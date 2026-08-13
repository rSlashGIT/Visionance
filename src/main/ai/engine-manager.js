'use strict';

/**
 * AI engine lifecycle.
 *
 * Owns install / status / removal for the neural backends, and nothing about
 * what they do. The job pipeline asks this for "a ready engine and a usable
 * model" and gets either that or a structured refusal - it never has to reason
 * about downloads, archives or Vulkan.
 *
 * Engines live in `<userData>/engines/<id>/`, never in the repository. An
 * engine is only reported `ready` when its executable exists *and* at least one
 * model is present *and* a Vulkan device answered - so "installed" can never
 * mean "downloaded but unusable".
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const downloads = require('./downloads');
const { AiRun, probeGpus } = require('./process');
const realesrgan = require('./engines/realesrgan');
const rife = require('./engines/rife');
const { VisionanceError, CODES } = require('../errors');
const { logger } = require('../logger');

const log = logger.child('engines');

const ENGINES = { [realesrgan.ID]: realesrgan, [rife.ID]: rife };

/**
 * A valid 2x2 opaque PNG, used to give RIFE something real to chew on during
 * the capability probe. Inline so the probe needs no ffmpeg and no assets.
 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8//8/AzbAhFVsQKUB' +
  'jGsCTMSc0LgAAAAASUVORK5CYII=',
  'base64'
);

/** not-installed → installing → ready | broken | unsupported */
const STATUS = {
  NOT_INSTALLED: 'not-installed',
  INSTALLING: 'installing',
  READY: 'ready',
  BROKEN: 'broken',
  UNSUPPORTED: 'unsupported'
};

class EngineManager extends EventEmitter {
  /** @param {object} o { rootDir } - usually <userData>/engines */
  constructor({ rootDir }) {
    super();
    this.rootDir = rootDir;
    /** id -> cached status */
    this.cache = new Map();
    /** id -> { control, promise } while installing */
    this.installs = new Map();
    this.gpuCache = null;
  }

  ids() {
    return Object.keys(ENGINES);
  }

  dirFor(id) {
    return path.join(this.rootDir, id);
  }

  tmpDir() {
    return path.join(this.rootDir, '.tmp');
  }

  metaPath(id) {
    return path.join(this.dirFor(id), 'visionance-engine.json');
  }

  /* ---------------- status ---------------- */

  /**
   * Full status for one engine. Cheap enough to call on demand; the Vulkan
   * probe (which spawns a process) is cached.
   * @returns {Promise<object>}
   */
  async status(id, { force = false } = {}) {
    const engine = ENGINES[id];
    if (!engine) throw new VisionanceError(CODES.INVALID_REQUEST, { message: `Unknown engine ${id}` });

    if (this.installs.has(id)) {
      return this._shape(id, engine, {
        status: STATUS.INSTALLING,
        installed: false,
        progress: this.installs.get(id).progress || null
      });
    }
    if (!force && this.cache.has(id)) return this.cache.get(id);

    const release = engine.releaseFor();
    if (!release || !release.url) {
      const unsupported = this._shape(id, engine, { status: STATUS.UNSUPPORTED, installed: false });
      this.cache.set(id, unsupported);
      return unsupported;
    }

    const dir = this.dirFor(id);
    const exe = path.join(dir, release.executable);
    if (!fs.existsSync(exe)) {
      const missing = this._shape(id, engine, { status: STATUS.NOT_INSTALLED, installed: false });
      this.cache.set(id, missing);
      return missing;
    }

    const models = engine.installedModels(dir);
    if (!models.length) {
      const broken = this._shape(id, engine, {
        status: STATUS.BROKEN,
        installed: true,
        executablePath: exe,
        error: {
          code: CODES.MODEL_MISSING,
          message: 'The engine is installed but no model weights were found.'
        }
      });
      this.cache.set(id, broken);
      return broken;
    }

    const gpu = await this.gpus(id, exe, dir, models, force);
    const value = this._shape(id, engine, {
      status: gpu.vulkan ? STATUS.READY : STATUS.BROKEN,
      installed: true,
      executablePath: exe,
      models,
      availableGPUs: gpu.gpus,
      version: this._readMeta(id).version || null,
      error: gpu.vulkan ? null : {
        code: CODES.VULKAN_UNAVAILABLE,
        message: 'No Vulkan device was reported, so this engine cannot run here.'
      }
    });
    this.cache.set(id, value);
    return value;
  }

  async statusAll(opts) {
    const out = {};
    for (const id of this.ids()) {
      // eslint-disable-next-line no-await-in-loop -- two engines, each spawning
      // a probe; parallelism here buys nothing and muddles the logs.
      out[id] = await this.status(id, opts);
    }
    return out;
  }

  /**
   * Vulkan device list, as reported by an engine's own runtime.
   *
   * This has to start a real inference - see probeGpus - so the arguments are
   * engine-specific and deliberately tiny: the engine's own bundled sample
   * image (Real-ESRGAN) or its smallest model (RIFE), at a small tile, killed
   * the moment the device list has been printed.
   */
  async gpus(id, exe, cwd, models, force = false) {
    if (!force && this.gpuCache) return this.gpuCache;

    const scratch = path.join(this.tmpDir(), `probe-${id}`);
    fs.mkdirSync(scratch, { recursive: true });
    let args = ['-h'];

    if (id === realesrgan.ID) {
      const sample = ['input.jpg', 'input2.jpg'].map((f) => path.join(cwd, f)).find((f) => fs.existsSync(f));
      if (sample) {
        args = ['-i', sample, '-o', path.join(scratch, 'probe.png'), '-s', '4', '-t', '32',
          '-n', (models[0] && models[0].name) || 'realesrgan-x4plus'];
      }
    } else if (id === rife.ID) {
      // RIFE bails out before touching Vulkan if it has nothing to read, so the
      // probe hands it two real (tiny) frames. This doubles as a health check:
      // an engine that cannot interpolate 2x2 pixels is not "ready".
      const inDir = path.join(scratch, 'in');
      const outDir = path.join(scratch, 'out');
      fs.mkdirSync(inDir, { recursive: true });
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(inDir, '00000001.png'), TINY_PNG);
      fs.writeFileSync(path.join(inDir, '00000002.png'), TINY_PNG);
      args = ['-i', inDir, '-o', outDir, '-n', '3', '-f', '%08d.png',
        '-m', (models[0] && models[0].path) || path.join(cwd, 'rife-v4.6')];
    }

    const probe = await probeGpus(exe, cwd, { args });
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }

    // Cache only a positive answer: a failure may just mean this engine is
    // mid-install, and we do not want to remember that as "no GPU".
    if (probe.gpus.length) this.gpuCache = probe;
    return probe;
  }

  _shape(id, engine, extra) {
    return {
      id,
      name: engine.LICENSE.name,
      license: engine.LICENSE,
      version: null,
      status: STATUS.NOT_INSTALLED,
      installed: false,
      executablePath: null,
      engineDir: this.dirFor(id),
      modelPaths: [],
      models: [],
      availableGPUs: [],
      downloadBytes: (engine.releaseFor() || {}).bytes || null,
      error: null,
      ...extra,
      modelPaths: (extra.models || []).map((m) => m.path || m.name).filter(Boolean)
    };
  }

  _readMeta(id) {
    try {
      return JSON.parse(fs.readFileSync(this.metaPath(id), 'utf8'));
    } catch {
      return {};
    }
  }

  _writeMeta(id, meta) {
    try {
      fs.writeFileSync(this.metaPath(id), JSON.stringify(meta, null, 2), 'utf8');
    } catch (err) {
      log.warn('could not write engine metadata', { engine: id, error: err.message });
    }
  }

  /* ---------------- install ---------------- */

  /**
   * Download and unpack an engine.
   *
   * Concurrent calls for the same engine share one install rather than racing
   * to write the same directory.
   *
   * @param {object} o { id, onProgress }
   */
  async install(id, { onProgress = null } = {}) {
    const engine = ENGINES[id];
    if (!engine) throw new VisionanceError(CODES.INVALID_REQUEST, { message: `Unknown engine ${id}` });

    const existing = this.installs.get(id);
    if (existing) {
      if (onProgress) existing.listeners.push(onProgress);
      return existing.promise;
    }

    const release = engine.releaseFor();
    if (!release || !release.url) {
      throw new VisionanceError(CODES.ENGINE_UNSUPPORTED, {
        message: `There is no ${engine.LICENSE.name} build for this platform.`
      });
    }

    // Refuse before downloading rather than filling the disk and then failing.
    const need = (release.bytes || 0) * 3;
    const free = downloads.freeSpaceBytes(this.rootDir) ?? downloads.freeSpaceBytes(path.dirname(this.rootDir));
    if (need && free != null && free < need) {
      throw new VisionanceError(CODES.INSUFFICIENT_DISK_SPACE, {
        message: `Installing ${engine.LICENSE.name} needs about ${Math.ceil(need / 1e9)} GB free; ` +
          `there is ${(free / 1e9).toFixed(1)} GB.`,
        technicalDetails: `need=${need} free=${free} root=${this.rootDir}`
      });
    }

    fs.mkdirSync(this.rootDir, { recursive: true });

    const control = { cancelled: false };
    const listeners = onProgress ? [onProgress] : [];
    const entry = { control, listeners, progress: null };

    const emit = (p) => {
      entry.progress = p;
      this.emit('install-progress', { id, ...p });
      for (const fn of listeners) {
        try { fn(p); } catch { /* a listener must not break the install */ }
      }
    };

    entry.promise = (async () => {
      log.info('engine install started', { engine: id, bytes: release.bytes });
      this.cache.delete(id);
      try {
        await downloads.downloadAndExtract({
          url: release.url,
          sha256: release.sha256,
          expectBytes: release.bytes,
          destDir: this.dirFor(id),
          tmpDir: this.tmpDir(),
          signal: control,
          label: engine.LICENSE.name,
          onProgress: emit
        });

        this._writeMeta(id, {
          id,
          version: path.basename(new URL(release.url).pathname, '.zip'),
          url: release.url,
          installedAt: Date.now(),
          license: engine.LICENSE
        });

        this.cache.delete(id);
        // Drop the in-flight record *before* asking for status, or status()
        // sees an install still in progress and reports `installing` for an
        // engine that has finished.
        this.installs.delete(id);
        const status = await this.status(id, { force: true });
        if (status.status !== STATUS.READY) {
          log.warn('engine installed but not ready', { engine: id, status: status.status });
        } else {
          log.info('engine ready', {
            engine: id,
            models: status.models.length,
            gpus: status.availableGPUs.map((g) => g.name).join(', ') || 'none'
          });
        }
        this.emit('status', { id, status });
        return status;
      } catch (err) {
        this.cache.delete(id);
        // Never leave a half-populated engine folder that later looks valid.
        if (control.cancelled) {
          try { fs.rmSync(this.dirFor(id), { recursive: true, force: true }); } catch { /* ignore */ }
        }
        throw err;
      } finally {
        this.installs.delete(id);
      }
    })();

    this.installs.set(id, entry);
    return entry.promise;
  }

  cancelInstall(id) {
    const entry = this.installs.get(id);
    if (!entry) return false;
    entry.control.cancelled = true;
    log.info('engine install cancelled', { engine: id });
    return true;
  }

  remove(id) {
    if (this.installs.has(id)) this.cancelInstall(id);
    this.cache.delete(id);
    try {
      fs.rmSync(this.dirFor(id), { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /* ---------------- use ---------------- */

  /**
   * The engine a stage needs, or a structured refusal explaining exactly what
   * is missing. Stages call this and never touch the filesystem themselves.
   */
  async require(id) {
    const status = await this.status(id);
    if (status.status === STATUS.READY) return status;

    if (status.status === STATUS.NOT_INSTALLED) {
      throw new VisionanceError(CODES.ENGINE_MISSING, {
        message: `${status.name} is not installed, so this render cannot run.`,
        suggestedAction: 'Settings → AI engines → Install.'
      });
    }
    if (status.status === STATUS.INSTALLING) {
      throw new VisionanceError(CODES.ENGINE_MISSING, {
        message: `${status.name} is still installing.`,
        suggestedAction: 'Wait for the install to finish, then retry the job.'
      });
    }
    if (status.status === STATUS.UNSUPPORTED) {
      throw new VisionanceError(CODES.ENGINE_UNSUPPORTED, {
        message: `There is no ${status.name} build for this platform.`
      });
    }
    throw new VisionanceError(
      status.error && status.error.code === CODES.VULKAN_UNAVAILABLE
        ? CODES.VULKAN_UNAVAILABLE
        : CODES.ENGINE_BROKEN,
      {
        message: (status.error && status.error.message) || `${status.name} is installed but not usable.`,
        technicalDetails: JSON.stringify(status.error || {})
      }
    );
  }

  /** Run an engine executable. Thin wrapper so stages share one code path. */
  createRun({ engineId, args, watchDir, expected, control, timeoutMs }) {
    const status = this.cache.get(engineId);
    if (!status || !status.executablePath) {
      throw new VisionanceError(CODES.ENGINE_MISSING, { technicalDetails: `no cached status for ${engineId}` });
    }
    return new AiRun({
      bin: status.executablePath,
      args,
      // ncnn tools resolve their default model folder relative to the cwd.
      cwd: status.engineDir,
      watchDir,
      expected,
      control,
      timeoutMs
    });
  }
}

module.exports = { EngineManager, STATUS, ENGINES };
