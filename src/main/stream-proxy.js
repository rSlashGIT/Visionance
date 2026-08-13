'use strict';

/**
 * The remote-media proxy behind `vs://app/__media?src=remote`.
 *
 * ## Why this exists at all
 *
 * A `<video>` playing a progressive URL asks for the whole remainder of the
 * file in one open-ended request: `Range: bytes=0-`. That is a perfectly
 * ordinary HTTP request, and on a CDN that serves it flat out it is the right
 * one - one connection, no per-chunk latency.
 *
 * YouTube's CDN does not serve it flat out. Measured against real googlevideo
 * URLs on the reference machine:
 *
 * ```
 * format            open `bytes=0-`     bounded `bytes=0-N`
 * 1080p avc1 1896k   3717 kbps (2.0x)   119403 kbps (63x)
 * 1080p vp9   999k   2002 kbps (2.0x)   118227 kbps (118x)
 * 1440p vp9  3373k   6607 kbps (2.0x)   118812 kbps (35x)
 * ```
 *
 * The open-ended request is paced at almost exactly **twice the media's own
 * bitrate**, whatever that bitrate is. Twice realtime sounds survivable and is
 * not: the buffer can only ever grow at one second per second of wall clock,
 * so it takes half a minute to bank fifteen seconds of runway, and any
 * hiccup - a busy CPU, a Wi-Fi retransmit - is a stall the player never gets
 * ahead of again. That is the "YouTube buffers far slower in Visionance than
 * in a browser" report, and it is not the user's connection.
 *
 * A bounded range gets full line rate. So this module turns one open-ended
 * client request into a **sequence of bounded upstream requests**, stitched
 * back into a single continuous response body. The player sees exactly the
 * response it asked for; the CDN sees the request shape it serves quickly.
 *
 * ## What it does not do
 *
 * It never accumulates a chunk in memory. The range span is a *request*
 * boundary, not a buffer: bytes are passed straight from the upstream reader
 * to the response as they arrive, one network packet at a time, and the
 * ReadableStream's own `pull` backpressure means nothing is read until the
 * consumer wants it. Peak memory per stream is a few tens of kilobytes
 * regardless of file size or chunk span, which is what makes this safe on an
 * 8 GB machine.
 */

const { logger } = require('./logger');

const log = logger.child('proxy');

/**
 * Span requested from the CDN at a time.
 *
 * Calibrated, not guessed. Sequential bounded requests against a real 1080p
 * format measured 89 Mbps at 1 MiB, 96 Mbps at 2 MiB, then fell back to
 * 49 Mbps at 4 MiB and 8 MiB. 2 MiB sits at the top of that curve while
 * staying small enough that a seek abandons at most a fraction of a second of
 * in-flight work.
 */
const CHUNK_BYTES = 2 * 1024 * 1024;

/** Headers that belong to our hop, not the client's. */
const HOP_HEADERS = /^(host|connection|content-length|transfer-encoding|keep-alive|upgrade)$/i;

/**
 * Parse an HTTP Range request header.
 * Only the single-range `bytes=` form is supported; anything else is treated
 * as "no range", which is the safe direction (we serve the whole resource).
 *
 * @returns {{start:number, end:number|null}|null}
 */
function parseRange(header) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;

  // A suffix range ("last N bytes") needs the total length to resolve, which
  // we do not have yet. Let it through untouched rather than guessing.
  if (rawStart === '') return { start: null, suffix: Number(rawEnd) };

  return { start: Number(rawStart), end: rawEnd === '' ? null : Number(rawEnd) };
}

/** `bytes 0-1023/4096` -> 4096 */
function totalFromContentRange(value) {
  if (!value) return null;
  const m = /\/(\d+)\s*$/.exec(String(value));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Per-leg transfer accounting, so "it buffers slowly" can be answered with
 * numbers instead of an opinion. Bounded: one entry per active stream.
 */
class TransferStats {
  constructor() {
    this.legs = new Map();
  }

  key(token, leg) { return `${token}:${leg}`; }

  begin(token, leg, meta) {
    // Totals accumulate across requests. A media element re-requests on every
    // seek and whenever the audio track is nudged back into sync, so counters
    // that reset per request read as zero most of the time and make a
    // perfectly healthy stream look like it is transferring nothing.
    const key = this.key(token, leg);
    const previous = this.legs.get(key);
    const entry = {
      token, leg, ...meta,
      startedAt: previous ? previous.startedAt : Date.now(),
      firstByteMs: previous ? previous.firstByteMs : null,
      requests: previous ? previous.requests + 1 : 1,
      bytes: previous ? previous.bytes : 0,
      chunks: previous ? previous.chunks : 0,
      errors: previous ? previous.errors : 0,
      done: false
    };
    this.legs.set(key, entry);
    if (this.legs.size > 16) {
      const oldest = [...this.legs.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
      if (oldest) this.legs.delete(oldest[0]);
    }
    return entry;
  }

  snapshot() {
    return [...this.legs.values()].map((e) => {
      const ms = Math.max(1, Date.now() - e.startedAt);
      return {
        leg: e.leg,
        status: e.status || null,
        rangeStart: e.rangeStart,
        total: e.total,
        firstByteMs: e.firstByteMs,
        requests: e.requests,
        bytes: e.bytes,
        chunks: e.chunks,
        errors: e.errors,
        elapsedMs: ms,
        kbps: Math.round((e.bytes * 8) / ms),
        done: e.done
      };
    });
  }

  clear() { this.legs.clear(); }
}

/**
 * Serve one remote media request by chunking it upstream.
 *
 * @param {object} o
 *   url        {string}   the CDN URL for this leg
 *   headers    {object}   the header set this leg requires
 *   request    {Request}  the renderer's request (for its Range header)
 *   fetchImpl  {Function} injected so this is testable without Electron
 *   chunkBytes {number}
 *   stats      {TransferStats|null}
 *   token/leg  {string}   for accounting only
 * @returns {Promise<Response>}
 */
async function serveRanged({
  url,
  headers = {},
  request,
  fetchImpl,
  chunkBytes = CHUNK_BYTES,
  stats = null,
  token = '',
  leg = 'video'
}) {
  const clientRange = parseRange(request && request.headers && request.headers.get('range'));

  const upstreamHeaders = () => {
    const h = new Headers();
    for (const [k, v] of Object.entries(headers || {})) {
      if (HOP_HEADERS.test(k)) continue;
      h.set(k, String(v));
    }
    return h;
  };

  // A suffix range ("give me the last N bytes") cannot be chunked without
  // knowing the length, and browsers only use it for probing. Pass it through.
  if (clientRange && clientRange.start === null) {
    const h = upstreamHeaders();
    h.set('range', request.headers.get('range'));
    return fetchImpl(url, { headers: h, bypassCustomProtocolHandlers: true });
  }

  const start = clientRange ? clientRange.start : 0;
  const clientEnd = clientRange ? clientRange.end : null;

  const controllers = new Set();
  const fetchChunk = async (from, to) => {
    const h = upstreamHeaders();
    h.set('range', `bytes=${from}-${to}`);
    const ac = new AbortController();
    controllers.add(ac);
    try {
      return await fetchImpl(url, {
        headers: h,
        signal: ac.signal,
        bypassCustomProtocolHandlers: true
      });
    } finally {
      controllers.delete(ac);
    }
  };

  const firstEnd = clientEnd === null ? start + chunkBytes - 1 : Math.min(clientEnd, start + chunkBytes - 1);
  const t0 = Date.now();
  const first = await fetchChunk(start, firstEnd);

  const account = stats ? stats.begin(token, leg, { rangeStart: start }) : null;
  if (account) {
    account.status = first.status;
    if (account.firstByteMs === null) account.firstByteMs = Date.now() - t0;
    account.chunks++;
  }

  // The CDN ignored the range, so there is nothing to stitch: hand the single
  // response straight through rather than inventing a 206 we cannot honour.
  if (first.status !== 206) {
    if (account) { account.total = null; account.done = true; }
    return first;
  }

  const total = totalFromContentRange(first.headers.get('content-range'));
  if (!total) {
    if (account) account.done = true;
    return first;
  }
  if (account) account.total = total;

  const finalEnd = clientEnd === null ? total - 1 : Math.min(clientEnd, total - 1);

  let pos = start;
  let reader = first.body ? first.body.getReader() : null;
  let chunkEnd = firstEnd;
  let cancelled = false;
  let chunks = 1;

  const abortAll = () => {
    cancelled = true;
    for (const ac of controllers) {
      try { ac.abort(); } catch { /* already gone */ }
    }
    controllers.clear();
  };

  const body = new ReadableStream({
    async pull(controller) {
      // One `pull` produces at most one enqueue, so the consumer's demand -
      // not the network - decides how fast we read. That is the backpressure
      // that keeps memory flat.
      for (;;) {
        if (cancelled) { controller.close(); return; }

        if (pos > finalEnd) {
          if (account) account.done = true;
          controller.close();
          return;
        }

        if (!reader) {
          chunkEnd = Math.min(pos + chunkBytes - 1, finalEnd);
          let res;
          try {
            res = await fetchChunk(pos, chunkEnd);
          } catch (err) {
            if (cancelled) { controller.close(); return; }
            if (account) account.errors++;
            // One retry: a CDN URL close to expiry drops the odd request, and
            // failing the whole stream for it would stall playback that could
            // simply have continued.
            try {
              res = await fetchChunk(pos, chunkEnd);
            } catch (err2) {
              controller.error(err2);
              return;
            }
          }
          if (res.status !== 206 && res.status !== 200) {
            if (account) account.errors++;
            controller.error(new Error(`upstream ${res.status} at byte ${pos}`));
            return;
          }
          chunks++;
          if (account) account.chunks++;
          reader = res.body ? res.body.getReader() : null;
          if (!reader) { controller.close(); return; }
        }

        let piece;
        try {
          piece = await reader.read();
        } catch (err) {
          if (cancelled) { controller.close(); return; }
          controller.error(err);
          return;
        }

        if (piece.done) { reader = null; continue; }

        let out = piece.value;
        // Never emit past what was asked for, even if the CDN was generous.
        if (pos + out.length - 1 > finalEnd) {
          out = out.subarray(0, finalEnd - pos + 1);
        }
        if (out.length === 0) continue;
        pos += out.length;
        if (account) account.bytes += out.length;
        controller.enqueue(out);
        return;
      }
    },

    cancel() {
      // A seek, a source switch or a closed window. Drop the in-flight request
      // immediately rather than paying for bytes nobody will decode.
      abortAll();
      if (account) account.done = true;
      reader = null;
    }
  });

  const length = finalEnd - start + 1;
  const outHeaders = new Headers();
  const contentType = first.headers.get('content-type');
  if (contentType) outHeaders.set('content-type', contentType);
  outHeaders.set('accept-ranges', 'bytes');
  outHeaders.set('content-length', String(length));

  // A client that asked for a range gets 206 and the span it asked for; one
  // that did not gets a plain 200 covering the whole resource. Chromium's
  // media stack relies on both being exactly right to seek at all.
  const status = clientRange ? 206 : 200;
  if (clientRange) {
    outHeaders.set('content-range', `bytes ${start}-${finalEnd}/${total}`);
  }

  log.debug('ranged stream', { leg, start, finalEnd, total, chunkBytes });

  return new Response(body, { status, headers: outHeaders });
}

module.exports = {
  serveRanged,
  parseRange,
  totalFromContentRange,
  TransferStats,
  CHUNK_BYTES
};
