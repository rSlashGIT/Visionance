'use strict';

/**
 * Machine telemetry for the performance panel.
 *
 * Every number here is measured. Nothing is modelled, interpolated or
 * plausibly guessed - a metric this machine does not expose comes back `null`
 * and the UI says so, because a fabricated GPU percentage in a video tool is
 * worse than an empty box.
 *
 * What is genuinely available, and from where:
 *
 *   CPU        Electron's own `app.getAppMetrics()`, summed over the app's
 *              processes. This is Visionance's usage, not the machine's, and
 *              it is labelled that way.
 *   Memory     `process.getSystemMemoryInfo()` for the machine, and the same
 *              app metrics for our own footprint.
 *   GPU        Only where a vendor tool reports it. On NVIDIA that is
 *              `nvidia-smi`, which ships with the driver. There is no
 *              cross-vendor API for utilisation, so on AMD and Intel this is
 *              `null` and the panel plots CPU instead of inventing a number.
 *
 * Sampling is pull-based and driven by a single subscriber count. Nothing runs
 * while nobody is looking: the renderer stops asking when the panel is hidden
 * or the window is not visible, and with no subscribers the interval is
 * cleared outright rather than left ticking.
 */

const os = require('os');
const { spawn } = require('child_process');

const { logger } = require('./logger');

const log = logger.child('telemetry');

/**
 * One sample per 2 s while somebody is watching.
 *
 * Fast enough that a 60-point history covers two minutes and a render's start
 * is visible within a couple of frames of the graph; slow enough that the
 * sampling itself is not the load being measured. `nvidia-smi` costs roughly a
 * process spawn, so 0.5 Hz is the honest ceiling for a UI that claims to be
 * resource-light.
 */
const SAMPLE_INTERVAL_MS = 2000;

class Telemetry {
  /**
   * @param {object} o
   *   app       {Electron.App}
   *   onSample  {function} called with each sample while subscribers exist
   */
  constructor({ app, onSample }) {
    this.app = app;
    this.onSample = onSample;
    this.subscribers = 0;
    this.timer = null;
    this.last = null;
    /** null = not probed yet, false = no vendor tool, string = the binary. */
    this.gpuTool = null;
    this._gpuProbe = null;
    this._gpuBusy = false;
    this._lastCpu = null;
  }

  /**
   * Start or stop sampling as the renderer's interest changes.
   *
   * @param {boolean} active
   */
  setActive(active) {
    this.subscribers = active ? this.subscribers + 1 : Math.max(0, this.subscribers - 1);
    if (this.subscribers > 0 && !this.timer) {
      // Take one immediately so a panel that just opened is not blank for two
      // seconds, then settle into the interval.
      this._sample();
      this.timer = setInterval(() => this._sample(), SAMPLE_INTERVAL_MS);
      if (this.timer.unref) this.timer.unref();
      log.debug('telemetry started');
    } else if (this.subscribers === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.debug('telemetry stopped');
    }
    return { active: this.subscribers > 0, intervalMs: SAMPLE_INTERVAL_MS };
  }

  /**
   * Forget every subscription, because the renderer that held them is gone.
   *
   * `setActive` is a count, and the balancing `setActive(false)` calls live in
   * the renderer. A reload (View → Reload, Ctrl+R) destroys that document
   * without it ever decrementing, so the count never returns to zero and
   * sampling continues for the rest of the session - spawning nvidia-smi every
   * two seconds behind a minimised window with no panel open. Called at the
   * start of every load, before the new document runs any script, so it can
   * never clobber a subscription the new renderer has already made.
   */
  reset() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.debug('telemetry stopped: renderer reloaded');
    }
    this.subscribers = 0;
  }

  /** The most recent sample, taking one now if there is none. */
  async snapshot() {
    if (!this.last) await this._sample();
    return this.last;
  }

  async _sample() {
    const sample = {
      at: Date.now(),
      cpu: this._cpu(),
      memory: this._memory(),
      gpu: await this._gpu(),
      intervalMs: SAMPLE_INTERVAL_MS
    };
    this.last = sample;
    if (this.onSample && this.subscribers > 0) {
      try {
        this.onSample(sample);
      } catch (err) {
        log.debug('telemetry listener failed', { error: err.message });
      }
    }
    return sample;
  }

  /**
   * Visionance's own CPU share, across every process it runs.
   *
   * `percentCPUUsage` is per logical core in Chromium's accounting, so the sum
   * across processes is divided by the core count to land on a share of the
   * whole machine - which is what a percentage in a UI is read as.
   */
  _cpu() {
    let appPercent = null;
    try {
      const metrics = this.app.getAppMetrics();
      const cores = Math.max(1, os.cpus().length);
      const total = metrics.reduce((sum, m) => sum + ((m.cpu && m.cpu.percentCPUUsage) || 0), 0);
      appPercent = Math.max(0, Math.min(100, Math.round((total / cores) * 10) / 10));
    } catch (err) {
      log.debug('app metrics unavailable', { error: err.message });
    }
    return {
      /** Share of the whole machine used by this application. */
      appPercent,
      cores: os.cpus().length || null,
      model: (os.cpus()[0] && os.cpus()[0].model) || null
    };
  }

  _memory() {
    let systemUsedBytes = null;
    let systemTotalBytes = null;
    try {
      // Reported in kilobytes.
      const info = process.getSystemMemoryInfo();
      systemTotalBytes = info.total * 1024;
      systemUsedBytes = (info.total - info.free) * 1024;
    } catch {
      systemTotalBytes = os.totalmem() || null;
      systemUsedBytes = systemTotalBytes ? systemTotalBytes - os.freemem() : null;
    }

    let appBytes = null;
    try {
      const metrics = this.app.getAppMetrics();
      const kb = metrics.reduce(
        (sum, m) => sum + ((m.memory && m.memory.workingSetSize) || 0), 0
      );
      if (kb > 0) appBytes = kb * 1024;
    } catch { /* left null */ }

    return { systemUsedBytes, systemTotalBytes, appBytes };
  }

  /**
   * GPU utilisation and VRAM, only where a vendor tool actually reports them.
   *
   * Probed once. If there is no tool the answer is `null` forever and no
   * process is spawned again - a panel that shells out every two seconds
   * looking for a binary that is not there would be exactly the kind of idle
   * cost this UI is supposed to avoid.
   */
  async _gpu() {
    if (this.gpuTool === false) return null;
    if (this.gpuTool === null) {
      if (!this._gpuProbe) this._gpuProbe = this._probeGpuTool();
      this.gpuTool = await this._gpuProbe;
      if (this.gpuTool === false) return null;
    }
    // A sample still running when the next tick arrives is skipped rather than
    // queued: two nvidia-smi processes tell us nothing one does not.
    if (this._gpuBusy) return this.last ? this.last.gpu : null;

    this._gpuBusy = true;
    try {
      const out = await runCapture(this.gpuTool, [
        '--query-gpu=name,utilization.gpu,memory.used,memory.total',
        '--format=csv,noheader,nounits'
      ], 4000);
      const line = String(out || '').split('\n').map((s) => s.trim()).filter(Boolean)[0];
      if (!line) return null;
      const parts = line.split(',').map((s) => s.trim());
      if (parts.length < 4) return null;
      const utilisation = Number(parts[1]);
      const usedMb = Number(parts[2]);
      const totalMb = Number(parts[3]);
      return {
        name: parts[0] || null,
        source: 'nvidia-smi',
        utilisationPercent: Number.isFinite(utilisation) ? utilisation : null,
        memoryUsedBytes: Number.isFinite(usedMb) ? usedMb * 1024 * 1024 : null,
        memoryTotalBytes: Number.isFinite(totalMb) ? totalMb * 1024 * 1024 : null
      };
    } catch (err) {
      log.debug('gpu sample failed', { error: err.message });
      return null;
    } finally {
      this._gpuBusy = false;
    }
  }

  async _probeGpuTool() {
    const candidates = process.platform === 'win32'
      ? [
        'nvidia-smi',
        'C:\\Windows\\System32\\nvidia-smi.exe',
        'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe'
      ]
      : ['nvidia-smi', '/usr/bin/nvidia-smi'];

    for (const candidate of candidates) {
      const out = await runCapture(candidate, [
        '--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'
      ], 5000);
      if (out && /\d/.test(out)) {
        log.info('gpu telemetry available', { tool: candidate });
        return candidate;
      }
    }
    log.info('gpu utilisation not exposed on this system');
    return false;
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.subscribers = 0;
  }
}

function runCapture(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch {
      return resolve('');
    }
    let out = '';
    if (child.stdout) {
      child.stdout.on('data', (b) => { if (out.length < 8192) out += b.toString('utf8'); });
    }
    if (child.stderr) child.stderr.resume();
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      resolve('');
    }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

module.exports = { Telemetry, SAMPLE_INTERVAL_MS };
