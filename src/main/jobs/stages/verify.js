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
const { VisionanceError, CODES } = require('../../errors');

const MIN_BYTES = 4096;
/** Encoders legitimately land a frame or two either side of the request. */
const DURATION_TOLERANCE_RATIO = 0.05;
const DURATION_TOLERANCE_SECONDS = 1.5;
const FPS_TOLERANCE = 0.75;

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

  /* ---- audio ---- */
  const wantAudio = recipe.audio.enabled && recipe.audio.mode !== 'none' &&
    (recipe.analysisRef ? recipe.analysisRef.hasAudio !== false : true);
  if (wantAudio) {
    add('audio track present', !!analysis.audio, 'one audio stream', analysis.audio ? analysis.audio.codec : 'none');
  } else {
    add('no audio track', !analysis.audio, 'no audio stream', analysis.audio ? analysis.audio.codec : 'none', false);
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
