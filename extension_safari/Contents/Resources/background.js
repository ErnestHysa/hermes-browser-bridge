/**
 * background.js — Safari Web Extension Background Service Worker
 * Connects to ws://localhost:9321 and routes messages to/from content scripts.
 *
 * Fix #C1:   Handles '_navigate' from content script — uses browser.tabs.update()
 *             instead of content script directly calling window.location.href
 * Fix #L3:   Clarified ping (content→background ping request) vs
 *             heartbeat (background→proxy keepalive) vs pong (content→background ping response)
 * Fix #H3:   tabId included on cmd_ack and cmd_error so proxy can route correctly
 */

const DEFAULT_PROXY_PORT = 9321;

/**
 * Proxy WebSocket URL.
 * Fix #8: Currently uses a constant port. Future: could read from
 * browser.runtime.getManifest() if a "proxy_port" manifest field is added,
 * enabling the extension to work with server_https.js (port 9322).
 */
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

/**
 * Forward a command to the content script in the active tab.
 * Fix #13: notifies popup on send, success, and error.
 * @param {object} cmd
 */
function forwardCommandToTab(cmd) {
  if (!currentTabId) {
    console.warn('[Hermes Bridge] No active tab to forward command to');
    notifyPopup({ event: 'cmd_error', cmdType: cmd.type, error: 'No active tab' });
    return;
  }

  notifyPopup({ event: 'cmd_sent', cmdType: cmd.type, selector: cmd.selector, url: cmd.url });

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
        // Fix #H3: include tabId so proxy can disambiguate which tab this error came from
        sendToProxy({ type: 'cmd_error', cmdId: cmd.cmdId, error: errorMsg, tabId: currentTabId, sessionId: SESSION_ID });
        notifyPopup({ event: 'cmd_error', cmdType: cmd.type, error: errorMsg });
      }
    });
  }

  attempt(1);
}

/**
 * Handle incoming messages from the proxy WebSocket.
 *
 * Message flow summary:
 * - Proxy → 'navigate'/'click'/'type'/etc. → forwardCommandToTab → content script
 * - Proxy → 'connected' → acknowledgment (no-op here)
 * - Content → 'pong' → forward to proxy as 'tab_snapshot'
 * - Content → 'cmd_ack' / 'cmd_error' → forward to proxy (Fix #H3: tabId attached)
 *
 * @param {object} cmd
 */
function handleProxyMessage(cmd) {
  switch (cmd.type) {
    case 'navigate':
    case 'click':
    case 'scroll':
    case 'type':
    case 'submit':
    case 'evaluate':
    case 'refresh':   // Fix #12: explicit refresh command from popup
      forwardCommandToTab(cmd);
      break;

    case 'cmd_ack':
      // Fix #H3: attach tabId so proxy can track which tab this ack belongs to
      notifyPopup({ event: 'cmd_done', cmdType: cmd.type });
      break;

    case 'cmd_error':
      // Fix #H3: tabId already included by the content script on send
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
    // Unicode escape — avoids emoji rendering inconsistency across macOS versions
    browser.action.setBadgeText({ text: connected ? '\u25CF' : '\u25CB' });
  } catch { /* Badge APIs may not be available */ }
}

// ─── Popup notifications ─────────────────────────────────────────────────────

function notifyPopup(data) {
  browser.runtime.sendMessage({ ...data, from: 'background' }).catch(() => {
    // Popup not open — ignore
  });
}

// ─── Browser events ─────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ── Popup / content script queries status ─────────────────────────────
  if (message.event === 'getStatus') {
    sendResponse({
      connected,
      currentTabId,
      url: currentTabUrl,
      sessionId: SESSION_ID
    });
    return true;
  }

  // ── Popup asks to activate the current tab ──────────────────────────
  if (message.event === 'activate') {
    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      if (tabs[0]) {
        setActiveTab(tabs[0].id, tabs[0].url);
        notifyPopup({ event: 'tab_activated', tabId: tabs[0].id, url: tabs[0].url });
      }
    });
    return true;
  }

  // ── Fix #C1: _navigate — content script asks background to navigate ─
  // browser.tabs.update() works reliably in extension context; direct
  // window.location.href assignment from content script is blocked by Safari.
  if (message.type === '_navigate') {
    if (currentTabId !== null) {
      browser.tabs.update(currentTabId, { url: message.url }).catch((err) => {
        console.error('[Hermes Bridge] browser.tabs.update failed:', err.message);
        // Notify the content script so it can report the error
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

  // ── Manual refresh from popup ───────────────────────────────────────
  if (message.event === 'refreshSnapshot') {
    if (currentTabId) {
      // ping → content script → pong with full snapshot → sendToProxy
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
    updateBadge('gray');
    notifyPopup({ event: 'disconnected' });
    return true;
  }

  // ── Extension → proxy messages ───────────────────────────────────────

  // Fix #H3: include tabId on all outbound messages to proxy
  if (message.type === 'tab_snapshot' || message.type === 'mutation' || message.type === 'heartbeat') {
    sendToProxy({ ...message, tabId: currentTabId, sessionId: SESSION_ID });
    return true;
  }

  if (message.type === 'cmd_ack' || message.type === 'cmd_error') {
    sendToProxy({ ...message, tabId: currentTabId, sessionId: SESSION_ID });
    return true;
  }

  // ── ping/pong: content script ping → background → proxy ────────────
  // ping: content script requests a full snapshot (e.g., Hermes wants current state)
  // pong: content script responds with the full HTML snapshot
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
