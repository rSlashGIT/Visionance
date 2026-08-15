'use strict';

/**
 * Create verification: output geometry, render cost, and Smart Reframe
 * telemetry.
 *
 *   npm run verify:create
 *
 * Pure logic - no GPU, no network, no binaries. These cover the three places
 * where Create was previously making claims nothing checked: an aspect ratio
 * that could only be reached through a social-platform preset, a cost class
 * computed before the plan was resolved, and three different descriptions of
 * one tracking run that could contradict each other on screen.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const recipes = require(path.join(__dirname, '..', 'src', 'main', 'recipe'));
const pipeline = require(path.join(__dirname, '..', 'src', 'main', 'jobs', 'pipeline'));
const tracking = require(path.join(__dirname, '..', 'src', 'main', 'ai', 'tracking'));
const realesrgan = require(path.join(__dirname, '..', 'src', 'main', 'ai', 'engines', 'realesrgan'));
const autoRecipe = require(path.join(__dirname, '..', 'src', 'main', 'auto-recipe'));

/* ------------------------------------------------------------------ *
 * Aspect ratio, resolution and framing as three separate answers
 * ------------------------------------------------------------------ */

const ANALYSIS_16_9 = {
  container: { bitrate: 8e6 },
  video: { width: 1920, height: 1080, nominalFps: 30, bitrate: 8e6, codec: 'h264' },
  audio: { channels: 2 },
  timing: { durationSeconds: 30 },
  derived: { displayWidth: 1920, displayHeight: 1080, durationSeconds: 30 }
};

function geometryFor(framing, reconstruction = {}) {
  const { recipe } = recipes.sanitize({
    output: { path: 'out.mp4' },
    framing: { enabled: true, ...framing },
    reconstruction
  });
  return { recipe, geometry: recipes.resolveOutputGeometry(recipe, ANALYSIS_16_9) };
}

test('aspect: every advertised ratio resolves to its documented resolution', () => {
  const expected = {
    '16:9': [1920, 1080],
    '9:16': [1080, 1920],
    '4:5': [1080, 1350],
    '1:1': [1080, 1080],
    '21:9': [2560, 1080],
    '2.39:1': [2560, 1072]
  };
  for (const [id, [w, h]] of Object.entries(expected)) {
    const s = recipes.suggestedResolution(id);
    assert.deepEqual(s, { width: w, height: h },
      `${id} should suggest ${w}x${h}, got ${JSON.stringify(s)}`);
    const ratio = recipes.aspectRatioOf(id);
    assert.ok(Math.abs((w / h) - ratio) < 0.012,
      `${id} suggestion ${w}x${h} is ${(w / h).toFixed(3)}, ratio is ${ratio.toFixed(3)}`);
    assert.equal(w % 2, 0, `${id} width must be even`);
    assert.equal(h % 2, 0, `${id} height must be even`);
  }
});

test('aspect: a ratio with no explicit size still produces a sane even canvas', () => {
  for (const id of ['16:9', '9:16', '4:5', '1:1', '21:9', '2.39:1']) {
    const { geometry } = geometryFor({ canvas: id, mode: 'fit' });
    const ratio = recipes.aspectRatioOf(id);
    assert.ok(Math.abs(geometry.width / geometry.height - ratio) < 0.02,
      `${id}: got ${geometry.width}x${geometry.height}`);
    assert.equal(geometry.width % 2, 0, `${id} width`);
    assert.equal(geometry.height % 2, 0, `${id} height`);
  }
});

test('aspect: a custom ratio is honoured', () => {
  const { geometry } = geometryFor({ canvas: 'custom', aspectW: 12, aspectH: 5, mode: 'fit' });
  assert.ok(Math.abs(geometry.width / geometry.height - 12 / 5) < 0.02,
    `${geometry.width}x${geometry.height}`);
});

test('aspect: a custom ratio with nothing in it falls back rather than resolving to zero', () => {
  const broken = recipes.sanitize({
    output: { path: 'out.mp4' },
    framing: { enabled: true, canvas: 'custom', mode: 'fit' }
  });
  assert.equal(broken.recipe.framing.canvas, 'source');
  assert.ok(broken.warnings.some((w) => /custom aspect ratio/i.test(w)),
    broken.warnings.join(' | '));
});

/*
 * This test used to assert the opposite, and that is why a real render came
 * out 16:9 after the user selected 21:9.
 *
 * It gave a 16:9 canvas a 2560x1080 pair — a 21:9 shape — and asserted that
 * the dimensions won. The product promise is the other way round: the ratio is
 * a shape the user picked from a list of shapes, and a resolution cannot
 * silently redefine it. The size is still honoured, on the long edge.
 */
test('aspect: the chosen ratio decides the shape, and the size is kept on the long edge', () => {
  const { geometry } = geometryFor({ canvas: '16:9', width: 2560, height: 1080, mode: 'fit' });
  assert.ok(Math.abs(geometry.width / geometry.height - 16 / 9) < 0.02,
    `${geometry.width}x${geometry.height} is not 16:9`);
  assert.equal(geometry.width, 2560, 'the long edge the user asked for is kept');
  assert.equal(geometry.height, 1440);
});

test('aspect: the exact failed render — 21:9 at a 2K class — resolves to 21:9', () => {
  // 2560x1440 is a 16:9 pair. Written into a 21:9 framing block it used to be
  // handed straight to the encoder, and the output really was 16:9.
  const { geometry } = geometryFor({ canvas: '21:9', width: 2560, height: 1440, mode: 'fit' });
  assert.equal(geometry.width, 2560);
  assert.equal(geometry.height, 1080);
  assert.ok(Math.abs(geometry.width / geometry.height - 64 / 27) < 0.02);
});

test('aspect: every ratio conforms, whatever pair it is handed', () => {
  const cases = [
    ['16:9', 1920, 1080], ['9:16', 1080, 1920], ['4:5', 2560, 1440],
    ['1:1', 2560, 1440], ['21:9', 2560, 1440], ['2.39:1', 3840, 2160],
    ['21:9', 1920, 1080], ['9:16', 3840, 2160]
  ];
  for (const [canvas, width, height] of cases) {
    const { geometry } = geometryFor({ canvas, width, height, mode: 'fit' });
    const wanted = recipes.aspectRatioOf(canvas);
    const actual = geometry.width / geometry.height;
    assert.ok(Math.abs(actual - wanted) < 0.02,
      `${canvas} from ${width}x${height} -> ${geometry.width}x${geometry.height} (${actual.toFixed(3)})`);
    assert.equal(geometry.width % 2, 0);
    assert.equal(geometry.height % 2, 0);
  }
});

test('aspect: odd dimensions are evened, and the user is told rather than surprised', () => {
  const { recipe, warnings } = recipes.sanitize({
    output: { path: 'out.mp4' },
    framing: { enabled: true, canvas: 'custom', aspectW: 3, aspectH: 2, width: 1921, height: 1081 }
  });
  assert.equal(recipe.framing.width % 2, 0);
  assert.equal(recipe.framing.height % 2, 0);
  assert.ok(warnings.some((w) => /even/i.test(w)), warnings.join(' | '));
});

test('aspect: zero, negative and NaN dimensions cannot reach the encoder', () => {
  for (const bad of [0, -100, NaN, 'abc', null, Infinity, 1e9]) {
    const { recipe } = recipes.sanitize({
      output: { path: 'out.mp4' },
      framing: { enabled: true, canvas: '16:9', width: bad, height: bad }
    });
    assert.ok(!recipe.framing.width || recipe.framing.width >= 16,
      `width ${bad} became ${recipe.framing.width}`);
    const geometry = recipes.resolveOutputGeometry(recipe, ANALYSIS_16_9);
    assert.ok(Number.isFinite(geometry.width) && geometry.width > 0,
      `geometry width from ${bad}: ${geometry.width}`);
    assert.ok(Number.isFinite(geometry.height) && geometry.height > 0,
      `geometry height from ${bad}: ${geometry.height}`);
  }
});

test('aspect: the ratio survives every framing choice made against it', () => {
  for (const [mode, tracking_] of [['fill', 'auto'], ['fill', 'center'], ['fit', 'center']]) {
    const { recipe } = recipes.sanitize({
      output: { path: 'out.mp4' },
      framing: { enabled: true, canvas: '21:9', mode, tracking: tracking_ }
    });
    assert.equal(recipe.framing.canvas, '21:9', 'framing never rewrites the ratio');
    assert.equal(recipe.framing.tracking, tracking_);
    assert.equal(recipe.framing.mode, mode);
  }
});

test('aspect: a platform seeds a ratio without owning it', () => {
  // Applying a platform sets the canvas...
  const base = recipes.defaultRecipe(ANALYSIS_16_9, { output: { path: 'out.mp4' } });
  const shorts = recipes.applyPlatform(base, 'youtube-shorts');
  assert.equal(shorts.framing.canvas, '9:16');

  // ...and the user can immediately choose something else, which sticks.
  const { recipe } = recipes.sanitize({
    ...shorts,
    framing: { ...shorts.framing, canvas: '21:9', width: null, height: null }
  });
  assert.equal(recipe.framing.canvas, '21:9');
  const geometry = recipes.resolveOutputGeometry(recipe, ANALYSIS_16_9);
  assert.ok(Math.abs(geometry.width / geometry.height - recipes.aspectRatioOf('21:9')) < 0.02,
    `${geometry.width}x${geometry.height} is not the 21:9 canvas`);
});

/* ------------------------------------------------------------------ *
 * Cost, from the resolved plan
 * ------------------------------------------------------------------ */

const GEOMETRY_720_TO_1440 = {
  sourceWidth: 1280, sourceHeight: 720, sourceFps: 30,
  width: 2560, height: 1440, fps: 30
};

const X4PLUS = { name: 'realesrgan-x4plus' };
const UPSCALE_STAGES = [{ id: 'UPSCALE', mode: 'pass' }, { id: 'ENCODE', mode: 'pass' }];

test('cost: a job running x4 inference is never called fast', () => {
  const cost = pipeline.estimatePlanCost({
    stages: UPSCALE_STAGES,
    geometry: GEOMETRY_720_TO_1440,
    aiPlan: { upscale: { model: X4PLUS, inferenceScale: 4, preScale: 1 } },
    durationSeconds: 10
  });
  assert.notEqual(cost.class, 'fast',
    `10s of full-size x4plus classed ${cost.class} (${cost.seconds}s)`);
  assert.ok(cost.reasons.some((r) => /realesrgan-x4plus/.test(r)), cost.reasons.join(' | '));
  assert.equal(cost.basis, 'measured-neural-rate');
});

test('cost: the reference clip is priced in the right order of magnitude', () => {
  // Measured: 12.66 s/frame for full-size x4plus on 720p. A ten-second 30 fps
  // clip is 300 frames, so ~63 minutes. The classifier does not have to be
  // exact, but it must not be out by an order of magnitude.
  const cost = pipeline.estimatePlanCost({
    stages: UPSCALE_STAGES,
    geometry: GEOMETRY_720_TO_1440,
    aiPlan: { upscale: { model: X4PLUS, inferenceScale: 4, preScale: 1 } },
    durationSeconds: 10
  });
  assert.ok(cost.seconds > 1200 && cost.seconds < 12000,
    `expected roughly an hour, estimated ${cost.seconds}s`);
  assert.ok(['heavy', 'very-heavy'].includes(cost.class), cost.class);
});

test('cost: the pre-scaled path is classified cheaper, in the measured proportion', () => {
  const full = pipeline.estimatePlanCost({
    stages: UPSCALE_STAGES, geometry: GEOMETRY_720_TO_1440, durationSeconds: 10,
    aiPlan: { upscale: { model: X4PLUS, inferenceScale: 4, preScale: 1 } }
  });
  const half = pipeline.estimatePlanCost({
    stages: UPSCALE_STAGES, geometry: GEOMETRY_720_TO_1440, durationSeconds: 10,
    aiPlan: { upscale: { model: X4PLUS, inferenceScale: 4, preScale: 0.5 } }
  });
  // A quarter of the input pixels. Measured 3.5x faster end to end.
  assert.ok(half.seconds < full.seconds / 3,
    `half-frame ${half.seconds}s vs full ${full.seconds}s`);
});

test('cost: a plain encode is fast, and says which basis it used', () => {
  const cost = pipeline.estimatePlanCost({
    stages: [{ id: 'ENCODE', mode: 'pass' }],
    geometry: { sourceWidth: 1920, sourceHeight: 1080, sourceFps: 30, width: 1920, height: 1080, fps: 30 },
    aiPlan: null,
    durationSeconds: 20
  });
  assert.equal(cost.class, 'fast');
  assert.equal(cost.basis, 'encode-only');
  assert.equal(cost.reasons.length, 0);
});

test('cost: every class is reachable and they are correctly ordered', () => {
  const seen = [];
  for (const seconds of [2, 30, 300, 7200]) {
    seen.push(pipeline.estimatePlanCost({
      stages: UPSCALE_STAGES, geometry: GEOMETRY_720_TO_1440, durationSeconds: seconds,
      aiPlan: { upscale: { model: X4PLUS, inferenceScale: 4, preScale: 1 } }
    }));
  }
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i].seconds > seen[i - 1].seconds, 'longer sources cost more');
    assert.ok(
      pipeline.COST_CLASSES.indexOf(seen[i].class) >= pipeline.COST_CLASSES.indexOf(seen[i - 1].class),
      `classes must not go backwards: ${seen.map((c) => c.class).join(' -> ')}`
    );
  }
  assert.equal(seen[seen.length - 1].class, 'very-heavy');
});

test('cost: the cheap model is classified as the cheap path it measured as', () => {
  const anime = pipeline.estimatePlanCost({
    stages: UPSCALE_STAGES, geometry: GEOMETRY_720_TO_1440, durationSeconds: 10,
    aiPlan: { upscale: { model: { name: 'realesr-animevideov3' }, inferenceScale: 2, preScale: 1 } }
  });
  const general = pipeline.estimatePlanCost({
    stages: UPSCALE_STAGES, geometry: GEOMETRY_720_TO_1440, durationSeconds: 10,
    aiPlan: { upscale: { model: X4PLUS, inferenceScale: 4, preScale: 1 } }
  });
  // Measured 0.64 s/frame against 12.66 - roughly twentyfold.
  assert.ok(anime.seconds * 5 < general.seconds,
    `anime ${anime.seconds}s vs general ${general.seconds}s`);
});

test('cost: a declined neural upscale is planned and priced as a fused resize', () => {
  const { recipe } = recipes.sanitize({
    output: { path: 'out.mp4' },
    reconstruction: {
      enabled: true, mode: 'neural', aiMode: 'upscale', aiScale: 2, aiQuality: 'fast',
      targetResolution: { mode: 'custom', width: 2560, height: 1440 }
    }
  });
  const analysis = {
    ...ANALYSIS_16_9,
    video: { width: 1280, height: 720, nominalFps: 30 },
    derived: { displayWidth: 1280, displayHeight: 720, durationSeconds: 10 }
  };
  const geometry = recipes.resolveOutputGeometry(recipe, analysis);

  const declined = pipeline.planStages(recipe, analysis, geometry, { neuralUpscale: false });
  assert.equal(declined.stages.find((s) => s.id === 'UPSCALE').mode, 'fused',
    'a declined neural pass is not a pass');
  assert.equal(declined.requiresChunking, false,
    'and does not drag the job onto the chunked neural path for nothing');

  const accepted = pipeline.planStages(recipe, analysis, geometry, { neuralUpscale: true });
  assert.equal(accepted.stages.find((s) => s.id === 'UPSCALE').mode, 'pass');
  assert.equal(accepted.requiresChunking, true);
});

test('cost: Auto never labels a job that runs a network as fast', () => {
  const compressed = {
    container: { bitrate: 1.2e6 },
    video: { width: 1280, height: 720, nominalFps: 30, bitrate: 1.2e6, codec: 'h264' },
    audio: { channels: 2 },
    timing: { durationSeconds: 8 },
    derived: { displayWidth: 1280, displayHeight: 720, durationSeconds: 8, resolutionClass: '720p' }
  };
  for (const intensity of ['light', 'balanced', 'strong', 'maximum']) {
    const r = autoRecipe.buildAutoRecipe({
      analysis: compressed, platform: 'youtube-1080p', profile: 'auto', intensity,
      engines: { realesrgan: true, rife: true, reframe: true }
    });
    if (r.recipe.reconstruction.mode === 'neural' || r.recipe.motion.interpolation === 'ai') {
      assert.notEqual(r.cost, 'fast',
        `${intensity} produced a neural recipe labelled fast`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * Auto's inference-quality decisions
 * ------------------------------------------------------------------ */

test('auto: only an explicit Maximum reaches the full-pixel 4x path', () => {
  const at = (intensity, extra = {}) => autoRecipe.neuralQualityFor({
    intensity, srcH: 720, targetH: 1080, quality: { level: 'compressed' }, ...extra
  });
  assert.equal(at('light'), 'fast');
  assert.equal(at('balanced'), 'balanced');
  assert.equal(at('strong'), 'balanced');
  assert.equal(at('maximum'), 'maximum');
});

test('auto: a badly damaged source climbing a long way earns full-size inference', () => {
  const q = autoRecipe.neuralQualityFor({
    intensity: 'strong', srcH: 480, targetH: 1080, quality: { level: 'poor' }
  });
  assert.equal(q, 'quality', '480p -> 1080p on a poor source is what this path is for');

  // The same climb on a merely compressed source does not.
  assert.equal(autoRecipe.neuralQualityFor({
    intensity: 'strong', srcH: 480, targetH: 1080, quality: { level: 'compressed' }
  }), 'balanced');
});

test('auto: animation is never sent down the pre-scaled path it does not need', () => {
  // The anime model has genuine native 2x weights and measured 0.64 s/frame,
  // so there is nothing cheaper worth having.
  for (const intensity of ['balanced', 'strong']) {
    assert.equal(autoRecipe.neuralQualityFor({
      intensity, srcH: 720, targetH: 1080, quality: { level: 'compressed' }, profile: 'animation'
    }), 'quality');
  }
});

test('auto: a clean 1080p source heading to 1080p is not neurally upscaled at all', () => {
  const clean = {
    container: { bitrate: 12e6 },
    video: { width: 1920, height: 1080, nominalFps: 30, bitrate: 12e6, codec: 'h264' },
    audio: { channels: 2 },
    timing: { durationSeconds: 20 },
    derived: { displayWidth: 1920, displayHeight: 1080, durationSeconds: 20, resolutionClass: '1080p' }
  };
  const r = autoRecipe.buildAutoRecipe({
    analysis: clean, platform: 'youtube-1080p', profile: 'auto', intensity: 'balanced',
    engines: { realesrgan: true, rife: true, reframe: true }
  });
  assert.notEqual(r.recipe.reconstruction.mode, 'neural');
});

test('auto: 720p to 1080p picks an efficient path, not x4-then-downsample', () => {
  const compressed = {
    container: { bitrate: 2e6 },
    video: { width: 1280, height: 720, nominalFps: 30, bitrate: 2e6, codec: 'h264' },
    audio: { channels: 2 },
    timing: { durationSeconds: 20 },
    derived: { displayWidth: 1280, displayHeight: 720, durationSeconds: 20, resolutionClass: '720p' }
  };
  const r = autoRecipe.buildAutoRecipe({
    analysis: compressed, platform: 'youtube-1080p', profile: 'auto', intensity: 'balanced',
    engines: { realesrgan: true, rife: true, reframe: true }
  });
  if (r.recipe.reconstruction.mode === 'neural') {
    assert.notEqual(r.recipe.reconstruction.aiQuality, 'maximum');
    assert.notEqual(r.recipe.reconstruction.aiQuality, 'quality');

    // ...and the resulting plan really does run the cheaper path.
    const plan = realesrgan.planInference({
      mode: 'upscale',
      scale: r.recipe.reconstruction.aiScale,
      modelId: 'general',
      quality: r.recipe.reconstruction.aiQuality,
      available: [{ id: 'general', name: 'realesrgan-x4plus', nativeScales: [4], availableScales: [4] }]
    });
    assert.ok(!plan.neural || plan.preScale < 1,
      `expected a cheap path, got ${plan.reason}`);
  }
});

/* ------------------------------------------------------------------ *
 * Smart Reframe telemetry
 * ------------------------------------------------------------------ */

test('reframe: the counters always add up to the sample count', () => {
  const cases = [
    { samples: 40, tracked: 40, holds: 0, fallbacks: 0, trackedConfidence: 0.9 },
    { samples: 40, tracked: 10, holds: 30, fallbacks: 22, trackedConfidence: 0.4 },
    { samples: 40, tracked: 0, holds: 40, fallbacks: 40, trackedConfidence: 0 },
    { samples: 12, tracked: 7, holds: 5, fallbacks: 1, trackedConfidence: 0.55 }
  ];
  for (const c of cases) {
    const s = tracking.summariseTracking({ ...c, cuts: 2 });
    assert.equal(s.tracked + s.held + s.centred, s.samples,
      `${s.tracked}+${s.held}+${s.centred} != ${s.samples}`);
    assert.ok(s.coverage >= 0 && s.coverage <= 1);
    assert.ok(s.confidence >= 0 && s.confidence <= 1);
  }
});

test('reframe: a success metric can never appear beside a failure warning', () => {
  // The reported defect: "crop follows the subject across 40 positions
  // (100% confidence, 4 cuts)" printed directly above "the subject could not
  // be located reliably". One summary now produces both, so they cannot
  // disagree - checked across the whole range of outcomes.
  for (let tracked = 0; tracked <= 40; tracked++) {
    const s = tracking.summariseTracking({
      samples: 40,
      tracked,
      holds: 40 - tracked,
      fallbacks: 40 - tracked,
      trackedConfidence: 1,        // detector maximally confident on what it did see
      cuts: 4
    });
    if (s.warning && /could not be tracked/i.test(s.warning)) {
      assert.equal(s.outcome, 'centred');
      assert.doesNotMatch(s.headline, /confidence/i,
        `a failed run must not quote a confidence: "${s.headline}"`);
    }
    if (s.outcome === 'tracked') {
      assert.equal(s.warning, null, 'a tracked run carries no failure warning');
    }
    assert.match(s.headline, new RegExp(`Tracked ${tracked} of 40`));
  }
});

test('reframe: the three outcomes are reached at the documented coverage', () => {
  const at = (tracked) => tracking.summariseTracking({
    samples: 100, tracked, holds: 100 - tracked, fallbacks: 100 - tracked,
    trackedConfidence: 0.8, cuts: 0
  }).outcome;
  assert.equal(at(100), 'tracked');
  assert.equal(at(60), 'tracked');
  assert.equal(at(59), 'partial');
  assert.equal(at(25), 'partial');
  assert.equal(at(24), 'centred');
  assert.equal(at(0), 'centred');
});

test('reframe: confidence describes the samples that were used, not all of them', () => {
  // Ten usable samples at 0.9 among ninety unusable ones. The old number was
  // the mean over all one hundred, which described neither the detector nor
  // the result - and was the number printed as "100% confidence".
  const s = tracking.summariseTracking({
    samples: 100, tracked: 10, holds: 90, fallbacks: 90, trackedConfidence: 0.9, cuts: 0
  });
  assert.equal(s.confidence, 0.9, 'confidence is of the tracked samples');
  assert.equal(s.coverage, 0.1, 'coverage says how few there were');
  assert.equal(s.outcome, 'centred');
  assert.ok(s.warning);
});

test('reframe: holds and centre fallbacks are nested, not parallel', () => {
  // `fallbacks` is the subset of `holds` with no previous position to reuse.
  // Reporting them side by side double-counted the same samples.
  const s = tracking.summariseTracking({
    samples: 20, tracked: 8, holds: 12, fallbacks: 5, trackedConfidence: 0.7, cuts: 1
  });
  assert.equal(s.held, 7, 'held = holds - fallbacks');
  assert.equal(s.centred, 5);
  assert.equal(s.tracked + s.held + s.centred, 20);
  assert.equal(s.scenes, 2);
});

test('reframe: a real trajectory reports counters consistent with its own points', () => {
  const samples = [];
  for (let i = 0; i < 40; i++) {
    // Confident for the first half, unreadable for the second.
    samples.push({ time: i / 4, center: 0.3 + i * 0.005, confidence: i < 20 ? 0.8 : 0.05 });
  }
  const t = tracking.buildTrajectory({ samples, cuts: [], profile: 'auto' });
  assert.equal(t.points.length, 40);
  assert.equal(t.tracked, 20);
  assert.equal(t.holds, 20);
  assert.ok(t.trackedConfidence > 0.7);

  const s = tracking.summariseTracking({
    samples: samples.length, tracked: t.tracked, holds: t.holds,
    fallbacks: t.fallbacks, trackedConfidence: t.trackedConfidence, cuts: 0
  });
  assert.equal(s.outcome, 'partial');
  assert.equal(s.tracked + s.held + s.centred, 40);
});

test('reframe: cuts into unreadable shots are counted, not silently dropped', () => {
  // A cut sample that cannot be read used to increment neither counter, so the
  // totals did not add up to the number of samples.
  const samples = Array.from({ length: 16 }, (_, i) => ({
    time: i / 4, center: 0.5, confidence: 0.02
  }));
  const t = tracking.buildTrajectory({ samples, cuts: [1, 2, 3], profile: 'auto' });
  assert.equal(t.tracked + t.holds, samples.length,
    `${t.tracked} tracked + ${t.holds} held != ${samples.length} samples`);
});

test('reframe: a clip with nothing trackable says so and quotes no confidence', () => {
  const samples = Array.from({ length: 24 }, (_, i) => ({ time: i / 4, center: 0.5, confidence: 0 }));
  const t = tracking.buildTrajectory({ samples, cuts: [], profile: 'auto' });
  const s = tracking.summariseTracking({
    samples: samples.length, tracked: t.tracked, holds: t.holds,
    fallbacks: t.fallbacks, trackedConfidence: t.trackedConfidence, cuts: 0
  });
  assert.equal(s.outcome, 'centred');
  assert.equal(s.tracked, 0);
  assert.match(s.warning, /centre framing was used/i);
  assert.doesNotMatch(s.headline, /confidence/i);
});

test('reframe: a fully tracked clip reports no warning and a real confidence', () => {
  const samples = Array.from({ length: 32 }, (_, i) => ({
    time: i / 4, center: 0.35 + i * 0.004, confidence: 0.78
  }));
  const t = tracking.buildTrajectory({ samples, cuts: [4], profile: 'auto' });
  const s = tracking.summariseTracking({
    samples: samples.length, tracked: t.tracked, holds: t.holds,
    fallbacks: t.fallbacks, trackedConfidence: t.trackedConfidence, cuts: 1
  });
  assert.equal(s.outcome, 'tracked');
  assert.equal(s.warning, null);
  assert.ok(s.confidence > 0.7);
  assert.equal(s.scenes, 2);
  assert.match(s.headline, /confidence 78%/);
});

/* ------------------------------------------------------------------ *
 * Rolling ETA
 *
 * A remaining time is only allowed to exist once enough real frames are
 * behind it. The first frames of a neural job include model load, Vulkan
 * warm-up and the tile search, so a rate taken from them is wrong by a factor
 * that matters.
 * ------------------------------------------------------------------ */

const jm = require(path.join(__dirname, '..', 'src', 'main', 'jobs', 'job-manager'));

test('eta: nothing is estimated until there is something to estimate from', () => {
  const job = { startedAt: Date.now() - 60000 };
  const early = jm.updateNeuralRate(job, {
    framesDone: jm.ETA_MIN_FRAMES - 1, framesTotal: 300, startedAt: Date.now() - 60000
  });
  assert.equal(early, null, 'too few frames');
  assert.equal(job.neuralRate.warming, true);
  assert.equal(job.neuralRate.framesPerSecond, 0);
  assert.equal(jm.estimateEta(job), null, 'and no ETA is offered');

  const tooSoon = jm.updateNeuralRate({ startedAt: Date.now() }, {
    framesDone: 100, framesTotal: 300, startedAt: Date.now() - 1000
  });
  assert.equal(tooSoon, null, 'too little wall clock');
});

test('eta: the rate is frames actually done over wall clock', () => {
  const startedAt = Date.now() - 60000;      // one minute ago
  const job = { startedAt };
  const rate = jm.updateNeuralRate(job, { framesDone: 30, framesTotal: 300, startedAt });
  assert.ok(rate, 'an estimate is produced');
  assert.ok(Math.abs(rate.framesPerSecond - 0.5) < 0.02,
    `30 frames in 60s should be 0.5 fps, got ${rate.framesPerSecond}`);
  assert.equal(rate.framesRemaining, 270);
  // 270 frames at 0.5 fps is 540 seconds.
  assert.ok(Math.abs(jm.estimateEta(job) - 540) < 30, `eta ${jm.estimateEta(job)}`);
});

test('eta: the rate is smoothed rather than jumping to each new sample', () => {
  const startedAt = Date.now() - 60000;
  const job = { startedAt };
  jm.updateNeuralRate(job, { framesDone: 30, framesTotal: 300, startedAt });
  const first = job.neuralRate.framesPerSecond;

  // A sudden doubling of the instantaneous rate must not double the reported one.
  jm.updateNeuralRate(job, { framesDone: 60, framesTotal: 300, startedAt });
  const second = job.neuralRate.framesPerSecond;
  assert.ok(second > first, 'it does move');
  assert.ok(second < first * 2,
    `smoothing should damp a doubling: ${first} -> ${second}`);
});

test('eta: a fused encode still uses ffmpeg\'s own speed', () => {
  const job = { totalDuration: 100, processedDuration: 25, speed: 2 };
  assert.equal(jm.estimateEta(job), 38, '75s of media left at 2x realtime');
});

test('eta: a finished neural job asks for no more time', () => {
  const startedAt = Date.now() - 60000;
  const job = { startedAt };
  jm.updateNeuralRate(job, { framesDone: 300, framesTotal: 300, startedAt });
  assert.equal(job.neuralRate.framesRemaining, 0);
  assert.equal(jm.estimateEta(job), null);
});

test('eta: a zero or missing total never produces a nonsense figure', () => {
  assert.equal(jm.updateNeuralRate({ startedAt: Date.now() }, { framesDone: 5, framesTotal: 0 }), null);
  assert.equal(jm.estimateEta({}), null);
  assert.equal(jm.estimateEta({ totalDuration: 10, speed: 0 }), null);
});

/* ------------------------------------------------------------------ *
 * Pre-neural filters actually reach the decoder
 *
 * `extractFrames` took no `filters` argument while `processChunk` passed one,
 * so the entire pre-neural chain - tone map, deinterlace, crop, denoise,
 * deblock, and the Balanced pre-scale - was silently discarded and the
 * network was fed raw decoded frames. Feeding compression artefacts into a
 * super-resolution model teaches it to reconstruct the artefacts, which is the
 * one thing the pre/post split exists to prevent.
 * ------------------------------------------------------------------ */

test('frames: extractFrames accepts and applies a filter chain', () => {
  const frames = require(path.join(__dirname, '..', 'src', 'main', 'ai', 'frames'));
  const src = frames.extractFrames.toString();
  assert.match(src, /filters/, 'extractFrames takes a filters argument');
  // The fps pin must survive, and the caller's filters must be appended to it.
  assert.match(src, /fps=\$\{fps\},\$\{filters\}|filters \?/,
    'the filter chain is composed with the fps pin rather than replacing it');
});

test('frames: the pre-neural chain a Balanced job builds is non-empty', () => {
  const { buildPreNeuralFilters } = require(path.join(__dirname, '..', 'src', 'main', 'ffmpeg', 'filters'));
  const { recipe } = recipes.sanitize({
    output: { path: 'out.mp4' },
    restore: { enabled: true, denoise: 0.4, deblock: 0.5 },
    reconstruction: {
      enabled: true, mode: 'neural', aiMode: 'upscale', aiScale: 2, aiQuality: 'balanced'
    }
  });
  const pre = buildPreNeuralFilters(recipe, ANALYSIS_16_9, {
    availableFilters: new Set(['hqdn3d', 'deblock', 'gblur', 'scale'])
  });
  assert.ok(pre.filters.length > 0,
    'a restoration recipe produces pre-neural filters worth delivering');
});

test('cost: even a one-second neural clip is not called fast', () => {
  // Measured end to end: the cheapest neural path manages 0.55 fps, so a
  // one-second clip is ~55 seconds. Under a minute in absolute terms, but not
  // the "press it and it is done" experience `fast` promises.
  const cost = pipeline.estimatePlanCost({
    stages: UPSCALE_STAGES,
    geometry: { sourceWidth: 854, sourceHeight: 480, sourceFps: 30, width: 1920, height: 1080, fps: 30 },
    aiPlan: { upscale: { model: X4PLUS, inferenceScale: 4, preScale: 0.5 } },
    durationSeconds: 1
  });
  assert.notEqual(cost.class, 'fast', `${cost.class} at ${cost.seconds}s`);
  assert.equal(cost.class, 'moderate');
});

test('cost: interpolation alone also lifts a job off fast', () => {
  const cost = pipeline.estimatePlanCost({
    stages: [{ id: 'INTERPOLATE', mode: 'pass' }],
    geometry: { sourceWidth: 640, sourceHeight: 360, sourceFps: 24, width: 640, height: 360, fps: 60 },
    aiPlan: { upscale: null, interpolate: { model: { label: 'v4.6' } } },
    durationSeconds: 1
  });
  assert.notEqual(cost.class, 'fast');
});

/* ------------------------------------------------------------------ *
 * Framing must actually reach the encoder
 *
 * A regression found by rendering a real 9:16 short and reading the filter
 * graph: with `reconstruction.targetResolution` set to the same 1080x1920 the
 * canvas wanted - which is exactly what the Create panel produces - the graph
 * came out as
 *     scale=1080:1920, crop=w=min(iw,ih*0.563)..., scale=1080:1920
 * The pre-scale squashed 16:9 into 9:16, after which `min(iw, ih*aspect)`
 * resolves to the full width and the crop is a no-op. Smart Reframe tracked
 * the subject perfectly and had no effect on the picture.
 * ------------------------------------------------------------------ */

test('framing: the canvas resample is not done twice', () => {
  const analysis = {
    container: {}, video: { width: 1920, height: 1080, nominalFps: 30 },
    audio: {}, timing: { durationSeconds: 6 },
    derived: { displayWidth: 1920, displayHeight: 1080, durationSeconds: 6 }
  };
  const { recipe } = recipes.sanitize({
    output: { path: 'o.mp4' },
    framing: { enabled: true, canvas: '9:16', width: 1080, height: 1920, mode: 'fill', tracking: 'auto' },
    reconstruction: {
      enabled: true, mode: 'classical',
      targetResolution: { mode: 'custom', width: 1080, height: 1920 }
    }
  });
  const g = recipes.resolveOutputGeometry(recipe, analysis);

  // Framing owns the resample, so nothing scales in front of it.
  assert.equal(g.scaleWidth, 1920, 'the pre-framing scale stays at source width');
  assert.equal(g.scaleHeight, 1080, 'the pre-framing scale stays at source height');
  assert.equal(g.requestedWidth, 1080, 'what was asked for is still recorded');
  assert.equal(g.width, 1080);
  assert.equal(g.height, 1920);
});

test('framing: a tracked crop is a real crop, not the whole frame', () => {
  const { buildVideoGraph } = require(path.join(__dirname, '..', 'src', 'main', 'ffmpeg', 'filters'));
  const analysis = {
    container: {}, video: { width: 1920, height: 1080, nominalFps: 30 },
    audio: {}, timing: { durationSeconds: 6 },
    derived: { displayWidth: 1920, displayHeight: 1080, durationSeconds: 6 }
  };
  const { recipe } = recipes.sanitize({
    output: { path: 'o.mp4' },
    framing: { enabled: true, canvas: '9:16', width: 1080, height: 1920, mode: 'fill', tracking: 'auto' },
    reconstruction: {
      enabled: true, mode: 'classical',
      targetResolution: { mode: 'custom', width: 1080, height: 1920 }
    }
  });
  const geometry = recipes.resolveOutputGeometry(recipe, analysis);
  // Signature is (recipe, geometry, analysis, opts).
  const graph = buildVideoGraph(recipe, geometry, analysis, {
    availableFilters: new Set(['scale', 'crop', 'gblur']),
    reframe: { expr: 'iw*0.6746', cropWidthFraction: 0.5625, points: 12, static: false }
  });
  const text = typeof graph === 'string' ? graph : (graph.graph || graph.filter || JSON.stringify(graph));
  assert.ok(text && text.length, 'a graph was produced');

  assert.match(text, /crop=/, 'a crop is present');
  // The crop must not be preceded by a scale to the canvas: that is the bug.
  const cropAt = text.indexOf('crop=');
  const before = text.slice(0, cropAt);
  assert.doesNotMatch(before, /scale=1080:1920/,
    `nothing may scale to the canvas before the crop: ${before}`);

  // And with a 16:9 source the crop width is genuinely narrower than the frame.
  const cropWidth = Math.min(1920, 1080 * (1080 / 1920));
  assert.ok(cropWidth < 1920 * 0.95,
    `the crop should be much narrower than the source, computed ${cropWidth}`);
});
