'use strict';

/**
 * Frames in, frames out.
 *
 * The neural engines work on directories of PNGs, so every chunk has to be
 * decoded to disk and re-encoded afterwards. Two rules keep that from becoming
 * the "extract the whole movie into a million PNGs" antipattern this pipeline
 * exists to avoid:
 *
 *   - only ever one chunk's frames exist at a time, and they are deleted as
 *     soon as the chunk is encoded
 *   - the frame grid is forced to a constant rate (`fps=`), so a variable-frame
 *     -rate source cannot desynchronise the interpolation arithmetic
 *
 * Audio is deliberately absent here. Chunks are encoded video-only and the
 * original audio is muxed once, at the end, straight from the source - so it is
 * encoded exactly one time and cannot drift chunk by chunk.
 */

const fs = require('fs');
const path = require('path');
const { FfmpegRun, summariseFfmpegError } = require('../ffmpeg/process');
const { encoderArgs } = require('../ffmpeg/encoders');
const { headerBlob } = require('../media-analyzer');
const { VisionanceError, CODES } = require('../errors');

const FRAME_PATTERN = '%08d.png';

function framePath(dir, index) {
  return path.join(dir, String(index).padStart(8, '0') + '.png');
}

function countFrames(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /\.png$/i.test(f)).length;
  } catch {
    return 0;
  }
}

function ensureEmptyDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function runFfmpeg({ bin, args, durationSeconds, control, onProgress, what }) {
  const run = new FfmpegRun(bin, args, { durationSeconds });
  if (control) control.activeRun = run;
  if (control && control.cancelled) run.cancel('cancelled');
  if (onProgress) run.on('progress', onProgress);

  let result;
  try {
    result = await run.run();
  } finally {
    if (control) control.activeRun = null;
  }

  if (result.cancelled || (control && control.cancelled)) {
    throw new VisionanceError(CODES.CANCELLED);
  }
  if (result.code !== 0) {
    const detail = summariseFfmpegError(result.stderrTail, result.code, result.signal);
    throw new VisionanceError(
      /no space left/i.test(result.stderrTail) ? CODES.DISK_FULL : CODES.STAGE_FAILED,
      {
        message: `${what} failed.`,
        technicalDetails: detail
      }
    );
  }
  return result;
}

/**
 * Decode one chunk to a directory of PNGs.
 *
 * @param {object} o
 *   ffmpeg, input, headers
 *   startSeconds, frameCount, fps
 *   outDir, control, onProgress
 * @returns {Promise<{produced:number, dir:string}>}
 */
async function extractFrames({
  ffmpeg, input, headers = null, startSeconds = 0, frameCount, fps, outDir, control, onProgress
}) {
  ensureEmptyDir(outDir);

  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  if (/^https?:/i.test(input)) {
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  }
  const blob = headerBlob(headers);
  if (blob) args.push('-headers', blob);
  if (startSeconds > 0) args.push('-ss', String(startSeconds));
  args.push('-i', input);

  // `fps=` pins the grid: a VFR source becomes an exact ladder of frames, which
  // is what the interpolation planner's arithmetic assumes.
  args.push('-vf', `fps=${fps}`);
  args.push('-frames:v', String(frameCount));
  args.push('-fps_mode', 'passthrough');
  args.push('-start_number', '1');
  args.push('-an', '-sn', '-dn');
  args.push('-progress', 'pipe:1', '-nostats');
  args.push(path.join(outDir, FRAME_PATTERN));

  await runFfmpeg({
    bin: ffmpeg,
    args,
    durationSeconds: frameCount / fps,
    control,
    what: 'Decoding frames',
    onProgress: onProgress ? (p) => onProgress({ ...p, phase: 'extract' }) : null
  });

  const produced = countFrames(outDir);
  if (!produced) {
    throw new VisionanceError(CODES.STAGE_FAILED, {
      message: 'No frames could be decoded from the source for this chunk.',
      technicalDetails: `start=${startSeconds}s want=${frameCount} fps=${fps}`
    });
  }
  return { produced, dir: outDir };
}

/**
 * Encode a directory of PNGs into a video-only chunk.
 *
 * Frames must be numbered from 1 with no gaps; `renumber()` guarantees that
 * after the per-shot RIFE outputs are stitched together.
 */
async function encodeFrames({
  ffmpeg, framesDir, fps, output, encoderId, recipe, control, onProgress, filters = null
}) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-framerate', String(fps),
    '-start_number', '1',
    '-i', path.join(framesDir, FRAME_PATTERN)
  ];

  if (filters) args.push('-vf', filters);

  args.push(...encoderArgs(encoderId, {
    quality: recipe.output.quality,
    preset: recipe.output.preset,
    bitrateMode: recipe.output.bitrateMode,
    bitrateKbps: recipe.output.bitrateKbps,
    maxBitrateKbps: recipe.output.maxBitrateKbps
  }));
  args.push('-pix_fmt', 'yuv420p');
  args.push('-r', String(fps));
  args.push('-an');
  args.push('-avoid_negative_ts', 'make_zero');
  args.push('-max_muxing_queue_size', '1024');
  args.push('-f', containerFormatFor(output));
  args.push('-progress', 'pipe:1', '-nostats');
  args.push(output);

  await runFfmpeg({
    bin: ffmpeg,
    args,
    durationSeconds: countFrames(framesDir) / fps,
    control,
    what: 'Encoding processed frames',
    onProgress: onProgress ? (p) => onProgress({ ...p, phase: 'encode' }) : null
  });

  return output;
}

function containerFormatFor(file) {
  const ext = path.extname(file).replace(/^\./, '').toLowerCase();
  if (ext === 'mkv') return 'matroska';
  if (ext === 'mov') return 'mov';
  if (ext === 'webm') return 'webm';
  return 'mp4';
}

/**
 * Move `files` into `destDir`, renumbered contiguously from `startIndex`.
 *
 * Each shot's RIFE output starts again at 00000001, so the pieces have to be
 * laid end to end before ffmpeg can read them as one sequence. A gap here shows
 * up as a truncated video, so the count is asserted afterwards.
 */
function appendRenumbered(sourceDir, destDir, startIndex, { limit = null, skipTrailing = 0 } = {}) {
  let names;
  try {
    names = fs.readdirSync(sourceDir).filter((f) => /\.png$/i.test(f)).sort();
  } catch {
    names = [];
  }
  if (skipTrailing > 0) names = names.slice(0, Math.max(0, names.length - skipTrailing));
  if (limit != null) names = names.slice(0, limit);

  let index = startIndex;
  for (const name of names) {
    fs.renameSync(path.join(sourceDir, name), framePath(destDir, index));
    index++;
  }
  return index - startIndex;
}

/** Copy one frame N times, for a shot too short to interpolate. */
function repeatFrame(sourceFile, destDir, startIndex, count) {
  for (let i = 0; i < count; i++) {
    fs.copyFileSync(sourceFile, framePath(destDir, startIndex + i));
  }
  return count;
}

/** Copy a contiguous run of source frames straight through. */
function copyRange(sourceDir, destDir, firstSourceIndex, count, startIndex) {
  for (let i = 0; i < count; i++) {
    fs.copyFileSync(framePath(sourceDir, firstSourceIndex + i), framePath(destDir, startIndex + i));
  }
  return count;
}

/**
 * Rough working-space estimate for one chunk, so a job can refuse before it
 * fills the disk rather than after.
 */
function estimateChunkBytes({ width, height, frames, stages = 2 }) {
  // PNG of natural video lands around 1.2 bytes per pixel after compression.
  const perFrame = Math.max(1, Number(width) * Number(height)) * 1.2;
  return Math.ceil(perFrame * Math.max(1, frames) * Math.max(1, stages));
}

module.exports = {
  FRAME_PATTERN,
  extractFrames,
  encodeFrames,
  appendRenumbered,
  repeatFrame,
  copyRange,
  countFrames,
  framePath,
  ensureEmptyDir,
  estimateChunkBytes,
  containerFormatFor
};
