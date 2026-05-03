/**
 * cmd_queue.js — Command queue with ack/error tracking
 * Tracks pending commands, resolves them on ack/error from extension.
 */

const { EventEmitter } = require('node:events');

const DEFAULT_TIMEOUT_MS = 30000;

class CommandQueue extends EventEmitter {
  constructor(timeoutMs = DEFAULT_TIMEOUT_MS) {
    super();
    this.pending = new Map(); // cmdId → { cmd, timer, resolve, reject }
    this.completed = new Map(); // cmdId → { status, result, error, timestamp }
    this.timeoutMs = timeoutMs;
  }

  /**
   * Add a command to the queue. Returns a promise that resolves when
   * the extension acknowledges it (ack or error).
   * @param {string} cmdId
   * @param {object} cmd
   * @returns {Promise<{success: boolean, result?: any, error?: string}>}
   */
  add(cmdId, cmd) {
    return new Promise((resolve, reject) => {
      // Clear any old completed entry
      this.completed.delete(cmdId);

      const timer = setTimeout(() => {
        this.pending.delete(cmdId);
        const error = `Command ${cmdId} timed out after ${this.timeoutMs}ms`;
        this.completed.set(cmdId, { status: 'error', error, timestamp: Date.now() });
        this.emit('timeout', cmdId, cmd);
        reject(new Error(error));
      }, this.timeoutMs);

      this.pending.set(cmdId, { cmd, timer, resolve, reject });
    });
  }

  /**
   * Called when the extension sends back cmd_ack.
   * @param {string} cmdId
   * @param {any} result
   */
  ack(cmdId, result) {
    const entry = this.pending.get(cmdId);
    if (!entry) return;

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
    if (!entry) return;

    clearTimeout(entry.timer);
    this.pending.delete(cmdId);
    this.completed.set(cmdId, { status: 'error', error, timestamp: Date.now() });
    entry.resolve({ success: false, error });
    this.emit('error', cmdId, error);
  }

  /**
   * Get the status of a command (including completed ones).
   * @param {string} cmdId
   * @returns {{ status: 'pending'|'done'|'error', result?: any, error?: string }}
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
   * Clean up old completed entries (call periodically).
   * @param {number} maxAgeMs
   */
  prune(maxAgeMs = 60000) {
    const now = Date.now();
    for (const [cmdId, entry] of this.completed) {
      if (now - entry.timestamp > maxAgeMs) {
        this.completed.delete(cmdId);
      }
    }
  }

  get size() {
    return this.pending.size;
  }
}

module.exports = { CommandQueue };
