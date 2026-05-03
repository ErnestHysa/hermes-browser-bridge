/**
 * cmd_queue.js — Command queue with ack/error tracking
 * Tracks pending commands, resolves them on ack/error from extension.
 *
 * Fix #P3-17: Added cancel() method to remove and discard pending commands.
 * Fix #P0-1: add() now accepts optional submittedAt for duration tracking in metrics.
 */

'use strict';

const { EventEmitter } = require('node:events');

const DEFAULT_TIMEOUT_MS = 30000;

class CommandQueue extends EventEmitter {
  constructor(timeoutMs = DEFAULT_TIMEOUT_MS) {
    super();
    /** @type {Map<string, { cmd: object, timer: NodeJS.Timeout, resolve: function, reject: function, submittedAt: number }>} */
    this.pending = new Map();
    /** @type {Map<string, { status: string, result?: any, error?: string, timestamp: number }>} */
    this.completed = new Map();
    this.timeoutMs = timeoutMs;
  }

  /**
   * Add a command to the queue. Returns a promise that resolves when
   * the extension acknowledges it (ack or error).
   *
   * @param {string} cmdId
   * @param {object} cmd
   * @param {number} [submittedAt] — timestamp when command was first queued, for metrics
   */
  add(cmdId, cmd, submittedAt = Date.now()) {
    return new Promise((resolve, reject) => {
      this.completed.delete(cmdId);

      const timer = setTimeout(() => {
        this.pending.delete(cmdId);
        const error = `Command ${cmdId} timed out after ${this.timeoutMs}ms`;
        this.completed.set(cmdId, { status: 'error', error, timestamp: Date.now() });
        this.emit('timeout', cmdId, cmd);
        resolve({ success: false, error });
      }, this.timeoutMs);

      this.pending.set(cmdId, { cmd, timer, resolve, reject, submittedAt });
    });
  }

  /**
   * Fix #P3-17: Cancel a pending command without waiting for extension response.
   * Notifies the extension via a cancel message so it ignores the cmdId.
   */
  cancel(cmdId) {
    const entry = this.pending.get(cmdId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(cmdId);
    this.completed.set(cmdId, { status: 'cancelled', timestamp: Date.now() });
    entry.resolve({ success: false, error: 'cancelled' });
    this.emit('cancel', cmdId, entry.cmd);
    return true;
  }

  /**
   * Called when the extension sends back cmd_ack.
   * @param {string} cmdId
   * @param {any} result
   */
  ack(cmdId, result) {
    const entry = this.pending.get(cmdId);
    if (!entry) {
      console.warn(`[CmdQueue] cmd_ack for unknown cmdId: ${cmdId}`);
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(cmdId);
    this.completed.set(cmdId, { status: 'done', result, timestamp: Date.now() });
    entry.resolve({ success: true, result });
    this.emit('ack', cmdId, result);
  }

  /**
   * Called when the extension sends back cmd_error.
   * @param {string} cmdId
   * @param {string} error
   */
  error(cmdId, error) {
    const entry = this.pending.get(cmdId);
    if (!entry) {
      console.warn(`[CmdQueue] cmd_error for unknown cmdId: ${cmdId}`);
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(cmdId);
    this.completed.set(cmdId, { status: 'error', error, timestamp: Date.now() });
    entry.resolve({ success: false, error });
    this.emit('error', cmdId, error);
  }

  /**
   * Get the status of a command (including completed ones).
   * @param {string} cmdId
   */
  get(cmdId) {
    if (this.pending.has(cmdId)) {
      return { status: 'pending' };
    }
    const completed = this.completed.get(cmdId);
    if (completed) {
      return completed;
    }
    return { status: 'unknown' };
  }

  /**
   * Prune old completed entries older than maxAgeMs.
   * @param {number} [maxAgeMs=60000]
   */
  prune(maxAgeMs = 60000) {
    const now = Date.now();
    for (const [cmdId, entry] of this.completed) {
      if (now - entry.timestamp > maxAgeMs) {
        this.completed.delete(cmdId);
      }
    }
  }

  /** Pending command count. */
  get size() {
    return this.pending.size;
  }
}

module.exports = { CommandQueue };
