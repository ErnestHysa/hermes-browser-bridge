/**
 * popup.js — Safari Web Extension Popup Logic
 */

// ─── DOM refs ────────────────────────────────────────────────────────────────

const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const urlDisplay = document.getElementById('url-display');
const activateBtn = document.getElementById('activate-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const errorPanel = document.getElementById('error-panel');
const errorText = document.getElementById('error-text');
const infoText = document.getElementById('info-text');
const versionText = document.getElementById('version-text');

// FIX #20: read version dynamically from manifest
try {
  const manifest = browser.runtime.getManifest();
  versionText.textContent = `v${manifest.version}`;
} catch {
  // Fallback to static
}

let state = 'inactive'; // 'inactive' | 'connecting' | 'active' | 'error'

// ─── UI State ───────────────────────────────────────────────────────────────

function setState(newState, extra = {}) {
  state = newState;

  // Reset all state classes
  statusDot.className = 'status-dot';
  errorPanel.classList.add('hidden');
  activateBtn.classList.remove('hidden', 'disabled');
  disconnectBtn.classList.add('hidden');
  activateBtn.disabled = false;
  urlDisplay.className = 'url-row';

  switch (newState) {
    case 'inactive':
      statusDot.textContent = '⚫';
      statusDot.classList.add('disconnected');
      statusText.textContent = 'Inactive';
      infoText.textContent = 'Click "Activate Tab" to give Hermes Agent access to your current page.';
      urlDisplay.textContent = 'No tab active';
      break;

    case 'connecting':
      statusDot.textContent = '🟡';
      statusDot.classList.add('connecting');
      statusText.textContent = 'Connecting…';
      infoText.textContent = 'Connecting to proxy server at localhost:9321…';
      activateBtn.disabled = true;
      activateBtn.classList.add('disabled');
      break;

    case 'active': {
      statusDot.textContent = '🟢';
      statusDot.classList.add('connected');
      statusText.textContent = 'Connected';
      activateBtn.classList.add('hidden');
      disconnectBtn.classList.remove('hidden');
      urlDisplay.classList.add('active');
      const displayUrl = extra.url || urlDisplay.textContent;
      if (displayUrl && displayUrl !== 'No tab active') {
        urlDisplay.textContent = displayUrl;
      }
      infoText.textContent = 'Hermes Agent has full access to this tab.';
      break;
    }

    case 'error':
      statusDot.textContent = '🔴';
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

  // Check current status from background
  try {
    const resp = await browser.runtime.sendMessage({ event: 'getStatus' });
    if (resp && resp.connected) {
      setState('active', { url: resp.url });
    }
  } catch {
    // Background not ready yet
  }

  // Listen for background events
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.from !== 'background') return;

    if (msg.event === 'connected') {
      setState('active');
    } else if (msg.event === 'disconnected') {
      setState('inactive');
    } else if (msg.event === 'tab_activated') {
      setState('active', { url: msg.url });
    } else if (msg.event === 'error') {
      setState('error', { message: msg.message });
    }
  });
}

// ─── Button handlers ─────────────────────────────────────────────────────────

activateBtn.addEventListener('click', async () => {
  setState('connecting');
  try {
    await browser.runtime.sendMessage({ event: 'activate' });
    // Response is handled by the onMessage listener above
  } catch (e) {
    setState('error', { message: e.message });
  }
});

disconnectBtn.addEventListener('click', () => {
  browser.runtime.sendMessage({ event: 'disconnect' }).catch(() => {});
  setState('inactive');
});

// ─── Start ───────────────────────────────────────────────────────────────────

init();
