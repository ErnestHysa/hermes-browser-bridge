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
 */

const HTML_TTL_MS = 5000;
const MUTATION_TTL_MS = 30000;
const MUTATION_BUFFER_MAX = 500;
const DEFAULT_MAX_HTML_BYTES = 10 * 1024 * 1024; // 10MB

class PageMirror {
  /**
   * @param {{ maxHtmlBytes?: number }} options
   */
  constructor(options = {}) {
    this._maxHtmlBytes = options.maxHtmlBytes || DEFAULT_MAX_HTML_BYTES;
    this._sessionTtlMs = options.sessionTtlMs || (5 * 60 * 1000); // default 5 min

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
     * @type {Map<string, number>}
     */
    this._lastSeqPerSession = new Map();

    /**
     * H4: Per-session mutation buffers — each session gets its own ring buffer.
     * Key: sessionId. Value: array of {mutations, url, seq, ts}.
     * This prevents an active session from evicting another session's mutations.
     * @type {Map<string, Array<{mutations: object[], url: string, seq: number, ts: number}>}
     */
    this._mutationBuffers = new Map();

    /**
     * H4: Per-buffer constants. Each session buffer maxes out independently.
     */
    this._mutationBufferMax = MUTATION_BUFFER_MAX;  // 500 per session

    /**
     * Global connected flag — true when at least one session is connected.
     * Derived from session state, not a separate flag.
     * @type {boolean}
     */
    this._anyConnected = false;

    // Fix #5: Start background eviction timer so disconnected sessions are
    // cleaned up even when no active poll requests come in.
    this._evictionTimer = null;
  }

  /**
   * Start the background eviction interval. Called once after construction.
   * Safe to call multiple times — only one interval runs at a time.
   */
  startEvictionTimer() {
    if (this._evictionTimer) return; // already running
    this._evictionTimer = setInterval(() => {
      this.evictStaleSessions();
    }, Math.max(30000, this._sessionTtlMs / 2)); // run at half TTL or 30s, whichever is larger
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

  // ─── Session management ─────────────────────────────────────────────────────

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
   * Fix #M3: enforces maxHtmlBytes — truncates or rejects oversized HTML.
   * @param {string} sessionId
   * @param {{ url: string, title: string, html: string, seq?: number }} snapshot
   */
  updateSnapshot(sessionId, { url, title, html, seq }) {
    const session = this._getSession(sessionId);

    // Fix #M3: enforce max HTML size
    let finalHtml = html;
    if (html.length > this._maxHtmlBytes) {
      console.warn(`[PageMirror] HTML snapshot for session ${sessionId} exceeds ${this._maxHtmlBytes} bytes (${html.length}) — truncating`);
      finalHtml = html.slice(0, this._maxHtmlBytes);
    }

    session.url = url;
    session.title = title;
    session.html = finalHtml;
    session.lastHtmlUpdate = Date.now();
    session.seq = seq ?? (session.seq + 1);
    session.connected = true;
    this._anyConnected = true;
  }

  /**
   * Mark a session as disconnected.
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
   * Evict sessions disconnected for longer than SESSION_TTL_MS.
   * Public entry point — delegates to internal (used by background timer).
   */
  evictStaleSessions() {
    this._evictStaleSessionsInternal();
  }

  /**
   * Add mutation data to the ring buffer, tagged by session.
   * @param {string} sessionId
   * @param {{ mutations: object[], url: string, seq: number }} mutationData
   */
  addMutations(sessionId, { mutations, url, seq }) {
    const ts = Date.now();
    if (!this._mutationBuffers.has(sessionId)) {
      this._mutationBuffers.set(sessionId, []);
    }
    const buf = this._mutationBuffers.get(sessionId);
    // H4: Warn when dropping oldest mutation for this specific session's buffer
    if (buf.length >= this._mutationBufferMax) {
      console.warn(`[PageMirror] Mutation buffer full for session ${sessionId} — dropping oldest entry`);
    }
    buf.push({ mutations, url, seq, ts });
    if (buf.length > this._mutationBufferMax) {
      const dropped = buf.shift();
      log('warn', `Mutation buffer overflow for session ${sessionId} — dropped ${dropped.mutations.length} mutation(s)`);
    }
  }

  // ─── State for Hermes ───────────────────────────────────────────────────────

  /**
   * Get the current page state for Hermes, scoped to a specific session.
   * @param {string} sessionId
   * @param {number} [lastSeq=0]
   * @returns {{ url: string, title: string, html: string, seq: number, connected: boolean, tabId: (string|null), lastUpdate: number, mutations: object[], htmlStale: boolean }}
   */
  getState(sessionId, lastSeq = 0) {
    // S2: Only run eviction on read if we haven't run it recently (debounce to once per 5s)
    // The background timer handles the regular eviction; this is a safety net.
    const now = Date.now();
    if (!this._lastEvictCheck || (now - this._lastEvictCheck) > 5000) {
      this._lastEvictCheck = now;
      const before = this._anyConnected;
      this._evictStaleSessionsInternal();
      this._anyConnected = Array.from(this._sessions.values()).some(s => s.connected);
    }

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

    // H4: Get mutations from this session's dedicated buffer, not a global one
    const sessionMutations = this._mutationBuffers.get(actualSessionId) || [];
    const mutations = sessionMutations
      .filter(m => m.seq > lastSeq && (now - m.ts) < MUTATION_TTL_MS)
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

  /** Internal eviction without the per-read debounce check — used by background timer */
  _evictStaleSessionsInternal() {
    const now = Date.now();
    for (const [sessionId, session] of this._sessions) {
      if (!session.connected && (now - session.lastHtmlUpdate) > this._sessionTtlMs) {
        this._sessions.delete(sessionId);
        this._lastSeqPerSession.delete(sessionId);
        this._mutationBuffers.delete(sessionId);
      }
    }
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
   * Fix #L2: used by the HTTP handler to expose GET /page_state?sessionId=...
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

module.exports = { PageMirror };
