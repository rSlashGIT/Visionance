'use strict';

/**
 * Framing, aspect and resolution regressions.
 *
 *   npm run verify:framing
 *
 * Written from one real failed render. A 12-second clip was asked for 21:9,
 * 2K, 60 fps through Auto Configure and produced a file that probed as
 *
 *     H.264  2560x1080  SAR 1:1  DAR 64:27  60 fps  721 frames  AAC stereo
 *
 * — correct by every check that existed — whose *visible* content was a
 * 1920x1080 16:9 picture with 320 px of black either side. An ultrawide
 * container around a 16:9 picture is not an ultrawide conversion, and the
 * requested 2K was not delivered either: the picture was still 1920 wide.
 *
 * Three defects met there, and each has its own group below:
 *
 *   1. Auto only ever considered cropping when the source was the *wider*
 *      shape, so a widening conversion fell through to `fit`.
 *   2. `fill` cropped width only, so on a widening conversion it was a no-op
 *      and the scale that followed simply stretched the frame.
 *   3. The neural encode could not express the blurred-background composite in
 *      a flat `-vf` chain and quietly substituted black bars — which is why a
 *      summary reading "Fit blurred" produced solid black ones.
 *
 * And a fourth group for the reason it shipped: verification only ever asked
 * about the container. The last section measures pixels.
 *
 * The media tests use a 640x360 fixture and run for about a second each.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'main');
const recipes = require(path.join(SRC, 'recipe'));
const auto = require(path.join(SRC, 'auto-recipe'));
const { buildVideoGraph, buildPostNeuralFilters } = require(path.join(SRC, 'ffmpeg', 'filters'));
const { runVerify, measureActivePicture } = require(path.join(SRC, 'jobs', 'stages', 'verify'));

function staticBinary(name) {
  try {
    const mod = require(path.join(ROOT, 'node_modules', name));
    const p = typeof mod === 'string' ? mod : mod && mod.path;
    return p && fs.existsSync(p) ? p : null;
  } catch { return null; }
}
const FFMPEG = staticBinary('ffmpeg-static');
const FFPROBE = staticBinary('ffprobe-static');

const FILTERS = new Set(['scale', 'crop', 'pad', 'gblur', 'eq', 'unsharp', 'deband', 'hqdn3d', 'deblock', 'overlay', 'split']);

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** The acceptance source: a compressed 24p landscape stream, video-only leg. */
function sourceOf(width, height, { fps = 23.976, bitrate = 2.2e6, duration = 12 } = {}) {
  return {
    video: { width, height, nominalFps: fps, codec: 'vp9', bitrate },
    audio: null,
    color: { isHDR: false },
    container: { duration, bitrate },
    derived: {
      displayWidth: width, displayHeight: height, durationSeconds: duration, nominalFps: fps,
      orientation: width >= height ? 'landscape' : 'portrait',
      isVertical: height > width,
      resolutionClass: height >= 1080 ? '1080p' : '720p',
      hasAudio: true, isHDR: false, isInterlaced: false
    },
    source: { type: 'remote', name: 'acceptance' },
    warnings: []
  };
}

/** The exact acceptance recipe, through the production Auto entry point. */
function acceptanceAuto(analysis, over = {}) {
  return auto.buildAutoConfigure({
    analysis,
    platform: 'custom',
    intensity: 'balanced',
    engines: { realesrgan: false, rife: true, reframe: true, semanticReframe: false },
    locks: { aspect: '21:9', resolution: 'custom', width: 2560, height: 1080, fps: 60 },
    outputPath: 'D:/Vis creations/acceptance-ultrawide.mp4',
    ...over
  });
}

function resolved(recipe, analysis) {
  const geometry = recipes.resolveOutputGeometry(recipe, analysis);
  return { geometry, plan: recipes.resolveFramingPlan(recipe, geometry) };
}

function graphFor(recipe, analysis, opts = {}) {
  const { geometry } = resolved(recipe, analysis);
  return buildVideoGraph(recipe, geometry, analysis, { availableFilters: FILTERS, ...opts }).graph;
}

/* ================================================================== *
 * 1. AUTO CONFIGURE — the decision that produced the bars
 * ================================================================== */

test('auto: the failed acceptance recipe now fills the ultrawide canvas', () => {
  // Both source sizes the render could have used. 720p is what the measured
  // failure implies — a fit scaled it to 1920x1080 and padded to 320 px either
  // side, which is exactly the picture the user found.
  for (const [w, h] of [[1280, 720], [1920, 1080]]) {
    const analysis = sourceOf(w, h);
    const res = acceptanceAuto(analysis);
    const { geometry, plan } = resolved(res.recipe, analysis);

    assert.equal(`${geometry.width}x${geometry.height}`, '2560x1080', `${w}x${h} container`);
    assert.equal(res.recipe.framing.mode, 'fill',
      `${w}x${h}: a widening conversion must crop to fill, not fit — got ${res.recipe.framing.mode}`);
    assert.equal(plan.fills, true, `${w}x${h}: the contract must promise a filled frame`);
    assert.equal(plan.cropAxis, 'y', `${w}x${h}: the canvas is wider, so the trim is vertical`);
    assert.equal(plan.activeWidth, 2560);
    assert.equal(plan.activeHeight, 1080);
  }
});

test('auto: the filter graph for that recipe pads nothing', () => {
  for (const [w, h] of [[1280, 720], [1920, 1080]]) {
    const analysis = sourceOf(w, h);
    const graph = graphFor(acceptanceAuto(analysis).recipe, analysis);
    assert.doesNotMatch(graph, /pad=/,
      `${w}x${h}: a filled contract must never reach ffmpeg with a pad: ${graph}`);
    assert.match(graph, /crop=/, `${w}x${h}: the shape change has to come from somewhere`);
    assert.match(graph, /scale=2560:1080/,
      `${w}x${h}: the picture must be scaled onto the target raster`);
  }
});

test('auto: 16:9 into 9:16 is unchanged — the narrowing case still tracks', () => {
  const analysis = sourceOf(1920, 1080);
  const res = auto.buildAutoConfigure({
    analysis, platform: 'custom', intensity: 'balanced',
    engines: { realesrgan: false, rife: true, reframe: true },
    locks: { aspect: '9:16', resolution: 'custom', width: 1080, height: 1920, fps: null },
    outputPath: 'out.mp4'
  });
  const { plan } = resolved(res.recipe, analysis);
  assert.equal(res.recipe.framing.mode, 'fill');
  assert.equal(res.recipe.framing.tracking, 'auto', 'a horizontal trim is what the tracker steers');
  assert.equal(plan.cropAxis, 'x');
  assert.equal(plan.fills, true);
});

test('auto: a vertical trim is centred and never labelled Smart Reframe', () => {
  // The tracker measures a horizontal position and nothing else. Claiming it
  // steers a top-and-bottom crop would be a tracking label on an untracked
  // crop — the same class of claim as promising face detection with no models.
  const analysis = sourceOf(1920, 1080);
  const res = acceptanceAuto(analysis);
  assert.equal(res.recipe.framing.tracking, 'center');
  const labels = res.summary.chose.map((c) => c.label).join(' | ');
  assert.doesNotMatch(labels, /Smart Reframe/, labels);
});

test('auto: no reframe engine still fills the canvas, and says what was lost', () => {
  const analysis = sourceOf(1920, 1080);
  const res = auto.buildAutoConfigure({
    analysis, platform: 'custom', intensity: 'balanced',
    engines: { realesrgan: false, rife: true, reframe: false },
    locks: { aspect: '9:16', resolution: 'custom', width: 1080, height: 1920, fps: null },
    outputPath: 'out.mp4'
  });
  const { plan } = resolved(res.recipe, analysis);
  assert.equal(res.recipe.framing.mode, 'fill', 'a deterministic crop is always available');
  assert.equal(res.recipe.framing.tracking, 'center');
  assert.equal(plan.fills, true);
  assert.equal(res.unmet.filter((u) => u.setting === 'framing').length, 1,
    'and the missing tracking is stated, not hidden');
});

test('auto: a screencast still keeps the whole frame, bars and all', () => {
  // The one case where bars are the right answer: the edges of the frame are
  // the content being demonstrated.
  const analysis = sourceOf(1920, 1080);
  const res = acceptanceAuto(analysis, { profile: 'screencast' });
  const { plan } = resolved(res.recipe, analysis);
  assert.equal(res.recipe.framing.mode, 'fit');
  assert.equal(plan.fills, false, 'a deliberate fit is allowed to have bars');
  assert.equal(plan.barAxis, 'x');
});

test('auto: a source already the right shape is not cropped for nothing', () => {
  const analysis = sourceOf(2560, 1080, { fps: 30 });
  const res = acceptanceAuto(analysis);
  const { plan } = resolved(res.recipe, analysis);
  assert.equal(res.recipe.framing.mode, 'fit');
  assert.equal(plan.fills, true, 'a fit that needs no bars still fills the frame');
  assert.equal(plan.cropAxis, null);
});

test('auto: the summary describes the framing that will actually run', () => {
  const analysis = sourceOf(1920, 1080);
  const res = acceptanceAuto(analysis);
  const framingChip = res.summary.chose.find((c) => /crop|fit|stretch|reframe/i.test(c.label));
  assert.ok(framingChip, JSON.stringify(res.summary.chose.map((c) => c.label)));
  assert.match(framingChip.label, /Crop to fill/,
    `the chip must not say "Fit" for a render that crops: ${framingChip.label}`);
  assert.match(String(framingChip.detail), /fills the frame/);
  assert.ok(res.explanations.some((e) => /no bars/.test(e)),
    'and the account says the picture reaches every edge');
});

test('auto: the stage list does not advertise a tracking pass that cannot run', () => {
  const pipeline = require(path.join(SRC, 'jobs', 'pipeline'));
  const analysis = sourceOf(1920, 1080);

  // A hand-picked Smart Reframe on a widening conversion. The tracker measures
  // a horizontal position and the trim is vertical, so there is nothing for an
  // analysis pass to produce — and the queue must not show one.
  const { recipe } = recipes.sanitize({
    output: { path: 'o.mp4' },
    framing: {
      enabled: true, canvas: '21:9', width: 2560, height: 1080,
      mode: 'fill', tracking: 'auto'
    }
  });
  const { geometry } = resolved(recipe, analysis);
  const stages = pipeline.planStages(recipe, analysis, geometry, {});
  assert.equal(stages.stages.find((s) => s.id === 'REFRAME').mode, 'fused');

  // The narrowing conversion the tracker *can* steer still gets its pass.
  const { recipe: vertical } = recipes.sanitize({
    output: { path: 'o.mp4' },
    framing: {
      enabled: true, canvas: '9:16', width: 1080, height: 1920,
      mode: 'fill', tracking: 'auto'
    }
  });
  const vg = resolved(vertical, analysis).geometry;
  assert.equal(
    pipeline.planStages(vertical, analysis, vg, {}).stages.find((s) => s.id === 'REFRAME').mode,
    'pass');
});

/* ------------------------------------------------------------------ *
 * The production Auto Configure path, entered exactly as the UI enters it.
 *
 * `main.js handle('auto:configure')` calls `buildAutoConfigure()` with
 * {analysis, platform, profile, intensity, outputPath, preferences, locks,
 * machine, engines}. The renderer supplies platform from the Target control,
 * profile/intensity from the Auto controls, `locks` from `currentLocks()`, and
 * — importantly — **no preferences at all**.
 *
 * The tests above used `platform: 'custom'` and a 1080p23.976 source, which is
 * not the combination a user reaches by picking "YouTube (landscape)" from the
 * Target control with a 1440p60 master loaded. That gap is why a report of
 * "16:9 -> 21:9 now crops" could be true and still not describe the screen in
 * front of someone.
 * ------------------------------------------------------------------ */

/** Exactly the payload `runAuto()` sends for the described panel state. */
function productionAutoConfigure(analysis, { platform = 'youtube', profile = 'auto' } = {}) {
  return auto.buildAutoConfigure({
    analysis,
    platform,
    profile,
    intensity: 'balanced',
    outputPath: null,
    // The renderer sends none. If it ever starts to, this is the merge that
    // would silently overwrite every decision Auto just made.
    preferences: {},
    locks: {
      platform,
      aspect: '21:9',
      aspectW: null,
      aspectH: null,
      resolution: 'custom',
      width: 2560,
      height: 1080,
      fps: 60
    },
    machine: { gpuTier: 'discrete' },
    engines: { realesrgan: false, rife: true, reframe: true, semanticReframe: false }
  });
}

test('production: the real UI payload crops a 1440p60 16:9 master to 21:9', () => {
  // Target: YouTube (landscape) · Aspect: 21:9 · Resolution: 2K class ·
  // 60 fps · Auto Configure · Content: Auto / General.
  const analysis = sourceOf(2560, 1440, { fps: 60, bitrate: 3.2e7 });
  const res = productionAutoConfigure(analysis);
  const { geometry, plan } = resolved(res.recipe, analysis);

  assert.equal(res.profile, 'auto', 'the content profile must be Auto / General');
  assert.equal(`${geometry.width}x${geometry.height}`, '2560x1080');
  assert.equal(res.recipe.framing.canvas, '21:9');
  assert.equal(res.recipe.framing.mode, 'fill',
    `the production path resolved framing.mode=${res.recipe.framing.mode}, not fill`);
  assert.equal(plan.fills, true);
  assert.equal(plan.cropAxis, 'y');

  const chip = res.summary.chose.find((c) => /crop|fit|stretch|reframe/i.test(c.label));
  assert.match(chip.label, /Crop to fill/, `the panel would show "${chip.label}"`);
});

test('production: the Target control cannot change the framing decision', () => {
  // A platform seeds a canvas; it must never override the ratio the user
  // picked, nor the framing that ratio implies.
  const analysis = sourceOf(2560, 1440, { fps: 60, bitrate: 3.2e7 });
  for (const platform of ['custom', 'youtube', 'youtube-4k', 'youtube-shorts']) {
    const res = productionAutoConfigure(analysis, { platform });
    const { geometry } = resolved(res.recipe, analysis);
    assert.equal(res.recipe.framing.canvas, '21:9', `${platform} rewrote the canvas`);
    assert.equal(`${geometry.width}x${geometry.height}`, '2560x1080', `${platform} rewrote the size`);
    assert.equal(res.recipe.framing.mode, 'fill', `${platform} resolved to ${res.recipe.framing.mode}`);
  }
});

test('production: a source that is already 21:9 fits, and says which shape it is', () => {
  /*
   * The case that produced a bug report against working code.
   *
   * `resolutionClass()` measures the long edge, so a 2560x1080 21:9 file
   * reports "1440p" — identical to a 2560x1440 16:9 one. With no shape in the
   * summary, "1440p · 60 fps · clean" above a Fit decision reads as a failure
   * to convert, when in fact the source was already the target shape and there
   * was nothing to convert. Fit here is correct and produces no bars at all.
   */
  const analysis = sourceOf(2560, 1080, { fps: 60, bitrate: 3.2e7 });
  const res = productionAutoConfigure(analysis);
  const { plan } = resolved(res.recipe, analysis);

  assert.equal(res.recipe.framing.mode, 'fit', 'nothing needs cropping');
  assert.equal(plan.fills, true, 'and a fit of a matching shape produces no bars');
  assert.equal(plan.barAxis, null);

  // The size class alone is ambiguous, so the shape has to be stated.
  assert.match(res.summary.source.label, /21:9/,
    `the source line must disclose the shape: "${res.summary.source.label}"`);
  assert.equal(res.summary.source.shape, '21:9');
  const chip = res.summary.chose.find((c) => /crop|fit|stretch|reframe/i.test(c.label));
  assert.match(String(chip.detail), /already 21:9/,
    `the chip must say what it already fits: "${chip.detail}"`);
});

test('production: the two 1440p sources are told apart by the summary', () => {
  // Both report resolutionClass "1440p" at 60 fps and both probe clean. The
  // only thing separating them in the panel is the shape, so it has to be there.
  const wide = productionAutoConfigure(sourceOf(2560, 1080, { fps: 60, bitrate: 3.2e7 }));
  const standard = productionAutoConfigure(sourceOf(2560, 1440, { fps: 60, bitrate: 3.2e7 }));
  assert.notEqual(wide.summary.source.label, standard.summary.source.label,
    `both sources read as "${wide.summary.source.label}"`);
  assert.match(standard.summary.source.label, /16:9/);
  assert.match(wide.summary.source.label, /21:9/);
});

test('production: the no-reshape explanation still satisfies the Auto UI contract', () => {
  // `verify-auto-ui.js` asserts /without cropping|fits the canvas/i against the
  // explanation for a source that already matches the canvas. Naming the shape
  // in that sentence must not break the wording that test relies on, and this
  // suite can run while the app holds its single-instance lock.
  const vertical = auto.buildAutoConfigure({
    analysis: sourceOf(1080, 1920, { fps: 30, bitrate: 8e6 }),
    platform: 'custom', profile: 'auto', intensity: 'balanced',
    outputPath: null, preferences: {},
    locks: { aspect: '9:16', resolution: 'custom', width: 1080, height: 1920, fps: null },
    machine: { gpuTier: 'discrete' },
    engines: { realesrgan: false, rife: true, reframe: true }
  });
  const why = vertical.explanations.join(' ');
  assert.match(why, /without cropping|fits the canvas/i, why);
  assert.match(why, /already 9:16/, `the shape has to be named: ${why}`);
  assert.equal(vertical.recipe.framing.mode, 'fit');
});

test('production: an explicitly chosen Fit is still honoured, both backgrounds', () => {
  // Auto proposes; the user disposes. Picking Fit from the Framing control must
  // keep the whole frame even on a shape change that Auto would have cropped.
  const analysis = sourceOf(2560, 1440, { fps: 60, bitrate: 3.2e7 });
  const res = productionAutoConfigure(analysis);

  for (const [choice, background, wantBars] of [
    ['fit', 'blur', true], ['fit-black', 'black', true]
  ]) {
    // The renderer's FRAMING_CHOICES mapping, applied over Auto's recipe the
    // way buildRecipeOverrides() does.
    const { recipe } = recipes.sanitize({
      ...res.recipe,
      framing: {
        ...res.recipe.framing,
        mode: 'fit', background, tracking: 'center', stretchTolerance: 0
      }
    });
    const { geometry, plan } = resolved(recipe, analysis);
    assert.equal(recipe.framing.mode, 'fit', `${choice} must stay a fit`);
    assert.equal(recipe.framing.background, background);
    assert.equal(plan.fills, !wantBars, `${choice} keeps the whole frame`);
    assert.equal(plan.barAxis, 'x');
    assert.equal(plan.activeWidth, 1920, `${choice}: a 16:9 picture inside 2560x1080`);
    assert.equal(geometry.width, 2560);

    // And the graph really pads rather than cropping.
    const graph = buildVideoGraph(recipe, geometry, analysis, { availableFilters: FILTERS }).graph;
    if (background === 'black') assert.match(graph, /pad=2560:1080/, graph);
    else assert.match(graph, /gblur/, graph);
  }
});

/* ================================================================== *
 * 2. THE FRAMING CONTRACT — one resolver, both directions
 * ================================================================== */

test('contract: fill trims whichever axis is long, in both directions', () => {
  const cases = [
    // source w,h        canvas         expected crop axis
    [1920, 1080, '21:9', 2560, 1080, 'y'],
    [1920, 1080, '9:16', 1080, 1920, 'x'],
    [1920, 1080, '1:1', 1080, 1080, 'x'],
    [1080, 1920, '16:9', 1920, 1080, 'y'],
    [1080, 1080, '21:9', 2560, 1080, 'y'],
    [1920, 1080, '2.39:1', 2560, 1072, 'y']
  ];
  for (const [w, h, canvas, cw, ch, axis] of cases) {
    const { recipe } = recipes.sanitize({
      output: { path: 'o.mp4' },
      framing: { enabled: true, canvas, width: cw, height: ch, mode: 'fill', tracking: 'center' }
    });
    const { plan } = resolved(recipe, sourceOf(w, h));
    assert.equal(plan.cropAxis, axis, `${w}x${h} -> ${canvas}: cropped ${plan.cropAxis}, wanted ${axis}`);
    assert.equal(plan.fills, true, `${w}x${h} -> ${canvas} must fill`);
    assert.equal(plan.stretch, 1, 'a hand-built fill spends no stretch');
  }
});

test('contract: a hand-built centre crop is a pure crop, with no stretch', () => {
  // The Framing control writes this. "Centre crop" promises a crop, so it must
  // not quietly acquire an anamorphic component from a preset it never saw.
  const { recipe } = recipes.sanitize({
    output: { path: 'o.mp4' },
    framing: { enabled: true, canvas: '21:9', width: 2560, height: 1080, mode: 'fill', tracking: 'center' }
  });
  assert.equal(recipe.framing.stretchTolerance, 0);
  const { plan } = resolved(recipe, sourceOf(1920, 1080));
  assert.equal(plan.stretch, 1);
  // A pure crop takes the whole shape change: 1080 * (1.778/2.370) = 810.
  assert.equal(Math.round(1080 * plan.keepHeight), 810);
});

test('contract: the stretch allowance is bounded, and bounded hard', () => {
  for (const asked of [0.5, 1, 0.2, 0.09, -1, NaN, 'lots']) {
    const { recipe } = recipes.sanitize({
      output: { path: 'o.mp4' },
      framing: { enabled: true, canvas: '21:9', mode: 'fill', stretchTolerance: asked }
    });
    assert.ok(recipe.framing.stretchTolerance <= recipes.MAX_STRETCH_TOLERANCE,
      `${asked} became ${recipe.framing.stretchTolerance}`);
    assert.ok(recipe.framing.stretchTolerance >= 0);
  }
  // And whatever Auto asks for, the distortion that reaches the picture stays
  // under what a viewer resolves.
  const { plan } = resolved(acceptanceAuto(sourceOf(1920, 1080)).recipe, sourceOf(1920, 1080));
  assert.ok(plan.stretch <= 1 + recipes.MAX_STRETCH_TOLERANCE + 1e-9, `stretch ${plan.stretch}`);
  assert.ok(plan.stretch <= 1.05, `${plan.stretch} would be visible on a face`);
});

test('contract: the allowance buys back crop rather than replacing it', () => {
  const analysis = sourceOf(1920, 1080);
  const { plan } = resolved(acceptanceAuto(analysis).recipe, analysis);
  const keptLines = Math.round(1080 * plan.keepHeight);
  assert.ok(keptLines > 810, `a pure crop keeps 810 lines; the hybrid kept ${keptLines}`);
  assert.ok(keptLines < 900, `${keptLines} lines would need a stretch nobody should see`);
});

test('contract: a small shape gap disappears into the allowance with no crop at all', () => {
  // 2.30:1 into 2.37:1 is a 3% gap. This is the case the allowance is genuinely
  // good for: nothing is cropped and nothing is visible.
  const analysis = sourceOf(2484, 1080, { fps: 30 });
  const { recipe } = recipes.sanitize({
    output: { path: 'o.mp4' },
    framing: {
      enabled: true, canvas: '21:9', width: 2560, height: 1080,
      mode: 'fill', tracking: 'center', stretchTolerance: 0.03
    }
  });
  const { plan } = resolved(recipe, analysis);
  assert.equal(plan.cropAxis, null, 'no crop was needed');
  assert.ok(plan.stretch > 1 && plan.stretch < 1.031, `stretch ${plan.stretch}`);
  assert.equal(plan.fills, true);
});

test('contract: a stretch tolerance on a non-fill mode is dropped, not remembered', () => {
  for (const mode of ['fit', 'stretch']) {
    const { recipe } = recipes.sanitize({
      output: { path: 'o.mp4' },
      framing: { enabled: true, canvas: '21:9', mode, stretchTolerance: 0.05 }
    });
    assert.equal(recipe.framing.stretchTolerance, 0, `${mode} must not carry an unused allowance`);
  }
});

test('contract: fit reports its bars, and which side they are on', () => {
  const wide = resolved(recipes.sanitize({
    output: { path: 'o.mp4' },
    framing: { enabled: true, canvas: '21:9', width: 2560, height: 1080, mode: 'fit' }
  }).recipe, sourceOf(1920, 1080)).plan;
  assert.equal(wide.fills, false);
  assert.equal(wide.barAxis, 'x', '16:9 in a 21:9 canvas gets bars either side');
  assert.equal(wide.activeWidth, 1920, 'and the kept picture is exactly the failed render');
  assert.equal(wide.activeHeight, 1080);

  const tall = resolved(recipes.sanitize({
    output: { path: 'o.mp4' },
    framing: { enabled: true, canvas: '16:9', width: 1920, height: 1080, mode: 'fit' }
  }).recipe, sourceOf(1080, 1920)).plan;
  assert.equal(tall.barAxis, 'x');
});

test('contract: no framing canvas means the output fills itself', () => {
  const { recipe } = recipes.sanitize({ output: { path: 'o.mp4' } });
  const { plan } = resolved(recipe, sourceOf(1920, 1080));
  assert.equal(plan.active, false);
  assert.equal(plan.fills, true, 'nothing was reshaped, so nothing can be short of the frame');
});

/* ================================================================== *
 * 3. RESOLUTION — the target raster, not the outer canvas
 * ================================================================== */

test('resolution: the picture is enlarged onto the target raster, not centred in it', () => {
  // The failed render left a native 1920-wide picture inside a 2560-wide file
  // and called that 2K. The crop rectangle is what gets scaled, and it must be
  // scaled up to the full canvas width.
  const analysis = sourceOf(1280, 720);
  const res = acceptanceAuto(analysis);
  const { geometry, plan } = resolved(res.recipe, analysis);
  const cropW = Math.min(1280, 720 * plan.cropRatio);
  assert.ok(cropW <= 1280 + 1e-6);
  assert.equal(plan.activeWidth, geometry.canvasWidth);
  // Enlargement, not a re-centring.
  assert.ok(geometry.canvasWidth / cropW > 1.9,
    `2560 from a ${Math.round(cropW)}-wide crop is a ${(geometry.canvasWidth / cropW).toFixed(2)}x climb`);
});

test('resolution: Auto knows the picture is being enlarged and plans for it', () => {
  // `climb` used to be min(2560/1920, 1080/1080) = 1.0 for this job, because it
  // assumed a fit. Auto therefore believed no rescale was needed at all.
  const analysis = sourceOf(1920, 1080);
  const res = acceptanceAuto(analysis);
  assert.ok(res.decisions.climb > 1.2,
    `a widening crop enlarges the picture; climb resolved to ${res.decisions.climb}`);
  assert.equal(res.decisions.needsMorePixels, true);
  assert.equal(res.recipe.reconstruction.enabled, true);
});

test('resolution: framing owns the resample, so nothing scales in front of the crop', () => {
  const analysis = sourceOf(1920, 1080);
  const graph = graphFor(acceptanceAuto(analysis).recipe, analysis);
  const cropAt = graph.indexOf('crop=');
  assert.ok(cropAt > 0, graph);
  assert.doesNotMatch(graph.slice(0, cropAt), /scale=2560:1080/,
    `nothing may scale to the canvas before the crop: ${graph.slice(0, cropAt)}`);
  assert.equal((graph.match(/scale=2560:1080/g) || []).length, 1, 'exactly one resample');
});

test('resolution: a neural pass is not thrown away and re-enlarged', () => {
  // With a canvas active the pre-canvas scale targets the *source* size, so it
  // would take a 3840x2160 network output down to 1920x1080 and then the canvas
  // step would enlarge it again to 2560x1080. One resample, from the largest
  // picture available.
  const analysis = sourceOf(1920, 1080);
  const { recipe } = recipes.sanitize({
    output: { path: 'o.mp4', fps: 60 },
    framing: { enabled: true, canvas: '21:9', width: 2560, height: 1080, mode: 'fill', tracking: 'center' },
    reconstruction: {
      enabled: true, mode: 'neural', aiMode: 'upscale', aiScale: 2,
      targetResolution: { mode: 'custom', width: 2560, height: 1080 }
    },
    motion: { enabled: true, interpolation: 'ai', targetFps: 60 }
  });
  const { geometry } = resolved(recipe, analysis);
  const post = buildPostNeuralFilters(recipe, geometry, { width: 3840, height: 2160 },
    { availableFilters: FILTERS });
  const chain = post.filters.join(',');
  assert.doesNotMatch(chain, /scale=1920:1080/,
    `the network output must not be dropped back to source size: ${chain}`);
  assert.match(chain, /scale=2560:1080/);
  assert.equal((chain.match(/scale=/g) || []).length, 1, `one resample, got: ${chain}`);
});

/* ================================================================== *
 * 4. THE NEURAL ENCODE — where "Fit blurred" became black bars
 * ================================================================== */

test('neural: a blurred fit is actually blurred, not silently turned black', () => {
  const analysis = sourceOf(1920, 1080);
  const { recipe } = recipes.sanitize({
    output: { path: 'o.mp4', fps: 60 },
    framing: {
      enabled: true, canvas: '21:9', width: 2560, height: 1080,
      mode: 'fit', background: 'blur', tracking: 'center'
    },
    motion: { enabled: true, interpolation: 'ai', targetFps: 60 }
  });
  const { geometry } = resolved(recipe, analysis);
  const post = buildPostNeuralFilters(recipe, geometry, { width: 1920, height: 1080 },
    { availableFilters: FILTERS });

  assert.ok(post.graph, 'the composite needs a labelled graph, not a flat -vf chain');
  assert.match(post.graph, /gblur/, `a blurred background must contain a blur: ${post.graph}`);
  assert.match(post.graph, /overlay/);
  assert.doesNotMatch(post.graph, /color=black/,
    `the flat chain used to substitute black bars here: ${post.graph}`);
  assert.match(post.graph, /\[vout\]$/, 'and it has to end somewhere the encoder can map');
  assert.equal(post.filters.length, 0, 'the whole chain moved into the graph');
});

test('neural: a black fit is still black, and still a flat chain', () => {
  const analysis = sourceOf(1920, 1080);
  const { recipe } = recipes.sanitize({
    output: { path: 'o.mp4', fps: 60 },
    framing: {
      enabled: true, canvas: '21:9', width: 2560, height: 1080,
      mode: 'fit', background: 'black', tracking: 'center'
    },
    motion: { enabled: true, interpolation: 'ai', targetFps: 60 }
  });
  const { geometry } = resolved(recipe, analysis);
  const post = buildPostNeuralFilters(recipe, geometry, { width: 1920, height: 1080 },
    { availableFilters: FILTERS });
  assert.equal(post.graph, null);
  assert.match(post.filters.join(','), /pad=2560:1080/);
});

test('neural: the acceptance recipe reaches the encoder with no pad at all', () => {
  for (const [w, h] of [[1280, 720], [1920, 1080]]) {
    const analysis = sourceOf(w, h);
    const res = acceptanceAuto(analysis);
    const { geometry } = resolved(res.recipe, analysis);
    const post = buildPostNeuralFilters(res.recipe, geometry, { width: w, height: h },
      { availableFilters: FILTERS });
    const chain = post.graph || post.filters.join(',');
    assert.doesNotMatch(chain, /pad=/, `${w}x${h}: ${chain}`);
    assert.match(chain, /crop=/);
    assert.match(chain, /scale=2560:1080/);
  }
});

/* ================================================================== *
 * 5. REAL PIXELS
 *
 * Everything above is a plan. This section renders one and looks at it,
 * because the plan was never what shipped broken — the picture was. A 640x360
 * fixture keeps each case around a second.
 * ================================================================== */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'visionance-framing-'));
const FIXTURE = path.join(TMP, 'fixture.mp4');
const mediaReady = !!(FFMPEG && FFPROBE);

if (mediaReady) {
  // Deliberately edge-to-edge content: a fixture with dark borders of its own
  // could not tell padding from the source.
  spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'testsrc2=size=640x360:rate=24:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', FIXTURE]);
}

/** Render the fixture through a recipe's own graph and return the file. */
function render(name, framing) {
  const analysis = sourceOf(640, 360, { fps: 24, duration: 2 });
  const { recipe } = recipes.sanitize({
    output: { path: path.join(TMP, `${name}.mp4`) },
    framing: { enabled: true, canvas: '21:9', width: 854, height: 360, ...framing }
  });
  const geometry = recipes.resolveOutputGeometry(recipe, analysis);
  const plan = recipes.resolveFramingPlan(recipe, geometry);
  const { graph } = buildVideoGraph(recipe, geometry, analysis, { availableFilters: FILTERS });
  const out = path.join(TMP, `${name}.mp4`);
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', FIXTURE,
    '-filter_complex', graph, '-map', '[vout]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out],
  { encoding: 'utf8' });
  assert.equal(r.status, 0, `${name} did not render: ${r.stderr}`);
  return { out, recipe, geometry, plan };
}

test('pixels: a filled ultrawide contract produces a picture that reaches every edge', async (t) => {
  if (!mediaReady) return t.skip('ffmpeg/ffprobe unavailable');
  const { out, geometry, plan } = render('fill', { mode: 'fill', tracking: 'center' });
  assert.equal(plan.fills, true);
  const active = await measureActivePicture({ ffmpeg: FFMPEG, filePath: out, durationSeconds: 2 });
  assert.ok(active, 'the picture must be measurable');
  assert.equal(active.width, geometry.width, `measured ${active.width}x${active.height}`);
  assert.equal(active.height, geometry.height);
  assert.equal(active.x, 0);
  assert.equal(active.y, 0);
});

test('pixels: the old behaviour is still measurable, and is still what a fit means', async (t) => {
  if (!mediaReady) return t.skip('ffmpeg/ffprobe unavailable');
  // This is the failed render, reproduced: a 16:9 picture pillarboxed inside a
  // 21:9 canvas. It is a legitimate output of a *deliberate* Fit, and the point
  // of the contract is that the same pixels mean different things depending on
  // what was promised.
  const { out, plan } = render('fitblack', { mode: 'fit', background: 'black', tracking: 'center' });
  assert.equal(plan.fills, false);
  const active = await measureActivePicture({ ffmpeg: FFMPEG, filePath: out, durationSeconds: 2 });
  assert.ok(active.width < 854 * 0.95,
    `a fit of a 16:9 source into 21:9 pillarboxes; measured ${active.width}`);
  assert.equal(active.width, plan.activeWidth, 'and by exactly the amount the contract predicted');
  assert.ok(active.x > 0, 'with the picture offset from the left edge');
});

test('pixels: verification fails a filled contract that did not fill', async (t) => {
  if (!mediaReady) return t.skip('ffmpeg/ffprobe unavailable');
  /*
   * The regression that matters most.
   *
   * The pillarboxed file from the previous test is handed to the verifier
   * alongside a *fill* contract — which is precisely the mismatch that shipped:
   * a job that promised a filled ultrawide frame and produced a 16:9 picture
   * between bars. Every check that existed at the time passed it.
   */
  const { out } = render('fitblack2', { mode: 'fit', background: 'black', tracking: 'center' });
  const analysis = sourceOf(640, 360, { fps: 24, duration: 2 });
  const { recipe } = recipes.sanitize({
    output: { path: out },
    framing: { enabled: true, canvas: '21:9', width: 854, height: 360, mode: 'fill', tracking: 'center' }
  });
  const geometry = recipes.resolveOutputGeometry(recipe, analysis);

  const result = await runVerify({
    filePath: out,
    recipe,
    geometry,
    plan: { totalDuration: 2 },
    bins: { ffmpeg: FFMPEG, ffprobe: FFPROBE },
    expected: { hasAudio: false },
    sourceHasAudio: false,
    report: () => {},
    log: { info: () => {}, warn: () => {} },
    jobId: 'framing-test'
  });

  assert.equal(result.ok, false, 'a picture that does not fill a fill contract is not a pass');
  assert.ok(result.failures.some((f) => /picture fills the frame/.test(f)),
    `the failure must name the picture, not the container: ${JSON.stringify(result.failures)}`);
  // And the container checks it used to pass on still pass, which is the whole
  // point: the container was never the problem.
  const container = result.checks.find((c) => c.name === 'resolution matches the recipe');
  assert.equal(container.ok, true, 'the file really is 854x360');
  const shape = result.checks.find((c) => c.name === 'aspect ratio matches the recipe');
  assert.equal(shape.ok, true, 'and really is 21:9');
});

test('pixels: verification passes the render Auto now produces', async (t) => {
  if (!mediaReady) return t.skip('ffmpeg/ffprobe unavailable');
  const { out, recipe, geometry } = render('fill2', { mode: 'fill', tracking: 'center', stretchTolerance: 0.03 });
  const result = await runVerify({
    filePath: out,
    recipe,
    geometry,
    plan: { totalDuration: 2 },
    bins: { ffmpeg: FFMPEG, ffprobe: FFPROBE },
    expected: { hasAudio: false },
    sourceHasAudio: false,
    report: () => {},
    log: { info: () => {}, warn: () => {} },
    jobId: 'framing-test-ok'
  });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  const fill = result.checks.find((c) => c.name === 'picture fills the frame');
  assert.ok(fill && fill.ok, JSON.stringify(fill));
});

test('pixels: a deliberate fit is not failed for having the bars it promised', async (t) => {
  if (!mediaReady) return t.skip('ffmpeg/ffprobe unavailable');
  const { out, recipe, geometry } = render('fitkeep', { mode: 'fit', background: 'black', tracking: 'center' });
  const result = await runVerify({
    filePath: out,
    recipe,
    geometry,
    plan: { totalDuration: 2 },
    bins: { ffmpeg: FFMPEG, ffprobe: FFPROBE },
    expected: { hasAudio: false },
    sourceHasAudio: false,
    report: () => {},
    log: { info: () => {}, warn: () => {} },
    jobId: 'framing-test-fit'
  });
  assert.equal(result.ok, true,
    `a Preserve-the-whole-frame mode legitimately pads: ${JSON.stringify(result.failures)}`);
});

test('pixels: a blurred fit fills the frame with picture rather than black', async (t) => {
  if (!mediaReady) return t.skip('ffmpeg/ffprobe unavailable');
  const { out } = render('fitblur', { mode: 'fit', background: 'blur', tracking: 'center' });
  const active = await measureActivePicture({ ffmpeg: FFMPEG, filePath: out, durationSeconds: 2 });
  assert.equal(active.width, 854, 'the blurred copy reaches the edges — that is what it is for');
  assert.equal(active.height, 360);
});

/* ------------------------------------------------------------------ *
 * The neural encode, run for real.
 *
 * This is the stage the discrepancy lived in: the recipe said "Fit, blurred
 * background", the summary repeated it, and the encoder produced solid black
 * bars because a flat `-vf` chain cannot carry a `split`/`overlay` composite.
 * Asserting the filter *strings* would not catch a `-filter_complex` that is
 * wired to the wrong label, so this encodes a real frame sequence exactly the
 * way the RIFE path does.
 * ------------------------------------------------------------------ */

test('pixels: the neural encode honours a blurred fit instead of substituting black', async (t) => {
  if (!mediaReady) return t.skip('ffmpeg/ffprobe unavailable');
  const frames = require(path.join(SRC, 'ai', 'frames'));
  const framesDir = path.join(TMP, 'seq');
  fs.mkdirSync(framesDir, { recursive: true });
  spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'testsrc2=size=640x360:rate=24:duration=1', '-frames:v', '24',
    '-start_number', '1', path.join(framesDir, '%08d.png')]);
  assert.ok(frames.countFrames(framesDir) >= 12, 'the frame sequence was written');

  const analysis = sourceOf(640, 360, { fps: 24, duration: 1 });
  const cases = [
    ['blur', { mode: 'fit', background: 'blur', tracking: 'center' }, true, 854],
    ['black', { mode: 'fit', background: 'black', tracking: 'center' }, false, 640],
    ['crop', { mode: 'fill', tracking: 'center', stretchTolerance: 0.03 }, false, 854]
  ];

  for (const [label, framing, wantsGraph, expectActiveWidth] of cases) {
    const out = path.join(TMP, `neural-${label}.mp4`);
    const { recipe } = recipes.sanitize({
      output: { path: out, fps: 60 },
      framing: { enabled: true, canvas: '21:9', width: 854, height: 360, ...framing },
      motion: { enabled: true, interpolation: 'ai', targetFps: 60 }
    });
    const geometry = recipes.resolveOutputGeometry(recipe, analysis);
    const post = buildPostNeuralFilters(recipe, geometry, { width: 640, height: 360 },
      { availableFilters: FILTERS });
    assert.equal(!!post.graph, wantsGraph, `${label}: graph vs flat chain`);

    // eslint-disable-next-line no-await-in-loop
    await frames.encodeFrames({
      ffmpeg: FFMPEG, framesDir, fps: 24, output: out, encoderId: 'libx264', recipe,
      control: {},
      filters: post.filters.length ? post.filters.join(',') : null,
      graph: post.graph || null,
      outputLabel: post.outputLabel || 'vout'
    });

    // eslint-disable-next-line no-await-in-loop
    const active = await measureActivePicture({ ffmpeg: FFMPEG, filePath: out, durationSeconds: 1 });
    assert.ok(active, `${label}: the encoded chunk must be measurable`);
    assert.equal(active.width, expectActiveWidth,
      `${label}: measured ${active.width}x${active.height}, wanted ${expectActiveWidth} wide`);
  }
});

/* ------------------------------------------------------------------ *
 * A genuinely low-resolution source reaching the 2K ultrawide raster.
 *
 * The accepted real render started from a 2560-wide master, so it proved the
 * framing but never proved *spatial scaling*: a container-only "upscale" would
 * have looked identical there. This drives a 1280x720 source all the way to
 * 2560x1080 through the production graph and reads the result back off disk.
 * ------------------------------------------------------------------ */

test('create: 720p to 2K ultrawide really scales, fills and keeps its audio', async (t) => {
  if (!mediaReady) return t.skip('ffmpeg/ffprobe unavailable');

  const src = path.join(TMP, 'sd-source.mp4');
  const out = path.join(TMP, 'sd-to-2k.mp4');
  // 1280x720 with a tone, so the audio contract has something to preserve.
  let r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src],
  { encoding: 'utf8' });
  assert.equal(r.status, 0, `fixture did not encode: ${r.stderr}`);

  const analysis = {
    video: { width: 1280, height: 720, nominalFps: 24, codec: 'h264', bitrate: 1.2e6 },
    audio: { codec: 'aac' }, color: { isHDR: false },
    container: { duration: 3, bitrate: 1.2e6 },
    derived: {
      displayWidth: 1280, displayHeight: 720, durationSeconds: 3, nominalFps: 24,
      orientation: 'landscape', isVertical: false, resolutionClass: '720p',
      hasAudio: true, isHDR: false, isInterlaced: false
    },
    source: { type: 'local', name: 'sd' }, warnings: []
  };

  // The production Auto path, locked to 21:9 at the 2K class and the source
  // rate (no interpolation, so this stays a fast test).
  const res = auto.buildAutoConfigure({
    analysis, platform: 'custom', profile: 'auto', intensity: 'balanced',
    outputPath: out, preferences: {},
    locks: { aspect: '21:9', resolution: 'custom', width: 2560, height: 1080, fps: null },
    machine: { gpuTier: 'discrete' },
    engines: { realesrgan: false, rife: false, reframe: true }
  });
  const { geometry, plan } = resolved(res.recipe, analysis);
  assert.equal(`${geometry.width}x${geometry.height}`, '2560x1080');
  assert.equal(plan.fills, true, 'Auto must resolve a filled contract here');

  const { graph } = buildVideoGraph(res.recipe, geometry, analysis, { availableFilters: FILTERS });
  assert.doesNotMatch(graph, /pad=/, graph);

  r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src,
    '-filter_complex', graph, '-map', '[vout]', '-map', '0:a:0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, `render failed: ${r.stderr}`);

  const probe = (args) => spawnSync(FFPROBE,
    ['-v', 'error', ...args, '-of', 'csv=p=0', out], { encoding: 'utf8' }).stdout.trim();

  const dims = probe(['-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate']);
  const [w, h, rate] = dims.split(',');
  assert.equal(`${w}x${h}`, '2560x1080', `container is ${dims}`);
  assert.equal(rate, '24/1', `frame rate contract broken: ${rate}`);

  const acodec = probe(['-select_streams', 'a:0', '-show_entries', 'stream=codec_name']);
  assert.equal(acodec, 'aac', `audio was not preserved: "${acodec}"`);

  // The picture must fill the ultrawide raster, not sit inside it.
  const active = await measureActivePicture({ ffmpeg: FFMPEG, filePath: out, durationSeconds: 3 });
  assert.ok(active, 'the output must be measurable');
  assert.equal(active.width, 2560, `active picture is ${active.width}x${active.height}`);
  assert.equal(active.height, 1080);

  // And it must be a real resample: the crop taken from a 1280-wide source is
  // narrower than the 2560-wide raster it lands on, so a container-only
  // "upscale" is arithmetically impossible to pass here.
  const cropW = Math.min(1280, 720 * plan.cropRatio);
  assert.ok(cropW <= 1280);
  assert.ok(2560 / cropW > 1.9,
    `2560 from a ${Math.round(cropW)}px crop is only ${(2560 / cropW).toFixed(2)}x`);
});

test('pixels: cleanup', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  assert.ok(true);
});
