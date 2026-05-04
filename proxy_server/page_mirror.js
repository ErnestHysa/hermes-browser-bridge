/**
 * page_mirror.js — In-memory page state cache
 *
 * Fix #C4:  (network binding done in server.js, not here)
 * Fix #4:   Per-session connected flag (not global)
 * Fix #6:   lastSeqPerSession — tracks per-session last acknowledged seq
 * Fix #7:   Mutations scoped to session
 * Fix #8:   Disconnected sessions evicted after SESSION_TTL_MS of inactivity
 * Fix #M3:   maxHtmlBytes guard — rejects snapshots exceeding the configured size
 * Fix #L2:   getLastSeq(sessionId) exposed via HTTP GET /page_state?sessionId=...&lastSeq=N
 * Fix #19:   PageStateCache refactor — extracted per-session state class used internally by PageMirror
 */

const HTML_TTL_MS = 5000;
const MUTATION_TTL_MS = 30000;
const MUTATION_BUFFER_MAX = 500;
const DEFAULT_MAX_HTML_BYTES = 10 * 1024 * 1024; // 10MB

// ─── Per-Session State Cache ─────────────────────────────────────────────────

/**
 * #19: PageStateCache — handles per-session page state (html, title, url, lastUpdate, mutations).
 *
 * Each session stored independently so one session's state cannot evict another's.
 * Mutation buffers are also per-session ring buffers.
 *
 * @private
 */
class PageStateCache {
  /**
   * @param {number} sessionTtlMs - How long to keep a disconnected session before evicting it
   */
  constructor(sessionTtlMs = 5 * 60 * 1000) {
    /** @type {number} */
    this._sessionTtlMs = sessionTtlMs;

    /**
     * Per-session page state.
     * Key: sessionId (string)
     * Value: session data object
     * @type {Map<string, {url: string, title: string, html: string, lastHtmlUpdate: number, seq: number, connected: boolean, tabId: (string|null)}>}
     */
    this._sessions = new Map();

    /**
     * Tracks the last seq each client (Hermes poll call) has seen, per session.
     * Key: sessionId. Value: last seq number Hermes acknowledged for this session.
     * Used so Hermes can request only delta mutations since its last poll.
     * @type {Map<string, number>}
     */
    this._lastSeqPerSession = new Map();

    /**
     * Per-session mutation buffers — each session gets its own ring buffer.
     * Key: sessionId. Value: array of {mutations, url, seq, ts}.
     * This prevents an active session from evicting another session's mutations.
     * @type {Map<string, Array<{mutations: object[], url: string, seq: number, ts: number}>}
     */
    this._mutationBuffers = new Map();

    /** Per-buffer constant — max mutations per session buffer */
    this._mutationBufferMax = MUTATION_BUFFER_MAX; // 500 per session

    /** @type {boolean} true when at least one session is currently connected */
    this._anyConnected = false;
  }

  // ─── Session management ─────────────────────────────────────────────────────

  /**
   * Get or create session data for a sessionId.
   * @param {string} sessionId
   * @returns {{url: string, title: string, html: string, lastHtmlUpdate: number, seq: number, connected: boolean, tabId: (string|null)}}
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
    session.connected = true;
    this._anyConnected = true;
  }

  /**
   * Mark a session as disconnected (but do not evict it yet).
   * @param {string} sessionId
   */
  disconnectSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (session) {
      session.connected = false;
    }
    this._anyConnected = Array.from(this._sessions.values()).some(s => s.connected);
  }

  /**
   * Add mutation data to the per-session ring buffer.
   * @param {string} sessionId
   * @param {{ mutations: object[], url: string, seq: number }} mutationData
   */
  addMutations(sessionId, { mutations, url, seq }) {
    const ts = Date.now();
    if (!this._mutationBuffers.has(sessionId)) {
      this._mutationBuffers.set(sessionId, []);
    }
    const buf = this._mutationBuffers.get(sessionId);
    if (buf.length >= this._mutationBufferMax) {
      console.warn(`[PageStateCache] Mutation buffer full for session ${sessionId} — dropping oldest entry`);
    }
    buf.push({ mutations, url, seq, ts });
    if (buf.length > this._mutationBufferMax) {
      const dropped = buf.shift();
      console.warn(`[PageStateCache] Mutation buffer overflow for session ${sessionId} — dropped ${dropped.mutations.length} mutation(s)`);
    }
  }

  /**
   * Get the current page state for a session, including delta mutations since lastSeq.
   * @param {string} sessionId
   * @param {number} [lastSeq=0]
   * @returns {{ url: string, title: string, html: string, seq: number, connected: boolean, tabId: (string|null), lastUpdate: number, mutations: object[], htmlStale: boolean }}
   */
  getState(sessionId, lastSeq = 0) {
    const now = Date.now();

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

    const htmlFresh = (now - targetSession.lastHtmlUpdate) < HTML_TTL_MS;

    // Get mutations from this session's dedicated buffer
    const sessionMutations = this._mutationBuffers.get(actualSessionId) || [];
    const mutations = sessionMutations
      .filter(m => m.seq > lastSeq && (now - m.ts) < MUTATION_TTL_MS)
      .map(m => ({ mutations: m.mutations, url: m.url, seq: m.seq, ts: m.ts }));

    // Return a shallow copy so callers cannot mutate internal state
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
   * Evict sessions disconnected for longer than _sessionTtlMs.
   * Called by the background eviction timer.
   */
  evictStaleSessions() {
    const now = Date.now();
    for (const [sessionId, session] of this._sessions) {
      if (!session.connected && (now - session.lastHtmlUpdate) > this._sessionTtlMs) {
        this._sessions.delete(sessionId);
        this._lastSeqPerSession.delete(sessionId);
        this._mutationBuffers.delete(sessionId);
      }
    }
    this._anyConnected = Array.from(this._sessions.values()).some(s => s.connected);
  }

  /**
   * Update the last-acknowledged seq for a session.
   * Called by the HTTP handler when Hermes includes ?lastSeq=N in the request.
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
   * @param {string} sessionId
   * @returns {number}
   */
  getLastSeq(sessionId) {
    return this._lastSeqPerSession.get(sessionId) || 0;
  }

  /** @returns {boolean} true if at least one session is currently connected */
  get connected() {
    return this._anyConnected;
  }
}

// ─── Page Mirror ─────────────────────────────────────────────────────────────

/**
 * PageMirror wraps PageStateCache with maxHtmlBytes enforcement and eviction timer.
 * The actual per-session state (html, title, url, lastUpdate, mutations[]) is
 * managed by the internal PageStateCache instance (#19 refactor).
 *
 * @public
 */
class PageMirror {
  /**
   * @param {{ maxHtmlBytes?: number, sessionTtlMs?: number }} options
   */
  constructor(options = {}) {
    this._maxHtmlBytes = options.maxHtmlBytes || DEFAULT_MAX_HTML_BYTES;
    /** @type {PageStateCache} Internal per-session state cache (#19) */
    this._cache = new PageStateCache(options.sessionTtlMs || (5 * 60 * 1000));

    /** @type {ReturnType<typeof setInterval>|null} */
    this._evictionTimer = null;
  }

  /**
   * Start the background eviction interval. Called once after construction.
   * Safe to call multiple times — only one interval runs at a time.
   */
  startEvictionTimer() {
    if (this._evictionTimer) return;
    this._evictionTimer = setInterval(() => {
      this._cache.evictStaleSessions();
    }, 30000);
  }

  /**
   * Stop the background eviction timer. Mainly for testing.
   */
  stopEvictionTimer() {
    if (this._evictionTimer) {
      clearInterval(this._evictionTimer);
      this._evictionTimer = null;
    }
  }

  // ─── Passthrough to PageStateCache ───────────────────────────────────────

  /**
   * Update the full page snapshot for a session.
   * Enforces maxHtmlBytes — truncates oversized HTML.
   * @param {string} sessionId
   * @param {{ url: string, title: string, html: string, seq?: number }} snapshot
   */
  updateSnapshot(sessionId, { url, title, html, seq }) {
    let finalHtml = html;
    if (html.length > this._maxHtmlBytes) {
      console.warn(`[PageMirror] HTML snapshot for session ${sessionId} exceeds ${this._maxHtmlBytes} bytes (${html.length}) — truncating`);
      finalHtml = html.slice(0, this._maxHtmlBytes);
    }
    this._cache.updateSnapshot(sessionId, { url, title, html: finalHtml, seq });
  }

  /**
   * Mark a session as disconnected.
   * @param {string} sessionId
   */
  disconnectSession(sessionId) {
    this._cache.disconnectSession(sessionId);
  }

  /**
   * Evict sessions disconnected for longer than the configured TTL.
   * Public entry point — used by the background timer and prune loop.
   */
  evictStaleSessions() {
    this._cache.evictStaleSessions();
  }

  /**
   * Add mutation data to the per-session ring buffer.
   * @param {string} sessionId
   * @param {{ mutations: object[], url: string, seq: number }} mutationData
   */
  addMutations(sessionId, mutationData) {
    this._cache.addMutations(sessionId, mutationData);
  }

  /**
   * Get the current page state for Hermes, scoped to a specific session.
   * @param {string} sessionId
   * @param {number} [lastSeq=0]
   * @returns {{ url: string, title: string, html: string, seq: number, connected: boolean, tabId: (string|null), lastUpdate: number, mutations: object[], htmlStale: boolean }}
   */
  getState(sessionId, lastSeq = 0) {
    return this._cache.getState(sessionId, lastSeq);
  }

  /**
   * Update the last-acknowledged seq for a session.
   * @param {string} sessionId
   * @param {number} seq
   */
  ackSessionSeq(sessionId, seq) {
    this._cache.ackSessionSeq(sessionId, seq);
  }

  /**
   * Get the last-acknowledged seq for a session.
   * @param {string} sessionId
   * @returns {number}
   */
  getLastSeq(sessionId) {
    return this._cache.getLastSeq(sessionId);
  }

  /** @returns {boolean} true if at least one session is currently connected */
  get connected() {
    return this._cache.connected;
  }
}

module.exports = { PageMirror, PageStateCache };
