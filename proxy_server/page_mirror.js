/**
 * page_mirror.js — In-memory page state cache
 *
 * Fix #4:  Per-session connected flag (not global)
 * Fix #6:  lastSeqPerSession — tracks per-session last acknowledged seq
 * Fix #7:  Mutations scoped to session — getMutations(sessionId) filters
 * Fix #8:  Disconnected sessions evicted after SESSION_TTL_MS of inactivity
 */

const HTML_TTL_MS = 5000;
const MUTATION_TTL_MS = 30000;
const MUTATION_BUFFER_MAX = 100;
const SESSION_TTL_MS = 300000; // 5 minutes after disconnect

class PageMirror {
  constructor() {
    /**
     * Per-session page state.
     * Key: sessionId (string)
     * Value: { url, title, html, lastHtmlUpdate, seq, connected, tabId }
     * @type {Map<string, {url: string, title: string, html: string, lastHtmlUpdate: number, seq: number, connected: boolean, tabId: (string|null)}>}
     */
    this._sessions = new Map();

    /**
     * Tracks the last seq each client (Hermes poll call) has seen, per session.
     * Key: sessionId. Value: last seq number Hermes acknowledged for this session.
     * Used so Hermes can request only delta mutations since its last poll.
     * Fix #6
     * @type {Map<string, number>}
     */
    this._lastSeqPerSession = new Map();

    /**
     * Mutation ring buffer — all mutations, tagged by sessionId.
     * @type {Array<{sessionId: string, mutations: object[], url: string, seq: number, ts: number}>}
     */
    this._mutationBuffer = [];

    /**
     * Global connected flag — true when at least one session is connected.
     * Fix #4: derived from session state, not a separate flag.
     */
    this._anyConnected = false;
  }

  // ─── Session management ─────────────────────────────────────────────────────

  /**
   * Get or create a session entry.
   * @param {string} sessionId
   * @returns {object}
   */
  _getSession(sessionId) {
    let session = this._sessions.get(sessionId);
    if (!session) {
      session = { url: '', title: '', html: '', lastHtmlUpdate: 0, seq: 0, connected: false, tabId: null };
      this._sessions.set(sessionId, session);
    }
    return session;
  }

  /**
   * Update the full page snapshot for a session.
   * Fix #4: also updates the per-session connected flag.
   * Fix #6: increments seq and stores it.
   * @param {string} sessionId
   * @param {{ url: string, title: string, html: string, seq?: number }} snapshot
   */
  updateSnapshot(sessionId, { url, title, html, seq }) {
    const session = this._getSession(sessionId);
    session.url = url;
    session.title = title;
    session.html = html;
    session.lastHtmlUpdate = Date.now();
    session.seq = seq ?? (session.seq + 1);
    // Mark session connected and refresh its TTL
    session.connected = true;
    this._anyConnected = true;
  }

  /**
   * Mark a session as disconnected. The session entry is kept until SESSION_TTL_MS
   * elapses (Fix #8), allowing Hermes to still read the last known state during
   * brief disconnects/reconnects without losing session context.
   * @param {string} sessionId
   */
  disconnectSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (session) {
      session.connected = false;
    }
    // Recompute _anyConnected
    this._anyConnected = Array.from(this._sessions.values()).some(s => s.connected);
  }

  /**
   * Evict sessions that have been disconnected for longer than SESSION_TTL_MS.
   * Called periodically to prevent unbounded memory growth (Fix #8).
   */
  _evictStaleSessions() {
    const now = Date.now();
    for (const [sessionId, session] of this._sessions) {
      if (!session.connected && (now - session.lastHtmlUpdate) > SESSION_TTL_MS) {
        this._sessions.delete(sessionId);
        this._lastSeqPerSession.delete(sessionId);
        // Also prune mutations belonging to this session
        this._mutationBuffer = this._mutationBuffer.filter(m => m.sessionId !== sessionId);
      }
    }
  }

  /**
   * Add mutation data to the ring buffer, tagged by session.
   * @param {string} sessionId
   * @param {{ mutations: object[], url: string, seq: number }} mutationData
   */
  addMutations(sessionId, { mutations, url, seq }) {
    const ts = Date.now();
    this._mutationBuffer.push({ sessionId, mutations, url, seq, ts });
    if (this._mutationBuffer.length > MUTATION_BUFFER_MAX) {
      this._mutationBuffer.shift();
    }
  }

  // ─── State for Hermes ───────────────────────────────────────────────────────

  /**
   * Get the current page state for Hermes, scoped to a specific session.
   * Fix #4: uses per-session connected state.
   * Fix #6: returns only new mutations since lastSeq.
   * Fix #7: mutations filtered to the requested sessionId.
   *
   * @param {string} sessionId — the session to return state for
   * @param {number} [lastSeq=0] — the last seq Hermes has already seen (for delta mutations)
   * @returns {{ url: string, title: string, html: string, seq: number, connected: boolean, tabId: (string|null), lastUpdate: number, mutations: object[], htmlStale: boolean }}
   */
  getState(sessionId, lastSeq = 0) {
    // Evict stale sessions first
    this._evictStaleSessions();

    // If the requested session doesn't exist, fall back to the most recently updated session
    let targetSession = this._sessions.get(sessionId);
    let actualSessionId = sessionId;
    if (!targetSession) {
      let latestUpdate = 0;
      for (const [sid, session] of this._sessions) {
        if (session.lastHtmlUpdate > latestUpdate) {
          latestUpdate = session.lastHtmlUpdate;
          targetSession = session;
          actualSessionId = sid;
        }
      }
    }

    if (!targetSession) {
      return {
        url: '', title: '', html: '',
        htmlStale: true, seq: 0,
        connected: false, tabId: null,
        lastUpdate: 0,
        mutations: []
      };
    }

    const now = Date.now();
    const htmlFresh = (now - targetSession.lastHtmlUpdate) < HTML_TTL_MS;

    // Fix #7: only return mutations for this specific session
    // Fix #6: only return mutations with seq > lastSeq (delta since last poll)
    const mutations = this._mutationBuffer
      .filter(m => m.sessionId === actualSessionId && m.seq > lastSeq && (now - m.ts) < MUTATION_TTL_MS)
      .map(m => ({ mutations: m.mutations, url: m.url, seq: m.seq, ts: m.ts }));

    return {
      url: targetSession.url,
      title: targetSession.title,
      html: htmlFresh ? targetSession.html : '',
      htmlStale: !htmlFresh,
      seq: targetSession.seq,
      connected: targetSession.connected,
      tabId: targetSession.tabId,
      lastUpdate: targetSession.lastHtmlUpdate,
      mutations
    };
  }

  /**
   * Update the last-acknowledged seq for a session.
   * Called by the HTTP handler when Hermes includes ?lastSeq=N in the request.
   * Fix #6
   * @param {string} sessionId
   * @param {number} seq
   */
  ackSessionSeq(sessionId, seq) {
    const current = this._lastSeqPerSession.get(sessionId) || 0;
    if (seq > current) {
      this._lastSeqPerSession.set(sessionId, seq);
    }
  }

  /**
   * Get the last-acknowledged seq for a session.
   * Used so Hermes can pass it back on the next poll call.
   * Fix #6
   * @param {string} sessionId
   * @returns {number}
   */
  getLastSeq(sessionId) {
    return this._lastSeqPerSession.get(sessionId) || 0;
  }

  /**
   * @returns {boolean} true if at least one session is currently connected
   */
  get connected() {
    return this._anyConnected;
  }
}

module.exports = { PageMirror };
