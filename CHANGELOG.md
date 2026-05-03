# Changelog

All notable changes to Hermes Browser Bridge are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.2.0] — 2026-05-03

### Added
- **Rate limiting** — Token-bucket limiter caps commands at 5/second per client; excess returns HTTP 429
- **permessage-deflate compression** — WebSocket traffic compressed, reducing bandwidth on heavy pages
- **Health polling** — Background script polls `/health` every 10s to detect silent proxy disconnects
- **`sessionId` on all messages** — Every extension→proxy message carries a session ID for multi-session tracking
- **Swift handler browser info** — `SafariWebExtensionHandler` now returns browser version on request
- **Per-session page state** — `page_mirror.js` tracks snapshots per sessionId (prepares for multi-tab)
- **`rateLimitRemaining` in response** — POST /command now returns remaining rate limit tokens

### Fixed
- **Info.plist binary name** — `CFBundleExecutable` now correctly set to `SafariWebExtensionHandler`
- **Navigate resolves on page load** — `navigate` command waits for `load` event before acknowledging (was resolving immediately)
- **type() with React/Vue** — Uses native input value setter instead of per-character events; React synthetic events work correctly
- **submit() bypasses JS handlers** — Now clicks the submit button or dispatches a submit event instead of calling native `form.submit()`
- **MutationObserver misses text changes** — Added `characterData: true` to capture text node changes in contenteditable and autofill
- **Mutations carry actual node names** — `addedNodeNames` and `removedNodeNames` arrays now included for meaningful diffs
- **Tab delivery errors swallowed** — Errors from `browser.tabs.sendMessage` now logged at warn level instead of silent catch
- **Popup error state race** — Error set before connecting UI to prevent state ordering bugs
- **Launchd KeepAlive conflict** — Removed conflicting `StartCalendarInterval` dict; `KeepAlive: true` alone handles restart
- **Launchd node path hardcoded** — Now uses `node` (no path) to respect user's PATH
- **Launchd WorkingDirectory fragile** — Now uses absolute path directly (not a symlink)
- **CORS open to all origins** — `Access-Control-Allow-Origin` tightened to `http://localhost:*`
- **Redundant `host_permissions`** — Removed `host_permissions: ["<all_urls>"]`; `activeTab` alone is sufficient for Manifest V3
- **Inconsistent versions** — All files now consistently report version `1.1.0` / build `11`
- **`ws` npm version mismatch** — Unified to `^8.20.0` in package.json

### Changed
- **Server code deduplicated** — `server.js` and `server_https.js` now share all logic via `proxy_lib.js`; no more copy-paste
- **Icon generator** — Rewritten in pure Node.js (no `canvas` dep); generates PNG icons with a geometric H-bridge design

### Security
- **CORS tightened** — REST API now only allows `http://localhost:*` origins

---

## [1.1.0] — 2026-05-03

### Added
- **Graceful shutdown** — Server now handles SIGINT, clears intervals, closes sockets cleanly
- **Periodic command prune** — Completed commands cleaned up every 2 minutes to prevent memory growth
- **Retry logic for command delivery** — Content script gets 3 delivery attempts before reporting failure back to Hermes
- **Mutation ring buffer** — Mutations capped at 100 entries (FIFO eviction)
- **`htmlStale` field** — `GET /page_state` now returns `htmlStale: true` when HTML data is older than 5s
- **macOS 13.0+ target** — Swift binary now targets macOS 13.0 (Ventura) instead of 15.0
- **Launchd plist** — `launchd/com.hermes-agent.browser-bridge.plist` for auto-restart on login
- **CHANGELOG.md** — This file

### Fixed
- **CmdQueue promise rejections** — Commands that time out now `resolve({success: false})` instead of `reject()`, eliminating unhandled rejection warnings
- **`page_mirror.addMutations` data loss** — Mutations are now correctly stored and returned to Hermes (was returning empty arrays)
- **Two-server port conflict** — WebSocket server now shares the HTTP server instance (was two independent binds on same port)
- **Parallel command tracking** — `pendingCmdId` replaced with `Map<cmdId, {resolve, reject}>` — multiple simultaneous commands now track correctly
- **`document.body` null guard** — Content script retries MutationObserver setup if body is absent at init
- **`setInterval` leak on navigation** — Interval cleared on `window.unload`; pending commands rejected on tab close
- **`disconnect` event handled** — Popup's Disconnect button now properly resets background state
- **`getStatus` missing URL** — Popup now receives and displays the active tab's URL after activation
- **`onUpdated` tab overwrite** — Only updates `currentTabId` when the updated tab is the active one
- **`pendingMessages` unbounded queue** — Queue now capped at 50 messages (oldest dropped on overflow)
- **`nativeMessaging` permission removed** — Was declared but unused; removed from manifest

### Changed
- **`ws` dependency documented** — SPEC.md now correctly lists `ws` as the only external dependency (was incorrectly stated as "no external deps")
- **popup.css refactored** — All colors replaced with CSS custom properties (`--bg-primary`, `--accent-blue`, etc.) for easy theming
- **Extension version dynamic** — Popup footer reads `version` from `browser.runtime.getManifest()` instead of hardcoding `v1.0`
- **Swift `profile` warning resolved** — Unused `let profile: UUID?` removed from SafariWebExtensionHandler
- **Swift deployment target** — Now targets macOS 13.0+ (was 15.0); binary compatible with Ventura, Sonoma, and Sequoia

### Security
- **`eval()` replaced with `Function` constructor** — `evaluate` command now uses `new Function()` instead of direct `eval()` for marginally safer page-sandboxed execution
- **WebSocket now has no auth** — Production deployments should add Basic Auth or token auth before exposing beyond localhost

---

## [1.0.0] — 2026-05-02

### Added
- Safari Web Extension with MutationObserver-based DOM mirroring
- Node.js proxy server with HTTP REST API + WebSocket on port 9321
- Click-to-activate popup UI with live connection status
- `scroll`, `click`, `type`, `submit`, `navigate`, `evaluate` commands
- Self-signed CA certificate for future HTTPS proxy support
- SETUP.md and SPEC.md documentation

---

## [Unreleased] — Future

### Planned for v1.3
- Basic Auth on WebSocket + REST endpoints
- Command idempotency keys (prevent double-execution on retry)
- Chrome extension parity (same WebSocket approach)
- HTTPS/TLS support for the proxy (using certificates/ca.crt)

### Considered for v2.0
- End-to-end encryption with user-held key (production readiness)
- Headless mode (no popup, auto-attach on browser launch)
- Multiple tab support (switch active tab from Hermes)
- Video frame capture for visual page understanding
- Multi-session proxy (multiple browser sessions simultaneously)
