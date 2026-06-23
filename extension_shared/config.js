/**
 * config.js — Shared configuration constants for all Hermes Bridge components.
 *
 * Imported by both proxy server and extension code to keep configuration
 * centralized. All tunables that were scattered across multiple files
 * are now defined here.
 */

'use strict';

// ─── Network ───────────────────────────────────────────────────────────────

/** Default proxy WebSocket port (also used for HTTP health/dashboard) */
const DEFAULT_PROXY_PORT = 9321;

// ─── WebSocket / Connection ────────────────────────────────────────────────

/** Maximum reconnect delay (ms) — exponential backoff ceiling */
const MAX_RECONNECT_DELAY_MS = 30000;

/** Initial reconnect delay (ms) for exponential backoff */
const INITIAL_RECONNECT_DELAY_MS = 2000;

/** Maximum number of messages queued while disconnected */
const MAX_PENDING_MESSAGES = 50;

/** Interval (ms) between health checks to the proxy */
const HEALTH_POLL_INTERVAL_MS = 10000;

// ─── Command Handling ──────────────────────────────────────────────────────

/** Maximum pending command types tracked (LRU cap) */
const MAX_PENDING_CMD_TYPES = 200;

// ─── Page Mirror ───────────────────────────────────────────────────────────

/** Max age of full HTML snapshots before they're considered stale (ms) */
const HTML_TTL_MS = 60_000;

/** Max age of DOM mutation records before eviction (ms) */
const MUTATION_TTL_MS = 120_000;

/** Maximum buffered mutation entries before applying backpressure */
const MUTATION_BUFFER_MAX = 2000;

// ─── Command Queue ─────────────────────────────────────────────────────────

/** Maximum completed commands retained in history */
const MAX_COMPLETED_CMDS = 2000;

// ─── Command History ───────────────────────────────────────────────────────

/** Maximum command history entries stored in browser extension */
const CMD_HISTORY_MAX = 50;

// ─── Popup / UI ────────────────────────────────────────────────────────────

/** Maximum command log entries displayed in popup */
const MAX_CMD_LOG = 5;

/** localStorage key for popup command log persistence */
const CMD_LOG_KEY = 'hermes_cmd_log';

// ─── Storage Keys ──────────────────────────────────────────────────────────

const SESSION_STORAGE_KEY = 'hermesSessionId';
const PROXY_PORT_STORAGE_KEY = 'hbsProxyPort';

// ─── Rate Limiter ──────────────────────────────────────────────────────────

/** Default rate limit window (ms) */
const RATE_LIMIT_WINDOW_MS = 1000;

/** Default max tokens per window */
const RATE_LIMIT_MAX_TOKENS = 10;

// ─── Command Queue Timing ──────────────────────────────────────────────────

/** Timeout (ms) for command execution before failing */
const CMD_TIMEOUT_MS = 30_000;

/** Delay between command queue processing iterations (ms) */
const CMD_QUEUE_POLL_MS = 100;

// ─── Export ────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    // Network
    DEFAULT_PROXY_PORT,

    // Connection
    MAX_RECONNECT_DELAY_MS,
    INITIAL_RECONNECT_DELAY_MS,
    MAX_PENDING_MESSAGES,
    HEALTH_POLL_INTERVAL_MS,

    // Commands
    MAX_PENDING_CMD_TYPES,

    // Page Mirror
    HTML_TTL_MS,
    MUTATION_TTL_MS,
    MUTATION_BUFFER_MAX,

    // Command Queue
    MAX_COMPLETED_CMDS,

    // History
    CMD_HISTORY_MAX,

    // Popup
    MAX_CMD_LOG,
    CMD_LOG_KEY,

    // Storage
    SESSION_STORAGE_KEY,
    PROXY_PORT_STORAGE_KEY,

    // Rate Limiter
    RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_MAX_TOKENS,

    // Timing
    CMD_TIMEOUT_MS,
    CMD_QUEUE_POLL_MS,
  };
}
