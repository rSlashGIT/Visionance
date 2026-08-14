'use strict';

/**
 * One stable thumbnail per source identity.
 *
 * The rule this module exists to enforce: a source has exactly one thumbnail,
 * and every place in the UI that shows that source shows the same image. Before
 * this, nothing showed a thumbnail at all; the obvious naive fix - extract a
 * frame wherever a card is drawn - would have meant a fresh ffmpeg process per
 * render pass of the Queue, and a different frame in Create than in Library for
 * the same file.
 *
 * Identity is derived from the source string (absolute path or page URL), not
 * from the descriptor object, so the Watch tab, the Create panel, a persisted
 * job and a recents row all resolve to the same cache key without having to
 * agree on anything else.
 *
 * Extraction is deliberately cheap and deliberately not frame zero: many edits
 * open on black, a slate or a fade-in, so frame zero is the single worst
 * timestamp to choose. We seek to ~25% of the duration, and if that frame is
 * essentially black we try one deterministic fallback further in. Two attempts
 * maximum: this is a thumbnail, not a content-aware key-frame search.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { logger } = require('./logger');

const log = logger.child('thumbs');

/** Long edge of a stored thumbnail. Large enough for a 160px card at 2x DPR. */
const THUMB_WIDTH = 400;
/** Anything under this is a decode failure or an empty frame, not a picture. */
const MIN_BYTES = 512;
/** Mean luma below this (0-255) reads as "black frame", so try again later in. */
const BLACK_THRESHOLD = 10;

const FIRST_FRACTION = 0.25;
const FALLBACK_FRACTION = 0.55;

class Thumbnails {
  /**
   * @param {object} o
   *   dir       {string}   cache directory
   *   binPaths  {function} () => { ffmpeg, ffprobe }
   *   net       {object}   Electron `net`, for remote fetches
   */
  constructor({ dir, binPaths, net }) {
    this.dir = dir;
    this.binPaths = binPaths;
    this.net = net;
    /** key -> Promise, so N simultaneous cards cause one extraction. */
    this.inflight = new Map();
    /** Keys we have already failed on; retrying every render is pure waste. */
    this.failed = new Set();
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      log.warn('thumbnail cache directory unavailable', { error: err.message });
    }
  }

  /**
   * Stable cache key for a source. The same file or page URL always produces
   * the same key, in this process and in the next one.
   *
   * @param {{kind?:string, source?:string, webpageUrl?:string}} descriptor
   * @returns {string|null}
   */
  keyFor(descriptor) {
    if (!descriptor) return null;
    const remote = descriptor.kind === 'stream' || descriptor.kind === 'remote';
    const raw = remote
      ? (descriptor.webpageUrl || descriptor.source || '')
      : (descriptor.source || descriptor.path || '');
    if (!raw) return null;
    // Paths are case-insensitive on Windows and macOS; URLs are normalised by
    // the renderer before they get here. Lower-casing a path key costs nothing
    // and stops C:\A.mp4 and c:\a.mp4 from owning two thumbnails.
    const normalised = remote ? String(raw).trim() : String(raw).trim().toLowerCase();
    const hash = crypto.createHash('sha1').update(normalised).digest('hex').slice(0, 20);
    return `${remote ? 'r' : 'l'}_${hash}`;
  }

  fileFor(key) {
    return path.join(this.dir, `${key}.jpg`);
  }

  /** Is this key already on disk? Used by the cache-hit assertions. */
  has(key) {
    if (!key) return false;
    try {
      return fs.statSync(this.fileFor(key)).size >= MIN_BYTES;
    } catch {
      return false;
    }
  }

  /**
   * Resolve a thumbnail for a source, extracting or downloading it once.
   *
   * @returns {Promise<{key:string, cached:boolean, generated:boolean}|null>}
   *   null when no thumbnail could be produced - the caller shows a placeholder
   *   rather than a fabricated image.
   */
  async ensure(descriptor) {
    const key = this.keyFor(descriptor);
    if (!key) return null;
    if (this.has(key)) return { key, cached: true, generated: false };
    if (this.failed.has(key)) return null;
    if (this.inflight.has(key)) return this.inflight.get(key);

    const run = this._produce(key, descriptor)
      .then((produced) => {
        if (!produced) {
          this.failed.add(key);
          return null;
        }
        return { key, cached: false, generated: true };
      })
      .catch((err) => {
        log.debug('thumbnail failed', { key, error: err.message });
        this.failed.add(key);
        return null;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, run);
    return run;
  }

  async _produce(key, descriptor) {
    const remote = descriptor.kind === 'stream' || descriptor.kind === 'remote';
    if (remote) {
      // yt-dlp already handed us a poster URL when it resolved the page. Using
      // it costs one HTTP GET, once, ever - versus decoding a remote video.
      if (descriptor.thumbnail) {
        const okRemote = await this._download(descriptor.thumbnail, this.fileFor(key));
        if (okRemote) return true;
      }
      return false;
    }

    const source = descriptor.source || descriptor.path;
    if (!source || !fs.existsSync(source)) return false;

    const duration = Number(descriptor.durationSeconds) > 0
      ? Number(descriptor.durationSeconds)
      : await this._probeDuration(source);

    const first = duration > 0 ? duration * FIRST_FRACTION : 3;
    if (await this._extract(source, first, this.fileFor(key))) {
      if (!(await this._looksBlack(this.fileFor(key)))) return true;
      // Opened on black. One deterministic second try, then accept whatever we
      // got - a dark thumbnail is still this file's thumbnail.
      const second = duration > 0 ? duration * FALLBACK_FRACTION : 10;
      if (await this._extract(source, second, this.fileFor(key))) return true;
      return this.has(key);
    }
    // Some containers refuse an input seek. Fall back to the very start rather
    // than showing nothing at all.
    return this._extract(source, 0, this.fileFor(key));
  }

  async _probeDuration(source) {
    const { ffprobe } = this.binPaths();
    if (!ffprobe) return 0;
    const out = await runCapture(ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      source
    ], 15000);
    const value = Number(String(out || '').trim());
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  /**
   * One frame, one JPEG. `-ss` before `-i` is an input seek, which jumps to the
   * nearest keyframe without decoding everything before it: the difference
   * between milliseconds and minutes on a long source.
   */
  async _extract(source, seconds, destination) {
    const { ffmpeg } = this.binPaths();
    if (!ffmpeg) return false;
    const tmp = `${destination}.tmp`;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-ss', String(Math.max(0, seconds).toFixed(3)),
      '-i', source,
      '-frames:v', '1',
      '-vf', `scale=${THUMB_WIDTH}:-2:flags=bicubic`,
      '-q:v', '5',
      '-f', 'mjpeg',
      '-y', tmp
    ];
    const code = await runStatus(ffmpeg, args, 25000);
    if (code !== 0) {
      safeUnlink(tmp);
      return false;
    }
    try {
      if (fs.statSync(tmp).size < MIN_BYTES) {
        safeUnlink(tmp);
        return false;
      }
      // Rename last: a reader either sees no file or a complete one.
      fs.renameSync(tmp, destination);
      return true;
    } catch {
      safeUnlink(tmp);
      return false;
    }
  }

  /**
   * Mean luma of the stored thumbnail, via ffmpeg's signalstats. Cheap: it runs
   * on one already-tiny JPEG, not on the video.
   */
  async _looksBlack(file) {
    const { ffmpeg } = this.binPaths();
    if (!ffmpeg) return false;
    const out = await runCapture(ffmpeg, [
      '-hide_banner', '-nostdin', '-i', file,
      '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG',
      '-f', 'null', '-'
    ], 15000, true);
    const match = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(out || '');
    if (!match) return false;
    return Number(match[1]) < BLACK_THRESHOLD;
  }

  /**
   * Fetch a poster image once. Bounded: a thumbnail that arrives slowly is not
   * worth holding a socket open for, and a "thumbnail" of several megabytes is
   * not a thumbnail.
   */
  _download(url, destination) {
    return new Promise((resolve) => {
      if (!/^https?:\/\//i.test(url)) return resolve(false);
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      let request;
      try {
        request = this.net.request({ url, method: 'GET' });
      } catch {
        return done(false);
      }

      const timer = setTimeout(() => {
        try { request.abort(); } catch { /* already gone */ }
        done(false);
      }, 12000);

      request.on('response', (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          clearTimeout(timer);
          response.resume();
          return done(false);
        }
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) {
            clearTimeout(timer);
            try { request.abort(); } catch { /* already gone */ }
            return done(false);
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          clearTimeout(timer);
          if (size < MIN_BYTES) return done(false);
          const tmp = `${destination}.tmp`;
          try {
            fs.writeFileSync(tmp, Buffer.concat(chunks));
            fs.renameSync(tmp, destination);
            done(true);
          } catch {
            safeUnlink(tmp);
            done(false);
          }
        });
        response.on('error', () => { clearTimeout(timer); done(false); });
      });
      request.on('error', () => { clearTimeout(timer); done(false); });
      try {
        request.end();
      } catch {
        clearTimeout(timer);
        done(false);
      }
    });
  }

  /** Total bytes and file count, for the Storage section of Settings. */
  stats() {
    let bytes = 0;
    let count = 0;
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.endsWith('.jpg')) continue;
        try {
          bytes += fs.statSync(path.join(this.dir, name)).size;
          count++;
        } catch { /* raced with a clear */ }
      }
    } catch { /* no cache yet */ }
    return { bytes, count, dir: this.dir };
  }

  clear() {
    let removed = 0;
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.endsWith('.jpg') && !name.endsWith('.tmp')) continue;
        try {
          fs.unlinkSync(path.join(this.dir, name));
          removed++;
        } catch { /* in use */ }
      }
    } catch { /* no cache yet */ }
    this.failed.clear();
    return removed;
  }
}

function safeUnlink(file) {
  try { fs.unlinkSync(file); } catch { /* never existed */ }
}

/** Run a process and resolve its exit code. Killed on timeout. */
function runStatus(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch {
      return resolve(-1);
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      resolve(-1);
    }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve(-1); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code == null ? -1 : code); });
    if (child.stdout) child.stdout.resume();
    if (child.stderr) child.stderr.resume();
  });
}

/** Run a process and resolve its stdout (or stderr, when asked). */
function runCapture(bin, args, timeoutMs, wantStderr = false) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch {
      return resolve('');
    }
    let out = '';
    const cap = (buffer) => { if (out.length < 65536) out += buffer.toString('utf8'); };
    if (wantStderr) {
      if (child.stderr) child.stderr.on('data', cap);
      if (child.stdout) child.stdout.resume();
    } else {
      if (child.stdout) child.stdout.on('data', cap);
      if (child.stderr) child.stderr.resume();
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      resolve(out);
    }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

module.exports = { Thumbnails, THUMB_WIDTH };
