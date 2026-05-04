/**
 * background.js — Chrome Extension Service Worker (Manifest V3)
 * Bridges the Safari extension's content+background architecture to Chrome.
 * 
 * Key differences from Safari:
 * - Uses chrome.tabs instead of browser.tabs
 * - Service worker instead of persistent background page
 * - chrome.runtime.sendNativeMessage for potential native messaging
 * 
 * Fix #P2-7: Full Chrome extension implementation for parity with Safari.
 */

const DEFAULT_PROXY_PORT = 9321;

function getProxyWsUrl() {
  return `ws://localhost:${DEFAULT_PROXY_PORT}`;
}

const PROXY_WS_URL = getProxyWsUrl();
const RECONNECT_DELAY_MS = 2000;
const MAX_PENDING_MESSAGES = 50;
const HEALTH_POLL_INTERVAL_MS = 10000;

// Session ID persists across service worker restarts via chrome.storage.local
let SESSION_ID = `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

// Connection state
let socket = null;
let connected = false;
let currentTabId = null;
let currentTabUrl = null;
let pendingMessages = [];
let reconnectTimer = null;
let healthPollTimer = null;
let backpressurePaused = false;

// ─── WebSocket ─────────────────────────────────────────────────────────────

function connect() {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return;
  }

  try {
    socket = new WebSocket(PROXY_WS_URL);
  } catch (e) {
    console.error('[Hermes Bridge] WebSocket creation failed:', e);
    scheduleReconnect();
    return;
  }

  socket.addEventListener('open', () => {
    connected = true;
    backpressurePaused = false;
    updateBadge('green');
    startHealthPoll();
    // C2: Send hello with auth token so proxy knows this is a legitimate extension
    // Token is optional on the proxy side when HBS_AUTH_TOKEN is not set (dev mode)
    socket.send(JSON.stringify({
      type: 'hello',
      token: typeof HBS_AUTH_TOKEN !== 'undefined' ? HBS_AUTH_TOKEN : null,
      extension: 'chrome',
      version: chrome.runtime.getManifest().version || 'unknown'
    }));
    // Notify content script that backpressure is cleared on reconnect
    if (currentTabId) {
      chrome.tabs.sendMessage(currentTabId, { type: 'backpressure', paused: false }).catch(() => {});
    }
    // Fix #7: Persist sessionId across service worker restarts
    // Fix #22: Persist sessionId via chrome.storage.session (survives service worker restarts)
    chrome.storage.session.get(['hermesSessionId']).then((result) => {
      if (result.hermesSessionId) {
        SESSION_ID = result.hermesSessionId;
      } else {
        chrome.storage.session.set({ hermesSessionId: SESSION_ID });
      }
    }).catch(() => {
      // session storage unavailable — use volatile memory only
    });
    // S3: Send session_info so the proxy knows our metadata
    socket.send(JSON.stringify({
      type: 'session_info',
      sessionId: SESSION_ID,
      extension: 'chrome',
      version: chrome.runtime.getManifest().version || 'unknown',
      tabId: currentTabId
    }));
    while (pendingMessages.length > 0) {
      const msg = pendingMessages.shift();
      sendToProxy(msg);
    }
    notifyPopup({ event: 'connected' });
  });

  // M4: Allow popup/options to update proxy port at runtime
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'setProxyPort' && typeof message.port === 'number') {
      _proxyPort = message.port;
      chrome.storage.local.set({ hbsProxyPort: message.port });
      sendResponse({ ok: true, port: _proxyPort });
    }
    return true;
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
    backpressurePaused = false;
    updateBadge('gray');
    stopHealthPoll();
    notifyPopup({ event: 'disconnected' });
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    connected = false;
    updateBadge('gray');
    notifyPopup({ event: 'error' });
  });
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
}

function sendToProxy(msg) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ ...msg, sessionId: SESSION_ID }));
  } else {
    if (pendingMessages.length >= MAX_PENDING_MESSAGES) {
      pendingMessages.shift();
      console.warn('[Hermes Bridge] Pending message queue full, dropping oldest');
    }
    pendingMessages.push({ ...msg, sessionId: SESSION_ID });
    connect();
  }
}

// ─── Health polling ─────────────────────────────────────────────────────────

function startHealthPoll() {
  stopHealthPoll();
  healthPollTimer = setInterval(async () => {
    try {
      const res = await fetch(`http://localhost:${DEFAULT_PROXY_PORT}/health`);
      const health = await res.json();
      if (!health.connected && connected) {
        console.warn('[Hermes Bridge] Proxy reports no WS client; forcing reconnect');
        socket.close();
      }
    } catch { /* proxy down */ }
  }, HEALTH_POLL_INTERVAL_MS);
}

function stopHealthPoll() {
  if (healthPollTimer !== null) {
    clearInterval(healthPollTimer);
    healthPollTimer = null;
  }
}

// ─── Command routing ─────────────────────────────────────────────────────────

function forwardCommandToTab(tabId, cmd) {
  if (!tabId) {
    console.warn('[Hermes Bridge] No active tab to forward command to');
    notifyPopup({ event: 'cmd_error', cmdType: cmd.type, error: 'No active tab' });
    return;
  }

  notifyPopup({ event: 'cmd_sent', cmdType: cmd.type, selector: cmd.selector, url: cmd.url, cmdId: cmd.cmdId });

  // Fix #14: Attach a short reqId to every command forwarded to content script
  // so Hermes can correlate logs across extension → proxy → Hermes
  const reqId = `${cmd.cmdId.slice(0, 8)}`;
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 300;

  function attempt(attemptNum) {
    chrome.tabs.sendMessage(tabId, { ...cmd, reqId }, (resp) => {
      if (chrome.runtime.lastError) {
        if (attemptNum < MAX_RETRIES) {
          setTimeout(() => attempt(attemptNum + 1), RETRY_DELAY_MS * (attemptNum + 1));
        } else {
          console.error(`[Hermes Bridge] Command ${cmd.type} (${cmd.cmdId}) delivery failed: ${chrome.runtime.lastError.message}`);
          const errorMsg = `Tab not ready: ${chrome.runtime.lastError.message}`;
          // Notify via runtime message AND proxy so Hermes sees the error
          chrome.runtime.sendMessage({
            type: 'cmd_error',
            cmdId: cmd.cmdId,
            error: errorMsg,
            tabId,
            sessionId: SESSION_ID
          }).catch(() => {});
          sendToProxy({ type: 'cmd_error', cmdId: cmd.cmdId, error: errorMsg, tabId, sessionId: SESSION_ID });
          notifyPopup({ event: 'cmd_error', cmdType: cmd.type, error: errorMsg });
        }
      }
      // Success: content script sends ack/error asynchronously
    });
  }

  attempt(1);
}

/**
 * Handle messages from the proxy WebSocket.
 */
function handleProxyMessage(cmd) {
  switch (cmd.type) {
    case 'backpressure': {
      backpressurePaused = cmd.paused;
      // Fix #6: Forward backpressure signal to content script so it can pause observer
      if (currentTabId) {
        chrome.tabs.sendMessage(currentTabId, { type: 'backpressure', paused: cmd.paused }).catch(() => {});
      }
      notifyPopup({ event: 'backpressure', paused: cmd.paused });
      console.warn(`[Hermes Bridge] Backpressure ${cmd.paused ? 'ACTIVE' : 'cleared'}`);
      break;
    }

    case 'cancel':
      if (currentTabId) {
        chrome.tabs.sendMessage(currentTabId, { type: 'cancel', cmdId: cmd.cmdId }).catch(() => {});
      }
      break;

    // S7: Use cmd.tabId if provided (proxy-directed command to specific tab), otherwise fall back to currentTabId
    case 'navigate':
    case 'click':
    case 'scroll':
    case 'type':
    case 'submit':
    case 'evaluate':
    case 'refresh':
      forwardCommandToTab(cmd.tabId || currentTabId, cmd);
      break;

    case 'cmd_ack':
      notifyPopup({ event: 'cmd_done', cmdType: cmd.type });
      break;

    case 'cmd_error':
      notifyPopup({ event: 'cmd_error', cmdType: cmd.type, error: cmd.error });
      break;

    default:
      console.warn('[Hermes Bridge] Unknown command type from proxy:', cmd.type);
  }
}

// ─── Tab management ─────────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  currentTabId = activeInfo.tabId;
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    currentTabUrl = tab.url;
  } catch { /* restricted pages */ }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active && changeInfo.status === 'complete') {
    currentTabId = tabId;
    currentTabUrl = tab.url;
  }
});

// ─── Badge / icon state ─────────────────────────────────────────────────────

function updateBadge(color) {
  const colorMap = { green: '#34C759', yellow: '#FFCC00', gray: '#8E8E93' };
  const bg = colorMap[color] || colorMap.gray;
  try {
    chrome.action.setBadgeBackgroundColor({ color: bg });
    chrome.action.setBadgeText({ text: connected ? '\u25CF' : '\u25CB' });
  } catch { /* Badge APIs may not be available */ }
}

// ─── Popup notifications ─────────────────────────────────────────────────────

function notifyPopup(data) {
  // Fix #13: Log errors from notifyPopup instead of silently swallowing them.
  // Errors are expected when popup is closed, but real failures should be visible.
  chrome.runtime.sendMessage({ ...data, from: 'background' }).catch((err) => {
    if (chrome.runtime.lastError?.message !== 'Could not establish connection. Receiving end does not exist.') {
      console.warn('[Hermes Bridge] notifyPopup failed:', chrome.runtime.lastError?.message || err.message);
    }
    // Popup not open — expected, no action needed
  });
}

// ─── Service worker events ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.event === 'getStatus') {
    sendResponse({
      connected,
      currentTabId,
      url: currentTabUrl,
      sessionId: SESSION_ID,
      backpressurePaused
    });
    return true;
  }

  if (message.event === 'activate') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        currentTabId = tabs[0].id;
        currentTabUrl = tabs[0].url;
        notifyPopup({ event: 'tab_activated', tabId: tabs[0].id, url: tabs[0].url });
      }
    });
    return true;
  }

  if (message.type === '_navigate') {
    if (currentTabId !== null) {
      chrome.tabs.update(currentTabId, { url: message.url }, () => {
        if (chrome.runtime.lastError) {
          chrome.tabs.sendMessage(currentTabId, {
            type: 'cmd_error',
            cmdId: message.cmdId,
            success: false,
            error: `Navigation failed: ${chrome.runtime.lastError.message}`
          }).catch(() => {});
        }
      });
    }
    return true;
  }

  if (message.event === 'refreshSnapshot') {
    if (currentTabId) {
      chrome.tabs.sendMessage(currentTabId, { type: 'ping' }, (resp) => {
        if (resp && resp.html) {
          sendToProxy({
            type: 'tab_snapshot',
            url: resp.url,
            title: resp.title,
            html: resp.html,
            seq: resp.seq,
            tabId: currentTabId,
            sessionId: SESSION_ID
          });
        }
      });
    }
    return true;
  }

  if (message.event === 'disconnect') {
    currentTabId = null;
    currentTabUrl = null;
    backpressurePaused = false;
    updateBadge('gray');
    notifyPopup({ event: 'disconnected', pendingCmdId: null });
    return true;
  }

  // Extension → proxy messages
  if (message.type === 'tab_snapshot' || message.type === 'mutation' || message.type === 'mutation_batch' || message.type === 'heartbeat') {
    // C1: Don't send mutation_batch when backpressure paused — content script already dropped them
    if ((message.type === 'mutation' || message.type === 'mutation_batch') && backpressurePaused) return true;
    sendToProxy({ ...message, tabId: currentTabId, sessionId: SESSION_ID });
    return true;
  }

  if (message.type === 'cmd_ack' || message.type === 'cmd_error') {
    sendToProxy({ ...message, tabId: currentTabId, sessionId: SESSION_ID });
    return true;
  }

  if (message.type === 'content_error') {
    console.error(`[Hermes Bridge] Content script error: ${message.message}`);
    notifyPopup({ event: 'error', message: `Content error: ${message.message}` });
    return true;
  }

  if (message.type === 'pong') {
    sendToProxy({
      type: 'tab_snapshot',
      url: message.url,
      title: message.title,
      html: message.html,
      seq: message.seq,
      tabId: currentTabId,
      sessionId: SESSION_ID
    });
    return true;
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────

connect();
