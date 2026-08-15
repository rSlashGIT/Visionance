'use strict';

/**
 * Output-contract regressions.
 *
 *   npm run verify:contract
 *
 * Written from one real failed render: a 187-second music video that was asked
 * for 21:9, 2K and 60 fps and produced a 2560x1440 (16:9) file with no audio
 * at all — and was marked Completed, because verification asked the same wrong
 * questions the pipeline had already answered wrongly.
 *
 * Three independent defects, three groups of tests, plus the verifier contract
 * that must reject that exact output.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'main');
const recipes = require(path.join(SRC, 'recipe'));
const interpolation = require(path.join(SRC, 'ai', 'interpolation-plan'));
const { buildEncodeCommand } = require(path.join(SRC, 'ffmpeg', 'command'));

/* ------------------------------------------------------------------ *
 * Fixtures — the real job, reduced to what matters
 * ------------------------------------------------------------------ */

const SOURCE = {
  video: { width: 1920, height: 1080, nominalFps: 23.976, codec: 'h264' },
  audio: null,                       // the video-only leg of a split stream
  color: { isHDR: false },
  container: { duration: 187.354, bitrate: 2.2e6 },
  derived: {
    displayWidth: 1920, displayHeight: 1080, durationSeconds: 187.354,
    nominalFps: 23.976, orientation: 'landscape', isVertical: false,
    resolutionClass: '1080p', hasAudio: false, isHDR: false, isInterlaced: false
  },
  warnings: []
};

function recipeFor(over = {}) {
  return recipes.sanitize({
    output: { path: 'D:/out.mp4', container: 'mp4', codec: 'h264', fps: 60 },
    reconstruction: {
      enabled: true, mode: 'classical',
      targetResolution: { mode: 'custom', width: 2560, height: 1440 }
    },
    framing: { enabled: true, canvas: '21:9', width: 2560, height: 1440, mode: 'fit' },
    motion: { enabled: true, targetFps: 60, interpolation: 'ai', sceneCutProtection: true },
    audio: { enabled: true, mode: 'encode', codec: 'aac', bitrateKbps: 256, master: 'creator' },
    ...over
  }).recipe;
}

/* ================================================================== *
 * GEOMETRY
 * ================================================================== */

test('geometry: the real failed render now resolves to 21:9', () => {
  const g = recipes.resolveOutputGeometry(recipeFor(), SOURCE);
  assert.equal(`${g.width}x${g.height}`, '2560x1080');
  assert.ok(Math.abs(g.width / g.height - recipes.aspectRatioOf('21:9')) < 0.02);
});

test('geometry: a resolution can never redefine the chosen shape', () => {
  // Every canvas, handed the 16:9 pair that broke the real render.
  for (const canvas of ['16:9', '9:16', '4:5', '1:1', '21:9', '2.39:1']) {
    const g = recipes.resolveOutputGeometry(
      recipeFor({ framing: { enabled: true, canvas, width: 2560, height: 1440, mode: 'fit' } }),
      SOURCE
    );
    const wanted = recipes.aspectRatioOf(canvas);
    const actual = g.width / g.height;
    assert.ok(Math.abs(actual - wanted) < 0.02,
      `${canvas} -> ${g.width}x${g.height} = ${actual.toFixed(3)}, wanted ${wanted.toFixed(3)}`);
  }
});

test('geometry: a custom ratio conforms too, and stays even', () => {
  const g = recipes.resolveOutputGeometry(recipeFor({
    framing: { enabled: true, canvas: 'custom', aspectW: 12, aspectH: 5, width: 2560, height: 1440, mode: 'fit' }
  }), SOURCE);
  assert.ok(Math.abs(g.width / g.height - 12 / 5) < 0.02, `${g.width}x${g.height}`);
  assert.equal(g.width % 2, 0);
  assert.equal(g.height % 2, 0);
});

test('geometry: the long edge the user asked for is what is kept', () => {
  const cases = [['21:9', 2560, 1440, 2560], ['21:9', 3840, 2160, 3840], ['9:16', 2560, 1440, 2560]];
  for (const [canvas, w, h, longEdge] of cases) {
    const g = recipes.resolveOutputGeometry(
      recipeFor({ framing: { enabled: true, canvas, width: w, height: h, mode: 'fit' } }), SOURCE);
    assert.equal(Math.max(g.width, g.height), longEdge, `${canvas} ${w}x${h}`);
  }
});

test('geometry: dimensions that already match the ratio are left exactly alone', () => {
  const g = recipes.resolveOutputGeometry(recipeFor({
    framing: { enabled: true, canvas: '21:9', width: 2560, height: 1080, mode: 'fit' }
  }), SOURCE);
  assert.equal(`${g.width}x${g.height}`, '2560x1080');
});

test('geometry: what reaches ffmpeg carries the conformed size, not the asked one', () => {
  const recipe = recipeFor();
  const geometry = recipes.resolveOutputGeometry(recipe, SOURCE);
  const { args } = buildEncodeCommand({
    recipe, geometry, analysis: SOURCE, availableFilters: ['scale', 'pad', 'crop'],
    input: 'https://cdn/video.mp4', encoderId: 'libx264'
  });
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.ok(/2560/.test(graph), graph.slice(0, 200));
  assert.ok(!/1440/.test(graph), `1440 must not reach the filter graph: ${graph.slice(0, 200)}`);
});

/* ================================================================== *
 * AUDIO
 * ================================================================== */

test('audio: a split source feeds the audio leg into the render', () => {
  const recipe = recipeFor();
  const geometry = recipes.resolveOutputGeometry(recipe, SOURCE);
  const { args } = buildEncodeCommand({
    recipe, geometry, analysis: SOURCE, availableFilters: ['scale'],
    input: 'https://cdn/video-only.mp4',
    audioInput: 'https://cdn/audio-only.m4a',
    encoderId: 'libx264'
  });
  assert.ok(args.includes('https://cdn/audio-only.m4a'), 'the audio leg must be an input');
  assert.ok(!args.includes('-an'), 'audio must not be disabled');
  assert.ok(args.includes('1:a:0'), 'audio must be mapped from the second input');
});

test('audio: with no audio anywhere, silence is explicit rather than accidental', () => {
  const recipe = recipeFor();
  const geometry = recipes.resolveOutputGeometry(recipe, SOURCE);
  const { args } = buildEncodeCommand({
    recipe, geometry, analysis: SOURCE, availableFilters: ['scale'],
    input: 'https://cdn/video-only.mp4', audioInput: null, encoderId: 'libx264'
  });
  assert.ok(args.includes('-an'));
});

test('audio: asking for no audio is honoured even when the source has some', () => {
  const withAudio = { ...SOURCE, audio: { codec: 'aac' }, derived: { ...SOURCE.derived, hasAudio: true } };
  const recipe = recipeFor({ audio: { enabled: false, mode: 'none' } });
  const geometry = recipes.resolveOutputGeometry(recipe, withAudio);
  const { args } = buildEncodeCommand({
    recipe, geometry, analysis: withAudio, availableFilters: ['scale'],
    input: 'local.mp4', audioInput: null, encoderId: 'libx264'
  });
  assert.ok(args.includes('-an'));
});

/* ================================================================== *
 * TEMPORAL
 * ================================================================== */

/** Where a shot's output samples land, and which of them cannot move. */
function planFor({ frameCount, fpsSrc, fpsDst, cutFrames = [], hasNextFrame = false }) {
  return interpolation.planInterpolation({ frameCount, fpsSrc, fpsDst, cutFrames, hasNextFrame });
}

/*
 * These two asserted that a shot ending at a cut must not carry a duplicated
 * anchor, on the theory that the duplicate caused the reported micro-pauses.
 * Measuring the source-time mapping showed the opposite: with the duplicate,
 * motion runs at 1.0010x and the tail samples hold the last frame for exactly
 * its own display interval, which is what the source does too. Removing it
 * turned every shot into 0.949x-0.988x slow motion.
 *
 * The real defect was next to it — see `requestFrames` — and the speed
 * contract now lives in verify-temporal.js.
 */
test('temporal: a shot ending at a cut anchors on its own last frame', () => {
  const plan = planFor({ frameCount: 120, fpsSrc: 23.976, fpsDst: 60, cutFrames: [40, 80] });
  const interior = plan.shots.filter((s) => s.mode === 'rife');
  assert.ok(interior.length >= 2, JSON.stringify(plan.shots.map((s) => s.mode)));
  for (const shot of interior.slice(0, -1)) {
    assert.equal(shot.anchor, 'duplicate',
      `shot ${shot.index} must not look past the cut for its anchor`);
    // Sample spacing comes from the rate ratio, never from the rounded count.
    const spacing = shot.inputFrames / (shot.requestFrames - 1);
    assert.ok(Math.abs(spacing - 23.976 / 60) < 0.01,
      `shot ${shot.index} spacing ${spacing.toFixed(4)} vs ${(23.976 / 60).toFixed(4)}`);
  }
});

test('temporal: a shot that continues past the chunk still borrows a real frame', () => {
  const plan = planFor({ frameCount: 120, fpsSrc: 23.976, fpsDst: 60, cutFrames: [40], hasNextFrame: true });
  const last = plan.shots[plan.shots.length - 1];
  assert.equal(last.anchor, 'next');
  assert.ok(last.dropTrailing >= 1, 'the sample landing on the anchor belongs to the next chunk');
  assert.ok(last.requestFrames > last.outputCount);
});

test('temporal: the frame count is exact for the real conversion', () => {
  // 23.976 -> 60 over the real duration.
  const frameCount = Math.round(187.354 * 23.976);
  const plan = planFor({ frameCount, fpsSrc: 23.976, fpsDst: 60 });
  const expected = interpolation.totalOutputFrames(frameCount / 23.976, 60);
  assert.equal(plan.outputCount, expected);
  const produced = plan.shots.reduce((sum, s) => sum + s.outputCount, 0);
  assert.equal(produced, expected, 'the plan must account for every output frame');
  assert.equal(plan.warnings.filter((w) => /produced .* frames for/.test(w)).length, 0);
});

test('temporal: output samples are monotonic and never overlap between shots', () => {
  const plan = planFor({ frameCount: 240, fpsSrc: 23.976, fpsDst: 60, cutFrames: [37, 96, 97, 180] });
  let next = 0;
  for (const shot of plan.shots) {
    if (shot.outputCount === 0) continue;
    assert.equal(shot.outputStart, next,
      `shot ${shot.index} starts at ${shot.outputStart}, expected ${next}`);
    next += shot.outputCount;
  }
  assert.equal(next, plan.outputCount);
});

test('temporal: cuts land on the right output frame', () => {
  const fpsSrc = 24;
  const fpsDst = 60;
  const plan = planFor({ frameCount: 240, fpsSrc, fpsDst, cutFrames: [48, 120] });
  for (const shot of plan.shots.slice(1)) {
    if (!shot.outputCount) continue;
    // The first output frame of a shot must be the first sample at or after
    // the cut's display time.
    const expected = Math.ceil((shot.startFrame / fpsSrc) * fpsDst - 1e-6);
    assert.equal(shot.outputStart, expected,
      `cut at source frame ${shot.startFrame} landed on output ${shot.outputStart}, expected ${expected}`);
  }
});

test('temporal: a genuine one-frame shot is still held, and says so', () => {
  const plan = planFor({ frameCount: 60, fpsSrc: 24, fpsDst: 60, cutFrames: [30, 31] });
  const held = plan.shots.filter((s) => s.mode === 'hold');
  assert.ok(held.length >= 1, JSON.stringify(plan.shots.map((s) => [s.inputFrames, s.mode])));
  assert.ok(plan.warnings.some((w) => /held rather than interpolated/.test(w)));
});

test('temporal: every conversion keeps duration, whatever the ratio', () => {
  for (const [src, dst] of [[23.976, 60], [24, 60], [25, 60], [30, 60], [29.97, 60], [60, 30], [24, 48]]) {
    const frameCount = Math.round(10 * src);
    const plan = planFor({ frameCount, fpsSrc: src, fpsDst: dst });
    const duration = plan.outputCount / dst;
    assert.ok(Math.abs(duration - frameCount / src) < 0.05,
      `${src} -> ${dst}: ${duration.toFixed(3)}s vs ${(frameCount / src).toFixed(3)}s`);
  }
});
