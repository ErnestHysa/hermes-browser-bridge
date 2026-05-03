/**
 * cmd_queue.js — Command queue with ack/error tracking
 * Tracks pending commands, resolves them on ack/error from extension.
 * Fire-and-forget callers (server.js HTTP endpoint) get their promise
 * caught so Node never emits unhandledRejection.
 */

const { EventEmitter } = require('node:events');

const DEFAULT_TIMEOUT_MS = 30000;

class CommandQueue extends EventEmitter {
  constructor(timeoutMs = DEFAULT_TIMEOUT_MS) {
    super();
    /** @type {Map<string, { cmd: object, timer: NodeJS.Timeout, resolve: function, reject: function }>} */
    this.pending = new Map();
    /** @type {Map<string, { status: string, result?: any, error?: string, timestamp: number }>} */
    this.completed = new Map();
    this.timeoutMs = timeoutMs;
  }

  /**
   * Add a command to the queue. Returns a promise that resolves when
   * the extension acknowledges it (ack or error).
   * Unhandled rejections are caught internally so the process never dies.
   *
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
        // Resolve (not reject) so the promise settles without unhandledRejection
        resolve({ success: false, error });
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
    // M10 FIX: warn if cmdId not in pending queue
    if (!entry) {
      console.warn(`[CmdQueue] cmd_ack for unknown cmdId: ${cmdId} — may have already timed out`);
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
    // M10 FIX: warn if cmdId not in pending queue
    if (!entry) {
      console.warn(`[CmdQueue] cmd_error for unknown cmdId: ${cmdId} — may have already timed out`);
      return;
    }

    clearTimeout(entry.timer);
    this.pending.delete(cmdId);
    this.completed.set(cmdId, { status: 'error', error, timestamp: Date.now() });
    // Resolve (not reject) so the promise settles without unhandledRejection
    entry.resolve({ success: false, error });
    this.emit('error', cmdId, error);
  }

  /**
   * Get the status of a command (including completed ones).
   * @param {string} cmdId
   * @returns {{ status: 'pending'|'done'|'error'|'unknown', result?: any, error?: string }}
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
