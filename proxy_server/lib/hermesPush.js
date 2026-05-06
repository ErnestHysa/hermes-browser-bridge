/**
 * hermesPush.js — Hermes Push Manager for WS client connections and per-session subscriptions.
 */

'use strict';

const { metricGauge } = require('./metrics');
const { log } = require('./logger');

class HermesPushManager {
  constructor() {
    /** @type {Map<import('ws').WebSocket, {sessionId: string, reqId: string}>} */
    this._clients = new Map();
    /** @type {Map<string, import('ws').WebSocket>} */
    this._cmdIdToWs = new Map();
    /** @type {Map<string, Set<import('ws').WebSocket>>} */
    this._sessionSubscriptions = new Map();
    this._onSessionBridge = null;
  }

  setOnSessionBridge(cb) { this._onSessionBridge = cb; }

  subscribe(ws, sessionId, reqId) {
    const existing = this._clients.get(ws);
    if (existing) {
      const prevSet = this._sessionSubscriptions.get(existing.sessionId);
      if (prevSet) prevSet.delete(ws);
    }

    this._clients.set(ws, { sessionId, reqId });
    if (!this._sessionSubscriptions.has(sessionId)) {
      this._sessionSubscriptions.set(sessionId, new Set());
    }
    this._sessionSubscriptions.get(sessionId).add(ws);
    metricGauge('hermesClients', this._clients.size);
    log('info', 'Hermes WS subscribed to session', { reqId, sessionId });
  }

  unsubscribe(ws) {
    const entry = this._clients.get(ws);
    if (entry) {
      const set = this._sessionSubscriptions.get(entry.sessionId);
      if (set) set.delete(ws);
      this._clients.delete(ws);
      metricGauge('hermesClients', this._clients.size);
    }
  }

  _removeSession(sid) {
    const subs = this._sessionSubscriptions.get(sid);
    if (subs) {
      for (const ws of subs) {
        try {
          ws.send(JSON.stringify({ type: 'session_evicted', sessionId: sid, reason: 'timeout' }));
        } catch (_) {}
      }
      this._sessionSubscriptions.delete(sid);
    }
    for (const [cmdId, storedWs] of this._cmdIdToWs.entries()) {
      const clientSid = this._clients.get(storedWs)?.sessionId;
      if (clientSid === sid) {
        this._cmdIdToWs.delete(cmdId);
      }
    }
  }

  _cleanupWsEntries(ws) {
    for (const [cmdId, storedWs] of this._cmdIdToWs.entries()) {
      if (storedWs === ws) {
        this._cmdIdToWs.delete(cmdId);
      }
    }
  }

  broadcastSessionBridge(newSessionId, oldSessionId) {
    if (this._onSessionBridge) {
      this._onSessionBridge(newSessionId, oldSessionId);
    }
  }

  pushToSession(sessionId, payload) {
    const subscribers = this._sessionSubscriptions.get(sessionId);
    if (!subscribers || subscribers.size === 0) return;
    const data = JSON.stringify(payload);
    for (const ws of subscribers) {
      if (ws.readyState === 1) {
        try { ws.send(data); } catch (_) {}
      }
    }
  }

  forwardCommand(sessionId, command, sendToExtensionFn) {
    return sendToExtensionFn(sessionId, command);
  }

  get size() { return this._clients.size; }
}

module.exports = { HermesPushManager };
