'use strict';

/**
 * Hard-cut detection.
 *
 * Frame interpolation across a cut is the single most visible way an AI render
 * can go wrong: the network is handed the last frame of one shot and the first
 * frame of the next and dutifully invents a smear of the two. Nobody watching
 * can miss it.
 *
 * ffmpeg's `scene` metric already gives a usable per-frame difference score, so
 * detection is a single decode pass over the chunk. The threshold comes from
 * the recipe (`motion.sceneCutThreshold`) and is a real 0..1 scene score, not
 * an opaque dial.
 *
 * The output is a list of chunk-relative timestamps where a new shot begins.
 * `interpolation-plan.js` turns those into shot boundaries and never lets a
 * pair straddle one.
 */

const { FfmpegRun } = require('../ffmpeg/process');
const { headerBlob } = require('../media-analyzer');
const { logger } = require('../logger');

const log = logger.child('scenes');

/**
 * @param {object} o
 *   ffmpeg, input, headers
 *   startSeconds, durationSeconds
 *   threshold      0..1 scene score, default 0.35
 *   maxWidth       downscale before scoring; detection does not need detail
 *   control
 * @returns {Promise<{cuts:number[], scores:Array<{time:number,score:number}>, ok:boolean}>}
 */
async function detectCuts({
  ffmpeg, input, headers = null, startSeconds = 0, durationSeconds = null,
  threshold = 0.35, maxWidth = 640, control = null
}) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'info'];
  if (/^https?:/i.test(input)) {
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  }
  const blob = headerBlob(headers);
  if (blob) args.push('-headers', blob);
  if (startSeconds > 0) args.push('-ss', String(startSeconds));
  args.push('-i', input);
  if (durationSeconds) args.push('-t', String(durationSeconds));

  // Scoring at reduced size is far cheaper and does not change where the cuts
  // are; `metadata=print` puts the timestamps somewhere machine-readable.
  args.push(
    '-vf',
    `scale=${maxWidth}:-2:flags=bilinear,select='gt(scene,${clamp01(threshold)})',metadata=print:file=-`
  );
  args.push('-an', '-sn', '-dn');
  args.push('-fps_mode', 'passthrough');
  args.push('-f', 'null', '-');

  const run = new FfmpegRun(ffmpeg, args, { durationSeconds: durationSeconds || 0 });
  if (control) control.activeRun = run;
  if (control && control.cancelled) run.cancel('cancelled');

  // `metadata=print:file=-` writes to stdout, which FfmpegRun consumes as
  // progress lines, so capture it here instead of parsing progress output.
  let captured = '';
  const origConsume = run._consume.bind(run);
  run._consume = (line) => {
    captured += line + '\n';
    origConsume(line);
  };

  let result;
  try {
    result = await run.run();
  } finally {
    if (control) control.activeRun = null;
  }

  if (result.cancelled) return { cuts: [], scores: [], ok: false, cancelled: true };

  const scores = parseSceneOutput(captured + '\n' + (result.stderrTail || ''));
  const cuts = scores.map((s) => s.time).filter((t) => t > 0.0001);

  if (result.code !== 0) {
    // Detection is an optimisation, not a requirement: if it fails we simply
    // treat the chunk as one shot, which is the safe direction (RIFE sees fewer
    // boundaries, never more).
    log.warn('scene detection failed; treating chunk as a single shot', {
      code: result.code,
      detail: (result.stderrTail || '').slice(-200)
    });
    return { cuts: [], scores: [], ok: false };
  }

  log.info('scene detection', {
    start: startSeconds,
    seconds: durationSeconds,
    threshold,
    cuts: cuts.length
  });
  return { cuts, scores, ok: true };
}

/**
 * Pull `pts_time` out of ffmpeg's metadata dump.
 * Lines look like:
 *   frame:12   pts:12288   pts_time:0.512
 *   lavfi.scene_score=0.812345
 */
function parseSceneOutput(text) {
  const out = [];
  let pending = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    const frame = /^frame:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:\s*(-?[\d.]+)/.exec(line);
    if (frame) {
      pending = { time: Number(frame[3]), score: null };
      out.push(pending);
      continue;
    }
    const score = /lavfi\.scene_score\s*[=:]\s*([\d.]+)/.exec(line);
    if (score && pending) pending.score = Number(score[1]);
  }
  return out.filter((s) => Number.isFinite(s.time) && s.time >= 0);
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.35;
  return Math.min(0.999, Math.max(0.01, n));
}

module.exports = { detectCuts, parseSceneOutput, clamp01 };
