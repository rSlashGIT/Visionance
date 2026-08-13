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
      return !!geometry &&
        (geometry.scaleWidth !== geometry.sourceWidth || geometry.scaleHeight !== geometry.sourceHeight);
    },
    mode: (r) => (r.reconstruction.mode === 'neural' ? 'pass' : 'fused')
  },

  INTERPOLATE: {
    id: 'INTERPOLATE',
    label: 'Motion',
    weight: 0,
    neuralWeight: 2,
    applies: (r, _a, geometry) => !!geometry && geometry.fpsChanged,
    mode: (r) => (r.motion.enabled && r.motion.interpolation === 'ai' ? 'pass' : 'fused')
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
  describePlan
};
