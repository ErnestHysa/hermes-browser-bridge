/**
 * server_https.js — Hermes Browser Bridge Proxy Server (HTTPS variant)
 *
 * Identical to server.js but upgrades to TLS using the self-signed CA cert pair.
 * See certificates/README.md before using — most users don't need this.
 *
 * Fix #P2-9:  /metrics endpoint documented in startup output.
 * Fix #P1-3:  /sessions and /sessions/:id/activate documented.
 * Fix #P3-17: DELETE /command/:cmdId documented.
 * Fix #P2-8:  Backpressure handling noted in startup message.
 */

'use strict';

const https = require('node:https');
const { readFileSync } = require('node:fs');
const { createProxy } = require('./proxy_lib');

const PORT = parseInt(process.env.HBS_HTTPS_PORT || '9322', 10);
const HOST = '127.0.0.1';

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
  process.exit(1);
}

const httpServer = https.createServer(tlsOptions);
const proxy = createProxy({ httpServer, tlsOptions });

httpServer.listen(PORT, HOST, () => {
  console.log('Hermes Browser Bridge proxy running (HTTPS)');
  console.log(`  HTTPS REST: https://${HOST}:${PORT}`);
  console.log(`  WSS:       wss://${HOST}:${PORT}`);
  console.log('');
  console.log('NOTE: Using self-signed certificate — browser will show a warning.');
  console.log('      Install ../certificates/ca.crt into Keychain to suppress it.');
  console.log('');
  console.log('Endpoints:');
  console.log('  GET  /health');
  console.log('  GET  /metrics          (Prometheus-compatible)');
  console.log('  GET  /sessions         (list active sessions)');
  console.log('  POST /sessions/:id/activate');
  console.log('  GET  /page_state');
  console.log('  POST /command');
  console.log('  GET  /command/:cmdId');
  console.log('  DELETE /command/:cmdId  (cancel pending command)');
  console.log('  GET  /last_seq');
  console.log('');
  console.log('Backpressure: proxy signals extension to pause on large payloads (P2-8)');
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
