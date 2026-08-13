'use strict';

/**
 * Remote stream sessions.
 *
 * A resolved online video is not one URL: it is up to two short-lived CDN URLs
 * with their own header requirements and their own expiry. This registry owns
 * that state so the rest of the app can pass around an opaque token instead of
 * copying headers - which is also what keeps request headers out of the
 * renderer, out of logs and out of the recipe files we persist.
 *
 * Tokens are per-run and meaningless to anything outside this process.
 */

const crypto = require('crypto');
const { VisionanceError, CODES, redactHeaders } = require('./errors');
const ytdlp = require('./ytdlp');
const { logger } = require('./logger');

const log = logger.child('stream');
const MAX_SESSIONS = 24;

class StreamSessionRegistry {
  constructor() {
    /** @type {Map<string, {token, resolved, createdAt, lastUsedAt}>} */
    this.sessions = new Map();
  }

  /**
   * @param {object} resolved
   * @param {object} [meta] decisions that produced this session (the stream
   *   policy, the selection purpose) so a refresh can repeat them rather than
   *   re-deriving them from settings that may say something different.
   * @returns {string} token
   */
  register(resolved, meta = null) {
    const token = 'st_' + crypto.randomBytes(9).toString('hex');
    this.sessions.set(token, {
      token,
      resolved,
      meta: meta || null,
      createdAt: Date.now(),
      lastUsedAt: Date.now()
    });
    this._evict();
    return token;
  }

  get(token) {
    const s = token ? this.sessions.get(token) : null;
    if (s) s.lastUsedAt = Date.now();
    return s || null;
  }

  /**
   * Headers for one leg of a session.
   * @param {string} token
   * @param {'video'|'audio'} kind
   */
  headersFor(token, kind) {
    const s = this.get(token);
    if (!s) return null;
    const fmt = kind === 'audio' ? s.resolved.audio : s.resolved.video;
    return (fmt && fmt.headers) || null;
  }

  urlFor(token, kind) {
    const s = this.get(token);
    if (!s) return null;
    const fmt = kind === 'audio' ? s.resolved.audio : s.resolved.video;
    return (fmt && fmt.url) || null;
  }

  isExpired(token, skewSeconds) {
    const s = this.get(token);
    if (!s) return true;
    return ytdlp.isExpired(s.resolved, skewSeconds);
  }

  /**
   * Re-resolve an expired session in place, keeping the same token so anything
   * already holding it keeps working.
   * @returns {Promise<object>} the refreshed descriptor
   */
  async refresh(token, bin, opts = {}) {
    const s = this.get(token);
    if (!s) {
      throw new VisionanceError(CODES.STREAM_EXPIRED, {
        message: 'That stream is no longer available in this session.'
      });
    }
    const fresh = await ytdlp.refreshStream(bin, s.resolved, opts);
    s.resolved = fresh;
    s.lastUsedAt = Date.now();
    log.info('session refreshed', { token, extractor: fresh.extractor });
    return fresh;
  }

  /** Safe-to-log / safe-to-send summary. Never includes header values. */
  describe(token) {
    const s = this.get(token);
    if (!s) return null;
    const r = s.resolved;
    return {
      token,
      webpageUrl: r.webpageUrl,
      extractor: r.extractor,
      muxed: r.muxed,
      resolvedAt: r.resolvedAt,
      expiresAt: r.expiresAt,
      expired: ytdlp.isExpired(r),
      usedAuth: r.usedAuth || 'none',
      videoHeaderKeys: Object.keys((r.video && r.video.headers) || {}),
      audioHeaderKeys: Object.keys((r.audio && r.audio.headers) || {}),
      redactedVideoHeaders: redactHeaders((r.video && r.video.headers) || {})
    };
  }

  release(token) {
    return this.sessions.delete(token);
  }

  clear() {
    this.sessions.clear();
  }

  _evict() {
    while (this.sessions.size > MAX_SESSIONS) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [k, v] of this.sessions) {
        if (v.lastUsedAt < oldest) { oldest = v.lastUsedAt; oldestKey = k; }
      }
      if (oldestKey == null) break;
      this.sessions.delete(oldestKey);
    }
  }
}

module.exports = { StreamSessionRegistry };
