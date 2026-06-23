import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandQueue } from '../cmd_queue.js';

describe('CommandQueue', () => {
  let queue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new CommandQueue();
    queue.on('error', () => {}); // suppress unhandled 'error' events
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds a command and returns a promise', () => {
    const promise = queue.add('cmd-1', { type: 'click', selector: '#a' });
    expect(promise).toBeInstanceOf(Promise);
    expect(queue.pending.has('cmd-1')).toBe(true);
  });

  it('resolves with ack', async () => {
    const promise = queue.add('cmd-2', { type: 'click', selector: '#x' });
    queue.ack('cmd-2', { ok: true });
    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.result.ok).toBe(true);
    expect(queue.pending.has('cmd-2')).toBe(false);
  });

  it('resolves (not rejects) on error', async () => {
    const promise = queue.add('cmd-3', { type: 'type', selector: '#x' });
    queue.error('cmd-3', 'Timeout');
    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toBe('Timeout');
  });

  it('cancels a pending command', () => {
    queue.add('cmd-4', { type: 'navigate', url: '/test' });
    const cancelled = queue.cancel('cmd-4');
    expect(cancelled).toBe(true);
    expect(queue.pending.has('cmd-4')).toBe(false);
  });

  it('cancel resolves promise with cancelled status', async () => {
    const promise = queue.add('cmd-5', { type: 'navigate', url: '/test' });
    queue.cancel('cmd-5');

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toBe('cancelled');
  });

  it('evicts oldest completed entries when max is reached', () => {
    const small = new CommandQueue();
    small.on('error', () => {});
    for (let i = 0; i < 2010; i++) {
      small.add(`cmd-${i}`, { type: 'click', selector: `#${i}` });
      small.ack(`cmd-${i}`, { ok: true });
    }
    expect(small.completed.size).toBeLessThanOrEqual(2000);
  });

  it('times out after DEFAULT_TIMEOUT_MS', async () => {
    const promise = queue.add('cmd-timeout', { type: 'click', selector: '#timeout' });

    vi.advanceTimersByTime(31000);

    const result = await promise;
    expect(result.success).toBe(false);
  });

  it('across multiple commands with mixed outcomes', async () => {
    const p1 = queue.add('c1', { type: 'click', selector: '#a' });
    const p2 = queue.add('c2', { type: 'type', selector: '#b' });
    const p3 = queue.add('c3', { type: 'click', selector: '#c' });

    queue.ack('c1', { ok: true });
    queue.error('c2', 'Failed');
    queue.cancel('c3');

    const r1 = await p1;
    expect(r1.success).toBe(true);

    const r2 = await p2;
    expect(r2.success).toBe(false);
    expect(r2.error).toBe('Failed');

    const r3 = await p3;
    expect(r3.success).toBe(false);
    expect(r3.error).toBe('cancelled');
  });
});
