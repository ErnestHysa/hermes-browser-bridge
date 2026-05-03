/**
 * content.js — Safari Web Extension Content Script
 * Runs in every page. Reads DOM, observes mutations, executes commands.
 */

const FULL_SNAPSHOT_INTERVAL_MS = 2000;
const PROXY_WS_URL = 'ws://localhost:9321';

// State
let lastHtml = '';
let pendingCmdId = null;
let reconnectTimer = null;

// ─── DOM Reading ─────────────────────────────────────────────────────────────

function getPageSnapshot() {
  try {
    return {
      url: window.location.href,
      title: document.title,
      html: document.documentElement.outerHTML
    };
  } catch (e) {
    return { url: window.location.href, title: document.title, html: '', error: e.message };
  }
}

// ─── Mutation Observer ───────────────────────────────────────────────────────

function setupMutationObserver() {
  let debounceTimer = null;
  let snapshotSeq = 0;

  const flush = () => {
    clearTimeout(debounceTimer);
    const snap = getPageSnapshot();
    if (snap.html !== lastHtml) {
      lastHtml = snap.html;
      snapshotSeq++;
      const snapshot = { ...snap, seq: snapshotSeq };
      sendToBackground({ type: 'tab_snapshot', ...snapshot });
    }
  };

  const observer = new MutationObserver((mutations) => {
    // Debounce: wait 100ms for DOM to settle
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      // Send incremental mutation data
      const mutationsData = mutations.map(m => ({
        type: m.type,
        target: m.target.nodeName,
        added: m.addedNodes.length,
        removed: m.removedNodes.length,
        text: m.target.nodeValue || ''
      }));
      sendToBackground({ type: 'mutation', mutations: mutationsData, url: window.location.href });

      // Trigger full snapshot on major changes
      const major = mutations.some(m =>
        m.type === 'childList' && (m.addedNodes.length > 5 || m.removedNodes.length > 0)
      );
      if (major) {
        flush();
      }
    }, 100);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: false,
    characterData: false
  });

  // Periodic full snapshot (ensures we catch的一切 even without mutations)
  setInterval(flush, FULL_SNAPSHOT_INTERVAL_MS);
}

// ─── Background communication ─────────────────────────────────────────────────

function sendToBackground(msg) {
  try {
    browser.runtime.sendMessage(msg).catch(() => {
      // Silent — content script may be isolated
    });
  } catch {
    // In case browser.runtime is not available
  }
}

// ─── Command Execution ───────────────────────────────────────────────────────

const CMD_HANDLERS = {
  navigate(cmd) {
    window.location.href = cmd.url;
    sendCmdAck(cmd.cmdId, `Navigated to ${cmd.url}`);
  },

  click(cmd) {
    const el = document.querySelector(cmd.selector);
    if (!el) {
      sendCmdError(cmd.cmdId, `Element not found: ${cmd.selector}`);
      return;
    }
    el.click();
    sendCmdAck(cmd.cmdId, `Clicked: ${cmd.selector}`);
  },

  scroll(cmd) {
    window.scrollTo(cmd.x || 0, cmd.y || 0);
    sendCmdAck(cmd.cmdId, `Scrolled to (${cmd.x}, ${cmd.y})`);
  },

  type(cmd) {
    const el = document.querySelector(cmd.selector);
    if (!el) {
      sendCmdError(cmd.cmdId, `Element not found: ${cmd.selector}`);
      return;
    }
    // Focus, clear, then type
    el.focus();
    el.value = '';
    // Use keyboard events for proper input triggering
    const inputEvent = new Event('input', { bubbles: true });
    for (const ch of cmd.text) {
      el.value += ch;
      el.dispatchEvent(inputEvent);
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    sendCmdAck(cmd.cmdId, `Typed "${cmd.text}" into: ${cmd.selector}`);
  },

  submit(cmd) {
    const el = cmd.selector ? document.querySelector(cmd.selector) : document.querySelector('form');
    if (!el) {
      sendCmdError(cmd.cmdId, `Form not found: ${cmd.selector || 'any form'}`);
      return;
    }
    el.submit();
    sendCmdAck(cmd.cmdId, `Submitted form: ${cmd.selector || 'form'}`);
  },

  evaluate(cmd) {
    try {
      // eslint-disable-next-line no-eval
      const result = eval(cmd.script);
      sendCmdAck(cmd.cmdId, result);
    } catch (e) {
      sendCmdError(cmd.cmdId, e.message);
    }
  }
};

function sendCmdAck(cmdId, result) {
  sendToBackground({ type: 'cmd_ack', cmdId, success: true, result });
}

function sendCmdError(cmdId, error) {
  sendToBackground({ type: 'cmd_error', cmdId, success: false, error });
}

// ─── Message listener (commands from background) ─────────────────────────────

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ping') {
    // Respond with current page state
    const snap = getPageSnapshot();
    sendResponse({ type: 'pong', ...snap });
    return true;
  }

  const handler = CMD_HANDLERS[message.type];
  if (handler) {
    pendingCmdId = message.cmdId;
    try {
      handler(message);
    } catch (e) {
      sendCmdError(message.cmdId, e.message);
    }
    return true;
  }

  return false;
});

// ─── Init ────────────────────────────────────────────────────────────────────

// Small delay to let the page settle
setTimeout(() => {
  const snap = getPageSnapshot();
  lastHtml = snap.html;
  sendToBackground({ type: 'tab_snapshot', ...snap });
  setupMutationObserver();
}, 500);
