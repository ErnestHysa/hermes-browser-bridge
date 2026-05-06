/**
 * commandHistory.js — In-memory command history store.
 * Tracks last 50 completed commands per session.
 */

'use strict';

const CMD_HISTORY_MAX = 50;
const SESSION_HISTORY_TTL_MS = 600000; // 10 min — sessions idle longer are pruned

/** @type {Map<string, {cmdId: string, type: string, status: string, result?: string, error?: string, ts: number}[]>} */
const _commandHistory = new Map();

/** @type {Map<string, number>} */
const _lastActiveTime = new Map();

/**
 * @param {string} sessionId
 * @returns {{cmdId: string, type: string, status: string, result?: string, error?: string, ts: number}[]}
 */
function getHistory(sessionId) {
  if (!_commandHistory.has(sessionId)) _commandHistory.set(sessionId, []);
  return _commandHistory.get(sessionId);
}

/**
 * @param {string} sessionId
 * @param {{cmdId: string, type: string, status: string, result?: string, error?: string, ts: number}} entry
 * @param {(level: string, msg: string, extras?: object) => void} logFn
 */
function pushHistory(sessionId, entry, logFn) {
  const hist = _commandHistory.get(sessionId) || [];
  hist.unshift(entry);
  if (hist.length > CMD_HISTORY_MAX) {
    const dropped = hist.length - CMD_HISTORY_MAX;
    logFn('warn', 'Command history overflow — dropping oldest entries', { sessionId, dropped, max: CMD_HISTORY_MAX });
    hist.splice(CMD_HISTORY_MAX);
  }
  _commandHistory.set(sessionId, hist);
  _lastActiveTime.set(sessionId, Date.now());
}

/**
 * Evict command history for fully disconnected sessions OR sessions that are
 * idle beyond SESSION_HISTORY_TTL_MS (10min). This prevents history from
 * accumulating indefinitely when Hermes clients stay connected but the session
 * is no longer actively used.
 *
 * @param {Map<string, *>} sessionSockets
 * @param {object} hermesPush
 */
function pruneHistory(sessionSockets, hermesPush) {
  const now = Date.now();
  for (const [sid] of _commandHistory) {
    const hasExt = sessionSockets.has(sid);
    const hasHermes = hermesPush._sessionSubscriptions.has(sid) && hermesPush._sessionSubscriptions.get(sid).size > 0;

    // Evict if fully disconnected
    if (!hasExt && !hasHermes) {
      _commandHistory.delete(sid);
      _lastActiveTime.delete(sid);
      continue;
    }

    // Evict if idle beyond TTL even though connections still exist
    const lastActive = _lastActiveTime.get(sid) || 0;
    if ((now - lastActive) > SESSION_HISTORY_TTL_MS) {
      _commandHistory.delete(sid);
      _lastActiveTime.delete(sid);
    }
  }
}

/**
 * @param {string} sessionId
 */
function deleteHistory(sessionId) {
  _commandHistory.delete(sessionId);
  _lastActiveTime.delete(sessionId);
}

module.exports = { getHistory, pushHistory, pruneHistory, deleteHistory, CMD_HISTORY_MAX };
