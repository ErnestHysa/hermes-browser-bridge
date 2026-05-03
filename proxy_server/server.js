/**
 * server.js — Hermes Browser Bridge Proxy Server (HTTP)
 * Thin wrapper around proxy_lib.js. All logic lives in proxy_lib.js.
 *
 * Usage: node server.js
 * Runs on: http://localhost:9321 + ws://localhost:9321
 */

const http = require('node:http');
const { createProxy } = require('./proxy_lib');

const PORT = 9321;
const HOST = '0.0.0.0';

const httpServer = http.createServer();
const proxy = createProxy({ httpServer });

httpServer.listen(PORT, HOST, () => {
  console.log('Hermes Browser Bridge proxy running (HTTP)');
  console.log(`  HTTP REST: http://${HOST}:${PORT}`);
  console.log(`  WebSocket: ws://${HOST}:${PORT}`);
  console.log('');
  console.log('Endpoints:');
  console.log('  GET  /health          → proxy health + rate limit status');
  console.log('  GET  /page_state      → current tab snapshot');
  console.log('  POST /command         → send command to extension');
  console.log('  GET  /command/:cmdId  → poll command result');
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
