/**
 * background.js — Safari Web Extension Background Service Worker
 * Connects to ws://localhost:9321 and routes messages to/from content scripts.
 */

const PROXY_WS_URL = 'ws://localhost:9321';
const RECONNECT_DELAY_MS = 2000;

// Connection state
let socket = null;
let connected = false;
let currentTabId = null;
let pendingMessages = [];

// ─── WebSocket ──────────────────────────────────────────────────────────────

function connect() {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return;
  }

  socket = new WebSocket(PROXY_WS_URL);

  socket.addEventListener('open', () => {
    connected = true;
    updateBadge('green');
    // Re-send any queued messages
    for (const msg of pendingMessages) {
      sendToProxy(msg);
    }
    pendingMessages = [];
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
    // Attempt reconnect
    setTimeout(connect, RECONNECT_DELAY_MS);
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
    // Queue message to send when connected
    pendingMessages.push(msg);
    // Still try to reconnect
    connect();
  }
}

// ─── Message handling ───────────────────────────────────────────────────────

function handleProxyMessage(cmd) {
  if (!currentTabId) return;

  switch (cmd.type) {
    case 'navigate':
    case 'click':
    case 'scroll':
    case 'type':
    case 'submit':
    case 'evaluate':
      // Forward to content script in the active tab
      browser.tabs.sendMessage(currentTabId, cmd).catch(() => {
        // Tab might not be ready — ignore
      });
      break;
    default:
      console.warn('[Hermes Bridge] Unknown command type:', cmd.type);
  }
}

// ─── Tab management ─────────────────────────────────────────────────────────

async function setActiveTab(tabId) {
  currentTabId = tabId;
  // Request initial snapshot from the tab
  try {
    await browser.tabs.sendMessage(tabId, { type: 'ping' });
  } catch {
    // Content script not yet loaded — that's fine
  }
}

// ─── Browser events ──────────────────────────────────────────────────────────

// Listen for messages from popup
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.event === 'getStatus') {
    sendResponse({ connected, currentTabId });
    return true;
  }

  if (message.event === 'activate') {
    // The popup is asking us to activate the current tab
    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      if (tabs[0]) {
        setActiveTab(tabs[0].id);
        notifyPopup({ event: 'tab_activated', tabId: tabs[0].id, url: tabs[0].url });
      }
    });
    return true;
  }

  if (message.type === 'tab_snapshot' || message.type === 'mutation' || message.type === 'heartbeat') {
    // Forward to proxy
    sendToProxy(message);
    return true;
  }

  if (message.type === 'cmd_ack' || message.type === 'cmd_error') {
    // Forward to proxy
    sendToProxy(message);
    return true;
  }

  if (message.type === 'pong') {
    // Response to our ping — tab is alive
    sendToProxy({ type: 'tab_snapshot', url: message.url, title: message.title, html: message.html });
    return true;
  }
});

// When the active tab changes, update our currentTabId
browser.tabs.onActivated.addListener(async (activeInfo) => {
  currentTabId = activeInfo.tabId;
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active) {
    currentTabId = tabId;
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

// ─── Init ───────────────────────────────────────────────────────────────────

connect();
