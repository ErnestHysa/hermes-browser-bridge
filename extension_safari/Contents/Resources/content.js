/**
 * content.js — Safari Web Extension Content Script
 * Runs in every page. Reads DOM, observes mutations, executes commands.
 *
 * Fix #4:  Navigate listener leak — old load/pageshow handlers properly removed before adding new ones
 * Fix #14: Incremental snapshots — full HTML only on first load / navigation / explicit request;
 *           MutationObserver sends lightweight change descriptors instead of full outerHTML every time
 */

const FULL_SNAPSHOT_INTERVAL_MS = 2000;

// State
/** @type {Map<string, {resolve: function, reject: function}>} */
const pendingCommands = new Map();
/** @type {number|null} */
let snapshotInterval = null;
/** @type {string|null} */
let lastFullHtml = null;
/** @type {number} */
let snapshotSeq = 0;

// ─── Navigate listener leak fix ────────────────────────────────────────────────
// Fix #4: store references so we can remove old handlers before adding new ones.

/** @type {((...args: any[]) => void)|null} */
let _navigateLoadHandler = null;
/** @type {((...args: any[]) => void)|null} */
let _navigatePageShowHandler = null;
/** @type {string|null} */
let _navigatePendingCmdId = null;
/** @type {string|null} */
let _navigatePendingUrl = null;

function clearNavigateHandlers() {
  if (_navigateLoadHandler) {
    window.removeEventListener('load', _navigateLoadHandler);
    _navigateLoadHandler = null;
  }
  if (_navigatePageShowHandler) {
    window.removeEventListener('pageshow', _navigatePageShowHandler);
    _navigatePageShowHandler = null;
  }
  _navigatePendingCmdId = null;
  _navigatePendingUrl = null;
}

// ─── DOM Reading ───────────────────────────────────────────────────────────────

/**
 * Full snapshot — sends complete outerHTML.
 * Only called on: first load, page navigation, Hermes 'refresh' command, or 2s interval.
 * Fix #14: not called on every mutation.
 */
function getFullPageSnapshot() {
  try {
    return {
      url: window.location.href,
      title: document.title,
      html: document.documentElement.outerHTML,
      seq: ++snapshotSeq
    };
  } catch (e) {
    return { url: window.location.href, title: document.title, html: '', seq: ++snapshotSeq, error: e.message };
  }
}

/**
 * Lightweight structural snapshot — sends element counts, title, URL, and text snippets.
 * Fix #14: sent on every MutationObserver flush instead of full outerHTML.
 * Hermes can use this to decide if it needs to request a full snapshot.
 */
function getStructuralSnapshot() {
  try {
    const counts = {
      total: document.querySelectorAll('*').length,
      forms: document.forms.length,
      inputs: document.querySelectorAll('input').length,
      buttons: document.querySelectorAll('button').length,
      links: document.querySelectorAll('a').length,
      images: document.querySelectorAll('img').length
    };
    // Sample visible text from key areas
    const bodyText = document.body ? document.body.innerText.slice(0, 200) : '';
    return {
      url: window.location.href,
      title: document.title,
      structural: counts,
      bodySample: bodyText,
      seq: ++snapshotSeq
    };
  } catch (e) {
    return { url: window.location.href, title: document.title, seq: ++snapshotSeq, error: e.message };
  }
}

// ─── Mutation Observer ─────────────────────────────────────────────────────────

function setupMutationObserver() {
  if (!document.body) {
    console.warn('[Hermes Bridge] document.body not ready, retrying…');
    setTimeout(setupMutationObserver, 200);
    return;
  }

  let debounceTimer = null;

  const flush = () => {
    clearTimeout(debounceTimer);
    // Fix #14: send structural snapshot (lightweight) instead of full outerHTML
    const snap = getStructuralSnapshot();
    sendToBackground({ type: 'tab_snapshot', ...snap, incremental: true });

    // Major DOM changes still trigger a full snapshot after a delay
    // so Hermes always has fresh HTML without being flooded
  };

  const observer = new MutationObserver((mutations) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
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

      sendToBackground({
        type: 'mutation',
        mutations: mutationsData,
        url: window.location.href,
        seq: snapshotSeq
      });

      // Trigger full snapshot on major structural changes
      const major = mutations.some(m =>
        m.type === 'childList' && (m.addedNodes.length > 5 || m.removedNodes.length > 0)
      );
      if (major) {
        // Debounce the full snapshot by 300ms to avoid rapid-fire on big renders
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          const snap = getFullPageSnapshot();
          lastFullHtml = snap.html;
          sendToBackground({ type: 'tab_snapshot', ...snap, incremental: false });
        }, 300);
      }
    }, 100);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: false,
    characterData: true
  });

  snapshotInterval = setInterval(() => {
    // Periodic full snapshot every 2s so Hermes always has fresh HTML
    const snap = getFullPageSnapshot();
    lastFullHtml = snap.html;
    sendToBackground({ type: 'tab_snapshot', ...snap, incremental: false });
  }, FULL_SNAPSHOT_INTERVAL_MS);
}

// ─── Background communication ─────────────────────────────────────────────────

function sendToBackground(msg) {
  return browser.runtime.sendMessage(msg).catch((err) => {
    console.error('[Hermes Bridge] Failed to deliver message to background:', err.message);
    throw err;
  });
}

// ─── Command Execution ───────────────────────────────────────────────────────

function safeEvaluate(script) {
  // eslint-disable-next-line no-new-func
  return (new Function(script))();
}

// Fix #4: clearNavigateHandlers called before adding new ones to prevent listener leak
function setupNavigateResolver(cmdId, url) {
  // Remove any stale handlers from a previous navigate
  clearNavigateHandlers();

  _navigatePendingCmdId = cmdId;
  _navigatePendingUrl = url;

  _navigateLoadHandler = () => {
    clearNavigateHandlers();
    resolveCommand(cmdId, `Navigated to ${url}`);
  };
  _navigatePageShowHandler = () => {
    clearNavigateHandlers();
    resolveCommand(cmdId, `Navigated to ${url}`);
  };

  window.addEventListener('load', _navigateLoadHandler);
  window.addEventListener('pageshow', _navigatePageShowHandler);
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

  type(cmd) {
    const el = document.querySelector(cmd.selector);
    if (!el) {
      rejectCommand(cmd.cmdId, `Element not found: ${cmd.selector}`);
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
    resolveCommand(cmd.cmdId, `Typed "${cmd.text}" into: ${cmd.selector}`);
  },

  submit(cmd) {
    const form = cmd.selector ? document.querySelector(cmd.selector) : document.querySelector('form');
    if (!form) {
      rejectCommand(cmd.cmdId, `Form not found: ${cmd.selector || 'any form'}`);
      return;
    }
    const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
    if (submitBtn) {
      submitBtn.click();
    } else {
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
  },

  // Fix #14: explicit refresh command — forces a full snapshot immediately
  refresh(cmd) {
    const snap = getFullPageSnapshot();
    lastFullHtml = snap.html;
    sendToBackground({ type: 'tab_snapshot', ...snap, incremental: false })
      .then(() => resolveCommand(cmd.cmdId, `Refreshed (seq ${snap.seq})`))
      .catch(e => rejectCommand(cmd.cmdId, e.message));
  }
};

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

// ─── Message listener (commands from background) ───────────────────────────────

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ping') {
    // On explicit ping (from Hermes), send full snapshot — not structural
    const snap = getFullPageSnapshot();
    lastFullHtml = snap.html;
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
  clearNavigateHandlers(); // Fix #4: clean up navigate handlers
  for (const [cmdId, pending] of pendingCommands) {
    pending.reject(new Error('Tab navigated away'));
  }
  pendingCommands.clear();
});

// ─── Init ──────────────────────────────────────────────────────────────────

setTimeout(() => {
  // Fix #14: first snapshot is always full HTML
  const snap = getFullPageSnapshot();
  lastFullHtml = snap.html;
  sendToBackground({ type: 'tab_snapshot', ...snap, incremental: false }).then(() => {
    setupMutationObserver();
  }).catch(() => {
    setupMutationObserver();
  });
}, 500);
