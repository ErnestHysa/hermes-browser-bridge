/**
 * background.js — Safari Web Extension Background Service Worker
 * Connects to ws://localhost:9321 and routes messages to/from content scripts.
 */

const PROXY_WS_URL = 'ws://localhost:9321';
const RECONNECT_DELAY_MS = 2000;
const MAX_PENDING_MESSAGES = 50;
const HEALTH_POLL_INTERVAL_MS = 10000;

// L4 FIX: generate a session ID once per browser session
const SESSION_ID = `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

// Connection state
let socket = null;
let connected = false;
let currentTabId = null;
let currentTabUrl = null;
let pendingMessages = [];
let reconnectTimer = null;
let healthPollTimer = null;

// ─── WebSocket ──────────────────────────────────────────────────────────────

function connect() {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return;
  }

  socket = new WebSocket(PROXY_WS_URL);

  socket.addEventListener('open', () => {
    connected = true;
    updateBadge('green');
    startHealthPoll();
    while (pendingMessages.length > 0) {
      const msg = pendingMessages.shift();
      sendToProxy(msg);
    }
    notifyPopup({ event: 'connected' });
  });

  socket.addEventListener('message', (event) => {
    try {
      const cmd = JSON.parse(event.data);
      handleProxyMessage(cmd);
    } catch (e) {
      console.error('[Hermes Bridge] Failed to parse proxy message:', e);
    }
  });

  socket.addEventListener('close', () => {
    connected = false;
    updateBadge('gray');
    stopHealthPoll();
    notifyPopup({ event: 'disconnected' });
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
  });

  socket.addEventListener('error', () => {
    connected = false;
    updateBadge('gray');
    notifyPopup({ event: 'error' });
  });
}

function sendToProxy(msg) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    // L4 FIX: attach sessionId to every outbound message
    socket.send(JSON.stringify({ ...msg, sessionId: SESSION_ID }));
  } else {
    if (pendingMessages.length >= MAX_PENDING_MESSAGES) {
      pendingMessages.shift();
      console.warn('[Hermes Bridge] Pending message queue full, dropping oldest message');
    }
    pendingMessages.push({ ...msg, sessionId: SESSION_ID });
    connect();
  }
}

// ─── Health polling ─────────────────────────────────────────────────────────

// M7 FIX: poll the proxy /health endpoint every 10s to detect silent disconnects
function startHealthPoll() {
  stopHealthPoll();
  healthPollTimer = setInterval(async () => {
    try {
      const res = await fetch('http://localhost:9321/health');
      const health = await res.json();
      if (!health.connected && connected) {
        // Proxy lost our connection but we think we're connected — force reconnect
        console.warn('[Hermes Bridge] Proxy reports no WS client; forcing reconnect');
        socket.close();
      }
    } catch {
      // Proxy down — will be caught by the close event handler
    }
  }, HEALTH_POLL_INTERVAL_MS);
}

function stopHealthPoll() {
  if (healthPollTimer !== null) {
    clearInterval(healthPollTimer);
    healthPollTimer = null;
  }
}

// ─── Message handling ───────────────────────────────────────────────────────

/**
 * Forward a command to the content script in the active tab.
 * @param {object} cmd
 */
function forwardCommandToTab(cmd) {
  if (!currentTabId) {
    console.warn('[Hermes Bridge] No active tab to forward command to');
    return;
  }

  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 300;

  function attempt(attemptNum) {
    browser.tabs.sendMessage(currentTabId, cmd).then(() => {
      // Success
    }).catch((err) => {
      // M4 FIX: log the actual error instead of silently ignoring it
      if (err && err.message) {
        console.warn(`[Hermes Bridge] Tab message delivery attempt ${attemptNum}/${MAX_RETRIES} failed: ${err.message}`);
      }
      if (attemptNum < MAX_RETRIES) {
        setTimeout(() => attempt(attemptNum + 1), RETRY_DELAY_MS * (attemptNum + 1));
      } else {
        console.error(`[Hermes Bridge] Command ${cmd.type} (${cmd.cmdId}) could not be delivered after ${MAX_RETRIES} attempts`);
        sendToProxy({ type: 'cmd_error', cmdId: cmd.cmdId, error: `Tab not ready: ${err.message || 'delivery failed'}` });
      }
    });
  }

  attempt(1);
}

function handleProxyMessage(cmd) {
  switch (cmd.type) {
    case 'navigate':
    case 'click':
    case 'scroll':
    case 'type':
    case 'submit':
    case 'evaluate':
      forwardCommandToTab(cmd);
      break;
    default:
      console.warn('[Hermes Bridge] Unknown command type:', cmd.type);
  }
}

// ─── Tab management ─────────────────────────────────────────────────────────

async function setActiveTab(tabId, tabUrl = null) {
  currentTabId = tabId;
  currentTabUrl = tabUrl ?? currentTabUrl;
  try {
    await browser.tabs.sendMessage(tabId, { type: 'ping' });
  } catch {
    // Content script not yet loaded — that's fine
    // M4 FIX: log at debug level instead of silent swallow
    console.debug('[Hermes Bridge] Content script not yet ready in tab', tabId);
  }
}

browser.tabs.onActivated.addListener(async (activeInfo) => {
  currentTabId = activeInfo.tabId;
  try {
    const tab = await browser.tabs.get(activeInfo.tabId);
    currentTabUrl = tab.url;
  } catch {
    // May fail for restricted pages
  }
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active && changeInfo.status === 'complete') {
    currentTabId = tabId;
    currentTabUrl = tab.url;
  }
});

// ─── Badge / icon state ──────────────────────────────────────────────────────

function updateBadge(color) {
  const colorMap = { green: '#34C759', yellow: '#FFCC00', gray: '#8E8E93' };
  const bg = colorMap[color] || colorMap.gray;
  try {
    browser.action.setBadgeBackgroundColor({ color: bg });
    browser.action.setBadgeText({ text: connected ? '●' : '○' });
  } catch {
    // Badge APIs may not be available in all Safari versions
  }
}

// ─── Popup notifications ─────────────────────────────────────────────────────

function notifyPopup(data) {
  browser.runtime.sendMessage({ ...data, from: 'background' }).catch(() => {
    // Popup not open — ignore
  });
}

// ─── Browser events ─────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Popup / content script queries status
  if (message.event === 'getStatus') {
    sendResponse({ connected, currentTabId, url: currentTabUrl, sessionId: SESSION_ID });
    return true;
  }

  // Popup asks to activate the current tab
  if (message.event === 'activate') {
    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      if (tabs[0]) {
        setActiveTab(tabs[0].id, tabs[0].url);
        notifyPopup({ event: 'tab_activated', tabId: tabs[0].id, url: tabs[0].url });
      }
    });
    return true;
  }

  if (message.event === 'disconnect') {
    currentTabId = null;
    currentTabUrl = null;
    updateBadge('gray');
    notifyPopup({ event: 'disconnected' });
    return true;
  }

  // Extension → proxy (tab data, heartbeats, command responses)
  // L4 FIX: attach sessionId to all outgoing messages
  if (message.type === 'tab_snapshot' || message.type === 'mutation' || message.type === 'heartbeat') {
    sendToProxy({ ...message, sessionId: SESSION_ID });
    return true;
  }

  if (message.type === 'cmd_ack' || message.type === 'cmd_error') {
    sendToProxy({ ...message, sessionId: SESSION_ID });
    return true;
  }

  if (message.type === 'pong') {
    sendToProxy({ type: 'tab_snapshot', url: message.url, title: message.title, html: message.html, sessionId: SESSION_ID });
    return true;
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────

connect();
