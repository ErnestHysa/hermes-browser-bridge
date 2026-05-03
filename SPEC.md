# Hermes Browser Bridge — v1.1 Specification

## Overview

A two-part local stack: a Safari Web Extension that reads and controls your open tab, and a Node.js proxy server that bridges it to Hermes Agent. All traffic stays on localhost — your browser session, cookies, and TLS fingerprint are fully respected by Cloudflare and other anti-bot systems.

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
│  │  Safari Web Extension                                  │  │
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
│   ├── server.js       ← Main entry: shared HTTP + WebSocket server
│   ├── page_mirror.js  ← In-memory DOM cache + mutation ring buffer
│   ├── cmd_queue.js    ← Command queue with timeout + ack/error tracking
│   └── package.json    ← ws@^8.20.0 (only external dependency)
├── extension_safari/
│   ├── Contents/
│   │   ├── Info.plist
│   │   ├── MacOS/
│   │   │   ├── SafariWebExtensionHandler    ← Compiled native binary
│   │   │   └── SafariWebExtensionHandler.swift
│   │   └── Resources/
│   │       ├── manifest.json   ← Manifest V3
│   │       ├── background.js  ← WebSocket client + message routing
│   │       ├── content.js     ← MutationObserver, DOM reader, cmd executor
│   │       ├── popup.html/js/css  ← Click-to-activate popup UI
│   │       ├── _locales/en/messages.json
│   │       └── images/        ← Extension icons (16,48,96,128 PNG)
├── certificates/
│   ├── ca.crt          ← Self-signed CA cert (for future HTTPS)
│   └── README.md       ← macOS Keychain install instructions
├── launchd/
│   └── com.hermes-agent.browser-bridge.plist  ← Auto-restart plist
├── SPEC.md
├── SETUP.md
└── CHANGELOG.md
```

## Dependencies

| Package | Version | Purpose |
|---|---|---|
| `ws` (npm) | ^8.20.0 | WebSocket server — the only external dependency |

> **Note:** `ws` is an npm package, NOT a Node.js built-in. Run `npm install` in `proxy_server/` before first use.

## Communication Protocol

### Extension → Proxy (WebSocket outbound)

```json
{ "type": "tab_snapshot", "url": "...", "title": "...", "html": "...", "seq": 1 }
{ "type": "mutation",      "mutations": [...], "url": "..." }
{ "type": "heartbeat",     "tabId": 1 }
{ "type": "cmd_ack",       "cmdId": "uuid", "success": true, "result": "..." }
{ "type": "cmd_error",     "cmdId": "uuid", "success": false, "error": "..." }
```

### Proxy → Extension (WebSocket inbound)

```json
{ "type": "navigate", "url": "https://...", "cmdId": "uuid" }
{ "type": "click",    "selector": "#login-btn", "cmdId": "uuid" }
{ "type": "scroll",   "x": 0, "y": 300, "cmdId": "uuid" }
{ "type": "type",     "selector": "input[name=q]", "text": "...", "cmdId": "uuid" }
{ "type": "evaluate", "script": "return document.title", "cmdId": "uuid" }
```

### Hermes → Proxy (REST)

```
GET  /health           → { status, uptime, connected, pendingCommands, wsClients }
GET  /page_state       → { url, title, html, htmlStale, seq, connected, lastUpdate, mutations }
POST /command          → { type, selector?, url?, x?, y?, text?, script? }
                        ← { cmdId, status: "pending", message }
GET  /command/:cmdId   → { cmdId, status: "pending"|"done"|"error", result?, error? }
```

## Safari Extension Behavior

- Click extension icon → popup with connection status + "Activate Tab" button
- "Activate Tab" → extension starts reading the current tab
- MutationObserver watches `document.body` (with null guard) for DOM changes
- Every 2s or on major mutation → sends full `tab_snapshot`
- Commands arrive via WebSocket → execute via DOM APIs
- Background script maintains WebSocket to proxy, routes messages to/from content script
- `disconnect` button properly terminates the active tab session
- Commands tracked per-command-id (Map) — parallel commands work correctly

## Proxy Server Behavior

- Node.js with `ws` npm package for WebSocket
- Single HTTP server shared with WebSocket (no port conflict)
- `page_mirror.js`: caches latest url/title/html, TTL 5s for html, 30s for mutations, ring buffer max 100 mutations
- `cmd_queue.js`: stores pending commands with 30s timeout, resolves rather than rejects on timeout (no unhandledRejection)
- Periodic prune of completed commands every 2 minutes
- Graceful shutdown on SIGINT (Ctrl+C)

## Security Model

- All traffic on localhost — nothing leaves the machine
- Extension activates only when user clicks — no passive tracking
- v1.1: **no auth** on WebSocket/REST (local-only, trusted machine assumption)
- Production hardening (see CHANGELOG.md v1.2 planned):
  - Basic Auth header on WebSocket + REST
  - Rate limiting (max N commands per second)
  - Command idempotency key

## Testing

| Test | Expected |
|---|---|
| Load extension in Safari | Popup shows "Inactive" |
| Click "Activate Tab" | Popup shows "Connected", green badge |
| Browse to https://example.com | DOM streamed to proxy within 2s |
| GET /page_state | Full HTML of current tab |
| POST /command scroll | Tab scrolls 300px down |
| POST /command click | Extension clicks element |
| POST 3 commands simultaneously | All 3 complete with correct cmdIds |
| Close extension popup | Connection stays alive (background script) |
| Click Disconnect | Session cleared, popup resets to Inactive |
