/**
 * page_mirror.js — In-memory page state cache
 * Stores the latest DOM snapshot and mutation buffer from the extension.
 * C3 FIX: tracks state per sessionId so multiple browser sessions coexist.
 */

const HTML_TTL_MS = 5000;
const MUTATION_TTL_MS = 30000;
const MUTATION_BUFFER_MAX = 100;

class PageMirror {
  constructor() {
    /**
     * Per-session page state.
     * Key: sessionId (string)
     * Value: { url, title, html, lastHtmlUpdate, seq }
     * @type {Map<string, {url: string, title: string, html: string, lastHtmlUpdate: number, seq: number}>}
     */
    this._sessions = new Map();

    /** @type {Array<{sessionId: string, mutations: object[], url: string, ts: number}>} */
    this._mutationBuffer = [];

    this.connected = false;
    this.tabId = null;
  }

  /**
   * Update the full page snapshot for a session.
   * @param {string} sessionId
   * @param {{ url: string, title: string, html: string, seq?: number }} snapshot
   */
  updateSnapshot(sessionId, { url, title, html, seq }) {
    let session = this._sessions.get(sessionId);
    if (!session) {
      session = { url: '', title: '', html: '', lastHtmlUpdate: 0, seq: 0 };
      this._sessions.set(sessionId, session);
    }
    session.url = url;
    session.title = title;
    session.html = html;
    session.lastHtmlUpdate = Date.now();
    session.seq = seq ?? (session.seq + 1);
  }

  /**
   * Add mutation data to the ring buffer, tagged by session.
   * @param {string} sessionId
   * @param {{ mutations: object[], url: string }} mutationData
   */
  addMutations(sessionId, { mutations, url }) {
    const ts = Date.now();
    this._mutationBuffer.push({ sessionId, mutations, url, ts });
    if (this._mutationBuffer.length > MUTATION_BUFFER_MAX) {
      this._mutationBuffer.shift();
    }
  }

  /**
   * Get the current page state for Hermes.
   * Returns the most recently updated session's state.
   * @returns {{ url: string, title: string, html: string, seq: number, connected: boolean, tabId: (string|null), lastUpdate: number, mutations: object[], htmlStale: boolean }}
   */
  getState() {
    // Find the session with the most recent update
    let latestSession = null;
    let latestUpdate = 0;
    for (const session of this._sessions.values()) {
      if (session.lastHtmlUpdate > latestUpdate) {
        latestUpdate = session.lastHtmlUpdate;
        latestSession = session;
      }
    }

    if (!latestSession) {
      return {
        url: '',
        title: '',
        html: '',
        htmlStale: true,
        seq: 0,
        connected: this.connected,
        tabId: this.tabId,
        lastUpdate: 0,
        mutations: this.getMutations()
      };
    }

    const now = Date.now();
    const htmlFresh = (now - latestSession.lastHtmlUpdate) < HTML_TTL_MS;

    return {
      url: latestSession.url,
      title: latestSession.title,
      html: htmlFresh ? latestSession.html : '',
      htmlStale: !htmlFresh,
      seq: latestSession.seq,
      connected: this.connected,
      tabId: this.tabId,
      lastUpdate: latestSession.lastHtmlUpdate,
      mutations: this.getMutations()
    };
  }

  /**
   * Get recent mutations that are not yet stale.
   * @returns {object[]}
   */
  getMutations() {
    const now = Date.now();
    return this._mutationBuffer
      .filter(m => (now - m.ts) < MUTATION_TTL_MS)
      .map(m => ({ sessionId: m.sessionId, mutations: m.mutations, url: m.url, ts: m.ts }));
  }

  /**
   * Update connection state.
   * @param {boolean} connected
   * @param {string|null} [tabId]
   */
  setConnected(connected, tabId = null) {
    this.connected = connected;
    this.tabId = tabId;
    if (!connected) {
      this.tabId = null;
    }
  }

  /**
   * @returns {boolean}
   */
  isFresh() {
    let latest = 0;
    for (const session of this._sessions.values()) {
      if (session.lastHtmlUpdate > latest) latest = session.lastHtmlUpdate;
    }
    return (Date.now() - latest) < HTML_TTL_MS;
  }
}

module.exports = { PageMirror };
