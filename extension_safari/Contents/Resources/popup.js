/**
 * popup.js — Safari Web Extension Popup Logic
 *
 * Fix #P1-6:  All event listeners are now registered with named functions stored
 *             in module variables, and removed when the popup is hidden/closed.
 *             This prevents listener accumulation on repeated open/close cycles.
 * Fix #P3-17: Added cancel button for pending commands.
 */

'use strict';

const DEFAULT_PROXY_PORT = 9321;
const MAX_CMD_LOG = 5;
const CMD_LOG_KEY = 'hermes_cmd_log'; // Fix #22: localStorage key for persistence

// ─── Popup state ───────────────────────────────────────────────────────────
// Fix #3: Track initialization and hidden state to prevent listener accumulation
let _popupInitialized = false;
let _popupHidden = false;

// ─── DOM refs ────────────────────────────────────────────────────────────────

const statusDot    = document.getElementById('status-dot');
const statusText   = document.getElementById('status-text');
const urlDisplay   = document.getElementById('url-display');
const activateBtn   = document.getElementById('activate-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const refreshBtn   = document.getElementById('refresh-btn');
// Fix #13: Cancel button for pending commands — calls DELETE /command/:cmdId
const cancelBtn     = document.getElementById('cancel-btn');
const errorPanel   = document.getElementById('error-panel');
const errorText    = document.getElementById('error-text');
const infoText     = document.getElementById('info-text');
const versionText   = document.getElementById('version-text');
const cmdLogPanel  = document.getElementById('cmd-log-panel');
const cmdLogList   = document.getElementById('cmd-log-list');
const cmdCount     = document.getElementById('cmd-count');
const dashboardLink = document.getElementById('dashboard-link'); // Fix #21

try {
  const manifest = browser.runtime.getManifest();
  // L2: Fallback to 'dev' if manifest version is missing/undefined
  versionText.textContent = `v${manifest.version || 'dev'}`;
} catch { /* fallback */ }

// R54: Dark mode support — mirrors Chrome popup's applyTheme() from F23.
function applyTheme() {
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.body.classList.add('dark');
  } else {
    document.body.classList.remove('dark');
  }
}
applyTheme();

let state = 'inactive';
let cmdLog = []; // Fix #22: loaded from localStorage in loadCmdLog()
let pendingCmdId = null; // P3-17: track last pending cmd for cancel

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
  // Escape: Close popup
  else if (e.key === 'Escape') {
    window.close();
  }
}

// ─── Event handler references (named functions for add/remove) ─────────────────

function onActivateClick() {
  setState('connecting');
  browser.runtime.sendMessage({ event: 'activate' }).catch((e) => {
    if (state !== 'active') setState('error', { message: e.message });
  });
}

function onDisconnectClick() {
  browser.runtime.sendMessage({ event: 'disconnect' }).catch(() => {});
  setState('inactive');
  cmdLog = [];
  saveCmdLog(); // Fix #22: persist cleared log
  renderCmdLog();
}

function onRefreshClick() {
  browser.runtime.sendMessage({ event: 'refreshSnapshot' }).catch(() => {});
  addCmdLog('pending', 'Refresh snapshot…');
}

// Fix #13: Cancel the currently pending command via background WS so runtime port is respected
function onCancelClick() {
  if (!pendingCmdId) return;
  const cmdIdToCancel = pendingCmdId;
  pendingCmdId = null;
  cancelBtn.classList.add('hidden');
  // Fix #L13: Route through background to use its runtime _proxyPort
  browser.runtime.sendMessage({ event: 'cancelCmd', cmdId: cmdIdToCancel })
    .then(() => { addCmdLog('error', `Cancelled: ${cmdIdToCancel}`); })
    .catch(() => { addCmdLog('error', 'Cancel failed'); });
}

// P1-6: Named handler so we can remove it on popup close
function onBgMessage(msg) {
  if (msg.from !== 'background') return;

  if (msg.event === 'connected') {
    const lastUrl = sessionStorage.getItem('hermes_last_url');
    setState('active', { url: lastUrl || undefined });
  } else if (msg.event === 'disconnected') {
    pendingCmdId = null;  // Fix #7: clear stale cmdId so cancel button doesn't persist
    cancelBtn?.classList.add('hidden');
    setState('inactive');
  } else if (msg.event === 'tab_activated') {
    pendingCmdId = null;  // Fix #12: clear stale cmdId when switching tabs
    cancelBtn?.classList.add('hidden');
    sessionStorage.setItem('hermes_last_url', msg.url);
    setState('active', { url: msg.url });
  } else if (msg.event === 'error') {
    setState('error', { message: msg.message });
  } else if (msg.event === 'cmd_sent') {
    pendingCmdId = msg.cmdId; // P3-17
    cancelBtn.classList.remove('hidden');  // Fix #13: show cancel button when command is pending
    addCmdLog('pending', `${msg.cmdType} → ${msg.selector || msg.url || '(action)'}`);
  } else if (msg.event === 'cmd_done') {
    // Fix #18: Only clear pendingCmdId if this ack belongs to the current pending command.
    // If tab switched since the command was sent, pendingCmdId was already nulled
    // and a stale ack from the old tab must not interfere with the new command.
    if (msg.cmdId !== pendingCmdId) return;
    pendingCmdId = null;
    cancelBtn.classList.add('hidden');  // Fix #13
    // Fix #15: If there's a pending "Refresh snapshot…" entry, update it in-place
    // instead of adding a second entry. Prevents "Refresh snapshot… / Refreshed: OK" duplication.
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
    // Fix #14: show backpressure PAUSED state in popup
    if (msg.paused) {
      pendingCmdId = null;
      addCmdLog('pending', 'PAUSED — Hermes is catching up');
    } else {
      addCmdLog('success', 'Resumed — Hermes is up to date');
    }
  } else if (msg.event === 'hermes_session') {
    // Fix #15: show which session Hermes is subscribed to
    const el = document.querySelector('.hermes-session-hint');
    if (el) el.textContent = `Session: ${msg.sessionId.slice(0, 12)}…`;
  }
}

// ─── Command log ─────────────────────────────────────────────────────────────

function addCmdLog(type, detail) {
  cmdLog.unshift({ type, detail, ts: Date.now() });
  if (cmdLog.length > MAX_CMD_LOG) cmdLog.pop();
  saveCmdLog(); // Fix #22: persist on every change
  renderCmdLog();
}

function renderCmdLog() {
  if (cmdLog.length === 0) {
    cmdLogPanel.classList.add('hidden');
    return;
  }
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

// ─── UI State ───────────────────────────────────────────────────────────────

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

// ─── Init ───────────────────────────────────────────────────────────────────

// Fix #21: Dashboard link — use named function so it can be removed on cleanup
function onDashboardLinkClick(e) {
  e.preventDefault();
  browser.tabs.create({ url: dashboardLink.href });
}

async function init() {
  // Fix #3: Guard against double-init if popup is reopened after being hidden
  if (_popupInitialized) return;
  _popupInitialized = true;

  setState('inactive');
  loadCmdLog(); // Fix #22: restore persisted command log
  renderCmdLog(); // Render loaded log on startup

  // Register background message listener (P1-6: named function for cleanup)
  browser.runtime.onMessage.addListener(onBgMessage);

  try {
    const resp = await browser.runtime.sendMessage({ event: 'getStatus' });
    if (resp && resp.connected) {
      const url = resp.url || sessionStorage.getItem('hermes_last_url');
      setState('active', { url: resp.url || url });
    } else if (resp && resp.url) {
      urlDisplay.textContent = resp.url;
      sessionStorage.setItem('hermes_last_url', resp.url);
    }
  } catch { /* background not ready */ }

  // Register button handlers (P1-6: named functions for cleanup)
  activateBtn.addEventListener('click', onActivateClick);
  disconnectBtn.addEventListener('click', onDisconnectClick);
  refreshBtn.addEventListener('click', onRefreshClick);
  cancelBtn.addEventListener('click', onCancelClick); // Fix #13
  document.addEventListener('keydown', onKeyDown);

  // Fix #3: Dashboard link - open in new tab (named function for cleanup)
  if (dashboardLink) {
    dashboardLink.addEventListener('click', onDashboardLinkClick);
  }

  // P1-6: Cleanup on popup visibility change (covers close, tab switch, etc.)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      _popupHidden = true;
      // Remove listeners to prevent accumulation
      browser.runtime.onMessage.removeListener(onBgMessage);
      activateBtn.removeEventListener('click', onActivateClick);
      disconnectBtn.removeEventListener('click', onDisconnectClick);
      refreshBtn.removeEventListener('click', onRefreshClick);
      cancelBtn.removeEventListener('click', onCancelClick);  // Fix #13
      document.removeEventListener('keydown', onKeyDown);
      // Fix #13: Remove dashboardLink listener to prevent accumulation on re-open
      if (dashboardLink) {
        dashboardLink.removeEventListener('click', onDashboardLinkClick);
      }
    } else if (document.visibilityState === 'visible' && _popupHidden) {
      // Fix #3: Popup was hidden and is now visible again — restore all listeners
      _popupHidden = false;
      browser.runtime.onMessage.addListener(onBgMessage);
      activateBtn.addEventListener('click', onActivateClick);
      disconnectBtn.addEventListener('click', onDisconnectClick);
      refreshBtn.addEventListener('click', onRefreshClick);
      cancelBtn.addEventListener('click', onCancelClick);
      document.addEventListener('keydown', onKeyDown);
      if (dashboardLink) {
        dashboardLink.addEventListener('click', onDashboardLinkClick);
      }
    }
  });

  // P1-6: Also clean up on pagehide (Safari's equivalent of beforeunload)
  window.addEventListener('pagehide', () => {
    _popupInitialized = false;
    _popupHidden = false;
    browser.runtime.onMessage.removeListener(onBgMessage);
    activateBtn.removeEventListener('click', onActivateClick);
    disconnectBtn.removeEventListener('click', onDisconnectClick);
    refreshBtn.removeEventListener('click', onRefreshClick);
    cancelBtn.removeEventListener('click', onCancelClick);  // Fix #13
    document.removeEventListener('keydown', onKeyDown);
    // Fix #13: Remove dashboardLink listener
    if (dashboardLink) {
      dashboardLink.removeEventListener('click', onDashboardLinkClick);
    }
  });
}

init();