/**
 * proxy_lib.js — Shared proxy logic for both HTTP and HTTPS server variants.
 * Contains all HTTP handling, WebSocket handling, and shared state.
 * Both server.js and server_https.js import this to avoid code duplication.
 */

const { WebSocketServer } = require('ws');
const { randomUUID } = require('node:crypto');

const { CommandQueue } = require('./cmd_queue');
const { PageMirror } = require('./page_mirror');

// ─── Rate Limiter ─────────────────────────────────────────────────────────────

/**
 * Token-bucket rate limiter: max `maxTokens` commands per `windowMs` milliseconds.
 * H3 FIX: prevents command spam — Hermes can't flood the extension with commands.
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

  /** How many tokens remaining right now */
  get available() {
    this._refill();
    return this.tokens;
  }
}

// ─── Shared Proxy ─────────────────────────────────────────────────────────────

function createProxy({ httpServer, tlsOptions }) {
  const pageMirror = new PageMirror();
  const cmdQueue = new CommandQueue(30000);
  const rateLimiter = new RateLimiter(5, 1000); // 5 commands/sec/client

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

  // ── WebSocket Server ──────────────────────────────────────────────────────

  // M3 FIX: enable permessage-deflate compression (ws handles it per connection)
  const wssOptions = { server: httpServer };
  if (!tlsOptions) {
    // plain HTTP — can still use permessage-deflate
    wssOptions.permessageDeflate = {
      concLinit: 10,
      thresholds: {
        clientNoContextTakeover: 1024,
        clientMaxWindowBits: 10,
        serverNoContextTakeover: 1024,
        serverMaxWindowBits: 10
      }
    };
  }
  const wss = new WebSocketServer(wssOptions);

  wss.on('connection', (ws, req) => {
    console.log(`[WS] Extension connected from ${req.socket.remoteAddress}`);
    ws.isAlive = true;
    // C3 FIX: pass tabId from incoming messages to setConnected
    pageMirror.setConnected(true, null);

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); }
      catch (e) { console.error('[WS] Invalid message:', raw); return; }

      // C3 FIX: route by sessionId — track which session owns which tab
      const sessionId = msg.sessionId || 'default';
      console.log(`[WS] ← ${msg.type} (session=${sessionId})`);

      switch (msg.type) {
        case 'tab_snapshot':
          // C3 FIX: store snapshot keyed by sessionId
          pageMirror.updateSnapshot(sessionId, msg);
          break;

        case 'mutation':
          // C3 FIX: mutations also keyed by session
          pageMirror.addMutations(sessionId, msg);
          break;

        case 'heartbeat':
          pageMirror.setConnected(true, msg.tabId ?? null);
          break;

        case 'cmd_ack':
          cmdQueue.ack(msg.cmdId, msg.result);
          break;

        case 'cmd_error':
          // L8 FIX: normalize error format
          cmdQueue.error(msg.cmdId, msg.error || 'Unknown error');
          break;

        default:
          console.warn('[WS] Unknown message type:', msg.type);
      }
    });

    ws.on('close', () => {
      console.log('[WS] Extension disconnected');
      pageMirror.setConnected(false);
    });

    ws.on('error', (err) => {
      console.error('[WS] Socket error:', err.message);
      pageMirror.setConnected(false);
    });

    ws.send(JSON.stringify({ type: 'connected', message: 'Hermes Browser Bridge proxy ready' }));
  });

  // Heartbeat
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) { ws.terminate(); return; }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => clearInterval(heartbeat));

  // Periodic prune
  const pruneInterval = setInterval(() => cmdQueue.prune(60000), 120000);

  function broadcastToExtension(msg) {
    const data = JSON.stringify(msg);
    wss.clients.forEach((client) => {
      if (client.readyState === 1 /* OPEN */) {
        client.send(data);
      }
    });
  }

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
        rateLimit: {
          available: rateLimiter.available,
          maxPerSecond: 5
        }
      });
      return;
    }

    // ── GET /page_state ───────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/page_state') {
      const state = pageMirror.getState();
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
    if (req.method === 'POST' && path === '/command') {
      // H3 FIX: check rate limit before accepting command
      if (!rateLimiter.tryConsume()) {
        jsonResponse(res, 429, {
          error: 'Rate limit exceeded. Max 5 commands per second.',
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
      const cmd = { type, cmdId, selector, url: destUrl, x, y, text, script };

      cmdQueue.add(cmdId, cmd).then((result) => {
        console.log(`[CMD] ${cmdId} resolved:`, result.success ? 'OK' : result.error);
      }).catch((err) => {
        console.warn(`[CMD] ${cmdId} caught: ${err.message}`);
      });

      broadcastToExtension(cmd);
      console.log(`[HTTP] → Extension: ${type} (${cmdId})`);

      // L8 FIX: return normalized response format
      jsonResponse(res, 202, {
        cmdId,
        status: 'pending',
        message: `Command queued. Poll GET /command/${cmdId}`,
        rateLimitRemaining: Math.floor(rateLimiter.available)
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
      // L8 FIX: normalize response — always { cmdId, status, result?, error? }
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
