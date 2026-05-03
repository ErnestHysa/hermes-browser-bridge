# Hermes Browser Bridge — v1 Specification

## Overview

A two-part local stack: a Safari Web Extension that reads and controls your open tab, and a Node.js proxy server that bridges it to Hermes Agent. All traffic stays on localhost.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Hermes Agent                                                │
│       │                                                        │
│       │ HTTP GET/POST localhost:9321                        │
│       ▼                                                        │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  proxy_server/server.js  (Node.js, port 9321)          │  │
│  │   - HTTP REST API (Hermes queries page state)          │  │
│  │   - WebSocket server (extension connects here)         │  │
│  │   - Page mirror cache (latest DOM + mutations)         │  │
│  │   - Command queue with ack/error tracking             │  │
│  └────────────┬───────────────────────────────────────────┘  │
│               │ WebSocket (localhost, no CORS)               │
│               ▼                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Safari Web Extension (.safari-extension)              │  │
│  │   - content.js: MutationObserver, DOM reader, cmd exec │  │
│  │   - background.js: WebSocket client, message routing  │  │
│  │   - popup.html: click-to-activate UI                   │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## File Structure

```
hermes-browser-bridge/
├── proxy_server/
│   ├── server.js       ← Main entry: HTTP + WebSocket server
│   ├── page_mirror.js  ← In-memory DOM cache + mutation buffer
│   ├── cmd_queue.js    ← Command queue with ack/error tracking
│   └── package.json    ← No external deps (Node.js built-ins only)
├── extension_safari/
│   ├── manifest.json   ← Manifest V3
│   ├── _locales/en/messages.json
│   ├── background.js   ← WebSocket client + message routing
│   ├── content.js      ← MutationObserver, DOM reader, cmd executor
│   ├── popup.html      ← Activate/connect popup UI
│   ├── popup.js        ← Popup logic
│   ├── popup.css       ← Popup styling
│   └── images/         ← Extension icons (16,48,96,128 PNG)
├── certificates/
│   ├── ca.crt          ← Self-signed CA cert
│   └── README.md       ← macOS Keychain install instructions
└── SPEC.md             ← This file
```

## Communication Protocol

### Extension → Proxy (WebSocket outbound)

```json
{ "type": "tab_snapshot", "url": "...", "title": "...", "html": "..." }
{ "type": "mutation",      "mutations": [...] }
{ "type": "heartbeat",      "tabId": 1 }
{ "type": "cmd_ack",        "cmdId": "uuid", "success": true, "result": "..." }
{ "type": "cmd_error",      "cmdId": "uuid", "error": "..." }
```

### Proxy → Extension (WebSocket inbound)

```json
{ "type": "navigate", "url": "https://...", "cmdId": "uuid" }
{ "type": "click",     "selector": "#login-btn", "cmdId": "uuid" }
{ "type": "scroll",    "x": 0, "y": 300, "cmdId": "uuid" }
{ "type": "type",      "selector": "input[name=q]", "text": "...", "cmdId": "uuid" }
{ "type": "evaluate",  "script": "return document.title", "cmdId": "uuid" }
```

### Hermes → Proxy (REST)

```
GET  /health           → { status: "ok", uptime: N }
GET  /page_state       → { url, title, html, lastUpdate, mutations }
POST /command          → { type, selector?, url?, x?, y?, text?, script?, cmdId }
GET  /command/:cmdId   → { status: "pending"|"done"|"error", result?, error? }
```

## Safari Extension Behavior

- Click extension icon → popup with connection status + "Activate Tab" button
- "Activate Tab" → extension starts reading the current tab
- MutationObserver watches document.body for DOM changes
- Every 2s or on major mutation → sends full tab_snapshot
- Receives commands via WebSocket → executes via DOM APIs
- Background script maintains WebSocket to proxy, routes messages to/from content script

## Proxy Server Behavior

- Pure Node.js, no npm packages (uses built-in modules: http, ws, events, crypto)
- WebSocket on ws://localhost:9321 (extension connects here)
- REST API on http://localhost:9321 (Hermes connects here)
- page_mirror.js: caches latest url/title/html, TTL 5s for html, 30s for mutations
- cmd_queue.js: stores pending commands with 30s timeout

## Security Model

- All traffic on localhost — nothing leaves the machine
- Extension activates only when user clicks — no passive tracking
- v1: no auth on WebSocket/REST (local-only, trusted machine assumption)
- Production recommendation: Basic Auth header on WebSocket + REST

## Testing

| Test | Expected |
|---|---|
| Load extension in Safari | Popup shows "Inactive" |
| Click "Activate Tab" | Popup shows "Connected", green badge |
| Browse to sonniss.com | DOM streamed to proxy within 2s |
| GET /page_state | Full HTML of current tab |
| POST /command scroll | Tab scrolls 300px down |
| POST /command click | Extension clicks element |
| Close extension popup | Connection stays alive (background script) |
