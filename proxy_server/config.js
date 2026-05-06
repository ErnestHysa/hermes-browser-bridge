/**
 * config.js — Hermes Browser Bridge runtime configuration
 *
 * ⚠️ INFO-22: HBS_AUTH_TOKEN is read once at startup — there is no hot-reload mechanism.
 *   If the token needs to be rotated, the proxy process must be restarted. A future version
 *   could add POST /admin/reload-config or support SIGHUP to reload without restart.
 *
 * ⚠️ INFO-23: Prometheus metrics (metrics.js) include counters and gauges but lack histogram
 *   buckets for computing percentile latencies (p50/p95/p99). metricHistogramObserve is called
 *   in some places but no histograms are registered with prom-client. Add histogram metrics
 *   for: command latency, snapshot sizes, mutation batch sizes.
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

// F20: CORS / Origin validation — comma-separated list of allowed origins.
// Defaults to localhost variants. Set to '*' to allow any origin (not recommended).
// Safari file:// pages send origin 'null' — it's always allowed.
// R54: HTTPS origins added for deployments running the proxy with TLS enabled.
const ALLOWED_ORIGINS = (process.env.HBS_ALLOWED_ORIGINS || 'null,http://localhost,http://localhost:9321,http://127.0.0.1,http://127.0.0.1:9321,https://localhost,https://localhost:9321,https://127.0.0.1,https://127.0.0.1:9321').split(',').map(o => o.trim());

// ─── Command Queue ─────────────────────────────────────────────────────────────

const CMD_TIMEOUT_MS = parseInt(process.env.HBS_CMD_TIMEOUT_MS || '30000', 10);
const IDEMPOTENCY_WINDOW_MS = parseInt(process.env.HBS_IDEMPOTENCY_WINDOW_MS || '30000', 10);

// ─── Session (Fix #5) ────────────────────────────────────────────────────────────
// R56: SESSION_TTL_MS and SESSION_TIMEOUT_MS serve different purposes:
// - SESSION_TTL_MS (5min default): How long a disconnected session's page state is
//   retained in the proxy's pageMirror before being evicted. If an extension reconnects
//   within TTL, its session state (page HTML, mutations) is still available.
// - SESSION_TIMEOUT_MS (10min default): How long to wait for a session to reconnect
//   before cleaning up its WebSocket and evicting it. This is a hard cleanup boundary
//   that runs regardless of whether the session is connected.
const SESSION_TTL_MS = parseInt(process.env.HBS_SESSION_TTL_MS || '300000', 10);
const SESSION_TIMEOUT_MS = parseInt(process.env.HBS_SESSION_TIMEOUT_MS || '600000', 10);
const PER_SESSION_RATE_LIMIT = parseInt(process.env.HBS_PER_SESSION_RATE_LIMIT || '100', 10);

// ─── HTML Snapshot Limits ─────────────────────────────────────────────────────

const MAX_BODY_BYTES = parseInt(process.env.HBS_MAX_BODY_BYTES || (1 * 1024 * 1024).toString(), 10);
const MAX_HTML_BYTES = parseInt(process.env.HBS_MAX_HTML_BYTES || (10 * 1024 * 1024).toString(), 10);

const LOG_LEVEL = process.env.HBS_LOG_LEVEL || 'info';

module.exports = {
  RATE_LIMIT_RPS,
  RATE_LIMIT_BURST,
  BACKPRESSURE_THRESHOLD_MS,
  METRICS_ENABLED,
  METRICS_FLUSH_INTERVAL_MS,
  CMD_TIMEOUT_MS,
  IDEMPOTENCY_WINDOW_MS,
  SESSION_TTL_MS,
  SESSION_TIMEOUT_MS,
  PER_SESSION_RATE_LIMIT,
  MAX_BODY_BYTES,
  MAX_HTML_BYTES,
  LOG_LEVEL
};
