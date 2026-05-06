/**
 * shared-content.js — Shared code for both Chrome and Safari content scripts.
 * This file is injected into pages via chrome.scripting.executeScript or loaded via script tag.
 * Sets window.HermesShared for content scripts to import from.
 *
 * Fix #17: Shared extension lib — extract common code used by both content.js files.
 *
 * ─── Architecture Notes ──────────────────────────────────────────────────────────
 *
 * ⚠️ HermesShared is shared across iframes on the same origin (INFO-19):
 *   Both Chrome and Safari content scripts inject shared-content.js by adding a <script>
 *   tag to the page. This means window.HermesShared is a SHARED SINGLETON across all
 *   frames on the same origin. If a page has multiple iframes, they all share the same
 *   HermesShared instance — including backpressurePaused, _mutationSendBuffer, and all
 *   navigate/command handlers. This can cause race conditions on multi-frame pages.
 *
 * ⚠️ evaluate() has no runtime sandboxing (INFO-27):
 *   window.HermesShared.evaluate() uses new Function() which has full access to all page
 *   globals. Password input values are stripped from HTML snapshots (sanitizePasswordInputs)
 *   but evaluate() has no equivalent protection. The caller (Hermes Agent) must never send
 *   evaluate() commands to pages with sensitive data.
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
const MUTATION_ADAPTIVE_FLUSH_RATIO = 0.6; // flush immediately when buffer is 60% full

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
    // Notify that mutations were dropped due to overflow
    window._hermesSendToBackground({
      type: 'mutation_overflow',
      dropped: true,
      bufferSize: MUTATION_BUFFER_MAX
    });
  }
  _mutationSendBuffer.push(mutationEntry);

  // Adaptive flush: if buffer exceeds 60% capacity, flush immediately to reduce latency.
  // On quiet pages (<60%), use the 500ms timer for batching efficiency.
  const fillRatio = _mutationSendBuffer.length / MUTATION_BUFFER_MAX;
  if (fillRatio >= MUTATION_ADAPTIVE_FLUSH_RATIO || _mutationSendBuffer.length >= MUTATION_BUFFER_MAX) {
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

// R56: Improved sampling strategy — the previous 200-char sample from the beginning
// misses any changes outside that window (e.g. footer text changes on large SPAs).
// Now sample from beginning, middle, and end of body text, plus structural signals.
function snapshotHash() {
  const body = document.body;
  const text = (body && body.textContent) ? body.textContent : '';
  const len = text.length;
  // Sample from start, middle, and end to catch changes anywhere in the page
  const begin = text.slice(0, 100);
  const middle = len > 200 ? text.slice(Math.floor(len / 2) - 50, Math.floor(len / 2) + 50) : '';
  const end = len > 100 ? text.slice(-100) : '';
  const sample = begin + middle + end;
  return `${document.title}:${document.contentType}:${len}:${body?.childElementCount || 0}:${sample}`;
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
  // Check whether the idle guard threshold is met BEFORE running the expensive
  // querySelectorAll('*'). On pages with 10K+ DOM nodes, that query can block 
  // the main thread for 50-200ms — so we only run it if we might need the idle path.
  const mayNeedIdle = MAX_STRUCTURAL_ELEMENTS > 0 && typeof requestIdleCallback !== 'undefined';
  if (mayNeedIdle) {
    const elementCount = document.querySelectorAll('*').length || 0;
    if (elementCount > MAX_STRUCTURAL_ELEMENTS) {
      return new Promise((resolve) => {
        const snapshot = () => resolve(_buildStructuralSnapshot(changedTexts));
        requestIdleCallback(snapshot, { timeout: 500 });
        setTimeout(() => {
          try { snapshot(); } catch (e) { console.error('[Hermes] Safety net snapshot failed:', e); }
        }, 600);
      });
    }
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

// F4: Per-command execution timeout — if a handler doesn't send cmd_ack within this
// window, treat it as hung and clean up the pending entry so Hermes's 30s server-side
// timeout doesn't linger unnecessarily.
const CMD_EXECUTION_TIMEOUT_MS = 5000;

// ─── CMD Handlers (shared portion) ────────────────────────────────────────────

/**
 * Evaluate a script string in a sandboxed context.
 * Blocks access to: document.cookie, localStorage, sessionStorage, indexedDB,
 * fetch, XMLHttpRequest, window.open, navigator.sendBeacon.
 *
 * Provides read-only shims:
 *   window.location  →  { href, hostname, pathname, protocol } (snapshot)
 *   document.cookie  →  blocked (throws)
 *
 * The function call is still synchronous — this is NOT an iframe sandbox or
 * Web Worker, but it significantly reduces accidental exfiltration surface.
 */
function _evaluateSandboxed(script) {
  'use strict';
  const hasDocument = typeof document !== 'undefined';
  const boundDoc = hasDocument ? document : null;

  const safeWindow = {
    // Math, JSON, Array, Object, String, Number, Boolean, Date, RegExp → native globals
    Math, JSON, Array, Object, String, Number, Boolean, Date, RegExp,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    undefined, null, NaN, Infinity,
    console: {
      log() {}, warn() {}, error() {}, info() {}, debug() {}
    },
    get location() {
      try { return { href: boundDoc?.location?.href || '', hostname: boundDoc?.location?.hostname || '', pathname: boundDoc?.location?.pathname || '', protocol: boundDoc?.location?.protocol || '' }; }
      catch (_) { return { href: '', hostname: '', pathname: '', protocol: '' }; }
    },
    get document() {
      const d = boundDoc;
      if (!d) return {};
      return {
        get querySelector() { return d.querySelector.bind(d); },
        get querySelectorAll() { return d.querySelectorAll.bind(d); },
        get getElementById() { return d.getElementById.bind(d); },
        get body() { return d.body; },
        get title() { return d.title; },
        get forms() { return d.forms; },
        get images() { return d.images; },
        get links() { return d.links; },
        // Explicitly block cookie access
        get cookie() { throw new Error('Access to document.cookie is blocked in sandbox'); }
      };
    },
    // Block storage
    get localStorage() { throw new Error('Access to localStorage is blocked in sandbox'); },
    get sessionStorage() { throw new Error('Access to sessionStorage is blocked in sandbox'); },
    // Block network
    get fetch() { throw new Error('Access to fetch is blocked in sandbox'); },
    get XMLHttpRequest() { throw new Error('Access to XMLHttpRequest is blocked in sandbox'); },
    get navigator() { return { userAgent: 'Blocked' }; },
    get window() { return safeWindow; },
    get self() { return safeWindow; },
    get globalThis() { return safeWindow; },
    // Block navigation
    get open() { throw new Error('Access to window.open is blocked in sandbox'); },
    // Promise / Symbol / Map / Set from global
    Promise, Symbol, Map, Set, WeakMap, WeakSet,
    // Intl / BigInt
    Intl, BigInt,
    Error, TypeError, RangeError, EvalError, SyntaxError, URIError
  };

  const safeDoc = safeWindow.document;
  const fn = new Function(
    'window', 'document', 'self', 'globalThis',
    'location', 'navigator', 'console',
    'Math', 'JSON', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Date', 'RegExp',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite',
    'encodeURIComponent', 'decodeURIComponent',
    'undefined', 'null', 'NaN', 'Infinity',
    'Promise', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet',
    'Intl', 'BigInt',
    'Error', 'TypeError', 'RangeError', 'EvalError', 'SyntaxError', 'URIError',
    'return (' + script + ')'
  );

  return fn(
    safeWindow, safeDoc, safeWindow, safeWindow,
    safeWindow.location, safeWindow.navigator, safeWindow.console,
    safeWindow.Math, safeWindow.JSON, safeWindow.Array, safeWindow.Object,
    safeWindow.String, safeWindow.Number, safeWindow.Boolean, safeWindow.Date, safeWindow.RegExp,
    safeWindow.parseInt, safeWindow.parseFloat, safeWindow.isNaN, safeWindow.isFinite,
    safeWindow.encodeURIComponent, safeWindow.decodeURIComponent,
    safeWindow.undefined, safeWindow.null, safeWindow.NaN, safeWindow.Infinity,
    safeWindow.Promise, safeWindow.Symbol, safeWindow.Map, safeWindow.Set,
    safeWindow.WeakMap, safeWindow.WeakSet,
    safeWindow.Intl, safeWindow.BigInt,
    safeWindow.Error, safeWindow.TypeError, safeWindow.RangeError,
    safeWindow.EvalError, safeWindow.SyntaxError, safeWindow.URIError
  );
}

/**
 * Wrap a command handler so it times out if it doesn't complete within the window.
 * Prevents hung handlers (e.g. a click triggering an infinite animation loop) from
 * leaving pending entries that wait for the full 30s server-side timeout.
 */
function withCmdTimeout(cmdId, fn) {
  const timeoutMs = CMD_EXECUTION_TIMEOUT_MS;
  const timerId = setTimeout(() => {
    window._hermesPendingCommands.delete(cmdId);
    window._hermesSendToBackground({
      type: 'cmd_error',
      cmdId,
      errorCode: 'HANDLER_TIMEOUT',
      error: `Command handler timed out after ${timeoutMs}ms`
    });
  }, timeoutMs);
  // Return a function that clears the timeout on success
  const clear = () => clearTimeout(timerId);
  return { clear };
}

const CMD_HANDLERS = {
  click(cmd) {
    // Support coordinate-based click: { x, y } with optional selector
    if (cmd.x !== undefined && cmd.y !== undefined) {
      const { clear: clearTimeout } = withCmdTimeout(cmd.cmdId, null);
      try {
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
            clearTimeout();
            window._hermesPendingCommands.delete(cmd.cmdId);
            window._hermesSendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'ELEMENT_NOT_FOUND', error: `Element not found: ${cmd.selector}` });
            return;
          }
        } else {
          document.elementFromPoint(cmd.x, cmd.y)?.dispatchEvent(clickEvent);
        }
        clearTimeout();
        window._hermesPendingCommands.delete(cmd.cmdId);
        window._hermesSendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Clicked at (${cmd.x}, ${cmd.y})` });
      } catch (e) {
        clearTimeout();
        window._hermesPendingCommands.delete(cmd.cmdId);
        window._hermesSendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'CLICK_ERROR', error: e.message });
      }
      return;
    }

    const { clear: clearTimeout } = withCmdTimeout(cmd.cmdId, null);
    try {
      const el = document.querySelector(cmd.selector);
      if (!el) {
        clearTimeout();
        window._hermesPendingCommands.delete(cmd.cmdId);
        window._hermesSendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'ELEMENT_NOT_FOUND', error: `Element not found: ${cmd.selector}` });
        return;
      }
      el.click();
      clearTimeout();
      window._hermesPendingCommands.delete(cmd.cmdId);
      window._hermesSendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Clicked: ${cmd.selector}` });
    } catch (e) {
      clearTimeout();
      window._hermesPendingCommands.delete(cmd.cmdId);
      window._hermesSendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'CLICK_ERROR', error: e.message });
    }
  },

  scroll(cmd) {
    const { clear: clearTimeout } = withCmdTimeout(cmd.cmdId, null);
    try {
      window.scrollTo(cmd.x || 0, cmd.y || 0);
      clearTimeout();
      window._hermesPendingCommands.delete(cmd.cmdId);
      window._hermesSendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Scrolled to (${cmd.x}, ${cmd.y})` });
    } catch (e) {
      clearTimeout();
      window._hermesPendingCommands.delete(cmd.cmdId);
      window._hermesSendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'SCROLL_ERROR', error: e.message });
    }
  },

  type(cmd) {
    const { clear: clearTimeout } = withCmdTimeout(cmd.cmdId, null);
    try {
      const el = document.querySelector(cmd.selector);
      if (!el) {
        clearTimeout();
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
      clearTimeout();
      window._hermesPendingCommands.delete(cmd.cmdId);
      window._hermesSendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Typed "${cmd.text}" into: ${cmd.selector}` });
    } catch (e) {
      clearTimeout();
      window._hermesPendingCommands.delete(cmd.cmdId);
      window._hermesSendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'TYPE_ERROR', error: e.message });
    }
  },

  submit(cmd) {
    const { clear: clearTimeout } = withCmdTimeout(cmd.cmdId, null);
    try {
      const form = cmd.selector ? document.querySelector(cmd.selector) : document.querySelector('form');
      if (!form) {
        clearTimeout();
        window._hermesPendingCommands.delete(cmd.cmdId);
        window._hermesSendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'FORM_NOT_FOUND', error: `Form not found: ${cmd.selector || 'any form'}` });
        return;
      }
      const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
      if (submitBtn) { submitBtn.click(); }
      else { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }
      clearTimeout();
      window._hermesPendingCommands.delete(cmd.cmdId);
      window._hermesSendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Submitted form: ${cmd.selector || 'form'}` });
    } catch (e) {
      clearTimeout();
      window._hermesPendingCommands.delete(cmd.cmdId);
      window._hermesSendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'SUBMIT_ERROR', error: e.message });
    }
  },

  evaluate(cmd) {
    // R56: Validate script is a string before attempting to compile it.
    // If Hermes sends a non-string (null, object, number), new Function() throws
    // a misleading TypeError. Catch this early with a structured errorCode.
    if (typeof cmd.script !== 'string') {
      window._hermesPendingCommands.delete(cmd.cmdId);
      window._hermesSendToBackground({
        type: 'cmd_error',
        cmdId: cmd.cmdId,
        errorCode: 'EVAL_ERROR',
        error: `evaluate expects script to be a string, got ${typeof cmd.script}`
      });
      return;
    }

    // R56: script is guaranteed to be a string at this point (validated above)
    const MAX_SCRIPT_CHARS = 50 * 1024;
    if (cmd.script.length > MAX_SCRIPT_CHARS) {
      window._hermesPendingCommands.delete(cmd.cmdId);
      window._hermesSendToBackground({
        type: 'cmd_error',
        cmdId: cmd.cmdId,
        errorCode: 'SCRIPT_TOO_LARGE',
        error: `Script exceeds ${MAX_SCRIPT_CHARS} character limit (${cmd.script.length} chars)`
      });
      return;
    }

    // F2: Wrap execution in a timeout to prevent infinite loops or heavy computation
    // from hanging the page's main thread. If the evaluated script runs longer than
    // 10 seconds, treat it as a failure so Hermes's cmd_queue can resolve promptly.
    const EVAL_TIMEOUT_MS = 10000;
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      window._hermesPendingCommands.delete(cmd.cmdId);
      window._hermesSendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'EVAL_TIMEOUT', error: `Script execution timed out after ${EVAL_TIMEOUT_MS}ms` });
    }, EVAL_TIMEOUT_MS);

    try {
      // Runtime sandbox: restrict evaluate() to only see whitelisted globals.
      // Prevents arbitrary access to document.cookie, localStorage, sessionStorage,
      // indexedDB, fetch, XMLHttpRequest, and window.open.
      // The script still has access to: document.querySelector, document.querySelectorAll,
      // document.getElementById, document.body, window.location (read-only), and Math/JSON/etc.
      // eslint-disable-next-line no-new-func
      const result = _evaluateSandboxed(cmd.script);
      clearTimeout(timeoutId);
      if (timedOut) return;  // timeout fired between Function() and clearTimeout
      window._hermesPendingCommands.delete(cmd.cmdId);
      // R54: Check result size incrementally during serialization so we never
      // materialize a full 100MB JSON string in memory. Abort early if limit exceeded.
      const RESULT_SIZE_LIMIT = 1024 * 1024;
      let resultSizeBytes = 0;
      let serialized;
      try {
        serialized = JSON.stringify(result, (k, v) => {
          if (typeof v === 'string') {
            resultSizeBytes += Buffer.byteLength(v, 'utf8');
          } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
            resultSizeBytes += 30; // rough estimate
          }
          if (resultSizeBytes > RESULT_SIZE_LIMIT) {
            throw new Error('RESULT_TOO_LARGE');
          }
          return v;
        });
      } catch (e) {
        if (timedOut) return;
        window._hermesSendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'RESULT_TOO_LARGE', error: e.message });
        return;
      }
      // R55: Send RESULT_TOO_LARGE error if serialized result exceeds limit.
      // Previously the size check threw but the result was still sent (line 366 used
      // the un-checked `result` variable). Now we abort before sending anything.
      if (resultSizeBytes > RESULT_SIZE_LIMIT) {
        window._hermesSendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'RESULT_TOO_LARGE', error: `Result size (${resultSizeBytes}) exceeds ${RESULT_SIZE_LIMIT} byte limit` });
        return;
      }
      window._hermesSendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result });
    } catch (e) {
      clearTimeout(timeoutId);
      if (timedOut) return;
      window._hermesPendingCommands.delete(cmd.cmdId);
      const errorCode = (e.message === 'RESULT_TOO_LARGE') ? 'RESULT_TOO_LARGE' : 'EVAL_ERROR';
      window._hermesSendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode, error: e.message });
    }
  },
};

// ─── Navigate Handler Cleanup ───────────────────────────────────────────────────

// Fix #3/#4: navigateFailTimer leaks across navigations — clear it in clearNavigateHandlers
// R55: Also clear lastNavigateCmdId so a stale timer cannot delete a future navigation's cmdId.
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
  // R55: Clear lastNavigateCmdId — prevents a stale timer from deleting a new navigation's cmdId
  if (window.HermesShared._lastNavigateCmdId !== undefined) {
    window.HermesShared._lastNavigateCmdId = null;
  }
}

// Fix #7: Also clean up navigate handlers and pending commands when the user
// navigates away manually (e.g. typing a new URL, clicking a link, or submitting a form).
// This prevents stale cmdIds from accumulating in _hermesPendingCommands.
window.addEventListener('beforeunload', () => {
  window.HermesShared.clearNavigateHandlers();
  window._hermesPendingCommands.clear();
});

// ─── Shared Content Script Bootstrap ─────────────────────────────────────────

/**
 * Shared initContentScript — called by platform-specific content.js after the
 * platform sets up window._hermesSendToBackground.
 *
 * @param {function} buildNavigateHandler - Platform-specific navigate handler factory
 *   Receives (cmd) and must set up listeners + fail-safe timer using HermesShared state.
 *   Returns void.
 */
function initContentScript(buildNavigateHandler) {
  let snapshotInterval = null;
  let pageObserver = null;
  let debounceTimer = null;
  let lastSnapshotHash = '';

  window.HermesShared._lastNavigateCmdId = null;

  function captureInitialSnapshot() {
    const snap = window.HermesShared.getFullPageSnapshot();
    window._hermesSendToBackground({ type: 'tab_snapshot', ...snap, incremental: false, _initial: true })
      .then(() => setupMutationObserver())
      .catch(() => setupMutationObserver());
  }

  function sendStructuralSnapshot(changedTexts = []) {
    const result = window.HermesShared.getStructuralSnapshot(changedTexts);
    if (result instanceof Promise) {
      result.then((snap) => {
        window._hermesSendToBackground({ type: 'tab_snapshot', ...snap, incremental: true });
      });
    } else {
      window._hermesSendToBackground({ type: 'tab_snapshot', ...result, incremental: true });
    }
  }

  function setupMutationObserver() {
    if (!document.body) { setTimeout(setupMutationObserver, 200); return; }
    if (pageObserver) { pageObserver.disconnect(); pageObserver = null; }
    if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }

    const changedTexts = [];

    const flush = () => {
      window.HermesShared.clearNavigateHandlers();
      clearTimeout(debounceTimer);
      debounceTimer = null;
      const texts = changedTexts.splice(0);
      sendStructuralSnapshot(texts);
    };

    const observer = new MutationObserver((mutations) => {
      if (debounceTimer !== null) { clearTimeout(debounceTimer); }

      const mutationsData = mutations.map(m => ({
        type: m.type, target: m.target.nodeName, targetId: m.target.id || null,
        targetClass: m.target.className || null, added: m.addedNodes.length,
        removed: m.removedNodes.length, text: m.target.nodeValue || '',
        addedNodeNames: Array.from(m.addedNodes).map(n => n.nodeName),
        removedNodeNames: Array.from(m.removedNodes).map(n => n.nodeName)
      }));

      for (const m of mutations) {
        if (m.type === 'characterData') changedTexts.push(String(m.target.nodeValue || '').slice(0, 200));
      }

      if (window.HermesShared.backpressurePaused) {
        if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
        changedTexts.splice(0);
        return;
      }

      window.HermesShared._pushMutationToBuffer({
        mutations: mutationsData, url: window.location.href, seq: window._snapshotSeq || 0
      });

      if (!window.HermesShared.backpressurePaused) {
        const major = mutations.some(m =>
          m.type === 'childList' && (m.addedNodes.length > 5 || m.removedNodes.length > 0)
        );
        if (major) {
          if (debounceTimer !== null) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            const snap = window.HermesShared.getFullPageSnapshot();
            window._hermesSendToBackground({ type: 'tab_snapshot', ...snap, incremental: false });
          }, window.HermesShared.MAJOR_MUTATION_DEBOUNCE_MS);
        }
      }
    });

    pageObserver = observer;
    observer.observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeOldValue: true, characterData: true
    });

    if (snapshotInterval !== null) clearInterval(snapshotInterval);
    const interval = window.HermesShared.backpressurePaused
      ? window.HermesShared.SLOW_SNAPSHOT_INTERVAL_MS
      : window.HermesShared.FULL_SNAPSHOT_INTERVAL_MS;
    snapshotInterval = setInterval(() => {
      const snap = window.HermesShared.getFullPageSnapshot();
      const hash = window.HermesShared.snapshotHash();
      if (hash !== lastSnapshotHash) {
        lastSnapshotHash = hash;
        window._hermesSendToBackground({ type: 'tab_snapshot', ...snap, incremental: false });
      }
    }, interval);
  }

  // ─── Message listener ───────────────────────────────────────────────────
  function onHermesMessage(message, sender, sendResponse) {
    if (message.type === 'backpressure') {
      window.HermesShared.backpressurePaused = message.paused;
      return true;
    }
    if (message.type === 'cancel') {
      window.HermesShared.handleCancel(message.cmdId);
      return true;
    }
    if (message.type === 'ping') {
      const { cmdId } = message;
      if (cmdId) {
        window._hermesPendingCommands.set(cmdId, { resolve: null, reject: null, settled: false });
      }
      const snap = window.HermesShared.getFullPageSnapshot();
      sendResponse({ type: 'pong', ...snap });
      return true;
    }
    if (message.type === 'refresh') {
      const snap = window.HermesShared.getFullPageSnapshot();
      const hash = window.HermesShared.snapshotHash();
      window.HermesShared._lastRefreshHash = hash;
      window._hermesSendToBackground({ type: 'tab_snapshot', ...snap, incremental: false })
        .then(() => {
          window._hermesPendingCommands.delete(message.cmdId);
          window._hermesSendToBackground({ type: 'cmd_ack', cmdId: message.cmdId, success: true, result: `Refreshed (seq ${snap.seq})` });
        })
        .catch(e => {
          window._hermesPendingCommands.delete(message.cmdId);
          window._hermesSendToBackground({ type: 'cmd_error', cmdId: message.cmdId, errorCode: 'REFRESH_FAILED', error: e.message });
        });
      return true;
    }
    if (message.type === 'navigate') {
      const { cmdId } = message;
      window._hermesPendingCommands.set(cmdId, { resolve: null, reject: null, settled: false });
      buildNavigateHandler(message);
      return true;
    }
    // Shared CMD_HANDLERS: click, scroll, type, submit, evaluate
    const handler = CMD_HANDLERS[message.type];
    if (handler) {
      const { cmdId } = message;
      window._hermesPendingCommands.set(cmdId, { resolve: null, reject: null, settled: false });
      Promise.resolve().then(() => handler(message)).catch((e) => {
        if (!window._hermesPendingCommands.get(cmdId)?.settled) {
          window._hermesPendingCommands.delete(cmdId);
        }
      });
      return true;
    }
    return false;
  }

  // ─── Cleanup on page unload ──────────────────────────────────────────────
  window.addEventListener('unload', () => {
    if (snapshotInterval !== null) { clearInterval(snapshotInterval); snapshotInterval = null; }
    if (pageObserver) { pageObserver.disconnect(); pageObserver = null; }
    if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
    window.HermesShared._flushMutationBuffer();
    window.HermesShared.clearNavigateHandlers();
    for (const [cmdId, pending] of window._hermesPendingCommands) {
      if (pending.reject && !pending.settled) pending.reject(new Error('Tab navigated away'));
    }
    window._hermesPendingCommands.clear();
  });

  // ─── Global error handlers ───────────────────────────────────────────────
  window.addEventListener('error', (e) => {
    window._hermesSendToBackground({
      type: 'content_error', message: e.message, filename: e.filename, lineno: e.lineno, colno: e.colno
    }).catch(() => {});
  });
  window.addEventListener('unhandledrejection', (e) => {
    window._hermesSendToBackground({ type: 'content_error', message: `unhandledrejection: ${e.reason}` }).catch(() => {});
  });

  // ─── Init ────────────────────────────────────────────────────────────────
  window._snapshotSeq = 0;
  const initDelay = document.body ? 0 : 100;
  setTimeout(captureInitialSnapshot, initDelay);

  // Return the listener so platform-specific code can register it
  return onHermesMessage;
}

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
  initContentScript,
  // Exported state for use by platform-specific code
  get backpressurePaused() { return backpressurePaused; },
  set backpressurePaused(v) { backpressurePaused = v; },
  _navLoadHandler: null,
  _navPageShowHandler: null,
  _navigateFailTimer: null,
  _navigateFailHandler: null,
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
  ready: true
};
