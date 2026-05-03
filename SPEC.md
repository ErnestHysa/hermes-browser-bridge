# Hermes Browser Bridge — v1.2 Specification

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
│  │   - HTTP REST API (Hermes queries page state)           │  │
│  │   - WebSocket server (extension connects here)          │  │
│  │   - Page mirror cache (latest DOM + mutations)        │  │
│  │   - Command queue with ack/error tracking             │  │
│  │   - Rate limiter (5 commands/sec)                     │  │
│  │   - permessage-deflate compression                    │  │
│  │   - Shared base: proxy_lib.js                         │  │
│  └────────────┬───────────────────────────────────────────┘  │
│               │ WebSocket (localhost, no CORS)               │
│               ▼                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Safari Web Extension                                  │  │
│  │   - content.js: MutationObserver, DOM reader, cmd exec │  │
│  │   - background.js: WS client, message routing, health │  │
│  │   - popup.html: click-to-activate UI                 │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## File Structure

```
hermes-browser-bridge/
├── proxy_server/
│   ├── server.js           ← HTTP + WebSocket entry (thin wrapper)
│   ├── server_https.js    ← HTTPS + WSS variant (thin wrapper)
│   ├── proxy_lib.js       ← Shared proxy logic (all real code lives here)
│   ├── page_mirror.js    ← In-memory DOM cache + mutation ring buffer (per-session)
│   ├── cmd_queue.js       ← Command queue with timeout + ack/error tracking
│   └── package.json       ← ws@^8.20.0 (only external dependency)
├── extension_safari/
│   ├── Contents/
│   │   ├── Info.plist
│   │   ├── MacOS/
│   │   │   ├── SafariWebExtensionHandler    ← Compiled native binary
│   │   │   └── SafariWebExtensionHandler.swift
│   │   └── Resources/
│   │       ├── manifest.json   ← Manifest V3 (activeTab only, no host_permissions)
│   │       ├── background.js  ← WebSocket client + message routing + health poll
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

## Communication Protocol

### Extension → Proxy (WebSocket outbound)

```json
{ "type": "tab_snapshot", "url": "...", "title": "...", "html": "...", "seq": 1, "sessionId": "..." }
{ "type": "mutation",      "mutations": [...], "url": "...", "sessionId": "..." }
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
GET  /health           → { status, uptime, connected, pendingCommands, wsClients, rateLimit }
GET  /page_state       → { url, title, html, htmlStale, seq, connected, lastUpdate, mutations }
POST /command          → { type, selector?, url?, x?, y?, text?, script? }
                        ← { cmdId, status: "pending", message, rateLimitRemaining }
GET  /command/:cmdId   → { cmdId, status: "pending"|"done"|"error", result?, error? }
```

## Safari Extension Behavior

- Click extension icon → popup with connection status + "Activate Tab" button
- "Activate Tab" → extension starts reading the current tab
- MutationObserver watches `document.body` for DOM changes (childList + characterData)
- Every 2s or on major mutation → sends full `tab_snapshot`
- Commands arrive via WebSocket → execute via DOM APIs
- Background script maintains WebSocket to proxy, routes messages to/from content script
- Background polls `/health` every 10s to detect silent disconnects
- `disconnect` button properly terminates the active tab session
- Commands tracked per-command-id (Map) — parallel commands work correctly
- `sessionId` attached to every extension→proxy message for multi-session tracking

## Proxy Server Behavior

- Node.js with `ws` npm package for WebSocket
- Single HTTP server shared with WebSocket (no port conflict)
- `proxy_lib.js`: all shared logic; `server.js` and `server_https.js` are thin wrappers
- `page_mirror.js`: caches per-session url/title/html, TTL 5s for html, 30s for mutations, ring buffer max 100 mutations
- `cmd_queue.js`: stores pending commands with 30s timeout, resolves rather than rejects on timeout
- Rate limiter: 5 commands per second per client (token bucket)
- permessage-deflate compression enabled on WebSocket connections
- Periodic prune of completed commands every 2 minutes
- Graceful shutdown on SIGINT (Ctrl+C)

## Security Model

- All traffic on localhost — nothing leaves the machine
- Extension activates only when user clicks — no passive tracking
- CORS restricted to `http://localhost:*` (not `*`)
- v1.2: **no auth** on WebSocket/REST (local-only, trusted machine assumption)
- Production hardening (see CHANGELOG.md v1.3 planned):
  - Basic Auth header on WebSocket + REST
  - TLS on proxy (use `server_https.js` with certificates/)
  - Command idempotency key

## Testing

| Test | Expected |
|---|---|
| Load extension in Safari | Popup shows "Inactive" |
| Click "Activate Tab" | Popup shows "Connected", green badge |
| Browse to https://example.com | DOM streamed to proxy within 2s |
| GET /page_state | Full HTML of current tab |
| POST 6 commands simultaneously | All 6 complete with correct cmdIds |
| POST 10 commands in 1 second | Last 5 get 429 Rate Limit Exceeded |
| GET /page_state after 5s idle | `htmlStale: true` |
| GET /command/nonexistent | 404 not found |
| Close extension popup | Connection stays alive (background script) |
| Click Disconnect | Session cleared, popup resets to Inactive |
