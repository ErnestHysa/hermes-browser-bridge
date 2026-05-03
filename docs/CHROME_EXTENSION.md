# Chrome Extension — Specification

**Status: Not yet implemented. Built after Safari extension validates.**

This document describes the Chrome Web Extension variant of Hermes Browser Bridge.
It mirrors the Safari extension architecture but uses Chrome's Web Extensions API.

## Architecture

```
Hermes Agent
    │
    │ HTTP localhost:9321 (same proxy)
    ▼
proxy_server/server.js ◄── WebSocket (ws://localhost:9321)
    │
    │ Chrome extension connects here
    ▼
Chrome Web Extension (Manifest V3)
    ├── background.js   ← Service worker: WS client, message routing
    ├── content.js      ← Injected into tab: DOM read, MutationObserver, cmd exec
    └── popup.html/js  ← Click-to-activate UI
```

**Key advantage**: Chrome's Manifest V3 service worker lifecycle is more predictable than Safari's background page. Service workers wake on events and stay alive during active connections.

## File Structure (Chrome variant)

```
extension_chrome/
├── manifest.json         ← Manifest V3, "service_worker": "background.js"
├── background.js         ← Service worker, WS client, message routing
├── content.js            ← Injected script: DOM reader + MutationObserver + cmd executor
├── popup.html
├── popup.css
├── popup.js
└── icons/               ← Same icons as Safari (reuse images/ from Safari extension)
    ├── icon-16.png
    ├── icon-48.png
    ├── icon-96.png
    └── icon-128.png
```

## Key Differences from Safari Extension

| Feature | Safari | Chrome |
|---|---|---|
| Background page | SafariWebExtensionHandler (native binary + background page) | Chrome Service Worker (Manifest V3) |
| Popup persistence | Background page always alive | Service worker sleeps after 30s idle |
| WS connection | Background page keeps WS alive | Service worker must reconnect on wake |
| Browser API | `browser.*` (Firefox-compatible) | `chrome.*` (Chrome-specific) |
| Message passing | `browser.runtime.sendMessage` | `chrome.runtime.sendMessage` |
| Native messaging | SafariWebExtensionHandler | N/A (not needed) |
| Distribution | Sideload (unpacked) | Sideload (unpacked) or Chrome Web Store |

## Critical Implementation Notes

### Service Worker Reconnection

Chrome kills service workers after ~30 seconds of inactivity. The WS connection will drop. On wake, the service worker must:
1. Re-establish the WebSocket connection to `ws://localhost:9321`
2. Re-send the current `sessionId` so the proxy can re-associate the session
3. Request a fresh `tab_snapshot` if the page mirror was evicted

```javascript
// In background.js (Chrome service worker)
let socket = null;
let reconnectTimer = null;

function connect() {
  if (socket && socket.readyState === WebSocket.OPEN) return;

  socket = new WebSocket('ws://localhost:9321');

  socket.addEventListener('open', () => {
    // Re-announce session after service worker wake
    socket.send(JSON.stringify({
      type: 'session_announce',
      sessionId: SESSION_ID,
      tabId: currentTabId
    }));
    startHealthPoll();
  });

  socket.addEventListener('close', () => {
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 2000);
}

// chrome.alarms or chrome.webNavigation can keep worker alive
chrome.alarms.create('keepAlive', { delayInMinutes: 0.5, periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => { /* trigger reconnect if needed */ });
```

### Shared Proxy (no duplication)

The Chrome extension connects to the **same proxy_server/server.js** as the Safari extension. No changes to the proxy are needed.

### Shared Icons

Copy `extension_safari/Contents/Resources/images/*.png` to `extension_chrome/icons/` — no regeneration needed.

### Manifest V3 Permissions

```json
{
  "manifest_version": 3,
  "name": "Hermes Browser Bridge",
  "version": "1.0.0",
  "permissions": [
    "activeTab",
    "scripting"
  ],
  "host_permissions": [
    "http://localhost:9321/*",
    "https://localhost:9322/*"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_popup": "popup.html",
    "default_icon": {
      "16": "icons/icon-16.png",
      "48": "icons/icon-48.png",
      "96": "icons/icon-96.png",
      "128": "icons/icon-128.png"
    }
  },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }]
}
```

### Content Script Injection

Chrome Manifest V3 requires `"<all_urls>"` in `host_permissions` to inject content scripts into all sites. Alternatively, use `chrome.tabs.executeScript` dynamically with `activeTab` permission (less permission surface).

```javascript
// Dynamic injection (preferred for minimal permissions)
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content.js']
  });
  await chrome.tabs.sendMessage(tab.id, { type: 'activate' });
});
```

## Loading the Chrome Extension (Developer Mode)

1. Go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the `extension_chrome/` directory
5. The extension icon appears in the toolbar

## Testing Checklist

- [ ] Load extension in Chrome → popup shows "Inactive"
- [ ] Click "Activate Tab" → popup shows "Connected", green dot
- [ ] Browse to any site → DOM streamed to proxy
- [ ] GET /page_state returns correct HTML
- [ ] Close Chrome and reopen → WS reconnects automatically (service worker wakes)
- [ ] Multiple Chrome windows → each gets own sessionId
- [ ] Safari and Chrome both connected simultaneously → proxy handles both sessions independently

## TODO

- [ ] Implement `background.js` service worker (Manifest V3)
- [ ] Implement `content.js` (same as Safari, minor `browser→chrome` API changes)
- [ ] Implement `popup.html/css/js` (same design as Safari)
- [ ] Copy icons from Safari extension
- [ ] Test against Cloudflare-protected sites
- [ ] Test service worker lifecycle (30s idle → reconnect)
