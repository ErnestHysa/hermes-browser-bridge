# Hermes Browser Bridge — Architecture Specification v1.3.1

> Hermes Browser Bridge gives the Hermes Agent full read and control of a live browser tab
> running in the user's own browser session. Since the extension runs inside the user's
> authenticated browser, it naturally bypasses Cloudflare, CORS restrictions, and
> login walls without any credential sharing.

---

## 1. Overview

```
User's Browser Tab (any site — Google, banking, intranet, etc.)
    │
    │ content.js (injected content script)
    │   • Reads rendered DOM + page state
    │   • MutationObserver → streams incremental page state
    │   • Executes: click, scroll, type, navigate, evaluate, submit
    │
    ▼
background.js (extension service worker / background page)
    │   • Maintains WebSocket to proxy (ws://localhost:9321)
    │   • Routes commands to content script
    │   • Routes page state to proxy
    │
    │  WebSocket (ws://localhost:9321)
    ▼
proxy_server/ (Node.js)
    │  • HTTP REST API (page_state, commands, sessions)
    │  • WebSocket endpoint for Hermes Agent (ws://localhost:9321/hermes)
    │  • PageMirror: caches page state per session
    │  • CmdQueue: async command execution with ack/error
    │
    │  HTTP/WS  localhost:9321
    ▼
Hermes Agent
    • Reads page state via GET /page_state
    • Sends commands via POST /command
    • Receives push via WebSocket connect to ws://localhost:9321/hermes
```

### What This Solves

| Blocker | How Bridge Solves It |
|---|---|
| Cloudflare | Traffic originates from YOUR browser IP/session — Cloudflare sees a real user |
| CORS | Extension reads page locally, sends to proxy on localhost — no cross-origin HTTP |
| Login walls | Extension runs inside your authenticated session — it sees what you see |
| Intranet sites | Same — extension reads whatever page is open, no network access needed |
| CSP restrictions | Content script runs at document_start before CSP; some sites still block — known limitation |

### Limitations

- **CSP-blocklisted sites**: Some sites (Google, banking, crypto exchanges) set Content Security Policy that blocks even content script injection. The extension reads the rendered page but interaction (click/type) may be silently blocked. The page state is still readable.
- **cross-origin iframes**: Content script runs at the top-frame level; sub-frame content may not be fully accessible.
- **Browser storage access**: content.js cannot read `sessionStorage`/`localStorage` cross-origin by design, but has access to cookies for the top-level domain.

---

## 2. Architecture Components

### 2.1 Content Script (`content.js`)

Injected into every page at `document_start`. Responsibilities:

**Page State Capture**
- On init: captures full HTML snapshot synchronously (`document.documentElement.outerHTML`) before MutationObserver attaches — avoids missing early DOM mutations
- Subsequent snapshots: structural snapshots (element counts, changed text, form/link counts) every 3 seconds
- Full snapshot on major DOM changes (5+ childList mutations)
- `characterData` mutations (text changes) are accumulated and included in the next structural snapshot

**MutationObserver**
- Observes `document.body` with `childList: true, subtree: true, characterData: true`
- Accumulates `characterData` mutations in a buffer; flushes buffer in the next structural snapshot (up to 10 changed text snippets)
- Major mutations (5+ added nodes or any removals) trigger an immediate full HTML snapshot after a 300ms debounce
- First snapshot is captured *before* the observer starts (race condition fix)

**Command Execution**
- Receives commands from background page via `window.addEventListener('message')`
- Supported commands: `navigate`, `click`, `scroll`, `type`, `submit`, `evaluate`, `refresh`
- Each command gets a unique `cmdId` (UUID); result is sent back via `cmd_ack` or `cmd_error`
- `navigate` uses `_navigate` (background page calls `chrome.tabs.update` to navigate the tab itself)
- `evaluate` uses `new Function(cmd.script)` — sandboxed to current page context

**Communication**
- To background: `window.postMessage({ type, ...payload }, '*')`
- Heartbeat: every 15s when tab is active

### 2.2 Background Service (`background.js` / SafariWebExtensionHandler)

**WebSocket to Proxy**
- Connects to `ws://localhost:9321` on extension load
- Sends `hello` handshake on connect (includes sessionId, extension version)
- After `hello` the proxy assigns/associates the session
- On reconnect: re-sends `hello` with same `sessionId` so proxy can re-associate

**Message Routing**
- Extension (content) → proxy: `tab_snapshot`, `mutation`, `cmd_ack`, `cmd_error`, `content_error`, `heartbeat`
- proxy (via WS) → extension: `navigate`, `click`, `scroll`, `type`, `submit`, `evaluate`, `refresh`, `cancel`, `backpressure`

**Tab Management**
- Tracks `currentTabId` via `tabs.onActivated` and `tabs.onUpdated`
- `_navigate` command: calls `chrome.tabs.update(tabId, { url })` to navigate the tab directly

**Popup Communication**
- Popup ↔ background: `chrome.runtime.sendMessage`
- Background pushes events: `connected`, `disconnected`, `tab_activated`, `cmd_sent`, `cmd_done`, `cmd_error`

**Hermes Agent WebSocket Push (v1.3)**
- The Hermes Agent itself connects directly to `ws://localhost:9321/hermes` — **not** the extension background
- Hermes Agent sends `{ type: 'subscribe', sessionId }` to subscribe to a session's push stream
- Proxy pushes `{ type: 'command', cmdId, type, selector, ... }` to Hermes for that session
- Extension executes the command and replies via the extension WS; proxy forwards `cmd_ack`/`cmd_error` to Hermes

**Note on run_at**: Extensions use `run_at: 'document_start'` so the content script injects before the page renders, capturing the initial DOM before any JS runs.

### 2.3 Proxy Server (`proxy_server/`)

**Files**
- `server.js` — main entry: HTTP server on port 9321 (default); HTTPS on port 9321 with `--https` flag (uses certificates from `../certificates/`)
- `proxy_lib.js` — shared logic (all HTTP handlers, WebSocket handling, state)
- `page_mirror.js` — DOM cache + mutation ring buffer
- `cmd_queue.js` — command queue with ack/error tracking and cancel support
- `config.js` — runtime configuration (port, rate limits, sizes, timeouts)

**HTTP Endpoints**

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Server health + connection count |
| GET | `/page_state?sessionId=X` | Current page state for session (HTML or structural) |
| POST | `/command` | Submit a command for a session |
| GET | `/command/:cmdId` | Poll command result |
| DELETE | `/command/:cmdId` | Cancel a pending command |
| GET | `/sessions` | List all active sessions + URLs |
| POST | `/sessions/:id/activate` | Set which session Hermes is actively watching |
| GET | `/last_seq?sessionId=X` | Get last received seq number for session |
| GET | `/metrics` | Prometheus-compatible metrics (text/plain) |

**WebSocket Endpoint `/hermes`**

For Hermes Agent's real-time push connection:

```
1. Client connects to ws://localhost:9321/hermes
2. Client sends: { type: 'subscribe', sessionId: 'abc123' }
3. Proxy sends: { type: 'subscribed', sessionId: 'abc123' }
4. Proxy pushes: { type: 'command', cmdId: '...', type: 'click', selector: '#btn' }
5. Client (Hermes) sends: { type: 'ack', cmdId: '...' } (optional)
6. Proxy receives ack/error from extension, forwards to Hermes WS
```

The proxy routes commands to the correct session based on the `sessionId` in `subscribe`.
If Hermes sends a `command` without announcing first, it is routed to the most recently active session.

**HTTP Endpoint `/command`**

```
POST /command
Body: { type, sessionId, cmdId, selector?, text?, url?, script?, x?, y? }

Response 202: { accepted: true, cmdId }
Response 400: { error: 'invalid type' }
Response 429: { error: 'rate limited' }
Response 504: { error: 'command timed out' } (after 30s)
```

**Backpressure Flow Control**

When the extension sends `mutation` events faster than Hermes consumes them (Hermes disconnects or is slow), the proxy tracks the pending mutation queue depth per session. When the queue exceeds `BACKPRESSURE_THRESHOLD` (50 mutations), the proxy sends `{ type: 'backpressure', paused: true }` to the extension's background WS. The extension stops sending `mutation` events (but continues sending `tab_snapshot` at the periodic interval). When the queue drains below the threshold, `{ type: 'backpressure', paused: false }` is sent and `mutation` flow resumes.

### 2.4 PageMirror (`page_mirror.js`)

Stores page state per `sessionId`. In-memory only (no persistence).

**State per session**
- `url`: last known URL
- `title`: last known title
- `html`: full HTML snapshot (null if only structural data)
- `structural`: `{ total, forms, inputs, buttons, links, images }` counts
- `changedTexts`: last N changed text snippets (max 10)
- `bodySample`: first 200 chars of body text
- `seq`: monotonically increasing sequence number
- `updatedAt`: timestamp

**Mutation Ring Buffer**
- Per-session circular buffer of recent mutation events
- Max 100 entries; oldest are evicted
- Used for debugging and replay

**Deduplication**
- If two consecutive `tab_snapshot` events have identical `html` and `seq`, the second is silently dropped (idempotency)

### 2.5 CommandQueue (`cmd_queue.js`)

Tracks pending commands awaiting `cmd_ack` or `cmd_error` from the extension.

- Commands time out after `CMD_TIMEOUT_MS` (default: 30000ms, configurable in `config.js`)
- `cancel(cmdId)` removes the command without resolving it
- Uses a UUID → pending command map for O(1) insert/lookup/delete

---

## 3. Configuration (`config.js`)

```javascript
PORT: 9321,                    // HTTP/WebSocket port
RATE_LIMIT_RPS: 20,           // Max commands per second per session
CMD_TIMEOUT_MS: 30000,        // Command timeout (ms)
MAX_HTML_BYTES: 10 * 1024 * 1024,  // Max HTML snapshot size (10MB)
MAX_STRUCTURAL_CHANGES: 500,  // Max mutations per batch
FULL_SNAPSHOT_INTERVAL_MS: 2000,   // ms between full HTML snapshots (shared-content.js)
MAJOR_MUTATION_DEBOUNCE_MS: 300,   // ms to wait before full snapshot after major mutation
HEARTBEAT_INTERVAL_MS: 15000,  // content.js → background.js heartbeat interval (shared-content.js)
BACKPRESSURE_THRESHOLD_MS: 500, // ms of estimated send time above which backpressure triggers
MAX_PENDING_MESSAGES: 50,    // Extension → proxy pending queue depth (extension background.js)
MAX_IDEMPOTENCY_CACHE: 1000,   // Max entries in the idempotency cache
IDEMPOTENCY_TTL_MS: 60000,    // How long idempotency keys live (ms)
SESSION_MAX_AGE_MS: 3600000,  // Evict sessions inactive for 1 hour
MAX_SESSIONS: 100,             // Max concurrent sessions before LRU eviction
MUTATION_BUFFER_MAX: 100,      // Max mutations per session ring buffer (page_mirror.js)
```

---

## 4. Security Model

**Localhost only**: All HTTP and WebSocket endpoints are bound to `localhost`. No remote access by default.

**Extension has full page access**: The content script has access to all DOM content, cookies (for the top-level domain), and can execute arbitrary JavaScript in the page context. This is inherent to how browser extensions work.

**No credential sharing**: Hermes Agent never sees your passwords or session tokens. It only receives the rendered DOM (text content of elements) and can issue click/type commands that go through the extension.

**Production hardening** (when ready for multi-user/multi-machine deployment):
- Add token-based auth: extensions receive a time-limited token; proxy validates it on every request
- Use HTTPS (`--https` flag on server.js + CA cert) for non-localhost proxy access
- Add per-session ACLs (restrict which sites a given token can access)
- Add request signing (HMAC) to prevent tampering in transit

---

## 5. Browser Compatibility

| Browser | Extension Type | Status |
|---|---|---|
| Safari 16+ (macOS) | Safari Web Extension | ✅ Implemented |
| Chrome 120+ (macOS/Windows/Linux) | Manifest V3 Web Extension | ✅ Implemented |
| Firefox 120+ | Web Extension (MV3) | Not currently supported — Firefox MV3 extensions require a different architecture and distribution model |

---

## 6. Future Work

- **Screenshot capture**: `GET /screenshot?sessionId=X` — returns a base64 PNG of the current viewport
- **File upload**: `POST /upload` — extension sends file input state, Hermes can provide file bytes
- **Multi-tab subscription**: Allow Hermes to subscribe to *multiple* sessions simultaneously and receive updates from all
- **DevTools Protocol (CDP)**: Use Chrome's CDP for deeper introspection without content script injection
- **Encrypted transport**: End-to-end encryption between extension and proxy (ChaCha20-Poly1305)
- **Session recording**: Persist page state stream to disk for replay/archival
- **WebDriver Protocol**: Bidirectional bridge to W3C WebDriver for cross-browser automation parity

---

## 7. Version History

|| Version | Date | Changes ||
|---|---|---|
|| 1.3.1 | 2026-05-03 | R26 audit fixes: RunAtLoad, backpressure threshold 500ms, mutation buffer 500, rate limit 20 rps, nodemon dev script, navigate handler (Safari), clearNavigateHandlers guard, Chrome popup pendingCmdId fix, Chrome storage persistence, cmd delivery error forwarding, x,y coordinate click, manifest page exclusions, Prometheus format (# TYPE/# HELP), conditional HTML snapshots, popup PAUSED indicator, SPEC.md/config.js sync ||
|| 1.3.0 | 2026-05-03 | R25 audit fixes: Hermes WS push redesign, backpressure, session management, command cancellation, Safari + Chrome extension parity, Prometheus metrics, requestIdleCallback, $HOME launchd path, popup listener cleanup, HTTPS shutdown fix, chunked WS ||
|| 1.2.0 | 2026-04 | Hermes WebSocket push endpoint added ||
|| 1.1.0 | 2026-04 | HTTPS variant, command queue, idempotency cache ||
|| 1.0.0 | 2026-03 | Initial release: Safari extension + HTTP proxy ||
