/**
 * server_https.js — Hermes Browser Bridge Proxy Server (HTTPS)
 * Thin wrapper around proxy_lib.js with TLS support.
 *
 * Identical to server.js but adds HTTPS/WSS using the self-signed CA cert.
 * See certificates/README.md before using this — most users don't need it.
 *
 * Usage: node server_https.js
 * Runs on: https://localhost:9322 + wss://localhost:9322
 */

const https = require('node:https');
const { readFileSync } = require('node:fs');
const { createProxy } = require('./proxy_lib');

const PORT = 9322;
const HOST = '127.0.0.1';  // Fix #C4: localhost only — prevents LAN exposure

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
  console.log('⚠️  Using self-signed certificate — browser will show a warning.');
  console.log('   Install ../certificates/ca.crt into Keychain to suppress it.');
  console.log('');
  console.log('Endpoints:');
  console.log('  GET  /health');
  console.log('  GET  /page_state');
  console.log('  POST /command');
  console.log('  GET  /command/:cmdId');
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
