'use strict';

/**
 * Real-ESRGAN (NCNN / Vulkan) - neural restoration and super-resolution.
 *
 * The portable ncnn build is used deliberately: it needs no Python, no PyTorch,
 * no CUDA toolkit and no conda environment, and it runs on NVIDIA, AMD and
 * Intel GPUs through Vulkan. Visionance downloads and manages it; the user
 * never opens a terminal.
 *
 * Scale, honestly
 * ---------------
 * These models have a *native* scale baked into their weights. `realesrgan-
 * x4plus` is 4x and nothing else; `realesr-animevideov3` genuinely ships x2, x3
 * and x4 weights. There is no 1x model, so "AI Restore" is not a 1x inference -
 * it is a native-scale inference followed by a high-quality Lanczos downscale
 * back to the target resolution. That is a real technique (the network still
 * removes compression damage and rebuilds detail), but it is not a "1x AI
 * model" and this file never pretends otherwise: `planInference()` returns the
 * scale actually used and whether a downscale follows.
 */

const path = require('path');
const fs = require('fs');

const ID = 'realesrgan';

/**
 * Official portable builds. Sizes are checked after download; the project
 * publishes no per-asset SHA-256, so `sha256` is null rather than invented and
 * the size check plus the archive's own integrity are what we rely on.
 */
const RELEASES = {
  win32: {
    url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip',
    bytes: 45474481,
    sha256: null,
    executable: 'realesrgan-ncnn-vulkan.exe'
  },
  linux: {
    url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-ubuntu.zip',
    bytes: null,
    sha256: null,
    executable: 'realesrgan-ncnn-vulkan'
  },
  darwin: {
    url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-macos.zip',
    bytes: null,
    sha256: null,
    executable: 'realesrgan-ncnn-vulkan'
  }
};

/**
 * Models shipped inside the release archive.
 *
 * `nativeScales` is what the weights actually support - asking for anything
 * else makes the tool exit with "invalid scale", so the planner never does.
 */
const MODELS = [
  {
    id: 'general',
    label: 'General',
    name: 'realesrgan-x4plus',
    nativeScales: [4],
    note: 'Photographic and live-action footage. Sharpens aggressively.'
  },
  {
    id: 'general-restore',
    label: 'General (restore)',
    name: 'realesrnet-x4plus',
    nativeScales: [4],
    // The non-GAN variant invents less, which is what you want when the goal is
    // repairing damage rather than manufacturing detail.
    note: 'Faithful restoration without GAN embellishment.'
  },
  {
    id: 'animation',
    label: 'Animation',
    name: 'realesr-animevideov3',
    nativeScales: [2, 3, 4],
    note: 'Anime and cel animation. The only model here with native 2x and 3x.'
  },
  {
    id: 'animation-art',
    label: 'Animation (artwork)',
    name: 'realesrgan-x4plus-anime',
    nativeScales: [4],
    note: 'Illustration and static anime artwork.'
  }
];

const LICENSE = {
  name: 'Real-ESRGAN',
  license: 'BSD-3-Clause',
  url: 'https://github.com/xinntao/Real-ESRGAN',
  notice: 'Real-ESRGAN by Xintao Wang et al. NCNN implementation by nihui. Bundled models carry their own upstream terms.'
};

function releaseFor(platform = process.platform) {
  if (platform === 'win32') return RELEASES.win32;
  if (platform === 'darwin') return RELEASES.darwin;
  return RELEASES.linux;
}

/** Model files must both exist before we claim a model is usable. */
function modelFiles(modelsDir, modelName, scale) {
  // animevideov3 names its weights per scale: realesr-animevideov3-x2.param
  const scaled = `${modelName}-x${scale}`;
  const candidates = [scaled, modelName];
  for (const base of candidates) {
    const param = path.join(modelsDir, `${base}.param`);
    const bin = path.join(modelsDir, `${base}.bin`);
    if (fs.existsSync(param) && fs.existsSync(bin)) return { base, param, bin };
  }
  return null;
}

/** Which of the catalogue's models are actually present on disk. */
function installedModels(engineDir) {
  const modelsDir = path.join(engineDir, 'models');
  const out = [];
  for (const model of MODELS) {
    const scales = model.nativeScales.filter((s) => !!modelFiles(modelsDir, model.name, s));
    if (scales.length) out.push({ ...model, availableScales: scales });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Inference quality
 *
 * Output scale and inference quality are different questions, and conflating
 * them is what made a ten-second clip take the best part of an hour.
 *
 * Measured on the reference machine (GTX 1650 Ti, 8 frames per run):
 *
 * ```
 * 720p source, 2x output (1440p)
 *   x4plus at x4 on the full frame, Lanczos back down   12.66 s/frame
 *   x4plus at x4 on a half-size frame, exact 2x          3.61 s/frame   3.5x faster
 *   animevideov3 native x2                               0.64 s/frame  19.9x faster
 *
 * 480p source
 *   x4plus at x4 on the full frame                        6.07 s/frame
 *   x4plus at x4 on a half-size frame                     1.96 s/frame  3.1x faster
 *   animevideov3 native x2 / x4                           0.41 s/frame
 * ```
 *
 * The middle row is the one worth explaining. These networks are trained to
 * reconstruct from *degraded, low-resolution* input - that is the entire
 * premise of ESRGAN - so feeding a half-size frame to a 4x model and taking
 * the result at exactly 2x is a legitimate way to reach 2x, not a shortcut
 * pretending to be one. It costs a quarter of the inference pixels because
 * the cost is driven by the input area. It is genuinely lower fidelity than
 * running the network on every source pixel and resampling down, because half
 * the source detail never reaches the network - which is precisely why it is
 * `balanced` and not `quality`.
 *
 * There is no native General 2x model to ship. `RealESRGAN_x2plus` exists
 * upstream as PyTorch weights, but the official ncnn portable release carries
 * no x2 param/bin for it, and the community conversions have no published
 * provenance or checksums. Inventing one, or relabelling the anime model as
 * general, would be worse than the honest fallback below.
 * ------------------------------------------------------------------ */

const QUALITIES = ['fast', 'balanced', 'quality', 'maximum'];

const QUALITY_LABELS = {
  fast: 'Fast',
  balanced: 'Balanced',
  quality: 'Quality',
  maximum: 'Maximum'
};

function normaliseQuality(q) {
  return QUALITIES.includes(q) ? q : 'balanced';
}

/**
 * Decide how to run the network for a requested outcome.
 *
 * @param {object} o
 *   mode        'restore' | 'upscale'
 *   scale       requested output multiplier (1 for restore, 2 or 4 for upscale)
 *   modelId     'auto' | catalogue id
 *   available   result of installedModels()
 *   quality     'fast' | 'balanced' | 'quality' | 'maximum'
 * @returns {{neural, model, inferenceScale, preScale, downscaleAfter,
 *            effectiveScale, quality, reason, tradeoff}|null}
 */
function planInference({ mode = 'upscale', scale = 2, modelId = 'auto', available = [], quality = 'balanced' }) {
  if (!available.length) return null;
  const q = normaliseQuality(quality);

  const byId = (id) => available.find((m) => m.id === id) || null;
  const animation = byId('animation') || byId('animation-art');
  const general = byId('general');
  const restorer = byId('general-restore') || general;

  let model;
  if (modelId === 'animation') model = animation || general;
  else if (modelId === 'general') model = mode === 'restore' ? restorer : general;
  else if (modelId !== 'auto') model = byId(modelId);
  // Auto stays deliberately dull: without content classification, guessing
  // "this looks like anime" would be a coin flip dressed up as intelligence.
  if (!model) model = mode === 'restore' ? restorer : general;
  if (!model) model = available[0];
  if (!model) return null;

  const scales = model.availableScales || model.nativeScales;
  const base = {
    neural: true, model, preScale: 1, quality: q,
    qualityLabel: QUALITY_LABELS[q], tradeoff: null
  };

  if (mode === 'restore') {
    // No 1x weights exist. Use the cheapest native scale and come back down,
    // except at Maximum where the largest scale reconstructs the most.
    const inferenceScale = q === 'maximum' ? Math.max(...scales) : Math.min(...scales);
    return {
      ...base,
      inferenceScale,
      downscaleAfter: true,
      effectiveScale: 1,
      reason: `restore via ${inferenceScale}x inference then Lanczos downscale`
    };
  }

  const hasNative = scales.includes(scale);
  const bigger = scales.filter((s) => s > scale).sort((a, b) => a - b)[0];
  const largest = Math.max(...scales);

  // Maximum always reconstructs at the largest native scale and resamples
  // down, even when a native scale exists - that is what the user asked for.
  if (q === 'maximum' && largest > scale) {
    return {
      ...base,
      inferenceScale: largest,
      downscaleAfter: true,
      effectiveScale: scale,
      reason: `${scale}x via ${largest}x inference then Lanczos downscale (maximum reconstruction)`,
      tradeoff: 'Highest fidelity and by far the slowest: the network runs on every source pixel at its largest scale.'
    };
  }

  if (hasNative) {
    return {
      ...base,
      inferenceScale: scale,
      downscaleAfter: false,
      effectiveScale: scale,
      reason: `native ${scale}x`
    };
  }

  if (!bigger) {
    return {
      ...base,
      inferenceScale: largest,
      downscaleAfter: largest !== scale,
      effectiveScale: scale,
      reason: `${largest}x is the largest available (requested ${scale}x)`
    };
  }

  // No native weights at the requested scale. What happens now is the whole
  // point of the quality setting.
  if (q === 'fast') {
    // Refuse to spend 4x-on-every-pixel money for a 2x result. The caller
    // falls back to classical reconstruction, and is told so plainly.
    return {
      ...base,
      neural: false,
      inferenceScale: null,
      downscaleAfter: false,
      effectiveScale: scale,
      reason: `no native ${scale}x weights for ${model.name}; Fast uses classical reconstruction instead`,
      tradeoff: `Fast declines neural ${scale}x here because this model has no native ${scale}x weights, ` +
        'and running its 4x network on every source pixel costs far more than the result is worth. ' +
        'Detail is resampled and sharpened rather than reconstructed.'
    };
  }

  if (q === 'balanced') {
    const preScale = scale / bigger;
    return {
      ...base,
      inferenceScale: bigger,
      preScale,
      downscaleAfter: false,
      effectiveScale: scale,
      reason: `${scale}x via ${bigger}x inference on a ${formatFraction(preScale)}-size frame (no native ${scale}x weights)`,
      tradeoff: `Balanced reaches ${scale}x by running the ${bigger}x network on a ${formatFraction(preScale)}-size ` +
        'frame, which costs about a quarter of the inference and measured 3.5x faster. ' +
        'It reconstructs from less source detail than Quality does.'
    };
  }

  return {
    ...base,
    inferenceScale: bigger,
    downscaleAfter: true,
    effectiveScale: scale,
    reason: `${scale}x via ${bigger}x inference then Lanczos downscale (no native ${scale}x weights)`,
    tradeoff: `Quality runs the ${bigger}x network on every source pixel and resamples down. ` +
      'The most detail the model can use, and the slowest path short of Maximum.'
  };
}

function formatFraction(v) {
  if (Math.abs(v - 0.5) < 1e-6) return 'half';
  if (Math.abs(v - 0.25) < 1e-6) return 'quarter';
  if (Math.abs(v - 0.75) < 1e-6) return 'three-quarter';
  return `${Math.round(v * 100)}%`;
}

/**
 * Command line for one directory of frames.
 * @param {object} o { engineDir, inputDir, outputDir, model, scale, tileSize, gpuId, threads }
 */
function buildArgs({ inputDir, outputDir, model, scale, tileSize = 0, gpuId = null, threads = null }) {
  const args = [
    '-i', inputDir,
    '-o', outputDir,
    '-n', model,
    '-s', String(scale),
    '-f', 'png'
  ];
  if (tileSize && tileSize > 0) args.push('-t', String(tileSize));
  if (gpuId !== null && gpuId !== undefined && gpuId !== 'auto') args.push('-g', String(gpuId));
  if (threads) args.push('-j', threads);
  return args;
}

module.exports = {
  ID,
  MODELS,
  LICENSE,
  QUALITIES,
  QUALITY_LABELS,
  normaliseQuality,
  releaseFor,
  installedModels,
  modelFiles,
  planInference,
  buildArgs
};
