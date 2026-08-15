'use strict';

/**
 * VERIFY stage.
 *
 * "ffmpeg exited 0" and "the user got a usable file" are not the same claim.
 * A truncated mux, a filter graph that silently produced the wrong geometry, a
 * dropped audio track - all of those exit cleanly. So before a job is allowed
 * to say `completed`, the output is probed and compared against what the recipe
 * asked for.
 *
 * Every check reports expected vs actual, so a failure is actionable rather
 * than a shrug.
 */

const fs = require('fs');
const { spawn } = require('child_process');
const { analyze } = require('../../media-analyzer');
const {
  aspectRatioOf, resolveFramingPlan, describeAspectRatio, RATIO_NAME_TOLERANCE
} = require('../../recipe');
const { VisionanceError, CODES } = require('../../errors');

const MIN_BYTES = 4096;
/** Encoders legitimately land a frame or two either side of the request. */
const DURATION_TOLERANCE_RATIO = 0.05;
const DURATION_TOLERANCE_SECONDS = 1.5;
const FPS_TOLERANCE = 0.75;
/**
 * Even-pixel rounding moves a ratio slightly, so an exact comparison would
 * reject good output. Shared with the ratio namer in `recipe.js` — two lists of
 * "what counts as 21:9" is one list too many.
 */
const ASPECT_TOLERANCE = RATIO_NAME_TOLERANCE;
/** Audio that stops early is as broken as audio that never existed. */
const AUDIO_DRIFT_SECONDS = 1.5;
/**
 * How short of the frame the visible picture may fall before a contract that
 * promised to fill it is considered broken.
 *
 * Generous on purpose. The failure this exists for left the picture 25% short
 * on one axis - 1920 of 2560 pixels - so nothing subtle needs catching, and a
 * loose threshold keeps a genuinely dark edge or a one-pixel rounding from
 * failing an otherwise good render.
 */
const FILL_TOLERANCE = 0.05;

/** Name a ratio the way the user chose it, so a failure reads plainly. */
const describeRatio = describeAspectRatio;

/* ------------------------------------------------------------------ *
 * Active picture
 *
 * The check that did not exist.
 *
 * A render asked for 21:9 at 2K produced a file that probed as 2560x1080, SAR
 * 1:1, DAR 64:27 — correct by every measure the verifier had — whose visible
 * content was a 1920x1080 16:9 picture with 320 px of black either side. The
 * container was ultrawide and the picture was not. Nothing downstream could
 * tell, because nothing downstream ever looked at a pixel.
 * ------------------------------------------------------------------ */

/**
 * One cropdetect pass over a window of the file.
 *
 * `reset=0` accumulates the union of non-black content across every frame it
 * sees, so a bar that is black for the whole window is reported while a single
 * dark shot cannot shrink the answer. Resolves null on any failure: an
 * unmeasurable picture is not the same claim as a broken one.
 */
function runCropDetect({ ffmpeg, filePath, startSeconds = 0, durationSeconds = 0, fps = 4, timeoutMs = 20000 }) {
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-nostdin', '-v', 'info'];
    if (startSeconds > 0) args.push('-ss', String(startSeconds));
    args.push('-i', filePath);
    if (durationSeconds > 0) args.push('-t', String(durationSeconds));
    args.push('-vf', `fps=${fps},cropdetect=limit=24:round=2:reset=0`);
    args.push('-an', '-sn', '-dn', '-f', 'null', '-');

    let proc;
    try {
      proc = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      return resolve(null);
    }
    let err = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, timeoutMs);
    proc.stderr.on('data', (c) => {
      err += c.toString();
      if (err.length > 400000) err = err.slice(-200000);
    });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('close', () => {
      clearTimeout(timer);
      const found = [...err.matchAll(/crop=(\d+):(\d+):(-?\d+):(-?\d+)/g)];
      if (!found.length) return resolve(null);
      const last = found[found.length - 1];
      resolve({
        width: Number(last[1]), height: Number(last[2]),
        x: Number(last[3]), y: Number(last[4])
      });
    });
  });
}

/**
 * The rectangle the picture actually occupies inside the frame.
 *
 * Sampled from two short windows rather than the whole file, and never from
 * the very start: padding introduced by a filter graph is in every frame, so a
 * dozen seconds of video answers the question, while an opening fade taken
 * alone would answer a different one. Bounded work regardless of how long the
 * render is.
 *
 * @returns {Promise<{x,y,width,height,windows}|null>} null when unmeasurable
 */
async function measureActivePicture({ ffmpeg, filePath, durationSeconds = 0 }) {
  if (!ffmpeg || !filePath) return null;
  const d = Number(durationSeconds) || 0;
  const windows = d > 20
    ? [{ start: d * 0.1, length: 6 }, { start: d * 0.55, length: 6 }]
    : [{ start: 0, length: 0 }];

  const rects = [];
  for (const w of windows) {
    // eslint-disable-next-line no-await-in-loop
    const r = await runCropDetect({
      ffmpeg, filePath, startSeconds: w.start, durationSeconds: w.length
    });
    if (r && r.width > 0 && r.height > 0) rects.push(r);
  }
  if (!rects.length) return null;

  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x: left, y: top, width: right - left, height: bottom - top, windows: rects.length };
}

/**
 * @param {object} ctx
 *   filePath   {string}  the part file to check
 *   recipe, geometry, plan
 *   bins       {{ffprobe:string}}
 *   report, log
 * @returns {Promise<{ok:boolean, checks:Array, failures:string[], analysis:object|null}>}
 */
async function runVerify(ctx) {
  const { filePath, recipe, geometry, plan, bins, report, log, jobId } = ctx;
  const checks = [];
  const add = (name, ok, expected, actual, fatal = true) => {
    checks.push({ name, ok, expected, actual, fatal });
  };

  report(0.1, 'Checking the rendered file');

  /* ---- existence and size ---- */
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    add('file exists', false, 'a file on disk', 'nothing');
    return finish(checks, null, jobId, log);
  }
  add('file exists', true, 'a file on disk', 'present');
  add('file is not empty', size >= MIN_BYTES, `≥ ${MIN_BYTES} bytes`, `${size} bytes`);

  if (size < MIN_BYTES) return finish(checks, null, jobId, log);

  /* ---- probe ---- */
  report(0.4, 'Probing streams');
  let analysis = null;
  try {
    analysis = await analyze(bins.ffprobe, filePath, { timeoutMs: 30000 });
  } catch (err) {
    add('output is readable video', false, 'a decodable video stream', err.message || 'probe failed');
    return finish(checks, null, jobId, log);
  }
  add('output is readable video', true, 'a decodable video stream', analysis.video.codec || 'video');

  /* ---- duration ---- */
  const expectedDuration = plan && plan.totalDuration ? plan.totalDuration : null;
  const actualDuration = analysis.container.duration;
  if (expectedDuration && actualDuration != null) {
    const tolerance = Math.max(DURATION_TOLERANCE_SECONDS, expectedDuration * DURATION_TOLERANCE_RATIO);
    add(
      'duration is plausible',
      Math.abs(actualDuration - expectedDuration) <= tolerance,
      `${expectedDuration.toFixed(2)}s ±${tolerance.toFixed(2)}s`,
      `${actualDuration.toFixed(2)}s`
    );
  } else if (actualDuration != null) {
    add('duration is present', actualDuration > 0, '> 0s', `${actualDuration.toFixed(2)}s`);
  }

  /* ---- geometry ---- */
  if (geometry && geometry.width && geometry.height) {
    const w = analysis.derived.displayWidth;
    const h = analysis.derived.displayHeight;
    add(
      'resolution matches the recipe',
      w === geometry.width && h === geometry.height,
      `${geometry.width}×${geometry.height}`,
      `${w}×${h}`
    );

    /*
     * The shape, checked separately from the size.
     *
     * A render that asked for 21:9 produced 2560x1440 — the right *size* class
     * and the wrong shape — and passed verification, because the only geometry
     * check compared the output against a resolved width and height that had
     * already been corrupted by the same bug. Comparing the ratio against the
     * *canvas the user chose* is an independent question, and it is the one
     * that catches this.
     */
    const wanted = recipe.framing && recipe.framing.enabled
      ? aspectRatioOf(recipe.framing.canvas, recipe.framing)
      : null;
    if (wanted && w && h) {
      const actual = w / h;
      add(
        'aspect ratio matches the recipe',
        Math.abs(actual - wanted) <= ASPECT_TOLERANCE,
        `${describeRatio(wanted)} (${wanted.toFixed(3)})`,
        `${describeRatio(actual)} (${actual.toFixed(3)})`
      );
    }
  }

  /* ---- the picture inside the frame ----
   *
   * Driven by the *resolved framing contract*, not by a guess about what
   * bars mean. A Fit was asked to keep the whole frame, so its bars are the
   * feature; a Fill/Smart Reframe/Stretch promised the picture reaches every
   * edge, and a picture that does not is the failure this whole check exists
   * for. Reporting one rule for both would either bless the broken render or
   * condemn a legitimate one.
   */
  const framing = geometry ? resolveFramingPlan(recipe, geometry) : null;
  if (framing && framing.active && ctx.bins && ctx.bins.ffmpeg &&
      analysis.derived.displayWidth && analysis.derived.displayHeight) {
    report(0.7, 'Checking the picture fills the frame');
    const w = analysis.derived.displayWidth;
    const h = analysis.derived.displayHeight;
    const active = await measureActivePicture({
      ffmpeg: ctx.bins.ffmpeg,
      filePath,
      durationSeconds: analysis.container.duration
    });

    /*
     * A picture measuring smaller than a quarter of the frame is far more
     * likely to be a dark passage than a framing fault: the failure this check
     * exists for still filled three quarters of the width and all of the
     * height. Below that the measurement is not trusted rather than believed.
     */
    const plausible = active && (active.width * active.height) >= (w * h) * 0.25;

    if (!active || !plausible) {
      // Not measurable is not the same as wrong.
      add('picture fills the frame', true, 'a measurable picture',
        active ? 'too dark to measure' : 'not measurable', false);
    } else if (framing.fills) {
      const fill = Math.min(active.width / w, active.height / h);
      const short = fill < 1 - FILL_TOLERANCE;
      add(
        'picture fills the frame',
        !short,
        `${w}×${h} of picture (${framing.mode} fills the canvas)`,
        short
          ? `${active.width}×${active.height} of picture with ${Math.round((1 - fill) * 100)}% ` +
            'unused border — the canvas is the right shape but the picture is not filling it. ' +
            'If the source itself has bars baked into the frame, choose Fit to keep them ' +
            'deliberately, or crop them off before rendering'
          : `${active.width}×${active.height}`
      );
    } else {
      // A deliberate Fit: the picture is *meant* to sit inside bars, so the
      // question is whether it is the size the contract predicted.
      const wantW = framing.activeWidth || w;
      const wantH = framing.activeHeight || h;
      const off = Math.max(Math.abs(active.width - wantW) / w, Math.abs(active.height - wantH) / h);
      add(
        'kept picture is the size the fit predicted',
        // A blurred background legitimately reaches the edges, so a measured
        // full frame there says nothing and must not be read as a failure.
        off <= FILL_TOLERANCE || framing.background === 'blur',
        `${wantW}×${wantH} inside a ${w}×${h} canvas`,
        `${active.width}×${active.height}`,
        false
      );
    }
  }

  /* ---- frame rate ---- */
  if (geometry && geometry.fps) {
    const actualFps = analysis.video.nominalFps;
    add(
      'frame rate matches the recipe',
      actualFps != null && Math.abs(actualFps - geometry.fps) <= FPS_TOLERANCE,
      `${geometry.fps} fps ±${FPS_TOLERANCE}`,
      actualFps != null ? `${actualFps} fps` : 'unknown',
      // A container that does not state a rate is odd but not a broken file.
      actualFps != null
    );
  }

  /* ---- audio ----
   *
   * The expectation comes from the job contract — what the render was set up
   * to produce — not from a fact the source analysis happened to record.
   *
   * It used to be `recipe.audio.enabled && analysisRef.hasAudio !== false`.
   * For a YouTube split source the analysis probes the video-only leg, so
   * `hasAudio` is false, so the verifier *expected silence*, and a 610 MB
   * music video with no sound was marked Completed. The verifier was asking
   * the same broken oracle that had caused the failure.
   *
   * `ctx.expected.hasAudio` is set by the job manager from the recipe alone.
   */
  const contractWantsAudio = ctx.expected && typeof ctx.expected.hasAudio === 'boolean'
    ? ctx.expected.hasAudio
    : (recipe.audio.enabled && recipe.audio.mode !== 'none');
  // A source with genuinely no audio cannot produce any, and saying "expected
  // one audio stream" about a silent film would be its own kind of wrong.
  const sourceHadAudio = ctx.sourceHasAudio !== false;

  if (contractWantsAudio && sourceHadAudio) {
    add('audio track present', !!analysis.audio, 'one audio stream',
      analysis.audio ? analysis.audio.codec : 'none');
    if (analysis.audio) {
      // A stream that exists but carries nothing is the other way to ship
      // silence, so its duration is checked against the picture's.
      const audioDuration = analysis.audio.duration != null
        ? analysis.audio.duration
        : analysis.container.duration;
      const videoDuration = analysis.container.duration;
      if (audioDuration != null && videoDuration) {
        const drift = Math.abs(audioDuration - videoDuration);
        add(
          'audio runs the length of the video',
          audioDuration > 0 && drift <= Math.max(AUDIO_DRIFT_SECONDS, videoDuration * 0.02),
          `≈ ${videoDuration.toFixed(2)}s`,
          `${audioDuration.toFixed(2)}s`
        );
      }
    }
  } else if (contractWantsAudio && !sourceHadAudio) {
    add('audio track present', true, 'none — the source has no audio', 'none', false);
  } else {
    add('no audio track', !analysis.audio, 'no audio stream',
      analysis.audio ? analysis.audio.codec : 'none', false);
  }

  report(1, 'Verified');
  return finish(checks, analysis, jobId, log);
}

function finish(checks, analysis, jobId, log) {
  const failures = checks.filter((c) => !c.ok && c.fatal);
  const soft = checks.filter((c) => !c.ok && !c.fatal);
  const ok = failures.length === 0;

  log.info('verification', {
    job: jobId,
    ok,
    failed: failures.map((f) => f.name).join(', ') || 'none',
    warned: soft.map((f) => f.name).join(', ') || 'none'
  });

  return {
    ok,
    checks,
    failures: failures.map((f) => `${f.name}: expected ${f.expected}, got ${f.actual}`),
    warnings: soft.map((f) => `${f.name}: expected ${f.expected}, got ${f.actual}`),
    analysis
  };
}

/** Build the structured error a failed verification should produce. */
function verificationError(result) {
  return new VisionanceError(CODES.VERIFICATION_FAILED, {
    message: `The render finished but the file failed ${result.failures.length} check(s).`,
    technicalDetails: result.failures.join(' | ')
  });
}

module.exports = { runVerify, verificationError, measureActivePicture, FILL_TOLERANCE };
