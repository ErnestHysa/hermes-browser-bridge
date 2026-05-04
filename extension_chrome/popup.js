/**
 * popup.js — Chrome Extension Popup
 * Identical logic to Safari popup.js.
 * Fix #P2-7: Chrome extension implementation.
 */

'use strict';

const MAX_CMD_LOG = 5;
const CMD_LOG_KEY = 'hermes_cmd_log'; // Fix #22: localStorage key for persistence

const statusDot    = document.getElementById('status-dot');
const statusText   = document.getElementById('status-text');
const urlDisplay   = document.getElementById('url-display');
const activateBtn  = document.getElementById('activate-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const refreshBtn   = document.getElementById('refresh-btn');
// Fix #13: Cancel button for pending commands — calls DELETE /command/:cmdId
const cancelBtn    = document.getElementById('cancel-btn');
const errorPanel   = document.getElementById('error-panel');
const errorText    = document.getElementById('error-text');
const infoText     = document.getElementById('info-text');
const versionText  = document.getElementById('version-text');
const cmdLogPanel  = document.getElementById('cmd-log-panel');
const cmdLogList   = document.getElementById('cmd-log-list');
const cmdCount     = document.getElementById('cmd-count');
const dashboardLink = document.getElementById('dashboard-link'); // Fix #21

try {
  const manifest = chrome.runtime.getManifest();
  // L2: Fallback to 'dev' if manifest version is missing/undefined
  versionText.textContent = 'v' + (manifest.version || 'dev');
} catch {}

let state = 'inactive';
let cmdLog = []; // Fix #22: loaded from localStorage in loadCmdLog()
let pendingCmdId = null;

// Fix #22: Load command log from localStorage
function loadCmdLog() {
  try {
    const stored = localStorage.getItem(CMD_LOG_KEY);
    if (stored) {
      cmdLog = JSON.parse(stored);
      // Filter out entries older than 24 hours
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      cmdLog = cmdLog.filter(entry => entry.ts > cutoff);
    }
  } catch { cmdLog = []; }
}

// Fix #22: Save command log to localStorage
function saveCmdLog() {
  try {
    localStorage.setItem(CMD_LOG_KEY, JSON.stringify(cmdLog));
  } catch { /* storage full or unavailable */ }
}

function onActivateClick() {
  setState('connecting');
  chrome.runtime.sendMessage({ event: 'activate' }).catch((e) => {
    if (state !== 'active') setState('error', { message: e.message });
  });
}

function onDisconnectClick() {
  chrome.runtime.sendMessage({ event: 'disconnect' }).catch(() => {});
  setState('inactive');
  cmdLog = [];
  saveCmdLog(); // Fix #22: persist cleared log
  renderCmdLog();
}

function onRefreshClick() {
  chrome.runtime.sendMessage({ event: 'refreshSnapshot' }).catch(() => {});
  addCmdLog('pending', 'Refresh snapshot…');
}

// Fix #13: Cancel the currently pending command by calling DELETE /command/:cmdId
function onCancelClick() {
  if (!pendingCmdId) return;
  const cmdIdToCancel = pendingCmdId;
  pendingCmdId = null;
  cancelBtn.classList.add('hidden');
  fetch(`http://localhost:9321/command/${encodeURIComponent(cmdIdToCancel)}`, {
    method: 'DELETE'
  }).then(() => {
    addCmdLog('error', `Cancelled: ${cmdIdToCancel}`);
  }).catch(() => {
    addCmdLog('error', 'Cancel failed');
  });
}

// Fix #20: Keyboard shortcuts for quick actions
function onKeyDown(e) {
  // Ctrl/Cmd + Shift + H: Activate tab
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'H') {
    e.preventDefault();
    if (!activateBtn.disabled && !activateBtn.classList.contains('hidden')) {
      onActivateClick();
    }
  }
  // Ctrl/Cmd + Shift + D: Disconnect
  else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'D') {
    e.preventDefault();
    if (!disconnectBtn.classList.contains('hidden')) {
      onDisconnectClick();
    }
  }
  // Ctrl/Cmd + Shift + R: Refresh snapshot
  else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'R') {
    e.preventDefault();
    if (!refreshBtn.classList.contains('hidden')) {
      onRefreshClick();
    }
  }
  // Escape: Close popup (via visibility change)
  else if (e.key === 'Escape') {
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
    setState('inactive');
  } else if (msg.event === 'tab_activated') {
    // H2: Clear pendingCmdId so stale responses from the previous tab don't leak
    pendingCmdId = null;
    sessionStorage.setItem('hermes_last_url', msg.url);
    setState('active', { url: msg.url });
  } else if (msg.event === 'error') {
    setState('error', { message: msg.message });
  } else if (msg.event === 'cmd_sent') {
    pendingCmdId = msg.cmdId;
    cancelBtn.classList.remove('hidden');  // Fix #13: show cancel button when command is pending
    addCmdLog('pending', `${msg.cmdType} → ${msg.selector || msg.url || '(action)'}`);
  } else if (msg.event === 'cmd_done') {
    pendingCmdId = null;
    cancelBtn.classList.add('hidden');
    // Fix #15: If there's a pending "Refresh snapshot…" entry, update it in-place
    // instead of adding a second entry.
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
    pendingCmdId = null;
    cancelBtn.classList.add('hidden');
    addCmdLog('error', `${msg.cmdType}: ${msg.error}`);
  } else if (msg.event === 'backpressure') {
    // Fix #14: show backpressure PAUSED state in popup; clear pending command
    if (msg.paused) {
      pendingCmdId = null;
      addCmdLog('pending', 'PAUSED — Hermes is catching up');
    } else {
      addCmdLog('success', 'Resumed — Hermes is up to date');
    }
  } else if (msg.event === 'hermes_session') {
    // Fix #8: Session hint was created but never appended to DOM — now uses existing element
    const el = document.getElementById('hermes-session-hint');
    if (el) {
      el.textContent = `Session: ${msg.sessionId.slice(0, 12)}…`;
      el.classList.remove('hidden');
    }
  }
}

function addCmdLog(type, detail) {
  cmdLog.unshift({ type, detail, ts: Date.now() });
  if (cmdLog.length > MAX_CMD_LOG) cmdLog.pop();
  saveCmdLog(); // Fix #22: persist on every change
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
      cancelBtn.classList.add('hidden');  // Fix #13
      break;
    case 'connecting':
      statusDot.classList.add('connecting');
      statusText.textContent = 'Connecting…';
      infoText.textContent = 'Connecting to proxy server at localhost:9321…';
      activateBtn.disabled = true;
      activateBtn.classList.add('disabled');
      cancelBtn.classList.add('hidden');  // Fix #13
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
      statusDot.classList.add('error'); // Fix #23: distinct error dot color
      statusText.textContent = 'Error';
      errorPanel.classList.remove('hidden');
      errorText.textContent = extra.message || 'Connection failed.';
      // Fix #23: Show retry button in error state instead of just info text
      activateBtn.classList.remove('hidden');
      activateBtn.disabled = false;
      activateBtn.textContent = 'Retry';
      infoText.textContent = 'Make sure the proxy server is running: node proxy_server/server.js';
      break;
  }
}

async function init() {
  setState('inactive');
  loadCmdLog(); // Fix #22: restore persisted command log
  renderCmdLog(); // Render loaded log on startup
  chrome.runtime.onMessage.addListener(onBgMessage);
  activateBtn.addEventListener('click', onActivateClick);
  disconnectBtn.addEventListener('click', onDisconnectClick);
  refreshBtn.addEventListener('click', onRefreshClick);
  cancelBtn.addEventListener('click', onCancelClick);  // Fix #13
  document.addEventListener('keydown', onKeyDown); // Fix #20: keyboard shortcuts

  // Fix #21: Dashboard link - open in new tab
  if (dashboardLink) {
    dashboardLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: dashboardLink.href });
    });
  }

  // Cleanup on close
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      chrome.runtime.onMessage.removeListener(onBgMessage);
      activateBtn.removeEventListener('click', onActivateClick);
      disconnectBtn.removeEventListener('click', onDisconnectClick);
      refreshBtn.removeEventListener('click', onRefreshClick);
      cancelBtn.removeEventListener('click', onCancelClick);
      document.removeEventListener('keydown', onKeyDown);
    }
  });

  try {
    const resp = await chrome.runtime.sendMessage({ event: 'getStatus' });
    if (resp && resp.connected) {
      const url = resp.url || sessionStorage.getItem('hermes_last_url');
      setState('active', { url: resp.url || url });
    } else if (resp && resp.url) {
      urlDisplay.textContent = resp.url;
      sessionStorage.setItem('hermes_last_url', resp.url);
    }
  } catch {}
}

init();
