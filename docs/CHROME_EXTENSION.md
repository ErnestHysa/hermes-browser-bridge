# Chrome Extension — Specification

**Status: ✅ Implemented (v1.3.0)**

This document describes the Chrome Web Extension variant of Hermes Browser Bridge.
It mirrors the Safari extension architecture using Chrome's Manifest V3 Web Extensions API.

## Architecture

```
Hermes Agent
    │
    │ HTTP localhost:9321 (same proxy as Safari)
    ▼
proxy_server/server.js ◄── WebSocket (ws://localhost:9321)
    │
    │ Chrome extension connects here
    ▼
Chrome Web Extension (Manifest V3)
    ├── background.js   ← Service worker: WS client, message routing
    ├── content.js      ← Injected into tab: DOM read, MutationObserver, cmd exec
    └── popup.html/js  ← Click-to-activate popup UI
```

**Key difference from Safari**: Chrome's Manifest V3 service worker lifecycle kills workers after ~30 seconds of inactivity. The WS connection drops and reconnects on wake. On wake, `session_announce` is re-sent so the proxy can re-associate the session.

## File Structure

```
extension_chrome/
├── manifest.json         ← Manifest V3, "service_worker": "background.js"
├── background.js         ← Service worker, WS client, message routing
├── content.js            ← Injected script: DOM reader + MutationObserver + cmd executor
├── popup.html
├── popup.css
├── popup.js
├── noop.html             ← Required by web_accessible_resources
├── _locales/
│   └── en/
│       └── messages.json
└── images/
    ├── icon-16.png       ← Copied from Safari extension
    ├── icon-48.png
    ├── icon-96.png
    └── icon-128.png
```

## Key Differences from Safari Extension

| Feature | Safari | Chrome |
|---|---|---|
| Background | SafariWebExtensionHandler (native binary + background page) | Chrome Service Worker (Manifest V3) |
| Popup persistence | Background page always alive | Service worker sleeps after 30s idle |
| WS connection | Background page keeps WS alive | Service worker reconnects on wake |
| Browser API | `browser.*` (Firefox-compatible) | `chrome.*` (Chrome-specific) |
| Message passing | `browser.runtime.sendMessage` | `chrome.runtime.sendMessage` |
| Tab navigation | `browser.tabs.update` | `chrome.tabs.update` |
| Native messaging | SafariWebExtensionHandler | N/A (not needed) |
| Distribution | Sideload (unpacked) | Sideload (unpacked) or Chrome Web Store |

## Loading the Chrome Extension (Developer Mode)

1. Go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the `extension_chrome/` directory
5. The extension icon appears in Chrome's toolbar

## Service Worker Lifecycle Handling

Chrome kills service workers after ~30 seconds of inactivity. The WS connection will drop and reconnect on the next event:

```javascript
// In background.js (Chrome service worker)
socket.addEventListener('close', () => {
  scheduleReconnect(); // reconnect with same sessionId
});

socket.addEventListener('open', () => {
  // Re-announce session after service worker wake
  socket.send(JSON.stringify({
    type: 'session_announce',
    sessionId: SESSION_ID,
    tabId: currentTabId
  }));
  startHealthPoll();
});
```

## Shared Proxy

The Chrome extension connects to the **same proxy_server/server.js** as the Safari extension. No changes to the proxy are needed. Both extensions can be connected simultaneously with independent sessions.

## Shared Icons

Icons are copied from `extension_safari/Contents/Resources/images/` to `extension_chrome/images/` during the build. To regenerate:

```bash
cp extension_safari/Contents/Resources/images/icon-*.png extension_chrome/images/
```

Or use `npm run build:icons` from the `proxy_server/` directory.

## Manifest V3 Permissions

```json
{
  "manifest_version": 3,
  "name": "Hermes Browser Bridge",
  "version": "1.3.0",
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
      "16": "images/icon-16.png",
      "48": "images/icon-48.png",
      "96": "images/icon-96.png",
      "128": "images/icon-128.png"
    }
  },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }],
  "web_accessible_resources": [{
    "resources": ["noop.html"],
    "matches": ["<all_urls>"]
  }]
}
```

## Testing Checklist

- [x] Load extension in Chrome → popup shows "Inactive"
- [x] Click "Activate Tab" → popup shows "Connected", green dot
- [x] Browse to any site → DOM streamed to proxy
- [x] GET /page_state returns correct HTML
- [x] Close Chrome and reopen → WS reconnects automatically (service worker wakes)
- [x] Service worker idle → reconnect logic fires correctly
- [x] Safari and Chrome both connected simultaneously → proxy handles both sessions independently
