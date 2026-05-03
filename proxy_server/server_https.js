/**
 * server_https.js — Hermes Browser Bridge Proxy Server (HTTPS variant)
 *
 * Identical to server.js but adds TLS/HTTPS support using the self-signed
 * CA certificate in ../certificates/. This is useful if you want to expose
 * the proxy to other machines on your network (e.g. a second Mac on the same
 * LAN) or if a site refuses HTTP connections.
 *
 * Usage: node server_https.js
 * Runs on: https://localhost:9322 + wss://localhost:9322
 *
 * ⚠️  Self-signed certs will cause a browser warning.
 *     Install the CA cert from ../certificates/ca.crt into Keychain first.
 *     See: ../certificates/README.md
 */

const https = require('node:https');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');

const { CommandQueue } = require('./cmd_queue');
const { PageMirror } = require('./page_mirror');

const PORT = 9322;
const HOST = '0.0.0.0';

// Load TLS cert/key from certificates/
const TLS_DIR = __dirname + '/../certificates';
let tlsOptions;
try {
  tlsOptions = {
    cert: readFileSync(`${TLS_DIR}/ca.crt`),
    key: readFileSync(`${TLS_DIR}/ca.key`)
  };
} catch (e) {
  console.error('[HTTPS] Failed to load TLS certificates from ../certificates/:', e.message);
  console.error('[HTTPS] Run: cd certificates && ./generate.sh  (or create ca.crt + ca.key manually)');
  process.exit(1);
}

// ─── Shared state ────────────────────────────────────────────────────────────

const pageMirror = new PageMirror();
const cmdQueue = new CommandQueue(30000);

// ─── Utility ────────────────────────────────────────────────────────────────

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

// ─── WebSocket Server (shares the HTTPS server) ───────────────────────────

const server = https.createServer(tlsOptions);
const wss = new WebSocketServer({ server });

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
        break;
      case 'mutation':
        pageMirror.addMutations(msg);
        break;
      case 'heartbeat':
        pageMirror.setConnected(true, msg.tabId ?? null);
        break;
      case 'cmd_ack':
        cmdQueue.ack(msg.cmdId, msg.result);
        break;
      case 'cmd_error':
        cmdQueue.error(msg.cmdId, msg.error);
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

  ws.send(JSON.stringify({ type: 'connected', message: 'Hermes Browser Bridge proxy ready (HTTPS)' }));
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

// Periodic prune of old completed commands
const pruneInterval = setInterval(() => cmdQueue.prune(60000), 120000);

function broadcastToExtension(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === 1 /* OPEN */) {
      client.send(data);
    }
  });
}

// ─── HTTP REST API ─────────────────────────────────────────────────────────

server.on('request', async (req, res) => {
  const url = new URL(req.url, `https://${HOST}:${PORT}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    jsonResponse(res, 204, {});
    return;
  }

  if (req.method === 'GET' && path === '/health') {
    jsonResponse(res, 200, {
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      connected: pageMirror.connected,
      pendingCommands: cmdQueue.size,
      wsClients: wss.clients.size,
      tls: true
    });
    return;
  }

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

  if (req.method === 'POST' && path === '/command') {
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
    console.log(`[HTTPS] → Extension: ${type} (${cmdId})`);

    jsonResponse(res, 202, { cmdId, status: 'pending', message: `Command queued. Poll GET /command/${cmdId}` });
    return;
  }

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

  jsonResponse(res, 404, { error: 'Not found.' });
});

// ─── Start ─────────────────────────────────────────────────────────────────

server.listen(PORT, HOST, () => {
  console.log('Hermes Browser Bridge proxy running (HTTPS)');
  console.log(`  HTTPS REST: https://${HOST}:${PORT}`);
  console.log(`  WSS:       wss://${HOST}:${PORT}`);
  console.log('');
  console.log('⚠️  Using self-signed certificate — browser will show a warning.');
  console.log('   Install ../certificates/ca.crt into Keychain to suppress it.');
  console.log('');
  console.log('Endpoints:');
  console.log('  GET  /health');
  console.log('  GET  /page_state');
  console.log('  POST /command');
  console.log('  GET  /command/:cmdId');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`ERROR: Port ${PORT} is already in use.`);
    process.exit(1);
  }
  throw err;
});

process.on('SIGINT', () => {
  console.log('\nShutting down…');
  clearInterval(heartbeat);
  clearInterval(pruneInterval);
  wss.close();
  server.close();
  process.exit(0);
});
