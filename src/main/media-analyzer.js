'use strict';

/**
 * Source analysis.
 *
 * One place that knows how to ask ffprobe what a file or stream actually is,
 * and one normalised shape that everything downstream consumes. Nothing else in
 * the codebase should call ffprobe directly or re-derive frame rates.
 *
 * Two rules:
 *   1. Unknown stays unknown. If ffprobe does not report a value, the field is
 *      null - never a guess dressed up as a measurement.
 *   2. Raw probe output and derived values live in separate branches, so a
 *      consumer can always tell what was measured from what was inferred.
 *
 * Electron-free on purpose: unit-testable as a plain Node module.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { VisionanceError, CODES, redactHeaders } = require('./errors');

const SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT = 30000;
const DEEP_TIMEOUT = 45000;

/* ------------------------------------------------------------------ *
 * ffprobe invocation
 * ------------------------------------------------------------------ */

function runFfprobe(bin, args, timeout) {
  return new Promise((resolve, reject) => {
    if (!bin) return reject(new VisionanceError(CODES.FFPROBE_MISSING));
    execFile(
      bin,
      args,
      { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message || '').trim();
          if (err.killed || /ETIMEDOUT/i.test(String(err.code))) {
            return reject(new VisionanceError(CODES.NETWORK_TIMEOUT, {
              message: 'Timed out while analysing the source.',
              technicalDetails: detail
            }));
          }
          return reject(new VisionanceError(CODES.PROBE_FAILED, { technicalDetails: detail }));
        }
        resolve(String(stdout));
      }
    );
  });
}

/** ffmpeg wants request headers as one CRLF-joined blob. */
function headerBlob(headers) {
  const entries = Object.entries(headers || {}).filter(([k, v]) => k && v != null);
  if (!entries.length) return null;
  return entries.map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
}

function inputArgs(opts) {
  const args = [];
  const blob = headerBlob(opts.headers);
  if (blob) args.push('-headers', blob);
  if (opts.userAgent) args.push('-user_agent', opts.userAgent);
  if (opts.isRemote) {
    args.push('-rw_timeout', String((opts.networkTimeoutMs || 15000) * 1000)); // microseconds
  }
  return args;
}

/* ------------------------------------------------------------------ *
 * Parsing helpers
 * ------------------------------------------------------------------ */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const posNum = (v) => {
  const n = num(v);
  return n != null && n > 0 ? n : null;
};

/** "30000/1001" -> 29.97 (3 dp). Returns null for "0/0" and friends. */
function parseRational(value) {
  if (!value || typeof value !== 'string') return null;
  const [a, b] = value.split('/');
  const nu = Number(a);
  const de = b === undefined ? 1 : Number(b);
  if (!Number.isFinite(nu) || !Number.isFinite(de) || de === 0 || nu === 0) return null;
  return Math.round((nu / de) * 1000) / 1000;
}

/** Best-effort bit depth from pix_fmt, used only when ffprobe omits it. */
function bitDepthFromPixFmt(pixFmt) {
  if (!pixFmt) return null;
  const m = /(\d{1,2})(le|be)$/.exec(pixFmt);
  if (m) return Number(m[1]);
  if (/^(yuv|yuvj|gbr|gray|nv)/.test(pixFmt)) return 8;
  return null;
}

function rotationOf(stream) {
  const tagged = num(stream.tags && (stream.tags.rotate ?? stream.tags.ROTATE));
  if (tagged != null) return ((tagged % 360) + 360) % 360;
  for (const sd of stream.side_data_list || []) {
    if (sd.rotation != null) {
      const r = num(sd.rotation);
      if (r != null) return ((Math.round(r) % 360) + 360) % 360;
    }
  }
  return null;
}

function gcd(a, b) { return b ? gcd(b, a % b) : a; }

function ratioString(w, h) {
  if (!w || !h) return null;
  const g = gcd(w, h) || 1;
  return `${Math.round(w / g)}:${Math.round(h / g)}`;
}

function resolutionClass(w, h) {
  if (!w || !h) return null;
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  if (long >= 7000 || short >= 4000) return '8K';
  if (long >= 3400 || short >= 1900) return '4K';
  if (long >= 2400 || short >= 1400) return '1440p';
  if (long >= 1700 || short >= 1000) return '1080p';
  if (long >= 1100 || short >= 700) return '720p';
  if (long >= 800) return '480p';
  return 'SD';
}

const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67', 'smpte428', 'bt2020-10', 'bt2020-12']);

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

function normaliseVideo(v) {
  if (!v) return null;

  const width = posNum(v.width);
  const height = posNum(v.height);
  const rFps = parseRational(v.r_frame_rate);
  const avgFps = parseRational(v.avg_frame_rate);
  // avg_frame_rate is measured over the whole file and is the honest answer for
  // a VFR source; r_frame_rate is the container's nominal maximum.
  const nominalFps = avgFps ?? rFps;

  const rotation = rotationOf(v);
  const swapped = rotation === 90 || rotation === 270;

  const sar = v.sample_aspect_ratio && v.sample_aspect_ratio !== '0:1' ? v.sample_aspect_ratio : null;
  const dar = v.display_aspect_ratio && v.display_aspect_ratio !== '0:1'
    ? v.display_aspect_ratio
    : ratioString(width, height);

  const fieldOrder = v.field_order || null;
  const interlaced = fieldOrder ? !/^progressive$/i.test(fieldOrder) : null;

  return {
    index: num(v.index),
    codec: v.codec_name || null,
    codecLongName: v.codec_long_name || null,
    profile: v.profile != null ? String(v.profile) : null,
    level: num(v.level) != null && num(v.level) > 0 ? num(v.level) : null,
    width,
    height,
    codedWidth: posNum(v.coded_width),
    codedHeight: posNum(v.coded_height),
    displayAspectRatio: dar,
    sampleAspectRatio: sar,
    pixelFormat: v.pix_fmt || null,
    bitDepth: num(v.bits_per_raw_sample) || bitDepthFromPixFmt(v.pix_fmt),
    bitrate: posNum(v.bit_rate),
    rotation,
    rotationSwapsAxes: swapped,
    fieldOrder,
    interlaced,
    timeBase: v.time_base || null,
    rFrameRate: v.r_frame_rate || null,
    avgFrameRate: v.avg_frame_rate || null,
    rFps,
    avgFps,
    nominalFps,
    frameCount: posNum(v.nb_frames)
      ?? posNum(v.nb_read_frames)
      ?? posNum(v.tags && (v.tags.NUMBER_OF_FRAMES || v.tags['NUMBER_OF_FRAMES-eng'])),
    duration: posNum(v.duration),
    startTime: num(v.start_time),
    language: (v.tags && (v.tags.language || v.tags.LANGUAGE)) || null
  };
}

function normaliseColour(v) {
  if (!v) return null;
  const transfer = v.color_transfer || null;
  const primaries = v.color_primaries || null;

  // Only claim HDR when the transfer function says so. A BT.2020 primary on an
  // SDR transfer is wide-gamut SDR, not HDR, and treating it as HDR would
  // produce a wrong tone map later.
  const isHDR = transfer ? HDR_TRANSFERS.has(transfer) && transfer !== 'bt2020-10' && transfer !== 'bt2020-12'
    : false;

  let mastering = null;
  let contentLight = null;
  for (const sd of v.side_data_list || []) {
    const type = String(sd.side_data_type || '').toLowerCase();
    if (type.includes('mastering display')) {
      mastering = {
        redX: sd.red_x ?? null, redY: sd.red_y ?? null,
        greenX: sd.green_x ?? null, greenY: sd.green_y ?? null,
        blueX: sd.blue_x ?? null, blueY: sd.blue_y ?? null,
        whitePointX: sd.white_point_x ?? null, whitePointY: sd.white_point_y ?? null,
        minLuminance: sd.min_luminance ?? null, maxLuminance: sd.max_luminance ?? null
      };
    } else if (type.includes('content light')) {
      contentLight = { maxContent: num(sd.max_content), maxAverage: num(sd.max_average) };
    }
  }

  return {
    range: v.color_range || null,
    space: v.color_space || null,
    primaries,
    transfer,
    chromaLocation: v.chroma_location || null,
    isHDR,
    hdrFormat: transfer === 'smpte2084' ? 'PQ' : transfer === 'arib-std-b67' ? 'HLG' : null,
    mastering,
    contentLight
  };
}

function normaliseAudio(a) {
  if (!a) return null;
  return {
    index: num(a.index),
    codec: a.codec_name || null,
    codecLongName: a.codec_long_name || null,
    profile: a.profile != null ? String(a.profile) : null,
    sampleRate: posNum(a.sample_rate),
    channels: posNum(a.channels),
    channelLayout: a.channel_layout || null,
    bitrate: posNum(a.bit_rate),
    duration: posNum(a.duration),
    language: (a.tags && (a.tags.language || a.tags.LANGUAGE)) || null,
    title: (a.tags && (a.tags.title || a.tags.TITLE)) || null,
    isDefault: !!(a.disposition && a.disposition.default)
  };
}

function normaliseSubtitle(s) {
  return {
    index: num(s.index),
    codec: s.codec_name || null,
    language: (s.tags && (s.tags.language || s.tags.LANGUAGE)) || null,
    title: (s.tags && (s.tags.title || s.tags.TITLE)) || null,
    forced: !!(s.disposition && s.disposition.forced)
  };
}

/**
 * Frame-rate mode from the two rates ffprobe already gives us. Cheap, and right
 * often enough to drive a UI hint; `deep` upgrades it to a measurement.
 */
function guessFrameRateMode(video) {
  if (!video || video.rFps == null || video.avgFps == null) {
    return { mode: 'unknown', confidence: 'none' };
  }
  const drift = Math.abs(video.rFps - video.avgFps) / Math.max(video.rFps, video.avgFps);
  if (drift < 0.002) return { mode: 'constant', confidence: 'low' };
  // Containers with no duration yet (fragmented mp4, live) skew avg_frame_rate.
  if (drift > 0.02) return { mode: 'variable', confidence: 'low' };
  return { mode: 'unknown', confidence: 'none' };
}

function derive(container, video, colour, audio) {
  const w = video && video.width;
  const h = video && video.height;
  const displayW = video && video.rotationSwapsAxes ? h : w;
  const displayH = video && video.rotationSwapsAxes ? w : h;

  const aspect = displayW && displayH ? Math.round((displayW / displayH) * 10000) / 10000 : null;
  const orientation = aspect == null
    ? null
    : aspect > 1.02 ? 'landscape' : aspect < 0.98 ? 'portrait' : 'square';

  const nominalFps = video ? video.nominalFps : null;
  const duration = (container && container.duration) || (video && video.duration) || null;

  return {
    displayWidth: displayW || null,
    displayHeight: displayH || null,
    orientation,
    aspectRatio: aspect,
    aspectRatioLabel: ratioString(displayW, displayH),
    isVertical: orientation === 'portrait',
    isSquare: orientation === 'square',
    isHDR: !!(colour && colour.isHDR),
    isInterlaced: video ? video.interlaced === true : null,
    nominalFps,
    frameRateMode: 'unknown',
    megapixels: displayW && displayH ? Math.round((displayW * displayH) / 10000) / 100 : null,
    resolutionClass: resolutionClass(displayW, displayH),
    hasAudio: !!audio,
    durationSeconds: duration,
    estimatedFrames: duration && nominalFps ? Math.round(duration * nominalFps) : null
  };
}

/* ------------------------------------------------------------------ *
 * Deep frame-timing probe
 * ------------------------------------------------------------------ */

/**
 * Read the first `frames` packet timestamps and measure the spread of the gaps.
 * A CFR source has one distinct gap (modulo rounding); a VFR one does not.
 * Only worth doing before an offline render, never during playback.
 */
async function probeFrameTiming(bin, input, opts, frames) {
  const args = [
    '-v', 'error',
    ...inputArgs(opts),
    '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time,duration_time',
    '-read_intervals', `%+#${frames}`,
    '-print_format', 'json',
    input
  ];
  const out = await runFfprobe(bin, args, DEEP_TIMEOUT);
  const packets = (JSON.parse(out).packets || [])
    .map((p) => num(p.pts_time))
    .filter((t) => t != null)
    .sort((a, b) => a - b);

  if (packets.length < 8) return null;

  const gaps = [];
  for (let i = 1; i < packets.length; i++) {
    const g = packets[i] - packets[i - 1];
    if (g > 0) gaps.push(g);
  }
  if (gaps.length < 6) return null;

  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const maxDev = Math.max(...gaps.map((g) => Math.abs(g - mean))) / mean;

  return {
    sampledFrames: packets.length,
    meanGap: Math.round(mean * 1e6) / 1e6,
    measuredFps: mean > 0 ? Math.round((1 / mean) * 1000) / 1000 : null,
    // 2% covers the ±1 timebase tick rounding a CFR mp4 legitimately shows.
    mode: maxDev <= 0.02 ? 'constant' : 'variable',
    maxDeviation: Math.round(maxDev * 10000) / 10000
  };
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * @param {string}  ffprobeBin
 * @param {string}  input      absolute file path or http(s) URL
 * @param {object}  [opts]
 *   headers        {object}  request headers for remote inputs
 *   userAgent      {string}
 *   deep           {boolean} measure frame timing (slower, offline use)
 *   deepFrames     {number}  frames to sample, default 120
 *   includeRaw     {boolean} attach the untouched ffprobe json
 *   timeoutMs      {number}
 * @returns {Promise<object>} normalised analysis
 */
async function analyze(ffprobeBin, input, opts = {}) {
  if (!ffprobeBin) throw new VisionanceError(CODES.FFPROBE_MISSING);
  if (!input || typeof input !== 'string') {
    throw new VisionanceError(CODES.INVALID_REQUEST, { message: 'No source was given to analyse.' });
  }

  const isRemote = /^https?:\/\//i.test(input);
  if (!isRemote) {
    if (!path.isAbsolute(input)) {
      throw new VisionanceError(CODES.INVALID_REQUEST, {
        message: 'Only absolute file paths can be analysed.',
        technicalDetails: `relative path rejected: ${input}`
      });
    }
    let stat;
    try {
      stat = fs.statSync(input);
    } catch {
      throw new VisionanceError(CODES.SOURCE_NOT_FOUND, { technicalDetails: `stat failed: ${input}` });
    }
    if (!stat.isFile()) {
      throw new VisionanceError(CODES.SOURCE_NOT_FOUND, { message: 'That path is not a file.' });
    }
    opts = { ...opts, _fileSize: stat.size };
  }

  const probeOpts = { ...opts, isRemote };
  const args = [
    '-v', 'error',
    ...inputArgs(probeOpts),
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    '-show_chapters',
    input
  ];

  const stdout = await runFfprobe(ffprobeBin, args, opts.timeoutMs || DEFAULT_TIMEOUT);

  let json;
  try {
    json = JSON.parse(stdout);
  } catch (err) {
    throw new VisionanceError(CODES.PROBE_FAILED, {
      message: 'ffprobe returned something Visionance could not read.',
      technicalDetails: err.message
    });
  }

  const streams = Array.isArray(json.streams) ? json.streams : [];
  const fmt = json.format || {};
  const warnings = [];

  const videoStreams = streams.filter((s) => s.codec_type === 'video' && !isCoverArt(s));
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const subtitleStreams = streams.filter((s) => s.codec_type === 'subtitle');

  if (!videoStreams.length) {
    throw new VisionanceError(CODES.NO_VIDEO_STREAM, {
      technicalDetails: `streams: ${streams.map((s) => s.codec_type).join(',') || 'none'}`
    });
  }

  const primaryVideo = videoStreams[0];
  const video = normaliseVideo(primaryVideo);
  const colour = normaliseColour(primaryVideo);
  const audios = audioStreams.map(normaliseAudio);
  const primaryAudio = audios.find((a) => a.isDefault) || audios[0] || null;

  const container = {
    formatName: fmt.format_name || null,
    formatLongName: fmt.format_long_name || null,
    duration: posNum(fmt.duration) ?? (video ? video.duration : null),
    size: posNum(fmt.size) ?? (opts._fileSize || null),
    bitrate: posNum(fmt.bit_rate),
    startTime: num(fmt.start_time),
    streamCount: streams.length,
    chapterCount: Array.isArray(json.chapters) ? json.chapters.length : 0,
    tags: pickTags(fmt.tags)
  };

  if (videoStreams.length > 1) warnings.push('Multiple video streams; the first was used.');
  if (container.duration == null) warnings.push('Duration is unknown for this source.');
  if (video.nominalFps == null) warnings.push('Frame rate could not be determined.');

  const derived = derive(container, video, colour, primaryAudio);
  const guessed = guessFrameRateMode(video);
  derived.frameRateMode = guessed.mode;
  derived.frameRateModeConfidence = guessed.confidence;

  let timing = null;
  if (opts.deep) {
    try {
      timing = await probeFrameTiming(ffprobeBin, input, probeOpts, opts.deepFrames || 120);
      if (timing) {
        derived.frameRateMode = timing.mode;
        derived.frameRateModeConfidence = 'measured';
        derived.measuredFps = timing.measuredFps;
      }
    } catch (err) {
      warnings.push('Frame-timing probe failed; frame rate mode is an estimate.');
      timing = null;
    }
  }

  const result = {
    schemaVersion: SCHEMA_VERSION,
    analysedAt: Date.now(),
    source: {
      type: isRemote ? 'remote' : 'local',
      path: isRemote ? null : input,
      url: isRemote ? input : null,
      name: isRemote ? null : path.basename(input),
      fileSize: isRemote ? null : (opts._fileSize ?? null),
      headers: isRemote ? redactHeaders(opts.headers) : null
    },
    container,
    video,
    color: colour,
    audio: primaryAudio,
    audioStreams: audios,
    subtitleStreams: subtitleStreams.map(normaliseSubtitle),
    timing,
    derived,
    warnings
  };

  if (opts.includeRaw) result.raw = { format: fmt, streams };
  return result;
}

/** Album art shows up as a 1-frame mjpeg video stream; it is not the video. */
function isCoverArt(s) {
  return !!(s.disposition && s.disposition.attached_pic) ||
    (s.codec_name === 'mjpeg' && String(s.avg_frame_rate) === '0/0');
}

function pickTags(tags) {
  if (!tags || typeof tags !== 'object') return {};
  const keep = ['title', 'artist', 'encoder', 'creation_time', 'comment', 'major_brand'];
  const out = {};
  for (const k of keep) {
    const v = tags[k] ?? tags[k.toUpperCase()];
    if (v != null) out[k] = String(v).slice(0, 200);
  }
  return out;
}

/**
 * Minimal shape used by the realtime player and older call sites. Kept as a
 * thin projection of the full analysis so there is only one probe path.
 */
function toLegacyInfo(analysis) {
  if (!analysis) return null;
  const v = analysis.video || {};
  const a = analysis.audio;
  return {
    width: v.width || 0,
    height: v.height || 0,
    fps: v.nominalFps || 0,
    vcodec: v.codec || null,
    acodec: a ? a.codec : null,
    hasAudio: !!a,
    duration: analysis.container.duration || 0,
    bitrate: analysis.container.bitrate || 0,
    size: analysis.container.size || 0,
    pixFmt: v.pixelFormat || null
  };
}

module.exports = {
  analyze,
  toLegacyInfo,
  probeFrameTiming,
  parseRational,
  resolutionClass,
  headerBlob,
  SCHEMA_VERSION
};
