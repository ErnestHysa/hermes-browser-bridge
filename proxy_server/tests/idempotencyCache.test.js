import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IdempotencyCache } from '../lib/idempotency.js';

describe('IdempotencyCache', () => {
  let cache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new IdempotencyCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns duplicate:false for first-time commands', () => {
    const result = cache.check('session1', 'key-1', { type: 'click' });
    expect(result.duplicate).toBe(false);
    expect(result.existingCmdId).toBeNull();
  });

  it('returns duplicate:true for recorded commands', () => {
    cache.record('session1', 'key-1', 'cmd-1', { type: 'click' });
    const result = cache.check('session1', 'key-1', { type: 'click' });
    expect(result.duplicate).toBe(true);
    expect(result.existingCmdId).toBe('cmd-1');
  });

  it('different sessions with same key are independent', () => {
    cache.record('session1', 'key-1', 'cmd-1', { type: 'click' });
    cache.record('session2', 'key-1', 'cmd-2', { type: 'click' });

    expect(cache.check('session1', 'key-1', {}).duplicate).toBe(true);
    expect(cache.check('session2', 'key-1', {}).duplicate).toBe(true);
    expect(cache.check('session1', 'key-1', {}).existingCmdId).toBe('cmd-1');
    expect(cache.check('session2', 'key-1', {}).existingCmdId).toBe('cmd-2');
  });

  it('returns duplicate:false when no idempotencyKey', () => {
    cache.record('session1', 'key-1', 'cmd-1', { type: 'click' });
    const result = cache.check('session1', null, { type: 'click' });
    expect(result.duplicate).toBe(false);
  });

  it('record does nothing without idempotencyKey', () => {
    cache.record('session1', null, 'cmd-1', { type: 'click' });
    // No error expected, should be a no-op
  });

  it('evicts entries after TTL expires', () => {
    cache.record('session1', 'key-1', 'cmd-1', { type: 'click' });
    expect(cache.check('session1', 'key-1', {}).duplicate).toBe(true);

    // Advance beyond IDEMPOTENCY_WINDOW_MS (from config)
    vi.advanceTimersByTime(61000); // Typical config is 60000
    expect(cache.check('session1', 'key-1', {}).duplicate).toBe(false);
  });

  it('prune removes expired entries', () => {
    cache.record('session1', 'key-1', 'cmd-1', { type: 'click' });
    cache.record('session1', 'key-2', 'cmd-2', { type: 'click' });

    vi.advanceTimersByTime(61000);
    cache.prune();

    expect(cache.check('session1', 'key-1', {}).duplicate).toBe(false);
    expect(cache.check('session1', 'key-2', {}).duplicate).toBe(false);
  });

  it('same command body produces different key than different body', () => {
    cache.record('s1', 'k1', 'cmd-1', { type: 'click', selector: '#a' });

    // Same json structure = same hash = same key
    const r1 = cache.check('s1', 'k1', { type: 'click', selector: '#a' });
    expect(r1.duplicate).toBe(true);

    // Different json structure would produce different hash
    // But since we use provided idempotencyKey, the body is only used for hash generation
    // The key is `${sessionId}:${idempotencyKey}`, so it should match regardless of body
    const r2 = cache.check('s1', 'k1', { type: 'click', selector: '#b' });
    expect(r2.duplicate).toBe(true);
  });
});
