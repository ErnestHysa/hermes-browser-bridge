/**
 * background.js — Safari Web Extension Background Service Worker
 * Connects to ws://localhost:9321 and routes messages to/from content scripts.
 */

const PROXY_WS_URL = 'ws://localhost:9321';
const RECONNECT_DELAY_MS = 2000;
const MAX_PENDING_MESSAGES = 50; // FIX #24: cap queued messages

// Connection state
let socket = null;
let connected = false;
let currentTabId = null;
let currentTabUrl = null;
let pendingMessages = [];
let reconnectTimer = null;

// ─── WebSocket ──────────────────────────────────────────────────────────────

function connect() {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return;
  }

  socket = new WebSocket(PROXY_WS_URL);

  socket.addEventListener('open', () => {
    connected = true;
    updateBadge('green');
    // Flush queued messages (oldest first)
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
    notifyPopup({ event: 'disconnected' });
    // Attempt reconnect with backoff
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
    socket.send(JSON.stringify(msg));
  } else {
    // FIX #24: cap queue — evict oldest if full (FIFO)
    if (pendingMessages.length >= MAX_PENDING_MESSAGES) {
      pendingMessages.shift();
      console.warn('[Hermes Bridge] Pending message queue full, dropping oldest message');
    }
    pendingMessages.push(msg);
    connect(); // trigger reconnect
  }
}

// ─── Message handling ───────────────────────────────────────────────────────

/**
 * Forward a command to the content script in the active tab.
 * FIX #15: Added retry logic — up to 3 attempts with delay between.
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
      // Success — command delivered
    }).catch((err) => {
      if (attemptNum < MAX_RETRIES) {
        console.warn(`[Hermes Bridge] Command delivery failed, retry ${attemptNum + 1}/${MAX_RETRIES}`);
        setTimeout(() => attempt(attemptNum + 1), RETRY_DELAY_MS * (attemptNum + 1));
      } else {
        console.error(`[Hermes Bridge] Command ${cmd.type} (${cmd.cmdId}) could not be delivered:`, err.message);
        // Notify proxy that the command failed to reach the content script
        sendToProxy({ type: 'cmd_error', cmdId: cmd.cmdId, error: `Tab not ready: ${err.message}` });
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
  // Ping the tab to confirm content script is alive
  try {
    await browser.tabs.sendMessage(tabId, { type: 'ping' });
  } catch {
    // Content script not yet loaded — that's fine
  }
}

// FIX #23: onUpdated should only update for the active tab
browser.tabs.onActivated.addListener(async (activeInfo) => {
  currentTabId = activeInfo.tabId;
  // Try to get the URL for the newly activated tab
  try {
    const tab = await browser.tabs.get(activeInfo.tabId);
    currentTabUrl = tab.url;
  } catch {
    // May fail for restricted pages
  }
});

// FIX #23: only update currentTabId if the updated tab is the active one
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
    // FIX #5: include currentTabUrl in the response
    sendResponse({ connected, currentTabId, url: currentTabUrl });
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

  // FIX #4: handle disconnect event from popup
  if (message.event === 'disconnect') {
    currentTabId = null;
    currentTabUrl = null;
    pageMirror?.setConnected(false);
    updateBadge('gray');
    notifyPopup({ event: 'disconnected' });
    return true;
  }

  // Extension → proxy (tab data, heartbeats, command responses)
  if (message.type === 'tab_snapshot' || message.type === 'mutation' || message.type === 'heartbeat') {
    sendToProxy(message);
    return true;
  }

  if (message.type === 'cmd_ack' || message.type === 'cmd_error') {
    sendToProxy(message);
    return true;
  }

  if (message.type === 'pong') {
    sendToProxy({ type: 'tab_snapshot', url: message.url, title: message.title, html: message.html });
    return true;
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────

connect();
