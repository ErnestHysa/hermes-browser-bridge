/**
 * server.js — Hermes Browser Bridge Proxy Server
 * HTTP REST API + WebSocket server for the Safari extension.
 * Pure Node.js (built-in modules only).
 *
 * Usage: node server.js
 * Runs on: http://localhost:9321 + ws://localhost:9321
 */

const http = require('node:http');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');

const { CommandQueue } = require('./cmd_queue');
const { PageMirror } = require('./page_mirror');

const PORT = 9321;
const HOST = '0.0.0.0';

// ─── Shared state ────────────────────────────────────────────────────────────

const pageMirror = new PageMirror();
const cmdQueue = new CommandQueue(30000);
const ee = new EventEmitter(); // Internal event bus

// ─── Utility ──────────────────────────────────────────────────────────────────

function jsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
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

// ─── WebSocket Server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ host: HOST, port: PORT });

wss.on('connection', (ws, req) => {
  console.log(`[WS] Extension connected from ${req.socket.remoteAddress}`);
  ws.isAlive = true;
  pageMirror.setConnected(true, null);

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch (e) { console.error('[WS] Invalid message:', raw); return; }

    console.log(`[WS] ← ${msg.type}`);

    switch (msg.type) {
      case 'tab_snapshot':
        pageMirror.updateSnapshot(msg);
        ee.emit('snapshot', msg);
        break;

      case 'mutation':
        pageMirror.addMutations(msg);
        ee.emit('mutation', msg);
        break;

      case 'heartbeat':
        pageMirror.setConnected(true, msg.tabId);
        break;

      case 'cmd_ack':
        cmdQueue.ack(msg.cmdId, msg.result);
        ee.emit('cmd_ack', msg);
        break;

      case 'cmd_error':
        cmdQueue.error(msg.cmdId, msg.error);
        ee.emit('cmd_error', msg);
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

  // Send welcome
  ws.send(JSON.stringify({ type: 'connected', message: 'Hermes Browser Bridge proxy ready' }));
});

// Heartbeat: ping WS clients every 30s
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

// Broadcast to all connected extension clients
function broadcastToExtension(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === 1 /* OPEN */) {
      client.send(data);
    }
  });
}

// ─── HTTP REST API ───────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    jsonResponse(res, 204, {});
    return;
  }

  // ── GET /health ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/health') {
    jsonResponse(res, 200, {
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      connected: pageMirror.connected,
      pendingCommands: cmdQueue.size,
      wsClients: wss.clients.size
    });
    return;
  }

  // ── GET /page_state ──────────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/page_state') {
    const state = pageMirror.getState();
    if (!pageMirror.connected) {
      jsonResponse(res, 200, {
        connected: false,
        message: 'No extension connected. Click "Activate Tab" in the Safari extension popup.'
      });
      return;
    }
    jsonResponse(res, 200, state);
    return;
  }

  // ── POST /command ────────────────────────────────────────────────────────
  if (req.method === 'POST' && path === '/command') {
    let body;
    try { body = await parseBody(req); }
    catch (e) { jsonResponse(res, 400, { error: e.message }); return; }

    const { type, selector, url, x, y, text, script } = body;
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
    const cmd = { type, cmdId, selector, url, x, y, text, script };

    // Send to extension via WebSocket
    broadcastToExtension(cmd);
    console.log(`[HTTP] → Extension: ${type} (${cmdId})`);

    // Register with command queue (returns promise)
    cmdQueue.add(cmdId, cmd).then((result) => {
      console.log(`[CMD] ${cmdId} resolved:`, result.success ? 'OK' : result.error);
    }).catch((err) => {
      console.warn(`[CMD] ${cmdId} failed:`, err.message);
    });

    jsonResponse(res, 202, { cmdId, status: 'pending', message: `Command queued, poll GET /command/${cmdId}` });
    return;
  }

  // ── GET /command/:cmdId ──────────────────────────────────────────────────
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

  // 404
  jsonResponse(res, 404, { error: 'Not found. Available: GET /health, GET /page_state, POST /command, GET /command/:cmdId' });
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, HOST, () => {
  console.log(`Hermes Browser Bridge proxy running`);
  console.log(`  HTTP REST: http://${HOST}:${PORT}`);
  console.log(`  WebSocket: ws://${HOST}:${PORT}`);
  console.log('');
  console.log('Waiting for extension to connect…');
  console.log('');
  console.log('Endpoints:');
  console.log('  GET  /health          → proxy health');
  console.log('  GET  /page_state      → current tab snapshot');
  console.log('  POST /command         → send command to extension');
  console.log('  GET  /command/:cmdId  → poll command result');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`ERROR: Port ${PORT} is already in use.`);
    console.error('Stop the existing server or change PORT in server.js');
    process.exit(1);
  }
  throw err;
});
