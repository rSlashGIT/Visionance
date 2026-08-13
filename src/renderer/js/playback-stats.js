/**
 * Playback diagnostics.
 *
 * Frame pacing cannot be diagnosed from CPU percentages. "50% GPU" tells you
 * nothing about whether frames reached the screen on time; `dropped / total`
 * and the spread of presentation intervals do.
 *
 * Everything here is measured from real media APIs:
 *   - `getVideoPlaybackQuality()` for the decoder's own dropped/total counts
 *   - `requestVideoFrameCallback` for the actual presentation cadence and the
 *     jitter around it
 *   - `buffered` for how much runway the network has given us
 *
 * This runs whether or not the panel is visible, because the interesting
 * question is almost always "what happened before I opened the panel". It costs
 * one callback per presented frame and no pixel work.
 *
 * ## Counting presented frames correctly
 *
 * `requestVideoFrameCallback` is *not* guaranteed to fire once per presented
 * frame. When the page is busy - which, with enhancement on, is exactly when
 * the number matters - the browser coalesces callbacks and several frames can
 * be composited between two invocations. Deriving the rate from the interval
 * between callbacks therefore under-reports precisely when the user is looking
 * at it to find out whether playback is smooth: a real 29.97 fps source with
 * 1.1% dropped frames measured "20.1 fps" that way, which is a number nobody
 * can act on.
 *
 * The metadata carries the compositor's own running total, `presentedFrames`,
 * for this reason - the spec exposes it so a client can tell that frames were
 * missed between callbacks. So the rate is `Δ presentedFrames / Δ wall clock`
 * over a short sliding window, which counts the frames the *compositor* put on
 * screen rather than the callbacks *we* happened to receive. Callback counting
 * remains as a fallback for engines that do not populate the metadata.
 */

(function () {
  'use strict';

  const MAX_INTERVALS = 240;
  /** Sliding window for the rate. Long enough to be steady at 24 fps, short
   *  enough to follow a real change within a second or so. */
  const RATE_WINDOW_MS = 2000;
  const MIN_RATE_SAMPLES = 3;
  /** A gap longer than this is a seek, a stall or a hidden tab, not a cadence. */
  const DISCONTINUITY_MS = 500;

  /**
   * Presentation rate from a window of frame samples.
   *
   * Pure arithmetic over `{ at, presentedFrames, mediaTime }`, so every source
   * rate can be tested without a GPU, a display or a video file.
   *
   * @param {Array<{at:number, presentedFrames:number|null, mediaTime:number|null}>} samples
   * @returns {{presentedFps:number, mediaFps:number, frames:number, spanMs:number,
   *            basis:'compositor'|'callbacks'|'none'}}
   */
  function computePresentationRate(samples) {
    const none = { presentedFps: 0, mediaFps: 0, frames: 0, spanMs: 0, basis: 'none' };
    if (!samples || samples.length < MIN_RATE_SAMPLES) return none;

    const first = samples[0];
    const last = samples[samples.length - 1];
    const spanMs = last.at - first.at;
    if (spanMs <= 0) return none;

    // The compositor's own count, where the engine provides it. This is the
    // number that stays correct when our callbacks are coalesced.
    const haveCounter =
      Number.isFinite(first.presentedFrames) && Number.isFinite(last.presentedFrames) &&
      last.presentedFrames >= first.presentedFrames;

    const frames = haveCounter
      ? last.presentedFrames - first.presentedFrames
      : samples.length - 1;

    const presentedFps = (frames * 1000) / spanMs;

    // How fast the *media* advanced over the same window. For ordinary
    // playback this equals presentedFps; where they differ they say something
    // real - 3:2 pulldown presents more frames than the source has, and a
    // starved network presents fewer.
    let mediaFps = 0;
    if (Number.isFinite(first.mediaTime) && Number.isFinite(last.mediaTime)) {
      const mediaSpan = last.mediaTime - first.mediaTime;
      if (mediaSpan > 0) mediaFps = frames / mediaSpan;
    }

    return {
      presentedFps: Math.round(presentedFps * 10) / 10,
      mediaFps: Math.round(mediaFps * 10) / 10,
      frames,
      spanMs: Math.round(spanMs),
      basis: haveCounter ? 'compositor' : 'callbacks'
    };
  }

  class PlaybackStats {
    /** @param {HTMLVideoElement} video */
    constructor(video) {
      this.video = video;
      this.reset();
      this._onFrame = this._onFrame.bind(this);
      this._handle = null;
      this._listeners = [];
      this._bind();
    }

    reset() {
      this.startedAt = performance.now();
      this.intervals = [];
      this.rateSamples = [];
      this.lastPresentedAt = 0;
      this.presentedFrames = 0;
      this.stalls = 0;
      this.stalledMs = 0;
      this._stallStartedAt = 0;
      this.baseline = null;
      this.lastMeta = null;
      this.label = '';
    }

    /**
     * Zero the counters at the current point, so a before/after comparison
     * measures the change rather than everything since the page loaded.
     */
    mark(label) {
      const q = this.quality();
      this.baseline = q ? { total: q.total, dropped: q.dropped } : null;
      this.startedAt = performance.now();
      this.intervals = [];
      this.rateSamples = [];
      this.presentedFrames = 0;
      this.stalls = 0;
      this.stalledMs = 0;
      this.label = label || '';
      return this.snapshot();
    }

    _on(target, event, fn) {
      target.addEventListener(event, fn);
      this._listeners.push([target, event, fn]);
    }

    _bind() {
      const v = this.video;
      this._on(v, 'waiting', () => {
        this.stalls++;
        this._stallStartedAt = performance.now();
      });
      const endStall = () => {
        if (!this._stallStartedAt) return;
        this.stalledMs += performance.now() - this._stallStartedAt;
        this._stallStartedAt = 0;
      };
      this._on(v, 'playing', endStall);
      this._on(v, 'canplay', endStall);
      // A new source is a new measurement. Anything carried over would be
      // describing media that is no longer on screen.
      this._on(v, 'loadedmetadata', () => this.reset());
      this._on(v, 'emptied', () => this.reset());
      this._on(v, 'seeking', () => { this.rateSamples = []; this.intervals = []; });

      if (typeof v.requestVideoFrameCallback === 'function') {
        this._handle = v.requestVideoFrameCallback(this._onFrame);
      }
    }

    _onFrame(now, meta) {
      const gap = this.lastPresentedAt ? now - this.lastPresentedAt : 0;

      if (gap > 1 && gap < DISCONTINUITY_MS) {
        this.intervals.push(gap);
        if (this.intervals.length > MAX_INTERVALS) this.intervals.shift();
      }

      // A long gap, or media time going backwards, means the previous window
      // describes something that is no longer happening.
      const wentBackwards =
        this.lastMeta && meta && Number.isFinite(meta.mediaTime) &&
        Number.isFinite(this.lastMeta.mediaTime) && meta.mediaTime < this.lastMeta.mediaTime;
      if (gap >= DISCONTINUITY_MS || wentBackwards) this.rateSamples = [];

      this.rateSamples.push({
        at: now,
        presentedFrames: meta && Number.isFinite(meta.presentedFrames) ? meta.presentedFrames : null,
        mediaTime: meta && Number.isFinite(meta.mediaTime) ? meta.mediaTime : null
      });
      while (this.rateSamples.length > 2 &&
             now - this.rateSamples[0].at > RATE_WINDOW_MS) {
        this.rateSamples.shift();
      }

      this.lastPresentedAt = now;
      this.presentedFrames++;
      this.lastMeta = meta || null;
      this._handle = this.video.requestVideoFrameCallback(this._onFrame);
    }

    /** The decoder's own accounting, where the browser exposes it. */
    quality() {
      const v = this.video;
      if (typeof v.getVideoPlaybackQuality !== 'function') return null;
      const q = v.getVideoPlaybackQuality();
      return {
        total: q.totalVideoFrames || 0,
        dropped: q.droppedVideoFrames || 0,
        corrupted: q.corruptedVideoFrames || 0
      };
    }

    bufferedAhead() {
      const v = this.video;
      try {
        for (let i = 0; i < v.buffered.length; i++) {
          if (v.buffered.start(i) <= v.currentTime && v.buffered.end(i) >= v.currentTime) {
            return v.buffered.end(i) - v.currentTime;
          }
        }
      } catch { /* not ready */ }
      return 0;
    }

    /** Everything a before/after comparison needs, as plain numbers. */
    snapshot() {
      const v = this.video;
      const q = this.quality();
      const total = q ? q.total - (this.baseline ? this.baseline.total : 0) : 0;
      const dropped = q ? q.dropped - (this.baseline ? this.baseline.dropped : 0) : 0;

      const sorted = [...this.intervals].sort((a, b) => a - b);
      const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
      const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
      // Mean absolute deviation from the median: a steady 24 fps has a tiny
      // number here, a stuttering one does not, and unlike variance it is not
      // dominated by a single outlier.
      const jitter = sorted.length
        ? sorted.reduce((sum, x) => sum + Math.abs(x - median), 0) / sorted.length
        : 0;

      const rate = computePresentationRate(this.rateSamples);

      return {
        label: this.label,
        elapsedSec: Math.round((performance.now() - this.startedAt) / 100) / 10,
        videoWidth: v.videoWidth,
        videoHeight: v.videoHeight,
        readyState: v.readyState,
        paused: v.paused,
        currentTime: Math.round(v.currentTime * 100) / 100,
        totalFrames: total,
        droppedFrames: dropped,
        droppedPercent: total > 0 ? Math.round((dropped / total) * 1000) / 10 : 0,
        presentedFrames: this.presentedFrames,
        // Frames the compositor actually put on screen per second of wall
        // clock, not callbacks we happened to receive.
        presentedFps: rate.presentedFps,
        presentedBasis: rate.basis,
        presentedWindowMs: rate.spanMs,
        // What the media itself is running at. Equal to presentedFps in normal
        // playback; deliberately reported separately rather than reconciled.
        sourceFps: rate.mediaFps,
        medianIntervalMs: Math.round(median * 100) / 100,
        p95IntervalMs: Math.round(p95 * 100) / 100,
        jitterMs: Math.round(jitter * 100) / 100,
        bufferedAheadSec: Math.round(this.bufferedAhead() * 10) / 10,
        stalls: this.stalls,
        stalledMs: Math.round(this.stalledMs)
      };
    }

    dispose() {
      if (this._handle && this.video.cancelVideoFrameCallback) {
        try { this.video.cancelVideoFrameCallback(this._handle); } catch { /* ignore */ }
      }
      this._handle = null;
      for (const [target, event, fn] of this._listeners) {
        target.removeEventListener(event, fn);
      }
      this._listeners = [];
    }
  }

  const api = { PlaybackStats, computePresentationRate };
  if (typeof window !== 'undefined') window.VSPlaybackStats = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
