'use strict';

/**
 * Running ffmpeg.
 *
 * Progress is read from `-progress pipe:1` rather than scraped from stderr:
 * it is machine-readable, stable across versions, and does not fight with the
 * error output we want to keep for diagnostics.
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { VisionanceError, CODES, redactArgs, redact } = require('../errors');

const KILL_ESCALATION_MS = 1500;

class FfmpegRun extends EventEmitter {
  /**
   * @param {string} bin
   * @param {string[]} args
   * @param {object} [opts] { durationSeconds, cwd, timeoutMs }
   */
  constructor(bin, args, opts = {}) {
    super();
    this.bin = bin;
    this.args = args;
    this.durationSeconds = Number(opts.durationSeconds) || 0;
    this.cwd = opts.cwd || undefined;
    this.timeoutMs = Number(opts.timeoutMs) || 0;

    this.proc = null;
    this.cancelled = false;
    this.cancelReason = null;
    this.stderrTail = '';
    this.lastProgress = null;
    this._killTimer = null;
    this._timeoutTimer = null;
  }

  /** @returns {Promise<{code:number|null, signal:string|null, cancelled:boolean, stderrTail:string}>} */
  run() {
    if (!this.bin) return Promise.reject(new VisionanceError(CODES.FFMPEG_MISSING));

    return new Promise((resolve, reject) => {
      let proc;
      try {
        proc = spawn(this.bin, this.args, { windowsHide: true, cwd: this.cwd });
      } catch (err) {
        return reject(new VisionanceError(CODES.ENCODE_FAILED, {
          message: 'ffmpeg could not be started.',
          technicalDetails: err.message
        }));
      }
      this.proc = proc;

      let stdoutBuf = '';
      proc.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop();
        for (const line of lines) this._consume(line.trim());
      });

      proc.stderr.on('data', (chunk) => {
        this.stderrTail = (this.stderrTail + chunk.toString()).slice(-8000);
      });

      proc.on('error', (err) => {
        this._clearTimers();
        this.proc = null;
        reject(new VisionanceError(CODES.ENCODE_FAILED, {
          message: err.code === 'ENOENT' ? 'The ffmpeg executable was not found.' : 'ffmpeg failed to run.',
          technicalDetails: `${err.message} :: ${redactArgs(this.args).join(' ')}`
        }));
      });

      proc.on('close', (code, signal) => {
        this._clearTimers();
        this.proc = null;
        resolve({
          code,
          signal,
          cancelled: this.cancelled,
          cancelReason: this.cancelReason,
          stderrTail: redact(this.stderrTail)
        });
      });

      if (this.timeoutMs) {
        this._timeoutTimer = setTimeout(() => this.cancel('timeout'), this.timeoutMs);
      }
    });
  }

  _consume(line) {
    const eq = line.indexOf('=');
    if (eq < 0) return;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);

    const p = this.lastProgress || (this.lastProgress = {
      outTimeSeconds: 0, fps: 0, speed: 0, frame: 0, bitrateKbps: 0, fraction: 0, ended: false
    });

    switch (key) {
      case 'out_time_us':
      case 'out_time_ms': {
        const seconds = Number(value) / (key === 'out_time_us' ? 1e6 : 1e3);
        if (Number.isFinite(seconds) && seconds >= 0) {
          p.outTimeSeconds = seconds;
          if (this.durationSeconds > 0) {
            p.fraction = Math.min(0.999, seconds / this.durationSeconds);
          }
        }
        break;
      }
      case 'frame':
        p.frame = Number(value) || 0;
        break;
      case 'fps':
        p.fps = Number(value) || 0;
        break;
      case 'bitrate':
        p.bitrateKbps = parseFloat(value) || 0;
        break;
      case 'speed':
        p.speed = parseFloat(value) || 0;
        break;
      case 'progress':
        if (value === 'end') {
          p.ended = true;
          p.fraction = 1;
        }
        // ffmpeg writes `progress=` last in each block, so this is the point
        // where the snapshot is internally consistent.
        this.emit('progress', { ...p });
        break;
      default:
        break;
    }
  }

  /**
   * ffmpeg treats SIGTERM as "finish what you're doing", which on a heavy
   * filter graph can mean seconds more work. Ask, then escalate.
   */
  cancel(reason = 'cancelled') {
    if (this.cancelled) return false;
    this.cancelled = true;
    this.cancelReason = reason;
    const proc = this.proc;
    if (!proc) return false;

    try {
      if (process.platform === 'win32') {
        // No signals on Windows: take the whole tree down.
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
        return true;
      }
      proc.kill('SIGTERM');
    } catch {
      return false;
    }

    this._killTimer = setTimeout(() => {
      if (this.proc) {
        try { this.proc.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, KILL_ESCALATION_MS);
    return true;
  }

  _clearTimers() {
    if (this._killTimer) { clearTimeout(this._killTimer); this._killTimer = null; }
    if (this._timeoutTimer) { clearTimeout(this._timeoutTimer); this._timeoutTimer = null; }
  }
}

/** Turn the last few stderr lines into something worth putting in an error. */
function summariseFfmpegError(stderrTail, code, signal) {
  const lines = String(stderrTail || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const meaningful = lines.filter((l) => !/^\s*$/.test(l)).slice(-3);
  if (meaningful.length) return meaningful.join(' · ');
  return `ffmpeg exited with code ${code}${signal ? ` (${signal})` : ''}`;
}

module.exports = { FfmpegRun, summariseFfmpegError };
