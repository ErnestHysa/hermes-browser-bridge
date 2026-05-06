/**
 * utils.js — Shared HTTP helpers: auth, jsonResponse, parseBody, HTML escape.
 */

'use strict';

const { createGzip } = require('zlib');
const cfg = require('../config');
const { log } = require('./logger');

const MAX_BODY_BYTES = cfg.MAX_BODY_BYTES;

function validateHttpAuth(req) {
  const expectedToken = process.env.HBS_AUTH_TOKEN || null;
  if (!expectedToken) return { authorized: true };
  const authHeader = req.headers['authorization'] || '';
  const queryToken = new URL(req.url, 'http://localhost').searchParams.get('token');
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (queryToken || '');
  if (!provided) return { authorized: false, reason: 'Missing token. Provide ?token=<auth_token> or Authorization: Bearer <token>' };
  if (provided !== expectedToken) return { authorized: false, reason: 'Invalid token' };
  return { authorized: true };
}

function jsonResponse(res, statusCode, data, extraHeaders = {}) {
  const json = JSON.stringify(data);
  const acceptEncoding = (res.req && res.req.headers && res.req.headers['accept-encoding']) || '';
  const reqId = (res.req && res.req._hermesReqId) || 'unknown';

  const commonHeaders = {
    'Access-Control-Allow-Origin': 'http://localhost:*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Request-Id': reqId,
    ...extraHeaders
  };

  if (acceptEncoding.includes('gzip') && json.length > 1024) {
    const gzip = createGzip();
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
      ...commonHeaders
    });
    gzip.pipe(res);
    gzip.write(json);
    gzip.end();
    return;
  }

  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    ...commonHeaders
  });
  res.end(json);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let body = '';
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { validateHttpAuth, jsonResponse, parseBody, htmlEscape };
