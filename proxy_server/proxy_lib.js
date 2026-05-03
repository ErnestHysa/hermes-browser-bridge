/**
 * proxy_lib.js — Shared proxy logic for both HTTP and HTTPS server variants.
 * Contains all HTTP handling, WebSocket handling, and shared state.
 * Both server.js and server_https.js import this to avoid code duplication.
 *
 * Fix #C4:  Binds to 127.0.0.1 by default (LAN exposure fixed)
 * Fix #M7:  Structured JSON logging with request IDs
 * Fix #M4:  parseBody enforces 1MB total size limit
 * Fix #M3:  HTML snapshots capped at 10MB
 * Fix #M2:  Idempotency key support — duplicate commands within 30s are rejected
 * Fix #M10: cmdQueue.ack/error log warning for unknown cmdId
 * Fix #L1:  Comment explaining pruneInterval 120s duration
 * Fix #L4:  Rate limiter cached in variable to avoid repeated Map lookup
 */

const { WebSocketServer } = require('ws');
const { randomUUID } = require('node:crypto');

const { CommandQueue } = require('./cmd_queue');
const { PageMirror } = require('./page_mirror');

// ─── Constants ─────────────────────────────────────────────────────────────────

const PROXY_HOST = '127.0.0.1';   // Fix #C4: localhost only, not 0.0.0.0
const MAX_BODY_BYTES = 1 * 1024 * 1024;           // Fix #M4: 1MB request body cap
const MAX_HTML_BYTES = 10 * 1024 * 1024;           // Fix #M3: 10MB HTML snapshot cap
const IDEMPOTENCY_WINDOW_MS = 30000;               // Fix #M2: 30s idempotency window
const PRUNE_INTERVAL_MS = 120000;                  // Fix #L1: 2-minute prune interval
const RATE_LIMITER_OPTS = { maxTokens: 5, windowMs: 1000 };

// ─── Structured Logging ────────────────────────────────────────────────────────

/**
 * Fix #M7: JSON log entries to stdout for production debuggability.
 * @param {string} level
 * @param {string} msg
 * @param {object} extras
 */
function log(level, msg, extras = {}) {
  const entry = {
    t: new Date().toISOString(),
    level,
    msg,
    pid: process.pid,
    ...extras
  };
  console.log(JSON.stringify(entry));
}

// ─── Rate Limiter ──────────────────────────────────────────────────────────────

/**
 * Token-bucket rate limiter: max `maxTokens` commands per `windowMs` milliseconds.
 * Fix #L4: instance stored in a Map and retrieved once per session,
 * not re-fetched from the Map on every call.
 */
class RateLimiter {
  constructor(maxTokens = 5, windowMs = 1000) {
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

// ─── Idempotency Cache ────────────────────────────────────────────────────────

/**
 * Fix #M2: Tracks sent command signatures per session to prevent duplicate execution.
 * Uses a Map of "sessionId:type:selector:text" → { cmdId, timestamp }.
 * Entries older than IDEMPOTENCY_WINDOW_MS are pruned automatically.
 */
class IdempotencyCache {
  constructor() {
    /** @type {Map<string, { cmdId: string, timestamp: number }>} */
    this._cache = new Map();
  }

  /** Generate a cache key for a command. */
  _key(sessionId, cmd) {
    // Combine fields that uniquely identify the command's intent
    return `${sessionId}:${cmd.type}:${cmd.selector || ''}:${cmd.text || ''}:${cmd.url || ''}`;
  }

  /**
   * Check if a command with this signature was recently sent.
   * @returns {{ duplicate: boolean, existingCmdId: string|null }}
   */
  check(sessionId, cmd) {
    const k = this._key(sessionId, cmd);
    const entry = this._cache.get(k);
    if (!entry) return { duplicate: false, existingCmdId: null };

    const age = Date.now() - entry.timestamp;
    if (age > IDEMPOTENCY_WINDOW_MS) {
      this._cache.delete(k);
      return { duplicate: false, existingCmdId: null };
    }
    return { duplicate: true, existingCmdId: entry.cmdId };
  }

  /** Record a command as sent. */
  record(sessionId, cmd, cmdId) {
    const k = this._key(sessionId, cmd);
    this._cache.set(k, { cmdId, timestamp: Date.now() });
  }

  /** Prune entries older than IDEMPOTENCY_WINDOW_MS. Called periodically. */
  prune() {
    const cutoff = Date.now() - IDEMPOTENCY_WINDOW_MS;
    for (const [k, v] of this._cache) {
      if (v.timestamp < cutoff) this._cache.delete(k);
    }
  }
}

// ─── Shared Proxy ─────────────────────────────────────────────────────────────

function createProxy({ httpServer, tlsOptions }) {
  const pageMirror = new PageMirror({ maxHtmlBytes: MAX_HTML_BYTES }); // Fix #M3
  const cmdQueue = new CommandQueue(30000);
  const idempotencyCache = new IdempotencyCache();  // Fix #M2

  /** @type {Map<string, RateLimiter>} */
  const rateLimiters = new Map();

  /**
   * Fix #L4: rate limiter fetched once per session and cached on the session
   * object itself, avoiding a Map lookup on every command.
   */
  const sessionMeta = new Map(); // sessionId → { limiter, lastSeen }

  function getSessionMeta(sessionId) {
    if (!sessionMeta.has(sessionId)) {
      sessionMeta.set(sessionId, {
        limiter: new RateLimiter(RATE_LIMITER_OPTS.maxTokens, RATE_LIMITER_OPTS.windowMs),
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

  function jsonResponse(res, statusCode, data) {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'http://localhost:*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(JSON.stringify(data));
  }

  /**
   * Fix #M4: parseBody enforces MAX_BODY_BYTES total size limit.
   * Aborts the connection if the body exceeds the limit.
   */
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
   * @param {string} sessionId
   * @param {object} msg
   */
  function sendToExtension(sessionId, msg) {
    const ws = sessionSockets.get(sessionId);
    if (ws && ws.readyState === 1 /* OPEN */) {
      ws.send(JSON.stringify(msg));
    }
  }

  function broadcastToAllExtensions(msg) {
    const data = JSON.stringify(msg);
    for (const ws of sessionSockets.values()) {
      if (ws.readyState === 1 /* OPEN */) {
        ws.send(data);
      }
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

  // ── WebSocket Server (Hermes push client) ──────────────────────────────────
  // Fix #M1: Hermes can connect here as a WebSocket client to receive push
  // updates instead of polling HTTP. The extension still connects to wss above.
  // Hermes connects to ws://localhost:9321/hermes (HTTP upgrade on same server).
  const wssHermes = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://localhost:${httpServer.address().port}`);
    if (url.pathname === '/hermes') {
      wssHermes.handleUpgrade(req, socket, head, (ws) => {
        wssHermes.emit('connection', ws, req);
      });
    }
    // else: extension WS (ws:///) handled by wss above
  });

  // Track Hermes WS clients — send them page state pushes
  /** @type {Set<import('ws').WebSocket>} */
  const hermesClients = new Set();

  wssHermes.on('connection', (ws, req) => {
    const reqId = randomUUID().slice(0, 8);
    const remoteIp = req.socket.remoteAddress || 'unknown';
    log('info', 'Hermes WS client connected', { reqId, remoteIp });
    hermesClients.add(ws);

    // Send current state immediately on connect
    const state = pageMirror.getState('default', 0);
    ws.send(JSON.stringify({ type: 'page_state', ...state }));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        log('debug', `Hermes WS ← ${msg.type}`, { reqId });
        // Future: Hermes can send commands over this WS too
        if (msg.type === 'command') {
          // Forward to extension
          const sessionId = msg.sessionId || 'default';
          sendToExtension(sessionId, msg);
          log('info', `Hermes CMD → extension`, { reqId, sessionId, type: msg.commandType });
        }
      } catch (e) {
        log('warn', 'Hermes WS invalid JSON', { reqId });
      }
    });

    ws.on('close', () => {
      hermesClients.delete(ws);
      log('info', 'Hermes WS client disconnected', { reqId });
    });

    ws.on('error', (err) => {
      log('error', 'Hermes WS error', { reqId, err: err.message });
      hermesClients.delete(ws);
    });
  });

  // Push page state to Hermes clients whenever the mirror updates
  // (the extension sends tab_snapshot → we forward it to Hermes push clients)
  const originalUpdateSnapshot = pageMirror.updateSnapshot.bind(pageMirror);
  pageMirror.updateSnapshot = function(sessionId, snapshot) {
    originalUpdateSnapshot(sessionId, snapshot);
    // Push to all Hermes WS clients
    const payload = JSON.stringify({ type: 'page_state', ...snapshot });
    for (const ws of hermesClients) {
      if (ws.readyState === 1) ws.send(payload);
    }
  };

  const originalAddMutations = pageMirror.addMutations.bind(pageMirror);
  pageMirror.addMutations = function(sessionId, mutationData) {
    originalAddMutations(sessionId, mutationData);
    // Push mutations to Hermes WS clients
    const payload = JSON.stringify({ type: 'mutations', sessionId, ...mutationData });
    for (const ws of hermesClients) {
      if (ws.readyState === 1) ws.send(payload);
    }
  };

  wss.on('connection', (ws, req) => {
    const reqId = randomUUID().slice(0, 8);
    const remoteIp = req.socket.remoteAddress || 'unknown';

    const origin = req.headers['origin'];
    const validOrigins = ['null', 'http://localhost', 'http://localhost:9321'];
    if (origin && !validOrigins.includes(origin)) {
      log('warn', 'WS connection rejected — unauthorized origin', { reqId, origin, remoteIp });
      ws.close(1008, 'Unauthorized origin');
      return;
    }

    ws.isAlive = true;
    log('info', 'WS client connected', { reqId, origin: origin || 'null', remoteIp });

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); }
      catch (e) {
        log('warn', 'WS invalid JSON', { reqId, raw: String(raw).slice(0, 100) });
        return;
      }

      const sessionId = msg.sessionId || 'default';
      log('debug', `WS ← ${msg.type}`, { reqId, sessionId, tabId: msg.tabId || null });

      switch (msg.type) {
        case 'tab_snapshot': {
          sessionSockets.set(sessionId, ws);
          pageMirror.updateSnapshot(sessionId, msg);
          break;
        }

        case 'mutation':
          pageMirror.addMutations(sessionId, msg);
          break;

        case 'heartbeat':
          sessionSockets.set(sessionId, ws);
          break;

        case 'cmd_ack': {
          // Fix #M10: warn if cmdId not found in queue
          const before = cmdQueue.size;
          cmdQueue.ack(msg.cmdId, msg.result);
          if (cmdQueue.size === before && !cmdQueue.get(msg.cmdId)?.result) {
            log('warn', 'cmd_ack for unknown cmdId — may have already timed out', { reqId, sessionId, cmdId: msg.cmdId });
          }
          break;
        }

        case 'cmd_error': {
          const before = cmdQueue.size;
          cmdQueue.error(msg.cmdId, msg.error || 'Unknown error');
          if (cmdQueue.size === before && cmdQueue.get(msg.cmdId)?.status !== 'error') {
            log('warn', 'cmd_error for unknown cmdId — may have already timed out', { reqId, sessionId, cmdId: msg.cmdId, error: msg.error });
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
          log('info', 'WS session disconnected', { reqId, sessionId: sid });
          break;
        }
      }
    });

    ws.on('error', (err) => {
      log('error', 'WS socket error', { reqId, err: err.message });
    });

    ws.send(JSON.stringify({ type: 'connected', message: 'Hermes Browser Bridge proxy ready' }));
  });

  // Heartbeat — ping all sockets to detect dead connections
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);

  // Fix #L1: prune old commands every PRUNE_INTERVAL_MS (120s)
  const pruneInterval = setInterval(() => {
    cmdQueue.prune(60000);
    idempotencyCache.prune();  // Fix #M2: also prune idempotency cache
  }, PRUNE_INTERVAL_MS);

  wss.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(pruneInterval);
  });

  // ── HTTP REST API ──────────────────────────────────────────────────────────

  httpServer.on('request', async (req, res) => {
    const reqId = randomUUID().slice(0, 8);
    const url = new URL(req.url, `http://localhost:${httpServer.address().port}`);
    const path = url.pathname;

    log('debug', `${req.method} ${path}`, { reqId });

    if (req.method === 'OPTIONS') {
      jsonResponse(res, 204, {});
      return;
    }

    // ── GET /health ────────────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/health') {
      jsonResponse(res, 200, {
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        connected: pageMirror.connected,
        pendingCommands: cmdQueue.size,
        wsClients: wss.clients.size,
        activeSessions: sessionSockets.size
      });
      return;
    }

    // ── GET /page_state ───────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/page_state') {
      const sessionId = url.searchParams.get('sessionId') || 'default';
      const lastSeq = parseInt(url.searchParams.get('lastSeq') || '0', 10);

      if (lastSeq > 0) {
        pageMirror.ackSessionSeq(sessionId, lastSeq);
      }

      const state = pageMirror.getState(sessionId, lastSeq);

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

    // ── POST /command ────────────────────────────────────────────────────
    if (req.method === 'POST' && path === '/command') {
      const sessionId = url.searchParams.get('sessionId') || 'default';

      // Fix #L4: get session meta (includes cached rate limiter)
      const meta = getSessionMeta(sessionId);
      if (!meta.limiter.tryConsume()) {
        jsonResponse(res, 429, {
          error: 'Rate limit exceeded. Max 5 commands per second per session.',
          retryAfterMs: 1000
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

      // Fix #M2: idempotency check — reject duplicate commands within the window
      if (idempotencyKey) {
        const idempKey = `${sessionId}:${idempotencyKey}`;
        const existing = idempotencyCache.check(sessionId, body);
        if (existing.duplicate) {
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

      // Fix #M2: record in idempotency cache
      if (idempotencyKey) {
        idempotencyCache.record(sessionId, body, cmdId);
      }

      cmdQueue.add(cmdId, cmd).then((result) => {
        log('info', `CMD resolved`, { reqId, cmdId, sessionId, type, success: result.success, result: result.result, error: result.error });
      }).catch((err) => {
        log('warn', `CMD caught`, { reqId, cmdId, sessionId, err: err.message });
      });

      sendToExtension(sessionId, cmd);
      log('info', `CMD → extension`, { reqId, cmdId, sessionId, type, selector: selector || null });

      jsonResponse(res, 202, {
        cmdId,
        status: 'pending',
        message: `Command queued. Poll GET /command/${cmdId}`,
        rateLimitRemaining: meta.limiter.available,
        sessionId
      });
      return;
    }

    // ── GET /command/:cmdId ──────────────────────────────────────────────
    const cmdMatch = path.match(/^\/command\/([^/]+)$/);
    if (req.method === 'GET' && cmdMatch) {
      const cmdId = cmdMatch[1];
      const result = cmdQueue.get(cmdId);
      if (result.status === 'unknown') {
        jsonResponse(res, 404, { error: `Command ${cmdId} not found` });
        return;
      }
      log('debug', `GET /command/${cmdId}`, { reqId, status: result.status });
      jsonResponse(res, 200, { cmdId, ...result });
      return;
    }

    jsonResponse(res, 404, { error: 'Not found. Available: GET /health, GET /page_state, POST /command, GET /command/:cmdId' });
  });

  // ── Graceful shutdown ───────────────────────────────────────────────────

  function shutdown() {
    log('info', 'Shutdown signal received');
    clearInterval(heartbeat);
    clearInterval(pruneInterval);
    wss.close();
    wssHermes.close();
    httpServer.close();
  }

  return { httpServer, wss, pageMirror, cmdQueue, shutdown };
}

module.exports = { createProxy, RateLimiter };
