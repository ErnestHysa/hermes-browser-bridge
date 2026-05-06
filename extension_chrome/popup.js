/**
 * popup.js — Chrome Extension Popup
 * Identical logic to Safari popup.js.
 * Fix #P2-7: Chrome extension implementation.
 */

'use strict';

const DEFAULT_PROXY_PORT = 9321;
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
let cmdLog = []; // F23: Detect system dark/light mode preference and apply --dark-* CSS variables
// from popup.css. Class 'dark' on <body> activates dark theme variables.
function applyTheme() {
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.body.classList.toggle('dark', isDark);
}
applyTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
// F9: pendingCmdId kept — needed for stale-response filtering (cmd_done/cmd_error guard).
let pendingCmdId = null;

// F12: proxyPort starts at default; overridden by chrome.storage.local if user set one.
// This is read by all sendToProxy calls to build the correct URL.
let proxyPort = DEFAULT_PROXY_PORT;

// F12: Load persisted proxy port override from storage
function loadProxyPort() {
  try {
    chrome.storage.local.get(['proxyPortOverride'], (result) => {
      if (result && result.proxyPortOverride) {
        proxyPort = result.proxyPortOverride;
        updatePortDisplay();
      }
    });
  } catch (_) {}
}

function updatePortDisplay() {
  const el = document.getElementById('port-num');
  if (el) el.textContent = proxyPort;
  const link = document.getElementById('dashboard-link');
  if (link) link.href = `http://localhost:${proxyPort}/dashboard`;
}

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

// R56: Save command log to localStorage with retry-on-failure.
// If storage is full, trim oldest entries and retry once before giving up.
// If storage is disabled (private browsing, storage API blocked), show error in UI.
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

// Fix #13: Cancel the currently pending command via background WS so runtime port is respected
function onCancelClick() {
  if (!pendingCmdId) return;
  const cmdIdToCancel = pendingCmdId;
  pendingCmdId = null;
  cancelBtn.classList.add('hidden');
  chrome.runtime.sendMessage({ event: 'cancelCmd', cmdId: cmdIdToCancel })
    .then(() => { addCmdLog('error', `Cancelled: ${cmdIdToCancel}`); })
    .catch(() => { addCmdLog('error', 'Cancel failed'); });
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
    // Fix #18: Only clear pendingCmdId if this ack belongs to the current pending command.
    // If tab switched since the command was sent, pendingCmdId was already nulled
    // and a stale ack from the old tab must not interfere with the new command.
    if (msg.cmdId !== pendingCmdId) return;
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
    // Fix #18: Same guard — ignore stale errors from a previous tab's command.
    if (msg.cmdId !== pendingCmdId) return;
    pendingCmdId = null;
    cancelBtn.classList.add('hidden');  // Fix #13
    addCmdLog('error', `${msg.cmdType}: ${msg.error}`);
  } else if (msg.event === 'cmd_cancelled') {
    // F3: Hermes cancelled this command — notify the user with a distinct log entry.
    if (msg.cmdId !== pendingCmdId) return;
    pendingCmdId = null;
    cancelBtn.classList.add('hidden');
    addCmdLog('error', `Cancelled by Hermes: ${msg.cmdId}`);
  } else if (msg.event === 'backpressure') {
    // F11: Show backpressure PAUSED state in popup — not just a log entry but a
    // visible status change so the user immediately understands why commands are queued.
    const dot = document.getElementById('status-dot');
    if (msg.paused) {
      pendingCmdId = null;
      // F11: Swap dot to 'paused' state — pulsing yellow warning
      if (dot) { dot.className = 'status-dot paused'; }
      addCmdLog('pending', 'PAUSED — Hermes is catching up');
    } else {
      // F11: Restore connected state when backpressure clears
      if (dot && state === 'active') { dot.className = 'status-dot connected'; }
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

// Fix #21: Dashboard link — use named function so it can be removed on cleanup
function onDashboardLinkClick(e) {
  e.preventDefault();
  chrome.tabs.create({ url: dashboardLink.href });
}

async function init() {
  setState('inactive');
  loadCmdLog(); // Fix #22: restore persisted command log
  loadProxyPort(); // F12: restore persisted proxy port override
  renderCmdLog();
  chrome.runtime.onMessage.addListener(onBgMessage);
  activateBtn.addEventListener('click', onActivateClick);
  disconnectBtn.addEventListener('click', onDisconnectClick);
  refreshBtn.addEventListener('click', onRefreshClick);
  cancelBtn.addEventListener('click', onCancelClick);  // Fix #13
  document.addEventListener('keydown', onKeyDown); // Fix #20: keyboard shortcuts

  // Fix #21: Dashboard link - open in new tab (named function for cleanup)
  if (dashboardLink) {
    dashboardLink.addEventListener('click', onDashboardLinkClick);
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
      // Fix #13: Remove dashboardLink listener to prevent accumulation on re-open
      if (dashboardLink) {
        dashboardLink.removeEventListener('click', onDashboardLinkClick);
      }
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

  // F12: Port override UI — wire click on the port display to show the input panel
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
        chrome.storage.local.set({ proxyPortOverride: val }, () => {
          updatePortDisplay();
          portOverridePanel.classList.add('hidden');
          // F12: Notify background so it uses the new port for future proxy connections
          chrome.runtime.sendMessage({ event: 'setProxyPort', port: val }).catch(() => {});
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
