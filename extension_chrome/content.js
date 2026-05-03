/**
 * content.js — Chrome Extension Content Script (Manifest V3)
 * 
 * Identical logic to the Safari version but uses chrome.* APIs instead of browser.*.
 * The command set, MutationObserver behavior, and snapshot strategy are the same.
 * 
 * Fix #P2-7: Chrome extension implementation for parity with Safari.
 */

'use strict';

const FULL_SNAPSHOT_INTERVAL_MS = 2000;
const MAJOR_MUTATION_DEBOUNCE_MS = 300;
const MAX_STRUCTURAL_ELEMENTS = 2000;

// ─── State ─────────────────────────────────────────────────────────────────

const pendingCommands = new Map();
let snapshotInterval = null;
let pageObserver = null;
let debounceTimer = null;
let navigateFailTimer = null;
let lastNavigateCmdId = null;

// Fix #13: skip periodic full HTML send when page hasn't changed
let lastSnapshotHash = '';
function snapshotHash() {
  const body = document.body;
  const sample = (body && body.textContent) ? body.textContent.slice(0, 200) : '';
  return `${document.title}:${document.contentType}:${sample.length}:${(body && body.childElementCount) || 0}:${sample}`;
}

// ─── Navigate handler (Chrome) ─────────────────────────────────────────────────
let _navLoadHandler = null;
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

// ─── DOM Reading ─────────────────────────────────────────────────────────────

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

function getStructuralSnapshot(changedTexts = []) {
  const elementCount = document.querySelectorAll('*').length || 0;
  // Fix #7: Safari already has a setTimeout safety net; Chrome was missing it.
  // If requestIdleCallback never fires on a busy page, the Promise would hang forever.
  if (elementCount > MAX_STRUCTURAL_ELEMENTS && typeof requestIdleCallback !== 'undefined') {
    return new Promise((resolve) => {
      const snapshot = () => resolve(_buildStructuralSnapshot(changedTexts));
      requestIdleCallback(snapshot, { timeout: 500 });
      // Safety net: if idle callback doesn't fire within 600ms, resolve anyway
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

// ─── Snapshot Sending ────────────────────────────────────────────────────────

function captureInitialSnapshot() {
  const snap = getFullPageSnapshot();
  sendToBackground({ type: 'tab_snapshot', ...snap, incremental: false, _initial: true })
    .then(() => setupMutationObserver())
    .catch(() => setupMutationObserver());
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

// ─── Mutation Observer ─────────────────────────────────────────────────────

function setupMutationObserver() {
  if (!document.body) {
    setTimeout(setupMutationObserver, 200);
    return;
  }
  if (pageObserver) { pageObserver.disconnect(); pageObserver = null; }
  if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }

  const changedTexts = [];

  const flush = () => {
    clearTimeout(debounceTimer);
    debounceTimer = null;
    const texts = changedTexts.splice(0);
    sendStructuralSnapshot(texts);
  };

  const observer = new MutationObserver((mutations) => {
    if (debounceTimer !== null) { clearTimeout(debounceTimer); }

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

    sendToBackground({
      type: 'mutation',
      mutations: mutationsData,
      url: window.location.href,
      seq: window._snapshotSeq || 0
    });

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

// ─── Background communication (Chrome: chrome.runtime) ───────────────────────

function sendToBackground(msg) {
  return chrome.runtime.sendMessage(msg).catch((err) => {
    console.error('[Hermes Bridge] sendToBackground failed:', err.message);
    throw err;
  });
}

// ─── Command Execution ───────────────────────────────────────────────────────

const CMD_HANDLERS = {
  navigate(cmd) {
    clearNavigateHandlers();
    lastNavigateCmdId = cmd.cmdId;
    navigateFailTimer = setTimeout(() => {
      if (lastNavigateCmdId === cmd.cmdId) {
        lastNavigateCmdId = null;
        pendingCommands.delete(cmd.cmdId);
        sendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'NAVIGATE_BLOCKED', error: `Navigation to ${cmd.url} was blocked or failed` });
      }
    }, 3000);

    _navLoadHandler = () => {
      clearNavigateHandlers();
      pendingCommands.delete(cmd.cmdId);
      sendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Navigated to ${cmd.url}` });
    };
    _navPageShowHandler = () => {
      clearNavigateHandlers();
      pendingCommands.delete(cmd.cmdId);
      sendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Navigated to ${cmd.url}` });
    };
    window.addEventListener('load', _navLoadHandler);
    window.addEventListener('pageshow', _navPageShowHandler);
    sendToBackground({ type: '_navigate', cmdId: cmd.cmdId, url: cmd.url }).catch(() => {});
  },

  click(cmd) {
    // Support coordinate-based click: { x, y } with optional selector
    if (cmd.x !== undefined && cmd.y !== undefined) {
      const clickEvent = new MouseEvent('click', {
        clientX: cmd.x,
        clientY: cmd.y,
        bubbles: true,
        cancelable: true
      });
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
    const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
      || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    if (nativeInputSetter) { nativeInputSetter.set.call(el, cmd.text); }
    else { el.value = cmd.text; }
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
    if (submitBtn) { submitBtn.click(); }
    else { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }
    pendingCommands.delete(cmd.cmdId);
    sendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Submitted form: ${cmd.selector || 'form'}` });
  },

  evaluate(cmd) {
    try {
      // eslint-disable-next-line no-new-func
      const result = (new Function(cmd.script))();
      pendingCommands.delete(cmd.cmdId);
      sendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result });
    } catch (e) {
      pendingCommands.delete(cmd.cmdId);
      sendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'EVAL_ERROR', error: e.message });
    }
  },

  refresh(cmd) {
    const snap = getFullPageSnapshot();
    pendingCommands.delete(cmd.cmdId);
    sendToBackground({ type: 'tab_snapshot', ...snap, incremental: false })
      .then(() => sendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Refreshed (seq ${snap.seq})` }))
      .catch(e => sendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'REFRESH_FAILED', error: e.message }));
  }
};

function handleCancel(cmdId) {
  if (!pendingCommands.has(cmdId)) return;
  pendingCommands.get(cmdId).settled = true;
  pendingCommands.delete(cmdId);
}

// ─── Message listener ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
      if (!pendingCommands.get(cmdId)?.settled) pendingCommands.delete(cmdId);
    });
    return true;
  }
  return false;
});

// ─── Cleanup ────────────────────────────────────────────────────────────────

window.addEventListener('unload', () => {
  if (snapshotInterval !== null) { clearInterval(snapshotInterval); snapshotInterval = null; }
  if (pageObserver) { pageObserver.disconnect(); pageObserver = null; }
  if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
  clearNavigateHandlers();
  for (const [cmdId, pending] of pendingCommands) {
    if (pending.reject && !pending.settled) pending.reject(new Error('Tab navigated away'));
  }
  pendingCommands.clear();
});

window.addEventListener('error', (e) => {
  sendToBackground({ type: 'content_error', message: e.message, filename: e.filename, lineno: e.lineno, colno: e.colno }).catch(() => {});
});

window.addEventListener('unhandledrejection', (e) => {
  sendToBackground({ type: 'content_error', message: `unhandledrejection: ${e.reason}` }).catch(() => {});
});

// ─── Init ─────────────────────────────────────────────────────────────────

window._snapshotSeq = 0;
const initDelay = document.body ? 0 : 100;
setTimeout(captureInitialSnapshot, initDelay);
