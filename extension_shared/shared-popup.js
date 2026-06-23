/**
 * shared-popup.js — Shared popup logic for Chrome and Safari extensions.
 *
 * Platform-specific files import createPopup() and pass their browser API
 * namespace (chrome or browser). This module contains all common popup logic:
 *   - UI state management (inactive/connecting/active/error)
 *   - Command log with localStorage persistence
 *   - Background message listener
 *   - Button click handlers
 *   - Keyboard shortcuts
 *   - Dark mode detection
 *   - Proxy port override UI
 *
 * Usage:
 *   // Chrome: popup.js
 *   import { createPopup } from '../extension_shared/shared-popup.js';
 *   createPopup({ browserAPI: chrome });
 */

'use strict';

const DEFAULT_PROXY_PORT = 9321;
const MAX_CMD_LOG = 5;
const CMD_LOG_KEY = 'hermes_cmd_log';

/**
 * @param {object} opts
 * @param {object} opts.browserAPI - The browser extension API namespace (chrome or browser)
 */
function createPopup({ browserAPI }) {
  const api = browserAPI;

  const statusDot    = document.getElementById('status-dot');
  const statusText   = document.getElementById('status-text');
  const urlDisplay   = document.getElementById('url-display');
  const activateBtn   = document.getElementById('activate-btn');
  const disconnectBtn = document.getElementById('disconnect-btn');
  const refreshBtn   = document.getElementById('refresh-btn');
  const cancelBtn     = document.getElementById('cancel-btn');
  const errorPanel   = document.getElementById('error-panel');
  const errorText    = document.getElementById('error-text');
  const infoText     = document.getElementById('info-text');
  const versionText   = document.getElementById('version-text');
  const cmdLogPanel  = document.getElementById('cmd-log-panel');
  const cmdLogList   = document.getElementById('cmd-log-list');
  const cmdCount     = document.getElementById('cmd-count');
  const dashboardLink = document.getElementById('dashboard-link');

  try {
    const manifest = api.runtime.getManifest();
    versionText.textContent = 'v' + (manifest.version || 'dev');
  } catch (_) {}

  let state = 'inactive';
  let cmdLog = [];
  let pendingCmdId = null;
  let proxyPort = DEFAULT_PROXY_PORT;

  function applyTheme() {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      document.body.classList.add('dark');
    } else {
      document.body.classList.remove('dark');
    }
  }
  applyTheme();

  function updatePortDisplay() {
    const el = document.getElementById('port-num');
    if (el) el.textContent = proxyPort;
    const link = document.getElementById('dashboard-link');
    if (link) link.href = `http://localhost:${proxyPort}/dashboard`;
  }

  function loadProxyPort() {
    try {
      api.storage.local.get(['proxyPortOverride'], (result) => {
        if (result && result.proxyPortOverride) {
          proxyPort = result.proxyPortOverride;
          updatePortDisplay();
        }
      });
    } catch (_) {}
  }

  function loadCmdLog() {
    try {
      const stored = localStorage.getItem(CMD_LOG_KEY);
      if (stored) {
        cmdLog = JSON.parse(stored);
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        cmdLog = cmdLog.filter(entry => entry.ts > cutoff);
      }
    } catch (_) { cmdLog = []; }
  }

  function saveCmdLog() {
    try {
      localStorage.setItem(CMD_LOG_KEY, JSON.stringify(cmdLog));
    } catch (e) {
      if (e.name === 'QuotaExceededError' && cmdLog.length > 1) {
        cmdLog = cmdLog.slice(-MAX_CMD_LOG);
        try {
          localStorage.setItem(CMD_LOG_KEY, JSON.stringify(cmdLog));
          return;
        } catch (_) {}
      }
      addCmdLog('warn', `Log not saved: ${e.name}`);
    }
  }

  function addCmdLog(type, detail) {
    cmdLog.unshift({ type, detail, ts: Date.now() });
    if (cmdLog.length > MAX_CMD_LOG) cmdLog.pop();
    saveCmdLog();
    renderCmdLog();
  }

  function renderCmdLog() {
    if (cmdLog.length === 0) { cmdLogPanel.classList.add('hidden'); return; }
    cmdLogPanel.classList.remove('hidden');
    cmdCount.textContent = cmdLog.length;
    cmdLogList.innerHTML = '';
    cmdLog.forEach(({ type, detail }) => {
      const li = document.createElement('li');
      li.textContent = detail;
      li.className = type;
      cmdLogList.appendChild(li);
    });
  }

  function setState(newState, extra = {}) {
    state = newState;
    statusDot.className = 'status-dot';
    errorPanel.classList.add('hidden');
    activateBtn.classList.remove('hidden', 'disabled');
    disconnectBtn.classList.add('hidden');
    refreshBtn.classList.add('hidden');
    activateBtn.disabled = false;
    urlDisplay.className = 'url-row';

    switch (newState) {
      case 'inactive':
        statusDot.classList.add('disconnected');
        statusText.textContent = 'Inactive';
        infoText.textContent = 'Click "Activate Tab" to give Hermes Agent access to your current page.';
        urlDisplay.textContent = 'No tab active';
        sessionStorage.removeItem('hermes_last_url');
        cancelBtn.classList.add('hidden');
        break;
      case 'connecting':
        statusDot.classList.add('connecting');
        statusText.textContent = 'Connecting…';
        infoText.textContent = 'Connecting to proxy server at localhost:9321…';
        activateBtn.disabled = true;
        activateBtn.classList.add('disabled');
        cancelBtn.classList.add('hidden');
        break;
      case 'active':
        statusDot.classList.add('connected');
        statusText.textContent = 'Connected';
        activateBtn.classList.add('hidden');
        disconnectBtn.classList.remove('hidden');
        refreshBtn.classList.remove('hidden');
        urlDisplay.classList.add('active');
        const displayUrl = extra.url || sessionStorage.getItem('hermes_last_url') || urlDisplay.textContent;
        if (displayUrl && displayUrl !== 'No tab active') {
          urlDisplay.textContent = displayUrl;
          sessionStorage.setItem('hermes_last_url', displayUrl);
        }
        infoText.textContent = 'Hermes Agent has full access to this tab.';
        break;
      case 'error':
        statusDot.classList.add('error');
        statusText.textContent = 'Error';
        errorPanel.classList.remove('hidden');
        errorText.textContent = extra.message || 'Connection failed.';
        activateBtn.classList.remove('hidden');
        activateBtn.disabled = false;
        activateBtn.textContent = 'Retry';
        infoText.textContent = 'Make sure the proxy server is running: node proxy_server/server.js';
        break;
    }
  }

  function onActivateClick() {
    setState('connecting');
    api.runtime.sendMessage({ event: 'activate' }).catch((e) => {
      if (state !== 'active') setState('error', { message: e.message });
    });
  }

  function onDisconnectClick() {
    api.runtime.sendMessage({ event: 'disconnect' }).catch(() => {});
    setState('inactive');
    cmdLog = [];
    saveCmdLog();
    renderCmdLog();
  }

  function onRefreshClick() {
    api.runtime.sendMessage({ event: 'refreshSnapshot' }).catch(() => {});
    addCmdLog('pending', 'Refresh snapshot…');
  }

  function onCancelClick() {
    if (!pendingCmdId) return;
    const cmdIdToCancel = pendingCmdId;
    pendingCmdId = null;
    cancelBtn.classList.add('hidden');
    api.runtime.sendMessage({ event: 'cancelCmd', cmdId: cmdIdToCancel })
      .then(() => { addCmdLog('error', `Cancelled: ${cmdIdToCancel}`); })
      .catch(() => { addCmdLog('error', 'Cancel failed'); });
  }

  function onKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'H') {
      e.preventDefault();
      if (!activateBtn.disabled && !activateBtn.classList.contains('hidden')) onActivateClick();
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'D') {
      e.preventDefault();
      if (!disconnectBtn.classList.contains('hidden')) onDisconnectClick();
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'R') {
      e.preventDefault();
      if (!refreshBtn.classList.contains('hidden')) onRefreshClick();
    } else if (e.key === 'Escape') {
      window.close();
    }
  }

  function onBgMessage(msg) {
    if (msg.from !== 'background') return;
    if (msg.event === 'connected') {
      const lastUrl = sessionStorage.getItem('hermes_last_url');
      setState('active', { url: lastUrl || undefined });
    } else if (msg.event === 'disconnected') {
      pendingCmdId = null;
      cancelBtn.classList.add('hidden');
      setState('inactive');
    } else if (msg.event === 'tab_activated') {
      pendingCmdId = null;
      cancelBtn.classList.add('hidden');
      sessionStorage.setItem('hermes_last_url', msg.url);
      setState('active', { url: msg.url });
    } else if (msg.event === 'error') {
      setState('error', { message: msg.message });
    } else if (msg.event === 'cmd_sent') {
      pendingCmdId = msg.cmdId;
      cancelBtn.classList.remove('hidden');
      addCmdLog('pending', `${msg.cmdType} → ${msg.selector || msg.url || '(action)'}`);
    } else if (msg.event === 'cmd_done') {
      if (msg.cmdId !== pendingCmdId) return;
      pendingCmdId = null;
      cancelBtn.classList.add('hidden');
      let updated = false;
      for (let i = 0; i < cmdLog.length; i++) {
        if (cmdLog[i].type === 'pending' && cmdLog[i].detail === 'Refresh snapshot…') {
          cmdLog[i] = { type: 'success', detail: 'Refreshed', ts: Date.now() };
          updated = true;
          break;
        }
      }
      if (!updated) addCmdLog('success', `${msg.cmdType}: OK`);
      else { saveCmdLog(); renderCmdLog(); }
    } else if (msg.event === 'cmd_error') {
      if (msg.cmdId !== pendingCmdId) return;
      pendingCmdId = null;
      cancelBtn.classList.add('hidden');
      addCmdLog('error', `${msg.cmdType}: ${msg.error}`);
    } else if (msg.event === 'cmd_cancelled') {
      if (msg.cmdId !== pendingCmdId) return;
      pendingCmdId = null;
      cancelBtn.classList.add('hidden');
      addCmdLog('error', `Cancelled by Hermes: ${msg.cmdId}`);
    } else if (msg.event === 'backpressure') {
      if (msg.paused) {
        pendingCmdId = null;
        if (statusDot) statusDot.className = 'status-dot paused';
        if (statusText) statusText.textContent = 'Paused';
        addCmdLog('pending', 'PAUSED — Hermes is catching up');
      } else {
        if (statusDot && state === 'active') statusDot.className = 'status-dot connected';
        if (statusText) statusText.textContent = 'Connected';
        addCmdLog('success', 'Resumed — Hermes is up to date');
      }
    } else if (msg.event === 'hermes_session') {
      const el = document.getElementById('hermes-session-hint') || document.querySelector('.hermes-session-hint');
      if (el) {
        el.textContent = `Session: ${msg.sessionId.slice(0, 12)}…`;
        el.classList.remove('hidden');
      }
    }
  }

  function onDashboardLinkClick(e) {
    e.preventDefault();
    api.tabs.create({ url: dashboardLink.href });
  }

  async function init() {
    setState('inactive');
    loadCmdLog();
    loadProxyPort();
    renderCmdLog();
    api.runtime.onMessage.addListener(onBgMessage);
    activateBtn.addEventListener('click', onActivateClick);
    disconnectBtn.addEventListener('click', onDisconnectClick);
    refreshBtn.addEventListener('click', onRefreshClick);
    cancelBtn.addEventListener('click', onCancelClick);
    document.addEventListener('keydown', onKeyDown);

    if (dashboardLink) {
      dashboardLink.addEventListener('click', onDashboardLinkClick);
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        api.runtime.onMessage.removeListener(onBgMessage);
        activateBtn.removeEventListener('click', onActivateClick);
        disconnectBtn.removeEventListener('click', onDisconnectClick);
        refreshBtn.removeEventListener('click', onRefreshClick);
        cancelBtn.removeEventListener('click', onCancelClick);
        document.removeEventListener('keydown', onKeyDown);
        if (dashboardLink) {
          dashboardLink.removeEventListener('click', onDashboardLinkClick);
        }
      }
    });

    try {
      const resp = await api.runtime.sendMessage({ event: 'getStatus' });
      if (resp && resp.connected) {
        const url = resp.url || sessionStorage.getItem('hermes_last_url');
        setState('active', { url: resp.url || url });
      } else if (resp && resp.url) {
        urlDisplay.textContent = resp.url;
        sessionStorage.setItem('hermes_last_url', resp.url);
      }
    } catch (_) {}

    // F12: Port override UI
    const portDisplay = document.getElementById('proxy-port-display');
    const portOverridePanel = document.getElementById('port-override-panel');
    const portOverrideInput = document.getElementById('port-override-input');
    const portOverrideOk = document.getElementById('port-override-ok');
    const portOverrideCancel = document.getElementById('port-override-cancel');

    if (portDisplay && portOverridePanel) {
      portDisplay.addEventListener('click', () => {
        portOverridePanel.classList.remove('hidden');
        if (portOverrideInput) {
          portOverrideInput.value = proxyPort;
          portOverrideInput.focus();
          portOverrideInput.select();
        }
      });
    }

    if (portOverrideOk) {
      portOverrideOk.addEventListener('click', () => {
        const val = parseInt(portOverrideInput.value, 10);
        if (val > 0 && val < 65536) {
          proxyPort = val;
          api.storage.local.set({ proxyPortOverride: val }, () => {
            updatePortDisplay();
            portOverridePanel.classList.add('hidden');
            api.runtime.sendMessage({ event: 'setProxyPort', port: val }).catch(() => {});
          });
        }
      });
    }

    if (portOverrideCancel) {
      portOverrideCancel.addEventListener('click', () => {
        portOverridePanel.classList.add('hidden');
      });
    }

    if (portOverrideInput) {
      portOverrideInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') portOverrideOk.click();
        if (e.key === 'Escape') portOverridePanel.classList.add('hidden');
      });
    }
  }

  init();
}

// Export for use by platform-specific popup.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createPopup };
}
