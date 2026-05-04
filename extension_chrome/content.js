/**
 * content.js — Chrome Extension Content Script (Manifest V3)
 *
 * Identical logic to the Safari version but uses chrome.* APIs instead of browser.*.
 * The command set, MutationObserver behavior, and snapshot strategy are the same.
 *
 * Fix #P2-7: Chrome extension implementation for parity with Safari.
 * Fix #17: Shared extension lib — imports shared code from extension_shared/shared-content.js.
 */

'use strict';

// ─── Load shared module (script tag approach for content scripts) ────────────────

// window._hermesSendToBackground must be defined BEFORE loading shared-content.js
const _chromeSendToBackground = (msg) => {
  return chrome.runtime.sendMessage(msg).catch((err) => {
    console.error('[Hermes Bridge] sendToBackground failed:', err.message);
    throw err;
  });
};
window._hermesSendToBackground = _chromeSendToBackground;
window._hermesPendingCommands = new Map();

// Load shared module if not already loaded, and wait for it to be ready.
// Fix #16: Dynamic script injection is asynchronous — HermesShared functions may not
// be available immediately after the script tag is appended. Poll until ready.
(function loadSharedModule() {
  function tryInit() {
    if (typeof window.HermesShared !== 'undefined' && window.HermesShared.ready === true) {
      initHermesContent();
    } else {
      setTimeout(tryInit, 10);
    }
  }
  if (typeof window.HermesShared === 'undefined') {
    const sharedScript = document.createElement('script');
    sharedScript.src = chrome.runtime.getURL('extension_shared/shared-content.js');
    sharedScript.onload = function() { sharedScript.remove(); };
    (document.head || document.documentElement).appendChild(sharedScript);
  }
  tryInit();
})();

// ─── State ─────────────────────────────────────────────────────────────────

function initHermesContent() {
  let snapshotInterval = null;
  let pageObserver = null;
  let debounceTimer = null;
  let lastSnapshotHash = '';

  // ─── Navigate Handler State (Chrome-specific) ────────────────────────────────
  // R55: Store on HermesShared so shared clearNavigateHandlers() can clear it
  window.HermesShared._lastNavigateCmdId = null;

  // ─── Snapshot Sending ────────────────────────────────────────────────────────

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
      // Fix #8: clear navigate handlers before major DOM changes to prevent
      // handlers from a previous page firing on the new page's DOM
      window.HermesShared.clearNavigateHandlers();
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

      // Fix #7: When paused, clear debounce timer and drop stale changedTexts
      // so we don't send stale data on resume. Also drop mutations entirely.
      if (window.HermesShared.backpressurePaused) {
        if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
        changedTexts.splice(0);  // Reset stale data
        return;  // Drop mutation — don't accumulate
      }

      // C1: Buffer mutations and send in batches
      window.HermesShared._pushMutationToBuffer({
        mutations: mutationsData,
        url: window.location.href,
        seq: window._snapshotSeq || 0
      });

      // Fix #10: Major DOM mutations also skip snapshot when backpressurePaused.
      // The debounce timer itself should not be set if paused — otherwise a 300ms
      // timer fires and calls getFullPageSnapshot() right when Hermes is overwhelmed.
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
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true
    });

    if (snapshotInterval !== null) clearInterval(snapshotInterval);
    // Fix #14: use adaptive interval — slow (10s) when Hermes is under backpressure, normal (2s) otherwise
    const interval = window.HermesShared.backpressurePaused
      ? window.HermesShared.SLOW_SNAPSHOT_INTERVAL_MS
      : window.HermesShared.FULL_SNAPSHOT_INTERVAL_MS;
    snapshotInterval = setInterval(() => {
      const snap = window.HermesShared.getFullPageSnapshot();
      const hash = window.HermesShared.snapshotHash();
      // Fix #13: only send if the DOM state actually changed
      if (hash !== lastSnapshotHash) {
        lastSnapshotHash = hash;
        window._hermesSendToBackground({ type: 'tab_snapshot', ...snap, incremental: false });
      }
    }, interval);
  }

  // ─── Command Execution (Chrome-specific navigate handler) ─────────────────────

  const _chromeCMDHandlers = {
    navigate(cmd) {
      window.HermesShared.clearNavigateHandlers();
      window.HermesShared._lastNavigateCmdId = cmd.cmdId;
      // Fix #3: Use HermesShared._navigateFailTimer so clearNavigateHandlers can cancel it
      window.HermesShared._navigateFailHandler = () => {
        if (window.HermesShared._lastNavigateCmdId === cmd.cmdId) {
          window.HermesShared._lastNavigateCmdId = null;
          // Fix #3: Clean up nav listeners when timer fires (navigation failed/neither event fired)
          window.HermesShared.clearNavigateHandlers();
          window._hermesPendingCommands.delete(cmd.cmdId);
          window._hermesSendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'NAVIGATE_BLOCKED', error: `Navigation to ${cmd.url} was blocked or failed` });
        }
      };
      // Fix #3: Unify navigate timeout — Safari uses 10s, Chrome used 3s. Use 10s as the single shared value.
      window.HermesShared._navigateFailTimer = setTimeout(window.HermesShared._navigateFailHandler, 10000);

      window.HermesShared._navLoadHandler = () => {
        window.HermesShared.clearNavigateHandlers();
        window._hermesPendingCommands.delete(cmd.cmdId);
        window._hermesSendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Navigated to ${cmd.url}` });
      };
      window.HermesShared._navPageShowHandler = () => {
        window.HermesShared.clearNavigateHandlers();
        window._hermesPendingCommands.delete(cmd.cmdId);
        window._hermesSendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Navigated to ${cmd.url}` });
      };
      // Fix #8: wrap event listener setup in try/catch for restricted pages
      try {
        window.addEventListener('load', window.HermesShared._navLoadHandler);
        window.addEventListener('pageshow', window.HermesShared._navPageShowHandler);
      } catch (e) {
        window.HermesShared.clearNavigateHandlers();
        window._hermesPendingCommands.delete(cmd.cmdId);
        window._hermesSendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'RESTRICTED_PAGE', error: 'Cannot set up navigation listeners on this page' });
        return;
      }
      window._hermesSendToBackground({ type: '_navigate', cmdId: cmd.cmdId, url: cmd.url }).catch(() => {});
    },

    refresh(cmd) {
      const snap = window.HermesShared.getFullPageSnapshot();
      // Fix #13: Don't delete cmdId until AFTER the send confirmation resolves.
      // If deleted before, a Hermes cancel command arriving mid-flight won't find
      // the cmdId in _hermesPendingCommands and could race with the pending send.
      window._hermesSendToBackground({ type: 'tab_snapshot', ...snap, incremental: false })
        .then(() => {
          window._hermesPendingCommands.delete(cmd.cmdId);
          return window._hermesSendToBackground({ type: 'cmd_ack', cmdId: cmd.cmdId, success: true, result: `Refreshed (seq ${snap.seq})` });
        })
        .catch(e => {
          window._hermesPendingCommands.delete(cmd.cmdId);
          return window._hermesSendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'REFRESH_FAILED', error: e.message });
        });
    }
  };

  // Merge Chrome-specific handlers with shared handlers
  const CMD_HANDLERS = {
    ...window.HermesShared.CMD_HANDLERS,
    ..._chromeCMDHandlers
  };

  // ─── Message listener ─────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // C1: Handle backpressure signal from background — pause/resume mutation batching
    if (message.type === 'backpressure') {
      window.HermesShared.backpressurePaused = message.paused;
      return true;
    }
    if (message.type === 'cancel') {
      window.HermesShared.handleCancel(message.cmdId);
      return true;
    }
    if (message.type === 'ping') {
      // Fix #14: Set up a pending command entry so the ping returns cmd_ack, not fire-and-forget.
      // This makes ping consistent with other commands and allows the background to wait for it.
      const { cmdId } = message;
      if (cmdId) {
        window._hermesPendingCommands.set(cmdId, { resolve: null, reject: null, settled: false });
      }
      const snap = window.HermesShared.getFullPageSnapshot();
      sendResponse({ type: 'pong', ...snap });
      return true;
    }
    const handler = CMD_HANDLERS[message.type];
    if (handler) {
      const { cmdId } = message;
      window._hermesPendingCommands.set(cmdId, { resolve: null, reject: null, settled: false });
      Promise.resolve().then(() => handler(message)).catch((e) => {
        if (!window._hermesPendingCommands.get(cmdId)?.settled) window._hermesPendingCommands.delete(cmdId);
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
    // C1: Flush any pending buffered mutations before unloading
    window.HermesShared._flushMutationBuffer();
    window.HermesShared.clearNavigateHandlers();
    for (const [cmdId, pending] of window._hermesPendingCommands) {
      if (pending.reject && !pending.settled) pending.reject(new Error('Tab navigated away'));
    }
    window._hermesPendingCommands.clear();
  });

  window.addEventListener('error', (e) => {
    window._hermesSendToBackground({ type: 'content_error', message: e.message, filename: e.filename, lineno: e.lineno, colno: e.colno }).catch(() => {});
  });

  window.addEventListener('unhandledrejection', (e) => {
    window._hermesSendToBackground({ type: 'content_error', message: `unhandledrejection: ${e.reason}` }).catch(() => {});
  });

  // ─── Init ─────────────────────────────────────────────────────────────────

  window._snapshotSeq = 0;
  const initDelay = document.body ? 0 : 100;
  setTimeout(captureInitialSnapshot, initDelay);
}
