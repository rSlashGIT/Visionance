'use strict';

/**
 * Running an NCNN/Vulkan AI executable.
 *
 * These tools are not chatty and do not report progress in a machine-readable
 * way, so progress is measured by counting the frames they have actually
 * written. That is a real measurement rather than an interpolated guess, and it
 * is the only number we show.
 *
 * Two failure modes matter enough to detect specifically:
 *
 *   - **Out of memory.** Vulkan allocation failures surface as recognisable
 *     stderr lines (and sometimes as a plain crash). The caller retries with a
 *     smaller tile rather than giving up.
 *   - **No Vulkan device.** A machine with no usable GPU must be told so, not
 *     left waiting on a process that will never produce a frame.
 *
 * Cancellation kills only this job's own process tree. It never matches on
 * executable name, so two concurrent jobs cannot kill each other's work.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { VisionanceError, CODES } = require('../errors');
const { logger } = require('../logger');

const log = logger.child('ai');

/** ncnn/Vulkan allocation failures, in the wording these tools actually use. */
const OOM_PATTERNS = [
  /vkallocatememory failed/i,
  /out of (device |host )?memory/i,
  /failed to allocate/i,
  /vkcreatebuffer failed/i,
  /vkmapmemory failed/i,
  /device memory/i,
  /allocator.*fail/i
];

const NO_VULKAN_PATTERNS = [
  /vkcreateinstance failed/i,
  /no vulkan device/i,
  /vulkan.*not (found|available|supported)/i,
  /failed to (find|create) (a )?(gpu|vulkan)/i,
  /gpu count *= *0/i
];

function matchesAny(text, patterns) {
  return patterns.some((p) => p.test(text));
}

class AiRun extends EventEmitter {
  /**
   * @param {object} o
   *   bin        {string}  executable path
   *   args       {string[]}
   *   cwd        {string}  the engine directory (ncnn tools resolve models relatively)
   *   watchDir   {string}  directory whose file count is the progress signal
   *   expected   {number}  how many files a complete run produces
   *   control    {{cancelled:boolean}}
   *   timeoutMs  {number}
   */
  constructor(o) {
    super();
    this.bin = o.bin;
    this.args = o.args || [];
    this.cwd = o.cwd;
    this.watchDir = o.watchDir || null;
    this.expected = Number(o.expected) || 0;
    this.control = o.control || { cancelled: false };
    this.timeoutMs = Number(o.timeoutMs) || 0;

    this.proc = null;
    this.stderrTail = '';
    this.produced = 0;
    this._poll = null;
    this._timeout = null;
    this._killed = false;
  }

  /** @returns {Promise<{code:number|null, produced:number, stderrTail:string}>} */
  run() {
    if (!this.bin || !fs.existsSync(this.bin)) {
      return Promise.reject(new VisionanceError(CODES.ENGINE_MISSING, {
        technicalDetails: `executable not found: ${this.bin}`
      }));
    }

    return new Promise((resolve, reject) => {
      let proc;
      try {
        proc = spawn(this.bin, this.args, {
          cwd: this.cwd,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (err) {
        return reject(new VisionanceError(CODES.AI_PROCESS_FAILED, {
          technicalDetails: `${err.message} :: ${path.basename(this.bin)}`
        }));
      }
      this.proc = proc;

      // These tools write progress-ish chatter to stderr; keep the tail only.
      const absorb = (chunk) => {
        this.stderrTail = (this.stderrTail + chunk.toString()).slice(-8000);
      };
      proc.stdout.on('data', absorb);
      proc.stderr.on('data', absorb);

      if (this.watchDir) this._startCounting();
      if (this.control.cancelled) this.cancel();
      if (this.timeoutMs) {
        this._timeout = setTimeout(() => this.cancel('timeout'), this.timeoutMs);
      }

      proc.on('error', (err) => {
        this._cleanup();
        reject(new VisionanceError(CODES.AI_PROCESS_FAILED, {
          technicalDetails: `${err.message} :: ${path.basename(this.bin)}`
        }));
      });

      proc.on('close', (code, signal) => {
        this._cleanup();
        this.produced = this._countFiles();
        resolve({
          code,
          signal,
          produced: this.produced,
          killed: this._killed,
          stderrTail: this.stderrTail
        });
      });
    });
  }

  _startCounting() {
    const tick = () => {
      const produced = this._countFiles();
      if (produced !== this.produced) {
        this.produced = produced;
        this.emit('progress', {
          produced,
          expected: this.expected,
          fraction: this.expected ? Math.min(0.999, produced / this.expected) : 0
        });
      }
    };
    this._poll = setInterval(tick, 500);
    if (this._poll.unref) this._poll.unref();
  }

  _countFiles() {
    if (!this.watchDir) return 0;
    try {
      // Only count finished frames; ncnn writes atomically per file.
      return fs.readdirSync(this.watchDir).filter((f) => /\.(png|jpg|webp)$/i.test(f)).length;
    } catch {
      return this.produced;
    }
  }

  _cleanup() {
    if (this._poll) { clearInterval(this._poll); this._poll = null; }
    if (this._timeout) { clearTimeout(this._timeout); this._timeout = null; }
    this.proc = null;
  }

  /**
   * Kill this job's process tree - by pid, never by image name. Two renders can
   * be running the same executable and must not take each other down.
   */
  cancel(reason = 'cancelled') {
    const proc = this.proc;
    if (!proc || this._killed) return false;
    this._killed = true;
    this.cancelReason = reason;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
      } else {
        proc.kill('SIGKILL');
      }
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Interpret a finished run.
 * @returns {{ok:boolean, reason:'ok'|'cancelled'|'oom'|'no-vulkan'|'incomplete'|'failed'}}
 */
function interpretResult(result, { expected = 0 } = {}) {
  const text = result.stderrTail || '';
  if (result.killed) return { ok: false, reason: 'cancelled' };
  if (matchesAny(text, NO_VULKAN_PATTERNS)) return { ok: false, reason: 'no-vulkan' };
  if (matchesAny(text, OOM_PATTERNS)) return { ok: false, reason: 'oom' };
  if (result.code !== 0) {
    // A non-zero exit with nothing recognisable in stderr, after producing some
    // frames, is very often an allocation failure that only printed a crash.
    if (expected && result.produced > 0 && result.produced < expected) {
      return { ok: false, reason: 'oom' };
    }
    return { ok: false, reason: 'failed' };
  }
  if (expected && result.produced < expected) return { ok: false, reason: 'incomplete' };
  return { ok: true, reason: 'ok' };
}

/** ncnn prints one such line per device: `[1 NVIDIA GeForce RTX 4060 Ti]  queueC=...` */
function parseGpuList(text) {
  const seen = new Map();
  const re = /\[(\d+)\s+([^\]]+?)\]\s+queue/gi;
  let m;
  while ((m = re.exec(text || ''))) {
    const index = Number(m[1]);
    if (!seen.has(index)) seen.set(index, { index, name: m[2].trim() });
  }
  return [...seen.values()].sort((a, b) => a.index - b.index);
}

/** Discrete parts are worth an order of magnitude over integrated ones. */
function gpuScore(name) {
  const n = String(name || '').toLowerCase();
  if (/nvidia|geforce|rtx|gtx|quadro|tesla/.test(n)) return 3;
  if (/radeon|\brx\b|amd/.test(n)) return 3;
  if (/arc\b/.test(n)) return 2;
  if (/intel|uhd|iris/.test(n)) return 1;
  if (/llvmpipe|swiftshader|software/.test(n)) return 0;
  return 2;
}

/**
 * Which Vulkan device `auto` should mean.
 *
 * ncnn's own default is device 0, which on a laptop is usually the integrated
 * GPU sitting next to a much faster discrete one. Picking the discrete part is
 * the difference between minutes and hours on a real render.
 * @returns {number|null} null when there is nothing to choose between
 */
function preferredGpu(gpus) {
  if (!gpus || gpus.length < 2) return gpus && gpus.length === 1 ? gpus[0].index : null;
  const ranked = [...gpus].sort((a, b) => gpuScore(b.name) - gpuScore(a.name) || a.index - b.index);
  return ranked[0].index;
}

/**
 * Ask an ncnn tool which Vulkan devices it can see.
 *
 * `-h` will not do: these tools print their help without ever creating a Vulkan
 * instance, so it always looks like there is no GPU. The device list appears at
 * the start of a *real* run, so this starts one on the engine's own bundled
 * sample image and stops as soon as the devices have been listed.
 *
 * @param {object} o { bin, cwd, sampleInput, outFile, extraArgs }
 * @returns {Promise<{gpus, vulkan, raw}>}
 */
function probeGpus(bin, cwd, o = {}) {
  return new Promise((resolve) => {
    if (!bin || !fs.existsSync(bin)) return resolve({ gpus: [], vulkan: false, raw: '' });

    const args = o.args || ['-h'];
    let proc;
    try {
      proc = spawn(bin, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ gpus: [], vulkan: false, raw: String(err.message) });
    }

    let raw = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill(); } catch { /* already gone */ }
      if (process.platform === 'win32' && proc.pid) {
        try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }); } catch { /* ignore */ }
      }
      const gpus = parseGpuList(raw);
      resolve({
        gpus,
        vulkan: gpus.length > 0 && !matchesAny(raw, NO_VULKAN_PATTERNS),
        raw: raw.slice(0, 4000)
      });
    };

    const onData = (chunk) => {
      raw += chunk.toString();
      // Devices are listed before any work starts; once the first percentage or
      // a second device block appears there is nothing more to learn.
      if (/%/.test(raw) || /\bbugsbn1=/.test(raw)) {
        // Give the remaining device lines a moment to arrive.
        setTimeout(finish, 250);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', finish);
    proc.on('close', finish);

    const timer = setTimeout(finish, o.timeoutMs || 25000);
  });
}

module.exports = {
  AiRun,
  interpretResult,
  probeGpus,
  parseGpuList,
  preferredGpu,
  gpuScore,
  OOM_PATTERNS,
  NO_VULKAN_PATTERNS,
  log
};
