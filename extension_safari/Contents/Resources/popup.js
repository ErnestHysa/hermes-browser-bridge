/**
 * popup.js — Safari Web Extension Popup Logic
 *
 * Fix #P1-6:  All event listeners are now registered with named functions stored
 *             in module variables, and removed when the popup is hidden/closed.
 *             This prevents listener accumulation on repeated open/close cycles.
 * Fix #P3-17: Added cancel button for pending commands.
 */

'use strict';

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

try {
  const manifest = browser.runtime.getManifest();
  versionText.textContent = `v${manifest.version}`;
} catch { /* fallback */ }

let state = 'inactive';
let cmdLog = [];
let pendingCmdId = null; // P3-17: track last pending cmd for cancel

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
  renderCmdLog();
}

function onRefreshClick() {
  browser.runtime.sendMessage({ event: 'refreshSnapshot' }).catch(() => {});
  addCmdLog('pending', 'Refresh snapshot…');
}

// P1-6: Named handler so we can remove it on popup close
function onBgMessage(msg) {
  if (msg.from !== 'background') return;

  if (msg.event === 'connected') {
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
    pendingCmdId = msg.cmdId; // P3-17
    addCmdLog('pending', `${msg.cmdType} → ${msg.selector || msg.url || '(action)'}`);
  } else if (msg.event === 'cmd_done') {
    pendingCmdId = null;
    addCmdLog('success', `${msg.cmdType}: OK`);
  } else if (msg.event === 'cmd_error') {
    pendingCmdId = null;
    addCmdLog('error', `${msg.cmdType}: ${msg.error}`);
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

  // P1-6: Cleanup on popup visibility change (covers close, tab switch, etc.)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // Remove listeners to prevent accumulation
      browser.runtime.onMessage.removeListener(onBgMessage);
      activateBtn.removeEventListener('click', onActivateClick);
      disconnectBtn.removeEventListener('click', onDisconnectClick);
      refreshBtn.removeEventListener('click', onRefreshClick);
    }
  });

  // P1-6: Also clean up on pagehide (Safari's equivalent of beforeunload)
  window.addEventListener('pagehide', () => {
    browser.runtime.onMessage.removeListener(onBgMessage);
    activateBtn.removeEventListener('click', onActivateClick);
    disconnectBtn.removeEventListener('click', onDisconnectClick);
    refreshBtn.removeEventListener('click', onRefreshClick);
  });
}

init();
