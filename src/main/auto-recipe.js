'use strict';

/**
 * Auto: turn a source analysis into a processing recipe.
 *
 * The hard part of "Auto" is not deciding to enhance. It is deciding *not* to.
 * A clean 1080p24 cinematic master needs almost nothing done to it, and running
 * a 4x super-resolution network plus 60 fps interpolation over it would take
 * hours, cost quality, and change the character of the film. So the rules here
 * are deliberately conservative, and every one of them produces a sentence
 * explaining itself.
 *
 * Nothing in here assumes:
 *   4x > 2x        - upscaling beyond the display is wasted work
 *   60 > 24        - authored cadence is a creative choice, not a defect
 *   sharper > soft - oversharpening is the most common amateur tell
 *   more saturated > less
 *
 * Auto only ever *proposes*. The result is an ordinary recipe the user can edit,
 * and the UI tracks whether it is still Auto, Modified or fully Custom.
 */

const recipes = require('./recipe');

/** Creator-facing content profiles. */
const PROFILES = {
  auto: { id: 'auto', label: 'Auto / General' },
  film: { id: 'film', label: 'Film / Cinematic' },
  action: { id: 'action', label: 'Action / Sports' },
  gaming: { id: 'gaming', label: 'Gaming' },
  animation: { id: 'animation', label: 'Animation / Anime' },
  dialogue: { id: 'dialogue', label: 'Dialogue / Podcast' },
  lowlight: { id: 'lowlight', label: 'Low Light' },
  screencast: { id: 'screencast', label: 'Screencast / Text' }
};

/** How willing Auto is to spend time. */
const INTENSITIES = ['light', 'balanced', 'strong', 'maximum', 'custom'];

/** Roughly how long a job will take, without inventing an ETA. */
const COST = ['fast', 'moderate', 'heavy', 'very-heavy'];

/**
 * Bitrate thresholds, in bits per second per megapixel, normalised to 30 fps.
 *
 * Calibrated against what real encodes look like: a healthy 1080p30 upload sits
 * around 8 Mbps, which is ~3.9 Mbps per megapixel; a good 720p30 around 4 Mbps,
 * or ~4.3 per megapixel. Below roughly 1.2 there is visible blocking.
 */
const BITRATE_POOR = 1.2e6;
const BITRATE_COMPRESSED = 2.6e6;

function megapixels(w, h) {
  return (Number(w) || 0) * (Number(h) || 0) / 1e6;
}

/**
 * Is this source visibly compressed?
 * Only answerable when we actually know the bitrate; unknown stays unknown
 * rather than becoming a guess that triggers hours of processing.
 */
function assessQuality(analysis) {
  const v = analysis.video || {};
  const d = analysis.derived || {};
  const bitrate = (v.bitrate || analysis.container.bitrate || 0);
  const mpx = megapixels(d.displayWidth || v.width, d.displayHeight || v.height);
  const fps = v.nominalFps || 30;

  if (!bitrate || !mpx) {
    return { known: false, level: 'unknown', bitsPerMpxPerS: null };
  }
  // Normalise to 30 fps: 60 fps needs roughly twice the bitrate for the same
  // per-frame quality, so it should not be judged as though it were 30.
  const perMpxPerS = bitrate / mpx / (fps / 30);
  let level;
  if (perMpxPerS < BITRATE_POOR) level = 'poor';
  else if (perMpxPerS < BITRATE_COMPRESSED) level = 'compressed';
  else level = 'clean';
  return { known: true, level, bitsPerMpxPerS: Math.round(perMpxPerS) };
}

/** Cinematic rates that should be left alone unless asked otherwise. */
function isCinematicRate(fps) {
  return fps > 0 && fps < 26;
}

/**
 * Infer a content profile, but only from things the file actually tells us.
 * Bitrate does not reveal genre, and pretending otherwise produces confident
 * nonsense - so `auto` mostly stays `auto`.
 */
function inferProfile(analysis, requested) {
  if (requested && requested !== 'auto' && PROFILES[requested]) {
    return { profile: requested, inferred: false, why: 'you chose it' };
  }
  const d = analysis.derived || {};
  const v = analysis.video || {};

  // A very high frame rate with a game-typical resolution is weak evidence at
  // best; the honest default is the general profile.
  if (d.isVertical) {
    return { profile: 'auto', inferred: true, why: 'vertical source; using the general profile' };
  }
  if (isCinematicRate(v.nominalFps) && (d.resolutionClass === '1080p' || d.resolutionClass === '4K')) {
    return {
      profile: 'film',
      inferred: true,
      why: `${v.nominalFps} fps at ${d.resolutionClass} looks like authored film`
    };
  }
  return { profile: 'auto', inferred: true, why: 'no reliable signal; using the general profile' };
}

/* ------------------------------------------------------------------ *
 * Per-profile policy
 * ------------------------------------------------------------------ */

const POLICY = {
  auto: { restoreBias: 1, grade: 'neutral', allowInterpolation: false, sharpen: 0.18 },
  film: { restoreBias: 0.5, grade: 'cinematic', allowInterpolation: false, sharpen: 0.1 },
  action: { restoreBias: 1, grade: 'punchy', allowInterpolation: true, sharpen: 0.24 },
  gaming: { restoreBias: 0.8, grade: 'punchy', allowInterpolation: true, sharpen: 0.24 },
  animation: { restoreBias: 1.1, grade: 'neutral', allowInterpolation: false, sharpen: 0.14 },
  dialogue: { restoreBias: 0.9, grade: 'neutral', allowInterpolation: false, sharpen: 0.14 },
  lowlight: { restoreBias: 1.4, grade: 'lift', allowInterpolation: false, sharpen: 0.12 },
  screencast: { restoreBias: 0.4, grade: 'flat', allowInterpolation: false, sharpen: 0.3 }
};

const INTENSITY_FACTOR = { light: 0.55, balanced: 1, strong: 1.4, maximum: 1.8, custom: 1 };

/* ------------------------------------------------------------------ *
 * The engine
 * ------------------------------------------------------------------ */

/**
 * @param {object} o
 *   analysis    {object}  required
 *   platform    {string}  recipe platform id
 *   profile     {string}  content profile or 'auto'
 *   intensity   {'light'|'balanced'|'strong'|'maximum'}
 *   engines     {{realesrgan:boolean, rife:boolean, reframe:boolean}} availability
 *   outputPath  {string}
 *   preferences {object}  raw overrides applied last
 * @returns {{recipe, explanations:string[], warnings:string[], cost:string,
 *            profile:string, decisions:object}}
 */
function buildAutoRecipe({
  analysis,
  platform = 'custom',
  profile: requestedProfile = 'auto',
  intensity = 'balanced',
  engines = {},
  outputPath = null,
  preferences = {}
} = {}) {
  if (!analysis) throw new Error('Auto needs a source analysis.');

  const explanations = [];
  const warnings = [];
  const v = analysis.video || {};
  const d = analysis.derived || {};

  const inferred = inferProfile(analysis, requestedProfile);
  const profile = inferred.profile;
  const policy = POLICY[profile] || POLICY.auto;
  const factor = INTENSITY_FACTOR[intensity] || 1;

  const quality = assessQuality(analysis);
  const srcW = d.displayWidth || v.width || 0;
  const srcH = d.displayHeight || v.height || 0;
  const srcFps = v.nominalFps || 0;
  const platformDef = recipes.PLATFORMS[platform] || recipes.PLATFORMS.custom;

  if (inferred.inferred && profile !== 'auto') {
    explanations.push(`Profile: ${PROFILES[profile].label} — ${inferred.why}.`);
  }

  /* ---------------- restoration ---------------- */
  const restore = { enabled: false, denoise: 0, deblock: 0, deband: 0, grain: 0 };
  if (quality.level === 'poor') {
    restore.enabled = true;
    restore.denoise = clamp(0.22 * policy.restoreBias * factor, 0, 0.6);
    restore.deblock = clamp(0.45 * policy.restoreBias * factor, 0, 0.8);
    restore.deband = clamp(0.35 * factor, 0, 0.7);
    explanations.push('Low source bitrate for this resolution — compression cleanup enabled.');
  } else if (quality.level === 'compressed') {
    restore.enabled = true;
    restore.denoise = clamp(0.1 * policy.restoreBias * factor, 0, 0.4);
    restore.deblock = clamp(0.2 * policy.restoreBias * factor, 0, 0.5);
    restore.deband = clamp(0.2 * factor, 0, 0.5);
    explanations.push('Moderately compressed source — light restoration enabled.');
  } else if (quality.level === 'clean') {
    explanations.push('Source is already clean — restoration left off.');
  } else {
    warnings.push('The source bitrate is unknown, so restoration was left off rather than guessed at.');
  }
  if (profile === 'screencast' && restore.enabled) {
    restore.denoise = Math.min(restore.denoise, 0.08);
    restore.grain = 0;
    explanations.push('Screencast: denoise kept minimal so text and UI edges stay crisp.');
  }

  /* ---------------- geometry ---------------- */
  const wantsCanvas = platformDef.canvas && platformDef.canvas !== 'source';
  const targetW = wantsCanvas ? platformDef.width : srcW;
  const targetH = wantsCanvas ? platformDef.height : srcH;

  /* ---------------- neural reconstruction ---------------- */
  const reconstruction = {
    enabled: false,
    mode: 'classical',
    aiMode: 'upscale',
    aiScale: 2,
    model: profile === 'animation' ? 'animation' : 'general',
    targetResolution: wantsCanvas
      ? { mode: 'custom', width: platformDef.width, height: platformDef.height }
      : { mode: 'source' }
  };

  const needsMorePixels = targetH > 0 && srcH > 0 && targetH > srcH * 1.2;
  const damaged = quality.level === 'poor' || quality.level === 'compressed';

  if (!engines.realesrgan) {
    if (needsMorePixels || damaged) {
      warnings.push('Real-ESRGAN is not installed, so neural reconstruction was not used.');
    }
    if (needsMorePixels) {
      reconstruction.enabled = true;
      reconstruction.mode = 'classical';
      explanations.push(`Scaling ${srcH}p to ${targetH}p with classical resampling.`);
    }
  } else if (needsMorePixels && damaged) {
    reconstruction.enabled = true;
    reconstruction.mode = 'neural';
    reconstruction.aiMode = 'upscale';
    reconstruction.aiScale = targetH > srcH * 2.5 ? 4 : 2;
    explanations.push(
      `${srcH}p source is compressed and the output is ${targetW}x${targetH} — ` +
      `neural ${reconstruction.aiScale}x reconstruction enabled.`
    );
  } else if (damaged && intensity !== 'light' && quality.level === 'poor') {
    reconstruction.enabled = true;
    reconstruction.mode = 'neural';
    reconstruction.aiMode = 'restore';
    reconstruction.aiScale = 1;
    explanations.push('Heavily compressed source — neural restore at the same resolution.');
  } else if (needsMorePixels) {
    // More pixels wanted, but the source is clean: a good resampler is the
    // right tool. A network here mostly invents texture that was not filmed.
    reconstruction.enabled = true;
    reconstruction.mode = 'classical';
    explanations.push(
      `${srcH}p source is clean — scaled to ${targetW}x${targetH} with classical ` +
      'resampling rather than a network, which would invent detail.'
    );
  } else {
    explanations.push(`Output stays at ${srcH || 'source'}p — no upscaling needed.`);
  }

  if (reconstruction.mode === 'neural' && intensity === 'maximum' &&
      reconstruction.aiMode === 'upscale' && reconstruction.aiScale === 2 &&
      targetH > srcH * 1.9) {
    // Maximum is allowed to spend more, but still not to do pointless work.
    explanations.push('Maximum intensity: neural scale kept at 2x, which already exceeds the target.');
  }

  /* ---------------- motion ---------------- */
  const motion = {
    enabled: false,
    targetFps: null,
    interpolation: 'none',
    sceneCutProtection: true,
    model: 'auto'
  };
  let outputFps = null;

  const platformMaxFps = platformDef.maxFps || null;
  if (isCinematicRate(srcFps)) {
    explanations.push(`${srcFps} fps cinematic source — original frame rate preserved.`);
  } else if (srcFps >= 50) {
    explanations.push(`Source is already ${Math.round(srcFps)} fps — no interpolation needed.`);
  } else if (policy.allowInterpolation && engines.rife && intensity !== 'light') {
    motion.enabled = true;
    motion.interpolation = 'ai';
    motion.targetFps = 60;
    outputFps = 60;
    explanations.push(
      `${PROFILES[profile].label}: AI interpolation to 60 fps. ` +
      'This changes the motion character — smoother, but less filmic.'
    );
  } else if (policy.allowInterpolation && !engines.rife) {
    warnings.push('RIFE is not installed, so the frame rate was left alone rather than duplicating frames.');
  }
  if (platformMaxFps && outputFps && outputFps > platformMaxFps) {
    outputFps = platformMaxFps;
    motion.targetFps = platformMaxFps;
  }

  /* ---------------- framing ---------------- */
  const framing = { enabled: false, canvas: 'source', mode: 'fit', background: 'blur', tracking: 'none' };
  if (wantsCanvas) {
    framing.enabled = true;
    framing.canvas = platformDef.canvas;
    framing.width = platformDef.width;
    framing.height = platformDef.height;
    const sourceIsWider = (srcW / Math.max(1, srcH)) > (platformDef.width / platformDef.height);
    if (sourceIsWider && engines.reframe) {
      framing.mode = 'fill';
      framing.tracking = 'auto';
      explanations.push(
        `${platformDef.label}: Smart Reframe enabled so the subject stays in the ${platformDef.canvas} crop.`
      );
    } else if (sourceIsWider) {
      framing.mode = 'fit';
      framing.tracking = 'center';
      warnings.push('Subject tracking is unavailable, so the crop is centred and letterboxed.');
    } else {
      framing.mode = 'fit';
      explanations.push(`${platformDef.label}: source fits the canvas without cropping.`);
    }
  }

  /* ---------------- colour ---------------- */
  const color = buildColor(policy, factor, analysis, explanations, warnings);

  /* ---------------- audio ---------------- */
  const audio = { enabled: d.hasAudio !== false, mode: d.hasAudio === false ? 'none' : 'encode' };
  if (d.hasAudio === false) {
    explanations.push('Source has no audio track.');
  } else if (profile === 'dialogue') {
    audio.master = 'dialogue';
    explanations.push('Dialogue profile — speech-focused mastering with gentle compression.');
  } else if (intensity === 'light') {
    audio.master = 'normalize';
    explanations.push('Audio normalised to a consistent loudness.');
  } else {
    audio.master = 'creator';
    explanations.push('Creator master applied: consistent loudness with a limiter to prevent clipping.');
  }

  /* ---------------- assemble ---------------- */
  const overrides = {
    name: analysis.source && analysis.source.name ? `${analysis.source.name} (auto)` : 'Auto render',
    restore,
    reconstruction,
    motion,
    framing,
    color,
    audio,
    output: {
      platform,
      path: outputPath,
      fps: outputFps,
      quality: intensity === 'light' ? 62 : intensity === 'maximum' ? 82 : 72
    },
    processing: { verify: true }
  };

  const merged = recipes.deepMerge(
    recipes.defaultRecipe(analysis, overrides),
    preferences || {}
  );
  const { recipe, warnings: sanitiseWarnings } = recipes.sanitize(merged);
  warnings.push(...sanitiseWarnings);

  const geometry = recipes.resolveOutputGeometry(recipe, analysis);
  const cost = estimateCost({ recipe, geometry, analysis });

  return {
    recipe,
    explanations,
    warnings,
    cost,
    profile,
    profileInferred: inferred.inferred,
    intensity,
    decisions: {
      sourceQuality: quality,
      needsMorePixels,
      neural: recipe.reconstruction.mode === 'neural',
      interpolation: recipe.motion.interpolation,
      tracking: recipe.framing.tracking,
      outputFps: geometry.fps,
      outputResolution: geometry.width && geometry.height
        ? `${geometry.width}x${geometry.height}`
        : null
    }
  };
}

function buildColor(policy, factor, analysis, explanations, warnings) {
  const color = {
    enabled: true,
    contrast: 0,
    brightness: 0,
    saturation: 0,
    gamma: 0,
    sharpen: clamp(policy.sharpen * factor, 0, 0.5),
    toneMap: 'none'
  };

  switch (policy.grade) {
    case 'cinematic':
      color.contrast = 0.06 * factor;
      color.saturation = 0.03 * factor;
      explanations.push('Cinematic finish: restrained contrast, skin tones and highlights left alone.');
      break;
    case 'punchy':
      color.contrast = 0.12 * factor;
      color.saturation = 0.12 * factor;
      explanations.push('Punchy finish for high-motion content.');
      break;
    case 'lift':
      color.gamma = 0.14 * factor;
      color.contrast = 0.04 * factor;
      explanations.push('Low light: shadows lifted without crushing the noise floor.');
      break;
    case 'flat':
      color.contrast = 0.02;
      color.saturation = 0;
      explanations.push('Screencast: colour left essentially untouched.');
      break;
    default:
      color.contrast = 0.05 * factor;
      color.saturation = 0.05 * factor;
      break;
  }

  const d = analysis.derived || {};
  if (d.isHDR) {
    const filters = analysis.__availableFilters;
    const canToneMap = !filters || (filters.zscale && filters.tonemap);
    if (canToneMap) {
      color.toneMap = 'hable';
      explanations.push('HDR source — tone-mapped to SDR with the Hable curve.');
    } else {
      warnings.push(
        'This is an HDR source but this ffmpeg build has no zscale/tonemap filter, ' +
        'so the colours will not be converted correctly.'
      );
    }
  }
  return color;
}

/**
 * Cost class, not an ETA. An ETA before any frames have been processed would be
 * a guess, and on a 4 GB laptop GPU a wrong one is badly misleading.
 */
function estimateCost({ recipe, geometry, analysis }) {
  const duration = (analysis.derived && analysis.derived.durationSeconds) || 0;
  const outPixels = (geometry.width || 1920) * (geometry.height || 1080);
  const fps = geometry.fps || 30;
  const frames = duration * fps;

  let score = 0;
  score += (outPixels / 2e6) * (frames / 1000);
  if (recipe.reconstruction.mode === 'neural') {
    score *= recipe.reconstruction.aiScale >= 4 ? 22 : 10;
  }
  if (recipe.motion.interpolation === 'ai') score *= 3;
  if (recipe.framing.tracking === 'auto') score *= 1.3;

  if (score < 8) return 'fast';
  if (score < 60) return 'moderate';
  if (score < 400) return 'heavy';
  return 'very-heavy';
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, Number(v) || 0));
}

module.exports = {
  buildAutoRecipe,
  inferProfile,
  assessQuality,
  estimateCost,
  isCinematicRate,
  PROFILES,
  INTENSITIES,
  COST
};
