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
const { analyze } = require('../../media-analyzer');
const { aspectRatioOf } = require('../../recipe');
const { VisionanceError, CODES } = require('../../errors');

const MIN_BYTES = 4096;
/** Encoders legitimately land a frame or two either side of the request. */
const DURATION_TOLERANCE_RATIO = 0.05;
const DURATION_TOLERANCE_SECONDS = 1.5;
const FPS_TOLERANCE = 0.75;
/**
 * Even-pixel rounding moves a ratio slightly: 2560x1080 is 2.3704 against a
 * nominal 2.3704, but 3840x1608 is 2.3881 against 2.39. A tolerance of 0.02
 * accepts that and still rejects 16:9 (1.778) standing in for 21:9 (2.370).
 */
const ASPECT_TOLERANCE = 0.02;
/** Audio that stops early is as broken as audio that never existed. */
const AUDIO_DRIFT_SECONDS = 1.5;

const KNOWN_RATIOS = [
  [16 / 9, '16:9'], [9 / 16, '9:16'], [4 / 5, '4:5'], [1, '1:1'],
  [64 / 27, '21:9'], [2.39, '2.39:1'], [4 / 3, '4:3'], [3 / 2, '3:2']
];

/** Name a ratio the way the user chose it, so a failure reads plainly. */
function describeRatio(ratio) {
  for (const [value, label] of KNOWN_RATIOS) {
    if (Math.abs(ratio - value) < ASPECT_TOLERANCE) return label;
  }
  return `${ratio.toFixed(2)}:1`;
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

module.exports = { runVerify, verificationError };
