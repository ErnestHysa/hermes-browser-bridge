/**
 * page_mirror.js — In-memory page state cache
 * Stores the latest DOM snapshot and mutation buffer from the extension.
 */

const HTML_TTL_MS = 5000;   // Full HTML snapshot expires after 5s
const MUTATION_TTL_MS = 30000; // Mutation buffer expires after 30s

class PageMirror {
  constructor() {
    this.url = '';
    this.title = '';
    this.html = '';
    this.lastHtmlUpdate = 0;
    this.lastMutationUpdate = 0;
    this.seq = 0; // snapshot sequence number
    this.connected = false;
    this.tabId = null;
  }

  /**
   * Update the full page snapshot.
   * @param {{ url: string, title: string, html: string, seq?: number }} snapshot
   */
  updateSnapshot({ url, title, html, seq }) {
    this.url = url;
    this.title = title;
    this.html = html;
    this.lastHtmlUpdate = Date.now();
    this.seq = seq || (this.seq + 1);
  }

  /**
   * Add mutation data to the buffer.
   * @param {{ mutations: object[] }} mutationData
   */
  addMutations(mutationData) {
    this.lastMutationUpdate = Date.now();
    // Mutations are stored in a ring buffer (last 100)
    if (!this._mutationBuffer) this._mutationBuffer = [];
    this._mutationBuffer.push({ ...mutationData, ts: Date.now() });
    if (this._mutationBuffer.length > 100) {
      this._mutationBuffer.shift();
    }
  }

  /**
   * Get the current page state for Hermes.
   * Returns null if the data is stale (TTL expired).
   * @returns {{ url: string, title: string, html: string, seq: number, connected: boolean, lastUpdate: number } | null}
   */
  getState() {
    const now = Date.now();
    const htmlFresh = (now - this.lastHtmlUpdate) < HTML_TTL_MS;
    const connected = this.connected;

    // Always return state — html freshness is caller's choice
    return {
      url: this.url,
      title: this.title,
      html: htmlFresh ? this.html : '',
      seq: this.seq,
      connected,
      tabId: this.tabId,
      lastUpdate: this.lastHtmlUpdate,
      mutations: this.getMutations()
    };
  }

  /**
   * Get recent mutations (not yet stale).
   * @returns {object[]}
   */
  getMutations() {
    const now = Date.now();
    if (!this._mutationBuffer) return [];
    return this._mutationBuffer
      .filter(m => (now - m.ts) < MUTATION_TTL_MS)
      .map(m => ({ type: m.type, mutations: m.mutations, url: m.url, ts: m.ts }));
  }

  setConnected(connected, tabId = null) {
    this.connected = connected;
    this.tabId = tabId;
  }

  isFresh() {
    const now = Date.now();
    return (now - this.lastHtmlUpdate) < HTML_TTL_MS;
  }
}

module.exports = { PageMirror };
