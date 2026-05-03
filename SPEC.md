# Hermes Browser Bridge — v1.3 Specification

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
│  │   - Page mirror cache (per-session DOM + mutations)     │  │
│  │   - Command queue with ack/error tracking               │  │
│  │   - Per-client rate limiter (5 commands/sec/session)    │  │
│  │   - permessage-deflate compression                     │  │
│  │   - Shared base: proxy_lib.js                          │  │
│  └────────────┬───────────────────────────────────────────┘  │
│               │ WebSocket (localhost, no CORS)               │
│               ▼                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Safari Web Extension                                  │  │
│  │   - content.js: MutationObserver, DOM reader, cmd exec │  │
│  │   - background.js: WS client, message routing, health │  │
│  │   - popup.html: click-to-activate + refresh + log     │  │
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
│   ├── page_mirror.js     ← Per-session DOM cache + mutation ring buffer
│   ├── cmd_queue.js       ← Command queue with timeout + ack/error tracking
│   └── package.json       ← ws@^8.20.0 (only external dependency)
├── extension_safari/
│   ├── Contents/
│   │   ├── Info.plist
│   │   ├── MacOS/
│   │   │   ├── SafariWebExtensionHandler    ← Compiled native binary
│   │   │   └── SafariWebExtensionHandler.swift
│   │   └── Resources/
│   │       ├── manifest.json   ← Manifest V3 (activeTab only)
│   │       ├── background.js  ← WebSocket client + message routing + health poll
│   │       ├── content.js    ← MutationObserver, DOM reader, cmd executor
│   │       ├── popup.html/js/css  ← Click-to-activate + refresh + cmd log
│   │       ├── _locales/en/messages.json
│   │       └── images/        ← Extension icons (16,48,96,128 PNG)
├── certificates/
│   ├── ca.crt              ← Self-signed CA cert (for HTTPS variant)
│   └── README.md           ← macOS Keychain install instructions
├── launchd/
│   └── com.hermes-agent.browser-bridge.plist  ← Auto-restart plist
├── tests/
│   └── smoke_test.sh       ← Basic curl-based smoke tests
├── docs/
│   ├── CHROME_EXTENSION.md ← Chrome extension specification
│   └── AUTH.md             ← Production auth design
├── SPEC.md
├── SETUP.md
└── CHANGELOG.md
```

## Dependencies

| Package | Version | Purpose |
|---|---|---|
| `ws` (npm) | `^8.20.0` | WebSocket server — the only external dependency |

## Communication Protocol

### Extension → Proxy (WebSocket outbound)

```json
{ "type": "tab_snapshot", "url": "...", "title": "...", "html": "...", "seq": 1, "sessionId": "...", "incremental": false }
{ "type": "mutation",      "mutations": [...], "url": "...", "sessionId": "...", "seq": 1 }
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
{ "type": "refresh",  "cmdId": "uuid" }
```

### Hermes → Proxy (REST)

```
GET  /health              → { status, uptime, connected, pendingCommands, wsClients, activeSessions }
GET  /page_state          → { url, title, html, htmlStale, seq, connected, lastUpdate, mutations }
GET  /page_state?sessionId=X&lastSeq=N  → delta mutations since lastSeq for that session
POST /command             → { type, selector?, url?, x?, y?, text?, script?, sessionId? }
                          ← { cmdId, status: "pending", message, rateLimitRemaining, sessionId }
GET  /command/:cmdId      → { cmdId, status: "pending"|"done"|"error", result?, error? }
```

## Safari Extension Behavior

- Click extension icon → popup with connection status + "Activate Tab" button
- "Activate Tab" → extension starts reading the current tab
- MutationObserver watches `document.body` for DOM changes:
  - **Incremental mode** (on minor mutations): sends lightweight structural snapshot — element counts, body text sample, URL, title. No outerHTML sent.
  - **Full mode** (first load, every 2s interval, navigation, explicit `refresh`, or major DOM changes): sends complete `outerHTML`
- `refresh` command forces an immediate full snapshot
- Navigate handlers properly removed before adding new ones (no listener leak)
- Commands arrive via WebSocket → execute via DOM APIs
- Background script maintains WebSocket to proxy, routes messages to/from content script
- Background polls `/health` every 10s to detect silent disconnects
- `disconnect` button properly terminates the active tab session
- Commands tracked per-command-id (Map) — parallel commands work correctly
- `sessionId` attached to every extension→proxy message for multi-session tracking
- Popup retains last known URL on reconnect; shows command log; supports manual refresh

## Proxy Server Behavior

- Node.js with `ws` npm package for WebSocket
- Single HTTP server shared with WebSocket (no port conflict)
- `proxy_lib.js`: all shared logic; `server.js` and `server_https.js` are thin wrappers
- `page_mirror.js`: caches per-session url/title/html, TTL 5s for html, 30s for mutations, ring buffer max 100 mutations
- **Per-session connected state** — `connected` is derived per-session, not global
- **Per-session mutation scoping** — `getState(sessionId, lastSeq)` returns only that session's mutations delta
- **Session eviction** — disconnected sessions cleaned up after 5 minutes of inactivity
- **Per-session rate limiting** — each `sessionId` gets its own 5 commands/sec token bucket
- **Per-session command routing** — commands with `?sessionId=X` are sent only to that session's WebSocket
- **Origin validation** — WebSocket connections from non-localhost origins are rejected (HTTP 1008)
- `cmd_queue.js`: stores pending commands with 30s timeout, resolves rather than rejects on timeout
- permessage-deflate compression enabled on WebSocket connections
- Periodic prune of completed commands every 2 minutes
- Graceful shutdown on SIGINT (Ctrl+C)

## Security Model

- All traffic on localhost — nothing leaves the machine
- Extension activates only when user clicks — no passive tracking
- CORS restricted to `http://localhost:*`
- WebSocket origin validated — unauthorized origins rejected
- v1.3: **no auth** on WebSocket/REST (local-only, trusted machine assumption)
- v2.0 planned (see `docs/AUTH.md`):
  - Token-based auth: Hermes sends `Authorization: Bearer <token>` header
  - Proxy validates token on every HTTP request and WebSocket handshake
  - Token stored in macOS Keychain, loaded at startup
  - Command idempotency keys prevent double-execution on retry

## Testing

| Test | Expected |
|---|---|
| Load extension in Safari | Popup shows "Inactive" |
| Click "Activate Tab" | Popup shows "Connected", green dot |
| Browse to https://example.com | DOM streamed to proxy within 2s |
| GET /page_state | Full HTML of current tab |
| GET /page_state?sessionId=X&lastSeq=5 | Only mutations with seq > 5 |
| POST 6 commands simultaneously | All 6 complete with correct cmdIds |
| POST 10 commands in 1 second (same session) | Last 5 get 429 Rate Limit Exceeded |
| POST 1 command per second for 10 seconds | All 10 succeed (bucket refills) |
| GET /page_state after 5s idle | `htmlStale: true` |
| GET /command/nonexistent | 404 not found |
| Close extension popup | Connection stays alive (background script) |
| Click Disconnect | Session cleared, popup resets to Inactive |
| Click Refresh Snapshot | Full snapshot resent immediately |
| Extension reconnect after brief disconnect | URL retained in popup |

## Future Work

- Chrome extension (see `docs/CHROME_EXTENSION.md`)
- Production auth with macOS Keychain token (see `docs/AUTH.md`)
- End-to-end encryption with user-held key
- Headless mode (no popup, auto-attach on browser launch)
- Multiple tab support (switch active tab from Hermes)
- Video frame capture for visual page understanding
