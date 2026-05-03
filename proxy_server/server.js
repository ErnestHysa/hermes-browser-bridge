/**
 * server.js — Hermes Browser Bridge Proxy Server
 *
 * Usage:
 *   node server.js             HTTP on port 9321 (default)
 *   node server.js --https     HTTPS on port 9322 (requires certificates/)
 *
 * All logic lives in proxy_lib.js. This is a thin wrapper.
 *
 * Fix #21: Merged HTTP and HTTPS servers into one binary with --https flag.
 *            HTTPS uses self-signed CA cert from certificates/ directory.
 */

'use strict';

const http = require('node:http');
const https = require('node:https');
const { readFileSync, existsSync } = require('node:fs');
const { createProxy } = require('./proxy_lib');

const HOST = '127.0.0.1';  // Fix #C4: localhost only — prevents LAN exposure

// Fix #19: Read version from package.json to avoid hardcoded drift
let PKG_VERSION = '1.0.0';
try {
  const { readFileSync: _readFileSync } = require('node:fs');
  const pkg = JSON.parse(_readFileSync(require.resolve('./package.json'), 'utf-8'));
  PKG_VERSION = pkg.version || PKG_VERSION;
} catch (_) { /* use fallback */ }

function startHttp() {
  const PORT = parseInt(process.env.HBS_PORT || '9321', 10);
  const httpServer = http.createServer();
  const proxy = createProxy({ httpServer, version: PKG_VERSION });

  httpServer.listen(PORT, HOST, () => {
    console.log('Hermes Browser Bridge proxy running (HTTP)');
    console.log(`  HTTP REST: http://${HOST}:${PORT}`);
    console.log(`  WebSocket: ws://${HOST}:${PORT}`);
    console.log('');
    console.log('Endpoints:');
    console.log('  GET    /health           → proxy health + rate limit status');
    console.log('  GET    /metrics          → Prometheus-compatible metrics');
    console.log('  GET    /sessions          → list active sessions');
    console.log('  POST   /sessions/:id/activate');
    console.log('  GET    /page_state       → current tab snapshot');
    console.log('  POST   /command           → send command to extension');
    console.log('  GET    /command/:cmdId    → poll command result');
    console.log('  DELETE /command/:cmdId    → cancel pending command');
    console.log('  GET    /last_seq');
    console.log('');
    console.log('  WebSocket: ws://localhost:9321 (extension)');
    console.log('             ws://localhost:9321/hermes (Hermes Agent)');
  });

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`ERROR: Port ${PORT} is already in use.`);
      process.exit(1);
    }
    throw err;
  });

  process.on('SIGINT', () => {
    console.log('\nShutting down…');
    proxy.shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\nShutting down…');
    proxy.shutdown();
    process.exit(0);
  });
}

function startHttps() {
  const PORT = parseInt(process.env.HBS_HTTPS_PORT || '9322', 10);
  const TLS_DIR = __dirname + '/../certificates';
  let tlsOptions;

  try {
    tlsOptions = {
      cert: readFileSync(`${TLS_DIR}/ca.crt`),
      key: readFileSync(`${TLS_DIR}/ca.key`)
    };
  } catch (e) {
    console.error('[HTTPS] Failed to load TLS certificates from ../certificates/:', e.message);
    console.error('[HTTPS] Run: ./scripts/generate-certs.sh');
    process.exit(1);
  }

  const httpServer = https.createServer(tlsOptions);
  const proxy = createProxy({ httpServer, tlsOptions, version: PKG_VERSION });

  httpServer.listen(PORT, HOST, () => {
    console.log('Hermes Browser Bridge proxy running (HTTPS)');
    console.log(`  HTTPS REST: https://${HOST}:${PORT}`);
    console.log(`  WSS:       wss://${HOST}:${PORT}`);
    console.log('');
    console.log('NOTE: Using self-signed certificate — browser will show a warning.');
    console.log('      Install ../certificates/ca.crt into Keychain to suppress it.');
    console.log('');
    console.log('Endpoints:');
    console.log('  GET    /health           → proxy health + rate limit status');
    console.log('  GET    /metrics          → Prometheus-compatible metrics');
    console.log('  GET    /sessions         → list active sessions');
    console.log('  POST   /sessions/:id/activate');
    console.log('  GET    /page_state       → current tab snapshot');
    console.log('  POST   /command          → send command to extension');
    console.log('  GET    /command/:cmdId   → poll command result');
    console.log('  DELETE /command/:cmdId   → cancel pending command');
    console.log('  GET    /last_seq');
  });

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`ERROR: Port ${PORT} is already in use.`);
      process.exit(1);
    }
    throw err;
  });

  process.on('SIGINT', () => {
    console.log('\nShutting down…');
    proxy.shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\nShutting down…');
    proxy.shutdown();
    process.exit(0);
  });
}

// Entry point
const useHttps = process.argv.includes('--https');
if (useHttps) {
  startHttps();
} else {
  startHttp();
}
