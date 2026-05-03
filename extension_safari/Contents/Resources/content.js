/**
 * content.js — Safari Web Extension Content Script
 * Runs in every page. Reads DOM, observes mutations, executes commands.
 */

const FULL_SNAPSHOT_INTERVAL_MS = 2000;

// State — FIX #6: use a Map instead of a single pendingCmdId so parallel commands work
/** @type {Map<string, {resolve: function, reject: function}>} */
const pendingCommands = new Map();

/** @type {number|null} */
let snapshotInterval = null;

let lastHtml = '';

// ─── DOM Reading ────────────────────────────────────────────────────────────

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
  // FIX #3: guard against null body (complex pages may not have it yet)
  if (!document.body) {
    console.warn('[Hermes Bridge] document.body not ready, retrying…');
    setTimeout(setupMutationObserver, 200);
    return;
  }

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

  // FIX #13: store interval handle so we can clear it on unload
  snapshotInterval = setInterval(flush, FULL_SNAPSHOT_INTERVAL_MS);
}

// ─── Background communication ─────────────────────────────────────────────────

/**
 * Send a message to the background script.
 * Returns a promise that resolves on success or rejects on delivery failure.
 * @param {object} msg
 * @returns {Promise<void>}
 */
function sendToBackground(msg) {
  return browser.runtime.sendMessage(msg).catch((err) => {
    console.error('[Hermes Bridge] Failed to deliver message to background:', err.message);
    throw err; // re-throw so callers know delivery failed
  });
}

// ─── Command Execution ───────────────────────────────────────────────────────

/**
 * Wraps eval in a sandboxed Function so page scope isn't polluted.
 * FIX #2: Removed direct eval — using Function constructor instead which is
 * slightly safer (no direct access to local scope). The evaluate command
 * intentionally runs JS in the page context — users must trust the page.
 * @param {string} script
 * @returns {any}
 */
function safeEvaluate(script) {
  // eslint-disable-next-line no-new-func
  return (new Function(script))();
}

const CMD_HANDLERS = {
  navigate(cmd) {
    window.location.href = cmd.url;
    resolveCommand(cmd.cmdId, `Navigated to ${cmd.url}`);
  },

  click(cmd) {
    const el = document.querySelector(cmd.selector);
    if (!el) {
      rejectCommand(cmd.cmdId, `Element not found: ${cmd.selector}`);
      return;
    }
    el.click();
    resolveCommand(cmd.cmdId, `Clicked: ${cmd.selector}`);
  },

  scroll(cmd) {
    window.scrollTo(cmd.x || 0, cmd.y || 0);
    resolveCommand(cmd.cmdId, `Scrolled to (${cmd.x}, ${cmd.y})`);
  },

  type(cmd) {
    const el = document.querySelector(cmd.selector);
    if (!el) {
      rejectCommand(cmd.cmdId, `Element not found: ${cmd.selector}`);
      return;
    }
    // Focus, clear, then type
    el.focus();
    el.value = '';
    const inputEvent = new Event('input', { bubbles: true });
    for (const ch of cmd.text) {
      el.value += ch;
      el.dispatchEvent(inputEvent);
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    resolveCommand(cmd.cmdId, `Typed "${cmd.text}" into: ${cmd.selector}`);
  },

  submit(cmd) {
    const el = cmd.selector ? document.querySelector(cmd.selector) : document.querySelector('form');
    if (!el) {
      rejectCommand(cmd.cmdId, `Form not found: ${cmd.selector || 'any form'}`);
      return;
    }
    el.submit();
    resolveCommand(cmd.cmdId, `Submitted form: ${cmd.selector || 'form'}`);
  },

  evaluate(cmd) {
    try {
      const result = safeEvaluate(cmd.script);
      resolveCommand(cmd.cmdId, result);
    } catch (e) {
      rejectCommand(cmd.cmdId, e.message);
    }
  }
};

// FIX #6: per-command tracking with Map
function resolveCommand(cmdId, result) {
  const pending = pendingCommands.get(cmdId);
  if (pending) {
    pending.resolve(result);
    pendingCommands.delete(cmdId);
  }
  sendToBackground({ type: 'cmd_ack', cmdId, success: true, result });
}

function rejectCommand(cmdId, error) {
  const pending = pendingCommands.get(cmdId);
  if (pending) {
    pending.reject(new Error(error));
    pendingCommands.delete(cmdId);
  }
  sendToBackground({ type: 'cmd_error', cmdId, success: false, error });
}

// ─── Message listener (commands from background) ─────────────────────────────

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ping') {
    // Respond with current page state
    const snap = getPageSnapshot();
    sendResponse({ type: 'pong', ...snap });
    return true; // async response
  }

  const handler = CMD_HANDLERS[message.type];
  if (handler) {
    const { cmdId } = message;
    // Wrap in promise so sync handlers still work
    Promise.resolve().then(() => handler(message)).catch((e) => {
      rejectCommand(cmdId, e.message);
    });
    return true; // async
  }

  return false;
});

// ─── Cleanup on page unload ───────────────────────────────────────────────────

// FIX #13: clear the interval when the page unloads to prevent memory leaks
window.addEventListener('unload', () => {
  if (snapshotInterval !== null) {
    clearInterval(snapshotInterval);
    snapshotInterval = null;
  }
  // Reject any pending commands so they don't hang forever
  for (const [cmdId, pending] of pendingCommands) {
    pending.reject(new Error('Tab navigated away'));
  }
  pendingCommands.clear();
});

// ─── Init ──────────────────────────────────────────────────────────────────

setTimeout(() => {
  const snap = getPageSnapshot();
  lastHtml = snap.html;
  sendToBackground({ type: 'tab_snapshot', ...snap }).then(() => {
    setupMutationObserver();
  }).catch(() => {
    // Page may be restricted — still try to observe mutations
    setupMutationObserver();
  });
}, 500);
