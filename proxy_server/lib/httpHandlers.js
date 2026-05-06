/**
 * httpHandlers.js — HTTP REST API route handlers.
 */

'use strict';

const { randomUUID } = require('node:crypto');
const { log } = require('./logger');
const { validateHttpAuth, jsonResponse, parseBody, htmlEscape } = require('./utils');
const { metrics, metricIncr, metricHistogramPush, metricGauge, formatPrometheus, buildMetricsJson } = require('./metrics');
const { getHistory, pushHistory, deleteHistory } = require('./commandHistory');

const cfg = require('../config');
const MAX_BODY_BYTES = cfg.MAX_BODY_BYTES;
const BACKPRESSURE_THRESHOLD_MS = cfg.BACKPRESSURE_THRESHOLD_MS;

/**
 * Set up all HTTP route handlers on the server.
 *
 * @param {import('http').Server} httpServer
 * @param {object} opts
 * @param {import('./page_mirror').PageMirror} opts.pageMirror
 * @param {import('./cmd_queue').CommandQueue} opts.cmdQueue
 * @param {import('./idempotency').IdempotencyCache} opts.idempotencyCache
 * @param {import('./hermesPush').HermesPushManager} opts.hermesPush
 * @param {object} [opts.tlsOptions]
 * @param {string} [opts.version='1.0.0']
 * @param {function} opts.sendToExtension
 * @param {Map<string, import('ws').WebSocket>} opts.sessionSockets
 * @param {Map<string, any>} opts.sessionMeta
 * @param {Map<string, any>} opts.sessionMetaInfo
 */
function setupHttpHandlers(httpServer, opts) {
  const {
    pageMirror, cmdQueue, idempotencyCache, hermesPush,
    tlsOptions, version, sendToExtension,
    sessionSockets, sessionMeta, sessionMetaInfo
  } = opts;
  const PROXY_VERSION = version || '1.0.0';
  const RATE_LIMIT_RPS = cfg.RATE_LIMIT_RPS;
  const PER_SESSION_RATE_LIMIT = cfg.PER_SESSION_RATE_LIMIT;
  const PRUNE_INTERVAL_MS = 120000;

  const RateLimiter = require('./rateLimiter').RateLimiter;

  httpServer.on('request', async (req, res) => {
    const REQ_TIMEOUT_MS = parseInt(process.env.HBS_REQ_TIMEOUT_MS || '30000', 10);
    req.setTimeout(REQ_TIMEOUT_MS, () => {
      if (!res.headersSent) {
        res.writeHead(408, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request timeout' }));
      }
    });
    const reqId = randomUUID().slice(0, 8);
    req._hermesReqId = reqId;
    const serverPort = httpServer.address().port;
    const url = new URL(req.url, `http://localhost:${serverPort}`);
    const path = url.pathname;

    log('debug', `${req.method} ${path}`, { reqId });

    if (req.method === 'OPTIONS') {
      jsonResponse(res, 204, {});
      return;
    }

    // Auth check for protected endpoints
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

    // ── GET /metrics/stream ──────────────────────────────────────────────
    if (req.method === 'GET' && path === '/metrics/stream') {
      const remoteIp = req.socket.remoteAddress || '';
      if (!remoteIp.includes('127.0.0.1') && !remoteIp.includes('::1') && !remoteIp.includes('localhost')) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden: /metrics/stream only available from localhost');
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Connection': 'keep-alive',
        'Keep-Alive': 'timeout=65, max=1000',
        'X-Accel-Buffering': 'no',
        'X-Request-Id': reqId
      });

      res.write(`data: ${JSON.stringify(buildMetricsJson(cmdQueue.size))}\n\n`);

      const metricsInterval = setInterval(() => {
        if (res.writableEnded) { clearInterval(metricsInterval); return; }
        try {
          res.write(`data: ${JSON.stringify(buildMetricsJson(cmdQueue.size))}\n\n`);
        } catch (e) { clearInterval(metricsInterval); }
      }, 1000);

      req.on('close', () => {
        clearInterval(metricsInterval);
        metrics.counters.sseStreams = Math.max(0, (metrics.counters.sseStreams || 0) - 1);
      });
      metrics.counters.sseStreams++;
      return;
    }

    // ── GET /health ──────────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/health') {
      const proto = tlsOptions ? 'wss' : 'ws';
      jsonResponse(res, 200, {
        status: 'ok',
        version: PROXY_VERSION,
        uptime: Math.floor(process.uptime()),
        connected: pageMirror.connected,
        pendingCommands: cmdQueue.size,
        activeSessions: sessionSockets.size,
        hermesClients: hermesPush.size,
        backpressureActive: metrics.gauges.backpressureActive === 1,
        wsUrl: `${proto}://localhost:${serverPort}`,
        hermesWsUrl: `${proto}://localhost:${serverPort}/hermes`,
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

    // ── GET /metrics ─────────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/metrics') {
      metricGauge('uptimeSeconds', Math.floor(process.uptime()));
      metricGauge('pendingCommands', cmdQueue.size);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(formatPrometheus());
      return;
    }

    // ── GET /config ─────────────────────────────────────────────────────
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

    // ── GET /sessions ────────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/sessions') {
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

    // ── GET /sessions/:id ────────────────────────────────────────────────
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
      const hermesClientCount = [...hermesPush._clients.values()].filter(sids => sids.has(sid)).length;
      jsonResponse(res, 200, {
        sessionId: sid,
        connected: ws.readyState === 1,
        url: state.url || '',
        title: state.title || '',
        lastUpdate: state.lastUpdate || 0,
        mutationsPending: state.mutations ? state.mutations.length : 0,
        hermesSubscribers: hermesClientCount,
        commandQueueDepth: cmdQueue.size,
        extensionVersion: meta.version || null,
        tabId: meta.tabId || null,
        userAgent: meta.userAgent || null,
        connectedAt: meta.connectedAt || null,
      });
      return;
    }

    // ── POST /sessions/:id/activate ─────────────────────────────────────
    const activateMatch = path.match(/^\/sessions\/([^/]+)\/activate$/);
    if (req.method === 'POST' && activateMatch) {
      const targetSessionId = activateMatch[1];
      if (!sessionSockets.has(targetSessionId)) {
        jsonResponse(res, 404, { error: `Session '${targetSessionId}' not found or disconnected` });
        return;
      }
      hermesPush.pushToSession(targetSessionId, {
        type: 'session_activated',
        sessionId: targetSessionId,
        url: pageMirror.getState(targetSessionId).url
      });
      jsonResponse(res, 200, { success: true, sessionId: targetSessionId, message: 'Session activated' });
      return;
    }

    // ── DELETE /sessions/:id ────────────────────────────────────────────
    const sessionDeleteMatch = path.match(/^\/sessions\/([^\/]+)$/);
    if (req.method === 'DELETE' && sessionDeleteMatch) {
      const sid = sessionDeleteMatch[1];
      pageMirror.disconnectSession(sid);
      deleteHistory(sid);
      jsonResponse(res, 200, { success: true, sessionId: sid, message: 'Session state cleared' });
      return;
    }

    // ── GET /commands/history ────────────────────────────────────────────
    const historyMatch = path.match(/^\/commands\/history(?:\/([^/]+))?$/);
    if (req.method === 'GET' && historyMatch) {
      const sessionId = historyMatch[1];
      let result;
      if (sessionId) {
        result = { sessionId, history: getHistory(sessionId) };
      } else {
        result = {};
        // Need access to _commandHistory internal Map
        const { getHistory: getAllHistory } = require('./commandHistory');
        // We can't access the internal Map directly, so iterate active sessions
        for (const [sid] of sessionSockets) {
          result[sid] = getHistory(sid);
        }
      }
      jsonResponse(res, 200, result);
      return;
    }

    // ── GET /page_state ──────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/page_state') {
      const sessionId = url.searchParams.get('sessionId');
      const lastSeq = parseInt(url.searchParams.get('lastSeq') || '0', 10);

      if (lastSeq > 0) {
        pageMirror.ackSessionSeq(sessionId, lastSeq);
      }

      const state = pageMirror.getState(sessionId, lastSeq);

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

    // ── POST /command ────────────────────────────────────────────────────
    if (req.method === 'POST' && path === '/command') {
      const sessionId = url.searchParams.get('sessionId');

      const contentLength = parseInt(req.headers['content-length'] || '0', 10);
      if (contentLength > MAX_BODY_BYTES) {
        jsonResponse(res, 413, { error: `Request body exceeds ${MAX_BODY_BYTES} bytes` });
        return;
      }

      if (!sessionMeta.has(sessionId)) {
        sessionMeta.set(sessionId, {
          limiter: new RateLimiter(RATE_LIMIT_RPS, 1000, PER_SESSION_RATE_LIMIT),
          lastSeen: Date.now()
        });
      }
      const meta = sessionMeta.get(sessionId);
      meta.lastSeen = Date.now();
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

      const selectorTypes = ['click', 'type', 'submit'];
      if (selectorTypes.includes(type)) {
        if (!selector || typeof selector !== 'string' || selector.trim() === '') {
          jsonResponse(res, 400, { error: `Missing or invalid 'selector' field for '${type}' command` });
          return;
        }
        if (/<\//.test(selector)) {
          jsonResponse(res, 400, { error: 'Invalid selector: cannot contain HTML tag syntax' });
          return;
        }
      }

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

      if (idempotencyKey) {
        const existing = idempotencyCache.check(sessionId, idempotencyKey, body);
        if (existing.duplicate) {
          metrics.counters.idempotencyRejections++;
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

      cmdQueue.add(cmdId, cmd, submittedAt);
      sendToExtension(sessionId, cmd);
      log('info', 'CMD → extension', { reqId, cmdId, sessionId, type, selector: selector || null });
      metricIncr('commands', { type, status: 'pending' });

      jsonResponse(res, 202, {
        cmdId,
        status: 'pending',
        message: 'Command queued. Poll GET /command/:cmdId',
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
      jsonResponse(res, 200, { cmdId, ...result });
      return;
    }

    // ── DELETE /command/:cmdId ──────────────────────────────────────────
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
      cmdQueue.cancel(cmdId);
      const sessionId = result.cmd?.sessionId || 'default';
      sendToExtension(sessionId, { type: 'cancel', cmdId });
      log('info', 'CMD cancelled', { reqId, cmdId });
      jsonResponse(res, 200, { cmdId, status: 'cancelled' });
      return;
    }

    // ── GET /last_seq ────────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/last_seq') {
      const sessionId = url.searchParams.get('sessionId') || 'default';
      jsonResponse(res, 200, { sessionId, lastSeq: pageMirror.getLastSeq(sessionId) });
      return;
    }

    // ── GET /dashboard ────────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/dashboard') {
      const auth = validateHttpAuth(req);
      if (!auth.authorized) {
        jsonResponse(res, 401, { error: 'Unauthorized', reason: auth.reason });
        return;
      }

      const sessions = Array.from(sessionSockets.entries()).map(([sid, ws]) => {
        const state = pageMirror.getState(sid);
        const cmdHistory = getHistory(sid).slice(0, 5);
        return {
          sessionId: htmlEscape(sid),
          connected: ws.readyState === 1,
          url: htmlEscape(state.url || ''),
          title: htmlEscape(state.title || ''),
          lastUpdate: state.lastUpdate || 0,
          recentCommands: cmdHistory.map(c => ({
            ...c,
            result: htmlEscape(c.result || ''),
            error: htmlEscape(c.error || '')
          }))
        };
      });

      const dashHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Hermes Browser Bridge — Dashboard</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌉</text></svg>">
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
  .error-banner { display: none; background: #f85149; color: #fff; padding: 12px 16px; border-radius: 6px; margin-bottom: 16px; font-size: 13px; }
  .error-banner.visible { display: block; }
</style>
</head>
<body>
<div class="error-banner" id="error-banner">⚠ Unable to reach proxy — connection lost</div>
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
      ${s.recentCommands.map(c => `<li class="${c.status}">[${c.status}] ${htmlEscape(c.type)} — ${c.result || c.error || ''}</li>`).join('')}
    </ul>` : ''}
  </div>`).join('')}
</div>
<p class="refresh">Auto-refreshes every 5s</p>
<script src="/dashboard.js"></script>
</body>
</html>`;
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'"
      });
      res.end(dashHtml);
      return;
    }

    // ── Serve /dashboard.js ────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/dashboard.js') {
      const fs = require('node:fs');
      const path2 = require('node:path');
      const jsFile = path2.join(__dirname, '..', 'dashboard.js');
      try {
        const jsContent = fs.readFileSync(jsFile, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'application/javascript',
          'Content-Security-Policy': "default-src 'none'"
        });
        res.end(jsContent);
      } catch (_) {
        res.writeHead(404);
        res.end('Not found');
      }
      return;
    }

    jsonResponse(res, 404, {
      error: 'Not found',
      available: ['GET /health', 'GET /metrics', 'GET /sessions', 'POST /sessions/:id/activate', 'GET /page_state', 'POST /command', 'GET /command/:cmdId', 'DELETE /command/:cmdId', 'GET /last_seq', 'GET /dashboard']
    });
  });
}

module.exports = { setupHttpHandlers };
