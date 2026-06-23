/**
 * shared-background.js — Shared background logic for Chrome and Safari extensions.
 *
 * Platform-specific files import createBackground() and pass their browser API
 * namespace (chrome or browser). This module contains all common logic:
 *   - WebSocket connection with exponential backoff
 *   - Proxy message routing (command forwarding, ack/error)
 *   - Tab management
 *   - Health polling
 *   - Badge/icon state
 *   - Popup notifications
 *
 * Usage:
 *   // Chrome: background.js
 *   import { createBackground } from '../extension_shared/shared-background.js';
 *   createBackground({ browserAPI: chrome, extName: 'chrome' });
 */

'use strict';

const DEFAULT_PROXY_PORT = 9321;
const MAX_RECONNECT_DELAY_MS = 30000;
const MAX_PENDING_MESSAGES = 50;
const HEALTH_POLL_INTERVAL_MS = 10000;
const MAX_PENDING_CMD_TYPES = 200;

const SESSION_STORAGE_KEY = 'hermesSessionId';
const PROXY_PORT_STORAGE_KEY = 'hbsProxyPort';

/**
 * @param {object} opts
 * @param {object} opts.browserAPI - The browser extension API namespace (chrome or browser)
 * @param {string} opts.extName - Extension name for logging ('chrome' or 'safari')
 * @param {object} [opts.platformExtras] - Platform-specific overrides/hooks
 */
function createBackground({ browserAPI, extName, platformExtras = {} }) {
  const api = browserAPI;

  function hbsLog(level, msg, extras = {}) {
    const entry = { ts: new Date().toISOString(), ext: extName, lvl: level, msg, ...extras };
    if (level === 'error') console.error('[Hermes]', JSON.stringify(entry));
    else if (level === 'warn') console.warn('[Hermes]', JSON.stringify(entry));
    else console.log('[Hermes]', JSON.stringify(entry));
  }

  let _proxyPort = DEFAULT_PROXY_PORT;
  function getProxyWsUrl() { return `ws://localhost:${_proxyPort}`; }

  let _reconnectAttempt = 0;
  let _reconnectDelay = 2000;

  const sessionStorageKey = SESSION_STORAGE_KEY;
  const proxyPortStorageKey = PROXY_PORT_STORAGE_KEY;
  let SESSION_ID = generateSessionId();

  function generateSessionId() {
    const uuid = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
    return `session_${Date.now()}_${uuid.replace(/-/g, '').slice(0, 10)}`;
  }

  async function restoreSessionId() {
    try {
      const stored = await api.storage.local.get([sessionStorageKey, proxyPortStorageKey]);
      if (stored[sessionStorageKey]) {
        const oldId = SESSION_ID;
        SESSION_ID = stored[sessionStorageKey];
        hbsLog('info', 'Restored session ID from storage', { sessionId: SESSION_ID.slice(0, 12) });
      } else {
        await persistSessionId();
      }
      if (stored[proxyPortStorageKey]) {
        _proxyPort = stored[proxyPortStorageKey];
        hbsLog('info', 'Restored proxy port from storage', { port: _proxyPort });
      }
    } catch (_) { /* storage unavailable */ }
  }

  async function persistSessionId() {
    try {
      await api.storage.local.set({ [sessionStorageKey]: SESSION_ID });
    } catch (_) { /* storage unavailable */ }
  }

  // Connection state
  let socket = null;
  let connected = false;
  let currentTabId = null;
  let currentTabUrl = null;
  let pendingMessages = [];
  let reconnectTimer = null;
  let healthPollTimer = null;
  let backpressurePaused = false;
  let navigating = false;
  const _prenderedTabs = new Set();

  const pendingCmdTypes = new Map();

  function _setPendingCmdType(cmdId, cmdType) {
    if (pendingCmdTypes.size >= MAX_PENDING_CMD_TYPES) {
      const firstKey = pendingCmdTypes.keys().next().value;
      if (firstKey !== undefined) pendingCmdTypes.delete(firstKey);
    }
    pendingCmdTypes.set(cmdId, cmdType);
  }

  function updateBadge(color) {
    const colorMap = { green: '#34C759', yellow: '#FFCC00', gray: '#8E8E93' };
    const bg = colorMap[color] || colorMap.gray;
    try {
      api.action.setBadgeBackgroundColor({ color: bg });
      api.action.setBadgeText({ text: connected ? '\u25CF' : '\u25CB' });
    } catch (_) { /* Badge APIs may not be available */ }
  }

  function notifyPopup(data) {
    api.runtime.sendMessage({ ...data, from: 'background' }).catch((err) => {
      const msg = err && err.message ? err.message : '';
      if (msg && msg.length > 0 && msg !== 'Could not establish connection. Receiving end does not exist.') {
        hbsLog('warn', 'notifyPopup failed', { err: msg });
      }
    });
  }

  function sendToProxy(msg) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ ...msg, sessionId: SESSION_ID }));
    } else {
      if (pendingMessages.length >= MAX_PENDING_MESSAGES) {
        pendingMessages.shift();
        hbsLog('warn', 'Pending message queue full, dropping oldest');
      }
      pendingMessages.push({ ...msg, sessionId: SESSION_ID });
      connect();
    }
  }

  function connect() {
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;

    let socketOrError = null;
    try {
      socketOrError = new WebSocket(getProxyWsUrl());
    } catch (e) {
      hbsLog('error', 'WebSocket construction failed', { err: e && e.message });
      scheduleReconnect();
      return;
    }
    socket = socketOrError;

    socket.addEventListener('open', () => {
      connected = true;
      backpressurePaused = false;
      _reconnectAttempt = 0;
      _reconnectDelay = 2000;
      updateBadge('green');
      startHealthPoll();
      socket.send(JSON.stringify({
        type: 'hello',
        token: typeof HBS_AUTH_TOKEN !== 'undefined' ? HBS_AUTH_TOKEN : null,
        extension: extName,
        version: api.runtime.getManifest().version || 'unknown'
      }));
      if (currentTabId) {
        api.tabs.sendMessage(currentTabId, { type: 'backpressure', paused: false }).catch(() => {});
      }
      persistSessionId().catch(() => {});
      socket.send(JSON.stringify({
        type: 'session_info',
        sessionId: SESSION_ID,
        extension: extName,
        version: api.runtime.getManifest().version || 'unknown',
        tabId: currentTabId
      }));
      while (pendingMessages.length > 0) {
        const msg = pendingMessages.shift();
        sendToProxy(msg);
      }
      notifyPopup({ event: 'connected' });
      notifyPopup({ event: 'hermes_session', sessionId: SESSION_ID });
    });

    socket.addEventListener('message', (event) => {
      try {
        const cmd = JSON.parse(event.data);
        handleProxyMessage(cmd);
      } catch (e) {
        hbsLog('error', 'Failed to parse proxy message', { err: e && e.message });
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
    const delay = Math.min(_reconnectDelay + Math.random() * 1000, MAX_RECONNECT_DELAY_MS);
    _reconnectDelay = Math.min(_reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    _reconnectAttempt++;
    hbsLog('info', `Reconnecting`, { delayMs: Math.round(delay), attempt: _reconnectAttempt });
    reconnectTimer = setTimeout(connect, delay);
  }

  function startHealthPoll() {
    stopHealthPoll();
    healthPollTimer = setInterval(async () => {
      try {
        const res = await fetch(`http://localhost:${_proxyPort}/health`);
        const health = await res.json();
        if (!health.connected && connected) {
          hbsLog('warn', 'Proxy reports no WS client; forcing reconnect');
          socket.close();
        }
      } catch (_) { /* proxy down */ }
    }, HEALTH_POLL_INTERVAL_MS);
  }

  function stopHealthPoll() {
    if (healthPollTimer !== null) {
      clearInterval(healthPollTimer);
      healthPollTimer = null;
    }
  }

  function forwardCommandToTab(tabId, cmd) {
    if (!tabId) {
      hbsLog('warn', 'No active tab to forward command to', { cmdType: cmd.type });
      notifyPopup({ event: 'cmd_error', cmdType: cmd.type, error: 'No active tab' });
      return;
    }
    _setPendingCmdType(cmd.cmdId, cmd.type);
    notifyPopup({ event: 'cmd_sent', cmdType: cmd.type, selector: cmd.selector, url: cmd.url, cmdId: cmd.cmdId });

    const reqId = `${cmd.cmdId.slice(0, 8)}`;
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 300;

    function attempt(attemptNum) {
      api.tabs.sendMessage(tabId, { ...cmd, reqId }, (resp) => {
        if (api.runtime.lastError) {
          if (attemptNum < MAX_RETRIES) {
            setTimeout(() => attempt(attemptNum + 1), RETRY_DELAY_MS * (attemptNum + 1));
          } else {
            hbsLog('error', `Command ${cmd.type} delivery failed`, { cmdId: cmd.cmdId, err: api.runtime.lastError.message });
            const errorMsg = `Tab not ready: ${api.runtime.lastError.message}`;
            api.runtime.sendMessage({ type: 'cmd_error', cmdId: cmd.cmdId, error: errorMsg, tabId, sessionId: SESSION_ID }).catch(() => {});
            sendToProxy({ type: 'cmd_error', cmdId: cmd.cmdId, error: errorMsg, tabId, sessionId: SESSION_ID });
            notifyPopup({ event: 'cmd_error', cmdType: cmd.type, error: errorMsg });
          }
        }
      });
    }
    attempt(1);
  }

  function handleProxyMessage(cmd) {
    switch (cmd.type) {
      case 'backpressure':
        backpressurePaused = cmd.paused;
        if (currentTabId) {
          api.tabs.sendMessage(currentTabId, { type: 'backpressure', paused: cmd.paused }).catch(() => {});
        }
        notifyPopup({ event: 'backpressure', paused: cmd.paused });
        hbsLog('warn', `Backpressure ${cmd.paused ? 'ACTIVE' : 'cleared'}`);
        break;

      case 'cancel':
        pendingCmdTypes.delete(cmd.cmdId);
        notifyPopup({ event: 'cmd_cancelled', cmdId: cmd.cmdId });
        if (currentTabId) {
          api.tabs.sendMessage(currentTabId, { type: 'cancel', cmdId: cmd.cmdId }).catch(() => {});
        }
        break;

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
        notifyPopup({ event: 'cmd_done', cmdType: pendingCmdTypes.get(cmd.cmdId) || cmd.type, cmdId: cmd.cmdId });
        pendingCmdTypes.delete(cmd.cmdId);
        break;

      case 'cmd_error':
        notifyPopup({ event: 'cmd_error', cmdType: pendingCmdTypes.get(cmd.cmdId) || cmd.type, error: cmd.error, cmdId: cmd.cmdId });
        pendingCmdTypes.delete(cmd.cmdId);
        break;

      default:
        hbsLog('warn', 'Unknown command type from proxy', { cmdType: cmd.type });
    }
  }

  // Tab management
  api.tabs.onActivated.addListener(async (activeInfo) => {
    currentTabId = activeInfo.tabId;
    try {
      const tab = await api.tabs.get(activeInfo.tabId);
      currentTabUrl = tab.url;
    } catch (_) { /* restricted pages */ }
  });

  api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab.active && changeInfo.status === 'complete') {
      navigating = false;
      currentTabId = tabId;
      currentTabUrl = tab.url;
      if (extName === 'chrome' && !_prenderedTabs.has(tabId)) {
        _prenderedTabs.add(tabId);
        try { api.tabs.prerender(tabId); } catch (_) {}
      }
    }
    if (changeInfo.url) {
      _prenderedTabs.delete(tabId);
    }
  });

  // Runtime message handling
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'setProxyPort' && typeof message.port === 'number') {
      _proxyPort = message.port;
      api.storage.local.set({ [proxyPortStorageKey]: message.port }).catch(() => {});
      sendResponse({ ok: true, port: _proxyPort });
      return true;
    }

    if (message.event === 'getStatus') {
      sendResponse({ connected, currentTabId, url: currentTabUrl, sessionId: SESSION_ID, backpressurePaused });
      return true;
    }

    if (message.event === 'setProxyPort' && typeof message.port === 'number') {
      _proxyPort = message.port;
      hbsLog('info', 'Proxy port overridden from popup', { port: message.port });
      return true;
    }

    if (message.event === 'activate') {
      api.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          currentTabId = tabs[0].id;
          currentTabUrl = tabs[0].url;
          notifyPopup({ event: 'tab_activated', tabId: tabs[0].id, url: tabs[0].url });
        }
      });
      return true;
    }

    if (message.type === '_navigate') {
      if (navigating) {
        const err = 'Navigation already in progress — command ignored';
        notifyPopup({ event: 'cmd_error', cmdType: 'navigate', error: err });
        sendToProxy({ type: 'cmd_error', cmdId: message.cmdId, error: err, tabId: currentTabId, sessionId: SESSION_ID });
        return true;
      }
      if (currentTabId !== null) {
        navigating = true;
        api.tabs.update(currentTabId, { url: message.url }, () => {
          navigating = false;
          if (api.runtime.lastError) {
            const errorMsg = `Navigation failed: ${api.runtime.lastError.message}`;
            api.tabs.sendMessage(currentTabId, { type: 'cmd_error', cmdId: message.cmdId, success: false, error: errorMsg }).catch(() => {});
            sendToProxy({ type: 'cmd_error', cmdId: message.cmdId, error: errorMsg, tabId: currentTabId, sessionId: SESSION_ID });
            notifyPopup({ event: 'cmd_error', cmdType: 'navigate', error: errorMsg });
          }
        });
      }
      return true;
    }

    if (message.event === 'refreshSnapshot') {
      if (currentTabId) {
        api.tabs.sendMessage(currentTabId, { type: 'ping' }, (resp) => {
          if (resp && resp.html) {
            sendToProxy({ type: 'tab_snapshot', url: resp.url, title: resp.title, html: resp.html, seq: resp.seq, tabId: currentTabId, sessionId: SESSION_ID });
          }
        });
      }
      return true;
    }

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

    if (message.type === 'tab_snapshot' || message.type === 'mutation' || message.type === 'mutation_batch' || message.type === 'heartbeat') {
      if ((message.type === 'mutation' || message.type === 'mutation_batch') && backpressurePaused) return true;
      sendToProxy({ ...message, tabId: currentTabId, sessionId: SESSION_ID });
      return true;
    }

    if (message.type === 'cmd_ack' || message.type === 'cmd_error') {
      sendToProxy({ ...message, tabId: currentTabId, sessionId: SESSION_ID });
      return true;
    }

    if (message.type === 'content_error') {
      hbsLog('error', `Content script error: ${message.message}`);
      notifyPopup({ event: 'error', message: `Content error: ${message.message}` });
      return true;
    }

    if (message.type === 'pong') {
      sendToProxy({ type: 'tab_snapshot', url: message.url, title: message.title, html: message.html, seq: message.seq, tabId: currentTabId, sessionId: SESSION_ID });
      return true;
    }
  });

  // Init
  restoreSessionId();
  connect();

  // Expose internal state for platform-specific extensions
  return {
    get connected() { return connected; },
    get sessionId() { return SESSION_ID; },
    get proxyPort() { return _proxyPort; },
    set proxyPort(p) { _proxyPort = p; },
    connect,
    sendToProxy,
    hbsLog,
    notifyPopup,
    getCurrentTabId: () => currentTabId,
    getCurrentTabUrl: () => currentTabUrl,
    getBackpressurePaused: () => backpressurePaused,
    getPendingCmdTypes: () => pendingCmdTypes,
    getPendingCmdType: (cmdId) => pendingCmdTypes.get(cmdId),
    deletePendingCmdType: (cmdId) => pendingCmdTypes.delete(cmdId),
    setPendingCmdType: _setPendingCmdType,
  };
}

// Export for module-style Chrome service workers
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createBackground, DEFAULT_PROXY_PORT, MAX_RECONNECT_DELAY_MS, MAX_PENDING_MESSAGES, HEALTH_POLL_INTERVAL_MS };
}
