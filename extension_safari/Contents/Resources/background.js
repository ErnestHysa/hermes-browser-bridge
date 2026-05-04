/**
 * background.js — Safari Web Extension Background Service Worker
 * Connects to ws://localhost:9321 and routes messages to/from content scripts.
 *
 * Fix #P0-1: Hermes WS push redesign — proxy now sends backpressure signals.
 *             background forwards cancel messages to content script.
 * Fix #P1-6: content_error events from content script logged at warn level.
 * Fix #P2-8: backpressure messages from proxy: {type:"backpressure", paused:bool}
 *             are forwarded to the popup as {event:'backpressure', paused:bool}.
 * Fix #P3-17: cancel messages from proxy are forwarded to content script.
 */

'use strict';

const DEFAULT_PROXY_PORT = 9321;

// M4: Configurable proxy port — defaults to 9321, can be updated at runtime
let _proxyPort = DEFAULT_PROXY_PORT;

function getProxyWsUrl() {
  return `ws://localhost:${_proxyPort}`;
}

// Fix #18/#32: Removed stale `const PROXY_WS_URL = getProxyWsUrl()` — the const was
// never used (site of first WS call already uses getProxyWsUrl() directly).
const RECONNECT_DELAY_MS = 2000;
const MAX_PENDING_MESSAGES = 50;
const HEALTH_POLL_INTERVAL_MS = 10000;

// Session ID — restored from storage.session on restart, otherwise generated fresh.
// Fix #9: On Safari, the background script can be restarted by the OS under memory pressure.
// Without persistence, a new SESSION_ID orphans the proxy's session state.
// browser.storage.session is available in Manifest V3 Safari extensions.
// Fix #11: Use crypto.randomUUID for unpredictable session IDs
const SESSION_STORAGE_KEY = 'hermesSessionId';
let SESSION_ID = `session_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;

async function restoreSessionId() {
  try {
    const stored = await browser.storage.session.get([SESSION_STORAGE_KEY]);
    if (stored[SESSION_STORAGE_KEY]) {
      SESSION_ID = stored[SESSION_STORAGE_KEY];
      console.log('[Hermes Bridge] Restored session ID:', SESSION_ID.slice(0, 12));
    } else {
      // First run — persist the generated ID so it survives restart
      await persistSessionId();
    }
  } catch (e) {
    console.warn('[Hermes Bridge] Could not restore session ID from storage:', e.message);
  }
}

async function persistSessionId() {
  try {
    await browser.storage.session.set({ [SESSION_STORAGE_KEY]: SESSION_ID });
  } catch (e) {
    console.warn('[Hermes Bridge] Could not persist session ID:', e.message);
  }
}

// Attempt to restore session on startup (may not complete before first connect)
restoreSessionId();

// Connection state
let socket = null;
let connected = false;
let currentTabId = null;
let currentTabUrl = null;
let pendingMessages = [];
let reconnectTimer = null;
let healthPollTimer = null;
let backpressurePaused = false; // P2-8

// ─── WebSocket ──────────────────────────────────────────────────────────────

function connect() {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return;
  }

  socket = new WebSocket(getProxyWsUrl());

  socket.addEventListener('open', () => {
    connected = true;
    backpressurePaused = false; // P2-8
    updateBadge('green');
    startHealthPoll();
    // C2: Send hello with auth token so proxy knows this is a legitimate extension
    // Token is optional on the proxy side when HBS_AUTH_TOKEN is not set (dev mode)
    socket.send(JSON.stringify({
      type: 'hello',
      token: typeof HBS_AUTH_TOKEN !== 'undefined' ? HBS_AUTH_TOKEN : null,
      extension: 'safari',
      version: browser.runtime.getManifest?.version || 'unknown'
    }));
    // Fix #6: Notify content script that backpressure is cleared on reconnect
    if (currentTabId) {
      browser.tabs.sendMessage(currentTabId, { type: 'backpressure', paused: false }).catch(() => {});
    }
    // S3: Send session_info so the proxy knows our metadata
    socket.send(JSON.stringify({
      type: 'session_info',
      sessionId: SESSION_ID,
      extension: 'safari',
      version: browser.runtime.getManifest?.version || 'unknown',
      tabId: currentTabId
    }));
    while (pendingMessages.length > 0) {
      const msg = pendingMessages.shift();
      sendToProxy(msg);
    }
    notifyPopup({ event: 'connected' });
    // S6: Notify popup of the Hermes session ID so it can display it
    notifyPopup({ event: 'hermes_session', sessionId: SESSION_ID });
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
    backpressurePaused = false; // P2-8
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

function forwardCommandToTab(tabId, cmd) {
  if (!tabId) {
    console.warn('[Hermes Bridge] No active tab to forward command to');
    notifyPopup({ event: 'cmd_error', cmdType: cmd.type, error: 'No active tab' });
    return;
  }

  // Fix #15: Remember the original command type for the ack/error handler
  pendingCmdTypes.set(cmd.cmdId, cmd.type);
  notifyPopup({ event: 'cmd_sent', cmdType: cmd.type, selector: cmd.selector, url: cmd.url, cmdId: cmd.cmdId });

  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 300;

  function attempt(attemptNum) {
    browser.tabs.sendMessage(tabId, cmd).then(() => {
      // Success — cmd_ack or cmd_error arrives asynchronously via handleProxyMessage
    }).catch((err) => {
      if (err && err.message) {
        console.warn(`[Hermes Bridge] Tab delivery attempt ${attemptNum}/${MAX_RETRIES} failed: ${err.message}`);
      }
      if (attemptNum < MAX_RETRIES) {
        setTimeout(() => attempt(attemptNum + 1), RETRY_DELAY_MS * (attemptNum + 1));
      } else {
        console.error(`[Hermes Bridge] Command ${cmd.type} (${cmd.cmdId}) could not be delivered`);
        const errorMsg = `Tab not ready: ${err.message || 'delivery failed'}`;
        // Also notify the extension's background via browser.runtime so Hermes sees it
        browser.runtime.sendMessage({
          type: 'cmd_error',
          cmdId: cmd.cmdId,
          error: errorMsg,
          tabId: currentTabId,
          sessionId: SESSION_ID
        }).catch(() => {});
        sendToProxy({ type: 'cmd_error', cmdId: cmd.cmdId, error: errorMsg, tabId: currentTabId, sessionId: SESSION_ID });
        notifyPopup({ event: 'cmd_error', cmdType: cmd.type, error: errorMsg });
      }
    });
  }

  attempt(1);
}

/**
 * Handle incoming messages from the proxy WebSocket.
 * Fix #P0-1: now handles backpressure and cancel message types.
 */
function handleProxyMessage(cmd) {
  switch (cmd.type) {
    // P2-8: Backpressure signal — proxy is overwhelmed, pause/resume sending
    case 'backpressure':
      backpressurePaused = cmd.paused;
      // Fix #6: Forward to content script so it can pause its MutationObserver
      if (currentTabId) {
        browser.tabs.sendMessage(currentTabId, { type: 'backpressure', paused: cmd.paused }).catch(() => {});
      }
      notifyPopup({ event: 'backpressure', paused: cmd.paused });
      console.warn(`[Hermes Bridge] Backpressure ${cmd.paused ? 'ACTIVE' : 'cleared'}`);
      break;

    // P3-17: Cancel — forward to content script so it ignores this cmdId
    case 'cancel':
      pendingCmdTypes.delete(cmd.cmdId);
      if (currentTabId) {
        browser.tabs.sendMessage(currentTabId, { type: 'cancel', cmdId: cmd.cmdId }).catch(() => {});
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

async function setActiveTab(tabId, tabUrl = null) {
  currentTabId = tabId;
  currentTabUrl = tabUrl ?? currentTabUrl;
  try {
    await browser.tabs.sendMessage(tabId, { type: 'ping' });
  } catch {
    console.debug('[Hermes Bridge] Content script not yet ready in tab', tabId);
  }
}

browser.tabs.onActivated.addListener(async (activeInfo) => {
  currentTabId = activeInfo.tabId;
  try {
    const tab = await browser.tabs.get(activeInfo.tabId);
    currentTabUrl = tab.url;
  } catch { /* restricted pages */ }
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
    browser.action.setBadgeText({ text: connected ? '\u25CF' : '\u25CB' });
  } catch { /* Badge APIs may not be available */ }
}

// ─── Popup notifications ─────────────────────────────────────────────────────

function notifyPopup(data) {
  // Fix #13: Log unexpected errors from notifyPopup instead of silently swallowing all.
  browser.runtime.sendMessage({ ...data, from: 'background' }).catch((err) => {
    // "Could not establish connection" is expected when popup is closed — don't log it
    const msg = err?.message || browser.runtime.lastError?.message || '';
    if (!msg.includes('Could not establish connection')) {
      console.warn('[Hermes Bridge] notifyPopup failed:', msg);
    }
  });
}

// ─── Browser events ─────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'setProxyPort' && typeof message.port === 'number') {
    // M4: Allow popup/options to update proxy port at runtime
    _proxyPort = message.port;
    sendResponse({ ok: true, port: _proxyPort });
    return true;
  }

  if (message.event === 'getStatus') {
    sendResponse({
      connected,
      currentTabId,
      url: currentTabUrl,
      sessionId: SESSION_ID,
      backpressurePaused // P2-8: expose backpressure state
    });
    return true;
  }

  if (message.event === 'activate') {
    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      if (tabs[0]) {
        setActiveTab(tabs[0].id, tabs[0].url);
        notifyPopup({ event: 'tab_activated', tabId: tabs[0].id, url: tabs[0].url });
      }
    });
    return true;
  }

  if (message.type === '_navigate') {
    if (currentTabId !== null) {
      browser.tabs.update(currentTabId, { url: message.url }).catch((err) => {
        console.error('[Hermes Bridge] browser.tabs.update failed:', err.message);
        browser.tabs.sendMessage(currentTabId, {
          type: 'cmd_error',
          cmdId: message.cmdId,
          success: false,
          error: `Navigation failed: ${err.message}`
        }).catch(() => {});
      });
    }
    return true;
  }

  if (message.event === 'refreshSnapshot') {
    // Fix #5: Set up a pending command entry so the popup gets cmd_ack on completion.
    // Without this, the pendingCmdId in popup.js never gets cleared for refresh commands.
    if (currentTabId) {
      const fakeCmdId = `refresh_${Date.now()}`;
      pendingCmdTypes.set(fakeCmdId, 'refresh');
      pendingCmdId = fakeCmdId;
      browser.tabs.sendMessage(currentTabId, { type: 'ping', cmdId: fakeCmdId }).then((resp) => {
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
          pendingCmdId = null;
          pendingCmdTypes.delete(fakeCmdId);
          notifyPopup({ event: 'cmd_done', cmdType: 'refresh' });
        }
      }).catch(() => {
        pendingCmdId = null;
        pendingCmdTypes.delete(fakeCmdId);
        notifyPopup({ event: 'cmd_error', cmdType: 'refresh', error: 'Tab not ready' });
      });
    }
    return true;
  }

  if (message.event === 'disconnect') {
    currentTabId = null;
    currentTabUrl = null;
    backpressurePaused = false;
    updateBadge('gray');
    // Fix #16: Always pass pendingCmdId on disconnect so popup resets state
    notifyPopup({ event: 'disconnected', pendingCmdId: null });
    return true;
  }

  // Extension → proxy messages
  if (message.type === 'tab_snapshot' || message.type === 'mutation' || message.type === 'mutation_batch' || message.type === 'heartbeat') {
    // P2-8: don't send if backpressure paused (mutation events are high-volume)
    // C1: mutation_batch is already batched on the content side so we send it regardless
    if ((message.type === 'mutation' || message.type === 'mutation_batch') && backpressurePaused) return true;
    sendToProxy({ ...message, tabId: currentTabId, sessionId: SESSION_ID });
    return true;
  }

  if (message.type === 'cmd_ack' || message.type === 'cmd_error') {
    sendToProxy({ ...message, tabId: currentTabId, sessionId: SESSION_ID });
    return true;
  }

  // P1-6: content_error forwarded to popup
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
