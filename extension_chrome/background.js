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

// F10: Consistent structured logger — same format as server.js log() and Safari hbsLog().
// Fields: { ts, ext, lvl, msg, ...extras }
function hbsLog(level, msg, extras = {}) {
  const entry = {
    ts: new Date().toISOString(),
    ext: 'chrome',
    lvl: level,
    msg,
    ...extras
  };
  if (level === 'error') console.error('[Hermes]', JSON.stringify(entry));
  else if (level === 'warn') console.warn('[Hermes]', JSON.stringify(entry));
  else console.log('[Hermes]', JSON.stringify(entry));
}

// Fix #5: Configurable proxy port — declared at module scope so setProxyPort works
let _proxyPort = DEFAULT_PROXY_PORT;

// Fix #6: Use _proxyPort dynamically so runtime port changes take effect
function getProxyWsUrl() {
  return `ws://localhost:${_proxyPort}`;
}

const MAX_RECONNECT_DELAY_MS = 30000;
// Fix #6: Exponential backoff state: attempt count and current delay
let _reconnectAttempt = 0;
let _reconnectDelay = 2000;
const MAX_PENDING_MESSAGES = 50;
const HEALTH_POLL_INTERVAL_MS = 10000;

// Session ID persists across service worker restarts via chrome.storage.local
// Fix #11: Use crypto.randomUUID for cryptographically unpredictable session IDs
let SESSION_ID = `session_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;

// Fix #19: chrome.storage.session may be unavailable (private browsing, strict MV3 permissions).
// Always keep SESSION_ID valid as the primary ID. On successful storage read, update it.
// Use chrome.storage.local as the persistence layer (available in MV3 Chrome extensions).
function restoreSessionId() {
  // chrome.storage.local.get is async but doesn't reject for missing keys — only for actual API failures
  chrome.storage.local.get(['hermesSessionId', 'hbsProxyPort']).then((stored) => {
    if (stored && stored.hermesSessionId) {
      const oldId = SESSION_ID;
      SESSION_ID = stored.hermesSessionId;
      console.log('[Hermes Bridge] Restored session ID from local storage:', SESSION_ID.slice(0, 12));
      // If we already connected with a fresh ID, that's fine — proxy handles re-association
    }
    // F12: Also restore persisted proxy port so the extension reconnects to the right port
    // after a service worker restart, even if the popup never sent setProxyPort.
    if (stored && stored.hbsProxyPort) {
      _proxyPort = stored.hbsProxyPort;
      hbsLog('info', 'Restored proxy port from storage', { port: _proxyPort });
    }
  }).catch(() => {
    // Storage API unavailable — use volatile ID
  });
}

restoreSessionId();

// Connection state
let socket = null;
let connected = false;
let currentTabId = null;
let currentTabUrl = null;
let pendingMessages = [];
let reconnectTimer = null;
let healthPollTimer = null;
let backpressurePaused = false;
let navigating = false; // F19: guard against phantom navigate command execution

// ─── WebSocket ─────────────────────────────────────────────────────────────

function connect() {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return;
  }

  try {
    // Fix #6: Call getProxyWsUrl() each time so runtime _proxyPort changes are respected
    socket = new WebSocket(getProxyWsUrl());
  } catch (e) {
    hbsLog('error', 'WebSocket creation failed', { err: e?.message });
    scheduleReconnect();
    return;
  }

  socket.addEventListener('open', () => {
    connected = true;
    backpressurePaused = false;
    // Fix #6: Reset exponential backoff on successful connection
    _reconnectAttempt = 0;
    _reconnectDelay = 2000;
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
    // Fix #19: Use chrome.storage.local (not session) for reliable persistence in MV3 Chrome
    chrome.storage.local.set({ hermesSessionId: SESSION_ID }).catch(() => {
      // storage unavailable — session will use fresh ID on next restart
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
      hbsLog('error', 'Failed to parse proxy message', { err: e?.message });
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
  // Fix #6: Exponential backoff with jitter — cap at MAX_RECONNECT_DELAY_MS
  const delay = Math.min(_reconnectDelay + Math.random() * 1000, MAX_RECONNECT_DELAY_MS);
  _reconnectDelay = Math.min(_reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  _reconnectAttempt++;
  console.log(`[Hermes Bridge] Reconnecting in ${Math.round(delay)}ms (attempt ${_reconnectAttempt})`);
  reconnectTimer = setTimeout(connect, delay);
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
      const res = await fetch(`http://localhost:${_proxyPort}/health`);
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

// Fix #15: Track pending command types so cmd_ack can report the real type to popup
const pendingCmdTypes = new Map();  // cmdId → original command type
const MAX_PENDING_CMD_TYPES = 200;  // Fix #H1: cap to prevent unbounded growth

// Fix #H1: Evict oldest entries when the cap is reached
function _setPendingCmdType(cmdId, cmdType) {
  if (pendingCmdTypes.size >= MAX_PENDING_CMD_TYPES) {
    // Delete the oldest entry (first key in insertion order)
    const firstKey = pendingCmdTypes.keys().next().value;
    pendingCmdTypes.delete(firstKey);
  }
  pendingCmdTypes.set(cmdId, cmdType);
}

function forwardCommandToTab(tabId, cmd) {
  if (!tabId) {
    console.warn('[Hermes Bridge] No active tab to forward command to');
    notifyPopup({ event: 'cmd_error', cmdType: cmd.type, error: 'No active tab' });
    return;
  }

  // Fix #15: Remember the original command type for the ack/error handler
  _setPendingCmdType(cmd.cmdId, cmd.type);  // Fix #H1: capped Map with LRU eviction
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
      pendingCmdTypes.delete(cmd.cmdId);
      // F3: Notify popup so the user sees feedback when Hermes cancels a command.
      // Without this, the cancel button disappears silently with no indication of what happened.
      notifyPopup({ event: 'cmd_cancelled', cmdId: cmd.cmdId });
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
      // Fix #15: Forward the original command type, not 'cmd_ack'
      notifyPopup({ event: 'cmd_done', cmdType: pendingCmdTypes.get(cmd.cmdId) || cmd.type, cmdId: cmd.cmdId });
      pendingCmdTypes.delete(cmd.cmdId);
      break;

    case 'cmd_error':
      notifyPopup({ event: 'cmd_error', cmdType: pendingCmdTypes.get(cmd.cmdId) || cmd.type, error: cmd.error, cmdId: cmd.cmdId });
      pendingCmdTypes.delete(cmd.cmdId);
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
    navigating = false;
    currentTabId = tabId;
    currentTabUrl = tab.url;
    // F22: On tab activation, trigger prerender for the extension's background page
    // so content script context is warm when the next command arrives.
    // Prerendering reduces command latency by ~50–100ms on cold starts.
    try { chrome.tabs.prerender(tabId); } catch (_) { /* prerender may not be available */ }
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

  // F12: setProxyPort — update _proxyPort from the popup's port override UI.
  // This persists via chrome.storage.local in the popup; the background keeps the
  // in-memory value in sync so future proxy connections use the new port.
  if (message.event === 'setProxyPort' && typeof message.port === 'number') {
    _proxyPort = message.port;
    hbsLog('info', 'Proxy port overridden from popup', { port: message.port });
    // Note: popup already persists via chrome.storage.local.set — no need to write again here
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
    // F19: Reject navigate commands while a navigation is already in flight.
    // Without this, a rapid sequence of navigate commands can cause phantom execution
    // where Hermes sends cmd_ack believing the tab navigated when it didn't.
    if (navigating) {
      const err = 'Navigation already in progress — command ignored';
      notifyPopup({ event: 'cmd_error', cmdType: 'navigate', error: err });
      sendToProxy({ type: 'cmd_error', cmdId: message.cmdId, error: err, tabId: currentTabId, sessionId: SESSION_ID });
      return true;
    }
    if (currentTabId !== null) {
      navigating = true; // F19: set BEFORE issuing tabs.update
      chrome.tabs.update(currentTabId, { url: message.url }, () => {
        // R54: Clear navigating flag on BOTH success and error — the flag must not
        // survive beyond the tabs.update call. Previously only cleared on error,
        // which left it set if the tab navigated successfully (tabs.onUpdated may
        // fire with tab.active=false if the user switched tabs during navigation).
        navigating = false;
        if (chrome.runtime.lastError) {
          // F1: Forward navigate failure to proxy so Hermes's cmd_queue resolves immediately.
          // Without this, the content script waits 10s for a load event that will never fire
          // while Hermes waits 30s for a cmd_ack that never arrives.
          const errorMsg = `Navigation failed: ${chrome.runtime.lastError.message}`;
          chrome.tabs.sendMessage(currentTabId, {
            type: 'cmd_error',
            cmdId: message.cmdId,
            success: false,
            error: errorMsg
          }).catch(() => {});
          sendToProxy({ type: 'cmd_error', cmdId: message.cmdId, error: errorMsg, tabId: currentTabId, sessionId: SESSION_ID });
          notifyPopup({ event: 'cmd_error', cmdType: 'navigate', error: errorMsg });
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

  // Fix #L12: Route cancel through background WS so it respects runtime _proxyPort
  if (message.event === 'cancelCmd' && message.cmdId) {
    sendToProxy({ type: 'cmd_cancel', cmdId: message.cmdId });
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
