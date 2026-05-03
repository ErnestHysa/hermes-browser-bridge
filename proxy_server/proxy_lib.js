/**
 * proxy_lib.js — Shared proxy logic for both HTTP and HTTPS server variants.
 * Contains all HTTP handling, WebSocket handling, and shared state.
 * Both server.js and server_https.js import this to avoid code duplication.
 *
 * Fix #3:  Per-client rate limiter Map<sessionId, RateLimiter>
 * Fix #9:  Per-client command routing — commands sent only to the correct session's WebSocket
 * Fix #15: Per-client rate limiting (not global)
 * Fix #16: Origin validation on WebSocket connections
 * Fix #4:  pageMirror uses per-session connected state (no longer needs setConnected)
 */

const { WebSocketServer } = require('ws');
const { randomUUID } = require('node:crypto');

const { CommandQueue } = require('./cmd_queue');
const { PageMirror } = require('./page_mirror');

// ─── Rate Limiter ─────────────────────────────────────────────────────────────

/**
 * Token-bucket rate limiter: max `maxTokens` commands per `windowMs` milliseconds.
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

// ─── Shared Proxy ─────────────────────────────────────────────────────────────

function createProxy({ httpServer, tlsOptions }) {
  const pageMirror = new PageMirror();
  const cmdQueue = new CommandQueue(30000);

  // Fix #3 + Fix #15: per-client rate limiters
  /** @type {Map<string, RateLimiter>} */
  const rateLimiters = new Map();

  /**
   * Get or create a rate limiter for a given client (sessionId).
   * Each browser session gets its own 5 commands/sec bucket.
   * @param {string} sessionId
   * @returns {RateLimiter}
   */
  function getRateLimiter(sessionId) {
    if (!rateLimiters.has(sessionId)) {
      rateLimiters.set(sessionId, new RateLimiter(5, 1000));
    }
    return rateLimiters.get(sessionId);
  }

  // Fix #9: per-session WebSocket routing — map sessionId → ws client
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

  function parseBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try { resolve(body ? JSON.parse(body) : {}); }
        catch (e) { reject(new Error('Invalid JSON')); }
      });
      req.on('error', reject);
    });
  }

  /**
   * Send a command to a specific session's extension, not all extensions.
   * Fix #9: replaces broadcastToExtension.
   * @param {string} sessionId
   * @param {object} msg
   */
  function sendToExtension(sessionId, msg) {
    const ws = sessionSockets.get(sessionId);
    if (ws && ws.readyState === 1 /* OPEN */) {
      ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Broadcast to all connected extension sessions.
   * Used for events that genuinely need to reach everyone (e.g. future system messages).
   * @param {object} msg
   */
  function broadcastToAllExtensions(msg) {
    const data = JSON.stringify(msg);
    for (const ws of sessionSockets.values()) {
      if (ws.readyState === 1 /* OPEN */) {
        ws.send(data);
      }
    }
  }

  // ── WebSocket Server ──────────────────────────────────────────────────────

  const wssOptions = { server: httpServer };
  // Fix #1 + Fix #24: correct concurrencyLimit spelling, proper windowBits
  wssOptions.permessageDeflate = {
    serverNoContextTakeover: true,
    serverMaxWindowBits: 15,
    clientNoContextTakeover: true,
    clientMaxWindowBits: 15,
    concurrencyLimit: 10
  };
  const wss = new WebSocketServer(wssOptions);

  wss.on('connection', (ws, req) => {
    // Fix #16: validate origin — Safari extensions use null origin
    const origin = req.headers['origin'];
    const validOrigins = ['null', 'http://localhost', 'http://localhost:9321'];
    if (origin && !validOrigins.includes(origin)) {
      console.warn(`[WS] Rejected connection from unauthorized origin: ${origin}`);
      ws.close(1008, 'Unauthorized origin');
      return;
    }

    ws.isAlive = true;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); }
      catch (e) { console.error('[WS] Invalid message:', raw); return; }

      // sessionId from the extension identifies this browser session
      const sessionId = msg.sessionId || 'default';
      console.log(`[WS] ← ${msg.type} (session=${sessionId})`);

      switch (msg.type) {
        case 'tab_snapshot':
          // Register this socket as the handler for this session
          sessionSockets.set(sessionId, ws);
          pageMirror.updateSnapshot(sessionId, msg);
          break;

        case 'mutation':
          pageMirror.addMutations(sessionId, msg);
          break;

        case 'heartbeat':
          // Refresh this session's socket binding (in case of reconnect)
          sessionSockets.set(sessionId, ws);
          break;

        case 'cmd_ack':
          cmdQueue.ack(msg.cmdId, msg.result);
          break;

        case 'cmd_error':
          cmdQueue.error(msg.cmdId, msg.error || 'Unknown error');
          break;

        default:
          console.warn('[WS] Unknown message type:', msg.type);
      }
    });

    ws.on('close', () => {
      // Find and remove the session that owned this socket
      for (const [sid, sws] of sessionSockets) {
        if (sws === ws) {
          sessionSockets.delete(sid);
          pageMirror.disconnectSession(sid);
          rateLimiters.delete(sid);
          console.log(`[WS] Session ${sid} disconnected`);
          break;
        }
      }
    });

    ws.on('error', (err) => {
      console.error('[WS] Socket error:', err.message);
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

  wss.on('close', () => clearInterval(heartbeat));

  // Periodic prune of old commands
  const pruneInterval = setInterval(() => cmdQueue.prune(60000), 120000);

  // ── HTTP REST API ──────────────────────────────────────────────────────────

  httpServer.on('request', async (req, res) => {
    const url = new URL(req.url, `http://localhost:${httpServer.address().port}`);
    const path = url.pathname;

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
    // Supports: ?sessionId=...&lastSeq=N  (lastSeq enables delta mutations)
    if (req.method === 'GET' && path === '/page_state') {
      const sessionId = url.searchParams.get('sessionId') || 'default';
      const lastSeq = parseInt(url.searchParams.get('lastSeq') || '0', 10);

      // Acknowledge the last seq we've seen so the extension can track delivery
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
      jsonResponse(res, 200, state);
      return;
    }

    // ── POST /command ────────────────────────────────────────────────────
    // Supports: ?sessionId=...  (routes command to specific browser session)
    if (req.method === 'POST' && path === '/command') {
      const sessionId = url.searchParams.get('sessionId') || 'default';

      // Fix #3 + Fix #15: per-client rate limiting
      const limiter = getRateLimiter(sessionId);
      if (!limiter.tryConsume()) {
        jsonResponse(res, 429, {
          error: 'Rate limit exceeded. Max 5 commands per second per session.',
          retryAfterMs: 1000
        });
        return;
      }

      let body;
      try { body = await parseBody(req); }
      catch (e) { jsonResponse(res, 400, { error: e.message }); return; }

      const { type, selector, url: destUrl, x, y, text, script } = body;
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

      const cmdId = randomUUID();
      // Attach sessionId so the correct client receives this command
      const cmd = { type, cmdId, selector, url: destUrl, x, y, text, script, sessionId };

      cmdQueue.add(cmdId, cmd).then((result) => {
        console.log(`[CMD] ${cmdId} resolved:`, result.success ? 'OK' : result.error);
      }).catch((err) => {
        console.warn(`[CMD] ${cmdId} caught: ${err.message}`);
      });

      // Fix #9: send to the specific session, not all sessions
      sendToExtension(sessionId, cmd);
      console.log(`[HTTP] → Session ${sessionId}: ${type} (${cmdId})`);

      jsonResponse(res, 202, {
        cmdId,
        status: 'pending',
        message: `Command queued. Poll GET /command/${cmdId}`,
        rateLimitRemaining: limiter.available,
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
      jsonResponse(res, 200, { cmdId, ...result });
      return;
    }

    jsonResponse(res, 404, { error: 'Not found. Available: GET /health, GET /page_state, POST /command, GET /command/:cmdId' });
  });

  // ── Graceful shutdown ───────────────────────────────────────────────────

  function shutdown() {
    console.log('\nShutting down…');
    clearInterval(heartbeat);
    clearInterval(pruneInterval);
    wss.close();
    httpServer.close();
  }

  return { httpServer, wss, pageMirror, cmdQueue, shutdown };
}

module.exports = { createProxy, RateLimiter };
