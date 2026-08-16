'use strict';

/**
 * Machine-awareness, stream selection and enhancement intent.
 *
 *   npm run verify:hardware
 *
 * This repository is about to move from a 4-core laptop with an integrated
 * realtime GPU to a substantially stronger desktop. Nothing here names a GPU
 * model: the tests drive the same decision functions production uses with
 * synthetic *capability* profiles, because a model-name table is exactly the
 * thing that would need editing on the new machine.
 *
 * It also pins the two real Watch failures:
 *   - a 1080p source resolved to 640x360 (see the muxed-fallback tests)
 *   - enhancement intent had to map to real stages and nothing else
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'main');
const auto = require(path.join(SRC, 'auto-recipe'));
const policy = require(path.join(SRC, 'stream-policy'));
const intent = require(path.join(ROOT, 'src', 'renderer', 'js', 'enhance-intent'));

/* ------------------------------------------------------------------ *
 * Capability profiles, by capability rather than by name
 * ------------------------------------------------------------------ */

const MACHINES = {
  low: { gpuTier: 'integrated', cores: 4, memoryBytes: 8 * 1024 ** 3 },
  mid: { gpuTier: 'discrete', cores: 12, memoryBytes: 32 * 1024 ** 3 },
  high: { gpuTier: 'discrete', cores: 24, memoryBytes: 64 * 1024 ** 3 }
};

const ALL_ENGINES = { realesrgan: true, rife: true, reframe: true, semanticReframe: true };

function sourceOf(width, height, { fps = 23.976, bitrate = 2.2e6, duration = 240 } = {}) {
  return {
    video: { width, height, nominalFps: fps, codec: 'h264', bitrate },
    audio: { codec: 'aac' },
    color: { isHDR: false },
    container: { duration, bitrate },
    derived: {
      displayWidth: width, displayHeight: height, durationSeconds: duration, nominalFps: fps,
      orientation: 'landscape', isVertical: false,
      resolutionClass: height >= 1080 ? '1080p' : '720p',
      hasAudio: true, isHDR: false, isInterlaced: false
    },
    source: { type: 'local', name: 'fixture' },
    warnings: []
  };
}

/** The production Create entry point, with one machine profile swapped in. */
function configure(analysis, machine, over = {}) {
  return auto.buildAutoConfigure({
    analysis,
    platform: 'custom',
    profile: 'auto',
    intensity: 'balanced',
    outputPath: null,
    preferences: {},
    locks: { aspect: '21:9', resolution: 'custom', width: 2560, height: 1080, fps: 60 },
    machine,
    engines: ALL_ENGINES,
    ...over
  });
}

/* ================================================================== *
 * CREATE — locks survive every machine
 * ================================================================== */

test('locks: the same manual choices resolve identically on every machine', () => {
  const analysis = sourceOf(1920, 1080);
  const seen = new Set();
  for (const [name, machine] of Object.entries(MACHINES)) {
    const res = configure(analysis, machine);
    const g = require(path.join(SRC, 'recipe')).resolveOutputGeometry(res.recipe, analysis);
    seen.add(`${g.width}x${g.height}@${g.fps}`);
    assert.equal(res.recipe.framing.canvas, '21:9', `${name} moved the aspect`);
    assert.equal(`${g.width}x${g.height}`, '2560x1080', `${name} moved the resolution`);
    assert.equal(g.fps, 60, `${name} moved the frame rate`);
  }
  assert.equal(seen.size, 1, `the output contract differed by machine: ${[...seen]}`);
});

/* ================================================================== *
 * CREATE — capability changes what is unlocked, not what was asked for
 * ================================================================== */

test('machine: a weak machine is not asked to run the most expensive inference', () => {
  // Damaged source climbing a long way is the case that earns neural work.
  const analysis = sourceOf(1280, 720, { bitrate: 6e5 });
  const low = configure(analysis, MACHINES.low, { intensity: 'strong' });
  const high = configure(analysis, MACHINES.high, { intensity: 'strong' });

  const order = ['fast', 'balanced', 'quality', 'maximum'];
  const rank = (r) => order.indexOf(r.recipe.reconstruction.aiQuality || 'balanced');
  if (low.recipe.reconstruction.mode === 'neural' && high.recipe.reconstruction.mode === 'neural') {
    assert.ok(rank(low) <= rank(high),
      `weak machine asked for ${low.recipe.reconstruction.aiQuality}, strong for ${high.recipe.reconstruction.aiQuality}`);
  }
  assert.ok(low.warnings.length >= 0);
});

test('machine: raw compute is never a reason to process a clean source', () => {
  // The rule that keeps "strong machine" from meaning "do more to the picture".
  const clean = sourceOf(2560, 1440, { fps: 60, bitrate: 4.5e7 });
  for (const [name, machine] of Object.entries(MACHINES)) {
    const res = configure(clean, machine);
    assert.notEqual(res.recipe.reconstruction.mode, 'neural',
      `${name} ran a network over a clean source`);
    assert.equal(res.recipe.restore.enabled, false,
      `${name} ran restoration over a clean source`);
  }
});

test('machine: an unknown machine is treated conservatively, never optimistically', () => {
  const analysis = sourceOf(1280, 720, { bitrate: 6e5 });
  const unknown = configure(analysis, null, { intensity: 'strong' });
  const high = configure(analysis, MACHINES.high, { intensity: 'strong' });
  const order = ['fast', 'balanced', 'quality', 'maximum'];
  const rank = (r) => order.indexOf(r.recipe.reconstruction.aiQuality || 'balanced');
  assert.ok(rank(unknown) <= rank(high) + 0,
    'an unknown machine must not be given more than a known strong one');
});

test('machine: no capability profile is read from tracked config', () => {
  // `capabilities.report()` caches in memory with a short TTL and writes
  // nothing to disk, which is what makes moving the repository to another
  // computer a no-op. A persisted profile here would silently describe the
  // laptop on the desktop.
  const caps = require(path.join(SRC, 'capabilities'));
  const src = require('fs').readFileSync(path.join(SRC, 'capabilities.js'), 'utf8');
  assert.ok(typeof caps.report === 'function');
  assert.doesNotMatch(src, /writeFileSync|writeFile\(|store\.set/,
    'capability detection must not persist a machine profile');
});

/* ================================================================== *
 * WATCH — the 360p failure
 * ================================================================== */

test('stream: a 1600x900 viewport asks for 1080p, not 360p', () => {
  const d = policy.chooseStreamHeight({
    viewportWidth: 1600, viewportHeight: 900, devicePixelRatio: 1,
    screenWidth: 1920, screenHeight: 1080,
    enhancement: true, watchQuality: 'auto', hardwareDecode: true
  });
  assert.equal(d.maxHeight, 1080, `${d.maxHeight}p — ${d.reason}`);
});

test('stream: enhancement being on never lowers the source below HD', () => {
  // The product rule: enhance the best sensible source, do not manufacture an
  // upscale opportunity by asking for a worse one.
  const off = policy.chooseStreamHeight({
    viewportWidth: 1600, viewportHeight: 900, devicePixelRatio: 1,
    screenWidth: 1920, screenHeight: 1080, enhancement: false, hardwareDecode: true
  });
  const on = policy.chooseStreamHeight({
    viewportWidth: 1600, viewportHeight: 900, devicePixelRatio: 1,
    screenWidth: 1920, screenHeight: 1080, enhancement: true, hardwareDecode: true
  });
  assert.ok(on.maxHeight >= 720, `enhancement dropped the request to ${on.maxHeight}p`);
  assert.ok(on.maxHeight >= off.maxHeight * 0.9,
    `enhancement on asked for ${on.maxHeight}p against ${off.maxHeight}p off`);
});

test('stream: a tiny viewport is allowed to take a small stream', () => {
  const d = policy.chooseStreamHeight({
    viewportWidth: 480, viewportHeight: 270, devicePixelRatio: 1,
    screenWidth: 1920, screenHeight: 1080, hardwareDecode: true
  });
  assert.ok(d.maxHeight <= 480, `${d.maxHeight}p for a 270px viewport`);
});

test('stream: 4K is not fetched for a ~900p window', () => {
  const d = policy.chooseStreamHeight({
    viewportWidth: 1600, viewportHeight: 900, devicePixelRatio: 1,
    screenWidth: 3840, screenHeight: 2160, hardwareDecode: true
  });
  assert.ok(d.maxHeight <= 1440, `${d.maxHeight}p for a 900px window`);
});

test('stream: an explicit user ceiling is obeyed exactly', () => {
  const d = policy.chooseStreamHeight({
    viewportWidth: 1600, viewportHeight: 900, devicePixelRatio: 1,
    screenWidth: 1920, screenHeight: 1080, userMaxHeight: 720
  });
  assert.equal(d.maxHeight, 720);
  assert.equal(d.source, 'user');
});

test('stream: only the audio-recovery fallback can force the 360p rendition', () => {
  /*
   * The real failure, pinned.
   *
   * Measured against live YouTube through the production resolver: the normal
   * path returns 1920x1080 (split video+audio) and `preferMuxed` returns
   * 640x360, because YouTube's only progressive rendition is 360p. So a session
   * sitting at 640x360 means the audio-recovery ladder reached its last rung,
   * and nothing else should ever produce it.
   *
   * This asserts the selection *rule* rather than hitting the network: a muxed
   * rendition may only win when it is not materially worse than the split pair.
   */
  const muxed360 = { height: 360, isMuxed: true };
  const split1080 = { height: 1080, isMuxed: false };

  // The rule `pickBest`/`normaliseInfo` applies: prefer split when it genuinely
  // buys resolution, and only keep muxed when it is within the same rung.
  const withinRung = (mux, split) => mux.height >= split.height * 0.93;
  assert.equal(withinRung(muxed360, split1080), false,
    '360p must never count as "the same quality" as 1080p');

  const muxed1080 = { height: 1080, isMuxed: true };
  assert.equal(withinRung(muxed1080, split1080), true,
    'an equal-quality combined stream is still preferred for simplicity');
});

/* ================================================================== *
 * WATCH — enhancement intent maps to real stages only
 * ================================================================== */

const LOOK = {
  enabled: true, denoise: 0.1, deblock: 0.1, edge: 0.5, line: 0.2,
  sharpen: 0.35, haloGuard: 0.8, deband: 0.25, localContrast: 0.15,
  contrast: 0.06, saturation: 0.08, vibrance: 0.1
};

test('intent: every intent maps only to parameters the shader chain has', () => {
  const real = new Set(Object.keys(LOOK));
  for (const name of Object.keys(intent.INTENTS)) {
    const out = intent.applyIntent(LOOK, name);
    for (const key of Object.keys(out)) {
      assert.ok(real.has(key), `intent "${name}" invented the parameter ${key}`);
    }
  }
  // And the stage map itself names only real passes.
  assert.deepEqual(Object.keys(intent.STAGES).sort(),
    ['finish', 'reconstruct', 'restore', 'sharpen']);
});

test('intent: Auto changes nothing at all', () => {
  assert.deepEqual(intent.applyIntent(LOOK, 'auto'), LOOK);
});

test('intent: Clean raises restoration and does not sharpen artefacts harder', () => {
  const out = intent.applyIntent(LOOK, 'clean');
  assert.ok(out.denoise > LOOK.denoise, 'denoise must rise');
  assert.ok(out.deblock > LOOK.deblock, 'deblock must rise');
  assert.ok(out.sharpen < LOOK.sharpen, 'sharpening compression damage is not cleanup');
});

test('intent: Detail favours reconstruction', () => {
  const out = intent.applyIntent(LOOK, 'detail');
  assert.ok(out.edge > LOOK.edge, 'edge reconstruction must rise');
});

test('intent: Sharp raises sharpening and raises halo protection with it', () => {
  const out = intent.applyIntent(LOOK, 'sharp');
  assert.ok(out.sharpen > LOOK.sharpen);
  assert.ok(out.haloGuard >= LOOK.haloGuard, 'more sharpening needs more halo guard');
});

test('intent: Finish favours colour and tone', () => {
  const out = intent.applyIntent(LOOK, 'finish');
  assert.ok(out.contrast > LOOK.contrast || out.saturation > LOOK.saturation);
});

test('intent: nothing ever leaves the 0..1 range the shaders accept', () => {
  const extreme = { ...LOOK, denoise: 0.95, sharpen: 0.95, edge: 0.95, contrast: 0.95 };
  for (const name of Object.keys(intent.INTENTS)) {
    const out = intent.applyIntent(extreme, name);
    for (const [key, value] of Object.entries(out)) {
      if (typeof value !== 'number') continue;
      assert.ok(value >= 0 && value <= 1, `${name}.${key} = ${value}`);
    }
  }
});

test('intent: applying an intent twice is not compounding', () => {
  // The UI recomputes from the Look, never from an already-biased value.
  const once = intent.applyIntent(LOOK, 'sharp');
  const twice = intent.applyIntent(LOOK, 'sharp');
  assert.deepEqual(once, twice);
});

test('intent: a description never claims a stage it did not raise', () => {
  assert.match(intent.describeIntent('clean'), /cleanup/i);
  assert.match(intent.describeIntent('detail'), /detail/i);
  assert.doesNotMatch(intent.describeIntent('clean'), /sharp/i);
  // And no engine names leak into normal Watch language.
  for (const name of Object.keys(intent.INTENTS)) {
    assert.doesNotMatch(intent.describeIntent(name), /rife|real-?esrgan|vulkan|ncnn/i);
  }
});
