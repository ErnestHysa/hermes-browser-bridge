/**
 * content.js — Chrome Extension Content Script (Manifest V3)
 *
 * All shared logic lives in extension_shared/shared-content.js.
 * This file only contains Chrome-specific glue: runtime.sendMessage
 * binding, shared module loading, navigate handler, and listener registration.
 */

'use strict';

window._hermesSendToBackground = (msg) => {
  return chrome.runtime.sendMessage(msg).catch((err) => {
    console.error('[Hermes Bridge] sendToBackground failed:', err.message);
    throw err;
  });
};
window._hermesPendingCommands = new Map();

(function loadSharedModule() {
  function tryInit() {
    if (typeof window.HermesShared !== 'undefined' && window.HermesShared.ready === true) {
      start();
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

function start() {
  const buildNavigateHandler = (cmd) => {
    window.HermesShared.clearNavigateHandlers();
    window.HermesShared._lastNavigateCmdId = cmd.cmdId;

    window.HermesShared._navigateFailHandler = () => {
      if (window.HermesShared._lastNavigateCmdId === cmd.cmdId) {
        window.HermesShared._lastNavigateCmdId = null;
        window.HermesShared.clearNavigateHandlers();
        window._hermesPendingCommands.delete(cmd.cmdId);
        window._hermesSendToBackground({ type: 'cmd_error', cmdId: cmd.cmdId, errorCode: 'NAVIGATE_BLOCKED', error: `Navigation to ${cmd.url} was blocked or failed` });
      }
    };
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
  };

  const onMessage = window.HermesShared.initContentScript(buildNavigateHandler);
  chrome.runtime.onMessage.addListener(onMessage);
}
