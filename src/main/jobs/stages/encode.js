'use strict';

/**
 * ENCODE stage.
 *
 * Runs ffmpeg over the source - once for the whole span, or once per chunk when
 * the plan is chunked. Chunk completion is checkpointed, so an interrupted job
 * restarts from the first chunk that is missing rather than from zero.
 *
 * The final destination is never written directly. Everything lands on a
 * sibling `.vspart` file that is only renamed into place after verification, so
 * a failed or cancelled render can never leave something that looks finished.
 */

const fs = require('fs');
const path = require('path');
const { FfmpegRun, summariseFfmpegError } = require('../../ffmpeg/process');
const { buildEncodeCommand } = require('../../ffmpeg/command');
const { VisionanceError, CODES, redactArgs } = require('../../errors');
const chunking = require('../chunking');

const PART_SUFFIX = '.vspart';

function partPathFor(outputPath) {
  return outputPath + PART_SUFFIX;
}

/**
 * @param {object} ctx
 *   recipe, analysis, geometry, encoderId, availableFilters
 *   inputs   {{video:string, audio:string|null}}
 *   headers  {{video:object|null, audio:object|null}}
 *   bins     {{ffmpeg:string}}
 *   workspace, jobId
 *   plan     chunk plan
 *   checkpoint
 *   control  {{cancelled:boolean, pauseRequested:boolean, activeRun:FfmpegRun|null}}
 *   report   (fraction, message, metrics) => void
 *   onCheckpoint (checkpoint) => void
 *   log
 * @returns {Promise<{outputPath:string, chunked:boolean, paused:boolean, metrics:object}>}
 */
async function runEncode(ctx) {
  const {
    recipe, analysis, geometry, encoderId, availableFilters,
    inputs, headers, bins, workspace, jobId, plan, control, report, onCheckpoint, log
  } = ctx;

  if (!bins.ffmpeg) throw new VisionanceError(CODES.FFMPEG_MISSING);

  const outputPath = recipe.output.path;
  const part = partPathFor(outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const ext = (path.extname(outputPath) || '.mp4').slice(1).toLowerCase();
  const sourceHasAudio = !!(analysis && analysis.audio);
  const totalDuration = plan.totalDuration || 0;

  let checkpoint = ctx.checkpoint;

  /* ---------------- single pass ---------------- */

  if (!plan.enabled) {
    // Let the recipe's own trim drive a single pass: re-deriving `-t` from a
    // probed duration could shave the final frames off an untrimmed render.
    const chunk = plan.chunks[0];
    const { args, notes, graph } = buildEncodeCommand({
      recipe,
      geometry,
      analysis,
      availableFilters,
      input: inputs.video,
      inputHeaders: headers.video,
      audioInput: inputs.audio,
      audioHeaders: headers.audio,
      output: part,
      encoderId,
      sourceHasAudio,
      segment: null,
      reframe: ctx.reframe || null
    });

    log.info('encode start', {
      job: jobId,
      encoder: encoderId,
      chunked: false,
      duration: totalDuration,
      graph: graph.length > 400 ? graph.slice(0, 400) + '…' : graph
    });
    workspace.appendLog(jobId, `ffmpeg ${redactArgs(args).join(' ')}`);

    const metrics = await runOne({
      bin: bins.ffmpeg,
      args,
      durationSeconds: chunk.durationSeconds || totalDuration,
      control,
      workspace,
      jobId,
      onProgress: (p) => {
        report(p.fraction, null, {
          fps: p.fps, speed: p.speed, processedSeconds: p.outTimeSeconds, bitrateKbps: p.bitrateKbps
        });
      }
    });

    return { outputPath: part, chunked: false, paused: false, notes, metrics };
  }

  /* ---------------- chunked ---------------- */

  workspace.create(jobId);
  checkpoint = chunking.reconcile(checkpoint, plan, workspace.existingChunks(jobId, ext));
  onCheckpoint(checkpoint);

  const aggregate = { fps: 0, speed: 0, processedSeconds: checkpoint.completedDuration || 0 };

  for (const chunk of plan.chunks) {
    if (checkpoint.completedChunks.includes(chunk.index)) continue;

    if (control.cancelled) throw new VisionanceError(CODES.CANCELLED);
    if (control.pauseRequested) {
      log.info('encode paused at chunk boundary', { job: jobId, nextChunk: chunk.index });
      return { outputPath: null, chunked: true, paused: true, metrics: aggregate };
    }

    const chunkFile = workspace.chunkPath(jobId, chunk.index, ext);
    const chunkTmp = chunkFile + '.tmp';
    try { fs.rmSync(chunkTmp, { force: true }); } catch { /* fresh start */ }

    const { args } = buildEncodeCommand({
      recipe,
      geometry,
      analysis,
      availableFilters,
      input: inputs.video,
      inputHeaders: headers.video,
      audioInput: inputs.audio,
      audioHeaders: headers.audio,
      output: chunkTmp,
      encoderId,
      sourceHasAudio,
      segment: chunk,
      forConcat: true,
      reframe: ctx.reframe || null
    });

    log.info('encode chunk', {
      job: jobId,
      chunk: chunk.index,
      of: plan.chunks.length,
      start: chunk.startSeconds,
      seconds: chunk.durationSeconds
    });
    workspace.appendLog(jobId, `chunk ${chunk.index}: ffmpeg ${redactArgs(args).join(' ')}`);

    const base = checkpoint.completedDuration || 0;
    const m = await runOne({
      bin: bins.ffmpeg,
      args,
      durationSeconds: chunk.durationSeconds,
      control,
      workspace,
      jobId,
      onProgress: (p) => {
        const processed = base + (p.outTimeSeconds || 0);
        aggregate.fps = p.fps;
        aggregate.speed = p.speed;
        aggregate.processedSeconds = processed;
        report(
          totalDuration ? Math.min(0.999, processed / totalDuration) : 0,
          `Chunk ${chunk.index + 1} of ${plan.chunks.length}`,
          { fps: p.fps, speed: p.speed, processedSeconds: processed, chunk: chunk.index }
        );
      }
    });

    fs.renameSync(chunkTmp, chunkFile);
    checkpoint = chunking.markChunkComplete(checkpoint, plan, chunk.index);
    onCheckpoint(checkpoint);
    aggregate.processedSeconds = checkpoint.completedDuration;
    aggregate.lastChunkMetrics = m;
  }

  return { outputPath: null, chunked: true, paused: false, metrics: aggregate, checkpoint };
}

/** One ffmpeg invocation, with cancellation wired to the shared control flag. */
async function runOne({ bin, args, durationSeconds, control, onProgress, workspace, jobId }) {
  const run = new FfmpegRun(bin, args, { durationSeconds });
  control.activeRun = run;
  if (control.cancelled) run.cancel('cancelled');
  run.on('progress', onProgress);

  let result;
  try {
    result = await run.run();
  } finally {
    control.activeRun = null;
  }

  if (result.cancelled || control.cancelled) {
    throw new VisionanceError(CODES.CANCELLED);
  }
  if (result.code !== 0) {
    workspace.appendLog(jobId, `ffmpeg failed (${result.code}): ${result.stderrTail}`);
    throw new VisionanceError(CODES.ENCODE_FAILED, {
      message: 'ffmpeg could not finish this render.',
      technicalDetails: summariseFfmpegError(result.stderrTail, result.code, result.signal)
    });
  }
  return {
    fps: run.lastProgress ? run.lastProgress.fps : 0,
    speed: run.lastProgress ? run.lastProgress.speed : 0,
    frames: run.lastProgress ? run.lastProgress.frame : 0
  };
}

module.exports = { runEncode, partPathFor, PART_SUFFIX };
