# Changelog

All notable changes to Hermes Browser Bridge are documented here.

## [1.3.2] — 2026-05-05

### Added
- **README.md**: Project overview, architecture diagram, quick-start instructions at repo root.
- **ESLint configuration**: Added `.eslintrc.json` and `lint` npm script for consistent code quality.
- **build_safari_bundle.sh**: Script to generate Safari `.safariextension` bundle for sideloading.

### Changed
- **Version unified**: All manifest.json, package.json, and Info.plist now consistently at 1.3.2.
- **proxy_lib.js refactored**: Monolithic 2026-line file split into `lib/` modules: `server.js` (entry), `routes/`, `handlers/`, and `middleware/`.
- **CHANGELOG.md updated**: 1.3.1 and 1.3.2 entries documented.

### Fixed
- **#P0: CA private key removed from repo**: `certificates/ca.key` and `ca.crt` added to `.gitignore`. Key regenerated with AES encryption. Rotated.
- **#P1: Chrome popup uses wrong API**: Fixed `browser.runtime.sendMessage` → `chrome.runtime.sendMessage` in Chrome popup cancel handler.
- **#P1: No test coverage for core modules**: Added unit tests for `cmd_queue.js`, `page_mirror.js`, `config.js` and integration tests for extension→proxy flow.
- **#P2: evaluate() has no sandbox guards**: Added runtime warnings when evaluate accesses sensitive APIs (cookies, storage, network).
- **#P2: Shared HermesShared singleton across iframes**: Added per-frame instance isolation via frame ID tracking.
- **#P2: commandHistory memory leak with stale connections**: Added TTL-based eviction for sessions with stale Hermes WebSocket connections.
- **#P2: Unbounded launchd log files**: Added `newsyslog`-style log rotation configuration.
- **#P3: getStructuralSnapshot runs O(n) DOM query before idle guard**: Moved `querySelectorAll('*')` inside the idle callback.
- **#P3: Dashboard silently swallows health check errors**: Added visible error banner when `/health` fetch fails.
- **#P3: Popup saveCmdLog silently fails**: Added user-visible toast notification on persistent storage errors.
- **#P3: Fixed mutation buffer overflow notification**: Hermes Agent now receives `buffer_overflow` warning when mutations exceed capacity.
- **#P3: Adaptive mutation flush**: Buffer now flushes immediately when exceeding 75% capacity instead of waiting for the fixed 500ms interval.
- **#P3: CHROME_EXTENSION.md stale docs**: Fixed `document_idle` → `document_start` in content script run_at documentation.
- **#P3: Safari navigate handler missing tab dedup**: Added tab change listener guard to prevent phantom navigations during rapid tab switches.
- **#P3: Shared content bootstrap extracted**: Common initialization logic moved into `initHermesBridge()` in shared-content.js.

### Security
- **CA key rotation**: `certificates/ca.key` regenerated with AES encryption, removed from git tracking.
- **evaluate() sandbox instrumentation**: Runtime monitoring of sensitive API access in evaluated scripts.

## [1.3.1] — 2026-05-04

### Fixed
- Safari extension manifest.json at correct location in bundle root for sideloading.
- CFBundlePackageType set to BNDL for Safari extension wrapper.

## [1.3.0] — 2026-05-03

### Fixed (22 issues from R25 audit)

#### P0 — Critical
- **Hermes WS push endpoint broken by design**: Redesigned `/hermes` WebSocket endpoint with proper session subscription model. Extension sends `session_announce` to subscribe; proxy routes commands to correct session. Dead `wssHermes` endpoint removed.

#### P1 — High Priority
- **`getState()` silent session mismatch**: Returns `{ sessionMismatch: true, requestedSessionId, actualSessionId }` when requested session doesn't exist — Hermes now detects mismatches instead of silently operating on wrong page state.
- **Tab targeting API**: New `GET /sessions` lists all active sessions with URLs and last-seen timestamps. New `POST /sessions/:id/activate` sets which session Hermes is actively watching. Hermes WS pushes to the activated session.
- **MutationObserver race condition**: `captureInitialSnapshot()` now captures full HTML synchronously BEFORE `setupMutationObserver()` attaches. Early DOM mutations (logo load, auth state) are no longer missed.
- **launchd plist hardcoded path**: Replaced `/Users/ernest/...` with `$HOME/Desktop/...` — plist now works across users and survives directory relocation.
- **popup.js event listener leak**: All `addEventListener` calls now use named function references stored in module variables. Popup `visibilitychange` handler removes all listeners on hide.

#### P2 — Medium Priority
- **Chrome extension (Manifest V3)**: Full working implementation at `extension_chrome/`. Service worker with WebSocket client, content script, popup UI. Uses same icon set as Safari (copied on build). Parity with Safari extension feature set.
- **Backpressure flow control**: New `backpressure` WebSocket message. When mutation queue exceeds 50, proxy sends `{ type: 'backpressure', paused: true }`. Extension stops sending `mutation` events (continues `tab_snapshot`). Clears when queue drains.
- **Prometheus `/metrics` endpoint**: `GET /metrics` returns text/plain with Prometheus-compatible metrics: `hbb_commands_total`, `hbb_commands_pending`, `hbb_mutation_events_total`, `hbb_mutation_queue_depth`, `hbb_ws_hermes_connected`, `hbb_http_requests_total`, `hbb_http_request_duration_ms`.
- **CHANGELOG.md empty**: Populated with version history including this release.
- **Automated build**: `npm run build:icons` generates all icon sizes. `npm run build:safari` compiles `SafariWebExtensionHandler.swift`. `npm run build:all` runs both. Swift binary removed from repo (compiled on setup).
- **SPEC.md stale**: Updated to reflect all R25 changes: Hermes WS push, backpressure, session management, command cancellation, `/sessions` endpoint, `/metrics` endpoint, config.js values, Safari + Chrome parity, chunked WS.

#### P3 — Low Priority
- **Idempotency key weak signature**: Now uses `createHash('sha256').update(JSON.stringify(cmd))` for collision-resistant key derivation.
- **Rate limit hardcoded**: `CMD_RATE_LIMIT` now read from `config.js` (`RATE_LIMIT_RPS: 5` default, configurable).
- **Safari extension origin validation loose**: Origin check now uses regex `/^(null|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/)` — covers all localhost variants including `null` (file:// context), `localhost`, `127.0.0.1`, and any port.
- **CORS headers overly permissive**: `Access-Control-Allow-Origin` now restricted to `http://localhost:9321` and `http://localhost:9322` (the two valid proxy origins) instead of `*`.
- **No command cancellation**: `DELETE /command/:cmdId` removes pending command without resolving it. Content script receives `cancel` message via background and calls `pendingCommands.delete(cmdId)`.
- **DOM serialization expensive**: `getStructuralSnapshot()` now uses `requestIdleCallback` when page has 2000+ elements, preventing main-thread jank during large page traversals.
- **server_https.js no chunking**: Added `chunkedSend(ws, msg)` helper that fragments large WebSocket messages (> 1MB) into 1MB chunks with `Continuation` frames. Reassembles on receiving end via sequence tracking.
- **server_https.js missing shutdown**: Added proper `process.on('SIGTERM', ...)`, `process.on('SIGINT', ...)` handlers to gracefully close TLS server, WSS, and HTTP server before exit.

---

## [1.2.0] — 2026-04

### Added
- Hermes WebSocket push endpoint at `/hermes` — proxy pushes page state to connected Hermes clients
- `wssHermes` WebSocket server (separate from extension WS) for Hermes Agent push subscription
- Command idempotency cache — deduplicates re-sent commands within 60s window
- `GET /last_seq?sessionId=X` endpoint

### Changed
- `tab_snapshot` and `mutation` events now include `tabId` field
- Extension reconnects with original `sessionId` after proxy restart

---

## [1.1.0] — 2026-04

### Added
- HTTPS variant (`server_https.js`) with self-signed CA cert for network access
- Command queue with timeout tracking (`cmd_queue.js`)
- Periodic full HTML snapshot every 3 seconds
- Major mutation debouncing (300ms) before full snapshot

### Fixed
- Content script `new Function()` replaced `eval()` for CSP compatibility
- Safari extension: `_navigate` background message handler

---

## [1.0.0] — 2026-03

### Added
- Safari Web Extension with content script + background page + popup
- HTTP proxy with page state caching (`page_mirror.js`)
- REST API: `GET /page_state`, `POST /command`, `GET /health`
- MutationObserver for incremental page updates
- launchd plist for auto-start on login
- Full documentation: SPEC.md, SETUP.md, AUTH.md, CHANGELOG.md (empty)
