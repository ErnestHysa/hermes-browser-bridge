/**
 * config.js — Hermes Browser Bridge runtime configuration
 *
 * Fix #P3-14: Rate limit is now fully configurable from this file instead of
 * being hardcoded in proxy_lib.js. Also enables per-setting overrides via env vars.
 *
 * Fix #P2-9: Metrics flush interval configurable (for high-throughput deployments).
 * Fix #P2-8: Backpressure threshold configurable.
 */

'use strict';

// ─── Rate Limiting (Fix #P3-14) ───────────────────────────────────────────────

const RATE_LIMIT_RPS = parseInt(process.env.HBS_RATE_LIMIT_RPS || '20', 10);
const RATE_LIMIT_BURST = parseInt(process.env.HBS_RATE_LIMIT_BURST || '10', 10);

// ─── Backpressure (Fix #P2-8) ─────────────────────────────────────────────────

// ms of estimated send time above which backpressure is triggered
const BACKPRESSURE_THRESHOLD_MS = parseInt(process.env.HBS_BACKPRESSURE_THRESHOLD_MS || '500', 10);

// ─── Metrics (Fix #P2-9) ───────────────────────────────────────────────────────

const METRICS_ENABLED = process.env.HBS_METRICS_ENABLED !== 'false';
const METRICS_FLUSH_INTERVAL_MS = parseInt(process.env.HBS_METRICS_FLUSH_MS || '60000', 10);

// ─── Command Queue ─────────────────────────────────────────────────────────────

const CMD_TIMEOUT_MS = parseInt(process.env.HBS_CMD_TIMEOUT_MS || '30000', 10);
const IDEMPOTENCY_WINDOW_MS = parseInt(process.env.HBS_IDEMPOTENCY_WINDOW_MS || '30000', 10);

// ─── Session ──────────────────────────────────────────────────────────────────

const SESSION_TTL_MS = parseInt(process.env.HBS_SESSION_TTL_MS || '300000', 10);

// ─── HTML Snapshot Limits ─────────────────────────────────────────────────────

const MAX_BODY_BYTES = parseInt(process.env.HBS_MAX_BODY_BYTES || (1 * 1024 * 1024).toString(), 10);
const MAX_HTML_BYTES = parseInt(process.env.HBS_MAX_HTML_BYTES || (10 * 1024 * 1024).toString(), 10);

// ─── Logging ───────────────────────────────────────────────────────────────────

const LOG_LEVEL = process.env.HBS_LOG_LEVEL || 'info';  // 'debug' | 'info' | 'warn' | 'error'

module.exports = {
  RATE_LIMIT_RPS,
  RATE_LIMIT_BURST,
  BACKPRESSURE_THRESHOLD_MS,
  METRICS_ENABLED,
  METRICS_FLUSH_INTERVAL_MS,
  CMD_TIMEOUT_MS,
  IDEMPOTENCY_WINDOW_MS,
  SESSION_TTL_MS,
  MAX_BODY_BYTES,
  MAX_HTML_BYTES,
  LOG_LEVEL,
};
