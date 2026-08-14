'use strict';

/**
 * AUTO CONFIGURE verification.
 *
 *   npm run verify:auto
 *
 * Pure logic - no GPU, no network, no binaries. Two engines are under test:
 *
 *   Create  - `auto-recipe.buildAutoConfigure()`, which must honour the four
 *             user locks exactly, choose the technical settings around them,
 *             and say plainly when it cannot.
 *   Watch   - `watch-auto.buildWatchAuto()`, which must configure realtime
 *             capabilities only, never reach for an offline one, and never
 *             choose a setting that switches the governor off.
 *
 * The claims worth defending are all of the form "it did not do the expensive
 * obvious thing": no upscaling a 4K master down to 1080p through a network, no
 * calling frame duplication interpolation, no Smart Reframe on a screencast,
 * no `maximum` chosen automatically on a laptop.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const autoRecipe = require(path.join(__dirname, '..', 'src', 'main', 'auto-recipe'));
const watchAuto = require(path.join(__dirname, '..', 'src', 'main', 'watch-auto'));
const recipes = require(path.join(__dirname, '..', 'src', 'main', 'recipe'));
const pipeline = require(path.join(__dirname, '..', 'src', 'main', 'jobs', 'pipeline'));

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function resolutionClass(w, h) {
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  if (long >= 3400 || short >= 1900) return '4K';
  if (long >= 2400 || short >= 1400) return '1440p';
  if (long >= 1700 || short >= 1000) return '1080p';
  if (long >= 1100 || short >= 700) return '720p';
  return '480p';
}

/**
 * A source analysis in the shape the analyser actually produces.
 * Bitrates are chosen against the real thresholds: `assessQuality()` works in
 * bits per megapixel per second normalised to 30 fps, so a "clean" 1080p30 is
 * about 8 Mbps and a "poor" 720p30 is under about 1.1 Mbps.
 */
function source({ width, height, fps, bitrate, duration = 30, hasAudio = true, codec = 'h264' }) {
  return {
    schemaVersion: 1,
    analysedAt: Date.now(),
    source: { type: 'local', path: 'C:/clip.mp4', name: 'clip.mp4' },
    container: { bitrate, duration, size: Math.round((bitrate / 8) * duration) },
    video: { width, height, nominalFps: fps, bitrate, codec, pixelFormat: 'yuv420p' },
    audio: hasAudio ? { codec: 'aac', channels: 2, sampleRate: 48000 } : null,
    color: { isHDR: false },
    derived: {
      displayWidth: width,
      displayHeight: height,
      durationSeconds: duration,
      orientation: width > height ? 'landscape' : width < height ? 'portrait' : 'square',
      isVertical: height > width,
      isHDR: false,
      isInterlaced: false,
      nominalFps: fps,
      frameRateMode: 'constant',
      resolutionClass: resolutionClass(width, height),
      hasAudio,
      megapixels: (width * height) / 1e6
    },
    warnings: []
  };
}

const CLEAN_1080P30 = source({ width: 1920, height: 1080, fps: 30, bitrate: 8e6 });
const CLEAN_1080P24 = source({ width: 1920, height: 1080, fps: 24, bitrate: 8e6 });
const COMPRESSED_720P24 = source({ width: 1280, height: 720, fps: 24, bitrate: 1.6e6 });
const POOR_480P30 = source({ width: 854, height: 480, fps: 30, bitrate: 380e3 });
const CLEAN_4K30 = source({ width: 3840, height: 2160, fps: 30, bitrate: 45e6 });
const VERTICAL_1080P30 = source({ width: 1080, height: 1920, fps: 30, bitrate: 8e6 });

/** Everything installed. Individual tests take it away to see what happens. */
const ALL_ENGINES = { realesrgan: true, rife: true, reframe: true, semanticReframe: true };
const DISCRETE = { gpuTier: 'discrete', cores: 8, memoryBytes: 16e9 };

function configure(over = {}) {
  return autoRecipe.buildAutoConfigure({
    analysis: CLEAN_1080P30,
    platform: 'custom',
    intensity: 'balanced',
    engines: ALL_ENGINES,
    machine: DISCRETE,
    outputPath: 'C:/out.mp4',
    ...over
  });
}

const unmetFor = (res, setting) => (res.unmet || []).filter((u) => u.setting === setting);
const chosen = (res) => res.summary.chose.map((c) => c.label).join(' | ');

/* ================================================================== *
 * CREATE — the locks
 * ================================================================== */

test('locks: what the user chose is what the output is', () => {
  const cases = [
    { locks: { aspect: '9:16', resolution: 'custom', width: 1080, height: 1920, fps: 60 },
      expect: { res: '1080x1920', fps: 60 } },
    { locks: { aspect: '16:9', resolution: 'custom', width: 1280, height: 720, fps: 30 },
      expect: { res: '1280x720', fps: 30 } },
    { locks: { aspect: '1:1', resolution: 'custom', width: 1080, height: 1080, fps: 24 },
      expect: { res: '1080x1080', fps: 24 } },
    { locks: { aspect: '4:5', resolution: 'custom', width: 1080, height: 1350, fps: null },
      expect: { res: '1080x1350', fps: 30 } }
  ];
  for (const c of cases) {
    const res = configure({ analysis: CLEAN_1080P30, locks: c.locks });
    assert.equal(res.decisions.outputResolution, c.expect.res,
      `${JSON.stringify(c.locks)} -> ${res.decisions.outputResolution}`);
    assert.equal(res.decisions.outputFps, c.expect.fps,
      `${JSON.stringify(c.locks)} -> ${res.decisions.outputFps} fps`);
    assert.equal(unmetFor(res, 'resolution').length, 0);
  }
});

test('locks: a locked frame rate is never quietly halved', () => {
  // The failure this exists to prevent: asking for 60, getting 30, and finding
  // out from the file.
  for (const engines of [ALL_ENGINES, { ...ALL_ENGINES, rife: false }]) {
    const res = configure({
      analysis: COMPRESSED_720P24,
      engines,
      locks: { aspect: 'source', resolution: 'source', fps: 60 }
    });
    assert.equal(res.decisions.outputFps, 60,
      `rife=${engines.rife}: got ${res.decisions.outputFps}`);
    assert.equal(res.recipe.output.fps, 60);
  }
});

test('locks: an explicit "same as source" is honoured as an answer', () => {
  const res = configure({
    analysis: CLEAN_1080P30,
    platform: 'youtube',   // a platform that would otherwise impose 1920x1080
    locks: { aspect: 'source', resolution: 'source', fps: null }
  });
  assert.equal(res.decisions.outputResolution, '1920x1080');
  assert.equal(res.recipe.framing.enabled, false, 'source shape must not be reframed');
});

/* ================================================================== *
 * CREATE — resolution
 * ================================================================== */

test('resolution: 1080p in, 1080p out, source rate — nothing is done for its own sake', () => {
  const res = configure({
    analysis: CLEAN_1080P30,
    locks: { aspect: 'source', resolution: 'source', fps: null }
  });
  assert.notEqual(res.recipe.reconstruction.mode, 'neural',
    'a clean 1080p master must not be run through a network to stay 1080p');
  assert.equal(res.recipe.motion.interpolation, 'none');
  assert.equal(res.decisions.outputFps, 30);
  assert.equal(res.decisions.outputResolution, '1920x1080');
  assert.ok(['fast', 'moderate'].includes(res.cost), `cost was ${res.cost}`);
});

test('resolution: 720p to 1080p on a compressed source reaches for reconstruction', () => {
  const res = configure({
    analysis: COMPRESSED_720P24,
    locks: { aspect: 'source', resolution: 'custom', width: 1920, height: 1080, fps: null }
  });
  assert.equal(res.recipe.reconstruction.mode, 'neural', chosen(res));
  assert.equal(res.recipe.reconstruction.aiMode, 'upscale');
  assert.equal(res.recipe.reconstruction.aiScale, 2, 'a 1.5x climb does not need a 4x network');
  assert.equal(res.decisions.outputResolution, '1920x1080');
});

test('resolution: 720p to 1080p on a clean source resamples rather than inventing detail', () => {
  const clean720 = source({ width: 1280, height: 720, fps: 30, bitrate: 6e6 });
  const res = configure({
    analysis: clean720,
    locks: { aspect: 'source', resolution: 'custom', width: 1920, height: 1080, fps: null }
  });
  assert.equal(res.recipe.reconstruction.mode, 'classical', chosen(res));
  assert.ok(res.explanations.some((e) => /invent detail/i.test(e)), res.explanations.join(' | '));
});

test('resolution: 4K down to 1080p never runs an upscaler the resize would throw away', () => {
  const res = configure({
    analysis: CLEAN_4K30,
    locks: { aspect: 'source', resolution: 'custom', width: 1920, height: 1080, fps: null }
  });
  assert.notEqual(res.recipe.reconstruction.mode, 'neural');
  assert.equal(res.decisions.downscales, true);
  assert.equal(res.decisions.outputResolution, '1920x1080');
  assert.ok(res.explanations.some((e) => /downscal/i.test(e)), res.explanations.join(' | '));
});

test('resolution: a heavily compressed source is repaired even when it is not being enlarged', () => {
  const res = configure({
    analysis: POOR_480P30,
    intensity: 'balanced',
    locks: { aspect: 'source', resolution: 'source', fps: null }
  });
  assert.equal(res.recipe.restore.enabled, true, 'compression cleanup should be on');
  assert.equal(res.recipe.reconstruction.aiMode, 'restore');
  assert.equal(res.decisions.outputResolution, '854x480', 'restore must not change the size');
});

/* ================================================================== *
 * CREATE — frame rate
 * ================================================================== */

test('fps: 24 to 60 uses RIFE when RIFE is installed', () => {
  const res = configure({
    analysis: COMPRESSED_720P24,
    locks: { aspect: 'source', resolution: 'source', fps: 60 }
  });
  assert.equal(res.recipe.motion.interpolation, 'ai');
  assert.equal(res.recipe.motion.enabled, true);
  assert.equal(res.decisions.outputFps, 60);
  assert.equal(unmetFor(res, 'fps').length, 0);
  assert.ok(/RIFE/.test(chosen(res)), chosen(res));
});

test('fps: 24 to 60 without RIFE says so, and never calls duplication interpolation', () => {
  const res = configure({
    analysis: COMPRESSED_720P24,
    engines: { ...ALL_ENGINES, rife: false },
    locks: { aspect: 'source', resolution: 'source', fps: 60 }
  });
  const unmet = unmetFor(res, 'fps');
  assert.equal(unmet.length, 1, JSON.stringify(res.unmet));
  assert.match(unmet[0].reason, /RIFE/);
  assert.match(unmet[0].action, /Install RIFE/i);
  assert.equal(res.recipe.motion.interpolation, 'duplicate');
  assert.equal(res.decisions.outputFps, 60, 'the lock still stands');
  // The summary must not describe repetition as interpolation.
  const line = res.summary.chose.find((c) => /Rate change/.test(c.label));
  assert.ok(line, chosen(res));
  assert.match(line.detail, /not interpolated/i);
  assert.match(line.detail, /not installed/i);
  assert.ok(!/RIFE interpolation/.test(chosen(res)), chosen(res));
});

test('fps: a small cadence change takes the cheap truthful path by default', () => {
  // 24 -> 30 repeats one frame in four. RIFE is charged on every output frame
  // either way, so at a 1.25x change a Balanced default should not pay it.
  const res = configure({
    analysis: CLEAN_1080P24,
    intensity: 'balanced',
    locks: { aspect: 'source', resolution: 'source', fps: 30 }
  });
  assert.equal(res.decisions.outputFps, 30, 'the lock is met either way');
  assert.equal(res.recipe.motion.interpolation, 'duplicate', chosen(res));
  assert.equal(res.decisions.interpolationDeclined, true);
  assert.equal(unmetFor(res, 'fps').length, 0, 'nothing was refused; this was a choice');
  // It must not claim a missing engine that is installed, and must not call
  // repetition interpolation.
  const line = res.summary.chose.find((c) => /Rate change/.test(c.label));
  assert.ok(line, chosen(res));
  assert.match(line.detail, /not interpolated/);
  assert.ok(!/RIFE is not installed/.test(line.detail), line.detail);
  assert.ok(res.explanations.some((e) => /raise the Auto intensity/i.test(e)),
    res.explanations.join(' | '));
});

test('fps: a large cadence change is where RIFE earns its cost', () => {
  for (const [srcFps, wanted, expected] of [
    [24, 30, 'duplicate'],   // 1.25x
    [25, 30, 'duplicate'],   // 1.20x
    [30, 40, 'duplicate'],   // 1.33x
    [24, 48, 'ai'],          // 2.00x
    [24, 60, 'ai'],          // 2.50x
    [30, 50, 'ai'],          // 1.67x
    [30, 60, 'ai']           // 2.00x
  ]) {
    const analysis = source({ width: 1920, height: 1080, fps: srcFps, bitrate: 12e6 });
    const res = configure({
      analysis, intensity: 'balanced',
      locks: { aspect: 'source', resolution: 'source', fps: wanted }
    });
    assert.equal(res.recipe.motion.interpolation, expected,
      `${srcFps} -> ${wanted} chose ${res.recipe.motion.interpolation}`);
    assert.equal(res.decisions.outputFps, wanted);
  }
});

test('fps: asking for more effort buys the network at any cadence change', () => {
  for (const intensity of ['strong', 'maximum']) {
    const res = configure({
      analysis: CLEAN_1080P24,
      intensity,
      locks: { aspect: 'source', resolution: 'source', fps: 30 }
    });
    assert.equal(res.recipe.motion.interpolation, 'ai', `${intensity}: ${chosen(res)}`);
  }
});

test('fps: a declined network is never confused with a missing one', () => {
  const withRife = configure({
    analysis: CLEAN_1080P24,
    locks: { aspect: 'source', resolution: 'source', fps: 30 }
  });
  const withoutRife = configure({
    analysis: CLEAN_1080P24,
    engines: { ...ALL_ENGINES, rife: false },
    locks: { aspect: 'source', resolution: 'source', fps: 30 }
  });
  assert.equal(withRife.recipe.motion.interpolation, 'duplicate');
  assert.equal(withoutRife.recipe.motion.interpolation, 'duplicate');
  assert.equal(unmetFor(withRife, 'fps').length, 0);
  assert.equal(unmetFor(withoutRife, 'fps').length, 1);
  const a = withRife.summary.chose.find((c) => /Rate change/.test(c.label)).detail;
  const b = withoutRife.summary.chose.find((c) => /Rate change/.test(c.label)).detail;
  assert.notEqual(a, b, 'the two situations must not read identically');
  assert.match(b, /not installed/);
});

test('fps: 60 to 30 is a rate conversion, not an interpolation problem', () => {
  const sixty = source({ width: 1920, height: 1080, fps: 60, bitrate: 14e6 });
  const res = configure({
    analysis: sixty,
    locks: { aspect: 'source', resolution: 'source', fps: 30 }
  });
  assert.equal(res.recipe.motion.interpolation, 'none');
  assert.equal(res.decisions.outputFps, 30);
  assert.ok(res.explanations.some((e) => /No frames are invented/i.test(e)),
    res.explanations.join(' | '));
});

test('fps: asking for the rate the source already has does nothing at all', () => {
  const res = configure({
    analysis: CLEAN_1080P24,
    locks: { aspect: 'source', resolution: 'source', fps: 24 }
  });
  assert.equal(res.recipe.motion.interpolation, 'none');
  assert.equal(res.recipe.motion.enabled, false);
  assert.equal(res.decisions.outputFps, 24);
});

/* ================================================================== *
 * CREATE — framing
 * ================================================================== */

test('framing: 16:9 into 9:16 makes a framing decision rather than stretching', () => {
  const res = configure({
    analysis: CLEAN_1080P30,
    locks: { aspect: '9:16', resolution: 'custom', width: 1080, height: 1920, fps: null }
  });
  assert.equal(res.recipe.framing.enabled, true);
  assert.equal(res.recipe.framing.canvas, '9:16');
  assert.equal(res.recipe.framing.mode, 'fill');
  assert.equal(res.recipe.framing.tracking, 'auto', 'Smart Reframe should be chosen here');
  assert.notEqual(res.recipe.framing.mode, 'stretch');
  assert.equal(res.decisions.outputResolution, '1080x1920');
});

test('framing: without the detector, Smart Reframe says which signal it really uses', () => {
  const res = configure({
    analysis: CLEAN_1080P30,
    engines: { ...ALL_ENGINES, semanticReframe: false },
    locks: { aspect: '9:16', resolution: 'custom', width: 1080, height: 1920, fps: null }
  });
  assert.equal(res.recipe.framing.tracking, 'auto', 'saliency tracking still works');
  assert.equal(res.decisions.semanticTracking, false);
  assert.ok(res.explanations.some((e) => /not installed.*motion and detail/i.test(e)),
    res.explanations.join(' | '));
  const line = res.summary.chose.find((c) => /Smart Reframe/.test(c.label));
  assert.match(line.label, /motion \+ detail/);
});

test('framing: with the detector, the claim upgrades to face and person', () => {
  const res = configure({
    analysis: CLEAN_1080P30,
    locks: { aspect: '9:16', resolution: 'custom', width: 1080, height: 1920, fps: null }
  });
  assert.equal(res.decisions.semanticTracking, true);
  const line = res.summary.chose.find((c) => /Smart Reframe/.test(c.label));
  assert.match(line.label, /face \+ person/);
});

test('framing: Smart Reframe is not switched on for content it is wrong for', () => {
  // A screencast has no subject moving inside the frame; the frame is the
  // subject, and a tracked crop would cut off the thing being demonstrated.
  const res = configure({
    analysis: CLEAN_1080P30,
    profile: 'screencast',
    locks: { aspect: '9:16', resolution: 'custom', width: 1080, height: 1920, fps: null }
  });
  assert.notEqual(res.recipe.framing.tracking, 'auto', chosen(res));
  assert.equal(res.recipe.framing.mode, 'fit');
  assert.ok(res.explanations.some((e) => /screen content/i.test(e)), res.explanations.join(' | '));
});

test('framing: with no reframe backend at all, the fallback is stated not hidden', () => {
  const res = configure({
    analysis: CLEAN_1080P30,
    engines: { ...ALL_ENGINES, reframe: false, semanticReframe: false },
    locks: { aspect: '9:16', resolution: 'custom', width: 1080, height: 1920, fps: null }
  });
  assert.equal(res.recipe.framing.tracking, 'center');
  assert.equal(unmetFor(res, 'framing').length, 1, JSON.stringify(res.unmet));
});

test('framing: a vertical source going to a vertical canvas is not cropped for nothing', () => {
  const res = configure({
    analysis: VERTICAL_1080P30,
    locks: { aspect: '9:16', resolution: 'custom', width: 1080, height: 1920, fps: null }
  });
  assert.equal(res.recipe.framing.mode, 'fit');
  assert.equal(res.recipe.framing.tracking, 'none');
});

/* ================================================================== *
 * CREATE — enhancement availability
 * ================================================================== */

test('engines: without Real-ESRGAN the climb is classical and the user is told why', () => {
  const res = configure({
    analysis: COMPRESSED_720P24,
    engines: { ...ALL_ENGINES, realesrgan: false },
    locks: { aspect: 'source', resolution: 'custom', width: 1920, height: 1080, fps: null }
  });
  assert.equal(res.recipe.reconstruction.mode, 'classical');
  assert.equal(res.decisions.outputResolution, '1920x1080', 'the lock is still met');
  const unmet = unmetFor(res, 'enhancement');
  assert.equal(unmet.length, 1, JSON.stringify(res.unmet));
  assert.match(unmet[0].reason, /Real-ESRGAN/);
});

test('engines: Auto never claims a capability the machine does not have', () => {
  const res = configure({
    analysis: COMPRESSED_720P24,
    engines: { realesrgan: false, rife: false, reframe: false, semanticReframe: false },
    locks: { aspect: '9:16', resolution: 'custom', width: 1080, height: 1920, fps: 60 }
  });
  const text = [chosen(res), ...res.explanations].join(' | ');
  assert.ok(!/RIFE interpolation/.test(text), text);
  assert.ok(!/face \+ person/.test(text), text);
  assert.notEqual(res.recipe.reconstruction.mode, 'neural');
  assert.notEqual(res.recipe.motion.interpolation, 'ai');
});

/* ================================================================== *
 * CREATE — cost
 * ================================================================== */

test('cost: a modest machine does not get the expensive inference path by default', () => {
  const res = configure({
    analysis: POOR_480P30,
    intensity: 'strong',
    machine: { gpuTier: 'integrated', cores: 4, memoryBytes: 8e9 },
    locks: { aspect: 'source', resolution: 'custom', width: 1920, height: 1080, fps: null }
  });
  assert.equal(res.recipe.reconstruction.aiQuality, 'balanced', chosen(res));
  assert.ok(res.explanations.some((e) => /no discrete GPU/i.test(e)), res.explanations.join(' | '));
});

test('cost: a long source is not multiplied by the slowest path', () => {
  const long = source({ width: 854, height: 480, fps: 30, bitrate: 380e3, duration: 45 * 60 });
  const res = configure({
    analysis: long,
    intensity: 'strong',
    locks: { aspect: 'source', resolution: 'custom', width: 1920, height: 1080, fps: null }
  });
  assert.equal(res.recipe.reconstruction.aiQuality, 'balanced');
  assert.ok(res.explanations.some((e) => /minutes/i.test(e)), res.explanations.join(' | '));
});

test('cost: "maximum" is only ever reached by asking for it', () => {
  const analyses = [CLEAN_1080P30, CLEAN_1080P24, COMPRESSED_720P24, POOR_480P30, CLEAN_4K30];
  for (const analysis of analyses) {
    for (const intensity of ['light', 'balanced', 'strong']) {
      const res = configure({
        analysis,
        intensity,
        locks: { aspect: '9:16', resolution: 'custom', width: 1080, height: 1920, fps: 60 }
      });
      assert.notEqual(res.recipe.reconstruction.aiQuality, 'maximum',
        `${analysis.derived.resolutionClass} at ${intensity}`);
    }
  }
  const asked = configure({
    analysis: COMPRESSED_720P24,
    intensity: 'maximum',
    locks: { aspect: 'source', resolution: 'custom', width: 1920, height: 1080, fps: null }
  });
  assert.equal(asked.recipe.reconstruction.aiQuality, 'maximum');
});

test('cost: a Balanced default does not resolve to an hour of GPU time for six seconds', () => {
  // The real case this rule exists for, measured on the reference machine: a
  // six-second 720p clip to 1080x1920 at 60 fps resolved to x4 inference plus
  // RIFE — about an hour. Every decision was defensible; their product was not.
  const short = source({ width: 1280, height: 720, fps: 24, bitrate: 400e3, duration: 6 });
  const res = configure({
    analysis: short,
    intensity: 'balanced',
    locks: { aspect: '9:16', resolution: 'custom', width: 1080, height: 1920, fps: 60 }
  });
  assert.equal(res.decisions.outputResolution, '1080x1920', 'the lock is not traded for speed');
  assert.equal(res.decisions.outputFps, 60, 'the lock is not traded for speed');
  assert.ok(res.recipe.reconstruction.aiScale <= 2,
    `neural scale was ${res.recipe.reconstruction.aiScale}`);
  const seconds = autoRecipe.estimateJobSeconds({
    recipe: res.recipe,
    geometry: { sourceWidth: 1280, sourceHeight: 720, sourceFps: 24, width: 1080, height: 1920, fps: 60 },
    analysis: short
  });
  assert.ok(seconds < 3600, `${seconds}s for a six-second clip`);
});

test('cost: raising the intensity buys back the expensive path', () => {
  const short = source({ width: 1280, height: 720, fps: 24, bitrate: 400e3, duration: 6 });
  const locks = { aspect: '9:16', resolution: 'custom', width: 1080, height: 1920, fps: 60 };
  const balanced = configure({ analysis: short, intensity: 'balanced', locks });
  const maximum = configure({ analysis: short, intensity: 'maximum', locks });
  assert.ok(maximum.recipe.reconstruction.aiScale >= balanced.recipe.reconstruction.aiScale);
  assert.equal(maximum.recipe.reconstruction.aiQuality, 'maximum');
});

test('cost: Auto and the queue measure the same job the same way', () => {
  // Auto's own figure is superseded by the resolved plan, but the two must be
  // in the same units and the same order of magnitude - otherwise Auto makes
  // proportionality decisions against a number describing no real machine.
  const short = source({ width: 1280, height: 720, fps: 24, bitrate: 400e3, duration: 6 });
  const geometry = {
    sourceWidth: 1280, sourceHeight: 720, sourceFps: 24, width: 1080, height: 1920, fps: 60
  };
  const recipe = recipes.sanitize({
    output: { path: 'out.mp4', fps: 60 },
    reconstruction: { enabled: true, mode: 'neural', aiMode: 'upscale', aiScale: 4,
      aiQuality: 'balanced', model: 'general' },
    motion: { enabled: true, interpolation: 'ai', targetFps: 60 },
    framing: { enabled: true, canvas: '9:16', width: 1080, height: 1920, mode: 'fill', tracking: 'auto' }
  }).recipe;

  const ours = autoRecipe.estimateJobSeconds({ recipe, geometry, analysis: short });
  const theirs = pipeline.estimatePlanCost({
    stages: [{ id: 'REFRAME', mode: 'pass' }],
    geometry,
    aiPlan: {
      upscale: { model: { name: 'realesrgan-x4plus' }, inferenceScale: 4, preScale: 1 },
      interpolate: { model: { label: 'v4.6' } }
    },
    durationSeconds: 6
  });
  const ratio = ours / theirs.seconds;
  assert.ok(ratio > 0.6 && ratio < 1.6,
    `auto ${ours}s vs queue ${theirs.seconds}s (ratio ${ratio.toFixed(2)})`);
});

test('quality: a modern codec is not judged by H.264 thresholds', () => {
  // A real 1440p60 VP9 rendition off YouTube: 6 Mbps. Judged as H.264 that is
  // "heavily compressed", and Auto then reached for restoration and a network
  // on a healthy stream.
  const vp9 = source({ width: 2560, height: 1440, fps: 60, bitrate: 5.97e6, codec: 'vp9' });
  const h264 = source({ width: 2560, height: 1440, fps: 60, bitrate: 5.97e6, codec: 'h264' });
  const a = autoRecipe.assessQuality(vp9);
  const b = autoRecipe.assessQuality(h264);
  assert.equal(b.level, 'poor', 'the same bitrate in H.264 really is starved');
  assert.notEqual(a.level, 'poor', `VP9 was judged ${a.level} at ${a.bitsPerMpxPerS}`);
  assert.ok(a.bitsPerMpxPerS > b.bitsPerMpxPerS);
  assert.equal(a.codecEfficiency, 1.6);
  // AV1 gets more credit again, and an ancient codec gets less.
  assert.ok(autoRecipe.assessQuality(
    source({ width: 1920, height: 1080, fps: 30, bitrate: 3e6, codec: 'av01.0.08M.08' })
  ).bitsPerMpxPerS > autoRecipe.assessQuality(
    source({ width: 1920, height: 1080, fps: 30, bitrate: 3e6, codec: 'mpeg2video' })
  ).bitsPerMpxPerS);
});

test('geometry: how far the picture is enlarged is measured after the crop', () => {
  // 2560x1440 to 1080x1920 keeps the full height and loses most of the width:
  // a 1.33x enlargement, not the 2x the raw dimensions suggest. Reading it as
  // 2x is what put a super-resolution network on a stream that needed none.
  const wide = source({ width: 2560, height: 1440, fps: 60, bitrate: 5.97e6, codec: 'vp9', duration: 635 });
  const res = configure({
    analysis: wide,
    locks: { aspect: '9:16', resolution: 'custom', width: 1080, height: 1920, fps: null }
  });
  assert.equal(res.decisions.outputResolution, '1080x1920');
  assert.equal(res.recipe.framing.tracking, 'auto', 'it is still a tracked crop');
  assert.notEqual(res.recipe.reconstruction.mode, 'neural',
    `chose ${chosen(res)} for a 1.33x enlargement of a ten-minute source`);
});

test('cost: a marginal enlargement does not justify a very heavy neural pass', () => {
  // The real case: ten minutes of 1440p to 1080x1920 resolved to 136 hours of
  // inference for a 1.33x enlargement.
  const long = source({ width: 2560, height: 1440, fps: 60, bitrate: 2.4e6, codec: 'h264', duration: 635 });
  const res = configure({
    analysis: long,
    intensity: 'balanced',
    locks: { aspect: '9:16', resolution: 'custom', width: 1080, height: 1920, fps: null }
  });
  assert.notEqual(res.recipe.reconstruction.mode, 'neural', chosen(res));
  assert.equal(res.decisions.outputResolution, '1080x1920', 'the lock is still met');
  assert.ok(res.explanations.some((e) => /not a Balanced trade/i.test(e)),
    res.explanations.join(' | '));

  // A real enlargement keeps the network, however long the job is.
  const climbs = source({ width: 854, height: 480, fps: 30, bitrate: 700e3, duration: 635 });
  const kept = configure({
    analysis: climbs,
    intensity: 'balanced',
    locks: { aspect: 'source', resolution: 'custom', width: 1920, height: 1080, fps: null }
  });
  assert.equal(kept.recipe.reconstruction.mode, 'neural', chosen(kept));
  assert.ok(kept.warnings.some((w) => /very heavy render/i.test(w)), kept.warnings.join(' | '));
});

test('cost: every result carries a class, and a neural job is never called fast', () => {
  const res = configure({
    analysis: COMPRESSED_720P24,
    locks: { aspect: 'source', resolution: 'custom', width: 1920, height: 1080, fps: null }
  });
  assert.ok(autoRecipe.COST.includes(res.cost), res.cost);
  assert.notEqual(res.cost, 'fast');
  assert.equal(res.summary.costLabel, autoRecipe.COST_LABEL[res.cost]);
});

/* ================================================================== *
 * CREATE — re-running Auto
 * ================================================================== */

test('re-auto: changing the resolution changes the non-locked decisions around it', () => {
  const locks = { aspect: 'source', resolution: 'custom', width: 1920, height: 1080, fps: null };
  const first = configure({ analysis: COMPRESSED_720P24, locks });
  assert.equal(first.recipe.reconstruction.mode, 'neural');

  const second = configure({
    analysis: COMPRESSED_720P24,
    locks: { ...locks, width: 1280, height: 720 }
  });
  assert.equal(second.decisions.outputResolution, '1280x720');
  assert.ok(second.recipe.reconstruction.mode !== 'neural' ||
    second.recipe.reconstruction.aiMode === 'restore',
  'no climb means no upscaling network');
  assert.notEqual(first.decisions.outputResolution, second.decisions.outputResolution);
});

test('re-auto: the same inputs produce the same answer', () => {
  const locks = { aspect: '9:16', resolution: 'custom', width: 1080, height: 1920, fps: 60 };
  const a = configure({ analysis: COMPRESSED_720P24, locks });
  const b = configure({ analysis: COMPRESSED_720P24, locks });
  assert.deepEqual(a.decisions, b.decisions);
  assert.deepEqual(a.summary.chose, b.summary.chose);
});

/* ================================================================== *
 * CREATE — the summary is a readout, not a wish
 * ================================================================== */

test('summary: every claimed decision is actually in the recipe', () => {
  const res = configure({
    analysis: COMPRESSED_720P24,
    locks: { aspect: '9:16', resolution: 'custom', width: 1080, height: 1920, fps: 60 }
  });
  const labels = chosen(res);
  if (/Neural/.test(labels)) assert.equal(res.recipe.reconstruction.mode, 'neural');
  if (/RIFE interpolation/.test(labels)) assert.equal(res.recipe.motion.interpolation, 'ai');
  if (/Smart Reframe/.test(labels)) assert.equal(res.recipe.framing.tracking, 'auto');
  if (/Creator master/.test(labels)) assert.equal(res.recipe.audio.master, 'creator');
  assert.ok(res.summary.source.label.length > 0);
  assert.equal(res.summary.output.label.includes('1080×1920'), true, res.summary.output.label);
});

test('summary: a source with no audio is not given an audio decision', () => {
  const silent = source({ width: 1920, height: 1080, fps: 30, bitrate: 8e6, hasAudio: false });
  const res = configure({
    analysis: silent,
    locks: { aspect: 'source', resolution: 'source', fps: null }
  });
  assert.equal(res.recipe.audio.enabled, false);
  assert.ok(!/master/i.test(chosen(res)), chosen(res));
});

test('summary: nothing switched on produces no invented entries', () => {
  const res = configure({
    analysis: CLEAN_1080P24,
    intensity: 'light',
    locks: { aspect: 'source', resolution: 'source', fps: null }
  });
  for (const item of res.summary.chose) {
    assert.ok(!/Neural|RIFE|Smart Reframe/.test(item.label),
      `nothing should be claimed here: ${item.label}`);
  }
});

/* ================================================================== *
 * CREATE — the old entry point still works
 * ================================================================== */

test('compatibility: buildAutoRecipe without locks behaves exactly as the platform path did', () => {
  const res = autoRecipe.buildAutoRecipe({
    analysis: CLEAN_1080P30,
    platform: 'youtube-shorts',
    engines: ALL_ENGINES,
    outputPath: 'C:/out.mp4'
  });
  assert.equal(res.recipe.framing.canvas, '9:16');
  assert.equal(res.recipe.framing.width, 1080);
  assert.equal(res.recipe.framing.height, 1920);
  assert.equal(res.decisions.outputResolution, '1080x1920');
});

/* ================================================================== *
 * WATCH
 * ================================================================== */

const LOOKS = ['off', 'balanced', 'streaming', 'anime', 'film', 'sports', 'lowlight',
  'screencast', 'vivid'];

function watch(over = {}) {
  return watchAuto.buildWatchAuto({
    analysis: CLEAN_1080P30,
    sourceKind: 'local',
    machine: { gpu: 'NVIDIA GeForce GTX 1650 Ti', cores: 8 },
    availableLooks: LOOKS,
    ...over
  });
}

test('watch: a normal clean 1080p file gets a general look and the adaptive policy', () => {
  const res = watch();
  assert.equal(res.look, 'balanced');
  assert.equal(res.quality, 'auto');
  assert.equal(res.adaptive, true);
  assert.equal(res.renderScale, 'auto');
  assert.ok(res.reasons.length > 0);
});

test('watch: a low-bitrate source gets Streaming Rescue, and says which measurement said so', () => {
  const res = watch({ analysis: POOR_480P30 });
  assert.equal(res.look, 'streaming');
  assert.ok(res.reasons.some((r) => /compressed/i.test(r)), res.reasons.join(' | '));
});

test('watch: an online stream with no reported bitrate does not pretend to know', () => {
  const unknown = source({ width: 1920, height: 1080, fps: 30, bitrate: 0 });
  unknown.container.bitrate = null;
  unknown.video.bitrate = null;
  const res = watch({ analysis: unknown, sourceKind: 'stream' });
  assert.equal(res.source.quality, 'unknown');
  assert.ok(res.warnings.some((w) => /did not report a bitrate/i.test(w)), res.warnings.join(' | '));
  assert.notEqual(res.look, 'streaming', 'an unknown bitrate is not evidence of a bad one');
});

test('watch: a cinematic file is recognised from its own cadence', () => {
  const res = watch({ analysis: CLEAN_1080P24 });
  assert.equal(res.look, 'film');
  assert.equal(res.profile, 'film');
  assert.equal(res.profileInferred, true);
});

test('watch: content the probe cannot detect is taken from the user, not guessed', () => {
  const cases = {
    animation: 'anime',
    action: 'sports',
    gaming: 'sports',
    lowlight: 'lowlight',
    screencast: 'screencast',
    film: 'film'
  };
  for (const [profile, look] of Object.entries(cases)) {
    const res = watch({ profile });
    assert.equal(res.look, look, `${profile} -> ${res.look}`);
    assert.equal(res.profileInferred, false);
  }
});

test('watch: a 4K source starts conservative rather than stuttering', () => {
  const res = watch({ analysis: CLEAN_4K30 });
  assert.equal(res.quality, 'performance');
  assert.ok(res.reasons.some((r) => /4K/.test(r)), res.reasons.join(' | '));
});

test('watch: the source is described by what it is, not by the threshold it crossed', () => {
  // The regression: a 1440p60 stream is 221 million pixels a second, which is
  // past a 4K film's rate, and the explanation called it "a 4K source".
  const cases = [
    { w: 1280, h: 720, fps: 30, label: '720p' },
    { w: 1920, h: 1080, fps: 30, label: '1080p' },
    { w: 1920, h: 1080, fps: 60, label: '1080p' },
    { w: 2560, h: 1440, fps: 60, label: '1440p' },
    { w: 3840, h: 2160, fps: 30, label: '4K' },
    // A vertical source is named by its long and short edges, not its height.
    { w: 1080, h: 1920, fps: 30, label: '1080p' }
  ];
  for (const c of cases) {
    const analysis = source({ width: c.w, height: c.h, fps: c.fps, bitrate: 12e6 });
    const res = watch({ analysis });
    assert.equal(res.source.resolutionClass, c.label,
      `${c.w}x${c.h} classified ${res.source.resolutionClass}`);
    assert.ok(res.source.label.startsWith(c.label), res.source.label);
    const said = res.reasons.join(' ');
    // Only a genuine 4K source may be called one.
    if (c.label !== '4K') {
      assert.ok(!/\ba 4K source\b/.test(said), `${c.label}: ${said}`);
      assert.ok(!new RegExp(`\\b${c.h}p\\b`).test(said) || c.label === `${c.h}p`,
        `${c.label}: named by raw height — ${said}`);
    }
    // Whatever it says, it names the class it actually measured.
    if (/pixels a second/.test(said)) {
      assert.ok(said.includes(c.label), `${c.label} missing from: ${said}`);
    }
  }
});

test('watch: a heavy source is still started conservatively, whatever it is called', () => {
  // The wording changed; the policy must not have.
  const hd1440p60 = source({ width: 2560, height: 1440, fps: 60, bitrate: 12e6 });
  const res = watch({ analysis: hd1440p60 });
  assert.equal(res.quality, 'performance');
  assert.equal(res.source.heavy, true);
  assert.ok(res.source.throughput > 3840 * 2160 * 24 * 0.9);
});

test('watch: a detected GPU is never described as absent', () => {
  // On this machine the WebGL context runs on the integrated adapter while a
  // GTX 1650 Ti is present. "No discrete adapter reported" is a claim about
  // the machine, and it is false; what is known is which device is rendering.
  const hd60 = source({ width: 1920, height: 1080, fps: 60, bitrate: 14e6 });
  const angle = 'ANGLE (Intel, Intel(R) UHD Graphics (0x00009BC4) Direct3D11 vs_5_0 ps_5_0, D3D11)';
  const res = watch({ analysis: hd60, machine: { gpu: angle, cores: 8 } });
  const said = res.reasons.join(' ');
  assert.equal(res.quality, 'performance', 'the policy is unchanged');
  assert.equal(res.source.gpu, 'Intel(R) UHD Graphics', res.source.gpu);
  assert.ok(said.includes('Intel(R) UHD Graphics'), said);
  assert.ok(!/no discrete/i.test(said), said);
  assert.ok(!/ANGLE/.test(said), 'the raw ANGLE string is not an explanation');

  // A named discrete adapter is neither called absent nor called integrated.
  const discrete = watch({
    analysis: source({ width: 1280, height: 720, fps: 30, bitrate: 6e6 }),
    machine: { gpu: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' }
  });
  assert.equal(discrete.source.gpuTier, 'discrete');
  assert.equal(discrete.source.gpu, 'NVIDIA GeForce GTX 1650 Ti');
  assert.ok(!/no discrete/i.test(discrete.reasons.join(' ')), discrete.reasons.join(' | '));
  assert.equal(discrete.quality, 'quality', 'a real GPU on a light source is allowed room');
});

test('watch: an unnamed GPU is reported as unnamed, not as missing', () => {
  const hd60 = source({ width: 1920, height: 1080, fps: 60, bitrate: 14e6 });
  const res = watch({ analysis: hd60, machine: { gpu: null } });
  const said = res.reasons.join(' ');
  assert.equal(res.source.gpu, null);
  assert.ok(/did not name/i.test(said), said);
  assert.ok(!/no discrete/i.test(said), said);
});

test('watch: high-rate 1080p on a weak GPU starts at Performance', () => {
  const hd60 = source({ width: 1920, height: 1080, fps: 60, bitrate: 14e6 });
  const weak = watch({ analysis: hd60, machine: { gpu: 'Intel(R) UHD Graphics 620', cores: 4 } });
  assert.equal(weak.quality, 'performance');
  assert.equal(weak.source.gpuTier, 'integrated');

  const strong = watch({ analysis: hd60, machine: { gpu: 'NVIDIA GeForce RTX 4070', cores: 16 } });
  assert.notEqual(strong.quality, 'performance');
});

test('watch: a small source on a real GPU is allowed to spend more', () => {
  const small = source({ width: 1280, height: 720, fps: 30, bitrate: 6e6 });
  const res = watch({ analysis: small });
  assert.equal(res.quality, 'quality');
});

test('watch: measured dropped frames outrank every guess', () => {
  const before = watch({ analysis: CLEAN_1080P30 });
  const after = watch({
    analysis: CLEAN_1080P30,
    playback: { dropRate: 14, limited: true, fps: 41 }
  });
  assert.equal(before.quality, 'auto');
  assert.equal(after.quality, 'performance');
  assert.ok(after.reasons.some((r) => /dropping/i.test(r)), after.reasons.join(' | '));
});

test('watch: Auto never chooses the setting that switches the governor off', () => {
  const analyses = [CLEAN_1080P30, CLEAN_1080P24, COMPRESSED_720P24, POOR_480P30, CLEAN_4K30];
  const gpus = ['NVIDIA GeForce RTX 4090', 'Intel(R) UHD Graphics', 'SwiftShader', null];
  for (const analysis of analyses) {
    for (const gpu of gpus) {
      for (const profile of ['auto', 'film', 'animation', 'screencast']) {
        const res = watch({ analysis, profile, machine: { gpu } });
        assert.notEqual(res.quality, 'maximum', `${gpu} / ${profile}`);
        assert.equal(res.adaptive, true, `${gpu} / ${profile}`);
      }
    }
  }
});

test('watch: Auto configures realtime capabilities and nothing else', () => {
  const res = watch({ analysis: COMPRESSED_720P24, profile: 'animation' });
  const keys = Object.keys(res).sort();
  assert.deepEqual(keys, ['adaptive', 'look', 'lookLabel', 'profile', 'profileInferred',
    'quality', 'renderScale', 'reasons', 'source', 'warnings'].sort());
  // Nothing offline may appear here in any form: Watch has no RIFE, no
  // Real-ESRGAN, no reframe and no encoder.
  const serialised = JSON.stringify(res);
  const forbidden = ['aiScale', 'aiQuality', 'interpolation', 'framing', 'targetFps',
    'encoder', 'container', 'recipe'];
  for (const key of forbidden) {
    assert.ok(!serialised.includes(key), `${key} must not appear in a Watch decision`);
  }
});

test('watch: a Look this build does not have is never selected', () => {
  const res = watch({ profile: 'animation', availableLooks: ['off', 'balanced', 'film'] });
  assert.equal(res.look, 'balanced');
  assert.ok(res.warnings.some((w) => /not available/i.test(w)), res.warnings.join(' | '));
});

test('watch: every chosen Look is a real Look and every policy a real policy', () => {
  const policies = ['auto', 'performance', 'balanced', 'quality', 'maximum'];
  for (const analysis of [CLEAN_1080P30, COMPRESSED_720P24, CLEAN_4K30, VERTICAL_1080P30]) {
    const res = watch({ analysis });
    assert.ok(LOOKS.includes(res.look), res.look);
    assert.ok(policies.includes(res.quality), res.quality);
    assert.ok(res.renderScale === 'auto' || Number(res.renderScale) > 0, String(res.renderScale));
  }
});

test('watch: with no source analysed at all it still answers, conservatively', () => {
  const res = watch({ analysis: null });
  assert.equal(res.look, 'balanced');
  assert.equal(res.quality, 'auto');
  assert.equal(res.adaptive, true);
});

test('watch: GPU classification does not flatter unknown hardware', () => {
  assert.equal(watchAuto.classifyGpu('NVIDIA GeForce GTX 1650 Ti'), 'discrete');
  assert.equal(watchAuto.classifyGpu('AMD Radeon RX 6600'), 'discrete');
  assert.equal(watchAuto.classifyGpu('Intel(R) Iris(R) Xe Graphics'), 'integrated');
  assert.equal(watchAuto.classifyGpu('Google SwiftShader'), 'none');
  assert.equal(watchAuto.classifyGpu(''), 'unknown');
  assert.equal(watchAuto.classifyGpu(null), 'unknown');
});

/* ================================================================== *
 * INDEPENDENCE
 * ================================================================== */

test('independence: a Watch decision cannot alter a Create recipe', () => {
  const locks = { aspect: '9:16', resolution: 'custom', width: 1080, height: 1920, fps: 60 };
  const before = configure({ analysis: COMPRESSED_720P24, locks });
  watch({ analysis: CLEAN_4K30, profile: 'screencast', playback: { dropRate: 40, limited: true } });
  const after = configure({ analysis: COMPRESSED_720P24, locks });
  assert.deepEqual(before.recipe, after.recipe);
  assert.deepEqual(before.decisions, after.decisions);
});

test('independence: a Create decision cannot alter a Watch decision', () => {
  const before = watch({ analysis: CLEAN_1080P30 });
  configure({
    analysis: CLEAN_4K30,
    intensity: 'maximum',
    locks: { aspect: '1:1', resolution: 'custom', width: 1080, height: 1080, fps: 120 }
  });
  const after = watch({ analysis: CLEAN_1080P30 });
  assert.deepEqual(before, after);
});
