'use strict';

/**
 * RIFE (NCNN / Vulkan) - neural frame interpolation.
 *
 * Same reasoning as Real-ESRGAN: the portable ncnn build needs no Python and
 * runs on any Vulkan GPU.
 *
 * The important capability here is `-n <count>`: RIFE can be asked for an exact
 * number of output frames rather than only doubling. That is what makes
 * 23.976 -> 60 and 25 -> 60 expressible at all, instead of pretending every
 * conversion is a power of two.
 *
 * `-u` (UHD mode) computes optical flow at reduced scale. It is switched on
 * automatically for large frames, which is what keeps 4k interpolation inside
 * 8 GB of VRAM.
 */

const path = require('path');
const fs = require('fs');

const ID = 'rife';

const RELEASES = {
  win32: {
    url: 'https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-windows.zip',
    bytes: 431540241,
    sha256: null,
    executable: 'rife-ncnn-vulkan.exe'
  },
  linux: {
    url: 'https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-ubuntu.zip',
    bytes: null,
    sha256: null,
    executable: 'rife-ncnn-vulkan'
  },
  darwin: {
    url: 'https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-macos.zip',
    bytes: null,
    sha256: null,
    executable: 'rife-ncnn-vulkan'
  }
};

/**
 * Model directories inside the archive, best first.
 *
 * v4 models take an arbitrary time step, which is what `-n` needs to place
 * frames at exact timestamps. The older v2/v3 models only halve intervals, so
 * they are listed as a fallback and flagged accordingly.
 */
const MODELS = [
  { id: 'rife-v4.6', dir: 'rife-v4.6', label: 'RIFE v4.6', arbitraryTimestep: true },
  { id: 'rife-v4', dir: 'rife-v4', label: 'RIFE v4', arbitraryTimestep: true },
  { id: 'rife-v3.1', dir: 'rife-v3.1', label: 'RIFE v3.1', arbitraryTimestep: false },
  { id: 'rife-v2.4', dir: 'rife-v2.4', label: 'RIFE v2.4', arbitraryTimestep: false },
  { id: 'rife-anime', dir: 'rife-anime', label: 'RIFE anime', arbitraryTimestep: false }
];

const LICENSE = {
  name: 'rife-ncnn-vulkan',
  license: 'MIT',
  url: 'https://github.com/nihui/rife-ncnn-vulkan',
  notice: 'RIFE by Zhewei Huang et al. (MIT). NCNN implementation by nihui (MIT).'
};

/** Frames above this get UHD mode; below it, full-resolution flow is fine. */
const UHD_PIXEL_THRESHOLD = 1920 * 1080 * 1.2;

function releaseFor(platform = process.platform) {
  if (platform === 'win32') return RELEASES.win32;
  if (platform === 'darwin') return RELEASES.darwin;
  return RELEASES.linux;
}

/** A model directory counts as present only if it holds real weights. */
function installedModels(engineDir) {
  const out = [];
  for (const model of MODELS) {
    const dir = path.join(engineDir, model.dir);
    try {
      const files = fs.readdirSync(dir);
      if (files.some((f) => f.endsWith('.param')) && files.some((f) => f.endsWith('.bin'))) {
        out.push({ ...model, path: dir });
      }
    } catch { /* not in this build */ }
  }
  return out;
}

/**
 * Pick a model.
 * Arbitrary-timestep models are strongly preferred: without one, only 2x, 4x
 * and other power-of-two conversions are exact.
 */
function pickModel(available, requestedId = 'auto') {
  if (!available.length) return null;
  if (requestedId && requestedId !== 'auto') {
    const exact = available.find((m) => m.id === requestedId);
    if (exact) return exact;
  }
  return available.find((m) => m.arbitraryTimestep) || available[0];
}

function shouldUseUhd(width, height) {
  return (Number(width) || 0) * (Number(height) || 0) > UHD_PIXEL_THRESHOLD;
}

/**
 * Command line for one segment of frames.
 *
 * @param {object} o
 *   inputDir   frames in, numbered from 1
 *   outputDir  frames out
 *   modelDir   absolute path to the chosen model directory
 *   frameCount exact number of frames to produce (`-n`)
 *   uhd, gpuId, threads
 */
function buildArgs({ inputDir, outputDir, modelDir, frameCount, uhd = false, gpuId = null, threads = null }) {
  const args = [
    '-i', inputDir,
    '-o', outputDir,
    '-m', modelDir,
    '-f', '%08d.png'
  ];
  if (frameCount) args.push('-n', String(frameCount));
  if (uhd) args.push('-u');
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
  pickModel,
  buildArgs,
  shouldUseUhd,
  UHD_PIXEL_THRESHOLD
};
