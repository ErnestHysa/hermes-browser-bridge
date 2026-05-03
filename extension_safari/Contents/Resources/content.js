/**
 * content.js — Safari Web Extension Content Script
 * Runs in every page. Reads DOM, observes mutations, executes commands.
 *
 * Fix #P1-4:  MutationObserver race — capture initial snapshot synchronously
 *             BEFORE observer starts, so no mutations are lost during setup.
 * Fix #P3-17: Handle 'cancel' command type — ignore if cmdId matches a pending
 *             command and do not send cmd_ack/error.
 * Fix #P3-18: DOM serialization uses requestIdleCallback to avoid main-thread
 *             blocking on large pages (5000+ elements).
 */

'use strict';

const FULL_SNAPSHOT_INTERVAL_MS = 2000;
const MAJOR_MUTATION_DEBOUNCE_MS = 300;
const MAX_STRUCTURAL_ELEMENTS = 2000;

// ─── State ─────────────────────────────────────────────────────────────────────

/** @type {Map<string, {resolve: function, reject: function, settled?: boolean}>} */
const pendingCommands = new Map();
/** @type {number|null} */
let snapshotInterval = null;
/** @type {MutationObserver|null} */
let pageObserver = null;
/** @type {number|null} */
let debounceTimer = null;
let navigateFailTimer = null;
let lastNavigateCmdId = null;
let backpressurePaused = false;  // Fix #6: stop MutationObserver batching when Hermes is slow

// Fix #13: skip periodic full HTML send when page hasn't changed
let lastSnapshotHash = '';
function snapshotHash() {
  const body = document.body;
  const sample = (body && body.textContent) ? body.textContent.slice(0, 200) : '';
  return `${document.title}:${document.contentType}:${sample.length}:${(body && body.childElementCount) || 0}:${sample}`;
}

// ─── Navigate handler leak fix ─────────────────────────────────────────────────

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
 * Uses requestIdleCallback when available to avoid main-thread jank.
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
 * Uses requestIdleCallback when page has many elements to avoid blocking.
 * @param {string[]} changedTexts
 */
function getStructuralSnapshot(changedTexts = []) {
  const elementCount = (document.querySelectorAll('*').length || 0);

  // Fix #7: For large pages, use requestIdleCallback with a forced-timeout fallback.
  // If requestIdleCallback never fires (busy page), the setTimeout always resolves.
  if (elementCount > MAX_STRUCTURAL_ELEMENTS && typeof requestIdleCallback !== 'undefined') {
    return new Promise((resolve) => {
      const snapshot = () => resolve(_buildStructuralSnapshot(changedTexts));
      const id = requestIdleCallback(snapshot, { timeout: 500 });
      // Safety net: if idle callback doesn't fire within 500ms, resolve anyway
      setTimeout(() => {
        try { snapshot(); } catch (_) {}
      }, 600);
    });
  }
  return Promise.resolve(_buildStructuralSnapshot(changedTexts));
}

function _buildStructuralSnapshot(changedTexts = []) {
  try {
    return {
      url: window.location.href,
      title: document.title,
      // No html field in structural snapshots
      structural: {
        total: document.querySelectorAll('*').length,
        forms: document.forms.length,
        inputs: document.querySelectorAll('input').length,
        buttons: document.querySelectorAll('button').length,
        links: document.querySelectorAll('a').length,
        images: document.querySelectorAll('img').length
      },
      changedTexts: changedTexts.slice(0, 10),
      bodySample: document.body ? document.body.innerText.slice(0, 200) : '',
      seq: window._snapshotSeq || 1
    };
  } catch (e) {
    return {
      url: window.location.href,
      title: document.title,
      structural: null,
      changedTexts: [],
      bodySample: '',
      seq: window._snapshotSeq || 1,
      error: e.message
    };
  }
}

// ─── Snapshot Sending ──────────────────────────────────────────────────────────

/**
 * P1-4 Fix: Immediately capture and send the current page state synchronously,
 * BEFORE the MutationObserver is attached, so zero initial mutations are missed.
 * Then start the observer.
 */
function captureInitialSnapshot() {
  // Synchronous snapshot before observer touches anything
  const snap = getFullPageSnapshot();
  lastSnapshotHash = snapshotHash();
  sendToBackground({ type: 'tab_snapshot', ...snap, incremental: false, _initial: true })
    .then(() => {
      // Observer starts only after first snapshot is confirmed sent
      setupMutationObserver();
    })
    .catch(() => {
      // Network hiccup — still start observer so we don't miss mutations
      setupMutationObserver();
    });
}

function sendStructuralSnapshot(changedTexts = []) {
  const result = getStructuralSnapshot(changedTexts);
  if (result instanceof Promise) {
    result.then((snap) => {
      sendToBackground({ type: 'tab_snapshot', ...snap, incremental: true });
    });
  } else {
    sendToBackground({ type: 'tab_snapshot', ...result, incremental: true });
  }
}

// ─── Mutation Observer ─────────────────────────────────────────────────────────

function setupMutationObserver() {
  if (!document.body) {
    setTimeout(setupMutationObserver, 200);
    return;
  }

  if (pageObserver) {
    pageObserver.disconnect();
    pageObserver = null;
  }

  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  /** @type {string[]} */
  const changedTexts = [];

  const flush = () => {
    clearTimeout(debounceTimer);
    debounceTimer = null;
    const texts = changedTexts.splice(0);
    sendStructuralSnapshot(texts);
  };

  const observer = new MutationObserver((mutations) => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }

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

    for (const m of mutations) {
      if (m.type === 'characterData') {
        changedTexts.push(String(m.target.nodeValue || '').slice(0, 200));
      }
    }

    // Fix #6: When backpressure is active, skip sending mutation events to reduce load
    if (!backpressurePaused) {
      sendToBackground({
        type: 'mutation',
        mutations: mutationsData,
        url: window.location.href,
        seq: window._snapshotSeq || 0
      });
    }

    // Major DOM changes trigger full snapshot after debounce (even when paused)
    const major = mutations.some(m =>
      m.type === 'childList' && (m.addedNodes.length > 5 || m.removedNodes.length > 0)
    );
    if (major) {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const snap = getFullPageSnapshot();
        sendToBackground({ type: 'tab_snapshot', ...snap, incremental: false });
      }, MAJOR_MUTATION_DEBOUNCE_MS);
    }
  });

  pageObserver = observer;
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    characterData: true
  });

  if (snapshotInterval !== null) clearInterval(snapshotInterval);
  snapshotInterval = setInterval(() => {
    const snap = getFullPageSnapshot();
    const hash = snapshotHash();
    // Fix #13: only send if the DOM state actually changed
    if (hash !== lastSnapshotHash) {
      lastSnapshotHash = hash;
      sendToBackground({ type: 'tab_snapshot', ...snap, incremental: false });
    }
  }, FULL_SNAPSHOT_INTERVAL_MS);
}

// ─── Background communication ───────────────────────────────────────────────────

function sendToBackground(msg) {
  return browser.runtime.sendMessage(msg).catch((err) => {
    console.error('[Hermes Bridge] sendToBackground failed:', err.message);
    throw err;
  });
}

// ─── Command Execution ─────────────────────────────────────────────────────────

const CMD_HANDLERS = {
  navigate(cmd) {
    // Clean up any previous navigate handlers before setting up new ones
    clearNavigateHandlers();
    lastNavigateCmdId = cmd.cmdId;

    // Fail-safe: if page doesn't fire load/pageshow within 10s, treat as blocked
    navigateFailTimer = setTimeout(() => {
      if (lastNavigateCmdId === cmd.cmdId) {
        clearNavigateHandlers();
        pendingCommands.delete(cmd.cmdId);
        sendToBackground({
          type: 'cmd_error',
          cmdId: cmd.cmdId,
          success: false,
          errorCode: 'NAVIGATE_TIMEOUT',
          error: `Navigation to ${cmd.url} was blocked or timed out`
        });
      }
    }, 10000);

    _navLoadHandler = () => {
      // Page finished loading
      clearNavigateHandlers();
      pendingCommands.delete(cmd.cmdId);
      sendToBackground({
        type: 'cmd_ack',
        cmdId: cmd.cmdId,
        success: true,
        result: `Navigated to ${cmd.url}`
      });
    };

    _navPageShowHandler = () => {
      // pageshow fires on bfcache restore too — treat as navigation success
      if (lastNavigateCmdId === cmd.cmdId) {
        clearNavigateHandlers();
        pendingCommands.delete(cmd.cmdId);
        sendToBackground({
          type: 'cmd_ack',
          cmdId: cmd.cmdId,
          success: true,
          result: `Navigated to ${cmd.url}`
        });
      }
    };

    window.addEventListener('load', _navLoadHandler);
    window.addEventListener('pageshow', _navPageShowHandler);
    sendToBackground({ type: '_navigate', cmdId: cmd.cmdId, url: cmd.url })
      .catch(() => {});
  },

  click(cmd) {
    // Support coordinate-based click: { x, y } with optional selector for element visibility check
    if (cmd.x !== undefined && cmd.y !== undefined) {
      const clickEvent = new MouseEvent('click', {
        clientX: cmd.x,
        clientY: cmd.y,
        bubbles: true,
        cancelable: true
      });
      // If a selector is provided, click the element at those coordinates (if it exists)
      if (cmd.selector) {
        const el = document.querySelector(cmd.selector);
        if (el) {
          el.dispatchEvent(clickEvent);
        } else {
          pendingCommands.delete(cmd.cmdId);
          sendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'ELEMENT_NOT_FOUND', error: `Element not found: ${cmd.selector}` });
          return;
        }
      } else {
        // Click at raw coordinates
        document.elementFromPoint(cmd.x, cmd.y)?.dispatchEvent(clickEvent);
      }
      pendingCommands.delete(cmd.cmdId);
      sendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Clicked at (${cmd.x}, ${cmd.y})` });
      return;
    }

    const el = document.querySelector(cmd.selector);
    if (!el) {
      pendingCommands.delete(cmd.cmdId);
      sendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'ELEMENT_NOT_FOUND', error: `Element not found: ${cmd.selector}` });
      return;
    }
    el.click();
    pendingCommands.delete(cmd.cmdId);
    sendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Clicked: ${cmd.selector}` });
  },

  scroll(cmd) {
    window.scrollTo(cmd.x || 0, cmd.y || 0);
    pendingCommands.delete(cmd.cmdId);
    sendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Scrolled to (${cmd.x}, ${cmd.y})` });
  },

  type(cmd) {
    const el = document.querySelector(cmd.selector);
    if (!el) {
      pendingCommands.delete(cmd.cmdId);
      sendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'ELEMENT_NOT_FOUND', error: `Element not found: ${cmd.selector}` });
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
    pendingCommands.delete(cmd.cmdId);
    sendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Typed "${cmd.text}" into: ${cmd.selector}` });
  },

  submit(cmd) {
    const form = cmd.selector ? document.querySelector(cmd.selector) : document.querySelector('form');
    if (!form) {
      pendingCommands.delete(cmd.cmdId);
      sendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'FORM_NOT_FOUND', error: `Form not found: ${cmd.selector || 'any form'}` });
      return;
    }
    const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
    if (submitBtn) {
      submitBtn.click();
    } else {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
    pendingCommands.delete(cmd.cmdId);
    sendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Submitted form: ${cmd.selector || 'form'}` });
  },

  evaluate(cmd) {
    // SECURITY WARNING: new Function() executes arbitrary JS in the page context.
    // Only use the evaluate command with scripts you trust. Malicious page scripts
    // can observe/modify the evaluated result via prototype overrides.
    try {
      // eslint-disable-next-line no-new-func
      const result = (new Function(cmd.script))();
      pendingCommands.delete(cmd.cmdId);
      sendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result });
    } catch (e) {
      pendingCommands.delete(cmd.cmdId);
      sendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'REFRESH_FAILED', error: e.message });
    }
  },

  refresh(cmd) {
    // Fix #10: Send snapshot then ack — never before the async send completes.
    // Only sends cmd_ack after tab_snapshot is confirmed delivered.
    const snap = getFullPageSnapshot();
    sendToBackground({ type: 'tab_snapshot', ...snap, incremental: false })
      .then(() => {
        pendingCommands.delete(cmd.cmdId);
        sendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Refreshed (seq ${snap.seq})` });
      })
      .catch(e => {
        pendingCommands.delete(cmd.cmdId);
        sendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'REFRESH_FAILED', error: e.message });
      });
  }
};

/**
 * P3-17 Fix: Handle cancel command — if this cmdId is pending, remove it
 * and do NOT send any ack/error back to the proxy.
 */
function handleCancel(cmdId) {
  if (!pendingCommands.has(cmdId)) return;
  const entry = pendingCommands.get(cmdId);
  entry.settled = true;
  pendingCommands.delete(cmdId);
  // Do NOT send cmd_ack or cmd_error — command was cancelled
}

// ─── Message listener ───────────────────────────────────────────────────────────

// Fix #6: Handle backpressure signal from background — pause/resume observer
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Backpressure: pause observer when Hermes is overwhelmed
  if (message.type === 'backpressure') {
    backpressurePaused = message.paused;
    return true;
  }

  // P3-17: Handle cancel command type
  if (message.type === 'cancel') {
    handleCancel(message.cmdId);
    return true;
  }

  if (message.type === 'ping') {
    const snap = getFullPageSnapshot();
    sendResponse({ type: 'pong', ...snap });
    return true;
  }

  const handler = CMD_HANDLERS[message.type];
  if (handler) {
    const { cmdId } = message;
    pendingCommands.set(cmdId, { resolve: null, reject: null, settled: false });
    Promise.resolve().then(() => handler(message)).catch((e) => {
      if (!pendingCommands.get(cmdId)?.settled) {
        pendingCommands.delete(cmdId);
      }
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
  if (pageObserver) {
    pageObserver.disconnect();
    pageObserver = null;
  }
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  clearNavigateHandlers();
  for (const [cmdId, pending] of pendingCommands) {
    if (pending.reject && !pending.settled) {
      pending.reject(new Error('Tab navigated away'));
    }
  }
  pendingCommands.clear();
});

// ─── Global error handlers (P1-4 / crash recovery) ──────────────────────────────

window.addEventListener('error', (e) => {
  sendToBackground({
    type: 'content_error',
    message: e.message,
    filename: e.filename,
    lineno: e.lineno,
    colno: e.colno
  }).catch(() => {});
});

window.addEventListener('unhandledrejection', (e) => {
  sendToBackground({
    type: 'content_error',
    message: `unhandledrejection: ${e.reason}`,
  }).catch(() => {});
});

// ─── Init ─────────────────────────────────────────────────────────────────────

window._snapshotSeq = 0;

// P1-4 Fix: Capture initial snapshot SYNCHRONOUSLY before observer starts
// Use a small delay only to ensure document.body is ready
const initDelay = document.body ? 0 : 100;
setTimeout(captureInitialSnapshot, initDelay);
