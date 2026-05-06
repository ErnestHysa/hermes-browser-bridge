/**
 * backpressure.js — Per-session backpressure tracking.
 */

'use strict';

const { metricGauge } = require('./metrics');

class BackpressureManager {
  constructor() {
    /** @type {Map<string, {paused: boolean, ws: import('ws').WebSocket, pendingCount: number}>} */
    this._sessions = new Map();
  }

  incrementPending(sessionId) {
    const entry = this._sessions.get(sessionId);
    if (!entry) return;
    entry.pendingCount++;
  }

  decrementPending(sessionId) {
    const entry = this._sessions.get(sessionId);
    if (!entry) return;
    if (entry.pendingCount > 0) entry.pendingCount--;
  }

  markWriting(sessionId, ws, forcePause = false) {
    const entry = this._sessions.get(sessionId);
    if (!entry || (!entry.paused || forcePause)) {
      this._sessions.set(sessionId, { ...(entry || {}), paused: true, ws, pendingCount: entry?.pendingCount || 0 });
      metricGauge('backpressureActive', 1);
      this._sendSignal(ws, true);
    }
  }

  markDone(sessionId, ws) {
    const entry = this._sessions.get(sessionId);
    if (entry && entry.paused) {
      if (entry.pendingCount <= 2) {
        entry.paused = false;
        this._sendSignal(ws, false);
        const anyPaused = Array.from(this._sessions.values()).some(e => e.paused);
        if (!anyPaused) {
          metricGauge('backpressureActive', 0);
        }
      }
    }
  }

  isPaused(sessionId) {
    const entry = this._sessions.get(sessionId);
    return entry ? entry.paused : false;
  }

  removeSession(sessionId) {
    const entry = this._sessions.get(sessionId);
    if (entry && entry.paused) {
      this._sendSignal(entry.ws, false);
    }
    this._sessions.delete(sessionId);
    const anyPaused = Array.from(this._sessions.values()).some(e => e.paused);
    if (!anyPaused) {
      metricGauge('backpressureActive', 0);
    }
  }

  _sendSignal(ws, paused) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'backpressure',
        paused,
        ts: Date.now()
      }));
    }
  }
}

module.exports = { BackpressureManager };
