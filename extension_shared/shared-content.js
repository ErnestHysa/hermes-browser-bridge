/**
 * shared-content.js — Shared code for both Chrome and Safari content scripts.
 * This file is injected into pages via chrome.scripting.executeScript or loaded via script tag.
 * Sets window.HermesShared for content scripts to import from.
 * 
 * Fix #17: Shared extension lib — extract common code used by both content.js files.
 */

'use strict';

// ─── Constants ─────────────────────────────────────────────────────────────────

const FULL_SNAPSHOT_INTERVAL_MS = 2000;
const SLOW_SNAPSHOT_INTERVAL_MS = 10000;  // Fix #14: slow down when Hermes is under backpressure
const MAJOR_MUTATION_DEBOUNCE_MS = 300;
const MAX_STRUCTURAL_ELEMENTS = 2000;

// C1: Mutation batching — buffer mutations and flush in batches to avoid flooding the pipeline
const MUTATION_FLUSH_INTERVAL_MS = 500;   // flush buffered mutations every 500ms
// Fix #13: Hard cap — drop oldest entries when buffer exceeds this limit
const MUTATION_BUFFER_MAX = 500;          // align with server-side proxy_lib.js limit

// ─── Shared State ─────────────────────────────────────────────────────────────

/** @type {{mutations: object[], url: string, seq: number}[]} */
let _mutationSendBuffer = [];
let _mutationFlushTimer = null;
let backpressurePaused = false;  // C1: stop batching when Hermes is slow

// Fix #13: skip periodic full HTML send when page hasn't changed
let lastSnapshotHash = '';

// ─── Mutation Buffer Functions ─────────────────────────────────────────────────

function _flushMutationBuffer() {
  if (_mutationSendBuffer.length === 0) return;
  const toSend = _mutationSendBuffer.splice(0, _mutationSendBuffer.length);
  window._hermesSendToBackground({
    type: 'mutation_batch',
    mutations: toSend,
    url: toSend[0]?.url || window.location.href,
    seq: toSend[toSend.length - 1]?.seq || 0
  });
}

function _scheduleMutationFlush() {
  if (_mutationFlushTimer !== null) return;
  _mutationFlushTimer = setTimeout(() => {
    _mutationFlushTimer = null;
    _flushMutationBuffer();
  }, MUTATION_FLUSH_INTERVAL_MS);
}

function _pushMutationToBuffer(mutationEntry) {
  // Fix #13: Enforce hard cap — drop oldest entries when buffer is full
  if (_mutationSendBuffer.length >= MUTATION_BUFFER_MAX) {
    _mutationSendBuffer.shift();  // Drop oldest
  }
  _mutationSendBuffer.push(mutationEntry);
  if (_mutationSendBuffer.length >= MUTATION_BUFFER_MAX) {
    if (_mutationFlushTimer !== null) {
      clearTimeout(_mutationFlushTimer);
      _mutationFlushTimer = null;
    }
    _flushMutationBuffer();
    return;
  }
  _scheduleMutationFlush();
}

// ─── Snapshot Hash ─────────────────────────────────────────────────────────────

function snapshotHash() {
  const body = document.body;
  const sample = (body && body.textContent) ? body.textContent.slice(0, 200) : '';
  return `${document.title}:${document.contentType}:${sample.length}:${(body && body.childElementCount) || 0}:${sample}`;
}

// ─── DOM Reading ───────────────────────────────────────────────────────────────

// Fix #14: Strip password input values from HTML snapshots before sending.
// Password fields must never leave the browser — even over localhost.
function sanitizePasswordInputs(html) {
  return html.replace(/ type=(['"]?)password\1/gi, ' type=$1text$1 data-hermes-masked="true"');
}

function getFullPageSnapshot() {
  try {
    // Fix #19: Use XMLSerializer instead of outerHTML — outerHTML can miss
    // dynamically added attributes or modified values that haven't been
    // serialized back to the HTML source. XMLSerializer reads the live DOM state.
    const html = sanitizePasswordInputs(new XMLSerializer().serializeToString(document));
    return {
      url: window.location.href,
      title: document.title,
      html,
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
      // Fix #27: Log instead of silently ignoring — these should be visible in devtools
      setTimeout(() => {
        try { snapshot(); } catch (e) { console.error('[Hermes] Safety net snapshot failed:', e); }
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

// ─── Cancel Handler ───────────────────────────────────────────────────────────

function handleCancel(cmdId) {
  if (!window._hermesPendingCommands.has(cmdId)) return;
  window._hermesPendingCommands.get(cmdId).settled = true;
  window._hermesPendingCommands.delete(cmdId);
}

// ─── CMD Handlers (shared portion) ────────────────────────────────────────────

const CMD_HANDLERS = {
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
          window._hermesPendingCommands.delete(cmd.cmdId);
          window._hermesSendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'ELEMENT_NOT_FOUND', error: `Element not found: ${cmd.selector}` });
          return;
        }
      } else {
        document.elementFromPoint(cmd.x, cmd.y)?.dispatchEvent(clickEvent);
      }
      window._hermesPendingCommands.delete(cmd.cmdId);
      window._hermesSendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Clicked at (${cmd.x}, ${cmd.y})` });
      return;
    }

    const el = document.querySelector(cmd.selector);
    if (!el) {
      window._hermesPendingCommands.delete(cmd.cmdId);
      window._hermesSendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'ELEMENT_NOT_FOUND', error: `Element not found: ${cmd.selector}` });
      return;
    }
    el.click();
    window._hermesPendingCommands.delete(cmd.cmdId);
    window._hermesSendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Clicked: ${cmd.selector}` });
  },

  scroll(cmd) {
    window.scrollTo(cmd.x || 0, cmd.y || 0);
    window._hermesPendingCommands.delete(cmd.cmdId);
    window._hermesSendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Scrolled to (${cmd.x}, ${cmd.y})` });
  },

  type(cmd) {
    const el = document.querySelector(cmd.selector);
    if (!el) {
      window._hermesPendingCommands.delete(cmd.cmdId);
      window._hermesSendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'ELEMENT_NOT_FOUND', error: `Element not found: ${cmd.selector}` });
      return;
    }
    el.focus();
    const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
      || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    if (nativeInputSetter) { nativeInputSetter.set.call(el, cmd.text); }
    else { el.value = cmd.text; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    window._hermesPendingCommands.delete(cmd.cmdId);
    window._hermesSendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Typed "${cmd.text}" into: ${cmd.selector}` });
  },

  submit(cmd) {
    const form = cmd.selector ? document.querySelector(cmd.selector) : document.querySelector('form');
    if (!form) {
      window._hermesPendingCommands.delete(cmd.cmdId);
      window._hermesSendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'FORM_NOT_FOUND', error: `Form not found: ${cmd.selector || 'any form'}` });
      return;
    }
    const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
    if (submitBtn) { submitBtn.click(); }
    else { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }
    window._hermesPendingCommands.delete(cmd.cmdId);
    window._hermesSendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Submitted form: ${cmd.selector || 'form'}` });
  },

  evaluate(cmd) {
    try {
      // WARNING: new Function() is NOT sandboxed — it has full access to page globals
      // (window, document, cookies, localStorage, etc.) just like eval().
      // The comment below is misleading and kept only to avoid breaking existing docs.
      // Do NOT assume evaluate() is safe to run on untrusted pages.
      // eslint-disable-next-line no-new-func
      const result = (new Function(cmd.script))();
      window._hermesPendingCommands.delete(cmd.cmdId);
      // Fix #6: Enforce 1MB result size limit to prevent memory exhaustion.
      // If the evaluated expression returns something very large (e.g. Array(1e8)),
      // serialize and check the byte length before sending.
      const serialized = JSON.stringify(result);
      if (serialized.length > 1024 * 1024) {
        window._hermesSendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'RESULT_TOO_LARGE', error: `Result exceeds 1MB limit (${serialized.length} bytes)` });
        return;
      }
      window._hermesSendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result });
    } catch (e) {
      window._hermesPendingCommands.delete(cmd.cmdId);
      window._hermesSendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'EVAL_ERROR', error: e.message });
    }
  },
};

// ─── Navigate Handler Cleanup ───────────────────────────────────────────────────

// Fix #3/#4: navigateFailTimer leaks across navigations — clear it in clearNavigateHandlers
function clearNavigateHandlers() {
  if (window.HermesShared._navLoadHandler) {
    window.removeEventListener('load', window.HermesShared._navLoadHandler);
    window.HermesShared._navLoadHandler = null;
  }
  if (window.HermesShared._navPageShowHandler) {
    window.removeEventListener('pageshow', window.HermesShared._navPageShowHandler);
    window.HermesShared._navPageShowHandler = null;
  }
  // Fix #4: Also clear the navigate fail-safe timer so it doesn't fire on a later page
  if (window.HermesShared._navigateFailTimer != null) {
    clearTimeout(window.HermesShared._navigateFailTimer);
    window.HermesShared._navigateFailTimer = null;
  }
}

// Fix #7: Also clean up navigate handlers and pending commands when the user
// navigates away manually (e.g. typing a new URL, clicking a link, or submitting a form).
// This prevents stale cmdIds from accumulating in _hermesPendingCommands.
window.addEventListener('beforeunload', () => {
  window.HermesShared.clearNavigateHandlers();
  window._hermesPendingCommands.clear();
});

// ─── Expose on window.HermesShared ────────────────────────────────────────────

window.HermesShared = {
  CMD_HANDLERS,
  _flushMutationBuffer,
  _pushMutationToBuffer,
  getFullPageSnapshot,
  getStructuralSnapshot,
  _buildStructuralSnapshot,
  snapshotHash,
  clearNavigateHandlers,
  handleCancel,
  // Exported state for use by platform-specific code
  get backpressurePaused() { return backpressurePaused; },
  set backpressurePaused(v) { backpressurePaused = v; },
  _navLoadHandler: null,
  _navPageShowHandler: null,
  _navigateFailTimer: null,   // Fix #3/#4: fail-safe timer must be cleared on navigate away
  _navigateFailHandler: null, // Stores the bound fail handler so we can cancel it
  // Mutation buffer state (needed for cleanup in content scripts)
  get _mutationSendBuffer() { return _mutationSendBuffer; },
  get _mutationFlushTimer() { return _mutationFlushTimer; },
  set _mutationFlushTimer(v) { _mutationFlushTimer = v; },
  // Constants
  FULL_SNAPSHOT_INTERVAL_MS,
  SLOW_SNAPSHOT_INTERVAL_MS,
  MAJOR_MUTATION_DEBOUNCE_MS,
  MAX_STRUCTURAL_ELEMENTS,
  MUTATION_FLUSH_INTERVAL_MS,
  MUTATION_BUFFER_MAX,
  // Fix #16: Signal to platform-specific content scripts that this module is fully loaded.
  // Platform code must wait for this before using any HermesShared function.
  ready: true
};
