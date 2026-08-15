'use strict';

/**
 * Temporal correctness: source time must arrive at the same output time.
 *
 *   npm run verify:temporal
 *
 * Interpolation may add temporal samples. It may not change playback speed.
 * A render can report the right frame rate, the right frame count and the
 * right total duration while motion inside it runs fast or slow, so none of
 * those three is the thing to assert.
 *
 * What is asserted here is the mapping itself. RIFE `-n N` over K images
 * produces N samples evenly spaced across them, endpoints inclusive, so
 * sample j sits at input position j*(K-1)/(N-1). That is arithmetic, which
 * means the whole contract can be checked exactly and in milliseconds without
 * running a network.
 *
 * This exists because a previous change removed the trailing anchor to get rid
 * of a hold at scene cuts, and measurably turned every shot into slow motion.
 * The hold it removed was the last source frame's own display interval.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const interpolation = require(path.join(__dirname, '..', 'src', 'main', 'ai', 'interpolation-plan'));

const NTSC_24 = 24000 / 1001;     // 23.976023976…

/**
 * Where every kept sample of a shot lands, in source time and output time.
 * Mirrors what `neural.js` hands to RIFE: the shot's frames, plus a trailing
 * anchor when the plan asked for one.
 */
function mapShot(shot, fpsSrc, fpsDst) {
  const images = shot.inputFrames + (shot.anchor === 'none' ? 0 : 1);
  const requested = shot.requestFrames;
  const rows = [];
  for (let j = 0; j < shot.outputCount; j++) {
    const position = shot.startFrame +
      (requested > 1 ? (j * (images - 1)) / (requested - 1) : 0);
    /*
     * Past the last real frame of the shot there is nothing newer to show, so
     * the last real frame stays on screen — exactly as it does in the source.
     *
     * Unless the anchor is the genuine next frame, in which case those samples
     * are real interpolations toward it and motion carries on across the join.
     */
    const held = shot.anchor !== 'next' && position > shot.endFrame + 1e-9;
    rows.push({
      outputTime: (shot.outputStart + j) / fpsDst,
      sourceTime: Math.min(position, shot.endFrame) / fpsSrc,
      held
    });
  }
  return rows;
}

/** Least-squares slope of source time against output time: the speed. */
function speedOf(rows) {
  const moving = rows.filter((r) => !r.held);
  if (moving.length < 2) return null;
  const n = moving.length;
  const sx = moving.reduce((s, r) => s + r.outputTime, 0);
  const sy = moving.reduce((s, r) => s + r.sourceTime, 0);
  const sxy = moving.reduce((s, r) => s + r.outputTime * r.sourceTime, 0);
  const sxx = moving.reduce((s, r) => s + r.outputTime * r.outputTime, 0);
  return (n * sxy - sx * sy) / (n * sxx - sx * sx);
}

function planFor({ frameCount, fpsSrc, fpsDst, cutFrames = [], hasNextFrame = false }) {
  return interpolation.planInterpolation({ frameCount, fpsSrc, fpsDst, cutFrames, hasNextFrame });
}

/* ================================================================== *
 * Speed
 * ================================================================== */

test('speed: motion runs at 1x inside every shot, for every shot length', () => {
  const frameCount = 480;
  const cuts = [12, 36, 72, 120, 180, 240, 312, 384];
  const plan = planFor({ frameCount, fpsSrc: NTSC_24, fpsDst: 60, cutFrames: cuts });

  for (const shot of plan.shots.filter((s) => s.mode === 'rife')) {
    const speed = speedOf(mapShot(shot, NTSC_24, 60));
    assert.ok(speed !== null, `shot ${shot.index} produced no moving samples`);
    assert.ok(Math.abs(speed - 1) < 0.01,
      `shot ${shot.index} (${shot.inputFrames} frames) plays at ${speed.toFixed(4)}x`);
  }
});

test('speed: no shot is fast-forwarded and none is slowed', () => {
  // Both directions, because the two plausible mistakes point opposite ways:
  // consuming source frames too quickly, or stretching motion to fill time.
  for (const [fpsSrc, fpsDst] of [[NTSC_24, 60], [24, 60], [25, 60], [30, 60], [30000 / 1001, 60]]) {
    const plan = planFor({
      frameCount: Math.round(fpsSrc * 8), fpsSrc, fpsDst,
      cutFrames: [24, 60, 110, 150]
    });
    for (const shot of plan.shots.filter((s) => s.mode === 'rife')) {
      const speed = speedOf(mapShot(shot, fpsSrc, fpsDst));
      assert.ok(speed > 0.99 && speed < 1.01,
        `${fpsSrc.toFixed(3)}->${fpsDst}: shot ${shot.index} at ${speed.toFixed(4)}x`);
    }
  }
});

test('speed: a known linear motion arrives where it should', () => {
  // x(t) = v*t in source time. Sampling the plan at output times must recover
  // the same positions, which is the property a viewer actually perceives.
  const V = 300;                                  // units per second
  const plan = planFor({ frameCount: 240, fpsSrc: NTSC_24, fpsDst: 60, cutFrames: [96] });
  const rows = plan.shots
    .filter((s) => s.mode === 'rife')
    .flatMap((s) => mapShot(s, NTSC_24, 60));

  for (const probeAt of [0.5, 1.0, 1.5, 2.0, 3.0, 4.0]) {
    const row = rows.reduce((best, r) =>
      Math.abs(r.outputTime - probeAt) < Math.abs(best.outputTime - probeAt) ? r : best, rows[0]);
    const expected = V * probeAt;
    const actual = V * row.sourceTime;
    // One source frame of tolerance: a held frame legitimately lags by up to
    // its own display interval.
    assert.ok(Math.abs(actual - expected) <= V / NTSC_24 * 1.05,
      `at ${probeAt}s expected ${expected.toFixed(1)} got ${actual.toFixed(1)}`);
  }
});

/* ================================================================== *
 * Holds
 * ================================================================== */

test('holds: a shot holds its last frame for exactly one source frame, no more', () => {
  const plan = planFor({ frameCount: 240, fpsSrc: NTSC_24, fpsDst: 60, cutFrames: [48, 96, 168] });
  // One source frame, rounded up to whole output samples: the last frame of a
  // shot is displayed for its own interval and samples cannot be fractional.
  const maxHeldSeconds = Math.ceil(60 / NTSC_24) / 60;

  for (const shot of plan.shots.filter((s) => s.mode === 'rife')) {
    const rows = mapShot(shot, NTSC_24, 60);
    const held = rows.filter((r) => r.held).length;
    const heldSeconds = held / 60;
    assert.ok(heldSeconds <= maxHeldSeconds + 1e-6,
      `shot ${shot.index} holds ${heldSeconds.toFixed(4)}s, source frame is ${maxHeldSeconds.toFixed(4)}s`);
  }
});

test('holds: a shot continuing past the chunk holds nothing at all', () => {
  const plan = planFor({
    frameCount: 240, fpsSrc: NTSC_24, fpsDst: 60, cutFrames: [96], hasNextFrame: true
  });
  const last = plan.shots[plan.shots.length - 1];
  assert.equal(last.anchor, 'next');
  const held = mapShot(last, NTSC_24, 60).filter((r) => r.held).length;
  assert.equal(held, 0, 'a real next frame means motion continues across the join');
});

/* ================================================================== *
 * Duration
 * ================================================================== */

test('duration: every shot occupies the same time in the output as in the source', () => {
  const plan = planFor({ frameCount: 480, fpsSrc: NTSC_24, fpsDst: 60, cutFrames: [60, 150, 300] });
  for (const shot of plan.shots) {
    if (!shot.outputCount) continue;
    const sourceSeconds = shot.inputFrames / NTSC_24;
    const outputSeconds = shot.outputCount / 60;
    assert.ok(Math.abs(outputSeconds / sourceSeconds - 1) < 0.02,
      `shot ${shot.index}: ${sourceSeconds.toFixed(4)}s -> ${outputSeconds.toFixed(4)}s`);
  }
});

test('duration: the whole clip keeps its length across conversions', () => {
  for (const [fpsSrc, fpsDst] of [[NTSC_24, 60], [24, 60], [30000 / 1001, 60], [60, 30]]) {
    const frameCount = Math.round(fpsSrc * 12);
    const plan = planFor({ frameCount, fpsSrc, fpsDst });
    assert.ok(Math.abs(plan.outputCount / fpsDst - frameCount / fpsSrc) < 0.05,
      `${fpsSrc.toFixed(3)}->${fpsDst}`);
  }
});

/* ================================================================== *
 * Frame-rate precision
 * ================================================================== */

test('precision: NTSC rates are carried as themselves, not rounded to 24 or 30', () => {
  // Rounding 23.976 to 24 is a 0.1% speed error — small per second, and a
  // visible drift over a song.
  const exact = planFor({ frameCount: 240, fpsSrc: NTSC_24, fpsDst: 60 });
  const rounded = planFor({ frameCount: 240, fpsSrc: 24, fpsDst: 60 });
  assert.notEqual(exact.outputCount, rounded.outputCount,
    'the planner must not treat 23.976 and 24 as the same rate');
  assert.ok(Math.abs(exact.duration - 240 / NTSC_24) < 1e-6);
});
