/**
 * idempotency.js — IdempotencyCache for deduplicating commands.
 */

'use strict';

const { createHash } = require('crypto');
const cfg = require('../config');

const IDEMPOTENCY_WINDOW_MS = cfg.IDEMPOTENCY_WINDOW_MS;

class IdempotencyCache {
  constructor() {
    /** @type {Map<string, { cmdId: string, timestamp: number }>} */
    this._cache = new Map();
  }

  _hash(cmd) {
    return createHash('sha256').update(JSON.stringify(cmd)).digest('hex').slice(0, 32);
  }

  _key(sessionId, idempotencyKey) {
    return `${sessionId}:${idempotencyKey}`;
  }

  check(sessionId, idempotencyKey, cmd) {
    if (!idempotencyKey) return { duplicate: false, existingCmdId: null };
    const k = this._key(sessionId, idempotencyKey);
    const entry = this._cache.get(k);
    if (!entry) return { duplicate: false, existingCmdId: null };
    const age = Date.now() - entry.timestamp;
    if (age > IDEMPOTENCY_WINDOW_MS) {
      this._cache.delete(k);
      return { duplicate: false, existingCmdId: null };
    }
    return { duplicate: true, existingCmdId: entry.cmdId };
  }

  record(sessionId, idempotencyKey, cmdId, cmd) {
    if (!idempotencyKey) return;
    const k = this._key(sessionId, idempotencyKey);
    this._cache.set(k, { cmdId, timestamp: Date.now() });
  }

  prune() {
    const cutoff = Date.now() - IDEMPOTENCY_WINDOW_MS;
    for (const [k, v] of this._cache) {
      if (v.timestamp < cutoff) this._cache.delete(k);
    }
  }
}

module.exports = { IdempotencyCache };
