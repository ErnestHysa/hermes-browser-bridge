/**
 * rateLimiter.js — Token-bucket rate limiter with burst support.
 */

'use strict';

const cfg = require('../config');

const RATE_LIMIT_RPS = cfg.RATE_LIMIT_RPS;
const RATE_LIMIT_BURST = cfg.RATE_LIMIT_BURST;

class RateLimiter {
  constructor(maxTokens = RATE_LIMIT_RPS, windowMs = 1000, burstSize = RATE_LIMIT_BURST) {
    this.maxTokens = maxTokens;
    this.windowMs = windowMs;
    this.burstSize = burstSize;
    this.tokens = burstSize;
    this.lastRefill = Date.now();
  }

  tryConsume() {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  _refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const intervals = Math.floor(elapsed / this.windowMs);
    if (intervals > 0) {
      const refill = Math.min(this.maxTokens * intervals, Math.floor(elapsed / this.windowMs * this.maxTokens));
      this.tokens = Math.min(this.maxTokens, this.tokens + refill);
      this.lastRefill += intervals * this.windowMs;
    }
  }

  get available() {
    this._refill();
    return Math.floor(this.tokens);
  }
}

module.exports = { RateLimiter, RATE_LIMIT_RPS, RATE_LIMIT_BURST };
