'use strict';

/**
 * Job persistence.
 *
 * The queue has to survive an application restart, including one caused by a
 * crash in the middle of a write. Three things make that true:
 *
 *   - the index is written to a temp file, fsynced, then renamed over the real
 *     one, so a torn write can never be observed
 *   - the previous good index is kept as `.bak` and used if the current one
 *     fails to parse
 *   - each job also owns a `manifest.json` in its working directory, which is
 *     enough to rebuild the index if both copies are lost
 *
 * On load, anything that claims to still be rendering is a lie - the process
 * that was rendering it is gone. Those become `interrupted`, which is a state
 * the user can act on, rather than a progress bar that will never move.
 */

const fs = require('fs');
const path = require('path');
const { Workspace } = require('./workspace');
const { logger } = require('../logger');

const log = logger.child('jobs');

const STORE_VERSION = 1;

/** States that imply a live process. None of them can survive a restart. */
const ACTIVE_STATES = new Set(['analysing', 'running', 'cancelling']);

class JobStore {
  /**
   * @param {object} o
   *   dir        {string}     directory holding index.json (usually <userData>/jobs)
   *   workspace  {Workspace}  working-directory manager
   *   saveDebounceMs {number}
   */
  constructor({ dir, workspace, saveDebounceMs = 400 }) {
    this.dir = dir;
    this.file = path.join(dir, 'index.json');
    this.backup = path.join(dir, 'index.json.bak');
    this.workspace = workspace instanceof Workspace ? workspace : new Workspace(path.join(dir, 'work'));
    this.records = new Map();
    this.saveDebounceMs = saveDebounceMs;
    this._timer = null;
    this._dirty = false;
  }

  /* ---------------- loading ---------------- */

  /**
   * @returns {{jobs: object[], recovered: object[], warnings: string[]}}
   */
  load() {
    const warnings = [];
    let parsed = this._readIndex(this.file);
    if (!parsed) {
      parsed = this._readIndex(this.backup);
      if (parsed) warnings.push('The job index was damaged; the previous copy was used.');
    }
    if (!parsed) {
      const rebuilt = this._rebuildFromManifests();
      if (rebuilt.length) {
        warnings.push(`Rebuilt ${rebuilt.length} job(s) from their working directories.`);
        parsed = { jobs: rebuilt };
      } else {
        parsed = { jobs: [] };
      }
    }

    const recovered = [];
    for (const raw of parsed.jobs || []) {
      const record = normaliseRecord(raw);
      if (!record) continue;
      if (ACTIVE_STATES.has(record.status)) {
        record.status = 'interrupted';
        record.stageProgress = record.stageProgress || 0;
        record.error = record.error || {
          code: 'INTERRUPTED',
          message: 'Visionance closed while this job was rendering.',
          recoverable: true,
          suggestedAction: 'Resume or retry the job.'
        };
        record.updatedAt = Date.now();
        recovered.push(record);
      }
      this.records.set(record.id, record);
    }

    if (recovered.length) {
      log.warn('recovered interrupted jobs', { count: recovered.length, ids: recovered.map((r) => r.id).join(',') });
      this._dirty = true;
      this.saveNow();
    }

    return { jobs: this.all(), recovered, warnings };
  }

  _readIndex(file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || !Array.isArray(parsed.jobs)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  _rebuildFromManifests() {
    const out = [];
    let entries = [];
    try {
      entries = fs.readdirSync(this.workspace.root, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifest = this.workspace.readManifest(entry.name);
      if (manifest && manifest.id === entry.name) out.push(manifest);
    }
    return out;
  }

  /* ---------------- access ---------------- */

  all() {
    return [...this.records.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  get(id) {
    return this.records.get(id) || null;
  }

  has(id) {
    return this.records.has(id);
  }

  /**
   * @param {object} record
   * @param {object} [opts] { immediate: boolean } - state transitions and
   *   checkpoints are immediate; progress ticks are not.
   */
  upsert(record, opts = {}) {
    record.updatedAt = Date.now();
    this.records.set(record.id, record);
    this._dirty = true;
    if (opts.immediate) this.saveNow();
    else this.saveSoon();
    return record;
  }

  remove(id) {
    const existed = this.records.delete(id);
    if (existed) {
      this._dirty = true;
      this.saveNow();
    }
    return existed;
  }

  /* ---------------- saving ---------------- */

  saveSoon() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.saveNow();
    }, this.saveDebounceMs);
    if (this._timer.unref) this._timer.unref();
  }

  saveNow() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (!this._dirty) return true;
    const payload = {
      storeVersion: STORE_VERSION,
      savedAt: Date.now(),
      jobs: this.all().map(persistable)
    };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (fs.existsSync(this.file)) {
        try { fs.copyFileSync(this.file, this.backup); } catch { /* best effort */ }
      }
      this.workspace.writeJsonAtomic(this.file, payload);
      this._dirty = false;
      return true;
    } catch (err) {
      log.error('index save failed', { error: err.message });
      return false;
    }
  }

  /** Mirror one job into its own working directory (crash-recovery copy). */
  checkpoint(record) {
    try {
      this.workspace.create(record.id);
      this.workspace.writeManifest(record.id, persistable(record));
      return true;
    } catch (err) {
      log.error('checkpoint failed', { job: record.id, error: err.message });
      return false;
    }
  }

  flush() {
    return this.saveNow();
  }
}

/**
 * Strip anything that must not be written to disk.
 * Header tokens are per-run and reference in-memory credentials; persisting one
 * would either be a dangling reference or, worse, a way for stale credentials
 * to be reused. Remote jobs keep the page URL and re-resolve instead.
 */
function persistable(record) {
  const copy = JSON.parse(JSON.stringify(record));
  if (copy.source) {
    delete copy.source.headerToken;
    // Direct CDN URLs expire; keeping them would produce a job that fails in a
    // confusing way rather than one that re-resolves.
    if (copy.source.type === 'remote') {
      copy.source.url = null;
      copy.source.audioUrl = null;
    }
  }
  if (copy.recipe && copy.recipe.source) {
    delete copy.recipe.source.headerToken;
    if (copy.recipe.source.type === 'remote') {
      copy.recipe.source.url = null;
      copy.recipe.source.audioUrl = null;
    }
  }
  delete copy._runtime;
  return copy;
}

/** Defensive load: anything unreadable is skipped rather than crashing boot. */
function normaliseRecord(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  return {
    ...raw,
    progress: Number(raw.progress) || 0,
    stageProgress: Number(raw.stageProgress) || 0,
    stages: Array.isArray(raw.stages) ? raw.stages : [],
    warnings: Array.isArray(raw.warnings) ? raw.warnings : []
  };
}

module.exports = { JobStore, ACTIVE_STATES, persistable, STORE_VERSION };
