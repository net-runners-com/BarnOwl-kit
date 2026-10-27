"use strict";
// In-memory session-scoped key store. Each entry is one 32-byte AES key tied
// to a session id and bounded by (a) last-use ttl and (b) an absolute lifetime
// so a long-lived socket can't keep a key alive forever.
//
// Keys never touch disk and are zeroed on eviction. The store is process-local
// — a barnowl restart invalidates every session, which is the point of
// "ephemeral per session".
//
// Thread safety: Node is single-threaded here; one Map suffices.

const { newKey } = require("./crypto.js");

const DEFAULT_TTL_MS = 30 * 60 * 1000;     // 30 min since last use
const DEFAULT_MAX_LIFE_MS = 4 * 60 * 60 * 1000; // 4 hour absolute cap

/**
 * @typedef {Object} StoreOpts
 * @property {number} [ttlMs=DEFAULT_TTL_MS]      per-key idle timeout (ms)
 * @property {number} [maxLifeMs=DEFAULT_MAX_LIFE_MS] absolute cap (ms)
 * @property {() => number} [now=Date.now]        clock injection for tests
 */

class KeyStore {
  /** @param {StoreOpts} [opts] */
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxLifeMs = opts.maxLifeMs ?? DEFAULT_MAX_LIFE_MS;
    this.now = opts.now ?? Date.now;
    /** @type {Map<string, {key: Buffer, bornAt: number, lastUsed: number}>} */
    this.map = new Map();
  }

  /**
   * Get (or mint) a key for a session id. Touches lastUsed.
   * @param {string} sessionId
   * @returns {Buffer}
   */
  getOrCreate(sessionId) {
    this._reap();
    const t = this.now();
    let entry = this.map.get(sessionId);
    if (!entry || t - entry.bornAt >= this.maxLifeMs) {
      // mint a fresh one — either first use, or old one hit absolute cap
      if (entry) entry.key.fill(0); // zero out the old key material
      entry = { key: newKey(), bornAt: t, lastUsed: t };
      this.map.set(sessionId, entry);
      return entry.key;
    }
    entry.lastUsed = t;
    return entry.key;
  }

  /**
   * Fetch a key without creating one.
   * @param {string} sessionId
   * @returns {Buffer|null}
   */
  get(sessionId) {
    this._reap();
    const entry = this.map.get(sessionId);
    if (!entry) return null;
    entry.lastUsed = this.now();
    return entry.key;
  }

  /** Explicitly drop a session's key, zeroing it. */
  drop(sessionId) {
    const entry = this.map.get(sessionId);
    if (!entry) return false;
    entry.key.fill(0);
    this.map.delete(sessionId);
    return true;
  }

  /** For tests / dashboards — number of currently live sessions. */
  size() { this._reap(); return this.map.size; }

  /** Internal: drop expired entries. */
  _reap() {
    const t = this.now();
    for (const [id, entry] of this.map) {
      const idleTooLong = t - entry.lastUsed >= this.ttlMs;
      const livedTooLong = t - entry.bornAt >= this.maxLifeMs;
      if (idleTooLong || livedTooLong) {
        entry.key.fill(0);
        this.map.delete(id);
      }
    }
  }
}

module.exports = { KeyStore, DEFAULT_TTL_MS, DEFAULT_MAX_LIFE_MS };
