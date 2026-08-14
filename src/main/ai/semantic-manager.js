'use strict';

/**
 * Managing the two semantic models.
 *
 * Deliberately *not* folded into `engine-manager.js`. That manager exists for
 * downloadable executables: it unpacks archives, probes for a Vulkan device and
 * refuses to call an engine `ready` without one. The semantic layer has no
 * executable and no Vulkan requirement - it is four megabytes of ONNX weights
 * executed by a runtime that is an ordinary npm dependency - so forcing it
 * through that shape would mean weakening the checks Real-ESRGAN and RIFE rely
 * on. It reuses the parts that genuinely apply: the resumable, atomic
 * downloader.
 *
 * States mirror the engine manager so the UI can treat them alike:
 *   not-installed -> installing -> ready | broken
 */

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const semantic = require('./engines/semantic');
const { downloadFile } = require('./downloads');
const { VisionanceError, CODES } = require('../errors');
const { logger } = require('../logger');

const log = logger.child('semantic');

const STATUS = {
  NOT_INSTALLED: 'not-installed',
  INSTALLING: 'installing',
  READY: 'ready',
  BROKEN: 'broken'
};

class SemanticManager extends EventEmitter {
  /** @param {object} o { rootDir } - usually <userData>/engines */
  constructor({ rootDir }) {
    super();
    this.rootDir = rootDir;
    this.install = null;
  }

  dir() {
    return path.join(this.rootDir, semantic.ID);
  }

  modelsDir() {
    return path.join(this.dir(), 'models');
  }

  /**
   * Where the analyser should look, or null if it should not bother.
   * The single question the job path asks.
   */
  readyModelsDir() {
    return this.status().status === STATUS.READY ? this.modelsDir() : null;
  }

  status() {
    const dir = this.modelsDir();
    const models = semantic.MODELS.map((m) => {
      const file = path.join(dir, m.file);
      let bytes = 0;
      try { bytes = fs.statSync(file).size; } catch { /* absent */ }
      return {
        id: m.id,
        label: m.label,
        license: m.license,
        expectedBytes: m.bytes,
        bytes,
        // A truncated download is worse than a missing one: it would load and
        // then fail at inference time, inside a render.
        present: bytes > 0 && bytes === m.bytes,
        truncated: bytes > 0 && bytes !== m.bytes
      };
    });

    // The runtime question is answered by trying to load it, not by looking
    // for a folder: a native binding can be present and still refuse to load.
    let runtime = { ok: false, error: 'not checked' };
    try {
      // eslint-disable-next-line global-require
      runtime = require('./detector').loadRuntime();
    } catch (err) {
      runtime = { ok: false, error: err.message };
    }

    const missing = models.filter((m) => !m.present);
    let state;
    if (this.install) state = STATUS.INSTALLING;
    else if (!runtime.ok) state = STATUS.BROKEN;
    else if (missing.length === 0) state = STATUS.READY;
    else if (models.some((m) => m.truncated)) state = STATUS.BROKEN;
    else state = STATUS.NOT_INSTALLED;

    return {
      id: semantic.ID,
      label: 'Face & person detection',
      status: state,
      runtime: {
        available: runtime.ok,
        error: runtime.ok ? null : runtime.error,
        package: semantic.RUNTIME.package,
        provider: 'cpu'
      },
      models,
      totalBytes: semantic.TOTAL_BYTES,
      license: semantic.LICENSE,
      // Said plainly so the UI never has to guess why a control is disabled.
      detail: state === STATUS.READY
        ? 'Face and person tracking is available for Smart Reframe.'
        : state === STATUS.BROKEN && !runtime.ok
          ? `The detection runtime could not be loaded (${runtime.error}). Smart Reframe will use motion and detail tracking.`
          : state === STATUS.BROKEN
            ? 'A model file is incomplete. Reinstall to repair it.'
            : 'Not installed. Smart Reframe will use motion and detail tracking until it is.'
    };
  }

  /**
   * Download both models. Resumable, atomic, cancellable.
   * @param {(progress:object) => void} onProgress
   */
  async installModels(onProgress = null) {
    if (this.install) return this.install.promise;

    const control = { cancelled: false };
    const dir = this.modelsDir();
    fs.mkdirSync(dir, { recursive: true });

    const total = semantic.TOTAL_BYTES;
    let completed = 0;

    const promise = (async () => {
      for (const model of semantic.MODELS) {
        const dest = path.join(dir, model.file);
        if (fs.existsSync(dest) && fs.statSync(dest).size === model.bytes) {
          completed += model.bytes;
          continue;
        }
        log.info('downloading model', { id: model.id, bytes: model.bytes });
        await downloadFile({
          url: model.url,
          destFile: dest,
          // OpenCV Zoo publishes no per-asset digest, so the size is checked
          // and no hash is invented. Same policy as the ncnn engines.
          expectBytes: model.bytes,
          sha256: model.sha256,
          signal: control,
          onProgress: (p) => {
            if (!onProgress) return;
            const received = p && p.received ? p.received : 0;
            onProgress({
              id: model.id,
              label: model.label,
              fraction: Math.min(1, (completed + received) / total),
              receivedBytes: completed + received,
              totalBytes: total
            });
          }
        });
        completed += model.bytes;
      }
    })()
      .then(() => {
        this.install = null;
        const status = this.status();
        this.emit('status', status);
        log.info('semantic models installed', { status: status.status });
        return status;
      })
      .catch((err) => {
        this.install = null;
        this.emit('status', this.status());
        throw err;
      });

    this.install = { control, promise };
    this.emit('status', this.status());
    return promise;
  }

  cancelInstall() {
    if (!this.install) return false;
    this.install.control.cancelled = true;
    return true;
  }

  remove() {
    if (this.install) {
      throw new VisionanceError(CODES.INVALID_REQUEST, {
        message: 'This download is still running. Cancel it first.'
      });
    }
    try {
      fs.rmSync(this.dir(), { recursive: true, force: true });
    } catch (err) {
      throw new VisionanceError(CODES.INVALID_REQUEST, {
        message: 'The models could not be removed.',
        technicalDetails: err.message
      });
    }
    const status = this.status();
    this.emit('status', status);
    return status;
  }
}

module.exports = { SemanticManager, STATUS };
