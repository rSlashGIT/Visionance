'use strict';

/**
 * MUX stage.
 *
 * Joins the rendered chunks into the final part file. The chunks were produced
 * by the same command builder with identical codec parameters, so this is a
 * stream copy - no second generation of encoding loss.
 */

const fs = require('fs');
const path = require('path');
const { FfmpegRun, summariseFfmpegError } = require('../../ffmpeg/process');
const { buildConcatCommand } = require('../../ffmpeg/command');
const { VisionanceError, CODES } = require('../../errors');
const { partPathFor } = require('./encode');

/**
 * @param {object} ctx  see runEncode; additionally `plan` and `checkpoint`
 * @returns {Promise<{outputPath:string, metrics:object}>}
 */
async function runMux(ctx) {
  const { recipe, bins, workspace, jobId, plan, control, report, log } = ctx;

  const outputPath = recipe.output.path;
  const part = partPathFor(outputPath);
  const ext = (path.extname(outputPath) || '.mp4').slice(1).toLowerCase();

  const missing = [];
  const lines = [];
  for (const chunk of plan.chunks) {
    const file = workspace.chunkPath(jobId, chunk.index, ext);
    if (!fs.existsSync(file)) {
      missing.push(chunk.index);
      continue;
    }
    // The concat demuxer takes a literal path; single quotes are escaped by
    // doubling the quote character inside the quoted form.
    lines.push(`file '${file.replace(/'/g, "'\\''")}'`);
  }

  if (missing.length) {
    throw new VisionanceError(CODES.STAGE_FAILED, {
      message: 'Some rendered chunks are missing, so the final file cannot be assembled.',
      technicalDetails: `missing chunk indices: ${missing.join(',')}`,
      suggestedAction: 'Retry the job; the missing chunks will be re-rendered.'
    });
  }

  const listFile = workspace.concatListPath(jobId);
  fs.writeFileSync(listFile, lines.join('\n') + '\n', 'utf8');

  const { args } = buildConcatCommand({
    listFile,
    output: part,
    faststart: recipe.output.faststart,
    container: recipe.output.container
  });

  log.info('mux start', { job: jobId, chunks: plan.chunks.length });
  report(0.05, `Joining ${plan.chunks.length} chunks`);

  const run = new FfmpegRun(bins.ffmpeg, args, { durationSeconds: plan.totalDuration });
  control.activeRun = run;
  if (control.cancelled) run.cancel('cancelled');
  run.on('progress', (p) => report(Math.min(0.99, p.fraction || 0), null, { speed: p.speed }));

  let result;
  try {
    result = await run.run();
  } finally {
    control.activeRun = null;
  }

  if (result.cancelled || control.cancelled) throw new VisionanceError(CODES.CANCELLED);
  if (result.code !== 0) {
    workspace.appendLog(jobId, `concat failed (${result.code}): ${result.stderrTail}`);
    throw new VisionanceError(CODES.STAGE_FAILED, {
      message: 'The rendered chunks could not be joined.',
      technicalDetails: summariseFfmpegError(result.stderrTail, result.code, result.signal)
    });
  }

  report(1, 'Chunks joined');
  return { outputPath: part, metrics: { chunks: plan.chunks.length } };
}

module.exports = { runMux };
