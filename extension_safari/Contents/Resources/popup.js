/**
 * popup.js — Safari Web Extension Popup Logic
 *
 * Fix #11: URL retained on reconnect — last known URL preserved in sessionStorage
 * Fix #12: Manual refresh button — forces full snapshot
 * Fix #13: Command log — shows last N commands with success/error
 * Fix #17: No emoji — status dot is pure CSS
 */

const MAX_CMD_LOG = 5;

// ─── DOM refs ────────────────────────────────────────────────────────────────

const statusDot    = document.getElementById('status-dot');
const statusText   = document.getElementById('status-text');
const urlDisplay   = document.getElementById('url-display');
const activateBtn   = document.getElementById('activate-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const refreshBtn   = document.getElementById('refresh-btn');
const errorPanel   = document.getElementById('error-panel');
const errorText    = document.getElementById('error-text');
const infoText     = document.getElementById('info-text');
const versionText   = document.getElementById('version-text');
const cmdLogPanel  = document.getElementById('cmd-log-panel');
const cmdLogList   = document.getElementById('cmd-log-list');
const cmdCount     = document.getElementById('cmd-count');

// Dynamic version from manifest
try {
  const manifest = browser.runtime.getManifest();
  versionText.textContent = `v${manifest.version}`;
} catch { /* fallback */ }

let state = 'inactive';
let cmdLog = [];   // Fix #13: ring buffer of recent commands

// ─── Command log ─────────────────────────────────────────────────────────────

function addCmdLog(type, detail) {
  cmdLog.unshift({ type, detail, ts: Date.now() });
  if (cmdLog.length > MAX_CMD_LOG) cmdLog.pop();
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
    li.className = type;   // 'success' | 'error'
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
      break;

    case 'connecting':
      statusDot.classList.add('connecting');
      statusText.textContent = 'Connecting…';
      infoText.textContent = 'Connecting to proxy server at localhost:9321…';
      activateBtn.disabled = true;
      activateBtn.classList.add('disabled');
      break;

    case 'active':
      statusDot.classList.add('connected');
      statusText.textContent = 'Connected';
      activateBtn.classList.add('hidden');
      disconnectBtn.classList.remove('hidden');
      refreshBtn.classList.remove('hidden');
      urlDisplay.classList.add('active');
      // Fix #11: use last known URL if new one not available
      const displayUrl = extra.url || sessionStorage.getItem('hermes_last_url') || urlDisplay.textContent;
      if (displayUrl && displayUrl !== 'No tab active') {
        urlDisplay.textContent = displayUrl;
        sessionStorage.setItem('hermes_last_url', displayUrl);
      }
      infoText.textContent = 'Hermes Agent has full access to this tab.';
      break;

    case 'error':
      statusDot.classList.add('disconnected');
      statusText.textContent = 'Error';
      errorPanel.classList.remove('hidden');
      errorText.textContent = extra.message || 'Connection failed.';
      infoText.textContent = 'Make sure the proxy server is running: node proxy_server/server.js';
      break;
  }
}

// ─── Init ───────────────────────────────────────────────────────────────────

async function init() {
  setState('inactive');

  // Check current status — background already knows the URL
  try {
    const resp = await browser.runtime.sendMessage({ event: 'getStatus' });
    if (resp && resp.connected) {
      // Fix #11: restore last URL from sessionStorage on init
      const url = resp.url || sessionStorage.getItem('hermes_last_url') || resp.url;
      setState('active', { url: resp.url || url });
    } else if (resp && resp.url) {
      // Not connected yet but we have a URL — show it as inactive URL
      urlDisplay.textContent = resp.url;
      sessionStorage.setItem('hermes_last_url', resp.url);
    }
  } catch { /* background not ready */ }

  // Listen for background events
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.from !== 'background') return;

    if (msg.event === 'connected') {
      // Fix #11: keep the URL we already have — don't wipe it on reconnect
      const lastUrl = sessionStorage.getItem('hermes_last_url');
      setState('active', { url: lastUrl || undefined });
    } else if (msg.event === 'disconnected') {
      setState('inactive');
    } else if (msg.event === 'tab_activated') {
      sessionStorage.setItem('hermes_last_url', msg.url);
      setState('active', { url: msg.url });
    } else if (msg.event === 'error') {
      setState('error', { message: msg.message });
    } else if (msg.event === 'cmd_sent') {
      // Fix #13: log command being sent
      addCmdLog('pending', `${msg.cmdType} → ${msg.selector || msg.url || '(action)'}`);
    } else if (msg.event === 'cmd_done') {
      addCmdLog('success', `${msg.cmdType}: OK`);
    } else if (msg.event === 'cmd_error') {
      addCmdLog('error', `${msg.cmdType}: ${msg.error}`);
    }
  });
}

// ─── Button handlers ─────────────────────────────────────────────────────────

activateBtn.addEventListener('click', async () => {
  try {
    setState('connecting');
    await browser.runtime.sendMessage({ event: 'activate' });
  } catch (e) {
    if (state !== 'active') setState('error', { message: e.message });
  }
});

disconnectBtn.addEventListener('click', () => {
  browser.runtime.sendMessage({ event: 'disconnect' }).catch(() => {});
  setState('inactive');
  cmdLog = [];
  renderCmdLog();
});

// Fix #12: manual refresh
refreshBtn.addEventListener('click', () => {
  browser.runtime.sendMessage({ event: 'refreshSnapshot' }).catch(() => {});
  addCmdLog('pending', 'Refresh snapshot…');
});

init();
