'use strict';

/**
 * The processing recipe.
 *
 * A recipe is *intent*: what the user wants done to a source. It is not a
 * description of the source (that is the analysis) and it is not the realtime
 * preview state (that is the shader parameter object in the renderer). Those
 * three things are deliberately separate:
 *
 *   analysis  - measured facts about the input          (media-analyzer.js)
 *   params    - WebGL preview settings, per frame       (renderer/js/presets.js)
 *   recipe    - offline processing intent, versioned    (this file)
 *
 * The preview and the offline render are different engines - GLSL versus an
 * ffmpeg filter graph, and later neural passes - so they can never be assumed
 * to produce identical pixels. `fromPreviewParams()` translates the preview
 * look into a *starting point* for a recipe and says so; it is not a promise of
 * equivalence.
 *
 * Compatibility rules:
 *   - every recipe carries `schemaVersion`
 *   - `sanitize()` drops unknown keys and clamps everything it keeps, so an
 *     old recipe missing new fields simply picks up the new defaults
 *   - `migrate()` is where a breaking change gets an explicit upgrade step
 */

/**
 * v2 added the neural fields (`reconstruction.aiMode`/`aiScale`,
 * `motion.interpolation: 'ai'`, `processing.gpu`/`tileSize`). v1 recipes load
 * unchanged - the new fields simply take their defaults, which describe the
 * classical behaviour v1 already had.
 */
const SCHEMA_VERSION = 2;

/* ------------------------------------------------------------------ *
 * Enumerations
 * ------------------------------------------------------------------ */

const RECONSTRUCTION_MODES = ['none', 'classical', 'neural'];
const RESAMPLERS = ['lanczos', 'bicubic', 'spline', 'bilinear'];
/**
 * 'motion' is ffmpeg's minterpolate - optical flow, but not a neural network.
 * 'ai' is RIFE. They are never conflated: the UI labels them differently and
 * a recipe asking for 'ai' fails rather than quietly falling back to 'motion'.
 */
const INTERPOLATION_MODES = ['none', 'duplicate', 'blend', 'motion', 'ai'];
/** What the neural reconstructor is being asked to achieve. */
const AI_MODES = ['restore', 'upscale'];
/** How much inference to spend reaching the requested scale. */
const AI_QUALITIES = ['fast', 'balanced', 'quality', 'maximum'];
const AI_MODELS = ['auto', 'general', 'animation'];
const FRAMING_MODES = ['fit', 'fill', 'stretch'];
const FRAMING_TRACKING = ['none', 'center', 'auto'];
const BACKGROUNDS = ['black', 'blur'];
const TONE_MAPS = ['none', 'hable', 'mobius', 'reinhard'];
const AUDIO_MODES = ['copy', 'encode', 'none'];
const AUDIO_MASTERS = ['preserve', 'normalize', 'creator', 'dialogue'];
const CONTAINERS = ['mp4', 'mkv', 'mov', 'webm'];
const VIDEO_CODECS = ['h264', 'hevc', 'vp9', 'av1'];
const BITRATE_MODES = ['quality', 'bitrate'];
const CHUNK_MODES = ['auto', 'off', 'on'];
const HARDWARE_MODES = ['auto', 'cpu'];
const DEINTERLACE_MODES = ['auto', 'off', 'on'];

/** Named output canvases. `source` keeps whatever the input had. */
const CANVASES = {
  source: null,
  '16:9': { w: 16, h: 9 },
  '9:16': { w: 9, h: 16 },
  '1:1': { w: 1, h: 1 },
  '4:5': { w: 4, h: 5 },
  /**
   * "21:9" is a marketing name, not an arithmetic one. Every ultrawide panel
   * and every standard ultrawide resolution - 2560×1080, 3440×1440 - is
   * actually 64:27 (2.370:1). Using a literal 21÷9 here would make the ratio
   * disagree with the resolution the same control suggests, which is the sort
   * of small lie that produces a two-pixel letterbox nobody can explain.
   */
  '21:9': { w: 64, h: 27 },
  '2.39:1': { w: 239, h: 100 },
  /** Ratio comes from `framing.aspectW` / `framing.aspectH`. */
  custom: null
};

/**
 * Aspect ratio is a first-class output setting, not a side effect of picking a
 * social platform.
 *
 * `suggested` is what the resolution control offers while it is in automatic
 * mode - changing the ratio moves it, and a resolution the user typed is left
 * alone. Long edge 1920/2560 so a ratio change never silently multiplies the
 * pixel count.
 */
const ASPECTS = {
  source: { id: 'source', label: 'Same as source', suggested: null },
  '16:9': { id: '16:9', label: '16:9 — widescreen', suggested: { width: 1920, height: 1080 } },
  '9:16': { id: '9:16', label: '9:16 — vertical', suggested: { width: 1080, height: 1920 } },
  '4:5': { id: '4:5', label: '4:5 — portrait feed', suggested: { width: 1080, height: 1350 } },
  '1:1': { id: '1:1', label: '1:1 — square', suggested: { width: 1080, height: 1080 } },
  '21:9': { id: '21:9', label: '21:9 — ultrawide (64:27)', suggested: { width: 2560, height: 1080 } },
  '2.39:1': { id: '2.39:1', label: '2.39:1 — cinemascope', suggested: { width: 2560, height: 1072 } },
  custom: { id: 'custom', label: 'Custom ratio', suggested: null }
};

/** The ratio a canvas id represents, or null for source/unset. */
function aspectRatioOf(canvasId, framing = null) {
  if (canvasId === 'custom') {
    const w = Number(framing && framing.aspectW);
    const h = Number(framing && framing.aspectH);
    return w > 0 && h > 0 ? w / h : null;
  }
  const c = CANVASES[canvasId];
  return c ? c.w / c.h : null;
}

/**
 * Resolution that suits a ratio, with even dimensions because most encoders
 * refuse odd ones. Used only while resolution is on automatic.
 */
function suggestedResolution(canvasId, framing = null) {
  const preset = ASPECTS[canvasId];
  if (preset && preset.suggested) return { ...preset.suggested };
  const ratio = aspectRatioOf(canvasId, framing);
  if (!ratio) return null;
  // Hold the long edge at 1920 so a custom ratio cannot explode the pixel count.
  if (ratio >= 1) {
    return { width: 1920, height: evenDim(1920 / ratio) };
  }
  return { width: evenDim(1080 * ratio), height: 1920 };
}

function evenDim(v) {
  const n = Math.max(16, Math.round(Number(v) || 0));
  return n % 2 === 0 ? n : n + 1;
}

/**
 * Platform targets. These only *seed* a recipe - every value stays editable,
 * and `platform` is recorded so the UI can show what a job was aimed at.
 */
const PLATFORMS = {
  custom: {
    id: 'custom',
    label: 'Custom',
    canvas: 'source',
    width: null,
    height: null,
    maxFps: null,
    container: 'mp4',
    codec: 'h264',
    audioBitrateKbps: 256
  },
  youtube: {
    id: 'youtube',
    label: 'YouTube (landscape)',
    canvas: '16:9',
    width: 1920,
    height: 1080,
    maxFps: 60,
    container: 'mp4',
    codec: 'h264',
    audioBitrateKbps: 384
  },
  'youtube-4k': {
    id: 'youtube-4k',
    label: 'YouTube 4K',
    canvas: '16:9',
    width: 3840,
    height: 2160,
    maxFps: 60,
    container: 'mp4',
    codec: 'h264',
    audioBitrateKbps: 384
  },
  'youtube-shorts': {
    id: 'youtube-shorts',
    label: 'YouTube Shorts',
    canvas: '9:16',
    width: 1080,
    height: 1920,
    maxFps: 60,
    container: 'mp4',
    codec: 'h264',
    audioBitrateKbps: 256
  },
  'instagram-reels': {
    id: 'instagram-reels',
    label: 'Instagram Reels',
    canvas: '9:16',
    width: 1080,
    height: 1920,
    maxFps: 60,
    container: 'mp4',
    codec: 'h264',
    audioBitrateKbps: 256
  },
  'instagram-feed': {
    id: 'instagram-feed',
    label: 'Instagram feed (4:5)',
    canvas: '4:5',
    width: 1080,
    height: 1350,
    maxFps: 60,
    container: 'mp4',
    codec: 'h264',
    audioBitrateKbps: 256
  },
  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    canvas: '9:16',
    width: 1080,
    height: 1920,
    maxFps: 60,
    container: 'mp4',
    codec: 'h264',
    audioBitrateKbps: 256
  }
};

/* ------------------------------------------------------------------ *
 * Coercion helpers
 * ------------------------------------------------------------------ */

function clamp(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function round(value, dp) {
  const f = Math.pow(10, dp);
  return Math.round(value * f) / f;
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/** Positive integer or null; used for "unset means derive it". */
function optInt(value, lo, hi) {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, n));
}

function optNum(value, lo, hi, dp = 3) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return round(Math.min(hi, Math.max(lo, n)), dp);
}

function str(value, max, fallback) {
  if (typeof value !== 'string') return fallback;
  const s = value.trim();
  return s ? s.slice(0, max) : fallback;
}

const even = (n) => (n % 2 === 0 ? n : n + 1);

/* ------------------------------------------------------------------ *
 * Defaults
 * ------------------------------------------------------------------ */

function baseRecipe() {
  return {
    schemaVersion: SCHEMA_VERSION,
    name: 'Untitled render',

    source: {
      type: 'local',
      path: null,
      /** Direct stream URLs. Short-lived, never persisted. */
      url: null,
      audioUrl: null,
      headerToken: null,
      /** The page the stream came from. This is what survives a restart. */
      webpageUrl: null,
      title: null
    },

    /** A snapshot of the facts the recipe was built against, not the analysis. */
    analysisRef: null,

    trim: { startSeconds: null, endSeconds: null },

    restore: {
      enabled: false,
      denoise: 0,
      deblock: 0,
      deband: 0,
      grain: 0,
      deinterlace: 'auto'
    },

    reconstruction: {
      enabled: false,
      mode: 'classical',
      scale: 1,
      resampler: 'lanczos',
      targetResolution: { mode: 'source', width: null, height: null },
      /**
       * Neural intent, separate from the output resolution on purpose.
       * `aiMode: 'restore'` means "repair at the current size"; `aiScale` is
       * the multiplier the user asked for. Neither is the same thing as the
       * network's own native scale, which the engine planner works out.
       */
      aiMode: 'upscale',
      aiScale: 2,
      /**
       * How much inference to spend reaching `aiScale`. A separate axis from
       * the scale itself: 2x output can be reached cheaply or expensively, and
       * before this existed it was always reached the expensive way.
       */
      aiQuality: 'balanced',
      model: 'auto'
    },

    motion: {
      enabled: false,
      targetFps: null,
      interpolation: 'none',
      model: 'auto',
      sceneCutProtection: true,
      sceneCutThreshold: 0.35,
      motionBlur: 0
    },

    framing: {
      enabled: false,
      canvas: 'source',
      width: null,
      height: null,
      mode: 'fit',
      background: 'blur',
      tracking: 'none',
      crop: null
    },

    color: {
      enabled: false,
      contrast: 0,
      brightness: 0,
      saturation: 0,
      gamma: 0,
      sharpen: 0,
      toneMap: 'none'
    },

    audio: {
      enabled: true,
      mode: 'encode',
      codec: 'aac',
      bitrateKbps: 256,
      sampleRate: null,
      channels: null,
      /**
       * Mastering preset. Visionance is not a DAW: these are four opinionated
       * chains built from standard ffmpeg filters, not a mixing desk.
       *   preserve  - touch nothing
       *   normalize - loudness only
       *   creator   - loudness + limiter + gentle glue compression
       *   dialogue  - creator, plus presence EQ and de-rumble for speech
       */
      master: 'preserve',
      normalize: { enabled: false, targetLufs: -14, truePeak: -1, lra: 11 }
    },

    output: {
      platform: 'custom',
      container: 'mp4',
      codec: 'h264',
      encoder: 'auto',
      bitrateMode: 'quality',
      quality: 70,
      bitrateKbps: null,
      maxBitrateKbps: null,
      preset: 'medium',
      fps: null,
      faststart: true,
      path: null
    },

    processing: {
      chunking: { mode: 'auto', chunkSeconds: 120 },
      verify: true,
      keepIntermediates: false,
      hardware: 'auto',
      /** Vulkan device for the neural engines: 'auto' or an index. */
      gpu: 'auto',
      /** Manual tile size (Advanced). null lets the OOM ladder choose. */
      tileSize: null
    }
  };
}

/* ------------------------------------------------------------------ *
 * Sanitisation
 * ------------------------------------------------------------------ */

/**
 * Return a fully-populated, clamped recipe built from arbitrary input.
 * Unknown keys are dropped; out-of-range values are clamped, not rejected.
 *
 * @returns {{recipe: object, warnings: string[]}}
 */
function sanitize(input) {
  const warnings = [];
  const raw = (input && typeof input === 'object') ? input : {};
  const d = baseRecipe();

  const noteClamp = (label, before, after) => {
    if (before !== undefined && before !== null && Number(before) !== after) {
      warnings.push(`${label} was clamped to ${after}.`);
    }
  };

  const src = raw.source || {};
  const source = {
    type: pick(src.type, ['local', 'remote'], d.source.type),
    path: str(src.path, 4096, null),
    url: str(src.url, 4096, null),
    audioUrl: str(src.audioUrl, 4096, null),
    headerToken: str(src.headerToken, 64, null),
    webpageUrl: str(src.webpageUrl, 4096, null),
    title: str(src.title, 300, null)
  };
  if (source.type === 'local') {
    source.url = null;
    source.audioUrl = null;
    source.headerToken = null;
    source.webpageUrl = null;
  }
  if (source.type === 'remote') source.path = null;

  const t = raw.trim || {};
  const trim = {
    startSeconds: optNum(t.startSeconds, 0, 86400 * 7),
    endSeconds: optNum(t.endSeconds, 0, 86400 * 7)
  };
  if (trim.startSeconds != null && trim.endSeconds != null && trim.endSeconds <= trim.startSeconds) {
    warnings.push('Trim end was before trim start; the trim was dropped.');
    trim.startSeconds = null;
    trim.endSeconds = null;
  }

  const r = raw.restore || {};
  const restore = {
    enabled: bool(r.enabled, d.restore.enabled),
    denoise: clamp(r.denoise, 0, 1, 0),
    deblock: clamp(r.deblock, 0, 1, 0),
    deband: clamp(r.deband, 0, 1, 0),
    grain: clamp(r.grain, 0, 1, 0),
    deinterlace: pick(r.deinterlace, DEINTERLACE_MODES, d.restore.deinterlace)
  };
  noteClamp('restore.denoise', r.denoise, restore.denoise);

  const rc = raw.reconstruction || {};
  const tr = rc.targetResolution || {};
  const reconstruction = {
    enabled: bool(rc.enabled, d.reconstruction.enabled),
    mode: pick(rc.mode, RECONSTRUCTION_MODES, d.reconstruction.mode),
    scale: clamp(rc.scale, 0.25, 8, 1),
    resampler: pick(rc.resampler, RESAMPLERS, d.reconstruction.resampler),
    targetResolution: {
      mode: pick(tr.mode, ['source', 'scale', 'custom'], 'source'),
      width: optInt(tr.width, 16, 16384),
      height: optInt(tr.height, 16, 16384)
    },
    aiMode: pick(rc.aiMode, AI_MODES, d.reconstruction.aiMode),
    // Only 2x, 3x and 4x exist as native neural scales; 1 means "restore".
    aiScale: [1, 2, 3, 4].includes(Math.round(Number(rc.aiScale)))
      ? Math.round(Number(rc.aiScale))
      : d.reconstruction.aiScale,
    aiQuality: pick(rc.aiQuality, AI_QUALITIES, d.reconstruction.aiQuality),
    model: str(rc.model, 120, d.reconstruction.model)
  };
  if (reconstruction.aiMode === 'restore') reconstruction.aiScale = 1;
  if (reconstruction.aiScale === 1) reconstruction.aiMode = 'restore';
  if (reconstruction.targetResolution.mode === 'custom' &&
      (!reconstruction.targetResolution.width || !reconstruction.targetResolution.height)) {
    warnings.push('Custom output resolution needs both width and height; falling back to source.');
    reconstruction.targetResolution.mode = 'source';
  }

  const m = raw.motion || {};
  const motion = {
    enabled: bool(m.enabled, d.motion.enabled),
    targetFps: optNum(m.targetFps, 1, 480, 3),
    // 'neural' was the v1 spelling for what is now 'ai'.
    interpolation: pick(m.interpolation === 'neural' ? 'ai' : m.interpolation,
      INTERPOLATION_MODES, d.motion.interpolation),
    model: str(m.model, 60, d.motion.model),
    sceneCutProtection: bool(m.sceneCutProtection, d.motion.sceneCutProtection),
    sceneCutThreshold: clamp(m.sceneCutThreshold, 0.01, 1, d.motion.sceneCutThreshold),
    motionBlur: clamp(m.motionBlur, 0, 1, 0)
  };

  const f = raw.framing || {};
  const framing = {
    enabled: bool(f.enabled, d.framing.enabled),
    canvas: Object.prototype.hasOwnProperty.call(CANVASES, f.canvas) ? f.canvas : d.framing.canvas,
    width: optInt(f.width, 16, 16384),
    height: optInt(f.height, 16, 16384),
    mode: pick(f.mode, FRAMING_MODES, d.framing.mode),
    background: pick(f.background, BACKGROUNDS, d.framing.background),
    tracking: pick(f.tracking, FRAMING_TRACKING, d.framing.tracking),
    // Only meaningful for `canvas: 'custom'`. Clamped rather than trusted: a
    // NaN or a zero here would resolve to a zero-width canvas and fail deep
    // inside ffmpeg instead of here.
    aspectW: optInt(f.aspectW, 1, 1000),
    aspectH: optInt(f.aspectH, 1, 1000),
    crop: sanitizeCrop(f.crop)
  };
  // 'auto' is Smart Reframe and is implemented; whether a usable trajectory can
  // be produced is a run-time question, answered by the REFRAME stage, which
  // falls back to centre framing and says so.

  if (framing.canvas === 'custom' && !(framing.aspectW && framing.aspectH) &&
      !(framing.width && framing.height)) {
    warnings.push('A custom aspect ratio needs both a width and a height ratio; the source ratio was kept.');
    framing.canvas = 'source';
  }
  if (framing.width && framing.height) {
    const evened = { width: evenDim(framing.width), height: evenDim(framing.height) };
    if (evened.width !== framing.width || evened.height !== framing.height) {
      warnings.push(
        `Output dimensions must be even for the encoder; ${framing.width}×${framing.height} ` +
        `was adjusted to ${evened.width}×${evened.height}.`
      );
      framing.width = evened.width;
      framing.height = evened.height;
    }
  }


  const c = raw.color || {};
  const color = {
    enabled: bool(c.enabled, d.color.enabled),
    contrast: clamp(c.contrast, -1, 1, 0),
    brightness: clamp(c.brightness, -1, 1, 0),
    saturation: clamp(c.saturation, -1, 1, 0),
    gamma: clamp(c.gamma, -1, 1, 0),
    sharpen: clamp(c.sharpen, 0, 1, 0),
    toneMap: pick(c.toneMap, TONE_MAPS, d.color.toneMap)
  };

  const a = raw.audio || {};
  const an = a.normalize || {};
  const audio = {
    enabled: bool(a.enabled, d.audio.enabled),
    mode: pick(a.mode, AUDIO_MODES, d.audio.mode),
    codec: pick(a.codec, ['aac', 'opus', 'flac'], d.audio.codec),
    bitrateKbps: clamp(a.bitrateKbps, 32, 640, d.audio.bitrateKbps),
    sampleRate: optInt(a.sampleRate, 8000, 192000),
    channels: optInt(a.channels, 1, 8),
    master: pick(a.master, AUDIO_MASTERS, d.audio.master),
    normalize: {
      enabled: bool(an.enabled, false),
      targetLufs: clamp(an.targetLufs, -40, -5, -14),
      truePeak: clamp(an.truePeak, -9, 0, -1),
      lra: clamp(an.lra, 1, 50, 11)
    }
  };
  if (!audio.enabled) audio.mode = 'none';
  if (audio.mode === 'none') audio.enabled = false;
  if (audio.master !== 'preserve') {
    // Every mastering chain needs re-encoded audio; a stream copy cannot be
    // loudness-corrected.
    if (audio.mode === 'copy') {
      warnings.push('Audio mastering needs re-encoded audio; audio mode switched to encode.');
      audio.mode = 'encode';
    }
    audio.normalize.enabled = true;
  }
  if (audio.mode === 'copy' && audio.normalize.enabled) {
    warnings.push('Loudness normalisation needs re-encoded audio; audio mode switched to encode.');
    audio.mode = 'encode';
  }

  const o = raw.output || {};
  const output = {
    platform: Object.prototype.hasOwnProperty.call(PLATFORMS, o.platform) ? o.platform : d.output.platform,
    container: pick(o.container, CONTAINERS, d.output.container),
    codec: pick(o.codec, VIDEO_CODECS, d.output.codec),
    encoder: str(o.encoder, 60, d.output.encoder),
    bitrateMode: pick(o.bitrateMode, BITRATE_MODES, d.output.bitrateMode),
    quality: Math.round(clamp(o.quality, 0, 100, d.output.quality)),
    bitrateKbps: optInt(o.bitrateKbps, 100, 400000),
    maxBitrateKbps: optInt(o.maxBitrateKbps, 100, 400000),
    preset: str(o.preset, 24, d.output.preset),
    fps: optNum(o.fps, 1, 480, 3),
    faststart: bool(o.faststart, d.output.faststart),
    path: str(o.path, 4096, null)
  };
  if (output.bitrateMode === 'bitrate' && !output.bitrateKbps) {
    warnings.push('Bitrate mode needs a bitrate; quality mode was used instead.');
    output.bitrateMode = 'quality';
  }
  if (output.container === 'webm' && !['vp9', 'av1'].includes(output.codec)) {
    warnings.push('WebM only carries VP9/AV1; the container was changed to MP4.');
    output.container = 'mp4';
  }

  const p = raw.processing || {};
  const pc = p.chunking || {};
  const processing = {
    chunking: {
      mode: pick(pc.mode, CHUNK_MODES, d.processing.chunking.mode),
      chunkSeconds: Math.round(clamp(pc.chunkSeconds, 5, 3600, d.processing.chunking.chunkSeconds))
    },
    verify: bool(p.verify, d.processing.verify),
    keepIntermediates: bool(p.keepIntermediates, d.processing.keepIntermediates),
    hardware: pick(p.hardware, HARDWARE_MODES, d.processing.hardware),
    gpu: p.gpu === 'auto' || p.gpu === undefined || p.gpu === null
      ? 'auto'
      : (optInt(p.gpu, 0, 15) ?? 'auto'),
    tileSize: optInt(p.tileSize, 32, 4096)
  };

  const recipe = {
    schemaVersion: SCHEMA_VERSION,
    name: str(raw.name, 200, d.name),
    source,
    analysisRef: sanitizeAnalysisRef(raw.analysisRef),
    trim,
    restore,
    reconstruction,
    motion,
    framing,
    color,
    audio,
    output,
    processing
  };

  return { recipe, warnings };
}

function sanitizeCrop(crop) {
  if (!crop || typeof crop !== 'object') return null;
  const x = optNum(crop.x, 0, 1, 5);
  const y = optNum(crop.y, 0, 1, 5);
  const w = optNum(crop.width ?? crop.w, 0.01, 1, 5);
  const h = optNum(crop.height ?? crop.h, 0.01, 1, 5);
  if (x == null || y == null || w == null || h == null) return null;
  return {
    x: Math.min(x, 1 - w),
    y: Math.min(y, 1 - h),
    width: w,
    height: h
  };
}

/** Compact facts the recipe was authored against, for auditing and UI. */
function sanitizeAnalysisRef(ref) {
  if (!ref || typeof ref !== 'object') return null;
  return {
    analysedAt: optInt(ref.analysedAt, 0, Number.MAX_SAFE_INTEGER),
    width: optInt(ref.width, 1, 16384),
    height: optInt(ref.height, 1, 16384),
    fps: optNum(ref.fps, 0.001, 480, 3),
    durationSeconds: optNum(ref.durationSeconds, 0, 86400 * 7, 3),
    hasAudio: typeof ref.hasAudio === 'boolean' ? ref.hasAudio : null,
    isHDR: typeof ref.isHDR === 'boolean' ? ref.isHDR : null,
    isInterlaced: typeof ref.isInterlaced === 'boolean' ? ref.isInterlaced : null,
    orientation: pick(ref.orientation, ['landscape', 'portrait', 'square'], null),
    codec: str(ref.codec, 40, null),
    frameRateMode: pick(ref.frameRateMode, ['constant', 'variable', 'unknown'], 'unknown')
  };
}

/** Build an analysisRef from a full analysis object. */
function analysisRefFrom(analysis) {
  if (!analysis) return null;
  const v = analysis.video || {};
  const dv = analysis.derived || {};
  return sanitizeAnalysisRef({
    analysedAt: analysis.analysedAt,
    width: dv.displayWidth || v.width,
    height: dv.displayHeight || v.height,
    fps: v.nominalFps,
    durationSeconds: dv.durationSeconds,
    hasAudio: !!analysis.audio,
    isHDR: !!dv.isHDR,
    isInterlaced: dv.isInterlaced === true,
    orientation: dv.orientation,
    codec: v.codec,
    frameRateMode: dv.frameRateMode
  });
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/**
 * Structural checks that sanitisation cannot fix by clamping.
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
function validate(recipe) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });

  if (!recipe || typeof recipe !== 'object') {
    return { valid: false, errors: [{ field: 'recipe', message: 'Recipe is missing.' }] };
  }
  if (recipe.schemaVersion !== SCHEMA_VERSION) {
    add('schemaVersion', `Unsupported schema version ${recipe.schemaVersion}.`);
  }

  const s = recipe.source || {};
  if (s.type === 'local' && !s.path) add('source.path', 'A source file is required.');
  // A remote job only needs *a* way to reach the media. The direct stream URL
  // expires, so a page URL alone is enough - the job re-resolves when it runs.
  if (s.type === 'remote' && !s.url && !s.webpageUrl) {
    add('source.url', 'A source URL is required.');
  }

  const o = recipe.output || {};
  if (!o.path) add('output.path', 'An output file path is required.');
  else if (!/\.[a-z0-9]{2,5}$/i.test(o.path)) add('output.path', 'The output path needs a file extension.');

  if (o.container === 'mp4' && !['h264', 'hevc', 'av1'].includes(o.codec)) {
    add('output.codec', `${o.codec} cannot be stored in an MP4 by Visionance.`);
  }

  // Neural stages are no longer rejected here: the backends exist. Whether the
  // *engine* is installed is a run-time fact, not a property of the recipe, so
  // it is checked when the job starts and reported as ENGINE_MISSING - which is
  // actionable ("install it") rather than "this recipe is invalid".
  if (recipe.motion && recipe.motion.enabled && recipe.motion.interpolation === 'ai' &&
      !recipe.motion.targetFps && !(recipe.output && recipe.output.fps)) {
    add('motion.targetFps', 'AI interpolation needs a target frame rate.');
  }

  return { valid: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ *
 * Migration
 * ------------------------------------------------------------------ */

/**
 * Bring a stored recipe up to the current schema.
 * Version 1 is the first published schema, so there is nothing to upgrade yet;
 * the shape exists so a future change has an obvious place to live and old
 * jobs on disk keep loading.
 */
function migrate(stored) {
  if (!stored || typeof stored !== 'object') return { recipe: sanitize({}).recipe, migrated: false };
  const from = Number(stored.schemaVersion) || 0;
  let working = stored;

  if (from > SCHEMA_VERSION) {
    // Written by a newer build. Sanitising keeps every field this build
    // understands and drops the rest rather than refusing to open the job.
    const { recipe } = sanitize(working);
    return { recipe, migrated: true, note: `Recipe came from schema v${from}; unknown fields were dropped.` };
  }

  if (from < 1) {
    working = { ...working, schemaVersion: 1 };
  }

  if (from < 2) {
    // v1 -> v2. The neural fields did not exist, and v1's only interpolation
    // options were classical, so the defaults already describe v1 behaviour.
    // The one real rename is 'neural' -> 'ai', handled in sanitize().
    working = {
      ...working,
      schemaVersion: 2,
      reconstruction: {
        // A v1 recipe could not have meant neural: the build refused it.
        mode: 'classical',
        ...(working.reconstruction || {})
      }
    };
    if (working.reconstruction && working.reconstruction.mode === 'neural') {
      working.reconstruction.mode = 'classical';
    }
  }

  const { recipe } = sanitize(working);
  return { recipe, migrated: from !== SCHEMA_VERSION };
}

/* ------------------------------------------------------------------ *
 * Construction helpers
 * ------------------------------------------------------------------ */

/**
 * A recipe that makes sense for this particular source: a straight re-encode
 * at source geometry with nothing switched on. Everything else is opt-in.
 */
function defaultRecipe(analysis, overrides = {}) {
  const base = baseRecipe();
  const ref = analysisRefFrom(analysis);
  if (ref) {
    base.analysisRef = ref;
    base.restore.deinterlace = ref.isInterlaced ? 'on' : 'auto';
    if (ref.isHDR) base.color.toneMap = 'hable';
    base.audio.enabled = ref.hasAudio !== false;
    base.audio.mode = ref.hasAudio === false ? 'none' : 'encode';
  }
  if (analysis && analysis.source) {
    base.source.type = analysis.source.type === 'remote' ? 'remote' : 'local';
    base.source.path = analysis.source.path || null;
    base.source.url = analysis.source.url || null;
    base.source.title = analysis.source.name || null;
    if (analysis.source.name) base.name = analysis.source.name;
  }
  const merged = deepMerge(base, overrides);
  return sanitize(merged).recipe;
}

/** Seed a recipe from a platform target, leaving unrelated fields alone. */
function applyPlatform(recipe, platformId) {
  const platform = PLATFORMS[platformId];
  if (!platform) return sanitize(recipe).recipe;

  const next = deepMerge(sanitize(recipe).recipe, {
    output: {
      platform: platform.id,
      container: platform.container,
      codec: platform.codec,
      fps: null
    },
    audio: { bitrateKbps: platform.audioBitrateKbps }
  });

  if (platform.id === 'custom') {
    next.framing.enabled = false;
    next.framing.canvas = 'source';
    next.framing.width = null;
    next.framing.height = null;
    next.reconstruction.targetResolution = { mode: 'source', width: null, height: null };
  } else {
    next.framing.enabled = true;
    next.framing.canvas = platform.canvas;
    next.framing.width = platform.width;
    next.framing.height = platform.height;
    next.reconstruction.enabled = true;
    next.reconstruction.mode = 'classical';
    next.reconstruction.targetResolution = {
      mode: 'custom',
      width: platform.width,
      height: platform.height
    };
  }

  const maxFps = platform.maxFps;
  const sourceFps = next.analysisRef && next.analysisRef.fps;
  if (maxFps && sourceFps && sourceFps > maxFps) {
    next.output.fps = maxFps;
  }

  return sanitize(next).recipe;
}

/**
 * Translate realtime preview parameters into recipe fields as a *starting
 * point*. The preview runs GLSL; the render runs an ffmpeg filter graph. The
 * two share intent, never arithmetic - callers should present the result as
 * "based on your preview", not "identical to your preview".
 */
function fromPreviewParams(params, analysis, overrides = {}) {
  const p = params || {};
  const recipe = defaultRecipe(analysis, overrides);

  const anyRestore = (p.denoise || 0) > 0.02 || (p.deblock || 0) > 0.02 ||
    (p.deband || 0) > 0.02 || (p.grain || 0) > 0.02;
  recipe.restore.enabled = !!p.enabled && anyRestore;
  recipe.restore.denoise = clamp(p.denoise, 0, 1, 0);
  recipe.restore.deblock = clamp(p.deblock, 0, 1, 0);
  recipe.restore.deband = clamp(p.deband, 0, 1, 0);
  recipe.restore.grain = clamp(p.grain, 0, 1, 0);

  const anyColour = ['contrast', 'brightness', 'saturation', 'gamma']
    .some((k) => Math.abs(Number(p[k]) || 0) > 0.005) || (p.sharpen || 0) > 0.02;
  recipe.color.enabled = !!p.enabled && anyColour;
  recipe.color.contrast = clamp(p.contrast, -1, 1, 0);
  recipe.color.brightness = clamp(p.brightness, -1, 1, 0);
  recipe.color.saturation = clamp(p.saturation, -1, 1, 0);
  recipe.color.gamma = clamp(p.gamma, -1, 1, 0);
  recipe.color.sharpen = clamp(p.sharpen, 0, 1, 0);

  if (p.enabled && Number(p.scaleFactor) > 1 && !overrides.reconstruction) {
    recipe.reconstruction.enabled = true;
    recipe.reconstruction.mode = 'classical';
    recipe.reconstruction.scale = clamp(p.scaleFactor, 1, 8, 1);
    recipe.reconstruction.targetResolution = { mode: 'scale', width: null, height: null };
  }

  recipe.derivedFromPreview = true;
  return sanitize(recipe).recipe;
}

/* ------------------------------------------------------------------ *
 * Intent -> geometry
 * ------------------------------------------------------------------ */

/**
 * Resolve the concrete output geometry a recipe asks for against a source.
 * Used by the encode planner *and* the output verifier, so what we ask ffmpeg
 * for and what we assert afterwards can never drift apart.
 *
 * @returns {{width:number|null, height:number|null, fps:number|null,
 *            scaleWidth:number|null, scaleHeight:number|null,
 *            canvasWidth:number|null, canvasHeight:number|null}}
 */
function resolveOutputGeometry(recipe, analysis) {
  const ref = (analysis && analysisRefFrom(analysis)) || recipe.analysisRef || null;
  const srcW = ref && ref.width;
  const srcH = ref && ref.height;
  const srcFps = ref && ref.fps;

  let width = srcW || null;
  let height = srcH || null;

  const tr = recipe.reconstruction.targetResolution;
  if (recipe.reconstruction.enabled) {
    if (tr.mode === 'custom' && tr.width && tr.height) {
      width = tr.width;
      height = tr.height;
    } else if (tr.mode === 'scale' && srcW && srcH) {
      width = Math.round(srcW * recipe.reconstruction.scale);
      height = Math.round(srcH * recipe.reconstruction.scale);
    } else if (recipe.reconstruction.mode === 'neural' && tr.mode === 'source' && srcW && srcH) {
      // "AI Upscale 2x" with no explicit target means 2x the source. Restore
      // (aiScale 1) deliberately keeps the source size - the network still runs,
      // it just does not change the resolution.
      const s = recipe.reconstruction.aiScale || 1;
      width = Math.round(srcW * s);
      height = Math.round(srcH * s);
    }
  }

  // Framing owns the final canvas; reconstruction only decides how many pixels
  // we rebuild before it is applied.
  let canvasWidth = null;
  let canvasHeight = null;
  if (recipe.framing.enabled) {
    if (recipe.framing.width && recipe.framing.height) {
      canvasWidth = recipe.framing.width;
      canvasHeight = recipe.framing.height;
    } else if (recipe.framing.canvas !== 'source' && width && height) {
      const aspect = aspectRatioOf(recipe.framing.canvas, recipe.framing);
      if (aspect) {
        // Preserve pixel count roughly, snap the long edge to the source's.
        if (aspect >= 1) {
          canvasWidth = evenDim(width);
          canvasHeight = evenDim(width / aspect);
        } else {
          canvasHeight = evenDim(height);
          canvasWidth = evenDim(height * aspect);
        }
      }
    }
  }

  const finalW = canvasWidth || width;
  const finalH = canvasHeight || height;

  /**
   * When framing owns the canvas, it also owns the resample.
   *
   * The framing stage crops from the source and then scales once to the
   * canvas. A *second* scale in front of it - which is what
   * `reconstruction.targetResolution` produces when the user picks, say,
   * 1080x1920 for a 9:16 output - squashes the 16:9 frame into 9:16 before the
   * crop ever runs. The crop then operates on an already-distorted picture,
   * and `min(iw, ih * aspect)` resolves to the full width, so it becomes a
   * no-op: Smart Reframe tracks a subject perfectly and then has no effect on
   * the output.
   *
   * Found by rendering a real 9:16 short and reading the filter graph:
   *   scale=1080:1920, crop=w=min(iw,ih*0.563)..., scale=1080:1920
   * The middle term can never crop anything.
   *
   * Suppressing the pre-scale is both correct and better: one resample instead
   * of two, from full source resolution.
   */
  const framesToCanvas = !!(recipe.framing.enabled && canvasWidth && canvasHeight);
  const preScaleW = framesToCanvas ? srcW : width;
  const preScaleH = framesToCanvas ? srcH : height;

  let fps = null;
  if (recipe.output.fps) fps = recipe.output.fps;
  else if (recipe.motion.enabled && recipe.motion.targetFps) fps = recipe.motion.targetFps;
  else fps = srcFps || null;

  return {
    sourceWidth: srcW || null,
    sourceHeight: srcH || null,
    sourceFps: srcFps || null,
    // What the reconstruction stage scales to *before* framing. Equal to the
    // source when framing performs the resample itself.
    scaleWidth: preScaleW ? even(preScaleW) : null,
    scaleHeight: preScaleH ? even(preScaleH) : null,
    // What reconstruction was asked for, kept so the plan can still explain
    // itself even when framing supersedes it.
    requestedWidth: width ? even(width) : null,
    requestedHeight: height ? even(height) : null,
    canvasWidth: canvasWidth ? even(canvasWidth) : null,
    canvasHeight: canvasHeight ? even(canvasHeight) : null,
    width: finalW ? even(finalW) : null,
    height: finalH ? even(finalH) : null,
    fps: fps ? round(fps, 3) : null,
    fpsChanged: !!(fps && srcFps && Math.abs(fps - srcFps) > 0.01)
  };
}

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/** Stable JSON for persistence and equality checks. */
function serialize(recipe) {
  return JSON.stringify(sanitize(recipe).recipe);
}

function deserialize(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { recipe: baseRecipe(), migrated: false, error: 'Recipe JSON could not be parsed.' };
  }
  return migrate(parsed);
}

module.exports = {
  SCHEMA_VERSION,
  PLATFORMS,
  CANVASES,
  ASPECTS,
  aspectRatioOf,
  suggestedResolution,
  RECONSTRUCTION_MODES,
  INTERPOLATION_MODES,
  AI_MODES,
  AI_QUALITIES,
  AI_MODELS,
  AUDIO_MASTERS,
  baseRecipe,
  defaultRecipe,
  applyPlatform,
  fromPreviewParams,
  sanitize,
  validate,
  migrate,
  serialize,
  deserialize,
  analysisRefFrom,
  resolveOutputGeometry,
  deepMerge
};
