/**
 * page_mirror.js — In-memory page state cache
 * Stores the latest DOM snapshot and mutation buffer from the extension.
 */

const HTML_TTL_MS = 5000;
const MUTATION_TTL_MS = 30000;
const MUTATION_BUFFER_MAX = 100;

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
    /** @type {Array<{mutations: object[], url: string, ts: number}>} */
    this._mutationBuffer = [];
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
    this.seq = seq ?? (this.seq + 1);
  }

  /**
   * Add mutation data to the ring buffer.
   * Mutations are stored with a timestamp so stale ones can be filtered out.
   * @param {{ mutations: object[], url: string }} mutationData
   */
  addMutations({ mutations, url }) {
    this.lastMutationUpdate = Date.now();
    this._mutationBuffer.push({ mutations, url, ts: Date.now() });
    if (this._mutationBuffer.length > MUTATION_BUFFER_MAX) {
      this._mutationBuffer.shift();
    }
  }

  /**
   * Get the current page state for Hermes.
   * @returns {{ url: string, title: string, html: string, seq: number, connected: boolean, tabId: (string|null), lastUpdate: number, mutations: object[] }}
   */
  getState() {
    const now = Date.now();
    const htmlFresh = (now - this.lastHtmlUpdate) < HTML_TTL_MS;

    return {
      url: this.url,
      title: this.title,
      // Return empty html if stale so Hermes knows data is outdated
      html: htmlFresh ? this.html : '',
      htmlStale: !htmlFresh,
      seq: this.seq,
      connected: this.connected,
      tabId: this.tabId,
      lastUpdate: this.lastHtmlUpdate,
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
      .map(m => ({ mutations: m.mutations, url: m.url, ts: m.ts }));
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
    return (Date.now() - this.lastHtmlUpdate) < HTML_TTL_MS;
  }
}

module.exports = { PageMirror };
