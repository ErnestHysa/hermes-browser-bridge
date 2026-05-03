/**
 * smoke.test.js — Playwright-based smoke tests for the Hermes Browser Bridge
 *
 * Run from the project root:
 *   npm install --save-dev playwright @playwright/test
 *   npx playwright install chromium
 *   node tests/smoke.test.js
 *
 * For running smoke tests (requires the proxy server to already be running):
 *   node tests/smoke.test.js
 *
 * For running the shell smoke test (starts/stops the proxy automatically):
 *   bash tests/smoke_test.sh
 *
 * These are LOCAL smoke tests — they verify the proxy server, WebSocket,
 * and HTTP endpoints without requiring the Safari/Chrome extension to be installed.
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const PROXY_PORT = 9321;
const PROXY_URL = `http://localhost:${PROXY_PORT}`;
const WS_URL = `ws://localhost:${PROXY_PORT}`;
const HERMES_WS_URL = `ws://localhost:${PROXY_PORT}/hermes`;

let server = null;
let serverExited = false;

// ── Server lifecycle ────────────────────────────────────────────────────────

function startProxyServer() {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, '..', 'proxy_server', 'server.js');
    server = spawn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test', PORT: String(PROXY_PORT) },
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) reject(new Error('Server startup timeout (10s)'[truncated]