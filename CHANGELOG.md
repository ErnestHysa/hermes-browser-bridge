# Changelog

All notable changes to Hermes Browser Bridge are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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

### Planned for v1.2
- Basic Auth on WebSocket + REST endpoints
- Rate limiting (max commands per second)
- Command idempotency keys (prevent double-execution on retry)
- Chrome extension parity (same WebSocket approach)
- HTTPS/TLS support for the proxy (using certificates/ca.crt)

### Considered for v2.0
- End-to-end encryption with user-held key (production readiness)
- Headless mode (no popup, auto-attach on browser launch)
- Multiple tab support (switch active tab from Hermes)
- Video frame capture for visual page understanding
