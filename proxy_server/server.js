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

// M7: Structured logging — JSON lines consistent with proxy_lib.js
function log(level, msg, extras = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...extras };
  const str = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') console.error(str);
  else console.log(str);
}

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
    log('info', 'Hermes Browser Bridge proxy running (HTTP)', { port: PORT, host: HOST, mode: 'http' });
    log('info', 'HTTP REST server started', { addr: `http://${HOST}:${PORT}` });
    log('info', 'WebSocket server started', { addr: `ws://${HOST}:${PORT}` });
    log('info', 'Registered HTTP endpoints:', { endpoints: ['GET /health', 'GET /metrics', 'GET /sessions', 'POST /sessions/:id/activate', 'GET /page_state', 'POST /command', 'GET /command/:cmdId', 'DELETE /command/:cmdId', 'GET /last_seq', 'GET /commands/history', 'GET /config', 'WS / (extension)', 'WS /hermes (Hermes)'] });









    log('info', 'Extension WebSocket endpoint', { addr: `ws://${HOST}:${PORT}` });
    log('info', 'Hermes Agent WebSocket endpoint', { addr: `ws://${HOST}:${PORT}/hermes` });
  });

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log('error', `Port ${PORT} is already in use`, { port: PORT, code: 'EADDRINUSE' });
      process.exit(1);
    }
    throw err;
  });

  process.on('SIGINT', () => {
    log('info', 'Shutting down…');
    proxy.shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    log('info', 'Shutting down…');
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
    log('error', 'Failed to load TLS certificates from ../certificates/', { err: e.message, hint: 'Run: ./scripts/generate-certs.sh' });

    process.exit(1);
  }

  // Fix #20: Check certificate expiry on startup to prevent cryptic connection failures
  try {
    const certObj = tlsOptions.cert;
    const certLines = certObj.split('\n');
    let certBase64 = '';
    let inCert = false;
    for (const line of certLines) {
      if (line === '-----BEGIN CERTIFICATE-----') inCert = true;
      if (inCert && !line.startsWith('-----')) certBase64 += line.trim();
      if (line === '-----END CERTIFICATE-----') break;
    }
    const certBuffer = Buffer.from(certBase64, 'base64');
    const asn1 = certBuffer;
    // Certificate expiry is at index offset in ASN.1 structure — use Node's crypto instead
    const { X509Certificate } = require('node:crypto');
    const x509 = new X509Certificate(certObj);
    const notBefore = x509.validFrom;
    const notAfter = x509.validTo;
    const now = new Date();
    const expiresAt = new Date(notAfter);
    const daysUntilExpiry = Math.floor((expiresAt - now) / (1000 * 60 * 60 * 24));
    if (daysUntilExpiry < 0) {
      log('error', 'TLS certificate has EXPIRED', { expiredAt: notAfter, expiredDaysAgo: Math.abs(daysUntilExpiry) });
      process.exit(1);
    } else if (daysUntilExpiry < 30) {
      log('warn', 'TLS certificate expires soon', { expiresAt: notAfter, daysRemaining: daysUntilExpiry });
    } else {
      log('info', 'TLS certificate loaded', { expiresAt: notAfter, daysRemaining: daysUntilExpiry });
    }
  } catch (e) {
    log('warn', 'Could not verify TLS certificate expiry', { err: e.message });
  }

  const httpServer = https.createServer(tlsOptions);
  const proxy = createProxy({ httpServer, tlsOptions, version: PKG_VERSION });

  httpServer.listen(PORT, HOST, () => {
    log('info', 'Hermes Browser Bridge proxy running (HTTPS)', { port: PORT, host: HOST, mode: 'https' });
    log('info', 'HTTPS REST server started', { addr: `https://${HOST}:${PORT}` });
    log('info', 'WSS server started', { addr: `wss://${HOST}:${PORT}` });
    log('warn', 'Using self-signed TLS certificate — browser will show a security warning');
    log('info', 'Install ../certificates/ca.crt into Keychain to suppress the warning');
    log('info', 'Registered HTTP endpoints:', { endpoints: ['GET /health', 'GET /metrics', 'GET /sessions', 'POST /sessions/:id/activate', 'GET /page_state', 'POST /command', 'GET /command/:cmdId', 'DELETE /command/:cmdId', 'GET /last_seq', 'GET /commands/history', 'GET /config', 'WS / (extension)', 'WS /hermes (Hermes)'] });









  });

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log('error', `Port ${PORT} is already in use`, { port: PORT, code: 'EADDRINUSE' });
      process.exit(1);
    }
    throw err;
  });

  process.on('SIGINT', () => {
    log('info', 'Shutting down…');
    proxy.shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    log('info', 'Shutting down…');
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
