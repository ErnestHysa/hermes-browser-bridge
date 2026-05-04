/**
 * proxy_lib.js — Shared proxy logic for both HTTP and HTTPS server variants.
 * Contains all HTTP handling, WebSocket handling, and shared state.
 * Both server.js and server_https.js import this.
 *
 * Fix #P0-1:  Hermes WS push redesign — proper session subscription model.
 *             Hermes connects to ws://localhost:9321/hermes, sends a subscribe
 *             message with sessionId, and only receives updates for that session.
 *             Commands from Hermes over WS are forwarded to the correct session.
 * Fix #P1-3:  Tab targeting API — GET /sessions lists all sessions,
 *             POST /sessions/:id/activate sets active session for Hermes.
 * Fix #P2-9:  Prometheus-compatible /metrics endpoint.
 * Fix #P2-8:  Backpressure signaling — proxy sends {type: "backpressure", paused: true/false}
 *             to extension WebSocket when its send buffer is high.
 * Fix #P3-13: Idempotency key uses SHA-256 hash of full command, not just signature.
 * Fix #P3-15: Origin validation checks for null origin (Safari file:// context) explicitly.
 * Fix #P3-16: CORS headers tightened to localhost only (no more wildcard on non-root paths).
 * Fix #P3-17: Command cancellation — DELETE /command/:cmdId cancels pending commands.
 * Fix #18:   Full TypeScript/JSDoc added to all exported classes and functions.
 * Fix #19:   PageStateCache refactor — extracted as a separate class used internally
 *             by PageMirror for per-session state (html, title, url, lastUpdate, mutations[]).
 */

'use strict';

const { WebSocketServer } = require('ws');
const { createHash } = require('crypto');
const { randomUUID } = require('node:crypto');
const { createGzip } = require('zlib');  // S5: gzip compression

// ─── Command History Store (S3) ───────────────────────────────────────────────

/** S3: In-memory command history — last 50 completed commands per session */
const CMD_HISTORY_MAX = 50;
/** @type {Map<string, {cmdId: string, type: string, status: string, result?: string, error?: string, ts: number}[]>} */
const _commandHistory = new Map();

/**
 * Retrieve command history for a session.
 * @param {string} sessionId
 * @returns {{cmdId: string, type: string, status: string, result?: string, error?: string, ts: number}[]}
 */
function _getHistory(sessionId) {
  if (!_commandHistory.has(sessionId)) _commandHistory.set(sessionId, []);
  return _commandHistory.get(sessionId);
}

/**
 * Prepend an entry to the session's command history (bounded to CMD_HISTORY_MAX).
 * @param {string} sessionId
 * @param {{cmdId: string, type: string, status: string, result?: string, error?: string, ts: number}} entry
 */
function _pushHistory(sessionId, entry) {
  const hist = _commandHistory.get(sessionId) || [];
  hist.unshift(entry);
  if (hist.length > CMD_HISTORY_MAX) {
    // F7: Log when we drop history entries so operators can detect when CMD_HISTORY_MAX
    // is too small for the workload. Previously silent — operators had no indication
    // that command audit records were being discarded.
    const dropped = hist.length - CMD_HISTORY_MAX;
    log('warn', 'Command history overflow — dropping oldest entries', { sessionId, dropped, max: CMD_HISTORY_MAX });
    hist.splice(CMD_HISTORY_MAX);
  }
  _commandHistory.set(sessionId, hist);
  // Note: disconnected-session eviction moved to periodic prune interval (see Fix #9)
  // to avoid O(n) iteration on every single command.
}

const { CommandQueue } = require('./cmd_queue');
const { PageMirror } = require('./page_mirror');
const cfg = require('./config');                   // P3-14: all tunable settings in one place

// ─── Constants (from config.js) ───────────────────────────────────────────────

const PROXY_HOST = '127.0.0.1';
const MAX_BODY_BYTES = cfg.MAX_BODY_BYTES;
const MAX_HTML_BYTES = cfg.MAX_HTML_BYTES;
const IDEMPOTENCY_WINDOW_MS = cfg.IDEMPOTENCY_WINDOW_MS;
const PRUNE_INTERVAL_MS = 120000;
const RATE_LIMIT_RPS = cfg.RATE_LIMIT_RPS;        // P3-14: from config.js
const RATE_LIMIT_BURST = cfg.RATE_LIMIT_BURST;
const PER_SESSION_RATE_LIMIT = cfg.PER_SESSION_RATE_LIMIT;  // Fix #15: per-session burst from config
const BACKPRESSURE_THRESHOLD_MS = cfg.BACKPRESSURE_THRESHOLD_MS; // P2-8: from config.js
const SESSION_TIMEOUT_MS = cfg.SESSION_TIMEOUT_MS; // Fix #10: server-side session timeout
const WS_SEND_TIMEOUT_MS = 30000;  // H2: force-close socket if send() blocks for >30s

// ─── Structured Logging ────────────────────────────────────────────────────────

/**
 * JSON log entries to stdout for production debuggability.
 * @param {string} level
 * @param {string} msg
 * @param {object} extras
 */
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LOG_LEVEL = LOG_LEVELS[cfg.LOG_LEVEL] !== undefined ? LOG_LEVELS[cfg.LOG_LEVEL] : LOG_LEVELS.info;  // L1: use explicit undefined check — 0 (debug) is falsy but valid

/** L2: Warn + fallback for missing message fields */
function _warnDefault(field, value) {
  log('warn', `WS message missing '${field}' — using 'default'`, { field, value });
  return 'default';
}

// ─── HTTP Auth Helper (C3) ────────────────────────────────────────────────────

/**
 * C3: Validate auth token from Authorization header or ?token= query param.
 * Returns { authorized: true } or { authorized: false, reason: string }.
 * Token is only required if HBS_AUTH_TOKEN env var is set (dev mode skips auth).
 * @param {import('http').IncomingMessage} req
 * @returns {{ authorized: boolean, reason?: string }}
 */
function validateHttpAuth(req) {
  const expectedToken = process.env.HBS_AUTH_TOKEN || null;
  if (!expectedToken) return { authorized: true }; // dev mode: no auth required
  const authHeader = req.headers['authorization'] || '';
  const queryToken = new URL(req.url, 'http://localhost').searchParams.get('token');
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (queryToken || '');
  if (!provided) return { authorized: false, reason: 'Missing token. Provide ?token=<auth_token> or Authorization: Bearer <token>' };
  if (provided !== expectedToken) return { authorized: false, reason: 'Invalid token' };
  return { authorized: true };
}

/**
 * Structured JSON logger — emits one JSON object per line to stdout.
 * Only logs messages at or above the configured LOG_LEVEL.
 *
 * @param {string} level - One of: debug, info, warn, error
 * @param {string} msg - Log message
 * @param {object} [extras={}] - Additional fields to include in the entry
 */
function log(level, msg, extras = {}) {
  if (LOG_LEVELS[level] === undefined || LOG_LEVELS[level] < CURRENT_LOG_LEVEL) return;
  const entry = {
    t: new Date().toISOString(),
    level,
    msg,
    pid: process.pid,
    ...extras
  };
  // C1: Redact sensitive fields — never log token/password values
  console.log(JSON.stringify(entry, (k, v) => {
    if (k === 'token' || k === 'auth' || k === 'pwd' || k === 'password') return '[REDACTED]';
    return v;
  }));
}

// ─── Prometheus Metrics ─────────────────────────────────────────────────────────

/**
 * Fix #P2-9: Prometheus-compatible metrics exported at GET /metrics.
 * Counters: hbs_commands_total{type, status}, hbs_ws_connections_total,
 *           hbs_ws_messages_total{direction}, hbs_idempotency_rejections_total.
 * Gauges:   hbs_connected_sessions, hbs_pending_commands, hbs_uptime_seconds,
 *           hbs_ws_hermes_clients, hbs_backpressure_active.
 * Histograms: hbs_command_duration_seconds{type}, hbs_html_bytes, hbs_mutation_buffer_size.
 */
const metrics = {
  counters: {
    commands: { type: {}, status: {}, total: 0 },   // commands.total[type][status]++
    wsConnections: 0,
    wsMessages: { rx: 0, tx: 0 },
    idempotencyRejections: 0,
    wsSendTimeouts: 0,  // Fix #8: track and expose WS send timeouts in Prometheus
    sseStreams: 0,
  },
  gauges: {
    connectedSessions: 0,
    pendingCommands: 0,
    uptimeSeconds: 0,
    hermesClients: 0,
    backpressureActive: 0,
  },
  histograms: {
    commandDuration: {},   // { type: [{value, ts}] }
    htmlBytes: [],        // [{bytes, ts}]
    mutationBufferSize: [], // [{size, ts}]
  }
};

/**
 * Increment a named counter metric.
 * @param {string} counterPath - Dot-separated path, e.g. 'commands' or 'commands.total'
 * @param {Record<string, string>} [labels={}] - Label key-value pairs
 */
function metricIncr(counterPath, labels = {}) {
  const parts = counterPath.split('.');
  let node = metrics.counters;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node[parts[i]]) node[parts[i]] = {};
    node = node[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (!node[last]) node[last] = labels._total ? 0 : {};
  if (labels._total) { node[last]++; return; }
  // Build label key for multi-label metrics
  const labelKeys = Object.keys(labels).sort((a, b) => a.localeCompare(b));
  const key = labelKeys.length > 0
    ? labelKeys.map(k => `${k}="${labels[k]}"`).join(',')
    : '';
  if (!node[last][key]) node[last][key] = 0;
  node[last][key]++;
}

/**
 * Set a gauge metric to a value.
 * @param {string} name - Gauge name
 * @param {number} value
 */
function metricGauge(name, value) {
  if (metrics.gauges[name] !== undefined) metrics.gauges[name] = value;
}

// M2: Track last TTL cleanup time to avoid running on every push
let _metricLastCleanup = 0;
const METRIC_TTL_MS = 60000;        // entries older than this are pruned
const METRIC_MAX_PER_TYPE = 1000;   // hard cap per histogram+type

/**
 * Push a value to a named histogram. Entries older than METRIC_TTL_MS are pruned
 * on a debounced schedule (at most every 60s to avoid O(n) on every call).
 *
 * @param {string} histName - Histogram name, e.g. 'commandDuration', 'htmlBytes'
 * @param {number} value
 * @param {Record<string, string>} [labels={}]
 */
function metricHistogramPush(histName, value, labels = {}) {
  const type = labels.type || 'unknown';
  if (!metrics.histograms[histName][type]) {
    metrics.histograms[histName][type] = [];
  }
  metrics.histograms[histName][type].push({ value, labels, ts: Date.now() });
  // M2: Periodic TTL cleanup — run at most every 60s to avoid O(n) on every call
  const now = Date.now();
  if (!_metricLastCleanup || (now - _metricLastCleanup) > METRIC_TTL_MS) {
    _metricLastCleanup = now;
    for (const [hName, entries] of Object.entries(metrics.histograms)) {
      for (const [type, arr] of Object.entries(entries)) {
        const cutoff = now - METRIC_TTL_MS;
        // Remove expired entries
        const valid = arr.filter(e => e.ts > cutoff);
        // Enforce hard cap
        if (valid.length > METRIC_MAX_PER_TYPE) {
          valid.splice(0, valid.length - METRIC_MAX_PER_TYPE);
        }
        metrics.histograms[hName][type] = valid;
      }
    }
  }
}

/**
 * Format all collected metrics in Prometheus exposition format.
 * @returns {string} Prometheus-compatible metrics text
 */
function formatPrometheus() {
  const lines = [];
  const emit = (...parts) => lines.push(parts.join(' '));

  // ── Gauges (TYPE/HELP before value) ────────────────────────────────────
  emit('# HELP hbs_uptime_seconds Proxy uptime in seconds');
  emit('# TYPE hbs_uptime_seconds gauge');
  emit(`hbs_uptime_seconds ${Math.floor(metrics.gauges.uptimeSeconds)}`);

  emit('# HELP hbs_connected_sessions Number of active extension sessions');
  emit('# TYPE hbs_connected_sessions gauge');
  emit(`hbs_connected_sessions ${metrics.gauges.connectedSessions}`);

  emit('# HELP hbs_pending_commands Number of pending commands in queue');
  emit('# TYPE hbs_pending_commands gauge');
  emit(`hbs_pending_commands ${metrics.gauges.pendingCommands}`);

  emit('# HELP hbs_ws_hermes_clients Number of Hermes WS clients connected');
  emit('# TYPE hbs_ws_hermes_clients gauge');
  emit(`hbs_ws_hermes_clients ${metrics.gauges.hermesClients}`);

  emit('# HELP hbs_backpressure_active Whether backpressure is active (1=paused, 0=normal)');
  emit('# TYPE hbs_backpressure_active gauge');
  emit(`hbs_backpressure_active ${metrics.gauges.backpressureActive}`);

  // ── Counters ─────────────────────────────────────────────────────────────
  emit('# HELP hbs_commands_total Total commands processed');
  emit('# TYPE hbs_commands_total counter');
  let grandTotal = 0;
  for (const [type, statusMap] of Object.entries(metrics.counters.commands)) {
    if (type === 'total') continue;
    for (const [labels, count] of Object.entries(statusMap)) {
      grandTotal += count;
      const labelPart = labels ? `{${labels}}` : '';
      emit(`hbs_commands_total{${labels}} ${count}`);
    }
  }
  // Fix #15: Derive total from sum of all labeled counters to avoid divergence
  emit(`hbs_commands_total ${grandTotal}`);

  emit('# HELP hbs_ws_connections_total WebSocket connections established');
  emit('# TYPE hbs_ws_connections_total counter');
  emit(`hbs_ws_connections_total ${metrics.counters.wsConnections}`);

  emit('# HELP hbs_ws_messages_total WebSocket messages received/sent');
  emit('# TYPE hbs_ws_messages_total counter');
  emit(`hbs_ws_messages_total{direction="rx"} ${metrics.counters.wsMessages.rx}`);
  emit(`hbs_ws_messages_total{direction="tx"} ${metrics.counters.wsMessages.tx}`);

  emit('# HELP hbs_idempotency_rejections_total Duplicate commands rejected');
  emit('# TYPE hbs_idempotency_rejections_total counter');
  emit(`hbs_idempotency_rejections_total ${metrics.counters.idempotencyRejections}`);

  emit('# HELP hbs_ws_send_timeouts_total Extension WebSocket sends that timed out (>30s blocked)');
  emit('# TYPE hbs_ws_send_timeouts_total counter');
  emit(`hbs_ws_send_timeouts_total ${metrics.counters.wsSendTimeouts}`);

  // ── Histogram: command duration (proper Prometheus bucket structure) ──────
  const durationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
  emit('# HELP hbs_command_duration_seconds Command execution duration in seconds');
  emit('# TYPE hbs_command_duration_seconds histogram');
  for (const [cmdType, entries] of Object.entries(metrics.histograms.commandDuration)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const values = entries.map(e => e.value);
    const sum = values.reduce((a, b) => a + b, 0);
    const count = values.length;
    // Bucket counts
    const bucketCounts = new Array(durationBuckets.length + 1).fill(0);
    for (const v of values) {
      const sec = v / 1000;
      for (let i = 0; i < durationBuckets.length; i++) {
        if (sec <= durationBuckets[i]) bucketCounts[i]++;
      }
      bucketCounts[durationBuckets.length]++; // +Inf bucket
    }
    // Build label strings once — avoid recomputing on every iteration
    const bucketLabels = [...durationBuckets.map(b => `le="${b}"`), 'le="+Inf"'];
    for (let i = 0; i <= durationBuckets.length; i++) {
      emit(`hbs_command_duration_seconds_bucket {type="${cmdType}",${bucketLabels[i]}} ${bucketCounts[i]}`);
    }
    emit(`hbs_command_duration_seconds_sum{type="${cmdType}"} ${(sum / 1000).toFixed(4)}`);
    emit(`hbs_command_duration_seconds_count{type="${cmdType}"} ${count}`);
  }

  // Fix #3: htmlBytes and mutationBufferSize were emitting ALL histogram entries as
  // O(n) lines per scrape — replace with a single current-value gauge to avoid
  // unbounded output that scales with session lifetime.
  if (metrics.histograms.htmlBytes.length > 0) {
    emit('# HELP hbs_html_bytes HTML snapshot size in bytes received by proxy');
    emit('# TYPE hbs_html_bytes gauge');
    // Emit only the most recent entry as the current value
    const latest = metrics.histograms.htmlBytes[metrics.histograms.htmlBytes.length - 1];
    emit(`hbs_html_bytes ${latest.value}`);
  }

  if (metrics.histograms.mutationBufferSize.length > 0) {
    emit('# HELP hbs_mutation_buffer_size Number of mutations in buffer');
    emit('# TYPE hbs_mutation_buffer_size gauge');
    // Emit only the most recent entry as the current value
    const latest = metrics.histograms.mutationBufferSize[metrics.histograms.mutationBufferSize.length - 1];
    emit(`hbs_mutation_buffer_size ${latest.value}`);
  }

  return lines.join('\n');
}

// ─── Idempotency Cache (Fix #P3-13 — SHA-256 hash of full command) ─────────────

/**
 * IdempotencyCache — prevents duplicate commands from being processed within the
 * idempotency window. Uses SHA-256 of the full command JSON as the cache key (#P3-13).
 *
 * @public
 */
class IdempotencyCache {
  constructor() {
    /** @type {Map<string, { cmdId: string, timestamp: number }>} */
    this._cache = new Map();
  }

  /**
   * Compute a SHA-256 hash of the command JSON and return the first 32 hex chars.
   * @param {object} cmd
   * @returns {string}
   */
  _hash(cmd) {
    return createHash('sha256').update(JSON.stringify(cmd)).digest('hex').slice(0, 32);
  }

  /**
   * Build the internal cache key from sessionId and idempotencyKey.
   * @param {string} sessionId
   * @param {string} idempotencyKey
   * @returns {string}
   */
  _key(sessionId, idempotencyKey) {
    return `${sessionId}:${idempotencyKey}`;
  }

  /**
   * Check whether a command with this idempotencyKey was already recorded for this session.
   * Entries older than IDEMPOTENCY_WINDOW_MS are treated as not found (auto-evicted).
   *
   * @param {string} sessionId
   * @param {string} idempotencyKey
   * @param {object} cmd
   * @returns {{ duplicate: boolean, existingCmdId: string|null }}
   */
  check(sessionId, idempotencyKey, cmd) {
    if (!idempotencyKey) return { duplicate: false, existingCmdId: null };
    const k = this._key(sessionId, idempotencyKey);
    const entry = this._cache.get(k);
    if (!entry) return { duplicate: false, existingCmdId: null };
    const age = Date.now() - entry.timestamp;
    if (age > IDEMPOTENCY_WINDOW_MS) {
      this._cache.delete(k);
      return { duplicate: false, existingCmdId: null };
    }
    return { duplicate: true, existingCmdId: entry.cmdId };
  }

  /**
   * Record a command's idempotency key so future duplicates can be detected.
   * @param {string} sessionId
   * @param {string} idempotencyKey
   * @param {string} cmdId
   * @param {object} cmd
   */
  record(sessionId, idempotencyKey, cmdId, cmd) {
    if (!idempotencyKey) return;
    const k = this._key(sessionId, idempotencyKey);
    this._cache.set(k, { cmdId, timestamp: Date.now() });
  }

  /**
   * Remove all entries older than IDEMPOTENCY_WINDOW_MS.
   */
  prune() {
    const cutoff = Date.now() - IDEMPOTENCY_WINDOW_MS;
    for (const [k, v] of this._cache) {
      if (v.timestamp < cutoff) this._cache.delete(k);
    }
  }
}

// ─── Rate Limiter ─────────────────────────────────────────────────────────────

/**
 * Token-bucket rate limiter with burst support.
 *
 * L3: Burst allows the first few requests after idle to proceed at full speed,
 * then refills tokens gradually. Start fully burst-ready on construction.
 *
 * @public
 */
class RateLimiter {
  /**
   * @param {number} [maxTokens=RATE_LIMIT_RPS] - Tokens per second (refill rate)
   * @param {number} [windowMs=1000] - Refill window in milliseconds
   * @param {number} [burstSize=RATE_LIMIT_BURST] - Max burst capacity
   */
  constructor(maxTokens = RATE_LIMIT_RPS, windowMs = 1000, burstSize = RATE_LIMIT_BURST) {
    this.maxTokens = maxTokens;
    this.windowMs = windowMs;
    this.burstSize = burstSize;
    this.tokens = burstSize;
    this.lastRefill = Date.now();
  }

  /**
   * Try to consume one token. Returns true if allowed, false if rate limited.
   * @returns {boolean}
   */
  tryConsume() {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** @private */
  _refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed >= this.windowMs) {
      const refill = Math.min(this.maxTokens, Math.floor(elapsed / this.windowMs * this.maxTokens));
      this.tokens = Math.min(this.maxTokens, this.tokens + refill);
      this.lastRefill = now;
    }
  }

  /** @returns {number} Available tokens after refill */
  get available() {
    this._refill();
    return Math.floor(this.tokens);
  }
}

// ─── Backpressure Manager (Fix #P2-8) ─────────────────────────────────────────

/**
 * Per-session backpressure tracking (#18).
 *
 * Each extension session has its own backpressure state — a slow session
 * doesn't pause other sessions. When a session's send buffer is estimated to
 * exceed BACKPRESSURE_THRESHOLD_MS, the manager sends {type: "backpressure", paused: true}
 * to the extension WebSocket. When the send completes, it sends paused: false.
 *
 * @public
 */
class BackpressureManager {
  constructor() {
    /** @type {Map<string, {paused: boolean, ws: import('ws').WebSocket, pendingCount: number}>} */
    this._sessions = new Map();
  }

  /**
   * Increment the pending message count for a session.
   * Fix #22: Track actual queue depth — backpressure kicks in when either the
   * estimated send time exceeds BACKPRESSURE_THRESHOLD_MS OR there are more than
   * 5 messages already buffered (depth-based backpressure).
   * @param {string} sessionId
   */
  incrementPending(sessionId) {
    const entry = this._sessions.get(sessionId);
    if (!entry) return;
    entry.pendingCount++;
  }

  /**
   * Decrement the pending message count when a message is confirmed sent.
   * @param {string} sessionId
   */
  decrementPending(sessionId) {
    const entry = this._sessions.get(sessionId);
    if (!entry) return;
    if (entry.pendingCount > 0) entry.pendingCount--;
  }

  /**
   * Signal that a session is about to write a large payload (estimated slow).
   * Only signals if the session isn't already paused.
   * Fix #22: Also triggers when pending message depth exceeds MAX_PENDING_DEPTH.
   * @param {string} sessionId
   * @param {import('ws').WebSocket} ws
   * @param {boolean} [forcePause] — force pause regardless of current state
   */
  markWriting(sessionId, ws, forcePause = false) {
    const entry = this._sessions.get(sessionId);
    if (!entry || (!entry.paused || forcePause)) {
      this._sessions.set(sessionId, { ...(entry || {}), paused: true, ws, pendingCount: entry?.pendingCount || 0 });
      metricGauge('backpressureActive', 1);
      this._sendSignal(ws, true);
    }
  }

  /**
   * Signal that a session's write completed (buffer drained).
   * Fix #22: Resume only when both conditions are met: estimated send time is
   * back under threshold AND pending count is below resume threshold.
   * @param {string} sessionId
   * @param {import('ws').WebSocket} ws
   */
  markDone(sessionId, ws) {
    const entry = this._sessions.get(sessionId);
    if (entry && entry.paused) {
      // Only resume when pending count has dropped well below the threshold
      if (entry.pendingCount <= 2) {
        entry.paused = false;
        this._sendSignal(ws, false);
        const anyPaused = Array.from(this._sessions.values()).some(e => e.paused);
        if (!anyPaused) {
          metricGauge('backpressureActive', 0);
        }
      }
      // If pending count is still high, keep backpressure active — don't clear it
    }
  }

  /**
   * @param {string} sessionId
   * @returns {boolean}
   */
  isPaused(sessionId) {
    const entry = this._sessions.get(sessionId);
    return entry ? entry.paused : false;
  }

  /**
   * Remove a session from backpressure tracking on disconnect.
   * @param {string} sessionId
   */
  removeSession(sessionId) {
    const entry = this._sessions.get(sessionId);
    if (entry && entry.paused) {
      this._sendSignal(entry.ws, false);
    }
    this._sessions.delete(sessionId);
    const anyPaused = Array.from(this._sessions.values()).some(e => e.paused);
    if (!anyPaused) {
      metricGauge('backpressureActive', 0);
    }
  }

  /** @private */
  _sendSignal(ws, paused) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'backpressure',
        paused,
        ts: Date.now()
      }));
    }
  }
}

// ─── Hermes Push Client Manager (Fix #P0-1) ────────────────────────────────────

/**
 * Hermes Push Manager — manages Hermes WS client connections and per-session subscriptions.
 *
 * Hermes clients connect to ws://localhost:9321/hermes and send a subscribe message
 * with a sessionId. The proxy then pushes only that session's updates to that client.
 * Hermes can also send commands over this socket which are forwarded to the
 * appropriate extension session.
 *
 * @public
 */
class HermesPushManager {
  constructor() {
    /** @type {Map<import('ws').WebSocket, {sessionId: string, reqId: string}>} */
    this._clients = new Map();
    /** @type {Map<string, import('ws').WebSocket>} H1: cmdId → specific Hermes WS client that issued it */
    this._cmdIdToWs = new Map();
    /** @type {Map<string, Set<import('ws').WebSocket>>} sessionId → set of subscribed clients */
    this._sessionSubscriptions = new Map();
    /** H3: Callback to forward session_bridge to extension — set by createProxy */
    this._onSessionBridge = null;
  }

  /**
   * Set the callback invoked when Hermes sends a session_bridge message.
   * @param {(newSessionId: string, oldSessionId: string) => void} cb
   */
  setOnSessionBridge(cb) { this._onSessionBridge = cb; }

  /**
   * Subscribe a Hermes WS client to a session. The client will receive page updates
   * for that session only. Re-subscribing to a different session atomically switches.
   * @param {import('ws').WebSocket} ws
   * @param {string} sessionId
   * @param {string} reqId
   */
  subscribe(ws, sessionId, reqId) {
    const existing = this._clients.get(ws);
    if (existing) {
      const prevSet = this._sessionSubscriptions.get(existing.sessionId);
      if (prevSet) prevSet.delete(ws);
    }

    this._clients.set(ws, { sessionId, reqId });
    if (!this._sessionSubscriptions.has(sessionId)) {
      this._sessionSubscriptions.set(sessionId, new Set());
    }
    this._sessionSubscriptions.get(sessionId).add(ws);
    metricGauge('hermesClients', this._clients.size);
    log('info', 'Hermes WS subscribed to session', { reqId, sessionId });
  }

  /**
   * Unsubscribe a Hermes WS client from its current session.
   * @param {import('ws').WebSocket} ws
   */
  unsubscribe(ws) {
    const entry = this._clients.get(ws);
    if (entry) {
      const set = this._sessionSubscriptions.get(entry.sessionId);
      if (set) set.delete(ws);
      this._clients.delete(ws);
      metricGauge('hermesClients', this._clients.size);
    }
  }

  /**
   * Fix #22: Remove all Hermes subscriptions and cmdIdToWs entries for a session.
   * Called when a session is evicted (timeout or manual disconnect) so Hermes clients
   * know they can stop waiting for updates on that session.
   * @param {string} sid
   */
  _removeSession(sid) {
    // Notify each subscribed Hermes client that this session is gone
    const subs = this._sessionSubscriptions.get(sid);
    if (subs) {
      for (const ws of subs) {
        try {
          ws.send(JSON.stringify({ type: 'session_evicted', sessionId: sid, reason: 'timeout' }));
        } catch (_) {}
      }
      this._sessionSubscriptions.delete(sid);
    }
    // Clean up any pending cmd routing entries for this session
    for (const [cmdId, storedWs] of this._cmdIdToWs.entries()) {
      const clientSid = this._clients.get(storedWs)?.sessionId;
      if (clientSid === sid) {
        this._cmdIdToWs.delete(cmdId);
      }
    }
  }

  /**
   * Fix #11: Remove all _cmdIdToWs entries associated with a disconnected Hermes WS.
   * This prevents unbounded memory growth when long-running Hermes sessions disconnect
   * without receiving cmd_error for all their pending commands.
   * @param {import('ws').WebSocket} ws
   */
  _cleanupWsEntries(ws) {
    for (const [cmdId, storedWs] of this._cmdIdToWs.entries()) {
      if (storedWs === ws) {
        this._cmdIdToWs.delete(cmdId);
      }
    }
  }

  /**
   * H3: Forward a session_bridge message to the extension WebSocket.
   * Called when Hermes sends { type: 'session_bridge', sessionId, previousSessionId }.
   * @param {string} newSessionId
   * @param {string} oldSessionId
   */
  broadcastSessionBridge(newSessionId, oldSessionId) {
    if (this._onSessionBridge) {
      this._onSessionBridge(newSessionId, oldSessionId);
    }
  }

  /**
   * Push a page state update to all Hermes clients subscribed to this session.
   * Called by the proxy whenever pageMirror updates.
   * @param {string} sessionId
   * @param {object} payload
   */
  pushToSession(sessionId, payload) {
    const subscribers = this._sessionSubscriptions.get(sessionId);
    if (!subscribers || subscribers.size === 0) return;
    const data = JSON.stringify(payload);
    for (const ws of subscribers) {
      if (ws.readyState === 1) {
        try { ws.send(data); } catch (_) {}
      }
    }
  }

  /**
   * Forward a command from Hermes to the correct extension session.
   * @param {string} sessionId
   * @param {object} command
   */
  forwardCommand(sessionId, command) {
    return sendToExtension(sessionId, command);
  }

  /** @returns {number} Number of connected Hermes WS clients */
  get size() { return this._clients.size; }
}

// ─── Shared Proxy Factory ─────────────────────────────────────────────────────

/**
 * createProxy — factory that builds a fully-configured Hermes Browser Bridge proxy.
 *
 * Returns the HTTP server, WebSocket servers, pageMirror, command queue, and a
 * shutdown function. The proxy handles:
 * - Extension WebSocket connections (page snapshots, mutations, command acks)
 * - Hermes WS push client connections (subscribes to session updates)
 * - HTTP REST API (health, metrics, commands, session management)
 *
 * @param {{ httpServer: import('http').Server, tlsOptions?: object, version?: string }} options
 * @returns {{
 *   httpServer: import('http').Server,
 *   wss: import('ws').WebSocketServer,
 *   pageMirror: import('./page_mirror').PageMirror,
 *   cmdQueue: import('./cmd_queue').CommandQueue,
 *   shutdown: () => void,
 *   hermesPush: HermesPushManager
 * }}
 */
function createProxy({ httpServer, tlsOptions, version }) {
  const PROXY_VERSION = version || '1.0.0';
  const pageMirror = new PageMirror({ maxHtmlBytes: MAX_HTML_BYTES, sessionTtlMs: cfg.SESSION_TTL_MS });
  // Fix #5: Start background eviction so disconnected sessions don't accumulate
  pageMirror.startEvictionTimer();
  const cmdQueue = new CommandQueue(cfg.CMD_TIMEOUT_MS);  // P3-14: configurable timeout
  const idempotencyCache = new IdempotencyCache();
  const backpressure = new BackpressureManager();
  const hermesPush = new HermesPushManager();
  hermesPush.setOnSessionBridge((newId, oldId) => {
    // H3: When Hermes sends session_bridge, forward to the extension WebSocket
    const extWs = sessionSockets.get(oldId);
    if (extWs && extWs.readyState === 1) {
      extWs.send(JSON.stringify({ type: 'session_bridge', sessionId: newId, previousSessionId: oldId }));
    }
  });

  /** @type {Map<string, RateLimiter>} */
  const rateLimiters = new Map();
  const sessionMeta = new Map(); // sessionId → { limiter, lastSeen }
  // Fix #5: Store extension session metadata (version, tabId, userAgent) per session
  const sessionMetaInfo = new Map(); // sessionId → { version?, tabId?, userAgent?, connectedAt: number }

  function getSessionMeta(sessionId) {
    if (!sessionMeta.has(sessionId)) {
      sessionMeta.set(sessionId, {
        limiter: new RateLimiter(RATE_LIMIT_RPS, 1000, PER_SESSION_RATE_LIMIT),  // Fix #15: use per-session burst from config
        lastSeen: Date.now()
      });
    }
    const meta = sessionMeta.get(sessionId);
    meta.lastSeen = Date.now();
    return meta;
  }

  /** @type {Map<string, import('ws').WebSocket>} */
  const sessionSockets = new Map();

  // ── Utility ────────────────────────────────────────────────────────────────────

  function jsonResponse(res, statusCode, data, extraHeaders = {}) {
    const json = JSON.stringify(data);
    const acceptEncoding = (res.req && res.req.headers && res.req.headers['accept-encoding']) || '';
    // S7: X-Request-Id on every HTTP response for tracing
    const reqId = (res.req && res.req._hermesReqId) || 'unknown';

    // S5: gzip — if client accepts gzip and response > 1KB, compress.
    // zlib.createGzip() uses level 6 by default (balanced speed/size).
    // Fix #17: To make configurable: set env HBS_GZIP_LEVEL (0=none, 1=fastest … 9=best, default 6).
    if (acceptEncoding.includes('gzip') && json.length > 1024) {
      const gzip = createGzip();
      const headers = {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Access-Control-Allow-Origin': 'http://localhost:*',  // Fix #14: was missing in gzip path
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'X-Content-Type-Options': 'nosniff',  // M10
        'X-Frame-Options': 'DENY',            // M10
        'X-XSS-Protection': '1; mode=block',  // M10
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',  // M10
        'X-Request-Id': reqId,                // S7
        ...extraHeaders
      };
      res.writeHead(statusCode, headers);
      gzip.pipe(res);
      gzip.write(json);
      gzip.end();
      return;
    }

    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'http://localhost:*',  // P3-16
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'X-Content-Type-Options': 'nosniff',  // M10
      'X-Frame-Options': 'DENY',            // M10
      'X-XSS-Protection': '1; mode=block',  // M10
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',  // M10
      'X-Request-Id': reqId,                // S7
      ...extraHeaders
    });
    res.end(json);
  }

  function parseBody(req) {
    return new Promise((resolve, reject) => {
      let bytes = 0;
      let body = '';
      req.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          req.destroy();
          reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
          return;
        }
        body += chunk;
      });
      req.on('end', () => {
        try { resolve(body ? JSON.parse(body) : {}); }
        catch (e) { reject(new Error('Invalid JSON')); }
      });
      req.on('error', reject);
    });
  }

  /**
   * Send a message to a specific session's extension WebSocket.
   * Fix #P2-8: If the message is large (e.g. full HTML snapshot), signal backpressure.
   * Fix #22: Also check depth-based backpressure — pause if session already has
   * more than 5 messages buffered (indicated by pendingCount).
   */
  function sendToExtension(sessionId, msg, options = {}) {
    const ws = sessionSockets.get(sessionId);
    if (!ws || ws.readyState !== 1) return false;
    const data = JSON.stringify(msg);
    const estimatedMs = data.length / 10000; // ~10KB/ms throughput guess

    // Depth-based backpressure: if the session already has messages queued, pause
    const entry = backpressure._sessions.get(sessionId);
    const pendingCount = entry?.pendingCount || 0;
    if (pendingCount > 5 || estimatedMs > BACKPRESSURE_THRESHOLD_MS) {
      backpressure.markWriting(sessionId, ws, /* forcePause */ pendingCount > 5);
    }

    // Fix #22: Increment pending count before sending
    backpressure.incrementPending(sessionId);

    try {
      _resetHermesSendTimeout(ws, reqId);  // Fix #1: Hermes-specific send timeout
      ws.send(data, () => {
        _clearHermesSendTimeout();  // Fix #1: send completed
        backpressure.decrementPending(sessionId);  // Fix #22
        backpressure.markDone(sessionId, ws);
      });
    } catch (e) {
      _clearHermesSendTimeout();  // Fix #1: send failed
      backpressure.markDone(sessionId, ws);
    }
    return true;
  }

  function broadcastToAllExtensions(msg) {
    const data = JSON.stringify(msg);
    for (const ws of sessionSockets.values()) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

  // ── WebSocket Server (Extension WebSocket) ─────────────────────────────────

  // F14: permessage-deflate is enabled — mutation HTML bodies and JSON frames are
  // transparently compressed, typically cutting bandwidth by 60–80% on typical page HTML.
  // To disable: set env HBS_NO_DEFLATE=1 or remove the permessageDeflate block below.
  // See: https://www.rfc-editor.org/rfc/rfc7692
  const wssOptions = { server: httpServer };
  wssOptions.permessageDeflate = {
    serverNoContextTakeover: true,
    serverMaxWindowBits: 15,
    clientNoContextTakeover: true,
    clientMaxWindowBits: 15,
    concurrencyLimit: 10
  };
  const wssOptionsWithPing = { ...wssOptions, pingInterval: 30000, pingTimeout: 10000 };
const wss = new WebSocketServer(wssOptionsWithPing);

  // ── WebSocket Server (Hermes push client — Fix #P0-1) ───────────────────────
  const wssHermes = new WebSocketServer({ noServer: true, pingInterval: 30000, pingTimeout: 10000 });

  // Fix #1: Hermes WS send timeout — separate from Extension's _sendTimeoutTimer.
  // Hermes uses this to detect when a Hermes WS client is unresponsive.
  let _hermesSendTimeoutTimer = null;
  function _clearHermesSendTimeout() {
    if (_hermesSendTimeoutTimer !== null) { clearTimeout(_hermesSendTimeoutTimer); _hermesSendTimeoutTimer = null; }
  }
  function _resetHermesSendTimeout(ws, reqId) {
    _clearHermesSendTimeout();
    _hermesSendTimeoutTimer = setTimeout(() => {
      log('warn', `Hermes WS send timeout — closing socket`, { reqId });
      metrics.counters.wsSendTimeouts++;
      ws.terminate();  // Fix #1: actually close the unresponsive Hermes WS
    }, WS_SEND_TIMEOUT_MS);
  }

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://localhost:${httpServer.address().port}`);
    if (url.pathname === '/hermes') {
      wssHermes.handleUpgrade(req, socket, head, (ws) => {
        wssHermes.emit('connection', ws, req);
      });
    }
    // Extension WS connections have path '/' — handled by wss above
  });

  // Hermes WS connection handler (Fix #P0-1)
  wssHermes.on('connection', (ws, req) => {
    const reqId = randomUUID().slice(0, 8);
    const remoteIp = req.socket.remoteAddress || 'unknown';
    log('info', 'Hermes WS client connected', { reqId, remoteIp });
    metricIncr('wsConnections');
    let authenticated = false;

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      log('debug', `Hermes WS ← ${msg.type}`, { reqId });

      // Fix #1: Token-based auth on /hermes — token validated against HBS_AUTH_TOKEN env var
      if (msg.type === 'hello') {
        const expectedToken = process.env.HBS_AUTH_TOKEN || null;
        if (expectedToken && msg.token !== expectedToken) {
          log('warn', 'Hermes WS auth failed — invalid token', { reqId });
          ws.close(1008, 'Invalid token');
          return;
        }
        authenticated = true;
        ws.send(JSON.stringify({ type: 'hello_ack', message: 'Hermes Browser Bridge proxy ready', reqId }));
        return;
      }

      if (!authenticated) {
        ws.close(1008, 'Send hello first');
        return;
      }

      // P0-1: Session subscription
      if (msg.type === 'subscribe') {
        if (!msg.sessionId) {
          ws.send(JSON.stringify({ type: 'error', message: 'sessionId required' }));
          return;
        }
        hermesPush.subscribe(ws, msg.sessionId, reqId);
        // Send current state of that session immediately
        const state = pageMirror.getState(msg.sessionId, 0);
        ws.send(JSON.stringify({ type: 'page_state', sessionId: msg.sessionId, ...state }));
        ws.send(JSON.stringify({ type: 'subscribed', sessionId: msg.sessionId }));
        return;
      }

      // Forward session_bridge from Hermes to the extension WebSocket
      if (msg.type === 'session_bridge') {
        const newId = msg.sessionId;
        const oldId = msg.previousSessionId;
        if (newId && oldId) {
          hermesPush.broadcastSessionBridge(newId, oldId);
        }
        ws.send(JSON.stringify({ type: 'session_bridge_ack', sessionId: newId, previousSessionId: oldId }));
        return;
      }

      // P0-1: Unsubscribe
      if (msg.type === 'unsubscribe') {
        hermesPush.unsubscribe(ws);
        ws.send(JSON.stringify({ type: 'unsubscribed' }));
        return;
      }

      // P0-1: Command over WS — forward to extension session
      if (msg.type === 'command') {
        const sessionId = msg.sessionId;
        const cmdId = msg.cmdId || randomUUID();
        const cmd = {
          type: msg.commandType,   // 'click', 'navigate', etc.
          cmdId,
          selector: msg.selector,
          url: msg.url,
          x: msg.x,
          y: msg.y,
          text: msg.text,
          script: msg.script,
        };
        // H1: Track cmdId → this specific Hermes WS client so cmd_error routes back correctly
        hermesPush._cmdIdToWs.set(cmdId, ws);
        hermesPush.forwardCommand(sessionId, cmd);
        log('info', `Hermes CMD → extension`, { reqId, sessionId, type: cmd.type, cmdId });
        ws.send(JSON.stringify({ type: 'command_queued', cmdId, sessionId }));
        return;
      }

      // P0-1: Ping/pong keepalive
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      }
    });

    _clearHermesSendTimeout();  // Fix #1: clear Hermes-specific send timeout on close
    ws.on('close', () => {
      hermesPush._cleanupWsEntries(ws);  // Fix #11: prevent _cmdIdToWs leaks on disconnect
      hermesPush.unsubscribe(ws);
      _clearHermesSendTimeout();  // Fix #1: clear timer on close
      log('info', 'Hermes WS client disconnected', { reqId });
    });

    ws.on('error', (err) => {
      log('error', 'Hermes WS error', { reqId, err: err.message });
      hermesPush.unsubscribe(ws);
    });
  });

  // Push page state to Hermes clients when pageMirror updates
  const origUpdateSnapshot = pageMirror.updateSnapshot.bind(pageMirror);
  pageMirror.updateSnapshot = function(sessionId, snapshot) {
    origUpdateSnapshot(sessionId, snapshot);
    hermesPush.pushToSession(sessionId, { type: 'page_state', sessionId, ...snapshot });
    metricHistogramPush('htmlBytes', snapshot.html ? snapshot.html.length : 0);
  };

  const origAddMutations = pageMirror.addMutations.bind(pageMirror);
  pageMirror.addMutations = function(sessionId, mutationData) {
    origAddMutations(sessionId, mutationData);
    hermesPush.pushToSession(sessionId, { type: 'mutations', sessionId, ...mutationData });
    metricHistogramPush('mutationBufferSize', mutationData.mutations ? mutationData.mutations.length : 0);
  };

  // ── Extension WebSocket ─────────────────────────────────────────────────────

  wss.on('connection', (ws, req) => {
    const reqId = randomUUID().slice(0, 8);
    const remoteIp = req.socket.remoteAddress || 'unknown';

    // C2: Authenticate extension connections via token in hello message.
    // Extensions must send { type: 'hello', token: <HBS_AUTH_TOKEN> } within
    // a short window after connecting. Connections without a valid token are rejected.
    let extAuthenticated = false;
    const expectedToken = process.env.HBS_AUTH_TOKEN || null;
    const authTimeout = setTimeout(() => {
      if (!extAuthenticated) {
        log('warn', 'Extension WS auth timeout — no hello received', { reqId, remoteIp });
        ws.close(1008, 'Auth required');
      }
    }, 5000);

    // F20: Origin validation — uses configurable ALLOWED_ORIGINS list from config.js.
    // Safari file:// pages send origin 'null' — always allowed.
    const origin = req.headers['origin'];
    const validOrigins = config.ALLOWED_ORIGINS;
    if (origin && !validOrigins.includes(origin)) {
      log('warn', 'WS connection rejected — unauthorized origin', { reqId, origin, remoteIp });
      ws.close(1008, 'Unauthorized origin');
      return;
    }

    log('info', 'Extension WS connected', { reqId, origin: origin || 'null', remoteIp });
    metricIncr('wsConnections');

    // H2: Send timeout — detect unresponsive extension sockets
    let _sendTimeoutTimer = null;
    function _clearSendTimeout() {
      if (_sendTimeoutTimer !== null) { clearTimeout(_sendTimeoutTimer); _sendTimeoutTimer = null; }
    }
    function _resetSendTimeout() {
      _clearSendTimeout();
      _sendTimeoutTimer = setTimeout(() => {
        log('warn', `WS send timeout for extension — closing socket`, { reqId, sessionId });
        metrics.counters.wsSendTimeouts++;
        ws.terminate();
      }, WS_SEND_TIMEOUT_MS);
    }

    // isAlive tracking now handled by ws library's ping/pong protocol

    ws.on('message', (raw) => {
      metrics.counters.wsMessages.rx++;

      // M4: Per-session WS message rate limiting — reject if session exceeds limit
      {
        const meta = getSessionMeta(sessionId);
        if (!meta.limiter.tryConsume()) {
          log('warn', 'Extension WS rate limit exceeded — dropping message', { reqId, sessionId, type: msg.type });
          ws.send(JSON.stringify({ type: 'rate_limited', message: 'Too many messages — slow down', retryAfterMs: 100 }));
          return;
        }
      }
      let msg;
      try { msg = JSON.parse(raw); }
      catch (e) {
        log('warn', 'WS invalid JSON', { reqId, raw: String(raw).slice(0, 100) });
        return;
      }

      // C2: Require 'hello' message with valid token before accepting any other messages
      if (!extAuthenticated) {
        if (msg.type === 'hello') {
          clearTimeout(authTimeout);
          // No token required if HBS_AUTH_TOKEN is not set (dev mode)
          if (expectedToken && msg.token !== expectedToken) {
            log('warn', 'Extension WS auth failed — invalid token', { reqId, remoteIp });
            ws.close(1008, 'Invalid token');
            return;
          }
          extAuthenticated = true;
          log('info', 'Extension WS authenticated', { reqId, remoteIp });
          ws.send(JSON.stringify({ type: 'connected', message: 'Proxy ready' }));
          return;
        }
        log('warn', 'Extension WS sent message before hello — rejecting', { reqId, type: msg.type });
        ws.close(1008, 'Send hello first');
        return;
      }

      // Fix #12: Warn when falling back to 'default' sessionId — masks config errors
      // Fix #4: Only warn once — don't call _warnDefault (which also logs) and then log again
      const sessionId = msg.sessionId || 'default';
      if (!msg.sessionId) {
        log('warn', 'Extension WS sent no sessionId — falling back to default', { reqId });
      }
      log('debug', `WS ← ${msg.type}`, { reqId, sessionId, tabId: msg.tabId || null });

      switch (msg.type) {
        case 'tab_snapshot': {
          if (sessionId) sessionSockets.set(sessionId, ws);
          pageMirror.updateSnapshot(sessionId, msg);
          metricGauge('connectedSessions', sessionSockets.size);
          break;
        }

        case 'mutation':
        case 'mutation_batch':
          // C1: mutation_batch carries an array of pre-batched mutation entries from Safari
          // Each entry has {mutations, url, seq}. Forward each to pageMirror individually
          if (msg.type === 'mutation_batch' && Array.isArray(msg.mutations)) {
            for (const entry of msg.mutations) {
              pageMirror.addMutations(sessionId, { ...entry, seq: entry.seq || msg.seq });
            }
          } else {
            pageMirror.addMutations(sessionId, msg);
          }
          break;

        case 'heartbeat':
          sessionSockets.set(sessionId, ws);
          break;

        case 'session_info':
          // S3: Extension sends session metadata on connect
          // Fix #5: Store metadata so it's accessible via GET /sessions/:id
          log('info', `session_info from extension`, { reqId, sessionId, version: msg.version, tabId: msg.tabId });
          sessionMetaInfo.set(sessionId, {
            version: msg.version || null,
            tabId: msg.tabId || null,
            userAgent: msg.userAgent || null,
            connectedAt: Date.now()
          });
          break;

        case 'cmd_ack': {
          const before = cmdQueue.size;
          cmdQueue.ack(msg.cmdId, msg.result);
          if (cmdQueue.size === before && !cmdQueue.get(msg.cmdId)?.result) {
            log('warn', 'cmd_ack for unknown cmdId', { reqId, sessionId, cmdId: msg.cmdId });
          } else {
            // Record metrics
            const cmdEntry = cmdQueue.get(msg.cmdId);
            if (cmdEntry?.cmd) {
              const duration = Date.now() - (cmdEntry.submittedAt || Date.now());
              metricHistogramPush('commandDuration', duration, { type: cmdEntry.cmd.type });
              metricIncr('commands', { type: cmdEntry.cmd.type, status: 'success' });
              // S3: Record in command history
              _pushHistory(sessionId, { cmdId: msg.cmdId, type: cmdEntry.cmd.type, status: 'success', result: String(msg.result || '').slice(0, 200), ts: Date.now() });
            }
            // Note: no second metricIncr for 'success' here — grandTotal is derived from labeled sums above
          }
          break;
        }

        case 'cmd_error': {
          // S8: Structured error codes — prefer the errorCode field if available,
          // fall back to string matching for compatibility with older extensions.
          // Fix #25: This avoids misclassification when error messages are localized,
          // capitalized differently, or reworded in custom element frameworks.
          const rawError = msg.error || 'Unknown error';
          let errCode;
          if (msg.errorCode && typeof msg.errorCode === 'string' && msg.errorCode !== 'INTERNAL_ERROR') {
            errCode = msg.errorCode;  // Use the structured code directly
          } else if (rawError.toLowerCase().includes('timeout')) {
            errCode = 'COMMAND_TIMEOUT';
          } else if (rawError.toLowerCase().includes('not found') || rawError.toLowerCase().includes('no node')) {
            errCode = 'ELEMENT_NOT_FOUND';
          } else if (rawError.toLowerCase().includes('denied') || rawError.toLowerCase().includes('permission')) {
            errCode = 'PERMISSION_DENIED';
          } else if (rawError.toLowerCase().includes('invalid') || rawError.toLowerCase().includes('selector')) {
            errCode = 'INVALID_COMMAND';
          } else {
            errCode = 'INTERNAL_ERROR';
          }

          const before = cmdQueue.size;
          cmdQueue.error(msg.cmdId, rawError);
          if (cmdQueue.size === before && cmdQueue.get(msg.cmdId)?.status !== 'error') {
            log('warn', 'cmd_error for unknown cmdId', { reqId, sessionId, cmdId: msg.cmdId, error: rawError, errCode });
          } else {
            const cmdEntry = cmdQueue.get(msg.cmdId);
            if (cmdEntry?.cmd) {
              metricIncr('commands', { type: cmdEntry.cmd.type, status: 'error' });
              // S3: Record in command history
              _pushHistory(sessionId, { cmdId: msg.cmdId, type: cmdEntry.cmd.type, status: 'error', error: String(msg.error || 'Unknown error').slice(0, 200), ts: Date.now() });
            }
          }

          // H1: Route cmd_error to the specific Hermes WS client that issued this command
          const targetWs = hermesPush._cmdIdToWs.get(msg.cmdId);
          if (targetWs && targetWs.readyState === 1) {
            targetWs.send(JSON.stringify({
              type: 'cmd_error',
              cmdId: msg.cmdId,
              error: String(rawError).slice(0, 200),
              errCode,
              sessionId: sessionId,
              ts: Date.now()
            }));
          }
          hermesPush._cmdIdToWs.delete(msg.cmdId);
          break;
        }

        default:
          log('warn', 'WS unknown message type', { reqId, sessionId, type: msg.type });
      }
    });

    _clearSendTimeout();  // H2: clear send timeout on close
    ws.on('close', () => {
      clearTimeout(authTimeout);
      for (const [sid, sws] of sessionSockets) {
        if (sws === ws) {
          sessionSockets.delete(sid);
          pageMirror.disconnectSession(sid);
          sessionMeta.delete(sid);       // Fix #13: clean up sessionMeta on disconnect
          sessionMetaInfo.delete(sid);   // Fix #13: clean up sessionMetaInfo on disconnect
          hermesPush._removeSession(sid);  // Fix #M2: notify Hermes clients of session eviction
          metricGauge('connectedSessions', sessionSockets.size);
          log('info', 'Extension WS session disconnected', { reqId, sessionId: sid });
          break;
        }
      }
    });

    ws.on('error', (err) => {
      clearTimeout(authTimeout);
      log('error', 'Extension WS error', { reqId, err: err.message });
    });
  });

  // Heartbeat — ws library handles ping/pong automatically via pingInterval
  // Both servers configured with pingInterval: 30000, pingTimeout: 10000 in constructor

  const heartbeat = setInterval(() => {
    metricGauge('uptimeSeconds', Math.floor(process.uptime()));
  }, 30000);

  // Prune old commands + idempotency cache + stale sessions
  // Fix #5: Session eviction now runs on a background interval, not just on getState()
  // Fix #10: Evict sessions that have been inactive for SESSION_TIMEOUT_MS
  const pruneInterval = setInterval(() => {
    cmdQueue.prune(60000);
    idempotencyCache.prune();
    metricGauge('pendingCommands', cmdQueue.size);

    // F26: Session eviction has TWO separate paths that work together:
    //
    // Path 1 — WebSocket close (ws.on('close') at ~line 1311):
    //   Triggered when the extension's browser tab closes or the WS is severed.
    //   Cleans up: sessionSockets, pageMirror, sessionMeta, sessionMetaInfo, hermesPush.
    //   This is the normal/tear-down path.
    //
    // Path 2 — Prune interval (below, runs every 30s):
    //   Triggered by inactivity timeout SESSION_TIMEOUT_MS or when the command history
    //   has orphaned entries (no extension WS AND no Hermes subscriber).
    //   Handles: unclean disconnects (Path 1 skipped), stale history, zombie sessions.
    //
    // Both paths call hermesPush._removeSession(sid) to notify Hermes clients.
    // This two-path strategy ensures no resource leaks even on hard browser kills.

    // Fix #10: Evict sessions that have been inactive past SESSION_TIMEOUT_MS
    const now = Date.now();
    for (const [sid, meta] of sessionMeta) {
      if (SESSION_TIMEOUT_MS > 0 && (now - meta.lastSeen) > SESSION_TIMEOUT_MS) {
        log('info', 'Evicting session due to inactivity timeout', { sessionId: sid, inactiveMs: now - meta.lastSeen });
        const ws = sessionSockets.get(sid);
        if (ws) {
          try { ws.close(1001, 'Session timed out'); } catch (_) {}
          sessionSockets.delete(sid);
          pageMirror.disconnectSession(sid);
        }
        hermesPush._removeSession(sid);  // Fix #22: notify Hermes clients of session eviction
        sessionMeta.delete(sid);
        sessionMetaInfo.delete(sid);  // Fix #13: clean up sessionMetaInfo on eviction
        metricGauge('connectedSessions', sessionSockets.size);
      }
    }
    // Fix #9: Evict command history for sessions that are fully gone
    // (not in sessionSockets AND no Hermes client is subscribed to them)
    for (const [sid] of _commandHistory) {
      const hasExt = sessionSockets.has(sid);
      const hasHermes = [...hermesPush._clients.values()].some(sids => sids.has(sid));
      if (!hasExt && !hasHermes) {
        _commandHistory.delete(sid);
      }
    }
    // Evict sessions that have been disconnected past SESSION_TTL_MS
    const before = pageMirror.connected;
    pageMirror.evictStaleSessions();
    const after = pageMirror.connected;
    if (before !== after) {
      metricGauge('connectedSessions', sessionSockets.size);
    }
  }, PRUNE_INTERVAL_MS);

  wss.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(pruneInterval);
  });

  // ── HTTP REST API ──────────────────────────────────────────────────────────

  httpServer.on('request', async (req, res) => {
    req.setTimeout(30000, () => {
      if (!res.headersSent) {
        res.writeHead(408, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request timeout' }));
      }
    });
    const reqId = randomUUID().slice(0, 8);
    req._hermesReqId = reqId;  // S7: attach to request for jsonResponse to read
    const serverPort = httpServer.address().port;
    const url = new URL(req.url, `http://localhost:${serverPort}`);
    const path = url.pathname;

    log('debug', `${req.method} ${path}`, { reqId });

    if (req.method === 'OPTIONS') {
      jsonResponse(res, 204, {});
      return;
    }

    // C3: Auth check for protected endpoints
    // Fix #6: GET /sessions and GET /sessions/:id expose all active tab URLs — require auth.
    // POST /command and POST /sessions also require auth (already non-GET).
    const protectedWritePaths = ['/command', '/sessions'];
    const needsWriteAuth = req.method !== 'GET' && protectedWritePaths.some(p => path.startsWith(p));
    const needsReadAuth = req.method === 'GET' && (path === '/sessions' || path.startsWith('/sessions/'));
    const needsAuth = needsWriteAuth || needsReadAuth;
    if (needsAuth) {
      const auth = validateHttpAuth(req);
      if (!auth.authorized) {
        log('warn', 'HTTP auth failed', { reqId, path, reason: auth.reason });
        jsonResponse(res, 401, { error: 'Unauthorized', reason: auth.reason });
        return;
      }
    }

    // ── GET /metrics/stream (S1) ───────────────────────────────────────────────
    // Server-Sent Events stream of live metrics — restricted to localhost
    if (req.method === 'GET' && path === '/metrics/stream') {
      const remoteIp = req.socket.remoteAddress || '';
      if (!remoteIp.includes('127.0.0.1') && !remoteIp.includes('::1') && !remoteIp.includes('localhost')) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden: /metrics/stream only available from localhost');
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });

      // Send initial metrics immediately
      metricGauge('uptimeSeconds', Math.floor(process.uptime()));
      metricGauge('pendingCommands', cmdQueue.size);
      // Fix #8: _buildMetrics was undefined — inline the metrics object directly.
      // Uses the same shape as the Prometheus formatter but as a JSON object for SSE.
      function _buildMetricsJson() {
        metricGauge('uptimeSeconds', Math.floor(process.uptime()));
        metricGauge('pendingCommands', cmdQueue.size);
        return {
          uptimeSeconds: metrics.gauges.uptimeSeconds || 0,
          connectedSessions: metrics.gauges.connectedSessions || 0,
          pendingCommands: metrics.gauges.pendingCommands || 0,
          hermesClients: metrics.gauges.hermesClients || 0,
          backpressureActive: metrics.gauges.backpressureActive === 1,
          wsConnections: metrics.counters.wsConnections || 0,
          wsMessages: metrics.counters.wsMessages || { rx: 0, tx: 0 },
          commands: metrics.counters.commands || {},
          idempotencyRejections: metrics.counters.idempotencyRejections || 0,
        };
      }

      res.write(`data: ${JSON.stringify(_buildMetricsJson())}\n\n`);

      // S1: Push updates every second
      const metricsInterval = setInterval(() => {
        if (res.writableEnded) { clearInterval(metricsInterval); return; }
        try {
          res.write(`data: ${JSON.stringify(_buildMetricsJson())}\n\n`);
        } catch (e) { clearInterval(metricsInterval); }
      }, 1000);

      // Fix #9: Decrement SSE stream counter when client disconnects
      req.on('close', () => {
        clearInterval(metricsInterval);
        metrics.counters.sseStreams = Math.max(0, (metrics.counters.sseStreams || 0) - 1);
      });
      metrics.counters.sseStreams++;
      return;
    }

    // ── GET /health ─────────────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/health') {
      const proto = tlsOptions ? 'wss' : 'ws';
      jsonResponse(res, 200, {
        status: 'ok',
        version: PROXY_VERSION,
        uptime: Math.floor(process.uptime()),
        connected: pageMirror.connected,
        pendingCommands: cmdQueue.size,
        wsClients: wss.clients.size,
        hermesClients: hermesPush.size,
        activeSessions: sessionSockets.size,
        backpressureActive: metrics.gauges.backpressureActive === 1,
        wsUrl: `${proto}://localhost:${serverPort}`,
        hermesWsUrl: `${proto}://localhost:${serverPort}/hermes`,
        // Fix #21: Expose connected extension metadata so Hermes can detect version mismatches
        // Fix #2: sessionMetaInfo keys are sessionIds — use .entries() to get both key and value
        extensions: [...sessionMetaInfo.entries()].map(([sessionId, m]) => ({
          sessionId,
          extension: m.extension,
          version: m.version,
          tabId: m.tabId,
          connectedAt: m.connectedAt
        }))
      });
      return;
    }

    // ── GET /metrics (Fix #P2-9) ────────────────────────────────────────────
    if (req.method === 'GET' && path === '/metrics') {
      metricGauge('uptimeSeconds', Math.floor(process.uptime()));
      metricGauge('pendingCommands', cmdQueue.size);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(formatPrometheus());
      return;
    }

    // ── GET /config (S1) ───────────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/config') {
      jsonResponse(res, 200, {
        version: PROXY_VERSION,
        authEnabled: !!process.env.HBS_AUTH_TOKEN,
        port: serverPort,
        sessionTtlMs: cfg.SESSION_TTL_MS,
        commandTimeoutMs: cfg.CMD_TIMEOUT_MS,
        rateLimitRps: cfg.RATE_LIMIT_RPS,
        rateLimitBurst: cfg.RATE_LIMIT_BURST,
        backpressureThresholdMs: BACKPRESSURE_THRESHOLD_MS,
        pruneIntervalMs: PRUNE_INTERVAL_MS,
      });
      return;
    }

    // ── GET /sessions (Fix #P1-3, M6) ───────────────────────────────────────
    if (req.method === 'GET' && path === '/sessions') {
      // M6: Call getState() once per session instead of 4x per session (was O(4N²))
      const sessions = Array.from(sessionSockets.entries()).map(([sid, ws]) => {
        const state = pageMirror.getState(sid);
        return {
          sessionId: sid,
          connected: ws.readyState === 1,
          url: state.url || '',
          title: state.title || '',
          lastUpdate: state.lastUpdate || 0,
        };
      });
      jsonResponse(res, 200, { sessions, total: sessions.length });
      return;
    }

    // ── GET /sessions/:id (Fix #16) ─────────────────────────────────────────────
    const sessionMatch = path.match(/^\/sessions\/([^\/]+)$/);
    if (req.method === 'GET' && sessionMatch) {
      const sid = sessionMatch[1];
      const ws = sessionSockets.get(sid);
      if (!ws) {
        jsonResponse(res, 404, { error: `Session '${sid}' not found` });
        return;
      }
      const state = pageMirror.getState(sid);
      const meta = sessionMetaInfo.get(sid) || {};
      // F17: Include Hermes subscriber count and command queue depth for structured inspection
      const hermesClientCount = [...hermesPush._clients.values()].filter(sids => sids.has(sid)).length;
      const cmdQueueDepth = cmdQueue.size;
      jsonResponse(res, 200, {
        sessionId: sid,
        connected: ws.readyState === 1,
        url: state.url || '',
        title: state.title || '',
        lastUpdate: state.lastUpdate || 0,
        mutationsPending: state.mutations ? state.mutations.length : 0,
        hermesSubscribers: hermesClientCount,   // F17: how many Hermes clients watching this session
        commandQueueDepth: cmdQueueDepth,        // F17: total server-side pending commands
        extensionVersion: meta.version || null,
        tabId: meta.tabId || null,
        userAgent: meta.userAgent || null,
        connectedAt: meta.connectedAt || null,
      });
      return;
    }

    // ── POST /sessions/:id/activate (Fix #P1-3) ──────────────────────────────
    const activateMatch = path.match(/^\/sessions\/([^/]+)\/activate$/);
    if (req.method === 'POST' && activateMatch) {
      const targetSessionId = activateMatch[1];
      if (!sessionSockets.has(targetSessionId)) {
        jsonResponse(res, 404, { error: `Session '${targetSessionId}' not found or disconnected` });
        return;
      }
      // Notify all Hermes clients to switch to this session
      hermesPush.pushToSession(targetSessionId, {
        type: 'session_activated',
        sessionId: targetSessionId,
        url: pageMirror.getState(targetSessionId).url
      });
      jsonResponse(res, 200, { success: true, sessionId: targetSessionId, message: 'Session activated' });
      return;
    }

    // ── DELETE /sessions/:id (F18) ───────────────────────────────────────────
    // Clear page state and command history for a session without closing the WebSocket.
    // Useful for resetting a stuck session without disrupting the extension connection.
    const sessionDeleteMatch = path.match(/^\/sessions\/([^\/]+)$/);
    if (req.method === 'DELETE' && sessionDeleteMatch) {
      const sid = sessionDeleteMatch[1];
      pageMirror.disconnectSession(sid);
      _commandHistory.delete(sid);
      jsonResponse(res, 200, { success: true, sessionId: sid, message: 'Session state cleared' });
      return;
    }

    // ── GET /commands/history (S3) ─────────────────────────────────────────────
    const historyMatch = path.match(/^\/commands\/history(?:\/([^/]+))?$/);
    if (req.method === 'GET' && historyMatch) {
      const sessionId = historyMatch[1];  // optional — if omitted return all sessions
      let result;
      if (sessionId) {
        result = { sessionId, history: _getHistory(sessionId) };
      } else {
        // Return history for all sessions that have commands
        result = {};
        for (const [sid, hist] of _commandHistory.entries()) {
          result[sid] = hist;
        }
      }
      jsonResponse(res, 200, result);
      return;
    }

    // ── GET /page_state ─────────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/page_state') {
      const sessionId = url.searchParams.get('sessionId');
      const lastSeq = parseInt(url.searchParams.get('lastSeq') || '0', 10);

      if (lastSeq > 0) {
        pageMirror.ackSessionSeq(sessionId, lastSeq);
      }

      const state = pageMirror.getState(sessionId, lastSeq);

      // P0-2 Fix: if requested sessionId doesn't exist, return explicit mismatch flag
      if (sessionId !== 'default' && !sessionSockets.has(sessionId)) {
        state._sessionMismatch = true;
        state._requestedSession = sessionId;
        state._activeSession = Array.from(sessionSockets.keys())[0] || null;
      }

      if (!pageMirror.connected) {
        jsonResponse(res, 200, {
          connected: false,
          message: 'No extension connected. Click "Activate Tab" in the browser extension popup.'
        });
        return;
      }
      log('debug', 'GET /page_state', { reqId, sessionId, seq: state.seq, mutations: state.mutations.length });
      jsonResponse(res, 200, state);
      return;
    }

    // ── POST /command ───────────────────────────────────────────────────────
    if (req.method === 'POST' && path === '/command') {
      const sessionId = url.searchParams.get('sessionId');

      const meta = getSessionMeta(sessionId);
      if (!meta.limiter.tryConsume()) {
        jsonResponse(res, 429, {
          error: 'Rate limit exceeded.',
          retryAfterMs: 1000,
          rateLimitRemaining: 0
        });
        return;
      }

      let body;
      try { body = await parseBody(req); }
      catch (e) {
        log('warn', 'POST /command parse error', { reqId, sessionId, err: e.message });
        jsonResponse(res, 400, { error: e.message });
        return;
      }

      const { type, selector, url: destUrl, x, y, text, script, idempotencyKey } = body;
      if (!type) {
        jsonResponse(res, 400, { error: 'Missing required field: type' });
        return;
      }

      const validTypes = ['navigate', 'click', 'scroll', 'type', 'submit', 'evaluate'];
      if (!validTypes.includes(type)) {
        jsonResponse(res, 400, { error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
        return;
      }

      // Fix #12: Validate selector to prevent querySelector crashes in the content script.
      // Only types that pass a selector to document.querySelector need validation.
      const selectorTypes = ['click', 'type', 'submit'];
      if (selectorTypes.includes(type)) {
        if (!selector || typeof selector !== 'string' || selector.trim() === '') {
          jsonResponse(res, 400, { error: `Missing or invalid 'selector' field for '${type}' command` });
          return;
        }
        // Reject selectors that would be dangerous in querySelector (e.g. closing tags)
        if (/<\//.test(selector)) {
          jsonResponse(res, 400, { error: `Invalid selector: cannot contain HTML tag syntax` });
          return;
        }
      }

      // Fix #14: Validate script field for evaluate commands
      if (type === 'evaluate') {
        if (!script || typeof script !== 'string') {
          jsonResponse(res, 400, { error: `Missing or invalid 'script' field for 'evaluate' command` });
          return;
        }
      }

      if (!pageMirror.connected) {
        jsonResponse(res, 503, { error: 'Extension not connected. Activate the tab first.' });
        return;
      }

      // P3-13 Fix: idempotency uses SHA-256 hash of full command body
      if (idempotencyKey) {
        const existing = idempotencyCache.check(sessionId, idempotencyKey, body);
        if (existing.duplicate) {
          metrics.counters.idempotencyRejections++;
          // Fix #11: Removed dead metricIncr('idempotencyRejections') call —
          // metricIncr() with no tags creates metrics.counters.idempotencyRejections['']
          // instead of incrementing the counter itself. Direct ++ above is correct.
          log('info', 'Duplicate command rejected (idempotency)', { reqId, sessionId, idempotencyKey, existingCmdId: existing.existingCmdId });
          jsonResponse(res, 200, {
            cmdId: existing.existingCmdId,
            status: 'duplicate',
            message: 'Command already sent with this idempotency key'
          });
          return;
        }
      }

      const cmdId = randomUUID();
      const cmd = { type, cmdId, selector, url: destUrl, x, y, text, script, sessionId };
      const submittedAt = Date.now();

      if (idempotencyKey) {
        idempotencyCache.record(sessionId, idempotencyKey, cmdId, body);
      }

      cmdQueue.add(cmdId, cmd, submittedAt);  // S4: promise is handled internally by ack/error callbacks — no .then() needed
      sendToExtension(sessionId, cmd);
      log('info', `CMD → extension`, { reqId, cmdId, sessionId, type, selector: selector || null });
      metricIncr('commands', { type, status: 'pending' });
      metrics.counters.commands.total++;

      jsonResponse(res, 202, {
        cmdId,
        status: 'pending',
        message: 'Command queued. Poll GET /command/:cmdId',
        rateLimitRemaining: meta.limiter.available,
        sessionId
      });
      return;
    }

    // ── GET /command/:cmdId ─────────────────────────────────────────────────
    const cmdMatch = path.match(/^\/command\/([^/]+)$/);
    if (req.method === 'GET' && cmdMatch) {
      const cmdId = cmdMatch[1];
      const result = cmdQueue.get(cmdId);
      if (result.status === 'unknown') {
        jsonResponse(res, 404, { error: `Command ${cmdId} not found` });
        return;
      }
      jsonResponse(res, 200, { cmdId, ...result });
      return;
    }

    // ── DELETE /command/:cmdId (Fix #P3-17: Command cancellation) ─────────────
    if (req.method === 'DELETE' && cmdMatch) {
      const cmdId = cmdMatch[1];
      const result = cmdQueue.get(cmdId);
      if (result.status === 'unknown') {
        jsonResponse(res, 404, { error: `Command ${cmdId} not found` });
        return;
      }
      if (result.status !== 'pending') {
        jsonResponse(res, 409, { error: `Command ${cmdId} is already ${result.status}` });
        return;
      }
      // Remove from queue — mark as cancelled
      cmdQueue.cancel(cmdId);
      // Notify extension to ignore this cmdId if it arrives
      const sessionId = result.cmd?.sessionId || 'default';
      sendToExtension(sessionId, { type: 'cancel', cmdId });
      log('info', `CMD cancelled`, { reqId, cmdId });
      jsonResponse(res, 200, { cmdId, status: 'cancelled' });
      return;
    }

    // ── GET /last_seq ───────────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/last_seq') {
      const sessionId = url.searchParams.get('sessionId') || 'default';
      jsonResponse(res, 200, { sessionId, lastSeq: pageMirror.getLastSeq(sessionId) });
      return;
    }

    // ── GET /dashboard ─────────────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/dashboard') {
      // Fix #5: Require HTTP auth — dashboard exposes all session URLs and command history
      const auth = validateHttpAuth(req);
      if (!auth.authorized) {
        jsonResponse(res, 401, { error: 'Unauthorized', reason: auth.reason });
        return;
      }

      // Fix #4: HTML-escape all user-controlled fields to prevent XSS
      const _e = (s) => String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

      const sessions = Array.from(sessionSockets.entries()).map(([sid, ws]) => {
        const state = pageMirror.getState(sid);
        const cmdHistory = _getHistory(sid).slice(0, 5);
        return {
          sessionId: _e(sid),
          connected: ws.readyState === 1,
          url: _e(state.url || ''),
          title: _e(state.title || ''),
          lastUpdate: state.lastUpdate || 0,
          recentCommands: cmdHistory.map(c => ({
            ...c,
            result: _e(c.result || ''),
            error: _e(c.error || '')
          }))
        };
      });
      const activeSessionIds = Array.from(sessionSockets.keys());
      const dashHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Hermes Browser Bridge — Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #c9d1d9; min-height: 100vh; padding: 24px; }
  h1 { color: #89b4fa; font-size: 20px; margin-bottom: 4px; }
  .subtitle { color: #6e7681; font-size: 13px; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
  .card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; }
  .status-dot.connected { background: #3fb950; }
  .status-dot.disconnected { background: #6e7681; }
  .card-title { font-size: 13px; font-weight: 600; color: #e6edf3; }
  .card-url { font-size: 11px; color: #8b949e; word-break: break-all; margin-bottom: 8px; }
  .card-title2 { font-size: 12px; color: #8b949e; margin-bottom: 6px; }
  .cmd-list { list-style: none; }
  .cmd-list li { font-size: 11px; padding: 3px 0; color: #8b949e; }
  .cmd-list li.success { color: #3fb950; }
  .cmd-list li.error { color: #f85149; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .stat { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; text-align: center; }
  .stat-val { font-size: 28px; font-weight: 700; color: #89b4fa; }
  .stat-label { font-size: 11px; color: #6e7681; margin-top: 4px; }
  .no-sessions { color: #6e7681; font-size: 13px; }
  .refresh { font-size: 11px; color: #6e7681; margin-top: 16px; }
</style>
</head>
<body>
<h1>Hermes Browser Bridge</h1>
<p class="subtitle">Proxy v${PROXY_VERSION} — <span id="uptime">—</span></p>

<div class="stats">
  <div class="stat"><div class="stat-val" id="stat-sessions">${sessions.length}</div><div class="stat-label">Sessions</div></div>
  <div class="stat"><div class="stat-val" id="stat-pending">${cmdQueue.size}</div><div class="stat-label">Pending</div></div>
  <div class="stat"><div class="stat-val" id="stat-hermes">${hermesPush.size}</div><div class="stat-label">Hermes Clients</div></div>
  <div class="stat"><div class="stat-val" id="stat-bp">${metrics.gauges.backpressureActive === 1 ? '⏸' : '✅'}</div><div class="stat-label">Flow</div></div>
</div>

<h2 style="font-size:14px;color:#8b949e;margin-bottom:12px;">Active Sessions</h2>
${sessions.length === 0 ? '<p class="no-sessions">No active sessions. Activate the extension in your browser.</p>' : ''}
<div class="grid">
${sessions.map(s => `
  <div class="card">
    <div class="card-header">
      <span class="status-dot ${s.connected ? 'connected' : 'disconnected'}"></span>
      <span class="card-title" title="${s.sessionId}">${s.sessionId}</span>
    </div>
    <div class="card-url">${s.url || '—'}</div>
    ${s.recentCommands.length > 0 ? `
    <div class="card-title2">Recent Commands</div>
    <ul class="cmd-list">
      ${s.recentCommands.map(c => `<li class="${c.status}">[${c.status}] ${c.type} — ${c.result || c.error || ''}</li>`).join('')}
    </ul>` : ''}
  </div>`).join('')}
</div>
<p class="refresh">Auto-refreshes every 5s</p>
<script>
let startTime = Date.now();
function refresh() {
  fetch('/health')
    .then(r => r.json())
    .then(d => {
      document.getElementById('stat-sessions').textContent = d.activeSessions;
      document.getElementById('stat-pending').textContent = d.pendingCommands;
      document.getElementById('stat-hermes').textContent = d.hermesClients;
      document.getElementById('stat-bp').textContent = d.backpressureActive ? '⏸' : '✅';
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      document.getElementById('uptime').textContent = \`up \${elapsed}s\`;
    });
}
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
      // Fix #10: Add Content-Security-Policy header to prevent XSS in dashboard
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
      });
      res.end(dashHtml);
      return;
    }

    jsonResponse(res, 404, {
      error: 'Not found',
      available: ['GET /health', 'GET /metrics', 'GET /sessions', 'POST /sessions/:id/activate', 'GET /page_state', 'POST /command', 'GET /command/:cmdId', 'DELETE /command/:cmdId', 'GET /last_seq', 'GET /dashboard']
    });
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────────

  // M7: Graceful shutdown with force-kill guard — don't hang indefinitely
  // Give sockets 5s to close gracefully, then force-exit
  function shutdown() {
    log('info', 'Shutdown signal received');
    clearInterval(heartbeat);
    clearInterval(pruneInterval);
    pageMirror.stopEvictionTimer();  // Fix #21: stop eviction interval on shutdown

    // Fix #11: Close all extension WebSocket connections gracefully with code 1001 (going away)
    // This gives extensions a chance to handle the close event rather than treating it as a crash.
    for (const ws of wss.clients) {
      try { ws.close(1001, 'Proxy shutting down'); } catch (_) {}
    }
    for (const ws of wssHermes.clients) {
      try { ws.close(1001, 'Proxy shutting down'); } catch (_) {}
    }

    wss.close();
    wssHermes.close();
    httpServer.close();

    // M7: Force-kill after 5s to prevent indefinite hang
    setTimeout(() => {
      log('warn', 'Shutdown timeout — forcing process exit');
      process.exit(1);
    }, 5000);
  }

  return { httpServer, wss, pageMirror, cmdQueue, shutdown, hermesPush };
}

// F25: Export hermesPush internals for testing — allows test scripts to inject fake
// Hermes clients and verify session routing without a real Hermes agent connection.
// Usage in tests: const { hermesPush } = require('./proxy_lib'); hermesPush._addSession(sid, fakeWs);
module.exports = {
  /** @type {typeof createProxy} */
  createProxy,
  /** @type {typeof RateLimiter} */
  RateLimiter,
  /** @type {hermesPush} Internal push client for Hermes agent subscriptions (F25) */
  hermesPush,
};
