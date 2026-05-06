/**
 * logger.js — Structured JSON logging for the proxy server.
 */

'use strict';

const cfg = require('../config');

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LOG_LEVEL = LOG_LEVELS[cfg.LOG_LEVEL] !== undefined ? LOG_LEVELS[cfg.LOG_LEVEL] : LOG_LEVELS.info;

/**
 * Structured JSON logger — emits one JSON object per line to stdout.
 * Only logs messages at or above the configured LOG_LEVEL.
 *
 * @param {string} level - One of: debug, info, warn, error
 * @param {string} msg - Log message
 * @param {object} [extras={}] - Additional fields to include in the entry
 */
function log(level, msg, extras = {}) {
  if (LOG_LEVELS[level] === undefined || LOG_LEVELS[level] < CURRENT_LOG_LEVEL) return;
  const entry = {
    ts: new Date().toISOString(),
    lvl: level,
    msg,
    pid: process.pid,
    ...extras
  };
  console.log(JSON.stringify(entry, (k, v) => {
    if (k === 'token' || k === 'auth' || k === 'pwd' || k === 'password') return '[REDACTED]';
    return v;
  }));
}

module.exports = { log, LOG_LEVELS, CURRENT_LOG_LEVEL };
