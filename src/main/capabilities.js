'use strict';

/**
 * What this machine can actually do.
 *
 * Used to pick encoders, to decide whether a filter the recipe wants exists in
 * this ffmpeg build, and to tell the user why something is unavailable. Every
 * probe is allowed to fail: `null`/`unknown` is a legitimate answer and never
 * blocks a render. Nothing here may assume a vendor - the app must work on a
 * laptop with no discrete GPU at all.
 */

const os = require('os');
const { execFile } = require('child_process');
const { detectEncoders } = require('./ffmpeg/encoders');
const { logger } = require('./logger');

const log = logger.child('caps');
const CACHE_TTL = 60 * 1000;

let cache = null;

function run(bin, args, timeout = 15000) {
  return new Promise((resolve) => {
    if (!bin) return resolve(null);
    execFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !stdout && !stderr) return resolve(null);
      resolve(String(stdout || '') + String(stderr || ''));
    });
  });
}

/** Filters this ffmpeg build advertises. Used to degrade gracefully. */
async function detectFilters(ffmpegBin) {
  const text = await run(ffmpegBin, ['-hide_banner', '-filters']);
  const set = new Set();
  if (!text) return set;
  for (const line of text.split('\n')) {
    // " TSC hqdn3d   V->V   Apply a High Quality 3D Denoiser."
    const m = /^\s*[TSC.]{1,4}\s+([A-Za-z0-9_]+)\s+/.exec(line);
    if (m) set.add(m[1]);
  }
  return set;
}

async function detectHwaccels(ffmpegBin) {
  const text = await run(ffmpegBin, ['-hide_banner', '-hwaccels']);
  if (!text) return [];
  return text
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !/hardware acceleration methods/i.test(l));
}

async function ffmpegVersion(bin) {
  const text = await run(bin, ['-version'], 10000);
  if (!text) return null;
  const first = text.split('\n')[0].trim();
  const m = /ffmpeg version (\S+)/i.exec(first);
  return m ? m[1] : first || null;
}

/* ------------------------------------------------------------------ *
 * GPU
 * ------------------------------------------------------------------ */

/**
 * Best-effort GPU inventory from the platform's own tooling.
 * Deliberately fragile-tolerant: any failure yields an empty list, and the app
 * carries on. Vendor strings are normalised only when they are unambiguous.
 */
async function detectGpus() {
  try {
    if (process.platform === 'win32') return await windowsGpus();
    if (process.platform === 'darwin') return await macGpus();
    return await linuxGpus();
  } catch (err) {
    log.debug('gpu detection failed', { error: err.message });
    return [];
  }
}

function vendorOf(name) {
  const n = String(name || '').toLowerCase();
  if (/nvidia|geforce|quadro|rtx|gtx|tesla/.test(n)) return 'nvidia';
  if (/amd|radeon|rx \d|firepro|vega/.test(n)) return 'amd';
  if (/intel|iris|uhd graphics|hd graphics|arc /.test(n)) return 'intel';
  if (/apple m\d/.test(n)) return 'apple';
  return 'unknown';
}

async function windowsGpus() {
  const out = await run(
    'powershell',
    [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion,VideoProcessor | ConvertTo-Json -Compress'
    ],
    12000
  );
  if (!out) return [];
  let parsed;
  try {
    parsed = JSON.parse(out.trim());
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.filter(Boolean).map((g) => ({
    name: g.Name || null,
    vendor: vendorOf(g.Name),
    // AdapterRAM is a 32-bit field, so anything past 4 GB reads back wrong.
    // Reporting a number we know is unreliable is worse than reporting none.
    vramBytes: typeof g.AdapterRAM === 'number' && g.AdapterRAM > 0 && g.AdapterRAM < 4294967295
      ? g.AdapterRAM
      : null,
    vramReliable: false,
    driver: g.DriverVersion || null
  }));
}

async function macGpus() {
  const out = await run('/usr/sbin/system_profiler', ['SPDisplaysDataType', '-json'], 12000);
  if (!out) return [];
  try {
    const parsed = JSON.parse(out);
    return (parsed.SPDisplaysDataType || []).map((g) => ({
      name: g.sppci_model || null,
      vendor: vendorOf(g.sppci_model),
      vramBytes: null,
      vramReliable: false,
      driver: null
    }));
  } catch {
    return [];
  }
}

async function linuxGpus() {
  const out = await run('lspci', ['-mm'], 8000);
  if (!out) return [];
  return out
    .split('\n')
    .filter((l) => /"(VGA compatible controller|3D controller|Display controller)"/i.test(l))
    .map((l) => {
      const fields = l.match(/"([^"]*)"/g) || [];
      const name = fields.slice(2, 4).map((f) => f.replace(/"/g, '')).join(' ').trim();
      return { name: name || null, vendor: vendorOf(name), vramBytes: null, vramReliable: false, driver: null };
    });
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

/**
 * @param {object} o
 *   bins        {{ffmpeg,ffprobe,ytdlp}}
 *   ytdlp       capability object from ytdlp.capabilities() (optional)
 *   versions    {{electron,chrome,node}} (optional, from the host process)
 *   gpuInfo     electron app.getGPUInfo('basic') result (optional)
 *   force       bypass the cache
 */
async function report({ bins = {}, ytdlp = null, versions = {}, gpuInfo = null, force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL) return cache.value;

  const [ffVersion, encoders, filters, hwaccels, gpus] = await Promise.all([
    ffmpegVersion(bins.ffmpeg),
    detectEncoders(bins.ffmpeg),
    detectFilters(bins.ffmpeg),
    detectHwaccels(bins.ffmpeg),
    detectGpus()
  ]);

  // Electron's own view of the GPU is a useful cross-check and works where the
  // platform command does not.
  let electronGpu = null;
  if (gpuInfo && gpuInfo.gpuDevice && gpuInfo.gpuDevice.length) {
    electronGpu = gpuInfo.gpuDevice.map((d) => ({
      vendorId: d.vendorId ?? null,
      deviceId: d.deviceId ?? null,
      active: !!d.active
    }));
  }

  const cpus = os.cpus() || [];
  const value = {
    generatedAt: Date.now(),
    os: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      version: typeof os.version === 'function' ? os.version() : null
    },
    cpu: {
      model: cpus[0] ? cpus[0].model.trim() : null,
      cores: cpus.length || null,
      speedMHz: cpus[0] ? cpus[0].speed : null
    },
    memory: {
      totalBytes: os.totalmem(),
      freeBytes: os.freemem()
    },
    runtime: {
      node: versions.node || process.versions.node,
      electron: versions.electron || null,
      chrome: versions.chrome || null,
      v8: process.versions.v8
    },
    ffmpeg: {
      path: bins.ffmpeg || null,
      version: ffVersion,
      available: !!bins.ffmpeg && !!ffVersion,
      encoders,
      hardwareEncoders: encoders.filter((e) => e.hardware),
      hwaccels,
      filterCount: filters.size,
      // The specific filters the recipe compiler can ask for.
      filters: [
        'hqdn3d', 'deblock', 'deband', 'noise', 'unsharp', 'eq', 'scale', 'crop',
        'pad', 'gblur', 'overlay', 'split', 'fps', 'framerate', 'minterpolate',
        'yadif', 'bwdif', 'zscale', 'tonemap', 'loudnorm', 'aresample'
      ].reduce((acc, name) => {
        acc[name] = filters.has(name);
        return acc;
      }, {})
    },
    ffprobe: {
      path: bins.ffprobe || null,
      available: !!bins.ffprobe
    },
    ytdlp: ytdlp
      ? {
        path: bins.ytdlp || null,
        available: !!ytdlp.available,
        version: ytdlp.version || null,
        ageDays: ytdlp.ageDays ?? null,
        stale: !!ytdlp.stale,
        supportsCookiesFromBrowser: !!ytdlp.supportsCookiesFromBrowser,
        supportsCookiesFile: !!ytdlp.supportsCookiesFile,
        jsRuntimes: (ytdlp.jsRuntimes || []).map((r) => ({ name: r.name, source: r.source })),
        jsRuntimeConfig: ytdlp.jsRuntimeFlag ? ytdlp.jsRuntimeFlag.flag : null,
        supportsJsRuntimeConfig: !!ytdlp.supportsJsRuntimeConfig
      }
      : { path: bins.ytdlp || null, available: !!bins.ytdlp, version: null },
    gpus,
    electronGpu,
    // A best guess only. Session 2's neural stages must size their tiles from a
    // real allocation probe, not from this.
    primaryGpuVendor: gpus.length ? (gpus.find((g) => g.vendor !== 'unknown') || gpus[0]).vendor : 'unknown',
    // Everything below is exposed so nothing downstream needs to re-probe.
    _filterSet: filters
  };

  cache = { at: Date.now(), value };
  log.info('capabilities', {
    ffmpeg: value.ffmpeg.version || 'missing',
    hwEncoders: value.ffmpeg.hardwareEncoders.map((e) => e.id).join(',') || 'none',
    gpus: gpus.map((g) => g.vendor).join(',') || 'unknown',
    ytdlp: value.ytdlp.version || 'missing'
  });
  return value;
}

/** IPC-safe projection: no Sets, no giant blobs. */
function serialisable(rep) {
  if (!rep) return null;
  const { _filterSet, ...rest } = rep;
  return rest;
}

function invalidate() {
  cache = null;
}

module.exports = { report, serialisable, invalidate, detectFilters, detectHwaccels, detectGpus, vendorOf };
