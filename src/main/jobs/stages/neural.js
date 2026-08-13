'use strict';

/**
 * The neural chunk pipeline.
 *
 * For each chunk, in order:
 *
 *   decode frames  ->  Real-ESRGAN  ->  RIFE (per shot)  ->  encode chunk
 *
 * and then, once, for the whole job: concatenate the chunks and mux the
 * original audio back in.
 *
 * Why this order
 * --------------
 * Upscaling before interpolating is the cheaper arrangement: Real-ESRGAN is by
 * far the more expensive network, and running it before RIFE means it processes
 * the *source* frame count rather than the interpolated one - for 24 -> 60 that
 * is 2.5x less super-resolution work. RIFE at high resolution is handled by its
 * UHD mode, which computes optical flow at reduced scale. It is also the order
 * the session-1 stage list already declares (UPSCALE before INTERPOLATE), so
 * the plan the user sees matches what runs.
 *
 * Memory
 * ------
 * Only one chunk's frames exist at a time and they are deleted as soon as the
 * chunk is encoded, so a 90-minute source costs the same disk as a 20-second
 * one. VRAM is handled by retrying with smaller tiles - see runUpscale.
 *
 * Audio
 * -----
 * Chunks are encoded video-only. The original audio is muxed once at the end,
 * straight from the source, so it is encoded exactly one time and cannot drift
 * chunk by chunk. RIFE adds frames; it does not change the timeline.
 */

const fs = require('fs');
const path = require('path');

const frames = require('../../ai/frames');
const scenes = require('../../ai/scenes');
const interpolation = require('../../ai/interpolation-plan');
const realesrgan = require('../../ai/engines/realesrgan');
const rife = require('../../ai/engines/rife');
const { interpretResult, preferredGpu } = require('../../ai/process');
const { buildPreNeuralFilters, buildPostNeuralFilters } = require('../../ffmpeg/filters');
const { FfmpegRun, summariseFfmpegError } = require('../../ffmpeg/process');
const chunking = require('../chunking');
const { partPathFor } = require('./encode');
const { VisionanceError, CODES } = require('../../errors');

/**
 * Tile sizes to fall back through when the GPU runs out of memory.
 * 0 means "let ncnn decide from the reported heap", which is right far more
 * often than a fixed guess; the rest are progressively safer.
 */
const TILE_LADDER = [0, 256, 128, 64];
const MAX_OOM_RETRIES = TILE_LADDER.length;

/* ------------------------------------------------------------------ *
 * Planning
 * ------------------------------------------------------------------ */

/**
 * Decide what the neural stages will do, before any work starts, so the job can
 * report it and refuse early if an engine is missing.
 *
 * @returns {Promise<{upscale:object|null, interpolate:object|null, notes:string[]}>}
 */
async function planNeural({ recipe, analysis, geometry, engines }) {
  const notes = [];
  let upscale = null;
  let interpolate = null;

  const wantsUpscale = recipe.reconstruction.enabled && recipe.reconstruction.mode === 'neural';
  const wantsInterpolate = recipe.motion.enabled && recipe.motion.interpolation === 'ai' && geometry.fpsChanged;

  if (wantsUpscale) {
    const status = await engines.require(realesrgan.ID);
    const inference = realesrgan.planInference({
      mode: recipe.reconstruction.aiMode === 'restore' ? 'restore' : 'upscale',
      scale: recipe.reconstruction.aiScale || 2,
      modelId: recipe.reconstruction.model || 'auto',
      quality: recipe.reconstruction.aiQuality || 'balanced',
      available: status.models
    });
    if (!inference) {
      throw new VisionanceError(CODES.MODEL_MISSING, {
        message: 'No Real-ESRGAN model is installed that can do this.',
        suggestedAction: 'Settings → AI engines → Reinstall Real-ESRGAN.'
      });
    }
    if (!inference.neural) {
      // Fast declined to run a 4x network to produce a 2x result. That is a
      // real quality decision, not a silent substitution: the job says which
      // path it took and why, and the classical scaler in the fused graph
      // handles the resize.
      notes.push(`Neural upscale skipped: ${inference.reason}.`);
      notes.push(inference.tradeoff);
    } else {
      upscale = {
        engineId: realesrgan.ID,
        status,
        model: inference.model,
        inferenceScale: inference.inferenceScale,
        preScale: inference.preScale || 1,
        downscaleAfter: inference.downscaleAfter,
        effectiveScale: inference.effectiveScale,
        quality: inference.quality,
        qualityLabel: inference.qualityLabel,
        gpuId: resolveGpu(recipe, status),
        reason: inference.reason,
        tradeoff: inference.tradeoff
      };
      notes.push(`Neural upscale: ${inference.model.name} (${inference.reason}).`);
      if (inference.tradeoff) notes.push(inference.tradeoff);
    }
  }

  if (wantsInterpolate) {
    const status = await engines.require(rife.ID);
    const model = rife.pickModel(status.models, recipe.motion.model || 'auto');
    if (!model) {
      throw new VisionanceError(CODES.MODEL_MISSING, {
        message: 'No RIFE model is installed.',
        suggestedAction: 'Settings → AI engines → Reinstall RIFE.'
      });
    }
    interpolate = {
      engineId: rife.ID,
      status,
      model,
      gpuId: resolveGpu(recipe, status),
      sceneCutProtection: recipe.motion.sceneCutProtection !== false,
      threshold: recipe.motion.sceneCutThreshold
    };
    notes.push(
      `Neural interpolation: ${model.label} to ${geometry.fps} fps` +
      (interpolate.sceneCutProtection ? ' with scene-cut protection.' : ' (scene-cut protection off).')
    );
  }

  return { upscale, interpolate, notes };
}

/** 'auto' means the fastest device we can identify, not simply device 0. */
function resolveGpu(recipe, status) {
  const requested = recipe.processing.gpu;
  if (requested !== undefined && requested !== null && requested !== 'auto') {
    return Number(requested);
  }
  return preferredGpu(status.availableGPUs);
}

/* ------------------------------------------------------------------ *
 * Engine invocations
 * ------------------------------------------------------------------ */

/**
 * Real-ESRGAN over a directory of frames, retrying with smaller tiles when the
 * GPU runs out of memory.
 *
 * Windows reports VRAM unreliably, so the size is not predicted from a number
 * we do not trust - the first attempt lets ncnn choose, and each failure halves
 * the tile. The tile that worked is reported back for the job metrics.
 */
async function runUpscale({ ctx, plan, inputDir, outputDir, expected, onProgress }) {
  const { engines, control, log, jobId } = ctx;
  const manualTile = ctx.recipe.processing.tileSize;
  const ladder = manualTile ? [Number(manualTile)] : TILE_LADDER;

  let lastError = null;
  for (let attempt = 0; attempt < Math.min(ladder.length, MAX_OOM_RETRIES); attempt++) {
    const tileSize = ladder[attempt];
    frames.ensureEmptyDir(outputDir);

    const args = realesrgan.buildArgs({
      inputDir,
      outputDir,
      model: plan.model.name,
      scale: plan.inferenceScale,
      tileSize,
      gpuId: plan.gpuId
    });

    const run = engines.createRun({
      engineId: plan.engineId,
      args,
      watchDir: outputDir,
      expected,
      control
    });
    control.activeAi = run;
    run.on('progress', onProgress);

    let result;
    try {
      result = await run.run();
    } finally {
      control.activeAi = null;
    }

    const verdict = interpretResult(result, { expected });
    if (verdict.ok) {
      if (attempt > 0) {
        log.info('upscale succeeded after tile reduction', { job: jobId, tileSize, attempt });
      }
      return { tileSize, produced: result.produced };
    }

    if (verdict.reason === 'cancelled') throw new VisionanceError(CODES.CANCELLED);
    if (verdict.reason === 'no-vulkan') {
      throw new VisionanceError(CODES.VULKAN_UNAVAILABLE, {
        technicalDetails: result.stderrTail.slice(-500)
      });
    }
    if (verdict.reason !== 'oom' && verdict.reason !== 'incomplete') {
      throw new VisionanceError(CODES.AI_PROCESS_FAILED, {
        message: 'Real-ESRGAN stopped unexpectedly.',
        technicalDetails: `exit=${result.code} ${result.stderrTail.slice(-500)}`
      });
    }

    lastError = result;
    log.warn('upscale ran out of memory; retrying with a smaller tile', {
      job: jobId,
      tileSize,
      next: ladder[attempt + 1],
      produced: result.produced,
      expected
    });
  }

  throw new VisionanceError(CODES.GPU_OOM, {
    message: 'The GPU ran out of memory even at the smallest tile size.',
    technicalDetails: lastError ? lastError.stderrTail.slice(-500) : 'no further detail',
    suggestedAction: 'Lower the output resolution, or set a smaller tile size under Advanced.'
  });
}

/**
 * RIFE over one shot. The shot's frames have already been isolated into their
 * own directory, which is what guarantees no pair spans a cut.
 */
async function runRifeSegment({ ctx, plan, inputDir, outputDir, requestFrames, uhd }) {
  const { engines, control } = ctx;
  frames.ensureEmptyDir(outputDir);

  const args = rife.buildArgs({
    inputDir,
    outputDir,
    modelDir: plan.model.path,
    frameCount: requestFrames,
    uhd,
    gpuId: plan.gpuId
  });

  const run = engines.createRun({
    engineId: plan.engineId,
    args,
    watchDir: outputDir,
    expected: requestFrames,
    control
  });
  control.activeAi = run;
  let result;
  try {
    result = await run.run();
  } finally {
    control.activeAi = null;
  }

  const verdict = interpretResult(result, { expected: requestFrames });
  if (verdict.ok) return result;

  if (verdict.reason === 'cancelled') throw new VisionanceError(CODES.CANCELLED);
  if (verdict.reason === 'no-vulkan') {
    throw new VisionanceError(CODES.VULKAN_UNAVAILABLE, {
      technicalDetails: result.stderrTail.slice(-500)
    });
  }
  if (verdict.reason === 'oom' && !uhd) {
    // UHD mode computes flow at reduced scale, which is the documented way to
    // fit large frames into limited VRAM.
    ctx.log.warn('RIFE ran out of memory; retrying in UHD mode', { job: ctx.jobId });
    return runRifeSegment({ ctx, plan, inputDir, outputDir, requestFrames, uhd: true });
  }
  throw new VisionanceError(verdict.reason === 'oom' ? CODES.GPU_OOM : CODES.AI_PROCESS_FAILED, {
    message: verdict.reason === 'oom'
      ? 'The GPU ran out of memory during frame interpolation.'
      : 'RIFE stopped unexpectedly.',
    technicalDetails: `exit=${result.code} produced=${result.produced}/${requestFrames} ${result.stderrTail.slice(-400)}`
  });
}

/* ------------------------------------------------------------------ *
 * Per-chunk work
 * ------------------------------------------------------------------ */

async function processChunk({ ctx, chunk, aiPlan, dirs, report }) {
  const { recipe, analysis, geometry, bins, control, log, jobId } = ctx;
  const fpsSrc = geometry.sourceFps || (analysis.video && analysis.video.nominalFps) || 30;
  const fpsDst = geometry.fps || fpsSrc;

  const frameCount = Math.max(1, Math.round((chunk.durationSeconds || 0) * fpsSrc));
  const isLastChunk = chunk.index === ctx.plan.chunks.length - 1;

  /* ---- 1. decode ---- */
  const pre = buildPreNeuralFilters(recipe, analysis, { availableFilters: ctx.availableFilters });
  const preFilters = [...pre.filters];

  // Balanced reaches a scale the model has no native weights for by running the
  // larger network on a smaller frame. The downscale belongs here, in the
  // decode pass, so the network never sees the full-size frame at all - that
  // is where the saving comes from.
  const preScale = (aiPlan.upscale && aiPlan.upscale.preScale) || 1;
  if (preScale > 0 && preScale < 1) {
    preFilters.push(`scale=iw*${preScale}:ih*${preScale}:flags=lanczos+accurate_rnd`);
  }
  // One extra frame gives the interpolator a real anchor across the chunk join
  // instead of a duplicate, which is what stops a freeze at the seam.
  const wantAnchor = !!aiPlan.interpolate && !isLastChunk;
  const decodeCount = frameCount + (wantAnchor ? 1 : 0);

  report('decode', 0, `Chunk ${chunk.index + 1}: decoding ${decodeCount} frames`);
  await frames.extractFrames({
    ffmpeg: bins.ffmpeg,
    input: ctx.inputs.video,
    headers: ctx.headers.video,
    startSeconds: chunk.startSeconds,
    frameCount: decodeCount,
    fps: fpsSrc,
    outDir: dirs.decoded,
    control,
    filters: preFilters.length ? preFilters.join(',') : null,
    onProgress: (p) => report('decode', p.fraction || 0)
  });

  const decoded = frames.countFrames(dirs.decoded);
  const usableFrames = Math.min(frameCount, wantAnchor ? decoded - 1 : decoded);
  if (usableFrames < 1) {
    throw new VisionanceError(CODES.STAGE_FAILED, {
      message: 'This chunk decoded no usable frames.',
      technicalDetails: `chunk=${chunk.index} decoded=${decoded}`
    });
  }

  /* ---- 2. neural upscale ---- */
  let workingDir = dirs.decoded;
  let frameSize = null;
  let tileUsed = null;

  if (aiPlan.upscale) {
    report('upscale', 0, `Chunk ${chunk.index + 1}: ${aiPlan.upscale.model.name} x${aiPlan.upscale.inferenceScale}`);
    const res = await runUpscale({
      ctx,
      plan: aiPlan.upscale,
      inputDir: dirs.decoded,
      outputDir: dirs.upscaled,
      expected: decoded,
      onProgress: (p) => report('upscale', p.fraction || 0, null, {
        producedFrames: p.produced,
        totalFrames: p.expected
      })
    });
    tileUsed = res.tileSize;
    workingDir = dirs.upscaled;
    const srcW = (geometry.sourceWidth || (analysis.video && analysis.video.width) || 0);
    const srcH = (geometry.sourceHeight || (analysis.video && analysis.video.height) || 0);
    // The network saw a pre-scaled frame where Balanced asked for one, so the
    // frames on disk are `preScale * inferenceScale` times the source.
    const net = preScale * aiPlan.upscale.inferenceScale;
    frameSize = { width: Math.round(srcW * net), height: Math.round(srcH * net) };
    // The decoded originals are dead weight once the network has consumed them.
    frames.ensureEmptyDir(dirs.decoded);
  }

  /* ---- 3. neural interpolation ---- */
  let finalDir = workingDir;
  let outputFrames = usableFrames;
  let cutCount = 0;

  if (aiPlan.interpolate) {
    let cuts = [];
    if (aiPlan.interpolate.sceneCutProtection) {
      report('interpolate', 0, `Chunk ${chunk.index + 1}: finding scene cuts`);
      const detected = await scenes.detectCuts({
        ffmpeg: bins.ffmpeg,
        input: ctx.inputs.video,
        headers: ctx.headers.video,
        startSeconds: chunk.startSeconds,
        durationSeconds: chunk.durationSeconds,
        threshold: aiPlan.interpolate.threshold,
        control
      });
      cuts = detected.cuts;
      cutCount = cuts.length;
    }

    const iplan = interpolation.planInterpolation({
      frameCount: usableFrames,
      fpsSrc,
      fpsDst,
      cutFrames: interpolation.cutsToFrameIndices(cuts, fpsSrc, usableFrames),
      hasNextFrame: wantAnchor && decoded > usableFrames,
      arbitraryTimestep: aiPlan.interpolate.model.arbitraryTimestep
    });
    for (const w of iplan.warnings) ctx.addWarning(w);

    log.info('interpolation plan', {
      job: jobId,
      chunk: chunk.index,
      shots: iplan.shots.length,
      cuts: cutCount,
      inFrames: usableFrames,
      outFrames: iplan.outputCount
    });

    finalDir = frames.ensureEmptyDir(dirs.interpolated);
    const uhd = rife.shouldUseUhd(
      frameSize ? frameSize.width : geometry.sourceWidth,
      frameSize ? frameSize.height : geometry.sourceHeight
    );

    let written = 0;
    for (const shot of iplan.shots) {
      if (control.cancelled) throw new VisionanceError(CODES.CANCELLED);
      if (shot.mode === 'skip' || shot.outputCount === 0) continue;

      if (shot.mode === 'copy') {
        written += frames.copyRange(
          workingDir, finalDir, shot.startFrame + 1, shot.outputCount, written + 1
        );
      } else if (shot.mode === 'hold') {
        // A one-frame shot has no motion to interpolate; holding it is the
        // truthful thing to do, and it is counted as such in the warnings.
        written += frames.repeatFrame(
          frames.framePath(workingDir, shot.startFrame + 1), finalDir, written + 1, shot.outputCount
        );
      } else {
        const shotIn = frames.ensureEmptyDir(dirs.shotIn);
        const shotOut = dirs.shotOut;
        // Isolate exactly this shot's frames - this is the mechanism that keeps
        // a cut out of RIFE's hands.
        let n = 1;
        for (let i = shot.startFrame; i <= shot.endFrame; i++) {
          fs.copyFileSync(frames.framePath(workingDir, i + 1), frames.framePath(shotIn, n++));
        }
        // Trailing anchor: the real next frame when the shot continues past the
        // chunk, otherwise a copy of its own last frame.
        const anchorSource = shot.anchor === 'next'
          ? frames.framePath(workingDir, shot.endFrame + 2)
          : frames.framePath(workingDir, shot.endFrame + 1);
        fs.copyFileSync(anchorSource, frames.framePath(shotIn, n++));

        await runRifeSegment({
          ctx,
          plan: aiPlan.interpolate,
          inputDir: shotIn,
          outputDir: shotOut,
          requestFrames: shot.requestFrames,
          uhd
        });

        // Drop the final output, which lands on the anchor and belongs to the
        // next shot (or the next chunk).
        const moved = frames.appendRenumbered(shotOut, finalDir, written + 1, {
          skipTrailing: shot.dropTrailing,
          limit: shot.outputCount
        });
        if (moved !== shot.outputCount) {
          throw new VisionanceError(CODES.STAGE_FAILED, {
            message: 'Frame interpolation produced the wrong number of frames.',
            technicalDetails: `shot=${shot.index} wanted=${shot.outputCount} got=${moved}`
          });
        }
        written += moved;
      }

      report('interpolate', written / Math.max(1, iplan.outputCount), null, {
        producedFrames: written,
        totalFrames: iplan.outputCount,
        sceneCuts: cutCount
      });
    }

    if (written !== iplan.outputCount) {
      throw new VisionanceError(CODES.STAGE_FAILED, {
        message: 'Frame interpolation did not produce a complete chunk.',
        technicalDetails: `wrote=${written} expected=${iplan.outputCount}`
      });
    }
    outputFrames = written;
    if (workingDir !== dirs.decoded) frames.ensureEmptyDir(workingDir);
  } else if (workingDir === dirs.decoded && wantAnchor) {
    // No interpolation: the anchor frame would be an extra frame in the output.
    const extra = frames.framePath(dirs.decoded, decoded);
    try { fs.rmSync(extra, { force: true }); } catch { /* ignore */ }
  }

  /* ---- 4. encode the chunk (video only) ---- */
  const post = buildPostNeuralFilters(recipe, geometry, frameSize, {
    availableFilters: ctx.availableFilters,
    reframe: ctx.reframe || null
  });
  const chunkFile = ctx.workspace.chunkPath(jobId, chunk.index, ctx.chunkExt);
  const chunkTmp = chunkFile + '.tmp';
  try { fs.rmSync(chunkTmp, { force: true }); } catch { /* fresh */ }

  report('encode', 0, `Chunk ${chunk.index + 1}: encoding ${outputFrames} frames`);
  await frames.encodeFrames({
    ffmpeg: bins.ffmpeg,
    framesDir: finalDir,
    fps: fpsDst,
    output: chunkTmp,
    encoderId: ctx.encoderId,
    recipe,
    control,
    filters: post.filters.length ? post.filters.join(',') : null,
    onProgress: (p) => report('encode', p.fraction || 0)
  });
  fs.renameSync(chunkTmp, chunkFile);

  /* ---- 5. clean up this chunk's frames ---- */
  for (const dir of Object.values(dirs)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  return { outputFrames, tileUsed, cutCount, notes: [...pre.notes, ...post.notes] };
}

/* ------------------------------------------------------------------ *
 * Whole-job orchestration
 * ------------------------------------------------------------------ */

/**
 * @param {object} ctx  as built by the job manager, plus:
 *   engines     EngineManager
 *   aiPlan      result of planNeural()
 *   reportStage (stageId, fraction, message, metrics) => void
 *   addWarning  (message) => void
 * @returns {Promise<{outputPath:string|null, paused:boolean, metrics:object}>}
 */
async function runNeuralPipeline(ctx) {
  const { recipe, plan, control, workspace, jobId, log, aiPlan, reportStage } = ctx;
  let checkpoint = ctx.checkpoint;

  workspace.create(jobId);
  ctx.chunkExt = (path.extname(recipe.output.path) || '.mp4').slice(1).toLowerCase();
  checkpoint = chunking.reconcile(checkpoint, plan, workspace.existingChunks(jobId, ctx.chunkExt));
  ctx.onCheckpoint(checkpoint);

  const totalChunks = plan.chunks.length;
  const metrics = { tileSize: null, sceneCuts: 0, framesProcessed: 0, chunksDone: checkpoint.completedChunks.length };
  const startedAt = Date.now();

  // How many frames the network will process over the whole job. The rate is
  // only useful against a total, and the total is knowable before we start.
  const srcFps = (ctx.geometry && ctx.geometry.sourceFps) || 30;
  ctx.totalNeuralFrames = Math.max(1, Math.round((plan.totalDuration || 0) * srcFps));

  for (const chunk of plan.chunks) {
    if (checkpoint.completedChunks.includes(chunk.index)) continue;
    if (control.cancelled) throw new VisionanceError(CODES.CANCELLED);
    if (control.pauseRequested) {
      log.info('neural pipeline paused at chunk boundary', { job: jobId, nextChunk: chunk.index });
      return { outputPath: null, paused: true, metrics };
    }

    const base = workspace.tmpPath(jobId, `chunk-${chunk.index}`);
    const dirs = {
      decoded: path.join(base, 'decoded'),
      upscaled: path.join(base, 'upscaled'),
      interpolated: path.join(base, 'interpolated'),
      shotIn: path.join(base, 'shot-in'),
      shotOut: path.join(base, 'shot-out')
    };
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

    const chunkFraction = (phase, f) => {
      // Rough but honest weighting of the phases inside one chunk.
      const weights = { decode: 0.1, upscale: aiPlan.upscale ? 0.6 : 0, interpolate: aiPlan.interpolate ? 0.2 : 0, encode: 0.1 };
      const order = ['decode', 'upscale', 'interpolate', 'encode'];
      const total = order.reduce((s, k) => s + weights[k], 0) || 1;
      let done = 0;
      for (const k of order) {
        if (k === phase) break;
        done += weights[k];
      }
      return (done + weights[phase] * Math.min(1, Math.max(0, f))) / total;
    };

    const report = (phase, fraction, message, extra) => {
      const within = chunkFraction(phase, fraction);
      const overall = (checkpoint.completedChunks.length + within) / totalChunks;
      const stageId = phase === 'upscale' ? 'UPSCALE' : phase === 'interpolate' ? 'INTERPOLATE' : 'ENCODE';
      // Frames the network has genuinely finished, job-wide, so the queue can
      // compute a rate from work rather than from a progress bar. Counted
      // across chunks *and* within the chunk in flight, because a short clip is
      // one chunk and would otherwise never produce an estimate at all.
      const inFlight = (extra && Number(extra.producedFrames)) || 0;
      reportStage(stageId, overall, message, {
        chunk: chunk.index + 1,
        totalChunks,
        phase,
        tileSize: metrics.tileSize,
        gpu: describeGpu(aiPlan),
        model: describeModel(aiPlan),
        neuralFramesDone: metrics.framesProcessed + inFlight,
        neuralFramesTotal: ctx.totalNeuralFrames || null,
        neuralStartedAt: startedAt,
        ...extra
      });
    };

    const result = await processChunk({ ctx, chunk, aiPlan, dirs, report });

    metrics.tileSize = result.tileUsed ?? metrics.tileSize;
    metrics.sceneCuts += result.cutCount;
    metrics.framesProcessed += result.outputFrames;
    checkpoint = chunking.markChunkComplete(checkpoint, plan, chunk.index);
    metrics.chunksDone = checkpoint.completedChunks.length;
    ctx.checkpoint = checkpoint;
    ctx.onCheckpoint(checkpoint);

    const elapsed = (Date.now() - startedAt) / 1000;
    if (elapsed > 0) metrics.framesPerSecond = Math.round((metrics.framesProcessed / elapsed) * 100) / 100;
    log.info('chunk complete', {
      job: jobId,
      chunk: chunk.index,
      of: totalChunks,
      frames: result.outputFrames,
      tile: result.tileUsed,
      cuts: result.cutCount,
      fps: metrics.framesPerSecond
    });
  }

  return { outputPath: null, paused: false, metrics, checkpoint };
}

function describeGpu(aiPlan) {
  const plan = aiPlan.upscale || aiPlan.interpolate;
  if (!plan) return null;
  const gpu = (plan.status.availableGPUs || []).find((g) => g.index === plan.gpuId);
  return gpu ? `${gpu.index}: ${gpu.name}` : (plan.gpuId == null ? 'auto' : String(plan.gpuId));
}

function describeModel(aiPlan) {
  const bits = [];
  if (aiPlan.upscale) bits.push(aiPlan.upscale.model.name);
  if (aiPlan.interpolate) bits.push(aiPlan.interpolate.model.label);
  return bits.join(' + ') || null;
}

/**
 * Join the video-only chunks and mux the original audio back in.
 *
 * One pass, video stream-copied, audio encoded exactly once from the source.
 * Doing it this way is what keeps sync exact regardless of how many chunks the
 * render was split into.
 */
async function finaliseNeural(ctx) {
  const { recipe, plan, bins, workspace, jobId, control, analysis, reportStage } = ctx;
  const output = recipe.output.path;
  const part = partPathFor(output);
  const ext = ctx.chunkExt || (path.extname(output) || '.mp4').slice(1).toLowerCase();

  const missing = [];
  const lines = [];
  for (const chunk of plan.chunks) {
    const file = workspace.chunkPath(jobId, chunk.index, ext);
    if (!fs.existsSync(file)) missing.push(chunk.index);
    else lines.push(`file '${file.replace(/'/g, "'\\''")}'`);
  }
  if (missing.length) {
    throw new VisionanceError(CODES.STAGE_FAILED, {
      message: 'Some processed chunks are missing, so the final file cannot be assembled.',
      technicalDetails: `missing chunks: ${missing.join(',')}`,
      suggestedAction: 'Retry the job; the missing chunks will be re-rendered.'
    });
  }

  const listFile = workspace.concatListPath(jobId);
  fs.writeFileSync(listFile, lines.join('\n') + '\n', 'utf8');

  const wantAudio = recipe.audio.enabled && recipe.audio.mode !== 'none' && !!(analysis && analysis.audio);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'concat', '-safe', '0', '-i', listFile
  ];

  if (wantAudio) {
    // Audio comes from the untouched source, trimmed to the same span as the
    // render, and is encoded once here rather than per chunk.
    if (recipe.trim.startSeconds) args.push('-ss', String(recipe.trim.startSeconds));
    args.push('-i', ctx.inputs.video);
    if (plan.totalDuration) args.push('-t', String(plan.totalDuration));
  }

  args.push('-map', '0:v:0');
  if (wantAudio) {
    args.push('-map', '1:a:0?');
    args.push('-c:a', recipe.audio.codec === 'opus' ? 'libopus' : recipe.audio.codec);
    if (recipe.audio.codec !== 'flac') args.push('-b:a', `${recipe.audio.bitrateKbps}k`);
    if (recipe.audio.channels) args.push('-ac', String(recipe.audio.channels));
    if (recipe.audio.sampleRate) args.push('-ar', String(recipe.audio.sampleRate));
  } else {
    args.push('-an');
  }

  args.push('-c:v', 'copy');
  if (recipe.output.faststart && /^(mp4|mov)$/.test(ext)) args.push('-movflags', '+faststart');
  args.push('-max_muxing_queue_size', '1024');
  args.push('-f', frames.containerFormatFor(output));
  args.push('-progress', 'pipe:1', '-nostats');
  args.push(part);

  reportStage('MUX', 0.05, `Joining ${plan.chunks.length} chunk(s)${wantAudio ? ' and audio' : ''}`);

  const run = new FfmpegRun(bins.ffmpeg, args, { durationSeconds: plan.totalDuration });
  control.activeRun = run;
  if (control.cancelled) run.cancel('cancelled');
  run.on('progress', (p) => reportStage('MUX', Math.min(0.99, p.fraction || 0)));

  let result;
  try {
    result = await run.run();
  } finally {
    control.activeRun = null;
  }

  if (result.cancelled || control.cancelled) throw new VisionanceError(CODES.CANCELLED);
  if (result.code !== 0) {
    throw new VisionanceError(CODES.STAGE_FAILED, {
      message: 'The processed chunks could not be joined.',
      technicalDetails: summariseFfmpegError(result.stderrTail, result.code, result.signal)
    });
  }

  reportStage('MUX', 1, 'Joined');
  return { outputPath: part };
}

/**
 * Working space this job will need at its peak, so it can be refused before it
 * fills the disk rather than half way through.
 */
function estimateWorkingBytes({ recipe, geometry, plan, aiPlan }) {
  if (!aiPlan.upscale && !aiPlan.interpolate) return 0;
  const chunk = plan.chunks[0] || { durationSeconds: plan.totalDuration || 0 };
  const fpsSrc = geometry.sourceFps || 30;
  const fpsDst = geometry.fps || fpsSrc;
  const srcFrames = Math.ceil((chunk.durationSeconds || 0) * fpsSrc) + 1;
  const outFrames = Math.ceil((chunk.durationSeconds || 0) * fpsDst) + 1;

  // Frames land at `preScale * inferenceScale` times the source, not at the
  // inference scale: Balanced feeds the network a half-size frame, so its
  // output is half the size the raw scale would suggest.
  const pre = (aiPlan.upscale && aiPlan.upscale.preScale) || 1;
  const scale = aiPlan.upscale ? aiPlan.upscale.inferenceScale * pre : 1;
  const w = Math.round((geometry.sourceWidth || 1920) * scale);
  const h = Math.round((geometry.sourceHeight || 1080) * scale);

  // The decoded frames are pre-scaled too, where a pre-scale applies.
  const decoded = frames.estimateChunkBytes({
    width: Math.round((geometry.sourceWidth || 1920) * pre),
    height: Math.round((geometry.sourceHeight || 1080) * pre),
    frames: srcFrames, stages: 1
  });
  const upscaled = aiPlan.upscale
    ? frames.estimateChunkBytes({ width: w, height: h, frames: srcFrames, stages: 1 })
    : 0;
  const interpolated = aiPlan.interpolate
    ? frames.estimateChunkBytes({ width: w, height: h, frames: outFrames, stages: 1 })
    : 0;

  // Chunks accumulate on disk until the final mux.
  const chunkBytes = Math.ceil(((recipe.output.bitrateKbps || 20000) * 1000 / 8) * (plan.totalDuration || 0));
  return decoded + upscaled + interpolated + chunkBytes;
}

module.exports = {
  planNeural,
  runNeuralPipeline,
  finaliseNeural,
  estimateWorkingBytes,
  resolveGpu,
  TILE_LADDER
};
