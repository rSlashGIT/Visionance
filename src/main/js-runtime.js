'use strict';

/**
 * JavaScript runtime discovery for yt-dlp.
 *
 * Modern yt-dlp needs an external JavaScript runtime to solve YouTube's player
 * challenge. Without one it prints
 *
 *   "No supported JavaScript runtime could be found. Only deno is enabled by
 *    default; to use another runtime add --js-runtimes RUNTIME[:PATH]"
 *
 * and falls back to a degraded extraction that returns few or no playable
 * formats. That was the real cause of "This source is not supported".
 *
 * Three rules here:
 *
 *   1. **Validate by executing.** A path existing is not evidence that it is a
 *      working runtime. Every candidate is run and its output checked. In
 *      particular `process.execPath` is Electron, not Node - it only counts as
 *      a Node runtime if it actually answers like one, which requires
 *      ELECTRON_RUN_AS_NODE and is therefore verified, not assumed.
 *   2. **Carry the environment with the runtime.** A candidate that needs an
 *      env var to behave as Node reports that env, and it is applied to the
 *      yt-dlp child so the runtime yt-dlp spawns inherits it.
 *   3. **Managed runtimes live in userData**, never in the repository, and are
 *      only used after the same validation as everything else.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { VisionanceError, CODES } = require('./errors');
const { logger } = require('./logger');

const log = logger.child('jsruntime');

const IS_WIN = process.platform === 'win32';
const VALIDATE_TIMEOUT = 10000;

/**
 * yt-dlp's own priority order, highest first. We report candidates in this
 * order so the runtime we hand over is the one yt-dlp would prefer anyway.
 */
const RUNTIME_PRIORITY = ['deno', 'node', 'quickjs', 'bun'];

/** Executable base names per runtime. `quickjs` ships as `qjs`. */
const RUNTIME_BINARIES = {
  deno: ['deno'],
  node: ['node'],
  bun: ['bun'],
  quickjs: ['qjs', 'quickjs']
};

/** What a working runtime's `--version` output has to look like. */
const VERSION_PATTERNS = {
  deno: /^deno\s+\d+\.\d+/im,
  node: /^v?\d+\.\d+\.\d+/m,
  bun: /^\d+\.\d+\.\d+/m,
  quickjs: /quickjs|^\d+\.\d+/im
};

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

function isFile(p) {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Every match for `name` on PATH, not just the first. */
function searchPath(name) {
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const found = [];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      if (isFile(candidate) && !found.includes(candidate)) found.push(candidate);
    }
  }
  return found;
}

/** Where managed runtimes are unpacked. Never inside the repository. */
function managedDir(userDataDir) {
  return path.join(userDataDir, 'runtimes');
}

function managedNodePath(userDataDir) {
  const dir = path.join(managedDir(userDataDir), 'node');
  if (!fs.existsSync(dir)) return null;
  // node-vX-win-x64/node.exe, or a flattened layout.
  const direct = path.join(dir, IS_WIN ? 'node.exe' : 'bin/node');
  if (isFile(direct)) return direct;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = path.join(dir, entry.name, IS_WIN ? 'node.exe' : 'bin/node');
    if (isFile(nested)) return nested;
  }
  return null;
}

/**
 * Candidate runtimes, before validation.
 * @param {object} opts { userDataDir, electronPath }
 */
function candidates(opts = {}) {
  const out = [];
  const add = (runtime, binPath, source, env) => {
    if (!binPath || out.some((c) => c.path === binPath && c.runtime === runtime)) return;
    out.push({ runtime, path: binPath, source, env: env || null });
  };

  for (const runtime of RUNTIME_PRIORITY) {
    for (const base of RUNTIME_BINARIES[runtime]) {
      for (const found of searchPath(base)) add(runtime, found, 'path');
    }
  }

  if (opts.userDataDir) {
    add('node', managedNodePath(opts.userDataDir), 'managed');
  }

  // Electron can behave as Node, but only with this environment variable, and
  // only if it actually answers - which validate() checks by running it.
  const electron = opts.electronPath || process.execPath;
  if (electron && isFile(electron)) {
    add('node', electron, 'electron', { ELECTRON_RUN_AS_NODE: '1' });
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/**
 * Run the candidate and check it answers like the runtime it claims to be.
 * @returns {Promise<{ok:boolean, version:string|null, error:string|null}>}
 */
function validate(candidate) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...(candidate.env || {}) };
    try {
      execFile(
        candidate.path,
        ['--version'],
        { timeout: VALIDATE_TIMEOUT, windowsHide: true, env },
        (err, stdout, stderr) => {
          const text = `${stdout || ''}${stderr || ''}`.trim();
          if (err && !text) {
            return resolve({ ok: false, version: null, error: err.message });
          }
          const pattern = VERSION_PATTERNS[candidate.runtime];
          if (pattern && !pattern.test(text)) {
            return resolve({
              ok: false,
              version: null,
              error: `unexpected --version output: ${text.slice(0, 120)}`
            });
          }
          resolve({ ok: true, version: text.split('\n')[0].trim(), error: null });
        }
      );
    } catch (err) {
      // Windows throws EFTYPE synchronously when asked to execute something
      // that is not a program. Rejecting a candidate is this function's job, so
      // it must answer rather than throw.
      resolve({ ok: false, version: null, error: err.message });
    }
  });
}

const discoveryCache = new Map();
const CACHE_TTL = 60 * 1000;

/**
 * Discover and validate every available runtime, best first.
 *
 * @param {object} opts { userDataDir, electronPath, force }
 * @returns {Promise<Array<{runtime,path,source,env,version,ok}>>}
 */
async function discover(opts = {}) {
  const key = `${opts.userDataDir || ''}|${opts.electronPath || ''}`;
  const cached = discoveryCache.get(key);
  if (!opts.force && cached && Date.now() - cached.at < CACHE_TTL) return cached.value;

  const results = [];
  for (const candidate of candidates(opts)) {
    // eslint-disable-next-line no-await-in-loop -- candidates are few and each
    // spawns a process; running them in parallel buys nothing and costs noise.
    const check = await validate(candidate);
    results.push({ ...candidate, ok: check.ok, version: check.version, error: check.error });
  }

  const working = results.filter((r) => r.ok);
  working.sort((a, b) => {
    const byRuntime = RUNTIME_PRIORITY.indexOf(a.runtime) - RUNTIME_PRIORITY.indexOf(b.runtime);
    if (byRuntime !== 0) return byRuntime;
    // A real standalone binary is preferable to Electron wearing a Node hat.
    const rank = { path: 0, managed: 1, electron: 2 };
    return (rank[a.source] ?? 9) - (rank[b.source] ?? 9);
  });

  discoveryCache.set(key, { at: Date.now(), value: working });
  log.info('runtimes discovered', {
    found: working.map((r) => `${r.runtime}:${r.source}`).join(',') || 'none',
    rejected: results.filter((r) => !r.ok).length
  });
  return working;
}

function invalidate() {
  discoveryCache.clear();
}

/** The runtime we would hand to yt-dlp, or null. */
async function best(opts = {}) {
  const all = await discover(opts);
  return all[0] || null;
}

/* ------------------------------------------------------------------ *
 * Managed Node install
 * ------------------------------------------------------------------ */

const NODE_DIST = 'https://nodejs.org/dist';
/** A current LTS. Pinned so an install is reproducible and hash-checkable. */
const MANAGED_NODE_VERSION = 'v22.14.0';

function nodeArchiveName(version) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (IS_WIN) return `node-${version}-win-${arch}.zip`;
  if (process.platform === 'darwin') return `node-${version}-darwin-${arch}.tar.gz`;
  return `node-${version}-linux-${arch}.tar.gz`;
}

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'Visionance' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchText(res.headers.location, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

/**
 * Install a managed Node runtime under userData.
 *
 * Only reached when no runtime could be found at all, which in practice means a
 * packaged build on a machine with no Node installed. The archive is verified
 * against nodejs.org's own published SHASUMS256.txt - a real upstream hash, not
 * one invented here - and is never executed before that check passes.
 *
 * @param {object} o { userDataDir, onProgress, signal }
 */
async function installManagedNode({ userDataDir, onProgress = null, signal = null } = {}) {
  if (!userDataDir) {
    throw new VisionanceError(CODES.INVALID_REQUEST, { message: 'No user data directory given.' });
  }
  const downloads = require('./ai/downloads');

  const version = MANAGED_NODE_VERSION;
  const archive = nodeArchiveName(version);
  const url = `${NODE_DIST}/${version}/${archive}`;

  let expectedSha = null;
  try {
    const shasums = await fetchText(`${NODE_DIST}/${version}/SHASUMS256.txt`);
    const line = shasums.split('\n').find((l) => l.trim().endsWith(archive));
    if (line) expectedSha = line.trim().split(/\s+/)[0];
  } catch (err) {
    log.warn('could not fetch node SHASUMS256', { error: err.message });
  }
  if (!expectedSha) {
    throw new VisionanceError(CODES.ENGINE_INSTALL_FAILED, {
      message: 'Could not verify the Node runtime download, so it was not installed.',
      technicalDetails: `no SHA256 published for ${archive}`
    });
  }

  const target = path.join(managedDir(userDataDir), 'node');
  fs.mkdirSync(target, { recursive: true });

  await downloads.downloadAndExtract({
    url,
    sha256: expectedSha,
    destDir: target,
    tmpDir: path.join(managedDir(userDataDir), '.tmp'),
    onProgress,
    signal,
    label: `Node ${version}`
  });

  invalidate();
  const installed = managedNodePath(userDataDir);
  if (!installed) {
    throw new VisionanceError(CODES.ENGINE_INSTALL_FAILED, {
      message: 'The Node runtime archive unpacked but no executable was found in it.'
    });
  }
  const check = await validate({ runtime: 'node', path: installed, env: null });
  if (!check.ok) {
    throw new VisionanceError(CODES.ENGINE_BROKEN, {
      message: 'The installed Node runtime does not run on this machine.',
      technicalDetails: check.error
    });
  }
  log.info('managed node installed', { version: check.version, path: installed });
  return { runtime: 'node', path: installed, source: 'managed', version: check.version, ok: true };
}

/** sha256 of a file, used by the download helper and by tests. */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (c) => hash.update(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

module.exports = {
  RUNTIME_PRIORITY,
  discover,
  validate,
  candidates,
  best,
  invalidate,
  installManagedNode,
  managedDir,
  managedNodePath,
  sha256File,
  searchPath,
  MANAGED_NODE_VERSION,
  tmpdir: os.tmpdir
};
