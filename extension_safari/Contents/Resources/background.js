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

function getProxyWsUrl() {
  return `ws://localhost:${DEFAULT_PROXY_PORT}`;
}

const PROXY_WS_URL = getProxyWsUrl();
const RECONNECT_DELAY_MS = 2000;
const MAX_PENDING_MESSAGES = 50;
const HEALTH_POLL_INTERVAL_MS = 10000;

// Session ID — generated once per browser session, persists across tab navigations
const SESSION_ID = `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

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

  socket = new WebSocket(PROXY_WS_URL);

  socket.addEventListener('open', () => {
    connected = true;
    backpressurePaused = false; // P2-8
    updateBadge('green');
    startHealthPoll();
    // Fix #6: Notify content script that backpressure is cleared on reconnect
    if (currentTabId) {
      browser.tabs.sendMessage(currentTabId, { type: 'backpressure', paused: false }).catch(() => {});
    }
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

function forwardCommandToTab(cmd) {
  if (!currentTabId) {
    console.warn('[Hermes Bridge] No active tab to forward command to');
    notifyPopup({ event: 'cmd_error', cmdType: cmd.type, error: 'No active tab' });
    return;
  }

  notifyPopup({ event: 'cmd_sent', cmdType: cmd.type, selector: cmd.selector, url: cmd.url, cmdId: cmd.cmdId });

  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 300;

  function attempt(attemptNum) {
    browser.tabs.sendMessage(currentTabId, cmd).then(() => {
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
      if (currentTabId) {
        browser.tabs.sendMessage(currentTabId, { type: 'cancel', cmdId: cmd.cmdId }).catch(() => {});
      }
      break;

    case 'navigate':
    case 'click':
    case 'scroll':
    case 'type':
    case 'submit':
    case 'evaluate':
    case 'refresh':
      forwardCommandToTab(cmd);
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
    if (currentTabId) {
      browser.tabs.sendMessage(currentTabId, { type: 'ping' }).then((resp) => {
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
      }).catch(() => {
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
    notifyPopup({ event: 'disconnected' });
    return true;
  }

  // Extension → proxy messages
  if (message.type === 'tab_snapshot' || message.type === 'mutation' || message.type === 'heartbeat') {
    // P2-8: don't send if backpressure paused (mutation events are high-volume)
    if (message.type === 'mutation' && backpressurePaused) return true;
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
