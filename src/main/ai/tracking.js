'use strict';

/**
 * Smart Reframe: deciding where to crop a 16:9 shot to make a 9:16 one.
 *
 * Backend choice
 * --------------
 * This is a **saliency tracker**, not a face detector. It samples frames at low
 * resolution and finds where the interesting content is, using two signals
 * ffmpeg can produce without any model at all:
 *
 *   motion  - inter-frame difference, which finds the moving subject
 *   detail  - local edge energy, which finds the in-focus subject when nothing
 *             is moving (a talking head against a blurred background)
 *
 * That is a deliberate trade. A face/person detector (an ONNX model such as
 * YuNet or a MediaPipe graph) would be better for talking-head content and is
 * the obvious upgrade path - the interface below is built for it, and
 * `TRACKER_BACKENDS` names the slot. But a detector is a ~10-100 MB model, a
 * runtime dependency and a licence to manage, and shipping a *working, tested*
 * saliency tracker beats shipping a half-integrated detector. What matters is
 * that the app never claims to be doing face detection when it is not: the
 * backend id travels with the trajectory and is surfaced in the UI and logs.
 *
 * Everything here is local. No cloud, no API key, no Python.
 */

const path = require('path');
const fs = require('fs');
const { FfmpegRun } = require('../ffmpeg/process');
const { headerBlob } = require('../media-analyzer');
const { VisionanceError, CODES } = require('../errors');
const { logger } = require('../logger');

const log = logger.child('reframe');

/**
 * What actually produced a trajectory.
 *
 * These are not marketing names: `primaryBackend` is chosen from the counted
 * contributions of each signal, so a run that fell back to saliency for most
 * of its samples reports saliency however much semantic machinery was
 * available.
 */
const TRACKER_BACKENDS = {
  saliency: { id: 'saliency', label: 'Motion & detail saliency', requiresModel: false },
  face: { id: 'face', label: 'Face tracking', requiresModel: true },
  person: { id: 'person', label: 'Person tracking', requiresModel: true },
  'face-person': { id: 'face-person', label: 'Face + person', requiresModel: true },
  hybrid: { id: 'hybrid', label: 'Semantic + saliency', requiresModel: true }
};

/**
 * Name the backend from what the samples actually used.
 *
 * @param {{face:number, person:number, saliency:number}} usage
 */
function primaryBackendFor(usage) {
  const face = usage.face || 0;
  const person = usage.person || 0;
  const saliency = usage.saliency || 0;
  const semantic = face + person;
  if (semantic === 0) return TRACKER_BACKENDS.saliency;
  // Saliency carried a meaningful share, so say so rather than claiming the
  // whole trajectory came from a detector. A fifth is the threshold: below
  // that it is a handful of gap-fills, above it the viewer is watching a
  // crop that saliency substantially decided.
  if (saliency > 0 && saliency / (semantic + saliency) >= 0.2) return TRACKER_BACKENDS.hybrid;
  if (face > 0 && person > 0) return TRACKER_BACKENDS['face-person'];
  if (face > 0) return TRACKER_BACKENDS.face;
  return TRACKER_BACKENDS.person;
}

/** Analysis grid. Coarse on purpose: we need a position, not a segmentation. */
const GRID_W = 32;
const GRID_H = 18;
/** Frames per second to sample. Subject position does not change that fast. */
const SAMPLE_FPS = 4;

/* ------------------------------------------------------------------ *
 * Sampling
 * ------------------------------------------------------------------ */

/**
 * Decode a low-resolution greyscale grid for every sampled frame.
 *
 * One ffmpeg pass, raw bytes on stdout: GRID_W * GRID_H bytes per frame at
 * SAMPLE_FPS. For a 60 s clip that is about 1.4 MB total - the whole point of
 * not writing analysis images to disk.
 */
function sampleGrid({ ffmpeg, input, headers, startSeconds = 0, durationSeconds, control }) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (/^https?:/i.test(input)) {
      args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
    }
    const blob = headerBlob(headers);
    if (blob) args.push('-headers', blob);
    if (startSeconds > 0) args.push('-ss', String(startSeconds));
    args.push('-i', input);
    if (durationSeconds) args.push('-t', String(durationSeconds));
    args.push('-vf', `fps=${SAMPLE_FPS},scale=${GRID_W}:${GRID_H}:flags=area,format=gray`);
    args.push('-f', 'rawvideo', '-pix_fmt', 'gray', '-');

    const { spawn } = require('child_process');
    const proc = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (control) control.activeRun = { cancel: () => { try { proc.kill(); } catch { /* gone */ } } };

    const chunks = [];
    let stderr = '';
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => { stderr = (stderr + c.toString()).slice(-2000); });
    proc.on('error', (err) => reject(new VisionanceError(CODES.STAGE_FAILED, {
      message: 'Subject analysis could not start.',
      technicalDetails: err.message
    })));
    proc.on('close', (code) => {
      if (control) control.activeRun = null;
      if (control && control.cancelled) return reject(new VisionanceError(CODES.CANCELLED));
      if (code !== 0) {
        return reject(new VisionanceError(CODES.STAGE_FAILED, {
          message: 'Subject analysis failed.',
          technicalDetails: `ffmpeg exit ${code}: ${stderr.slice(-300)}`
        }));
      }
      const buf = Buffer.concat(chunks);
      const frameSize = GRID_W * GRID_H;
      const frames = [];
      for (let off = 0; off + frameSize <= buf.length; off += frameSize) {
        frames.push(buf.subarray(off, off + frameSize));
      }
      resolve(frames);
    });
  });
}

/* ------------------------------------------------------------------ *
 * Saliency
 * ------------------------------------------------------------------ */

/** Local edge energy: how much detail sits in each column. */
function detailColumns(frame) {
  const cols = new Float64Array(GRID_W);
  for (let y = 1; y < GRID_H - 1; y++) {
    for (let x = 1; x < GRID_W - 1; x++) {
      const i = y * GRID_W + x;
      const dx = Math.abs(frame[i + 1] - frame[i - 1]);
      const dy = Math.abs(frame[i + GRID_W] - frame[i - GRID_W]);
      cols[x] += dx + dy;
    }
  }
  return cols;
}

/** Inter-frame motion per column. */
function motionColumns(frame, prev) {
  const cols = new Float64Array(GRID_W);
  if (!prev) return cols;
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const i = y * GRID_W + x;
      cols[x] += Math.abs(frame[i] - prev[i]);
    }
  }
  return cols;
}

/**
 * Where is the subject, horizontally, in this frame?
 * @returns {{center:number, confidence:number}} center is 0..1 across the frame
 */
function locateSubject(frame, prev) {
  const motion = motionColumns(frame, prev);
  const detail = detailColumns(frame);

  const motionSum = motion.reduce((a, b) => a + b, 0);
  const detailSum = detail.reduce((a, b) => a + b, 0);

  // Motion is the stronger cue when there is any; detail carries a static shot.
  const weights = new Float64Array(GRID_W);
  for (let x = 0; x < GRID_W; x++) {
    const m = motionSum > 0 ? motion[x] / motionSum : 0;
    const dtl = detailSum > 0 ? detail[x] / detailSum : 0;
    weights[x] = motionSum > detailSum * 0.05 ? m * 0.75 + dtl * 0.25 : dtl;
  }

  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return { center: 0.5, confidence: 0 };

  let centroid = 0;
  for (let x = 0; x < GRID_W; x++) centroid += ((x + 0.5) / GRID_W) * weights[x];
  centroid /= total;

  // Confidence: how concentrated the energy is. A flat distribution means
  // "everything is equally interesting", which is the same as knowing nothing.
  let variance = 0;
  for (let x = 0; x < GRID_W; x++) {
    const p = weights[x] / total;
    variance += p * Math.pow((x + 0.5) / GRID_W - centroid, 2);
  }
  const spread = Math.sqrt(variance);
  const confidence = Math.max(0, Math.min(1, 1 - spread / 0.29));

  return { center: centroid, confidence };
}

/* ------------------------------------------------------------------ *
 * Trajectory
 * ------------------------------------------------------------------ */

/** How hard the crop is allowed to chase the subject, per content profile. */
/**
 * `smoothing` is the fraction of the remaining error corrected per sample, and
 * `maxStepPerSecond` caps how fast the crop may travel. The two do different
 * jobs: smoothing stops the crop twitching, the cap stops it whip-panning.
 *
 * Smoothing has to be high enough to actually catch a moving subject - a 9:16
 * crop of a 16:9 frame is only ~32% of the width, so a crop that lags by a
 * quarter of the frame has already lost the subject.
 */
const MOTION_PROFILES = {
  calm: { smoothing: 0.18, maxStepPerSecond: 0.2, deadZone: 0.05 },
  normal: { smoothing: 0.32, maxStepPerSecond: 0.45, deadZone: 0.035 },
  fast: { smoothing: 0.5, maxStepPerSecond: 0.9, deadZone: 0.02 }
};

function motionProfileFor(profile) {
  if (profile === 'film' || profile === 'dialogue' || profile === 'screencast') return 'calm';
  if (profile === 'action' || profile === 'gaming') return 'fast';
  return 'normal';
}

/**
 * Turn per-sample observations into a smooth, bounded crop path.
 *
 * Three properties matter more than accuracy:
 *   - it must not oscillate (a crop that jitters left/right is unwatchable)
 *   - it must not lag so far that the subject leaves the frame
 *   - it must snap, not glide, across a hard cut - gliding across a cut looks
 *     like a camera move that never happened
 *
 * @param {object} o
 *   samples   [{ time, center, confidence }]
 *   cuts      cut timestamps in seconds
 *   profile   content profile id
 *   minConfidence
 * @returns {{points:Array<{time,center}>, backend, fallbacks:number, holds:number}}
 */
function buildTrajectory({ samples, cuts = [], profile = 'auto', minConfidence = 0.18 }) {
  const tuning = MOTION_PROFILES[motionProfileFor(profile)];
  const cutSet = [...cuts].sort((a, b) => a - b);

  const points = [];
  let current = 0.5;
  let haveLock = false;
  let fallbacks = 0;
  let holds = 0;
  let tracked = 0;
  let trackedConfidence = 0;
  let nextCut = 0;
  /** Which signal decided each tracked sample. */
  const usage = { face: 0, person: 0, saliency: 0 };

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const prevTime = i > 0 ? samples[i - 1].time : 0;

    // A hard cut invalidates everything we knew about where the subject was.
    let crossedCut = false;
    while (nextCut < cutSet.length && cutSet[nextCut] <= s.time) {
      if (cutSet[nextCut] > prevTime) crossedCut = true;
      nextCut++;
    }
    if (crossedCut) {
      haveLock = false;
      if (s.confidence >= minConfidence) {
        // Jump straight to the new shot's subject rather than gliding.
        current = s.center;
        haveLock = true;
        tracked++;
        trackedConfidence += s.confidence;
        usage[s.source || 'saliency'] = (usage[s.source || 'saliency'] || 0) + 1;
      } else {
        // A cut into a shot we cannot read is a centre fallback like any
        // other. Counting it as neither used to make the totals not add up.
        holds++;
        fallbacks++;
      }
      points.push({ time: s.time, center: current, cut: true, source: s.source || 'centre' });
      continue;
    }

    if (s.confidence < minConfidence) {
      // Detection is unreliable for this frame: hold the last good position
      // rather than lurching to a meaningless centroid.
      holds++;
      if (!haveLock) fallbacks++;
      points.push({ time: s.time, center: current, source: haveLock ? 'hold' : 'centre' });
      continue;
    }

    tracked++;
    trackedConfidence += s.confidence;
    usage[s.source || 'saliency'] = (usage[s.source || 'saliency'] || 0) + 1;

    const target = s.center;

    // No lock yet - the very first confident detection, or the first one after
    // a lost stretch. Start *at* the subject rather than gliding in from the
    // centre, which would waste the opening second of the shot on a move the
    // camera never made.
    if (!haveLock) {
      current = target;
      haveLock = true;
      points.push({ time: s.time, center: current, source: s.source || 'saliency' });
      continue;
    }

    const delta = target - current;

    // Dead zone: ignore small wobble so a stationary subject gives a still crop.
    if (Math.abs(delta) < tuning.deadZone) {
      points.push({ time: s.time, center: current, source: s.source || 'saliency' });
      haveLock = true;
      continue;
    }

    const dt = Math.max(1 / SAMPLE_FPS, s.time - prevTime);
    const maxStep = tuning.maxStepPerSecond * dt;
    const smoothed = delta * tuning.smoothing;
    const step = Math.max(-maxStep, Math.min(maxStep, smoothed));
    current = Math.max(0, Math.min(1, current + step));
    haveLock = true;
    points.push({ time: s.time, center: current, source: s.source || 'saliency' });
  }

  return {
    points,
    fallbacks,
    holds,
    tracked,
    usage,
    // Mean confidence **of the samples that were actually used**. Averaging in
    // the ones we rejected would describe neither the detector nor the result.
    trackedConfidence: tracked > 0 ? trackedConfidence / tracked : 0
  };
}

/* ------------------------------------------------------------------ *
 * Outcome
 *
 * One function decides what happened, and every message anyone shows is
 * derived from it. Before this existed, three places described the same run in
 * their own vocabulary against their own thresholds - the queue printed the
 * mean confidence of the *raw detector* over every sample, `tracking.js`
 * warned from a fallback count, and `filters.js` announced "the crop follows
 * the subject" purely because the compiled expression was not a constant. So a
 * job could report "100% confidence, crop follows the subject" directly above
 * "the subject could not be located reliably". All three were reading
 * different numbers; none of them was reading the outcome.
 * ------------------------------------------------------------------ */

/** Below this share of usable samples, the crop is not really tracking. */
const TRACKED_OK = 0.6;
const TRACKED_PARTIAL = 0.25;

/**
 * @param {object} o { samples, tracked, holds, fallbacks, trackedConfidence, cuts }
 * @returns {{outcome, coverage, confidence, tracked, held, centred, samples,
 *            scenes, headline, detail, warning}}
 */
function summariseTracking({
  samples, tracked, holds, fallbacks, trackedConfidence, cuts = 0,
  usage = null, semanticAvailable = false
}) {
  const total = Math.max(1, samples);
  const coverage = tracked / total;
  const confidence = tracked > 0 ? trackedConfidence : 0;
  const scenes = cuts + 1;

  // `holds` counts every sample that reused the previous position; `fallbacks`
  // is the subset that had no previous position to reuse and therefore sat at
  // the centre. They are nested, not parallel, and reporting them as if they
  // were parallel was half the confusion.
  const centred = fallbacks;
  const held = Math.max(0, holds - fallbacks);

  // Which signal actually decided each tracked sample. The invariant the
  // previous patch established still holds:
  //     tracked + held + centred === samples
  // and now, additionally:
  //     faceSamples + personSamples + saliencySamples === tracked
  const counts = usage || {};
  const faceSamples = counts.face || 0;
  const personSamples = counts.person || 0;
  const saliencySamples = counts.saliency || 0;
  const semanticSamples = faceSamples + personSamples;
  const backend = primaryBackendFor({
    face: faceSamples, person: personSamples, saliency: saliencySamples
  });

  let outcome;
  if (coverage >= TRACKED_OK) outcome = 'tracked';
  else if (coverage >= TRACKED_PARTIAL) outcome = 'partial';
  else outcome = 'centred';

  const pct = Math.round(confidence * 100);
  let headline;
  let warning = null;

  if (outcome === 'tracked') {
    headline = `Tracked ${tracked} of ${total} samples`;
  } else if (outcome === 'partial') {
    headline = `Tracked ${tracked} of ${total} samples`;
    warning = `Smart Reframe could only follow the subject for ${Math.round(coverage * 100)}% of this clip; ` +
      'the rest holds the last good position.';
  } else {
    headline = `Tracked ${tracked} of ${total} samples`;
    warning = 'Subject could not be tracked reliably. Centre framing was used for most of the clip.';
  }

  // A confidence is only meaningful where something was tracked, and a
  // failure must never carry one.
  if (outcome !== 'centred') headline += ` · confidence ${pct}%`;

  // The detail line names the signals in the order they contributed, so
  // "30 face · 6 person" cannot appear for a run that was mostly saliency.
  const detail = [];
  if (faceSamples) detail.push(`${faceSamples} face`);
  if (personSamples) detail.push(`${personSamples} person`);
  if (saliencySamples) detail.push(`${saliencySamples} saliency`);
  if (held > 0) detail.push(`${held} held`);
  if (centred > 0) detail.push(`${centred} centred`);
  if (scenes > 1) detail.push(`${scenes} scenes`);

  return {
    outcome,
    samples: total,
    tracked,
    held,
    centred,
    coverage: Math.round(coverage * 1000) / 1000,
    confidence: Math.round(confidence * 1000) / 1000,
    trackingConfidence: Math.round(confidence * 1000) / 1000,
    scenes,

    semanticSamples,
    faceSamples,
    personSamples,
    saliencySamples,
    semanticAvailable: !!semanticAvailable,

    primaryBackend: backend.id,
    primaryBackendLabel: backend.label,
    backendUsage: {
      face: faceSamples, person: personSamples, saliency: saliencySamples,
      hold: held, centre: centred
    },

    headline,
    detail,
    warning
  };
}

/**
 * Analyse a source and produce a crop trajectory.
 *
 * @returns {{backend, points, width, cropWidthFraction, fallbacks, holds,
 *            confidence, notes:string[]}}
 */
async function analyseSubject({
  ffmpeg, input, headers = null, startSeconds = 0, durationSeconds,
  cuts = [], profile = 'auto', targetAspect, sourceAspect, control = null,
  /**
   * Where the semantic models live, or null to skip semantic entirely.
   * Absent, unreadable or broken means saliency - never a failed export.
   */
  semanticModelsDir = null,
  semanticEnabled = true
}) {
  const notes = [];

  /* ---- 1. saliency grid: the canonical sample timeline ---- */
  const frames = await sampleGrid({ ffmpeg, input, headers, startSeconds, durationSeconds, control });
  if (!frames.length) {
    throw new VisionanceError(CODES.STAGE_FAILED, {
      message: 'Subject analysis produced no frames.'
    });
  }

  const samples = [];
  let prev = null;
  for (let i = 0; i < frames.length; i++) {
    const { center, confidence } = locateSubject(frames[i], prev);
    samples.push({ time: i / SAMPLE_FPS, center, confidence, source: 'saliency' });
    prev = frames[i];
  }

  const cropWidthFraction = Math.min(1, (targetAspect / sourceAspect));

  /* ---- 2. semantic layer, above the saliency it does not replace ---- */
  const semanticResult = await runSemanticLayer({
    ffmpeg, input, headers, startSeconds, durationSeconds, control,
    profile, cuts, samples, cropWidthFraction,
    modelsDir: semanticEnabled ? semanticModelsDir : null,
    notes
  });

  /* ---- 3. trajectory from whatever each sample ended up trusting ---- */
  const trajectory = buildTrajectory({ samples, cuts, profile });

  const summary = summariseTracking({
    samples: samples.length,
    tracked: trajectory.tracked,
    holds: trajectory.holds,
    fallbacks: trajectory.fallbacks,
    trackedConfidence: trajectory.trackedConfidence,
    cuts: cuts.length,
    usage: trajectory.usage,
    semanticAvailable: semanticResult.available
  });

  if (summary.warning) notes.push(summary.warning);

  log.info('subject analysis', {
    outcome: summary.outcome,
    backend: summary.primaryBackend,
    samples: summary.samples,
    tracked: summary.tracked,
    face: summary.faceSamples,
    person: summary.personSamples,
    saliency: summary.saliencySamples,
    held: summary.held,
    centred: summary.centred,
    scenes: summary.scenes,
    semanticMs: semanticResult.ms,
    semanticFrames: semanticResult.frames
  });

  return {
    backend: summary.primaryBackend,
    backendLabel: summary.primaryBackendLabel,
    points: trajectory.points,
    sampleFps: SAMPLE_FPS,
    cropWidthFraction,
    fallbacks: trajectory.fallbacks,
    holds: trajectory.holds,
    semantic: semanticResult,
    ...summary,
    notes
  };
}

/**
 * Run face/person detection over the clip and write the results back onto the
 * saliency samples in place.
 *
 * Returns rather than throws on every failure path. Semantic tracking is an
 * improvement to a working feature, not a new dependency of it: a missing
 * runtime, a missing model, a load failure or an inference error all end with
 * the saliency samples untouched and a note the user can read.
 */
async function runSemanticLayer({
  ffmpeg, input, headers, startSeconds, durationSeconds, control,
  profile, cuts, samples, cropWidthFraction, modelsDir, notes
}) {
  const result = {
    available: false, attempted: false, frames: 0, ms: 0,
    faces: 0, persons: 0, reason: null, backend: null
  };
  if (!modelsDir) {
    result.reason = 'disabled';
    return result;
  }

  // Required lazily so a build without the optional runtime still loads this
  // module - the whole point of the fallback chain.
  let detector;
  let subjectTrack;
  try {
    // eslint-disable-next-line global-require
    detector = require('./detector');
    // eslint-disable-next-line global-require
    subjectTrack = require('./subject-track');
  } catch (err) {
    result.reason = 'detector unavailable (' + err.message + ')';
    notes.push('Semantic subject detection is unavailable; motion and detail tracking was used.');
    return result;
  }

  const probe = detector.probe(modelsDir);
  if (!probe.ready) {
    result.reason = probe.runtime
      ? 'models missing: ' + probe.missingModels.join(', ')
      : 'runtime unavailable: ' + probe.runtimeError;
    notes.push(
      probe.runtime
        ? 'The face and person models are not installed, so motion and detail tracking was used.'
        : 'The semantic detection runtime is unavailable, so motion and detail tracking was used.'
    );
    return result;
  }

  result.attempted = true;
  const started = Date.now();
  const engine = new detector.SemanticDetector({ modelsDir });

  let loaded = false;
  try {
    loaded = await engine.load();
  } catch (err) {
    result.reason = 'load failed (' + err.message + ')';
  }
  if (!loaded) {
    result.reason = result.reason || engine.error || 'load failed';
    notes.push('Semantic subject detection could not start; motion and detail tracking was used.');
    engine.dispose();
    return result;
  }

  const plan = subjectTrack.planSemanticSampling(durationSeconds || (samples.length / SAMPLE_FPS));
  const tracker = new subjectTrack.SubjectTracker({ profile });
  const cutTimes = [...cuts].sort((a, b) => a - b);
  let nextCut = 0;
  let lastTime = 0;

  try {
    // eslint-disable-next-line global-require
    const { streamSemanticFrames } = require('./semantic-samples');
    const stream = await streamSemanticFrames({
      ffmpeg, input, headers, startSeconds, durationSeconds, control,
      intervalSeconds: plan.intervalSeconds,
      onFrame: async (rgb, index, time) => {
        // A hard cut invalidates identity: do not glide the previous shot's
        // subject into the next one.
        while (nextCut < cutTimes.length && cutTimes[nextCut] <= time) {
          if (cutTimes[nextCut] > lastTime) tracker.reset();
          nextCut++;
        }
        lastTime = time;

        const found = await engine.detect(rgb);
        result.faces += found.faces.length;
        result.persons += found.persons.length;

        const elected = tracker.observe({ time, faces: found.faces, persons: found.persons });
        if (!elected.subject || !elected.source) return;

        const composed = tracker.compose(elected.subject, cropWidthFraction);
        if (!composed) return;

        // Write onto the nearest canonical sample. The sampling plan snaps to
        // the saliency grid precisely so this lands on a real sample rather
        // than being attributed to one it does not belong to.
        const slot = Math.round(time * SAMPLE_FPS);
        const sample = samples[slot];
        if (!sample) return;
        sample.center = composed.x;
        // A semantic detection is a far stronger statement than a saliency
        // centroid, so it enters the trajectory with high confidence and is
        // labelled with the signal that produced it.
        sample.confidence = Math.max(sample.confidence, Math.min(0.99, 0.55 + elected.subject.score * 0.4));
        sample.source = elected.source;
        sample.semantic = true;
      }
    });
    result.frames = stream.frames;
  } catch (err) {
    if (err && err.code === CODES.CANCELLED) {
      engine.dispose();
      throw err;
    }
    result.reason = 'inference failed (' + (err && err.message) + ')';
    notes.push('Semantic subject detection failed part-way; motion and detail tracking covered the rest.');
  }

  result.ms = Date.now() - started;
  result.available = true;
  result.backend = engine.backend;
  result.inferenceMs = engine.stats.inferenceMs;
  result.interval = plan.intervalSeconds;
  engine.dispose();
  return result;
}

/**
 * Compile a trajectory into an ffmpeg crop expression.
 *
 * The x position is a piecewise-linear function of time, expressed with
 * nested `if(lt(t,..))` terms. Keeping it declarative means the crop happens
 * inside the same filter graph as everything else - no second pass, no frame
 * dump, and it composes with chunked rendering because `t` is chunk-relative.
 */
function buildCropExpression({ points, cropWidthFraction, maxTerms = 400 }) {
  const w = Math.min(1, Math.max(0.05, cropWidthFraction));
  if (!points || !points.length) {
    return { expr: `(iw-ow)/2`, static: true, points: 0 };
  }

  // Collapse runs where the crop does not move; a static shot should not
  // produce hundreds of identical terms.
  const simplified = [];
  for (const p of points) {
    const last = simplified[simplified.length - 1];
    if (!last || Math.abs(last.center - p.center) > 0.004 || p.cut) simplified.push(p);
  }
  const use = simplified.length > maxTerms
    ? simplified.filter((_, i) => i % Math.ceil(simplified.length / maxTerms) === 0)
    : simplified;

  if (use.length === 1) {
    const x = clamp01(use[0].center - w / 2) ;
    return { expr: `iw*${round4(x)}`, static: true, points: 1 };
  }

  // Build from the end backwards so each term shadows the later ones.
  let expr = `iw*${round4(clamp01(use[use.length - 1].center - w / 2))}`;
  for (let i = use.length - 2; i >= 0; i--) {
    const t0 = use[i].time;
    const t1 = use[i + 1].time;
    const x0 = clamp01(use[i].center - w / 2);
    const x1 = clamp01(use[i + 1].center - w / 2);
    const span = Math.max(0.0001, t1 - t0);
    // Linear interpolation between the two sample positions.
    const lerp = `iw*(${round4(x0)}+(${round4(x1 - x0)})*(t-${round4(t0)})/${round4(span)})`;
    expr = `if(lt(t,${round4(t1)}),${lerp},${expr})`;
  }
  return { expr, static: false, points: use.length };
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

module.exports = {
  analyseSubject,
  runSemanticLayer,
  buildTrajectory,
  summariseTracking,
  primaryBackendFor,
  buildCropExpression,
  locateSubject,
  motionProfileFor,
  sampleGrid,
  TRACKER_BACKENDS,
  MOTION_PROFILES,
  GRID_W,
  GRID_H,
  SAMPLE_FPS
};
