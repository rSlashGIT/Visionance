'use strict';

/**
 * Processing stages.
 *
 * The pipeline is a fixed, ordered list of stage identities. A recipe decides
 * which of them apply, and each stage decides *how* it contributes:
 *
 *   fused   - it is expressible as ffmpeg filters, so it is folded into the
 *             encode pass. One decode, one encode, no intermediate files.
 *   pass    - it needs its own run over the media (a neural upscaler, a frame
 *             interpolator, a separate audio render). It produces an
 *             intermediate the next segment consumes.
 *   skipped - the recipe does not ask for it.
 *
 * In this build every enhancement stage is `fused`; the only `pass` stages are
 * ANALYSE, ENCODE, MUX and VERIFY. That is not a shortcut - fusing is the right
 * answer for filter-expressible work. The point of the abstraction is that when
 * session 2 registers UPSCALE as a `pass` stage, the planner splits the graph
 * automatically and the orchestrator does not need to learn anything about
 * Real-ESRGAN.
 *
 * The orchestration layer knows: order, applicability, weight, progress and
 * failure. It knows nothing about any stage's internals.
 */

const STAGE_IDS = [
  'ANALYSE',
  'RESTORE',
  'UPSCALE',
  'INTERPOLATE',
  'REFRAME',
  'GRADE',
  'AUDIO',
  'ENCODE',
  'MUX',
  'VERIFY'
];

/**
 * Stage definitions.
 *
 * `applies`  - does the recipe ask for this at all?
 * `mode`     - how it contributes, given the recipe and the current build
 * `weight`   - relative share of the job's progress bar
 * `execute`  - only for pass stages; supplied by ./stages/*
 */
const DEFINITIONS = {
  ANALYSE: {
    id: 'ANALYSE',
    label: 'Analyse',
    weight: 0.02,
    applies: () => true,
    mode: () => 'pass'
  },

  RESTORE: {
    id: 'RESTORE',
    label: 'Restore',
    weight: 0,
    applies: (r) => r.restore.enabled &&
      (r.restore.denoise > 0.02 || r.restore.deblock > 0.02 ||
       r.restore.deband > 0.02 || r.restore.grain > 0.02 ||
       r.restore.deinterlace === 'on'),
    mode: () => 'fused'
  },

  UPSCALE: {
    id: 'UPSCALE',
    label: 'Reconstruct',
    // Real-ESRGAN dominates the cost of any job it is part of.
    weight: 0,
    neuralWeight: 6,
    applies: (r, _a, geometry) => {
      if (!r.reconstruction.enabled) return false;
      // A neural pass is worthwhile even when the output size is unchanged:
      // "restore" repairs at the same resolution.
      if (r.reconstruction.mode === 'neural') return true;
      if (!geometry) return false;
      // The *requested* size, not the pre-framing scale. When a framing canvas
      // is active the resample happens inside the framing filter, so
      // `scaleWidth` equals the source - but the user did ask for a different
      // resolution and the plan should still say Reconstruct.
      const w = geometry.requestedWidth != null ? geometry.requestedWidth : geometry.scaleWidth;
      const h = geometry.requestedHeight != null ? geometry.requestedHeight : geometry.scaleHeight;
      return w !== geometry.sourceWidth || h !== geometry.sourceHeight;
    },
    // `ctx.neuralUpscale` is the *resolved* answer from the engine planner, not
    // the recipe's request. Fast can decline a neural upscale it judges not
    // worth the inference, and when it does this stage really is a fused
    // classical resize - claiming a neural pass would put a six-weight bar on
    // work that never runs.
    mode: (r, _a, _g, ctx = {}) => {
      if (r.reconstruction.mode !== 'neural') return 'fused';
      return ctx.neuralUpscale === false ? 'fused' : 'pass';
    }
  },

  INTERPOLATE: {
    id: 'INTERPOLATE',
    label: 'Motion',
    weight: 0,
    neuralWeight: 2,
    applies: (r, _a, geometry) => !!geometry && geometry.fpsChanged,
    mode: (r, _a, _g, ctx = {}) => {
      if (!(r.motion.enabled && r.motion.interpolation === 'ai')) return 'fused';
      return ctx.neuralInterpolate === false ? 'fused' : 'pass';
    }
  },

  REFRAME: {
    id: 'REFRAME',
    label: 'Reframe',
    weight: 0,
    applies: (r, _a, geometry) => r.framing.enabled && !!geometry &&
      (!!geometry.canvasWidth || !!r.framing.crop),
    mode: (r) => (r.framing.tracking === 'auto' ? 'pass' : 'fused')
  },

  GRADE: {
    id: 'GRADE',
    label: 'Grade',
    weight: 0,
    applies: (r, a) => r.color.enabled ||
      (r.color.toneMap !== 'none' && !!(a && a.derived && a.derived.isHDR)),
    mode: () => 'fused'
  },

  AUDIO: {
    id: 'AUDIO',
    label: 'Audio',
    weight: 0,
    applies: (r) => r.audio.enabled && r.audio.mode !== 'none',
    mode: () => 'fused'
  },

  ENCODE: {
    id: 'ENCODE',
    label: 'Encode',
    weight: 1,
    applies: () => true,
    mode: () => 'pass'
  },

  MUX: {
    id: 'MUX',
    label: 'Mux',
    weight: 0.05,
    // Neural chunks are encoded video-only so the audio can be muxed exactly
    // once at the end - which means a neural job needs this step even when
    // there is only one chunk to "join".
    applies: (_r, _a, _g, ctx) => !!(ctx && (ctx.chunked || ctx.neural)),
    mode: () => 'pass'
  },

  VERIFY: {
    id: 'VERIFY',
    label: 'Verify',
    weight: 0.03,
    applies: (r) => r.processing.verify !== false,
    mode: () => 'pass'
  }
};

/**
 * Work out which stages run and how.
 *
 * @param {object} recipe
 * @param {object} analysis
 * @param {object} geometry
 * @param {object} [ctx] { chunked: boolean }
 * @returns {{stages: object[], requiresChunking: boolean, fused: string[], passes: string[]}}
 */
function planStages(recipe, analysis, geometry, ctx = {}) {
  const stages = [];
  let requiresChunking = false;

  for (const id of STAGE_IDS) {
    const def = DEFINITIONS[id];
    const applies = !!def.applies(recipe, analysis, geometry, ctx);
    const mode = applies ? def.mode(recipe, analysis, geometry, ctx) : 'skipped';
    if (mode === 'pass' && !['ANALYSE', 'ENCODE', 'MUX', 'VERIFY'].includes(id)) {
      // A discrete processing pass cannot stream a two-hour file in one go.
      requiresChunking = true;
    }
    stages.push({
      id,
      label: def.label,
      // A neural stage carries real weight in the progress bar; the same stage
      // done as an ffmpeg filter is essentially free and carries none.
      weight: mode === 'pass' && def.neuralWeight ? def.neuralWeight : def.weight,
      mode,
      status: mode === 'skipped' ? 'skipped' : 'pending',
      progress: 0,
      message: null,
      metrics: null,
      startedAt: null,
      finishedAt: null
    });
  }

  return {
    stages,
    requiresChunking,
    fused: stages.filter((s) => s.mode === 'fused').map((s) => s.id),
    passes: stages.filter((s) => s.mode === 'pass').map((s) => s.id)
  };
}

/* ------------------------------------------------------------------ *
 * Cost, from the plan that will actually run
 * ------------------------------------------------------------------ */

const COST_CLASSES = ['fast', 'moderate', 'heavy', 'very-heavy'];
const COST_LABELS = {
  fast: 'Fast',
  moderate: 'Moderate',
  heavy: 'Heavy',
  'very-heavy': 'Very heavy'
};

/**
 * Measured neural throughput on the reference machine (GTX 1650 Ti), as
 * seconds of inference per megapixel of *network input*, which is what these
 * models are actually bound by:
 *
 *   x4plus       720p (0.92 Mpx) -> 12.66 s/frame  = 13.7 s/Mpx
 *                480p (0.41 Mpx) ->  6.07 s/frame  = 14.8 s/Mpx
 *   animevideov3 720p            ->  0.64 s/frame  = 0.69 s/Mpx
 *                480p            ->  0.41 s/frame  = 1.0 s/Mpx
 *
 * These are a *classifier's* constants, not a promise. They put a job in the
 * right bucket on the hardware Visionance targets; the real ETA comes later
 * from frames that have actually been processed.
 */
const SECONDS_PER_INPUT_MPX = {
  'realesrgan-x4plus': 14,
  'realesrnet-x4plus': 14,
  'realesrgan-x4plus-anime': 6,
  'realesr-animevideov3': 0.9,
  default: 12
};

/**
 * Classify a job from its **resolved** plan.
 *
 * The old estimate ran on the Auto recipe before stage resolution, so it could
 * not see which model had been chosen, whether the network would run on
 * full-size or pre-scaled frames, or whether the neural pass had been declined
 * altogether. A job executing x4 inference could therefore be labelled `fast`,
 * which is the single most misleading thing the queue could say.
 *
 * @param {object} o
 *   stages     resolved stages from planStages()
 *   geometry   resolved output geometry
 *   aiPlan     resolved neural plan ({upscale, interpolate}) or null
 *   durationSeconds
 * @returns {{class:string, label:string, seconds:number|null, basis:string,
 *            reasons:string[]}}
 */
function estimatePlanCost({ stages = [], geometry = {}, aiPlan = null, durationSeconds = 0 }) {
  const reasons = [];
  const srcW = geometry.sourceWidth || geometry.width || 1920;
  const srcH = geometry.sourceHeight || geometry.height || 1080;
  const srcFps = geometry.sourceFps || 30;
  const outFps = geometry.fps || srcFps;
  const frames = Math.max(1, Math.round((durationSeconds || 0) * srcFps));

  let seconds = 0;

  const upscale = aiPlan && aiPlan.upscale;
  if (upscale) {
    // Cost follows the pixels the network is *fed*, which is exactly what the
    // pre-scale changes.
    const pre = upscale.preScale || 1;
    const inputMpx = (srcW * pre) * (srcH * pre) / 1e6;
    const rate = SECONDS_PER_INPUT_MPX[upscale.model && upscale.model.name] || SECONDS_PER_INPUT_MPX.default;
    const cost = frames * inputMpx * rate;
    seconds += cost;
    reasons.push(
      `${upscale.model.name} at x${upscale.inferenceScale} on ` +
      `${Math.round(srcW * pre)}×${Math.round(srcH * pre)} frames ≈ ` +
      `${formatDuration(cost)} of inference`
    );
  }

  const interpolate = aiPlan && aiPlan.interpolate;
  if (interpolate) {
    // RIFE works on the frames the upscaler produced, at the output rate.
    const net = upscale ? (upscale.preScale || 1) * upscale.inferenceScale : 1;
    const mpx = (srcW * net) * (srcH * net) / 1e6;
    const outFrames = Math.max(1, Math.round((durationSeconds || 0) * outFps));
    const cost = outFrames * mpx * 0.35;
    seconds += cost;
    reasons.push(`RIFE generating ${outFrames} frames ≈ ${formatDuration(cost)}`);
  }

  const reframe = stages.find((s) => s.id === 'REFRAME' && s.mode === 'pass');
  if (reframe) {
    // One low-resolution analysis pass. Cheap, but not free on a long source.
    const cost = (durationSeconds || 0) * 0.04;
    seconds += cost;
    reasons.push('Smart Reframe analysis pass');
  }

  // The encode itself, on a hardware encoder, runs at a few times realtime.
  const outMpx = (geometry.width || 1920) * (geometry.height || 1080) / 1e6;
  const encode = (durationSeconds || 0) * Math.max(0.08, outMpx * 0.12);
  seconds += encode;

  let cls = seconds < 60 ? 'fast'
    : seconds < 600 ? 'moderate'
      : seconds < 3600 ? 'heavy'
        : 'very-heavy';

  // A job that runs a network is never `fast`, however short the clip.
  // Measured end to end, the *cheapest* neural path on the reference GPU
  // manages 0.55 frames per second - a one-second clip takes the better part
  // of a minute, and every longer one scales from there. `fast` next to a
  // running Real-ESRGAN pass is the label that made the queue untrustworthy.
  if ((upscale || interpolate) && cls === 'fast') cls = 'moderate';

  return {
    class: cls,
    label: COST_LABELS[cls],
    // A rough figure, offered as a magnitude and never as a countdown.
    seconds: Math.round(seconds),
    basis: aiPlan && (aiPlan.upscale || aiPlan.interpolate) ? 'measured-neural-rate' : 'encode-only',
    reasons
  };
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

/** Total weight of the stages that will actually run. */
function totalWeight(stages) {
  return stages
    .filter((s) => s.mode === 'pass')
    .reduce((sum, s) => sum + (s.weight || 0), 0) || 1;
}

/**
 * Overall job progress from per-stage progress.
 * Only pass stages carry weight; fused stages are shown as tracking the encode
 * they are part of, which is what is actually happening.
 */
function aggregateProgress(stages) {
  const total = totalWeight(stages);
  let done = 0;
  for (const s of stages) {
    if (s.mode !== 'pass') continue;
    const w = s.weight || 0;
    if (s.status === 'completed') done += w;
    else if (s.status === 'running') done += w * Math.min(1, Math.max(0, s.progress || 0));
  }
  return Math.min(1, done / total);
}

/** Human sentence describing what a plan will do, for the UI and the log. */
function describePlan(stages) {
  const active = stages.filter((s) => s.mode !== 'skipped');
  return active.map((s) => `${s.label}${s.mode === 'fused' ? ' (in encode)' : ''}`).join(' → ');
}

module.exports = {
  STAGE_IDS,
  DEFINITIONS,
  planStages,
  aggregateProgress,
  totalWeight,
  describePlan,
  estimatePlanCost,
  COST_CLASSES,
  COST_LABELS,
  SECONDS_PER_INPUT_MPX
};
