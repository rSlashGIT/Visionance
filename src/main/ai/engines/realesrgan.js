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

/**
 * Decide how to run the network for a requested outcome.
 *
 * @param {object} o
 *   mode        'restore' | 'upscale'
 *   scale       requested output multiplier (1 for restore, 2 or 4 for upscale)
 *   modelId     'auto' | catalogue id
 *   available   result of installedModels()
 * @returns {{model, inferenceScale, downscaleAfter, reason}|null}
 */
function planInference({ mode = 'upscale', scale = 2, modelId = 'auto', available = [] }) {
  if (!available.length) return null;

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

  if (mode === 'restore') {
    // No 1x weights exist. Use the cheapest native scale and come back down.
    const inferenceScale = Math.min(...scales);
    return {
      model,
      inferenceScale,
      downscaleAfter: true,
      reason: `restore via ${inferenceScale}x inference then Lanczos downscale`
    };
  }

  if (scales.includes(scale)) {
    return { model, inferenceScale: scale, downscaleAfter: false, reason: `native ${scale}x` };
  }

  // Requested scale has no weights: go up to the nearest native scale that is
  // at least as large, then come back down.
  const bigger = scales.filter((s) => s > scale).sort((a, b) => a - b)[0];
  if (bigger) {
    return {
      model,
      inferenceScale: bigger,
      downscaleAfter: true,
      reason: `${scale}x via ${bigger}x inference then Lanczos downscale (no native ${scale}x weights)`
    };
  }

  const largest = Math.max(...scales);
  return {
    model,
    inferenceScale: largest,
    downscaleAfter: largest !== scale,
    reason: `${largest}x is the largest available (requested ${scale}x)`
  };
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
  releaseFor,
  installedModels,
  modelFiles,
  planInference,
  buildArgs
};
