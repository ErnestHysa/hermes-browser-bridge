/**
 * wsHandlers.js — Extension and Hermes WebSocket connection handlers.
 */

'use strict';

const { WebSocketServer } = require('ws');
const { randomUUID } = require('node:crypto');
const { log } = require('./logger');
const { getToken } = require('./authToken');
const { metrics, metricIncr, metricGauge, metricHistogramPush } = require('./metrics');
const { pushHistory } = require('./commandHistory');

const cfg = require('../config');
const BACKPRESSURE_THRESHOLD_MS = cfg.BACKPRESSURE_THRESHOLD_MS;
const WS_SEND_TIMEOUT_MS = 30000;
const SESSION_TIMEOUT_MS = cfg.SESSION_TIMEOUT_MS;
const PER_SESSION_RATE_LIMIT = cfg.PER_SESSION_RATE_LIMIT;

/**
 * Create and wire up both WebSocket servers.
 *
 * @param {object} opts
 * @param {import('http').Server} opts.httpServer
 * @param {import('./page_mirror').PageMirror} opts.pageMirror
 * @param {import('./cmd_queue').CommandQueue} opts.cmdQueue
 * @param {import('./idempotency').IdempotencyCache} opts.idempotencyCache
 * @param {import('./backpressure').BackpressureManager} opts.backpressure
 * @param {import('./hermesPush').HermesPushManager} opts.hermesPush
 * @param {import('./rateLimiter').RateLimiter} opts.RateLimiter
 * @param {Map<string, import('ws').WebSocket>} opts.sessionSockets
 * @param {Map<string, any>} opts.sessionMeta
 * @param {Map<string, any>} opts.sessionMetaInfo
 * @param {function} opts.sendToExtension
 * @returns {{ wss: import('ws').WebSocketServer, wssHermes: import('ws').WebSocketServer }}
 */
function setupWebSocketHandlers({
  httpServer, pageMirror, cmdQueue, idempotencyCache, backpressure, hermesPush,
  RateLimiter, sessionSockets, sessionMeta, sessionMetaInfo, sendToExtension
}) {
  const RATE_LIMIT_RPS = cfg.RATE_LIMIT_RPS;

  // Extension WS with permessage-deflate
  const wss = new WebSocketServer({
    server: httpServer,
    pingInterval: 30000,
    pingTimeout: 10000,
    permessageDeflate: {
      serverNoContextTakeover: true,
      serverMaxWindowBits: 15,
      clientNoContextTakeover: true,
      clientMaxWindowBits: 15,
      concurrencyLimit: 10
    }
  });

  // Hermes WS
  const wssHermes = new WebSocketServer({ noServer: true, pingInterval: 30000, pingTimeout: 10000 });

  // ── Hermes WS send timeout tracking ───────────────────────────────────
  let _hermesSendTimeoutTimer = null;
  function _clearHermesSendTimeout() {
    if (_hermesSendTimeoutTimer !== null) { clearTimeout(_hermesSendTimeoutTimer); _hermesSendTimeoutTimer = null; }
  }
  function _resetHermesSendTimeout(ws, reqId) {
    _clearHermesSendTimeout();
    _hermesSendTimeoutTimer = setTimeout(() => {
      log('warn', 'Hermes WS send timeout — closing socket', { reqId });
      metrics.counters.wsSendTimeouts++;
      ws.terminate();
    }, WS_SEND_TIMEOUT_MS);
  }

  // ── HTTP upgrade routing ──────────────────────────────────────────────
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://localhost:${httpServer.address().port}`);
    if (url.pathname === '/hermes') {
      wssHermes.handleUpgrade(req, socket, head, (ws) => {
        wssHermes.emit('connection', ws, req);
      });
    }
  });

  // ── Hermes WS handler ─────────────────────────────────────────────────
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

      if (msg.type === 'hello') {
        const expectedToken = getToken();
        if (expectedToken && msg.token !== expectedToken) {
          log('warn', 'Hermes WS auth failed — invalid token', { reqId });
          ws.close(1008, 'Invalid token');
          return;
        }
        authenticated = true;
        try {
          ws.send(JSON.stringify({ type: 'hello_ack', message: 'Hermes Browser Bridge proxy ready', reqId }));
        } catch (e) {
          log('warn', 'Hermes WS failed to send hello_ack', { reqId, err: e.message });
        }
        return;
      }

      if (!authenticated) {
        ws.close(1008, 'Send hello first');
        return;
      }

      if (msg.type === 'subscribe') {
        if (!msg.sessionId) {
          try { ws.send(JSON.stringify({ type: 'error', message: 'sessionId required' })); } catch (e) {
            log('warn', 'Hermes WS failed to send error response', { reqId, err: e.message });
          }
          return;
        }
        hermesPush.subscribe(ws, msg.sessionId, reqId);
        const state = pageMirror.getState(msg.sessionId, 0);
        try {
          ws.send(JSON.stringify({ type: 'page_state', sessionId: msg.sessionId, ...state }));
          ws.send(JSON.stringify({ type: 'subscribed', sessionId: msg.sessionId }));
        } catch (e) {
          log('warn', 'Hermes WS failed to send subscribe response', { reqId, sessionId: msg.sessionId, err: e.message });
        }
        return;
      }

      if (msg.type === 'session_bridge') {
        const newId = msg.sessionId;
        const oldId = msg.previousSessionId;
        if (newId && oldId) {
          hermesPush.broadcastSessionBridge(newId, oldId);
        }
        try { ws.send(JSON.stringify({ type: 'session_bridge_ack', sessionId: newId, previousSessionId: oldId })); } catch (e) {
          log('warn', 'Hermes WS failed to send session_bridge_ack', { reqId, err: e.message });
        }
        return;
      }

      if (msg.type === 'unsubscribe') {
        hermesPush.unsubscribe(ws);
        try { ws.send(JSON.stringify({ type: 'unsubscribed' })); } catch (e) {
          log('warn', 'Hermes WS failed to send unsubscribed', { reqId, err: e.message });
        }
        return;
      }

      if (msg.type === 'command') {
        const sessionId = msg.sessionId;
        const cmdId = msg.cmdId || randomUUID();
        const cmd = {
          type: msg.commandType,
          cmdId,
          selector: msg.selector,
          url: msg.url,
          x: msg.x,
          y: msg.y,
          text: msg.text,
          script: msg.script,
        };
        hermesPush._cmdIdToWs.set(cmdId, ws);
        hermesPush.forwardCommand(sessionId, cmd, sendToExtension);
        log('info', 'Hermes CMD → extension', { reqId, sessionId, type: cmd.type, cmdId });
        try {
          ws.send(JSON.stringify({ type: 'command_queued', cmdId, sessionId }));
        } catch (e) {
          log('warn', 'Hermes WS failed to send command_queued', { reqId, cmdId, err: e.message });
        }
        return;
      }

      if (msg.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); } catch (e) {
          log('warn', 'Hermes WS failed to send pong', { reqId, err: e.message });
        }
      }
    });

    _clearHermesSendTimeout();
    ws.on('close', () => {
      hermesPush._cleanupWsEntries(ws);
      hermesPush.unsubscribe(ws);
      _clearHermesSendTimeout();
      log('info', 'Hermes WS client disconnected', { reqId });
    });

    ws.on('error', (err) => {
      log('error', 'Hermes WS error', { reqId, err: err.message });
      hermesPush.unsubscribe(ws);
    });
  });

  // ── Extension WS handler ──────────────────────────────────────────────
  wss.on('connection', (ws, req) => {
    const reqId = randomUUID().slice(0, 8);
    const remoteIp = req.socket.remoteAddress || 'unknown';

    let extAuthenticated = false;
    const expectedToken = getToken();
    const authTimeout = setTimeout(() => {
      if (!extAuthenticated) {
        log('warn', 'Extension WS auth timeout — no hello received', { reqId, remoteIp });
        ws.close(1008, 'Auth required');
      }
    }, 5000);

    const origin = req.headers['origin'];
    const validOrigins = cfg.ALLOWED_ORIGINS;
    if (origin && !validOrigins.includes(origin)) {
      log('warn', 'WS connection rejected — unauthorized origin', { reqId, origin, remoteIp });
      ws.close(1008, 'Unauthorized origin');
      return;
    }

    log('info', 'Extension WS connected', { reqId, origin: origin || 'null', remoteIp });
    metricIncr('wsConnections');

    ws.on('message', (raw) => {
      metrics.counters.wsMessages.rx++;

      let msg;
      try { msg = JSON.parse(raw); }
      catch (e) {
        log('warn', 'WS invalid JSON', { reqId, raw: String(raw).slice(0, 100) });
        return;
      }

      // Per-session rate limiting
      {
        const sid = msg.sessionId || 'default';
        if (!sessionMeta.has(sid)) {
          sessionMeta.set(sid, {
            limiter: new RateLimiter(RATE_LIMIT_RPS, 1000, PER_SESSION_RATE_LIMIT),
            lastSeen: Date.now()
          });
        }
        const meta = sessionMeta.get(sid);
        meta.lastSeen = Date.now();
        if (!meta.limiter.tryConsume()) {
          log('warn', 'Extension WS rate limit exceeded — dropping message', { reqId, sessionId: sid, type: msg.type });
          ws.send(JSON.stringify({ type: 'rate_limited', message: 'Too many messages — slow down', retryAfterMs: 100 }));
          return;
        }
      }

      if (!extAuthenticated) {
        if (msg.type === 'hello') {
          clearTimeout(authTimeout);
          if (expectedToken && msg.token !== expectedToken) {
            log('warn', 'Extension WS auth failed — invalid token', { reqId, remoteIp });
            ws.close(1008, 'Invalid token');
            return;
          }
          extAuthenticated = true;
          log('info', 'Extension WS authenticated', { reqId, remoteIp });
          try {
            ws.send(JSON.stringify({ type: 'connected', message: 'Proxy ready' }));
          } catch (e) {
            log('error', 'Extension WS failed to send connected ack', { reqId, err: e.message });
          }
          return;
        }
        log('warn', 'Extension WS sent message before hello — rejecting', { reqId, type: msg.type });
        ws.close(1008, 'Send hello first');
        return;
      }

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
          log('info', 'session_info from extension', { reqId, sessionId, version: msg.version, tabId: msg.tabId });
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
            const cmdEntry = cmdQueue.get(msg.cmdId);
            if (cmdEntry?.cmd) {
              const duration = Date.now() - (cmdEntry.submittedAt || Date.now());
              metricHistogramPush('commandDuration', duration, { type: cmdEntry.cmd.type });
              metricIncr('commands', { type: cmdEntry.cmd.type, status: 'success' });
              pushHistory(sessionId, { cmdId: msg.cmdId, type: cmdEntry.cmd.type, status: 'success', result: String(msg.result || '').slice(0, 200), ts: Date.now() }, log);
            }
          }
          break;
        }

        case 'cmd_error': {
          const rawError = msg.error || 'Unknown error';
          let errCode;
          if (msg.errorCode && typeof msg.errorCode === 'string' && msg.errorCode !== 'INTERNAL_ERROR') {
            errCode = msg.errorCode;
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
              pushHistory(sessionId, { cmdId: msg.cmdId, type: cmdEntry.cmd.type, status: 'error', error: String(msg.error || 'Unknown error').slice(0, 200), ts: Date.now() }, log);
            }
          }

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

    ws.on('close', () => {
      clearTimeout(authTimeout);
      for (const [sid, sws] of sessionSockets) {
        if (sws === ws) {
          sessionSockets.delete(sid);
          pageMirror.disconnectSession(sid);
          sessionMeta.delete(sid);
          sessionMetaInfo.delete(sid);
          hermesPush._removeSession(sid);
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

  return { wss, wssHermes };
}

module.exports = { setupWebSocketHandlers };
