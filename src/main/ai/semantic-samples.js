'use strict';

/**
 * Streaming semantic sampling.
 *
 * One ffmpeg pass emits letterboxed square RGB frames at the semantic sample
 * rate. Each frame is inferred and immediately dropped; only boxes are kept.
 * At 640x640 a frame is 1.2 MB, so holding even a few seconds of them would be
 * hundreds of megabytes on a machine with eight gigabytes total - hence the
 * back-pressured, one-frame-at-a-time loop rather than collecting first and
 * inferring after.
 */

const { spawn } = require('child_process');
const { headerBlob } = require('../media-analyzer');
const { VisionanceError, CODES } = require('../errors');
const { logger } = require('../logger');
const { FACE_SIZE } = require('./detector');

const log = logger.child('reframe');

/**
 * Decode at `intervalSeconds` and run `onFrame` for each sample.
 *
 * @param {object} o
 *   ffmpeg, input, headers, startSeconds, durationSeconds, intervalSeconds
 *   onFrame  {(rgb:Buffer, index:number, time:number) => Promise<void>}
 *   control  cancellation handle
 * @returns {Promise<{frames:number}>}
 */
function streamSemanticFrames({
  ffmpeg, input, headers, startSeconds = 0, durationSeconds,
  intervalSeconds, onFrame, control
}) {
  return new Promise((resolve, reject) => {
    const size = FACE_SIZE;
    const fps = 1 / intervalSeconds;

    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (/^https?:/i.test(input)) {
      args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
    }
    const blob = headerBlob(headers);
    if (blob) args.push('-headers', blob);
    if (startSeconds > 0) args.push('-ss', String(startSeconds));
    args.push('-i', input);
    if (durationSeconds) args.push('-t', String(durationSeconds));
    // Letterbox rather than stretch: the models were trained on undistorted
    // faces, and the pad offsets are what maps boxes back to source space.
    args.push('-vf',
      `fps=${fps},scale=${size}:${size}:force_original_aspect_ratio=decrease,` +
      `pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=black`);
    args.push('-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');

    const proc = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (control) control.activeRun = { cancel: () => { try { proc.kill(); } catch { /* gone */ } } };

    const frameBytes = size * size * 3;
    let pending = Buffer.alloc(0);
    let index = 0;
    let stderr = '';
    let queue = Promise.resolve();
    let failed = null;

    proc.stdout.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= frameBytes) {
        const frame = pending.subarray(0, frameBytes);
        pending = pending.subarray(frameBytes);
        const i = index++;
        const time = i * intervalSeconds;
        // Serialise inference and pause the decoder while it runs, so at most
        // one frame plus ffmpeg's own pipe buffer is ever resident.
        proc.stdout.pause();
        queue = queue
          .then(() => onFrame(frame, i, time))
          .catch((err) => { failed = failed || err; })
          .then(() => { if (!proc.killed) proc.stdout.resume(); });
      }
    });

    proc.stderr.on('data', (c) => { stderr = (stderr + c.toString()).slice(-2000); });
    proc.on('error', (err) => reject(new VisionanceError(CODES.STAGE_FAILED, {
      message: 'Semantic analysis could not start.',
      technicalDetails: err.message
    })));
    proc.on('close', (code) => {
      if (control) control.activeRun = null;
      queue.then(() => {
        if (control && control.cancelled) return reject(new VisionanceError(CODES.CANCELLED));
        if (failed) return reject(failed);
        if (code !== 0) {
          return reject(new VisionanceError(CODES.STAGE_FAILED, {
            message: 'Semantic analysis failed.',
            technicalDetails: `ffmpeg exit ${code}: ${stderr.slice(-300)}`
          }));
        }
        log.debug('semantic frames', { frames: index });
        return resolve({ frames: index });
      });
    });
  });
}

module.exports = { streamSemanticFrames };
