/**
 * Hermes Browser Bridge — Proxy Server Library
 *
 * Provides HTTP REST API, WebSocket relay, and Hermes WS endpoints
 * for bridge communication between Chrome/Safari extensions and
 * Hermes AI agents (Claude Code).
 *
 * SPEC v1.3.2  — see ../SPEC.md
 */

'use strict';

const http = require('node:http');
const { randomUUID } = require('node:crypto');
const cfg = require('./config');
const pkg = require('./package.json');

const { log } = require('./lib/logger');
const { metrics, metricIncr, metricGauge } = require('./lib/metrics');
const { BackpressureManager } = require('./lib/backpressure');
const { HermesPushManager } = require('./lib/hermesPush');
const { IdempotencyCache } = require('./lib/idempotency');
const { RateLimiter, RATE_LIMIT_RPS, RATE_LIMIT_BURST } = require('./lib/rateLimiter');
const { PageMirror } = require('./page_mirror');
const { CommandQueue } = require('./cmd_queue');
const { pruneHistory } = require('./lib/commandHistory');
const { validateHttpAuth } = require('./lib/utils');
const { setupWebSocketHandlers } = require('./lib/wsHandlers');
const { setupHttpHandlers } = require('./lib/httpHandlers');

const SESSION_TIMEOUT_MS = cfg.SESSION_TIMEOUT_MS;
const PRUNE_INTERVAL_MS = 120000;

/**
 * Initialize and start the HTTP/WS proxy server.
 *
 * @param {object} [opts={}]
 * @param {number} [opts.port] - Port to listen on (default from config)
 * @param {import('http').Server} [opts.httpServer] - Pre-created server (takes precedence)
 * @param {object} [opts.tlsOptions] - Node.js TLS options
 * @param {boolean} [opts.useHttp2] - Not supported, use tlsOptions
 * @param {boolean} [opts.useTls] - Deprecated, just use tlsOptions
 * @returns {Promise<{httpServer: import('http').Server, wss: import('ws').WebSocketServer, wssHermes: import('ws').WebSocketServer}>}
 */
function startProxy(opts = {}) {
  return new Promise((resolve) => {
    const port = opts.port || 9321;
    const tlsOptions = opts.tlsOptions || null;
    const version = pkg.version || '1.3.2';

    const sessionSockets = new Map();
    const sessionMeta = new Map();
    const sessionMetaInfo = new Map();

    const pageMirror = new PageMirror();
    const cmdQueue = new CommandQueue();
    const idempotencyCache = new IdempotencyCache();
    const backpressure = new BackpressureManager();
    const hermesPush = new HermesPushManager();

    let httpServer = opts.httpServer || null;
    if (!httpServer) {
      if (tlsOptions) {
        const https = require('node:https');
        httpServer = https.createServer(tlsOptions);
      } else {
        httpServer = http.createServer();
      }
    } else if (httpServer.listen) {
      // Pre-created server: don't create new one, just wire up handlers
    }

    // Wire up HTTP routes
    setupHttpHandlers(httpServer, {
      pageMirror, cmdQueue, idempotencyCache, hermesPush,
      tlsOptions, version, sendToExtension,
      sessionSockets, sessionMeta, sessionMetaInfo
    });

    // Wire up WebSocket handlers
    const { wss, wssHermes } = setupWebSocketHandlers({
      httpServer, pageMirror, cmdQueue, idempotencyCache, backpressure, hermesPush,
      RateLimiter, sessionSockets, sessionMeta, sessionMetaInfo, sendToExtension
    });

    // ── sendToExtension (closure over sessionSockets) ───────────────────
    function sendToExtension(sessionId, cmd) {
      const ws = sessionSockets.get(sessionId);
      if (!ws || ws.readyState !== 1) {
        log('warn', 'Cannot send command — extension WS not open', { sessionId, cmdId: cmd.cmdId });
        cmdQueue.error(cmd.cmdId, 'Extension WebSocket not open');
        return;
      }
      try {
        ws.send(JSON.stringify(cmd));
        metrics.counters.wsMessages.tx++;
      } catch (e) {
        log('error', 'WS send failed', { sessionId, cmdId: cmd.cmdId, err: e.message });
        cmdQueue.error(cmd.cmdId, `WS send error: ${e.message}`);
      }
    }

    // ── Session bridge handler (Hermes tells proxy about session joins) ──
    hermesPush.setOnSessionBridge((newSessionId, oldSessionId) => {
      log('info', 'Hermes session bridge', { newSessionId, oldSessionId });
      if (sessionSockets.has(oldSessionId)) {
        const ws = sessionSockets.get(oldSessionId);
        sessionSockets.delete(oldSessionId);
        sessionSockets.set(newSessionId, ws);
        pageMirror.mergeSessionData(oldSessionId, newSessionId);
      }
    });

    // ── Session timeout eviction ────────────────────────────────────────
    const sessionTimeoutInterval = setInterval(() => {
      const now = Date.now();
      for (const [sid, meta] of sessionMeta) {
        if (now - meta.lastSeen > SESSION_TIMEOUT_MS) {
          log('info', 'Session timeout — evicting', { sessionId: sid });
          const ws = sessionSockets.get(sid);
          if (ws) {
            try { ws.close(1001, 'Session timeout'); } catch (e) {
              log('warn', 'Failed to close WS on session timeout', { sessionId: sid, err: e.message });
            }
          }
          sessionSockets.delete(sid);
          sessionMeta.delete(sid);
          sessionMetaInfo.delete(sid);
          pageMirror.disconnectSession(sid);
          hermesPush._removeSession(sid);
        }
      }
      metricGauge('connectedSessions', sessionSockets.size);
    }, PRUNE_INTERVAL_MS);

    // ── Idempotency cache prune ─────────────────────────────────────────
    const idempotencyPruneInterval = setInterval(() => {
      idempotencyCache.prune();
    }, 30000);

    // ── Command history prune ───────────────────────────────────────────
    const cmdHistoryPruneInterval = setInterval(() => {
      pruneHistory(sessionSockets, hermesPush);
    }, PRUNE_INTERVAL_MS);

    // ── BIND & LISTEN ───────────────────────────────────────────────────
    if (opts.httpServer) {
      // Pre-created server: resolve immediately
      const protocol = tlsOptions ? 'https' : 'http';
      const wsProtocol = tlsOptions ? 'wss' : 'ws';
      log('info', `Hermes Browser Bridge proxy configured on ${protocol}://127.0.0.1:${port}`, {
        version,
        node: process.version,
        pid: process.pid,
        wsUrl: `${wsProtocol}://127.0.0.1:${port}`,
        hermesWsUrl: `${wsProtocol}://127.0.0.1:${port}/hermes`,
        rateLimitRps: RATE_LIMIT_RPS,
        rateLimitBurst: RATE_LIMIT_BURST,
        backpressureThresholdMs: cfg.BACKPRESSURE_THRESHOLD_MS,
      });
      resolve({ httpServer, wss, wssHermes });
    } else {
      httpServer.listen(port, '127.0.0.1', () => {
        const protocol = tlsOptions ? 'https' : 'http';
        const wsProtocol = tlsOptions ? 'wss' : 'ws';
        log('info', `Hermes Browser Bridge proxy server listening on ${protocol}://127.0.0.1:${port}`, {
          version,
          node: process.version,
          pid: process.pid,
          wsUrl: `${wsProtocol}://127.0.0.1:${port}`,
          hermesWsUrl: `${wsProtocol}://127.0.0.1:${port}/hermes`,
          rateLimitRps: RATE_LIMIT_RPS,
          rateLimitBurst: RATE_LIMIT_BURST,
          backpressureThresholdMs: cfg.BACKPRESSURE_THRESHOLD_MS,
        });
        resolve({ httpServer, wss, wssHermes });
      });
    }

    httpServer.on('error', (err) => {
      log('error', 'Proxy server failure', { err: err.message });
    });
  });
}

module.exports = { startProxy };
