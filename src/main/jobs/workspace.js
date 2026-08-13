'use strict';

/**
 * Per-job working directories.
 *
 * Every job gets one directory with a deterministic layout, so a crashed run
 * can be understood - and cleaned up - by looking at the filesystem alone:
 *
 *   <root>/<jobId>/
 *     manifest.json      the job record as of the last checkpoint
 *     chunks/            chunk_0000.mp4, chunk_0001.mp4, …
 *     chunks/list.txt    concat demuxer input, rewritten each mux
 *     tmp/               scratch for stages that need an intermediate file
 *     job.log            ffmpeg stderr and stage notes for this job only
 *
 * Nothing outside <root> is ever written or deleted: job ids are validated
 * against a strict pattern and every path is re-checked after joining.
 */

const fs = require('fs');
const path = require('path');
const { VisionanceError, CODES } = require('../errors');

const JOB_ID_RE = /^job_[0-9a-z]{4,40}$/;

function assertJobId(jobId) {
  if (!JOB_ID_RE.test(String(jobId || ''))) {
    throw new VisionanceError(CODES.INVALID_REQUEST, {
      message: 'Invalid job identifier.',
      technicalDetails: `job id rejected: ${jobId}`
    });
  }
}

class Workspace {
  /** @param {string} root absolute path of the working-directory root */
  constructor(root) {
    if (!root || !path.isAbsolute(root)) {
      throw new VisionanceError(CODES.WORKSPACE_ERROR, {
        message: 'Visionance needs an absolute path for its working folder.',
        technicalDetails: `root=${root}`
      });
    }
    this.root = path.normalize(root);
  }

  ensureRoot() {
    fs.mkdirSync(this.root, { recursive: true });
    return this.root;
  }

  /** Absolute path inside a job directory, guaranteed to stay inside it. */
  resolve(jobId, ...parts) {
    assertJobId(jobId);
    const base = path.join(this.root, jobId);
    const target = path.normalize(path.join(base, ...parts));
    if (target !== base && !target.startsWith(base + path.sep)) {
      throw new VisionanceError(CODES.INVALID_REQUEST, {
        message: 'Refused a path outside the job workspace.',
        technicalDetails: `escape attempt: ${parts.join('/')}`
      });
    }
    return target;
  }

  dirFor(jobId) {
    return this.resolve(jobId);
  }

  create(jobId) {
    const dir = this.dirFor(jobId);
    fs.mkdirSync(path.join(dir, 'chunks'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
    return dir;
  }

  exists(jobId) {
    try {
      return fs.statSync(this.dirFor(jobId)).isDirectory();
    } catch {
      return false;
    }
  }

  manifestPath(jobId) { return this.resolve(jobId, 'manifest.json'); }
  logPath(jobId) { return this.resolve(jobId, 'job.log'); }
  chunkDir(jobId) { return this.resolve(jobId, 'chunks'); }
  chunkPath(jobId, index, ext = 'mp4') {
    return this.resolve(jobId, 'chunks', `chunk_${String(index).padStart(4, '0')}.${ext}`);
  }
  concatListPath(jobId) { return this.resolve(jobId, 'chunks', 'list.txt'); }
  tmpPath(jobId, name) { return this.resolve(jobId, 'tmp', String(name).replace(/[^\w.-]+/g, '_')); }

  /** Write JSON so a crash mid-write cannot destroy the previous copy. */
  writeJsonAtomic(file, data) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const payload = JSON.stringify(data, null, 2);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, payload, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  }

  writeManifest(jobId, record) {
    this.writeJsonAtomic(this.manifestPath(jobId), record);
  }

  readManifest(jobId) {
    try {
      return JSON.parse(fs.readFileSync(this.manifestPath(jobId), 'utf8'));
    } catch {
      return null;
    }
  }

  appendLog(jobId, text) {
    if (!text) return;
    try {
      fs.mkdirSync(this.dirFor(jobId), { recursive: true });
      fs.appendFileSync(this.logPath(jobId), `${new Date().toISOString()} ${text}\n`, 'utf8');
    } catch { /* logging must not break a render */ }
  }

  /** Chunk files present on disk right now, as a set of indices. */
  existingChunks(jobId, ext = 'mp4') {
    try {
      return new Set(
        fs.readdirSync(this.chunkDir(jobId))
          .map((name) => /^chunk_(\d{4})\.(\w+)$/.exec(name))
          .filter((m) => m && m[2] === ext)
          .map((m) => Number(m[1]))
      );
    } catch {
      return new Set();
    }
  }

  /** Remove scratch but keep chunks, so a paused job can still resume. */
  cleanTemp(jobId) {
    const tmp = this.resolve(jobId, 'tmp');
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
    } catch { /* best effort */ }
  }

  /** Remove everything for a job. Only ever called with a validated id. */
  destroy(jobId) {
    const dir = this.dirFor(jobId);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Directories with no matching job record - left behind by a hard crash. */
  orphans(knownIds) {
    const known = new Set(knownIds || []);
    let entries = [];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && JOB_ID_RE.test(e.name) && !known.has(e.name))
      .map((e) => e.name);
  }

  sizeOf(jobId) {
    let total = 0;
    const walk = (dir) => {
      let items;
      try {
        items = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        const p = path.join(dir, item.name);
        if (item.isDirectory()) walk(p);
        else {
          try { total += fs.statSync(p).size; } catch { /* vanished */ }
        }
      }
    };
    walk(this.dirFor(jobId));
    return total;
  }
}

module.exports = { Workspace, assertJobId, JOB_ID_RE };
