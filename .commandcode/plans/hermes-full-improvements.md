# Hermes Browser Bridge — Complete Improvement Plan (24 Items)

## Implementation Order & Phases

### Phase 1: Quick Wins & Safety Fixes (No structural changes)
**Goal:** Fix actual bugs, remove dead code, and address critical issues with zero risk.

#### 1. Fix Chrome `web_accessible_resources` bug
- **File:** `extension_chrome/manifest.json`
- **Change:** Add `"extension_shared/shared-content.js"` to the `web_accessible_resources[0].resources` array

#### 2. Delete dead files
- **Files to delete:**
  - `extension_safari/Contents/Resources/background.js.bak`
  - `extension_safari/Contents/Resources/background_full.js`

#### 3. Fix `rateLimiter.js` token-bucket refill bug
- **File:** `proxy_server/lib/rateLimiter.js`
- **Change:** In `_refill()`, update `this.lastRefill = now` before the `if (elapsed < this.windowMs) return;` guard, so partial-window calls don't leak tokens

#### 4. Fix `package.json` / `package-lock.json` version drift
- **File:** `proxy_server/package-lock.json`
- **Change:** Update `"version": "1.3.2"` to match `package.json`

#### 5. Add `eslint` as devDependency
- **File:** `proxy_server/package.json`
- **Change:** Add `"eslint": "^8.57.0"` to `devDependencies`

#### 6. Fix silent error swallowing
- **Files:** `proxy_server/server.js`, `proxy_server/proxy_lib.js`, `proxy_server/lib/wsHandlers.js`, `proxy_server/lib/httpHandlers.js`
- **Changes:**
  - `server.js`: In `readFileSync` catch for package.json, log the error; in `X509Certificate` catch, log the error
  - `proxy_lib.js`: In `ws.send` catch for command forward, emit error back to command queue so Hermes gets feedback
  - `wsHandlers.js`: In `ws.close` catch, log the error instead of `catch (_) {}`
  - `httpHandlers.js`: In `readFileSync` catch for dashboard.js, log the error; in DELETE command handler, check `cmdQueue.cancel` return value

---

### Phase 2: Consolidation (Deduplication & Shared Code)
**Goal:** Eliminate ~500+ lines of near-duplicate code between Chrome and Safari extensions.

#### 7. Create `extension_shared/shared-background.js`
- **New file:** `extension_shared/shared-background.js`
- **Extract from:** `extension_chrome/background.js` and `extension_safari/Contents/Resources/background.js`
- **Approach:** Create a factory function `createBackground(browserAPI, storageAPI)` that accepts either `chrome` or `browser` as the API namespace. Export the shared logic:
  - `connect()`, `scheduleReconnect()`, `startHealthPoll()`, `stopHealthPoll()`
  - `forwardCommandToTab()`, `handleProxyMessage()`, `notifyPopup()`
  - All constants (moved from hardcoded values)
  - Tab management, message routing, badge/icon state

#### 8. Refactor Chrome `background.js` to use shared-background.js
- **File:** `extension_chrome/background.js`
- **Change:** Import `createBackground` from shared module, call with `chrome`, keep only the `chrome.*`-specific service worker startup logic

#### 9. Refactor Safari `background.js` to use shared-background.js
- **File:** `extension_safari/Contents/Resources/background.js`
- **Change:** Import `createBackground` from shared module, call with `browser`, keep only Safari-specific startup logic

#### 10. Create `extension_shared/shared-popup.js`
- **New file:** `extension_shared/shared-popup.js`
- **Extract from:** `extension_chrome/popup.js` and `extension_safari/Contents/Resources/popup.js`
- **Approach:** Factory function `createPopup(runtimeAPI, storageAPI)` — same pattern as background

#### 11. Refactor Chrome `popup.js` to use shared-popup.js
- **File:** `extension_chrome/popup.js`
- **Change:** Import and use shared popup logic

#### 12. Refactor Safari `popup.js` to use shared-popup.js
- **File:** `extension_safari/Contents/Resources/popup.js`
- **Change:** Import and use shared popup logic

#### 13. Create `extension_shared/content-bridge.js` for content.js dedup
- **Files:** `extension_chrome/content.js` + `extension_safari/Contents/Resources/content.js`
- **Change:** Both are already ~77 lines, ~95% identical. Create `extension_shared/content-bridge.js` that accepts the `sendMessage` function, and reduce both content.js files to ~10 lines each

---

### Phase 3: Code Quality & Structure
**Goal:** Improve maintainability, reduce coupling, fix structural issues.

#### 14. Move hardcoded constants to shared config
- **Files:** `proxy_server/server.js`, `proxy_server/page_mirror.js`, `proxy_server/lib/cmd_queue.js`, `proxy_server/lib/commandHistory.js`, `proxy_server/proxy_lib.js`, `extension_shared/shared-background.js` (new)
- **Changes:**
  - Add to `proxy_server/config.js`: `DEFAULT_HTTP_PORT`, `DEFAULT_HTTPS_PORT`, `PRUNE_INTERVAL_MS`, `HTML_TTL_MS`, `MUTATION_TTL_MS`, `MUTATION_BUFFER_MAX`, `MAX_COMPLETED`, `CMD_HISTORY_MAX`, `SESSION_HISTORY_TTL_MS`, `WS_SEND_TIMEOUT_MS`
  - Add to a new `extension_shared/shared-config.js`: `DEFAULT_PROXY_PORT`, `MAX_RECONNECT_DELAY_MS`, `MAX_PENDING_MESSAGES`, `HEALTH_POLL_INTERVAL_MS`, `MAX_RETRIES`, `RETRY_DELAY_MS`
  - Update all references to use config imports

#### 15. Split `setupHttpHandlers()` into per-route handlers
- **File:** `proxy_server/lib/httpHandlers.js`
- **Approach:** Extract handler functions for each route group:
  - `handleHealth()`, `handleMetrics()`, `handlePageState()`, `handleCommand()`, `handleCommandStatus()`, `handleSessions()`, `handleDashboard()`, `handleConfig()`, `handleCommandHistory()`
  - Each accepts `(req, res, ctx)` where `ctx` contains shared dependencies

#### 16. Split `setupWebSocketHandlers()` into two separate setup functions
- **File:** `proxy_server/lib/wsHandlers.js`
- **Approach:** Extract `setupExtensionWS()` and `setupHermesWS()` — each handles its own connection lifecycle

#### 17. Decouple `proxy_lib.js` God module
- **File:** `proxy_server/proxy_lib.js`
- **Approach:** Create a `proxy_server/lib/serverFactory.js` that handles subsystem construction and wiring. `proxy_lib.js` becomes a thin orchestrator that calls the factory.

#### 18. Expose proper public API on `HermesPushManager` instead of accessing `_clients`/`_sessionSubscriptions` directly
- **Files:** `proxy_server/lib/hermesPush.js`, `proxy_server/lib/wsHandlers.js`
- **Changes:** Add `getClientCount()`, `getSubscribedSessions()` methods to `HermesPushManager`; update `wsHandlers.js` to use them instead of `hermesPush._clients`

---

### Phase 4: Testing Infrastructure
**Goal:** Establish a test framework and add unit tests for critical modules.

#### 19. Add Vitest as test framework
- **File:** `proxy_server/package.json`
- **Changes:**
  - Add `"vitest": "^2.0.0"` to `devDependencies`
  - Add `"test": "vitest run"`, `"test:watch": "vitest"` scripts
  - Add `vitest.config.js` at `proxy_server/vitest.config.js`

#### 20. Add unit tests for critical modules
- **New files under `proxy_server/lib/__tests__/`:**
  - `rateLimiter.test.js` — token bucket behavior, burst, refill, edge cases
  - `cmd_queue.test.js` — add, timeout, ack, error, cancel, prune, MAX_COMPLETED
  - `idempotency.test.js` — dedup, TTL eviction, hash consistency
  - `config.test.js` — env var parsing, defaults, edge cases
  - `utils.test.js` — `validateHttpAuth`, `parseBody`, `jsonResponse`, `htmlEscape`

---

### Phase 5: Remaining Fixes
**Goal:** Address the remaining items from the audit.

#### 21. Fix CORS `Access-Control-Allow-Origin` invalid syntax
- **File:** `proxy_server/lib/utils.js`
- **Change:** Replace `'http://localhost:*'` with logic that reflects the `Origin` header when it matches `localhost` or `127.0.0.1` patterns

#### 22. Fix `window.postMessage` `'*'` target origin in shared-content.js
- **File:** `extension_shared/shared-content.js`
- **Change:** Use `location.origin` instead of `'*'` for `postMessage` target, and add origin filtering on the receiver side

#### 23. Inconsistent logging — unify patterns
- **Files:** `extension_chrome/background.js`, `extension_safari/Contents/Resources/background.js`, `proxy_server/page_mirror.js`, `proxy_server/lib/cmd_queue.js`
- **Changes:** Create `extension_shared/shared-logger.js` for browser-side structured logging; update PageMirror and CmdQueue to use `lib/logger.js` instead of raw `console.warn`

#### 24. Remove dead metrics declarations
- **File:** `proxy_server/lib/metrics.js`
- **Change:** Remove unused `htmlBytes` and `mutationBufferSize` histogram arrays

---

## Verification Plan

After each phase:
- **Phase 1:** Run `npm run smoke`, verify proxy starts, load Chrome extension and check `web_accessible_resources` in chrome://extensions
- **Phase 2:** Load both Chrome and Safari extensions, verify popup works, commands flow, health polling functions
- **Phase 3:** Run smoke tests, manually test all HTTP and WS endpoints
- **Phase 4:** Run `npm test` — all new unit tests pass
- **Phase 5:** Run full smoke suite, manually verify CORS behavior, verify no console warnings about `postMessage` origins
