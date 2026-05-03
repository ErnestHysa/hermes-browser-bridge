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
 */

'use strict';

const { WebSocketServer } = require('ws');
const { createHash } = require('crypto');
const { randomUUID } = require('node:crypto');

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
const BACKPRESSURE_THRESHOLD_MS = cfg.BACKPRESSURE_THRESHOLD_MS; // P2-8: from config.js

// ─── Structured Logging ────────────────────────────────────────────────────────

/**
 * JSON log entries to stdout for production debuggability.
 * @param {string} level
 * @param {string} msg
 * @param {object} extras
 */
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LOG_LEVEL = LOG_LEVELS[cfg.LOG_LEVEL] ?? LOG_LEVELS.info;

function log(level, msg, extras = {}) {
  if (LOG_LEVELS[level] === undefined || LOG_LEVELS[level] < CURRENT_LOG_LEVEL) return;
  const entry = {
    t: new Date().toISOString(),
    level,
    msg,
    pid: process.pid,
    ...extras
  };
  console.log(JSON.stringify(entry));
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

function metricGauge(name, value) {
  if (metrics.gauges[name] !== undefined) metrics.gauges[name] = value;
}

function metricHistogramPush(histName, value, labels = {}) {
  const type = labels.type || 'unknown';
  if (!metrics.histograms[histName][type]) {
    metrics.histograms[histName][type] = [];
  }
  metrics.histograms[histName][type].push({ value, labels, ts: Date.now() });
  // Keep last 1000 entries per type
  if (metrics.histograms[histName][type].length > 1000) {
    metrics.histograms[histName][type].shift();
  }
}

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
    const leLabels = [...durationBuckets.map(b => `${b}`), '+Inf'].map(b => `le="${b}"`).join(',');
    for (let i = 0; i <= durationBuckets.length; i++) {
      emit(`hbs_command_duration_seconds_bucket{type="${cmdType}",${leLabels.split(',')[i]} ${bucketCounts[i]}`);
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
    emit(`hbs_html_bytes ${latest.value} ${latest.ts}`);
  }

  if (metrics.histograms.mutationBufferSize.length > 0) {
    emit('# HELP hbs_mutation_buffer_size Number of mutations in buffer');
    emit('# TYPE hbs_mutation_buffer_size gauge');
    // Emit only the most recent entry as the current value
    const latest = metrics.histograms.mutationBufferSize[metrics.histograms.mutationBufferSize.length - 1];
    emit(`hbs_mutation_buffer_size ${latest.value} ${latest.ts}`);
  }

  return lines.join('\n');
}

// ─── Idempotency Cache (Fix #P3-13 — SHA-256 hash of full command) ─────────────

class IdempotencyCache {
  constructor() {
    /** @type {Map<string, { cmdId: string, timestamp: number }>} */
    this._cache = new Map();
  }

  /**
   * Fix #P3-13: Use SHA-256 of full command JSON for idempotency key.
   * Much stronger than the previous string-concat approach which could collide.
   */
  _hash(cmd) {
    return createHash('sha256').update(JSON.stringify(cmd)).digest('hex').slice(0, 32);
  }

  _key(sessionId, idempotencyKey) {
    return `${sessionId}:${idempotencyKey}`;
  }

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

  record(sessionId, idempotencyKey, cmdId, cmd) {
    if (!idempotencyKey) return;
    const k = this._key(sessionId, idempotencyKey);
    this._cache.set(k, { cmdId, timestamp: Date.now() });
  }

  prune() {
    const cutoff = Date.now() - IDEMPOTENCY_WINDOW_MS;
    for (const [k, v] of this._cache) {
      if (v.timestamp < cutoff) this._cache.delete(k);
    }
  }
}

// ─── Rate Limiter ─────────────────────────────────────────────────────────────

class RateLimiter {
  constructor(maxTokens = RATE_LIMIT_RPS, windowMs = 1000) {  // P3-14: default from config
    this.maxTokens = maxTokens;
    this.windowMs = windowMs;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  tryConsume() {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  _refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed >= this.windowMs) {
      this.tokens = this.maxTokens;
      this.lastRefill = now;
    }
  }

  get available() {
    this._refill();
    return Math.floor(this.tokens);
  }
}

// ─── Backpressure Manager (Fix #P2-8) ─────────────────────────────────────────

/**
 * Fix #18: Per-session backpressure tracking.
 * Each extension session has its own backpressure state — a slow session
 * doesn't pause other sessions.
 */
class BackpressureManager {
  constructor() {
    /** @type {Map<string, {paused: boolean, ws: import('ws').WebSocket}>} */
    this._sessions = new Map();
  }

  markWriting(sessionId, ws) {
    // Only signal if this specific session isn't already paused
    const entry = this._sessions.get(sessionId);
    if (!entry || !entry.paused) {
      this._sessions.set(sessionId, { paused: true, ws });
      metricGauge('backpressureActive', 1);
      this._sendSignal(ws, true);
    }
  }

  markDone(sessionId, ws) {
    const entry = this._sessions.get(sessionId);
    if (entry && entry.paused) {
      entry.paused = false;
      this._sendSignal(ws, false);
      // Check if any session is still paused
      const anyPaused = Array.from(this._sessions.values()).some(e => e.paused);
      if (!anyPaused) {
        metricGauge('backpressureActive', 0);
      }
    }
  }

  isPaused(sessionId) {
    const entry = this._sessions.get(sessionId);
    return entry ? entry.paused : false;
  }

  /** Remove a session from backpressure tracking on disconnect */
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
 * Hermes clients connect to ws://localhost:9321/hermes.
 * Each client sends a {type: "subscribe", sessionId: "..."} message.
 * The proxy then pushes only that session's updates to that client.
 *
 * Hermes can also send commands over this socket (P0-1).
 */
class HermesPushManager {
  constructor() {
    /** @type {Map<import('ws').WebSocket, {sessionId: string, reqId: string}>} */
    this._clients = new Map();
    /** @type {Map<string, Set<import('ws').WebSocket>>} sessionId → set of subscribed clients */
    this._sessionSubscriptions = new Map();
  }

  subscribe(ws, sessionId, reqId) {
    // Unsubscribe from previous session if any
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
   * Push a page state update to all Hermes clients subscribed to this session.
   * Called by the proxy whenever pageMirror updates.
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
   */
  forwardCommand(sessionId, command) {
    return sendToExtension(sessionId, command);
  }

  get size() { return this._clients.size; }
}

// ─── Shared Proxy Factory ─────────────────────────────────────────────────────

function createProxy({ httpServer, tlsOptions, version }) {
  const PROXY_VERSION = version || '1.0.0';
  const pageMirror = new PageMirror({ maxHtmlBytes: MAX_HTML_BYTES, sessionTtlMs: cfg.SESSION_TTL_MS });
  // Fix #5: Start background eviction so disconnected sessions don't accumulate
  pageMirror.startEvictionTimer();
  const cmdQueue = new CommandQueue(cfg.CMD_TIMEOUT_MS);  // P3-14: configurable timeout
  const idempotencyCache = new IdempotencyCache();
  const backpressure = new BackpressureManager();
  const hermesPush = new HermesPushManager();

  /** @type {Map<string, RateLimiter>} */
  const rateLimiters = new Map();
  const sessionMeta = new Map(); // sessionId → { limiter, lastSeen }

  function getSessionMeta(sessionId) {
    if (!sessionMeta.has(sessionId)) {
      sessionMeta.set(sessionId, {
        limiter: new RateLimiter(RATE_LIMIT_RPS, 1000),  // P3-14: from config
        lastSeen: Date.now()
      });
    }
    const meta = sessionMeta.get(sessionId);
    meta.lastSeen = Date.now();
    return meta;
  }

  /** @type {Map<string, import('ws').WebSocket>} */
  const sessionSockets = new Map();

  // ── Utility ────────────────────────────────────────────────────────────────

  function jsonResponse(res, statusCode, data, extraHeaders = {}) {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'http://localhost:*',  // P3-16: tightened to localhost
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      ...extraHeaders
    });
    res.end(JSON.stringify(data));
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
   */
  function sendToExtension(sessionId, msg, options = {}) {
    const ws = sessionSockets.get(sessionId);
    if (!ws || ws.readyState !== 1) return false;
    const data = JSON.stringify(msg);
    const estimatedMs = data.length / 10000; // ~10KB/ms throughput guess
    if (estimatedMs > BACKPRESSURE_THRESHOLD_MS) {
      backpressure.markWriting(sessionId, ws);
    }
    try {
      ws.send(data, () => {
        backpressure.markDone(sessionId, ws);
      });
    } catch (e) {
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

  const wssOptions = { server: httpServer };
  wssOptions.permessageDeflate = {
    serverNoContextTakeover: true,
    serverMaxWindowBits: 15,
    clientNoContextTakeover: true,
    clientMaxWindowBits: 15,
    concurrencyLimit: 10
  };
  const wss = new WebSocketServer(wssOptions);

  // ── WebSocket Server (Hermes push client — Fix #P0-1) ───────────────────────
  const wssHermes = new WebSocketServer({ noServer: true });

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

      // P0-1: Unsubscribe
      if (msg.type === 'unsubscribe') {
        hermesPush.unsubscribe(ws);
        ws.send(JSON.stringify({ type: 'unsubscribed' }));
        return;
      }

      // P0-1: Command over WS — forward to extension session
      if (msg.type === 'command') {
        const sessionId = msg.sessionId;
        const cmd = {
          type: msg.commandType,   // 'click', 'navigate', etc.
          cmdId: msg.cmdId || randomUUID(),
          selector: msg.selector,
          url: msg.url,
          x: msg.x,
          y: msg.y,
          text: msg.text,
          script: msg.script,
        };
        hermesPush.forwardCommand(sessionId, cmd);
        log('info', `Hermes CMD → extension`, { reqId, sessionId, type: cmd.type });
        ws.send(JSON.stringify({ type: 'command_queued', cmdId: cmd.cmdId, sessionId }));
        return;
      }

      // P0-1: Ping/pong keepalive
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      }
    });

    ws.on('close', () => {
      hermesPush.unsubscribe(ws);
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

    // P3-15: Improved origin validation — 'null' is Safari's file:// context
    const origin = req.headers['origin'];
    const validOrigins = [
      'null',                          // Safari file:// context
      'http://localhost',
      'http://localhost:9321',
      'http://127.0.0.1',
      'http://127.0.0.1:9321',
    ];
    if (origin && !validOrigins.includes(origin)) {
      log('warn', 'WS connection rejected — unauthorized origin', { reqId, origin, remoteIp });
      ws.close(1008, 'Unauthorized origin');
      return;
    }

    log('info', 'Extension WS connected', { reqId, origin: origin || 'null', remoteIp });
    metricIncr('wsConnections');

    // isAlive tracking now handled by ws library's ping/pong protocol

    ws.on('message', (raw) => {
      metrics.counters.wsMessages.rx++;
      let msg;
      try { msg = JSON.parse(raw); }
      catch (e) {
        log('warn', 'WS invalid JSON', { reqId, raw: String(raw).slice(0, 100) });
        return;
      }

      // Fix #12: Warn when falling back to 'default' sessionId — masks config errors
      const sessionId = msg.sessionId || _warnDefault('sessionId', msg.sessionId);
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
          pageMirror.addMutations(sessionId, msg);
          break;

        case 'heartbeat':
          sessionSockets.set(sessionId, ws);
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
            }
            metricIncr('commands', { status: 'success' });
          }
          break;
        }

        case 'cmd_error': {
          const before = cmdQueue.size;
          cmdQueue.error(msg.cmdId, msg.error || 'Unknown error');
          if (cmdQueue.size === before && cmdQueue.get(msg.cmdId)?.status !== 'error') {
            log('warn', 'cmd_error for unknown cmdId', { reqId, sessionId, cmdId: msg.cmdId, error: msg.error });
          } else {
            const cmdEntry = cmdQueue.get(msg.cmdId);
            if (cmdEntry?.cmd) {
              metricIncr('commands', { type: cmdEntry.cmd.type, status: 'error' });
            }
            metricIncr('commands', { status: 'error' });
          }
          break;
        }

        default:
          log('warn', 'WS unknown message type', { reqId, sessionId, type: msg.type });
      }
    });

    ws.on('close', () => {
      for (const [sid, sws] of sessionSockets) {
        if (sws === ws) {
          sessionSockets.delete(sid);
          pageMirror.disconnectSession(sid);
          sessionMeta.delete(sid);
          metricGauge('connectedSessions', sessionSockets.size);
          log('info', 'Extension WS session disconnected', { reqId, sessionId: sid });
          break;
        }
      }
    });

    ws.on('error', (err) => {
      log('error', 'Extension WS error', { reqId, err: err.message });
    });

    ws.send(JSON.stringify({ type: 'connected', message: 'Proxy ready' }));
  });

  // Heartbeat — use ws library's built-in ping/pong (Fix #28)
  // ws handles protocol-level pings automatically when pingInterval is set
  wss.options = { ...wss.options, pingInterval: 30000, pingTimeout: 10000 };
  wssHermes.options = { ...wssHermes.options, pingInterval: 30000, pingTimeout: 10000 };

  const heartbeat = setInterval(() => {
    metricGauge('uptimeSeconds', Math.floor(process.uptime()));
  }, 30000);

  // Prune old commands + idempotency cache + stale sessions
  // Fix #5: Session eviction now runs on a background interval, not just on getState()
  const pruneInterval = setInterval(() => {
    cmdQueue.prune(60000);
    idempotencyCache.prune();
    metricGauge('pendingCommands', cmdQueue.size);
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
    const serverPort = httpServer.address().port;
    const url = new URL(req.url, `http://localhost:${serverPort}`);
    const path = url.pathname;

    log('debug', `${req.method} ${path}`, { reqId });

    if (req.method === 'OPTIONS') {
      jsonResponse(res, 204, {});
      return;
    }

    // ── GET /health ─────────────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/health') {
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

    // ── GET /sessions (Fix #P1-3) ───────────────────────────────────────────
    if (req.method === 'GET' && path === '/sessions') {
      const sessions = Array.from(sessionSockets.entries()).map(([sid, ws]) => ({
        sessionId: sid,
        connected: ws.readyState === 1,
        url: pageMirror.getState(sid).url || '',
        title: pageMirror.getState(sid).title || '',
        lastUpdate: pageMirror.getState(sid).lastUpdate || 0,
      }));
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
      jsonResponse(res, 200, {
        sessionId: sid,
        connected: ws.readyState === 1,
        url: state.url || '',
        title: state.title || '',
        lastUpdate: state.lastUpdate || 0,
        mutationsPending: state.mutations ? state.mutations.length : 0,
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

      if (!pageMirror.connected) {
        jsonResponse(res, 503, { error: 'Extension not connected. Activate the tab first.' });
        return;
      }

      // P3-13 Fix: idempotency uses SHA-256 hash of full command body
      if (idempotencyKey) {
        const existing = idempotencyCache.check(sessionId, idempotencyKey, body);
        if (existing.duplicate) {
          metrics.counters.idempotencyRejections++;
          metricIncr('idempotencyRejections');
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

      cmdQueue.add(cmdId, cmd, submittedAt).then((result) => {
        log('info', `CMD resolved`, { reqId, cmdId, sessionId, type, success: result.success });
      }).catch((err) => {
        log('warn', `CMD caught`, { reqId, cmdId, sessionId, err: err.message });
      });

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

    jsonResponse(res, 404, {
      error: 'Not found',
      available: ['GET /health', 'GET /metrics', 'GET /sessions', 'POST /sessions/:id/activate', 'GET /page_state', 'POST /command', 'GET /command/:cmdId', 'DELETE /command/:cmdId', 'GET /last_seq']
    });
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────────

  function shutdown() {
    log('info', 'Shutdown signal received');
    clearInterval(heartbeat);
    clearInterval(pruneInterval);

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
  }

  return { httpServer, wss, pageMirror, cmdQueue, shutdown, hermesPush };
}

module.exports = { createProxy, RateLimiter };
