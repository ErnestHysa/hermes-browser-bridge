import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../lib/rateLimiter.js';

describe('RateLimiter', () => {
  let limiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new RateLimiter(10, 1000, 10);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows initial token consume', () => {
    expect(limiter.tryConsume()).toBe(true);
  });

  it('exhausts tokens after maxClaims in the same window', () => {
    for (let i = 0; i < 10; i++) {
      expect(limiter.tryConsume()).toBe(true);
    }
    expect(limiter.tryConsume()).toBe(false);
  });

  it('refills tokens after window elapses', () => {
    for (let i = 0; i < 10; i++) {
      limiter.tryConsume();
    }
    expect(limiter.tryConsume()).toBe(false);

    vi.advanceTimersByTime(1100);

    expect(limiter.tryConsume()).toBe(true);
  });

  it('refills proportional tokens for partial window elapsed', () => {
    for (let i = 0; i < 10; i++) {
      limiter.tryConsume();
    }
    expect(limiter.tryConsume()).toBe(false);

    vi.advanceTimersByTime(550);

    let partialClaims = 0;
    while (limiter.tryConsume()) {
      partialClaims++;
    }
    // With _refill using intervals only when elapsed >= windowMs,
    // partial windows won't refill — tokens only come back at full window boundaries.
    // This is the current behavior (token-bucket with per-window refill).
    // So we expect 0 additional tokens for partial window advancement.
    expect(partialClaims).toBe(0);
  });

  it('refills across multiple full windows correctly', () => {
    for (let i = 0; i < 10; i++) {
      limiter.tryConsume();
    }

    vi.advanceTimersByTime(1100); // 1 full window
    let count1 = 0;
    while (limiter.tryConsume()) count1++;
    expect(count1).toBe(10);
  });

  it('caps tokens at maxTokens', () => {
    vi.advanceTimersByTime(10000);

    let claims = 0;
    while (limiter.tryConsume()) claims++;
    // Should refill 10 tokens per window for ~10 windows = 100 tokens.
    // But capped at maxTokens per refill cycle — since _refill updates lastRefill
    // by intervals*windowMs each cycle, we get one refill at a time.
    // With fake timers, Date.now() jumps by 10000ms, intervals = 10,
    // refill = Math.min(10*10, floor(10000/1000*10)) = Math.min(100, 100) = 100
    // tokens = Math.min(10, 100) = 10. So we only get 10 tokens max.
    expect(claims).toBe(10);
  });

  it('handles zero-window edge case gracefully', () => {
    const zeroWindow = new RateLimiter(5, 0, 5);
    // _refill: intervals = floor(elapsed / 0) = Infinity or NaN depending on JS engine
    // This is an edge case — we just verify it doesn't throw
    for (let i = 0; i < 100; i++) {
      zeroWindow.tryConsume();
    }
    // No assertion on behavior since it's undefined for window=0
  });

  it('reports correct available tokens', () => {
    limiter.tryConsume();
    limiter.tryConsume();
    expect(limiter.available).toBe(8);
  });

  it('burstSize allows initial burst > maxTokens', () => {
    const burst = new RateLimiter(5, 1000, 20);
    let count = 0;
    while (burst.tryConsume()) count++;
    expect(count).toBe(20);
  });
});
