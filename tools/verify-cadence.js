'use strict';

/**
 * Watch realtime cadence: scheduling and governor policy.
 *
 *   npm run verify:cadence
 *
 * Written from a measured failure. Enhanced Watch on the reference laptop
 * reported 0.99 ms of enhancement cost against a 41.9 ms budget, a quality
 * scale pinned near 45%, and 4.4% dropped frames - three numbers that cannot
 * all be true at once. Measuring them found that none of them were:
 *
 *   `tools/measure-video-visibility.js`
 *      the media element is parked at 1x1 off-screen whenever the canvas is the
 *      picture. Over the same clip the decoder reported 0% dropped while
 *      visible and 97.9% while parked, with media time advancing at exactly
 *      1.0x in both. The counter describes an element nobody can see.
 *
 *   `tools/measure-enhance-cost.js`
 *      the CPU bracket around the draw calls measures submission, not
 *      rendering: 0.9 ms reported against 20.2 ms of real GPU time.
 *
 *   the same tool, sweeping the governor's own lever
 *      render scale 1, 1.5 and 2 all produced an identical 2560x1350 render at
 *      an identical 20 ms, because the output size was clamped to at least the
 *      source. The governor's only actuator was disconnected.
 *
 * So the governor was reading a metric that always said "raise" and a metric
 * that always said "lower", and pulling a lever attached to nothing.
 *
 * These tests are the deterministic half: pure policy over synthetic inputs,
 * no GPU, no media, no timing. The measurement tools above are the other half
 * and are run by hand against real playback.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/* ------------------------------------------------------------------ *
 * Loading the engine without a GPU
 *
 * `engine.js` is a browser script that builds its GL context in the
 * constructor. The governor, the scheduler and the output-size arithmetic are
 * all plain functions of state, so the class is loaded into a context with
 * enough of a DOM to construct, and `_initGL` is neutralised. Nothing here
 * touches WebGL.
 * ------------------------------------------------------------------ */

function loadEngine() {
  const sandbox = {
    window: {},
    performance: { now: () => sandbox.__now },
    __now: 0,
    requestAnimationFrame: (fn) => { sandbox.__rafQueue.push(fn); return sandbox.__rafQueue.length; },
    cancelAnimationFrame: (h) => { sandbox.__rafCancelled.push(h); },
    __rafQueue: [],
    __rafCancelled: [],
    console
  };
  sandbox.window.VSShaders = new Proxy({}, { get: () => 'void main(){}' });
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'engine.js'), 'utf8'),
    sandbox, { filename: 'engine.js' });
  return { api: sandbox.window.VSEngine, sandbox };
}

const { api: VSEngine, sandbox } = loadEngine();

/**
 * An engine with the GL half neutralised.
 *
 * `_initGL` is overridden rather than mocked: the governor, the scheduler and
 * the output-size arithmetic are pure functions of state and need no context,
 * and a fake GL object would only invite tests that assert against the fake.
 */
class TestEngine extends VSEngine.Engine {
  _initGL() {
    this.maxTextureSize = 16384;
    this._timerExt = null;
    this._pendingQueries = [];
    this.stats.gpuTimingAvailable = false;
  }
}

function makeEngine({ srcW = 2560, srcH = 1350, displayW = 1600, displayH = 900 } = {}) {
  const canvas = {
    width: 0, height: 0,
    parentElement: { getBoundingClientRect: () => ({ width: displayW, height: displayH }) },
    getBoundingClientRect: () => ({ width: displayW, height: displayH }),
    addEventListener() {}
  };
  const engine = new TestEngine(canvas);
  engine.video = {
    videoWidth: srcW, videoHeight: srcH, paused: false, readyState: 4,
    currentTime: 0, playbackRate: 1,
    getBoundingClientRect: () => ({ width: 1, height: 1 }),
    addEventListener() {}, removeEventListener() {},
    requestVideoFrameCallback: () => 1, cancelVideoFrameCallback() {}
  };
  return engine;
}

// `devicePixelRatio` is read by _computeOutputSize.
sandbox.window.devicePixelRatio = 1;
globalThis.window = globalThis.window || sandbox.window;

/* ================================================================== *
 * The frame budget comes from the media, not from 60 Hz
 * ================================================================== */

test('budget: a 23.976 fps source gets a 41.7 ms budget, not 16.7', () => {
  const engine = makeEngine();
  engine._measuredIntervalMs = 1000 / 23.976;
  assert.ok(Math.abs(engine.frameBudgetMs() - 41.71) < 0.1,
    `budget was ${engine.frameBudgetMs()}`);
});

test('budget: a 60 fps source is not given a hidden 24 fps cap', () => {
  const engine = makeEngine();
  engine._measuredIntervalMs = 1000 / 60;
  assert.ok(Math.abs(engine.frameBudgetMs() - 16.67) < 0.1,
    `budget was ${engine.frameBudgetMs()}`);
});

/* ================================================================== *
 * The governor's lever has to move something
 * ================================================================== */

test('scale: the quality scale genuinely reduces rendered pixels', () => {
  // The regression that mattered most: this used to be clamped to at least the
  // source size, so every scale produced the same render and the same cost.
  const engine = makeEngine({ srcW: 2560, srcH: 1350, displayW: 1600, displayH: 900 });
  const at = (scale) => {
    engine._qualityScale = scale;
    const { outW, outH } = engine._computeOutputSize(2560, 1350);
    return outW * outH;
  };
  const full = at(1);
  const half = at(0.5);
  const floor = at(0.4);
  assert.ok(half < full * 0.95, `scale 0.5 produced ${half} px against ${full} at full`);
  assert.ok(floor < half, `scale 0.4 (${floor}) must be cheaper than 0.5 (${half})`);
});

test('scale: full quality is never below what the panel can show', () => {
  // Reducing past the displayed size is where the viewer starts losing real
  // detail, so the governor is not allowed to go there on its own.
  const engine = makeEngine({ srcW: 2560, srcH: 1350, displayW: 1600, displayH: 900 });
  engine._qualityScale = 0.1;
  const { outW, outH } = engine._computeOutputSize(2560, 1350);
  assert.ok(outW >= 1600 * 0.98, `render fell to ${outW}x${outH}, below the 1600px display`);
});

test('scale: a small source on a big panel is still allowed to be upscaled', () => {
  const engine = makeEngine({ srcW: 640, srcH: 360, displayW: 1920, displayH: 1080 });
  engine._qualityScale = 1;
  const { outW } = engine._computeOutputSize(640, 360);
  assert.ok(outW > 640, `a 640px source on a 1920px panel rendered ${outW}`);
});

/* ================================================================== *
 * The governor reads signals that describe the enhanced picture
 * ================================================================== */

/** Drive `_adapt` n times with one steady set of signals. */
function settle(engine, signals, ticks = 12) {
  for (let i = 0; i < ticks; i++) engine._adapt(signals);
  return engine._qualityScale;
}

test('governor: real over-budget GPU cost backs quality off', () => {
  const engine = makeEngine();
  engine._measuredIntervalMs = 1000 / 23.976;
  const after = settle(engine, { gpuMs: 60, cpuMs: 1, missRate: 0, mediaVsWall: 1 });
  assert.ok(after < 1, `quality stayed at ${after} while 60 ms was spent on a 41.7 ms budget`);
});

test('governor: a cheap CPU timer no longer masks an expensive frame', () => {
  // The exact reference-laptop reading: 0.9 ms of submission over 20 ms of real
  // GPU work. The old governor saw only the first number and voted to raise.
  const engine = makeEngine();
  engine._measuredIntervalMs = 1000 / 23.976;
  engine._qualityScale = 1;
  const overBudget = settle(engine, { gpuMs: 45, cpuMs: 0.9, missRate: 0, mediaVsWall: 1 });
  assert.ok(overBudget < 1, `the GPU number must decide, got ${overBudget}`);
});

test('governor: missed enhanced frames back quality off', () => {
  const engine = makeEngine();
  engine._measuredIntervalMs = 1000 / 23.976;
  const after = settle(engine, { gpuMs: 5, cpuMs: 1, missRate: 0.3, mediaVsWall: 1 });
  assert.ok(after < 1, `quality stayed at ${after} while 30% of frames were missed`);
});

test('governor: media falling behind the wall clock backs quality off', () => {
  const engine = makeEngine();
  engine._measuredIntervalMs = 1000 / 23.976;
  const after = settle(engine, { gpuMs: 5, cpuMs: 1, missRate: 0, mediaVsWall: 0.9 });
  assert.ok(after < 1, `quality stayed at ${after} while playback ran at 0.9x real time`);
});

test('governor: a healthy enhanced path is left alone', () => {
  // 20 ms of a 41.7 ms budget with no misses and the clock keeping time is the
  // measured reference-laptop state. It is not a reason to throw quality away.
  const engine = makeEngine();
  engine._measuredIntervalMs = 1000 / 23.976;
  const after = settle(engine, { gpuMs: 20, cpuMs: 0.9, missRate: 0, mediaVsWall: 1 }, 20);
  assert.equal(after, 1, `quality was reduced to ${after} on a healthy path`);
});

test('governor: a parked element cannot drag quality down any more', () => {
  // The measured artifact: 97.9% "dropped" with the clock at 1.0x and nothing
  // actually missed. The governor must not see this at all.
  const engine = makeEngine();
  engine._measuredIntervalMs = 1000 / 23.976;
  engine._sampleDropRate = () => 0.979;
  const after = settle(engine, { gpuMs: 18, cpuMs: 0.9, missRate: 0, mediaVsWall: 1 }, 20);
  assert.equal(after, 1, `the decoder counter still reached the governor: ${after}`);
});

test('governor: recovery is slower than backoff', () => {
  const engine = makeEngine();
  engine._measuredIntervalMs = 1000 / 23.976;

  engine._qualityScale = 1;
  engine._pressure = 0;
  engine._adapt({ gpuMs: 5, cpuMs: 1, missRate: 0.4, mediaVsWall: 1 });
  engine._adapt({ gpuMs: 5, cpuMs: 1, missRate: 0.4, mediaVsWall: 1 });
  const dropped = 1 - engine._qualityScale;

  engine._qualityScale = 0.5;
  engine._pressure = 0;
  const before = engine._qualityScale;
  for (let i = 0; i < 2; i++) engine._adapt({ gpuMs: 2, cpuMs: 0.2, missRate: 0, mediaVsWall: 1 });
  const gained = engine._qualityScale - before;

  assert.ok(dropped > 0, 'sustained misses must reduce quality');
  assert.ok(gained < dropped,
    `recovery (${gained}) must be gentler than backoff (${dropped})`);
});

test('governor: sustained headroom does eventually recover quality', () => {
  const engine = makeEngine();
  engine._measuredIntervalMs = 1000 / 23.976;
  engine._qualityScale = 0.5;
  const after = settle(engine, { gpuMs: 4, cpuMs: 0.3, missRate: 0, mediaVsWall: 1 }, 40);
  assert.ok(after > 0.5, `quality never recovered, stayed at ${after}`);
});

test('governor: the media clock is never traded for quality', () => {
  // Nothing in the governor may touch playbackRate or the media element.
  const engine = makeEngine();
  engine._measuredIntervalMs = 1000 / 23.976;
  const rateBefore = engine.video.playbackRate;
  const timeBefore = engine.video.currentTime;
  settle(engine, { gpuMs: 90, cpuMs: 40, missRate: 0.5, mediaVsWall: 0.8 }, 20);
  assert.equal(engine.video.playbackRate, rateBefore, 'playbackRate must not be touched');
  assert.equal(engine.video.currentTime, timeBefore, 'the media clock must not be touched');
});

/* ================================================================== *
 * Overload hands back to native rather than stuttering
 * ================================================================== */

test('overload: only fires at the floor, and reports honest reasons', () => {
  const engine = makeEngine();
  engine._measuredIntervalMs = 1000 / 23.976;
  const seen = [];
  engine.onOverload = (info) => seen.push(info);

  engine._qualityScale = 1;
  settle(engine, { gpuMs: 20, cpuMs: 1, missRate: 0.3, mediaVsWall: 1 }, 30);

  assert.ok(seen.length >= 1, 'sustained misses at the floor must surface');
  assert.ok(Number.isFinite(seen[0].missRate), 'the reason names the miss rate');
  assert.ok('mediaVsWall' in seen[0], 'and the playback clock');
  assert.ok(!('dropRate' in seen[0]),
    'the decoder counter must not be quoted as the reason');
});

test('overload: a healthy path never triggers it', () => {
  const engine = makeEngine();
  engine._measuredIntervalMs = 1000 / 23.976;
  let fired = 0;
  engine.onOverload = () => fired++;
  settle(engine, { gpuMs: 20, cpuMs: 0.9, missRate: 0, mediaVsWall: 1 }, 40);
  assert.equal(fired, 0, 'enhancement was switched off on a machine that was keeping up');
});

/* ================================================================== *
 * Scheduling
 * ================================================================== */

test('scheduler: enhancement is gated on new source frames, not on refreshes', () => {
  const engine = makeEngine();
  let rvfcArmed = 0;
  const draws = [];
  engine.draw = () => draws.push(sandbox.__now);
  engine.video.requestVideoFrameCallback = () => { rvfcArmed++; return rvfcArmed; };
  engine.running = true;
  sandbox.__rafQueue.length = 0;

  engine._restartFrameSource();
  assert.equal(engine.stats.scheduler, 'frame-gated');

  // The engine starts life wanting one draw to put something on the canvas.
  // This test is about what happens *after* that, in steady playback.
  engine._needsDraw = false;
  engine._pendingFrame = false;

  // Pump refreshes with no new media frame: nothing expensive may happen.
  for (let i = 0; i < 10; i++) {
    const fn = sandbox.__rafQueue.shift();
    if (fn) fn(sandbox.__now += 16.7);
  }
  assert.equal(draws.length, 0,
    `${draws.length} draws happened without a single new source frame`);

  // One new frame arrives; exactly one draw follows.
  engine._pendingFrame = true;
  const fn = sandbox.__rafQueue.shift();
  if (fn) fn(sandbox.__now += 16.7);
  assert.equal(draws.length, 1, 'a new source frame must produce exactly one draw');
});

test('scheduler: a paused video leaves no render loop running', () => {
  const engine = makeEngine();
  engine.draw = () => {};
  engine.running = true;
  sandbox.__rafQueue.length = 0;
  engine._restartFrameSource();

  engine.video.paused = true;
  // The loop must retire itself rather than re-arming for a still picture.
  const fn = sandbox.__rafQueue.shift();
  if (fn) fn(sandbox.__now += 16.7);
  assert.equal(sandbox.__rafQueue.length, 0,
    'a paused engine re-armed its presentation loop');
  assert.equal(engine._rafHandle, null);
});

test('scheduler: stopping cancels every callback it owns', () => {
  const engine = makeEngine();
  engine.draw = () => {};
  engine.running = true;
  sandbox.__rafQueue.length = 0;
  engine._restartFrameSource();
  engine._scheduleIdleDraw();
  engine.stop();
  assert.equal(engine._rafHandle, null);
  assert.equal(engine._rvfcHandle, null);
  assert.equal(engine._idleHandle, null);
  assert.equal(engine.running, false);
});

test('scheduler: with no rvfc the fallback says so rather than pretending', () => {
  const engine = makeEngine();
  engine.draw = () => {};
  engine.video.requestVideoFrameCallback = undefined;
  engine.running = true;
  sandbox.__rafQueue.length = 0;
  engine._restartFrameSource();
  assert.equal(engine.stats.scheduler, 'refresh');
});

/* ================================================================== *
 * Metrics are not conflated
 * ================================================================== */

test('metrics: decoder drops are marked untrustworthy while the element is parked', () => {
  const engine = makeEngine();
  // Watch's enhanced-mode parking: 1x1, off-screen.
  engine.video.getBoundingClientRect = () => ({ width: 1, height: 1 });
  assert.equal(engine._decoderDropsTrustworthy(), false);

  engine.video.getBoundingClientRect = () => ({ width: 1280, height: 720 });
  assert.equal(engine._decoderDropsTrustworthy(), true);
});

test('metrics: the stats block keeps the three clocks apart', () => {
  const engine = makeEngine();
  const s = engine.stats;
  for (const key of ['sourceFps', 'enhancedFps', 'missRate', 'mediaVsWall',
    'decoderDropRate', 'decoderDropTrusted', 'gpuMs', 'gpuTimingAvailable']) {
    assert.ok(key in s, `stats is missing ${key}`);
  }
  // The old name conflated our own misses with the decoder's drops.
  assert.ok(!('dropRate' in s), 'the ambiguous dropRate field must be gone');
});
