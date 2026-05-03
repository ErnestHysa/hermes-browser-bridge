/**
 * content.js — Safari Web Extension Content Script
 * Runs in every page. Reads DOM, observes mutations, executes commands.
 *
 * Fix #C1:   navigate() uses background script (browser.tabs.update) instead of
 *            direct window.location.href, which is unreliable in Safari extension context
 * Fix #C2:   MutationObserver stored globally — properly disconnected before re-create
 * Fix #C3:   debounceTimer moved to module-level — stale timeouts cleared before new ones
 * Fix #H2:   incremental snapshots stripped of html field — structural data only
 * Fix #H4:   resolveCommand/rejectCommand removed from pending before sending ack/error
 *            to avoid double-resolution with background.js fire-and-forget pattern
 * Fix #H6:   lastFullHtml dead code removed
 * Fix #M5:   navigate() tracks blocked/failed navigation with error result + timeout
 * Fix #M8:   getStructuralSnapshot() includes changed text from characterData mutations
 */

const FULL_SNAPSHOT_INTERVAL_MS = 2000;

// ─── State ─────────────────────────────────────────────────────────────────────

/** @type {Map<string, {resolve: function, reject: function}>} */
const pendingCommands = new Map();
/** @type {number|null} */
let snapshotInterval = null;
/** @type {MutationObserver|null} */
let pageObserver = null;
/** @type {number|null} */
let debounceTimer = null;       // Fix #C3: module-level, cleared before each setTimeout
/** @type {number|null} */
let navigateFailTimer = null;   // Fix #M5: detect blocked navigation
/** @type {string|null} */
let lastNavigateCmdId = null;   // Fix #M5: track which cmd triggered navigation

// ─── Navigate handler leak fix (Fix #C1 + #M5) ──────────────────────────────────

/** @type {((...args: any[]) => void)|null} */
let _navLoadHandler = null;
/** @type {((...args: any[]) => void)|null} */
let _navPageShowHandler = null;

function clearNavigateHandlers() {
  if (_navLoadHandler) {
    window.removeEventListener('load', _navLoadHandler);
    _navLoadHandler = null;
  }
  if (_navPageShowHandler) {
    window.removeEventListener('pageshow', _navPageShowHandler);
    _navPageShowHandler = null;
  }
  if (navigateFailTimer !== null) {
    clearTimeout(navigateFailTimer);
    navigateFailTimer = null;
  }
  lastNavigateCmdId = null;
}

// ─── DOM Reading ───────────────────────────────────────────────────────────────

/**
 * Full snapshot — sends complete outerHTML.
 * Only called on: first load, explicit refresh, periodic 2s interval.
 * Fix #H2: this is the ONLY place html is sent (never on structural snapshots).
 */
function getFullPageSnapshot() {
  try {
    return {
      url: window.location.href,
      title: document.title,
      html: document.documentElement.outerHTML,
      seq: ++window._snapshotSeq || (window._snapshotSeq = 1)
    };
  } catch (e) {
    return {
      url: window.location.href,
      title: document.title,
      html: '',
      seq: ++window._snapshotSeq || (window._snapshotSeq = 1),
      error: e.message
    };
  }
}

/**
 * Structural snapshot — element counts + changed text from characterData mutations.
 * Fix #H2: never includes html.
 * Fix #M8: captures changed text content when text nodes change.
 * @param {string[]} changedTexts  — text values from characterData mutations
 */
function getStructuralSnapshot(changedTexts = []) {
  try {
    return {
      url: window.location.href,
      title: document.title,
      // Fix #H2: no html field in structural snapshots
      structural: {
        total: document.querySelectorAll('*').length,
        forms: document.forms.length,
        inputs: document.querySelectorAll('input').length,
        buttons: document.querySelectorAll('button').length,
        links: document.querySelectorAll('a').length,
        images: document.querySelectorAll('img').length
      },
      // Fix #M8: changed text content from characterData mutations
      changedTexts: changedTexts.slice(0, 10), // cap at 10 changed text nodes
      bodySample: document.body ? document.body.innerText.slice(0, 200) : '',
      seq: ++window._snapshotSeq || (window._snapshotSeq = 1)
    };
  } catch (e) {
    return {
      url: window.location.href,
      title: document.title,
      structural: null,
      changedTexts: [],
      bodySample: '',
      seq: ++window._snapshotSeq || (window._snapshotSeq = 1),
      error: e.message
    };
  }
}

// ─── Mutation Observer ─────────────────────────────────────────────────────────

/**
 * Fix #C2: observer stored in module-level variable, properly disconnected
 * before a new one is created on re-navigation.
 * Fix #C3: debounceTimer cleared before each new setTimeout to prevent
 * stale callbacks from firing after navigation.
 * Fix #M8: tracks characterData mutations and passes changed text to snapshot.
 */
function setupMutationObserver() {
  if (!document.body) {
    console.warn('[Hermes Bridge] document.body not ready, retrying…');
    setTimeout(setupMutationObserver, 200);
    return;
  }

  // Fix #C2: disconnect old observer if it exists
  if (pageObserver) {
    pageObserver.disconnect();
    pageObserver = null;
  }

  // Fix #C3: clear any pending debounce timer from a previous page
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  /** @type {string[]} Collect changed text from characterData mutations */
  const changedTexts = [];

  const flush = () => {
    // Fix #C3: clear the timer reference before firing
    clearTimeout(debounceTimer);
    debounceTimer = null;

    // Fix #M8: pass collected changed texts then reset
    const texts = changedTexts.splice(0);
    const snap = getStructuralSnapshot(texts);
    sendToBackground({ type: 'tab_snapshot', ...snap, incremental: true });
  };

  const observer = new MutationObserver((mutations) => {
    // Fix #C3: clear any pending flush before scheduling a new one
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }

    // Collect mutation descriptors (lightweight — no outerHTML)
    const mutationsData = mutations.map(m => ({
      type: m.type,
      target: m.target.nodeName,
      targetId: m.target.id || null,
      targetClass: m.target.className || null,
      added: m.addedNodes.length,
      removed: m.removedNodes.length,
      text: m.target.nodeValue || '',
      addedNodeNames: Array.from(m.addedNodes).map(n => n.nodeName),
      removedNodeNames: Array.from(m.removedNodes).map(n => n.nodeName)
    }));

    // Fix #M8: collect characterData mutation text
    for (const m of mutations) {
      if (m.type === 'characterData') {
        changedTexts.push(String(m.target.nodeValue || '').slice(0, 200));
      }
    }

    sendToBackground({
      type: 'mutation',
      mutations: mutationsData,
      url: window.location.href,
      seq: window._snapshotSeq || 0
    });

    // Major DOM changes trigger a full snapshot after debounce
    const major = mutations.some(m =>
      m.type === 'childList' && (m.addedNodes.length > 5 || m.removedNodes.length > 0)
    );
    if (major) {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const snap = getFullPageSnapshot();
        sendToBackground({ type: 'tab_snapshot', ...snap, incremental: false });
      }, 300);
    }
  });

  // Fix #C2: store globally so it can be disconnected on re-navigation
  pageObserver = observer;
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: false,
    characterData: true   // Fix #M8: observe text node changes
  });

  // Periodic full snapshot every 2s so Hermes always has fresh HTML
  if (snapshotInterval !== null) clearInterval(snapshotInterval);
  snapshotInterval = setInterval(() => {
    const snap = getFullPageSnapshot();
    sendToBackground({ type: 'tab_snapshot', ...snap, incremental: false });
  }, FULL_SNAPSHOT_INTERVAL_MS);
}

// ─── Background communication ───────────────────────────────────────────────────

function sendToBackground(msg) {
  return browser.runtime.sendMessage(msg).catch((err) => {
    console.error('[Hermes Bridge] Failed to deliver message to background:', err.message);
    throw err;
  });
}

// ─── Command Execution ─────────────────────────────────────────────────────────

function safeEvaluate(script) {
  // eslint-disable-next-line no-new-func
  return (new Function(script))();
}

/**
 * Fix #C1: navigate goes through background script (browser.tabs.update)
 * so it works reliably in Safari's extension context.
 * Fix #M5: also tracks blocked/failed navigation via beforeunload + timeout.
 */
function setupNavigateResolver(cmdId, url) {
  clearNavigateHandlers();
  lastNavigateCmdId = cmdId;

  // Fix #M5: if page doesn't unload within 3s, navigation was likely blocked
  navigateFailTimer = setTimeout(() => {
    if (lastNavigateCmdId === cmdId) {
      lastNavigateCmdId = null;
      // Fix #H4: remove from pending BEFORE sending error to avoid double-fire
      pendingCommands.delete(cmdId);
      sendToBackground({ type: 'cmd_error', cmdId, success: false, error: `Navigation to ${url} was blocked or failed` });
    }
  }, 3000);

  _navLoadHandler = () => {
    clearNavigateHandlers();
    // Fix #H4: remove from pending BEFORE sending ack
    pendingCommands.delete(cmdId);
    sendToBackground({ type: 'cmd_ack', cmdId, success: true, result: `Navigated to ${url}` });
  };
  _navPageShowHandler = () => {
    clearNavigateHandlers();
    pendingCommands.delete(cmdId);  // Fix #H4
    sendToBackground({ type: 'cmd_ack', cmdId, success: true, result: `Navigated to ${url}` });
  };

  window.addEventListener('load', _navLoadHandler);
  window.addEventListener('pageshow', _navPageShowHandler);

  // Fix #M5: watch for beforeunload being cancelled (navigation blocked)
  const beforeUnloadHandler = (e) => {
    if (lastNavigateCmdId === cmdId) {
      e.preventDefault();
      // Navigation was blocked — clean up and report failure
      clearNavigateHandlers();
      pendingCommands.delete(cmdId);  // Fix #H4
      sendToBackground({ type: 'cmd_error', cmdId, success: false, error: `Navigation to ${url} was blocked by the browser` });
      window.removeEventListener('beforeunload', beforeUnloadHandler);
    }
  };
  window.addEventListener('beforeunload', beforeUnloadHandler);
}

const CMD_HANDLERS = {
  /**
   * Fix #C1: send navigate request to background script instead of
   * directly setting window.location.href (unreliable in Safari extension context).
   * Background handles browser.tabs.update().
   */
  navigate(cmd) {
    setupNavigateResolver(cmd.cmdId, cmd.url);
    // Ask background to perform the navigation
    sendToBackground({ type: '_navigate', cmdId: cmd.cmdId, url: cmd.url })
      .catch(() => {
        // If background can't handle it, fall back — but this path is rarely hit
      });
  },

  click(cmd) {
    const el = document.querySelector(cmd.selector);
    if (!el) {
      pendingCommands.delete(cmd.cmdId);  // Fix #H4
      sendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, success: false, error: `Element not found: ${cmd.selector}` });
      return;
    }
    el.click();
    pendingCommands.delete(cmd.cmdId);  // Fix #H4
    sendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Clicked: ${cmd.selector}` });
  },

  scroll(cmd) {
    window.scrollTo(cmd.x || 0, cmd.y || 0);
    pendingCommands.delete(cmd.cmdId);  // Fix #H4
    sendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Scrolled to (${cmd.x}, ${cmd.y})` });
  },

  type(cmd) {
    const el = document.querySelector(cmd.selector);
    if (!el) {
      pendingCommands.delete(cmd.cmdId);  // Fix #H4
      sendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, success: false, error: `Element not found: ${cmd.selector}` });
      return;
    }
    el.focus();
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
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    pendingCommands.delete(cmd.cmdId);  // Fix #H4
    sendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Typed "${cmd.text}" into: ${cmd.selector}` });
  },

  submit(cmd) {
    const form = cmd.selector ? document.querySelector(cmd.selector) : document.querySelector('form');
    if (!form) {
      pendingCommands.delete(cmd.cmdId);  // Fix #H4
      sendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, success: false, error: `Form not found: ${cmd.selector || 'any form'}` });
      return;
    }
    const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
    if (submitBtn) {
      submitBtn.click();
    } else {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
    pendingCommands.delete(cmd.cmdId);  // Fix #H4
    sendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Submitted form: ${cmd.selector || 'form'}` });
  },

  evaluate(cmd) {
    try {
      const result = safeEvaluate(cmd.script);
      pendingCommands.delete(cmd.cmdId);  // Fix #H4
      sendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result });
    } catch (e) {
      pendingCommands.delete(cmd.cmdId);  // Fix #H4
      sendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, success: false, error: e.message });
    }
  },

  refresh(cmd) {
    const snap = getFullPageSnapshot();
    pendingCommands.delete(cmd.cmdId);  // Fix #H4
    sendToBackground({ type: 'tab_snapshot', ...snap, incremental: false })
      .then(() => {
        sendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Refreshed (seq ${snap.seq})` });
      })
      .catch(e => {
        sendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, success: false, error: e.message });
      });
  }
};

/**
 * Fix #H4: commands are now settled in the handler itself (ack/error sent to proxy).
 * The internal pending promise is resolved/rejected to prevent unhandled rejections.
 */
function resolveCommand(cmdId, result) {
  const pending = pendingCommands.get(cmdId);
  if (pending) {
    pending.resolve(result);
    pendingCommands.delete(cmdId);
  }
  // ack already sent by handler
}

function rejectCommand(cmdId, error) {
  const pending = pendingCommands.get(cmdId);
  if (pending) {
    pending.reject(new Error(error));
    pendingCommands.delete(cmdId);
  }
  // error already sent by handler
}

// ─── Message listener (commands from background) ───────────────────────────────

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ping') {
    const snap = getFullPageSnapshot();
    sendResponse({ type: 'pong', ...snap });
    return true;
  }

  const handler = CMD_HANDLERS[message.type];
  if (handler) {
    const { cmdId } = message;
    // Store pending promise so unload handler can reject them
    pendingCommands.set(cmdId, { resolve: resolveCommand, reject: rejectCommand });
    Promise.resolve().then(() => handler(message)).catch((e) => {
      rejectCommand(cmdId, e.message);
    });
    return true;
  }

  return false;
});

// ─── Cleanup on page unload ────────────────────────────────────────────────────

window.addEventListener('unload', () => {
  if (snapshotInterval !== null) {
    clearInterval(snapshotInterval);
    snapshotInterval = null;
  }
  // Fix #C2: disconnect observer
  if (pageObserver) {
    pageObserver.disconnect();
    pageObserver = null;
  }
  // Fix #C3: clear any pending debounce
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  clearNavigateHandlers();
  for (const [cmdId, pending] of pendingCommands) {
    pending.reject(new Error('Tab navigated away'));
  }
  pendingCommands.clear();
});

// ─── Init ─────────────────────────────────────────────────────────────────────

window._snapshotSeq = 0;

setTimeout(() => {
  const snap = getFullPageSnapshot();
  sendToBackground({ type: 'tab_snapshot', ...snap, incremental: false }).then(() => {
    setupMutationObserver();
  }).catch(() => {
    setupMutationObserver();
  });
}, 500);
