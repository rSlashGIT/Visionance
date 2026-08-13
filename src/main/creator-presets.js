'use strict';

/**
 * Creator export presets.
 *
 * Production-oriented starting points, so a user does not have to understand
 * encoder flags to publish something. Each one is a small set of recipe
 * overrides applied on top of the source-aware defaults - never a frozen
 * recipe, because canvas and frame rate depend on what the source actually is.
 *
 * These are only *starting points*. Everything stays editable, and Advanced
 * still exposes the underlying fields.
 */

const recipes = require('./recipe');

/**
 * `overrides` is a function of the analysis so a preset can adapt: a Short from
 * a 60 fps source should stay 60, and one from a 24 fps film should not be
 * dragged up to 60 just because the platform allows it.
 */
const PRESETS = [
  {
    id: 'shorts-quality',
    label: 'YouTube Short — Quality',
    platform: 'youtube-shorts',
    description: '1080x1920, smart crop, loudness-matched audio.',
    overrides: () => ({
      framing: { enabled: true, canvas: '9:16', width: 1080, height: 1920, mode: 'fill', tracking: 'auto' },
      audio: { master: 'creator', bitrateKbps: 256 },
      output: { quality: 78, faststart: true }
    })
  },
  {
    id: 'reel-quality',
    label: 'Instagram Reel — Quality',
    platform: 'instagram-reels',
    description: '1080x1920, smart crop, loudness-matched audio.',
    overrides: () => ({
      framing: { enabled: true, canvas: '9:16', width: 1080, height: 1920, mode: 'fill', tracking: 'auto' },
      audio: { master: 'creator', bitrateKbps: 256 },
      output: { quality: 78, faststart: true }
    })
  },
  {
    id: 'feed-quality',
    label: 'Instagram Feed — Quality',
    platform: 'instagram-feed',
    description: '1080x1350 (4:5), smart crop, loudness-matched audio.',
    overrides: () => ({
      framing: { enabled: true, canvas: '4:5', width: 1080, height: 1350, mode: 'fill', tracking: 'auto' },
      audio: { master: 'creator', bitrateKbps: 256 },
      output: { quality: 78, faststart: true }
    })
  },
  {
    id: 'youtube-1080p',
    label: 'YouTube 1080p',
    platform: 'youtube',
    description: '1920x1080, source frame rate preserved.',
    overrides: () => ({
      framing: { enabled: false, canvas: 'source' },
      reconstruction: {
        enabled: true, mode: 'classical',
        targetResolution: { mode: 'custom', width: 1920, height: 1080 }
      },
      audio: { master: 'normalize', bitrateKbps: 384 },
      output: { quality: 76, faststart: true }
    })
  },
  {
    id: 'youtube-1440p',
    label: 'YouTube 1440p',
    platform: 'youtube',
    description: '2560x1440 for a sharper YouTube transcode.',
    overrides: () => ({
      framing: { enabled: false, canvas: 'source' },
      reconstruction: {
        enabled: true, mode: 'classical',
        targetResolution: { mode: 'custom', width: 2560, height: 1440 }
      },
      audio: { master: 'normalize', bitrateKbps: 384 },
      output: { quality: 80, faststart: true }
    })
  },
  {
    id: 'youtube-4k',
    label: 'YouTube 4K',
    platform: 'youtube-4k',
    description: '3840x2160. YouTube gives 4K uploads a better bitrate.',
    overrides: () => ({
      framing: { enabled: false, canvas: 'source' },
      reconstruction: {
        enabled: true, mode: 'classical',
        targetResolution: { mode: 'custom', width: 3840, height: 2160 }
      },
      audio: { master: 'normalize', bitrateKbps: 384 },
      output: { quality: 82, faststart: true }
    })
  },
  {
    id: 'master',
    label: 'High Quality Master',
    platform: 'custom',
    description: 'Source geometry, high bitrate, audio untouched. For archiving or re-editing.',
    overrides: () => ({
      framing: { enabled: false, canvas: 'source' },
      reconstruction: { enabled: false, targetResolution: { mode: 'source' } },
      audio: { master: 'preserve', bitrateKbps: 384 },
      output: { quality: 92, preset: 'slow', faststart: true }
    })
  }
];

function list() {
  return PRESETS.map(({ id, label, platform, description }) => ({ id, label, platform, description }));
}

function get(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

/**
 * Build a recipe from a preset.
 *
 * @param {string} id
 * @param {object} o { analysis, outputPath, extra }
 * @returns {object} a sanitised recipe
 */
function apply(id, { analysis = null, outputPath = null, extra = {} } = {}) {
  const preset = get(id);
  if (!preset) throw new Error(`Unknown creator preset: ${id}`);

  const base = recipes.applyPlatform(
    recipes.defaultRecipe(analysis, {}),
    preset.platform
  );

  const merged = recipes.deepMerge(
    recipes.deepMerge(base, preset.overrides(analysis) || {}),
    recipes.deepMerge({ output: { path: outputPath, platform: preset.platform } }, extra)
  );

  const { recipe } = recipes.sanitize(merged);

  // A preset must never drag a 24 fps film up to 60 just because the platform
  // permits it. Frame rate stays whatever the source authored unless the user
  // explicitly asks for a change.
  recipe.output.fps = extra && extra.output && extra.output.fps !== undefined
    ? extra.output.fps
    : null;
  recipe.motion.enabled = !!(extra && extra.motion && extra.motion.enabled);

  return recipes.sanitize(recipe).recipe;
}

module.exports = { list, get, apply, PRESETS };
