'use strict';

/**
 * Engine and runtime downloads.
 *
 * Everything an AI engine needs arrives through here, and the rules are the
 * same for all of it:
 *
 *   - download to a `.part` file, never to the destination
 *   - resume a partial `.part` with a Range request instead of restarting
 *   - verify the published SHA-256 before anything is unpacked or executed
 *   - unpack to a staging directory, then move into place atomically
 *   - a cancelled or failed download leaves no half-installed engine behind
 *
 * A partially downloaded executable is never run. If no trustworthy upstream
 * hash exists for an asset the caller passes `sha256: null` and the size is
 * checked instead - we do not invent hashes.
 *
 * Archive extraction uses tooling every supported OS already ships (bsdtar on
 * Windows 10+, tar/unzip elsewhere) rather than adding an unpacking dependency.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { VisionanceError, CODES } = require('../errors');
const { logger } = require('../logger');

const log = logger.child('download');

const MAX_REDIRECTS = 6;
const EXTRACT_TIMEOUT = 15 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Hashing
 * ------------------------------------------------------------------ */

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (c) => hash.update(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/* ------------------------------------------------------------------ *
 * Download
 * ------------------------------------------------------------------ */

/**
 * @param {object} o
 *   url         {string}
 *   destFile    {string}   final path for the downloaded file
 *   sha256      {string|null}
 *   expectBytes {number|null}
 *   onProgress  {(p:{received,total,fraction,resumed}) => void}
 *   signal      {{cancelled:boolean}} cooperative cancellation
 * @returns {Promise<{path:string, bytes:number, resumed:boolean, sha256:string|null}>}
 */
async function downloadFile({
  url, destFile, sha256 = null, expectBytes = null, onProgress = null, signal = null
}) {
  const part = destFile + '.part';
  fs.mkdirSync(path.dirname(destFile), { recursive: true });

  let startAt = 0;
  try {
    startAt = fs.statSync(part).size;
  } catch { /* no partial download yet */ }

  const result = await fetchToFile({ url, part, startAt, onProgress, signal });

  if (signal && signal.cancelled) {
    // Keep the .part file: the next attempt resumes instead of restarting.
    throw new VisionanceError(CODES.CANCELLED, { message: 'Download cancelled.' });
  }

  const bytes = fs.statSync(part).size;
  if (expectBytes && bytes !== expectBytes) {
    fs.rmSync(part, { force: true });
    throw new VisionanceError(CODES.DOWNLOAD_FAILED, {
      message: 'The download finished at the wrong size and was discarded.',
      technicalDetails: `expected ${expectBytes} bytes, got ${bytes}`
    });
  }

  let digest = null;
  if (sha256) {
    digest = await sha256File(part);
    if (digest.toLowerCase() !== String(sha256).toLowerCase()) {
      // A corrupt partial must not be resumed into the same wrong file forever.
      fs.rmSync(part, { force: true });
      throw new VisionanceError(CODES.CHECKSUM_MISMATCH, {
        technicalDetails: `expected ${sha256}, got ${digest}`
      });
    }
  }

  fs.rmSync(destFile, { force: true });
  fs.renameSync(part, destFile);
  log.info('downloaded', {
    file: path.basename(destFile), bytes, resumed: result.resumed, verified: !!sha256
  });
  return { path: destFile, bytes, resumed: result.resumed, sha256: digest };
}

function fetchToFile({ url, part, startAt, onProgress, signal, redirects = 0 }) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) return reject(new Error('Too many redirects'));

    const headers = { 'User-Agent': 'Visionance' };
    if (startAt > 0) headers.Range = `bytes=${startAt}-`;

    const request = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchToFile({
          url: new URL(res.headers.location, url).toString(),
          part, startAt, onProgress, signal, redirects: redirects + 1
        }));
      }

      // 416 means the .part is already the whole file (or the server changed).
      if (res.statusCode === 416 && startAt > 0) {
        res.resume();
        return resolve({ resumed: true });
      }

      if (startAt > 0 && res.statusCode === 200) {
        // Server ignored the Range header; start over rather than append.
        res.resume();
        try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
        return resolve(fetchToFile({ url, part, startAt: 0, onProgress, signal, redirects }));
      }

      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        return reject(new VisionanceError(CODES.DOWNLOAD_FAILED, {
          technicalDetails: `HTTP ${res.statusCode} for ${url}`
        }));
      }

      const resumed = res.statusCode === 206;
      const chunkTotal = Number(res.headers['content-length'] || 0);
      const total = chunkTotal ? chunkTotal + (resumed ? startAt : 0) : 0;
      let received = resumed ? startAt : 0;

      const file = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' });
      let settled = false;
      const bail = (err) => {
        if (settled) return;
        settled = true;
        try { res.destroy(); } catch { /* ignore */ }
        file.close(() => reject(err));
      };

      res.on('data', (chunk) => {
        received += chunk.length;
        if (signal && signal.cancelled) {
          if (settled) return;
          settled = true;
          try { res.destroy(); } catch { /* ignore */ }
          file.end(() => resolve({ resumed }));
          return;
        }
        if (onProgress && total) {
          onProgress({ received, total, fraction: Math.min(1, received / total), resumed });
        }
      });
      res.on('error', bail);
      file.on('error', (err) => {
        bail(new VisionanceError(
          err.code === 'ENOSPC' ? CODES.DISK_FULL : CODES.DOWNLOAD_FAILED,
          { technicalDetails: err.message }
        ));
      });
      res.pipe(file);
      file.on('finish', () => {
        if (settled) return;
        settled = true;
        file.close(() => resolve({ resumed }));
      });
    });

    request.on('error', (err) => reject(new VisionanceError(CODES.DOWNLOAD_FAILED, {
      technicalDetails: err.message
    })));
    request.setTimeout(60000, () => {
      request.destroy(new Error('Connection timed out'));
    });
  });
}

/* ------------------------------------------------------------------ *
 * Extraction
 * ------------------------------------------------------------------ */

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: EXTRACT_TIMEOUT, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err });
    });
  });
}

/**
 * Unpack an archive using whatever the OS already provides.
 * Windows 10+ ships bsdtar as `tar`, which handles zip as well as tar.
 */
async function extractArchive(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const lower = archive.toLowerCase();

  const attempts = [];
  if (lower.endsWith('.zip')) {
    attempts.push(['tar', ['-xf', archive, '-C', destDir]]);
    if (process.platform === 'win32') {
      attempts.push([
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command',
          `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`]
      ]);
    } else {
      attempts.push(['unzip', ['-o', '-q', archive, '-d', destDir]]);
    }
  } else {
    attempts.push(['tar', ['-xf', archive, '-C', destDir]]);
  }

  let lastError = null;
  for (const [cmd, args] of attempts) {
    // eslint-disable-next-line no-await-in-loop -- fallbacks are sequential
    const res = await run(cmd, args);
    if (res.ok) return destDir;
    lastError = `${cmd}: ${(res.stderr || res.err.message || '').slice(0, 300)}`;
  }

  throw new VisionanceError(CODES.ENGINE_INSTALL_FAILED, {
    message: 'The downloaded archive could not be unpacked.',
    technicalDetails: lastError
  });
}

/**
 * Download, verify, unpack, and move into place as one operation.
 *
 * The destination only ever sees a fully verified, fully extracted tree: work
 * happens in a staging directory and is swapped in at the end, so an interrupted
 * install cannot leave a half-populated engine folder that later looks valid.
 */
async function downloadAndExtract({
  url, sha256 = null, expectBytes = null, destDir, tmpDir, onProgress = null, signal = null, label = 'archive'
}) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const archiveName = path.basename(new URL(url).pathname) || 'download.bin';
  const archivePath = path.join(tmpDir, archiveName);

  await downloadFile({
    url,
    destFile: archivePath,
    sha256,
    expectBytes,
    signal,
    onProgress: onProgress
      ? (p) => onProgress({ phase: 'download', label, ...p })
      : null
  });

  if (signal && signal.cancelled) throw new VisionanceError(CODES.CANCELLED);

  if (onProgress) onProgress({ phase: 'extract', label, fraction: 0 });
  const staging = path.join(tmpDir, `stage-${Date.now().toString(36)}`);
  fs.rmSync(staging, { recursive: true, force: true });
  await extractArchive(archivePath, staging);

  if (signal && signal.cancelled) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new VisionanceError(CODES.CANCELLED);
  }

  // Most release archives wrap everything in a single top-level folder; lift it
  // so callers get a predictable layout.
  const entries = fs.readdirSync(staging, { withFileTypes: true });
  const root = entries.length === 1 && entries[0].isDirectory()
    ? path.join(staging, entries[0].name)
    : staging;

  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  fs.rmSync(destDir, { recursive: true, force: true });
  try {
    fs.renameSync(root, destDir);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    copyTree(root, destDir);
    fs.rmSync(root, { recursive: true, force: true });
  }

  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(archivePath, { force: true });
  if (onProgress) onProgress({ phase: 'done', label, fraction: 1 });
  return destDir;
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

/** Free space on the volume holding `dir`, or null if it cannot be read. */
function freeSpaceBytes(dir) {
  try {
    const stat = fs.statfsSync(dir);
    return stat.bavail * stat.bsize;
  } catch {
    return null;
  }
}

module.exports = {
  downloadFile,
  downloadAndExtract,
  extractArchive,
  sha256File,
  freeSpaceBytes,
  copyTree
};
