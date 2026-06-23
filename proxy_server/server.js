/**
 * server.js — Hermes Browser Bridge Proxy Server entry point.
 *
 * Usage:
 *   node server.js             HTTP on port 9321 (default)
 *   node server.js --https     HTTPS on port 9322 (requires certificates/)
 *
 * All logic lives in proxy_lib.js. This is a thin wrapper.
 */

'use strict';

const http = require('node:http');
const https = require('node:https');
const { readFileSync } = require('node:fs');
const { startProxy } = require('./proxy_lib');
const { reload } = require('./lib/authToken');

const HOST = '127.0.0.1';

let PKG_VERSION = '1.3.2';
try {
  const pkg = JSON.parse(readFileSync(require.resolve('./package.json'), 'utf-8'));
  PKG_VERSION = pkg.version || PKG_VERSION;
} catch (e) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), lvl: 'error', msg: 'Failed to read package.json version', err: e.message }));
}

function startHttp() {
  const PORT = parseInt(process.env.HBS_PORT || '9321', 10);
  const httpServer = http.createServer();

  startProxy({ httpServer, port: PORT, version: PKG_VERSION })
    .then(({ wss, wssHermes }) => {
      httpServer.listen(PORT, HOST, () => {
        console.log(JSON.stringify({ ts: new Date().toISOString(), lvl: 'info', msg: 'Hermes Browser Bridge running (HTTP)', port: PORT, host: HOST }));
      });

      httpServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.error(JSON.stringify({ ts: new Date().toISOString(), lvl: 'error', msg: `Port ${PORT} is already in use` }));
          process.exit(1);
        }
        throw err;
      });

      setupShutdown(httpServer);
    });
}

function startHttps() {
  const PORT = parseInt(process.env.HBS_HTTPS_PORT || '9322', 10);
  const TLS_DIR = __dirname + '/../certificates';

  let tlsOptions;
  try {
    tlsOptions = {
      cert: readFileSync(`${TLS_DIR}/ca.crt`),
      key: readFileSync(`${TLS_DIR}/ca.key`),
    };
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), lvl: 'error', msg: 'Failed to load TLS certificates', hint: 'Run: ./generate_certs.sh' }));
    process.exit(1);
  }

  // Check cert expiry
  try {
    const { X509Certificate } = require('node:crypto');
    const x509 = new X509Certificate(tlsOptions.cert);
    const daysUntilExpiry = Math.floor((new Date(x509.validTo) - new Date()) / (1000 * 60 * 60 * 24));
    if (daysUntilExpiry < 0) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), lvl: 'error', msg: 'TLS certificate EXPIRED', expiredAt: x509.validTo }));
      process.exit(1);
    }
    if (daysUntilExpiry < 30) {
      console.warn(JSON.stringify({ ts: new Date().toISOString(), lvl: 'warn', msg: 'TLS certificate expires soon', expiresAt: x509.validTo, daysRemaining: daysUntilExpiry }));
    }
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), lvl: 'error', msg: 'Certificate validation failed', err: e.message }));
  }

  const httpServer = https.createServer(tlsOptions);

  startProxy({ httpServer, tlsOptions, port: PORT, version: PKG_VERSION })
    .then(() => {
      httpServer.listen(PORT, HOST, () => {
        console.log(JSON.stringify({ ts: new Date().toISOString(), lvl: 'info', msg: 'Hermes Browser Bridge running (HTTPS)', port: PORT, host: HOST }));
      });

      httpServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.error(JSON.stringify({ ts: new Date().toISOString(), lvl: 'error', msg: `Port ${PORT} is already in use` }));
          process.exit(1);
        }
        throw err;
      });

      setupShutdown(httpServer);
    });
}

function setupShutdown(httpServer) {
  let shuttingDown = false;
  const handler = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ ts: new Date().toISOString(), lvl: 'info', msg: 'Shutting down' }));
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  process.on('SIGHUP', () => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), lvl: 'info', msg: 'Received SIGHUP — reloading config' }));
    reload();
  });
}

const useHttps = process.argv.includes('--https');
if (useHttps) {
  startHttps();
} else {
  startHttp();
}
