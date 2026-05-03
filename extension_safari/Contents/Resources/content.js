/**
 * content.js — Safari Web Extension Content Script
 * Runs in every page. Reads DOM, observes mutations, executes commands.
 */

const FULL_SNAPSHOT_INTERVAL_MS = 2000;

// State — parallel command tracking via Map
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
  // Guard against null body (complex pages may not have it yet)
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
      // H4 FIX: also observe characterData so text-node changes are captured
      const mutationsData = mutations.map(m => ({
        type: m.type,
        target: m.target.nodeName,
        targetId: m.target.id || null,
        targetClass: m.target.className || null,
        added: m.addedNodes.length,
        removed: m.removedNodes.length,
        text: m.target.nodeValue || '',
        // M2 FIX: include actual added/removed node names for meaningful diffs
        addedNodeNames: Array.from(m.addedNodes).map(n => n.nodeName),
        removedNodeNames: Array.from(m.removedNodes).map(n => n.nodeName)
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

  // H4 FIX: added characterData to capture text-node changes (contenteditable, autofill)
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: false,
    characterData: true
  });

  snapshotInterval = setInterval(flush, FULL_SNAPSHOT_INTERVAL_MS);
}

// ─── Background communication ─────────────────────────────────────────────────

/**
 * Send a message to the background script.
 * @param {object} msg
 * @returns {Promise<void>}
 */
function sendToBackground(msg) {
  return browser.runtime.sendMessage(msg).catch((err) => {
    console.error('[Hermes Bridge] Failed to deliver message to background:', err.message);
    throw err;
  });
}

// ─── Command Execution ───────────────────────────────────────────────────────

/**
 * Wraps script execution in a sandboxed Function constructor.
 * Runs in the page's global context — users must trust the page.
 * @param {string} script
 * @returns {any}
 */
function safeEvaluate(script) {
  // eslint-disable-next-line no-new-func
  return (new Function(script))();
}

// C2 FIX: navigate resolves on page load, not immediately
function setupNavigateResolver(cmdId, url) {
  const handler = () => {
    window.removeEventListener('load', handler);
    window.removeEventListener('pageshow', handler);
    resolveCommand(cmdId, `Navigated to ${url}`);
  };
  window.addEventListener('load', handler);
  window.addEventListener('pageshow', handler);
}

const CMD_HANDLERS = {
  navigate(cmd) {
    setupNavigateResolver(cmd.cmdId, cmd.url);
    window.location.href = cmd.url;
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

  // H1 FIX: batch-set value then fire input once — works with React/Vue synthetic events
  type(cmd) {
    const el = document.querySelector(cmd.selector);
    if (!el) {
      rejectCommand(cmd.cmdId, `Element not found: ${cmd.selector}`);
      return;
    }
    el.focus();
    // Set full value at once — React/Vue see this as a single coherent change
    const nativeInputSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ) || Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    );
    if (nativeInputSetter) {
      nativeInputSetter.set.call(el, cmd.text);
    } else {
      el.value = cmd.text;
    }
    // Single input event — React/Vue synthetic systems register for this
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    resolveCommand(cmd.cmdId, `Typed "${cmd.text}" into: ${cmd.selector}`);
  },

  // H2 FIX: click the submit button instead of calling native form.submit()
  // which bypasses JS event handlers
  submit(cmd) {
    const form = cmd.selector ? document.querySelector(cmd.selector) : document.querySelector('form');
    if (!form) {
      rejectCommand(cmd.cmdId, `Form not found: ${cmd.selector || 'any form'}`);
      return;
    }
    // Find the submit button and click it — fires all JS submit handlers
    const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
    if (submitBtn) {
      submitBtn.click();
    } else {
      // Fallback: dispatch a submit event on the form (still respects JS handlers)
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
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

// Per-command tracking with Map
function resolveCommand(cmdId, result) {
  const pending = pendingCommands.get(cmdId);
  if (pending) {
    pending.resolve(result);
    pendingCommands.delete(cmdId);
  }
  // L8 FIX: normalize cmd_ack result as { result } for consistent formatting
  sendToBackground({ type: 'cmd_ack', cmdId, success: true, result });
}

function rejectCommand(cmdId, error) {
  const pending = pendingCommands.get(cmdId);
  if (pending) {
    pending.reject(new Error(error));
    pendingCommands.delete(cmdId);
  }
  // L8 FIX: normalize error as { error } in cmd_error
  sendToBackground({ type: 'cmd_error', cmdId, success: false, error });
}

// ─── Message listener (commands from background) ─────────────────────────────

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ping') {
    const snap = getPageSnapshot();
    sendResponse({ type: 'pong', ...snap });
    return true;
  }

  const handler = CMD_HANDLERS[message.type];
  if (handler) {
    const { cmdId } = message;
    Promise.resolve().then(() => handler(message)).catch((e) => {
      rejectCommand(cmdId, e.message);
    });
    return true;
  }

  return false;
});

// ─── Cleanup on page unload ───────────────────────────────────────────────────

window.addEventListener('unload', () => {
  if (snapshotInterval !== null) {
    clearInterval(snapshotInterval);
    snapshotInterval = null;
  }
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
    setupMutationObserver();
  });
}, 500);
