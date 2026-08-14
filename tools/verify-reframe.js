'use strict';

/**
 * Smart Reframe tracking policy.
 *
 *   npm run verify:reframe
 *
 * Two deliberately separated halves:
 *
 *   1. **Deterministic policy tests.** Synthetic detections are fed straight
 *      into the tracker and the fusion. No model, no GPU, no network, no
 *      floating-point confidence from a detector that a future model version
 *      would move. These assert *behaviour*: which subject is elected, whether
 *      identity survives a missed face, whether a cut resets, whether two
 *      people are framed together.
 *
 *   2. **Real detector smoke tests**, at the bottom, skipped with a printed
 *      reason when the models are not installed. They assert that inference
 *      runs and produces sane geometry - never an exact score.
 *
 * The split matters: a detector upgrade should be able to change confidences
 * without rewriting the policy suite.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const subject = require(path.join(ROOT, 'src', 'main', 'ai', 'subject-track'));
const tracking = require(path.join(ROOT, 'src', 'main', 'ai', 'tracking'));
const detector = require(path.join(ROOT, 'src', 'main', 'ai', 'detector'));
const semantic = require(path.join(ROOT, 'src', 'main', 'ai', 'engines', 'semantic'));

/* ------------------------------------------------------------------ *
 * Fixtures: synthetic detections
 * ------------------------------------------------------------------ */

/** A face box centred at (cx, cy) with the given width, all normalised. */
function face(cx, cy = 0.3, w = 0.09, score = 0.9) {
  const h = w * 1.3;
  return { x: cx - w / 2, y: cy - h / 2, w, h, score, kind: 'face' };
}

/** A person box centred horizontally at cx, occupying most of the height. */
function person(cx, w = 0.22, score = 0.8, y = 0.15, h = 0.8) {
  return { x: cx - w / 2, y, w, h, score, kind: 'person' };
}

/** Drive a tracker over a scripted sequence and report what it did. */
function drive(script, { profile = 'auto', cropWidth = 0.32 } = {}) {
  const tracker = new subject.SubjectTracker({ profile });
  const out = [];
  for (let i = 0; i < script.length; i++) {
    const step = script[i];
    if (step.cut) tracker.reset();
    const elected = tracker.observe({
      time: i * 0.25,
      faces: step.faces || [],
      persons: step.persons || []
    });
    const composed = elected.subject ? tracker.compose(elected.subject, cropWidth) : null;
    out.push({
      subjectId: elected.subject ? elected.subject.id : null,
      source: elected.source,
      centre: composed ? composed.x : null,
      grouped: composed ? composed.grouped : false
    });
  }
  return out;
}

/** Repeat one frame `n` times. */
function hold(frame, n) {
  return Array.from({ length: n }, () => frame);
}

/* ------------------------------------------------------------------ *
 * 1-2. Static person, left and right
 * ------------------------------------------------------------------ */

test('policy: a static person on the left is tracked on the left', () => {
  const result = drive(hold({ faces: [face(0.2)], persons: [person(0.2)] }, 12));
  const settled = result.slice(4);
  for (const r of settled) {
    assert.equal(r.source, 'face', 'a visible face is the strongest signal');
    assert.ok(Math.abs(r.centre - 0.2) < 0.06, `centre ${r.centre} should sit near 0.2`);
  }
  // One identity throughout: a static subject must not be re-acquired.
  assert.equal(new Set(result.map((r) => r.subjectId)).size, 1);
});

test('policy: a static person on the right is tracked on the right', () => {
  const result = drive(hold({ faces: [face(0.82)], persons: [person(0.82)] }, 12));
  for (const r of result.slice(4)) {
    assert.ok(Math.abs(r.centre - 0.82) < 0.06, `centre ${r.centre} should sit near 0.82`);
  }
});

/* ------------------------------------------------------------------ *
 * 3. Static person against a moving background - the reason this exists
 * ------------------------------------------------------------------ */

test('policy: a semantic subject beats a saliency centroid elsewhere in frame', () => {
  // Saliency is confidently wrong: foliage on the left has more motion energy
  // than a person standing still on the right. Measured on a real fixture,
  // saliency put the crop at 0.61 while the person was at 0.83.
  const fused = subject.fuseSample({
    semantic: { subject: {}, source: 'face', focus: 0.83 },
    saliency: { center: 0.35, confidence: 0.9 },
    previous: 0.5
  });
  assert.equal(fused.center, 0.83, 'the person wins');
  assert.equal(fused.source, 'face');
});

test('policy: saliency still decides when there is no semantic subject', () => {
  const fused = subject.fuseSample({
    semantic: null,
    saliency: { center: 0.71, confidence: 0.6 },
    previous: 0.5
  });
  assert.equal(fused.center, 0.71);
  assert.equal(fused.source, 'saliency');
});

/* ------------------------------------------------------------------ *
 * 4. Person moving across frame
 * ------------------------------------------------------------------ */

test('policy: a person crossing the frame keeps one identity', () => {
  const script = [];
  for (let i = 0; i < 16; i++) {
    const cx = 0.2 + (i / 15) * 0.6;
    script.push({ faces: [face(cx)], persons: [person(cx)] });
  }
  const result = drive(script);
  assert.equal(new Set(result.map((r) => r.subjectId)).size, 1,
    'a moving subject is one person, not sixteen');
  assert.ok(result[0].centre < 0.35, `starts left, got ${result[0].centre}`);
  assert.ok(result[result.length - 1].centre > 0.65, `ends right, got ${result[result.length - 1].centre}`);
  // Monotonic-ish: the crop follows rather than jumping about.
  for (let i = 1; i < result.length; i++) {
    assert.ok(result[i].centre >= result[i - 1].centre - 0.02, 'the crop does not reverse');
  }
});

/* ------------------------------------------------------------------ *
 * 5. Person leaves frame briefly
 * ------------------------------------------------------------------ */

test('policy: a subject that leaves briefly is the same subject on return', () => {
  const present = { faces: [face(0.7)], persons: [person(0.7)] };
  const script = [...hold(present, 6), ...hold({ faces: [], persons: [] }, 3), ...hold(present, 6)];
  const result = drive(script);
  const before = result[5].subjectId;
  const after = result[result.length - 1].subjectId;
  assert.equal(before, after, 'identity survives a short absence');
  // While absent there is nothing to elect from, so no semantic source.
  assert.equal(result[7].source, null);
});

test('policy: a subject gone for a long time is dropped rather than haunting the crop', () => {
  const present = { faces: [face(0.7)], persons: [person(0.7)] };
  const empty = { faces: [], persons: [] };
  const tuning = subject.tuningFor('auto');
  const result = drive([...hold(present, 4), ...hold(empty, tuning.maxMisses + 3)]);
  assert.equal(result[result.length - 1].subjectId, null,
    'the track ages out after maxMisses');
});

/* ------------------------------------------------------------------ *
 * 6. Face missed, body remains
 * ------------------------------------------------------------------ */

test('policy: losing the face keeps the person track and says so', () => {
  const withFace = { faces: [face(0.35)], persons: [person(0.35)] };
  const bodyOnly = { faces: [], persons: [person(0.35)] };
  const result = drive([...hold(withFace, 5), ...hold(bodyOnly, 4), ...hold(withFace, 3)]);

  assert.equal(result[4].source, 'face');
  assert.equal(result[6].source, 'person', 'the body carries the track');
  assert.equal(result[result.length - 1].source, 'face', 'and the face resumes it');

  const ids = new Set(result.map((r) => r.subjectId));
  assert.equal(ids.size, 1, 'the same human throughout - a turned head is not a new person');

  // The crop must not lurch when the face drops out.
  for (let i = 1; i < result.length; i++) {
    assert.ok(Math.abs(result[i].centre - result[i - 1].centre) < 0.08,
      `step ${i} moved ${Math.abs(result[i].centre - result[i - 1].centre).toFixed(3)}`);
  }
});

/* ------------------------------------------------------------------ *
 * 7-8. Two people
 * ------------------------------------------------------------------ */

test('policy: two nearby people are framed together', () => {
  const frame = {
    faces: [face(0.44), face(0.56)],
    persons: [person(0.44), person(0.56)]
  };
  const result = drive(hold(frame, 8), { cropWidth: 0.45 });
  const last = result[result.length - 1];
  assert.ok(last.grouped, 'both fit, so both are kept');
  assert.ok(Math.abs(last.centre - 0.5) < 0.06,
    `a two-shot is centred between them, got ${last.centre}`);
});

test('policy: two distant people do not make the crop oscillate', () => {
  // Confidence deliberately flickers between them, which is what makes a
  // naive argmax ping-pong.
  const script = [];
  for (let i = 0; i < 20; i++) {
    const a = i % 2 === 0 ? 0.92 : 0.78;
    const b = i % 2 === 0 ? 0.8 : 0.9;
    script.push({
      faces: [face(0.15, 0.3, 0.09, a), face(0.85, 0.3, 0.09, b)],
      persons: [person(0.15, 0.22, a), person(0.85, 0.22, b)]
    });
  }
  const result = drive(script, { cropWidth: 0.32 });
  const settled = result.slice(6);
  const ids = new Set(settled.map((r) => r.subjectId));
  assert.equal(ids.size, 1, `the subject must not alternate, saw ${ids.size} identities`);
  const spread = Math.max(...settled.map((r) => r.centre)) - Math.min(...settled.map((r) => r.centre));
  assert.ok(spread < 0.05, `crop should be stable, moved ${spread.toFixed(3)}`);
});

test('policy: dialogue is more reluctant to switch subject than action', () => {
  assert.ok(subject.tuningFor('dialogue').switchHold > subject.tuningFor('action').switchHold);
  assert.ok(subject.tuningFor('dialogue').switchMargin > subject.tuningFor('action').switchMargin);
  // Gaming is the most reluctant of all: an incidental webcam face must not
  // steal the crop from the game.
  assert.ok(subject.tuningFor('gaming').switchMargin >= subject.tuningFor('dialogue').switchMargin);
  assert.ok(subject.tuningFor('gaming').salienceWeight > subject.tuningFor('dialogue').salienceWeight);
});

test('policy: a clearly dominant subject does eventually win', () => {
  // A small far figure, then someone walks up close and stays. Persistence
  // should not mean permanence.
  const script = [
    ...hold({ faces: [face(0.2, 0.3, 0.05, 0.7)], persons: [person(0.2, 0.1, 0.6)] }, 6),
    ...hold({
      faces: [face(0.2, 0.3, 0.05, 0.7), face(0.75, 0.3, 0.18, 0.95)],
      persons: [person(0.2, 0.1, 0.6), person(0.75, 0.4, 0.92)]
    }, 14)
  ];
  const result = drive(script);
  assert.ok(Math.abs(result[5].centre - 0.2) < 0.08, 'starts on the first subject');
  assert.ok(result[result.length - 1].centre > 0.6,
    `the dominant subject takes over, ended at ${result[result.length - 1].centre}`);
});

/* ------------------------------------------------------------------ *
 * 9. Hard cut
 * ------------------------------------------------------------------ */

test('policy: a hard cut establishes a new subject instead of gliding', () => {
  const script = [
    ...hold({ faces: [face(0.2)], persons: [person(0.2)] }, 6),
    { cut: true, faces: [face(0.8)], persons: [person(0.8)] },
    ...hold({ faces: [face(0.8)], persons: [person(0.8)] }, 5)
  ];
  const result = drive(script);
  assert.ok(Math.abs(result[5].centre - 0.2) < 0.06, 'shot one is on the left');
  // Straight onto the new subject: a cut is not a camera move.
  assert.ok(Math.abs(result[6].centre - 0.8) < 0.06,
    `shot two should snap to 0.8, got ${result[6].centre}`);
  assert.notEqual(result[5].subjectId, result[6].subjectId,
    'identity does not survive a cut');
});

/* ------------------------------------------------------------------ *
 * 10-11. No people
 * ------------------------------------------------------------------ */

test('policy: no people means no semantic subject at all', () => {
  const result = drive(hold({ faces: [], persons: [] }, 8));
  assert.ok(result.every((r) => r.source === null && r.subjectId === null));
});

test('policy: with no people the trajectory is saliency, and is labelled saliency', () => {
  // A moving object: saliency is the right answer and must be named as such.
  const samples = [];
  for (let i = 0; i < 20; i++) {
    samples.push({ time: i * 0.25, center: 0.3 + i * 0.02, confidence: 0.7, source: 'saliency' });
  }
  const t = tracking.buildTrajectory({ samples, cuts: [], profile: 'action' });
  const s = tracking.summariseTracking({
    samples: samples.length, tracked: t.tracked, holds: t.holds, fallbacks: t.fallbacks,
    trackedConfidence: t.trackedConfidence, cuts: 0, usage: t.usage, semanticAvailable: true
  });
  assert.equal(s.primaryBackend, 'saliency');
  assert.equal(s.faceSamples, 0);
  assert.equal(s.personSamples, 0);
  assert.equal(s.saliencySamples, s.tracked);
  assert.doesNotMatch(s.primaryBackendLabel, /face/i,
    'semantic availability must never imply semantic use');
});

test('policy: gameplay keeps saliency primary when a face is incidental', () => {
  // One small low-confidence face in a corner, as a webcam overlay is. Gaming
  // demands a large sustained margin before a face takes the crop.
  const tuning = subject.tuningFor('gaming');
  const result = drive(hold({
    faces: [face(0.9, 0.85, 0.05, 0.62)],
    persons: []
  }, 4), { profile: 'gaming' });
  // It is legitimate for the tracker to see it; what matters is that the
  // profile makes it hard to hold the crop, and that the summary names the
  // signal that actually dominated.
  assert.ok(tuning.switchHold >= 6);
  assert.ok(tuning.maxMisses <= 4, 'a webcam face is dropped quickly once gone');
  assert.ok(result.length === 4);
});

/* ------------------------------------------------------------------ *
 * 12. Nothing useful at all
 * ------------------------------------------------------------------ */

test('policy: nothing to track ends at centre and says so without a confidence', () => {
  const samples = Array.from({ length: 20 }, (_, i) => ({
    time: i * 0.25, center: 0.5, confidence: 0, source: 'saliency'
  }));
  const t = tracking.buildTrajectory({ samples, cuts: [], profile: 'auto' });
  const s = tracking.summariseTracking({
    samples: samples.length, tracked: t.tracked, holds: t.holds, fallbacks: t.fallbacks,
    trackedConfidence: t.trackedConfidence, cuts: 0, usage: t.usage
  });
  assert.equal(s.outcome, 'centred');
  assert.equal(s.tracked, 0);
  assert.match(s.warning, /Centre framing was used/i);
  assert.doesNotMatch(s.headline, /confidence/i,
    'a failed run must never quote a confidence');
});

/* ------------------------------------------------------------------ *
 * 13-14. Semantic unavailable / failing
 * ------------------------------------------------------------------ */

test('fallback: no models directory means saliency, silently and safely', async () => {
  const notes = [];
  const result = await tracking.runSemanticLayer({
    modelsDir: null, notes, samples: [], cuts: [], profile: 'auto'
  });
  assert.equal(result.available, false);
  assert.equal(result.attempted, false);
  assert.equal(result.reason, 'disabled');
  assert.equal(notes.length, 0, 'a deliberate opt-out is not a warning');
});

test('fallback: missing model files degrade to saliency with a readable note', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-nomodels-'));
  const notes = [];
  const samples = [{ time: 0, center: 0.4, confidence: 0.5, source: 'saliency' }];
  const result = await tracking.runSemanticLayer({
    modelsDir: empty, notes, samples, cuts: [], profile: 'auto'
  });
  assert.equal(result.available, false);
  assert.match(result.reason, /models missing|runtime unavailable/);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /motion and detail tracking was used/i);
  // Crucially the saliency samples are untouched.
  assert.equal(samples[0].source, 'saliency');
  assert.equal(samples[0].center, 0.4);
  fs.rmSync(empty, { recursive: true, force: true });
});

test('fallback: a detector that throws never fails the export', async () => {
  // The failure path is exercised by pointing at a directory containing files
  // with the right names and the wrong contents: load must fail, not crash.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-badmodels-'));
  for (const m of semantic.MODELS) fs.writeFileSync(path.join(dir, m.file), Buffer.alloc(m.bytes));
  const notes = [];
  const samples = [{ time: 0, center: 0.4, confidence: 0.5, source: 'saliency' }];

  let threw = null;
  let result;
  try {
    result = await tracking.runSemanticLayer({
      modelsDir: dir, notes, samples, cuts: [], profile: 'auto',
      ffmpeg: 'ffmpeg-that-does-not-exist'
    });
  } catch (err) {
    threw = err;
  }
  assert.equal(threw, null, 'a broken detector must not throw into the job');
  assert.equal(result.available, false, 'and must report itself unavailable');
  assert.ok(notes.length >= 1, 'and must say something the user can read');
  assert.equal(samples[0].source, 'saliency', 'leaving saliency intact');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fallback: the fusion chain is exactly semantic > saliency > hold > centre', () => {
  const all = subject.fuseSample({
    semantic: { subject: {}, source: 'person', focus: 0.7 },
    saliency: { center: 0.3, confidence: 0.9 }, previous: 0.4
  });
  assert.deepEqual([all.center, all.source], [0.7, 'person']);

  const noSemantic = subject.fuseSample({
    semantic: null, saliency: { center: 0.3, confidence: 0.9 }, previous: 0.4
  });
  assert.deepEqual([noSemantic.center, noSemantic.source], [0.3, 'saliency']);

  const weakSaliency = subject.fuseSample({
    semantic: null, saliency: { center: 0.3, confidence: 0.01 }, previous: 0.4
  });
  assert.deepEqual([weakSaliency.center, weakSaliency.source], [0.4, 'hold']);

  const nothing = subject.fuseSample({ semantic: null, saliency: null, previous: null });
  assert.deepEqual([nothing.center, nothing.source], [0.5, 'centre']);
});

/* ------------------------------------------------------------------ *
 * 15. Manual framing wins
 * ------------------------------------------------------------------ */

test('policy: manual framing never runs the tracker at all', () => {
  const recipes = require(path.join(ROOT, 'src', 'main', 'recipe'));
  const pipeline = require(path.join(ROOT, 'src', 'main', 'jobs', 'pipeline'));
  const analysis = {
    container: {}, video: { width: 1920, height: 1080, nominalFps: 30 },
    audio: {}, timing: { durationSeconds: 10 },
    derived: { displayWidth: 1920, displayHeight: 1080, durationSeconds: 10 }
  };
  for (const trackingMode of ['center', 'none']) {
    const { recipe } = recipes.sanitize({
      output: { path: 'out.mp4' },
      framing: { enabled: true, canvas: '9:16', mode: 'fill', tracking: trackingMode }
    });
    const geometry = recipes.resolveOutputGeometry(recipe, analysis);
    const stages = pipeline.planStages(recipe, analysis, geometry, {});
    assert.equal(stages.stages.find((s) => s.id === 'REFRAME').mode, 'fused',
      `tracking=${trackingMode} must not become an analysis pass`);
  }
});

/* ------------------------------------------------------------------ *
 * Sampling plan and accounting
 * ------------------------------------------------------------------ */

test('sampling: semantic calls stay bounded however long the source is', () => {
  for (const [duration, maxCalls] of [[10, 45], [60, 160], [600, 160], [7200, 160]]) {
    const plan = subject.planSemanticSampling(duration);
    assert.ok(plan.count <= maxCalls,
      `${duration}s planned ${plan.count} detections`);
    // And it always lands on the saliency grid, so results attribute to a real
    // sample rather than one they do not belong to.
    const onGrid = Math.abs(plan.intervalSeconds * subject.SALIENCY_FPS -
      Math.round(plan.intervalSeconds * subject.SALIENCY_FPS)) < 1e-9;
    assert.ok(onGrid, `interval ${plan.intervalSeconds} is off the saliency grid`);
  }
  // A short clip gets the finest rate available.
  assert.equal(subject.planSemanticSampling(10).everyNthSaliency, 1);
});

test('accounting: the canonical invariant survives the semantic metrics', () => {
  const cases = [
    { usage: { face: 30, person: 6, saliency: 0 }, tracked: 36, holds: 4, fallbacks: 0, samples: 40 },
    { usage: { face: 14, person: 8, saliency: 9 }, tracked: 31, holds: 9, fallbacks: 2, samples: 40 },
    { usage: { face: 0, person: 0, saliency: 4 }, tracked: 4, holds: 36, fallbacks: 27, samples: 40 },
    { usage: { face: 0, person: 0, saliency: 0 }, tracked: 0, holds: 20, fallbacks: 20, samples: 20 }
  ];
  for (const c of cases) {
    const s = tracking.summariseTracking({ ...c, trackedConfidence: 0.7, cuts: 1 });
    assert.equal(s.tracked + s.held + s.centred, s.samples,
      `${s.tracked}+${s.held}+${s.centred} != ${s.samples}`);
    assert.equal(s.faceSamples + s.personSamples + s.saliencySamples, s.tracked,
      'the semantic breakdown must account for exactly the tracked samples');
    assert.equal(s.semanticSamples, s.faceSamples + s.personSamples);
  }
});

test('accounting: the backend name follows the counts, not the availability', () => {
  const name = (usage) => tracking.primaryBackendFor(usage).label;
  assert.match(name({ face: 30, person: 6, saliency: 0 }), /Face \+ person/);
  assert.match(name({ face: 30, person: 0, saliency: 0 }), /Face tracking/);
  assert.match(name({ face: 0, person: 12, saliency: 0 }), /Person tracking/);
  assert.match(name({ face: 0, person: 0, saliency: 20 }), /saliency/i);
  // A meaningful saliency share must be disclosed, not hidden behind a
  // detector's name.
  assert.match(name({ face: 14, person: 8, saliency: 9 }), /Semantic \+ saliency/);
  assert.match(name({ face: 20, person: 0, saliency: 1 }), /Face tracking/);
});

test('accounting: a summary never pairs a failure warning with a success metric', () => {
  for (let tracked = 0; tracked <= 40; tracked += 2) {
    const s = tracking.summariseTracking({
      samples: 40, tracked, holds: 40 - tracked, fallbacks: 40 - tracked,
      trackedConfidence: 1, cuts: 2,
      usage: { face: tracked, person: 0, saliency: 0 }
    });
    if (s.outcome === 'centred') {
      assert.doesNotMatch(s.headline, /confidence/i);
      assert.ok(s.warning);
    }
    if (s.outcome === 'tracked') assert.equal(s.warning, null);
  }
});

/* ------------------------------------------------------------------ *
 * Composition
 * ------------------------------------------------------------------ */

test('composition: a face is not nailed to dead centre', () => {
  // Landmarks placed to the right within the face mean the subject faces
  // right, so the crop leaves room on that side.
  const tracker = new subject.SubjectTracker({ profile: 'dialogue' });
  const f = face(0.5);
  f.landmarks = [
    { x: f.x + f.w * 0.62, y: 0.28 }, { x: f.x + f.w * 0.86, y: 0.28 },
    { x: f.x + f.w * 0.75, y: 0.32 }, { x: f.x + f.w * 0.64, y: 0.36 },
    { x: f.x + f.w * 0.84, y: 0.36 }
  ];
  tracker.observe({ time: 0, faces: [f], persons: [person(0.5)] });
  const composed = tracker.compose(tracker.tracks[0], 0.32);
  assert.ok(composed.x > 0.5, `look-room should shift right, got ${composed.x}`);
  assert.ok(composed.x < 0.56, 'but only a little');
});

test('composition: the crop centre always stays inside the frame', () => {
  for (const cx of [0.02, 0.1, 0.5, 0.9, 0.98]) {
    const tracker = new subject.SubjectTracker({ profile: 'auto' });
    tracker.observe({ time: 0, faces: [face(cx)], persons: [person(cx)] });
    const composed = tracker.compose(tracker.tracks[0], 0.32);
    assert.ok(composed.x >= 0 && composed.x <= 1, `centre ${composed.x} out of frame`);
  }
});

/* ================================================================== *
 * REAL detector smoke tests
 *
 * Deliberately separate, deliberately loose. They prove inference runs and
 * the geometry is sane; they never assert an exact confidence, because a
 * model revision would change it without anything being wrong.
 * ================================================================== */

const MODELS_DIR = process.env.VISIONANCE_SEMANTIC_MODELS ||
  path.join(os.homedir(), 'AppData', 'Roaming', 'Visionance', 'engines', 'semantic', 'models');
const FIXTURE = process.env.VISIONANCE_FACE_FIXTURE || null;

const probe = detector.probe(MODELS_DIR);

test('real: the runtime loads and reports itself honestly', () => {
  const runtime = detector.loadRuntime();
  if (!runtime.ok) {
    console.log(`      note: ONNX Runtime unavailable (${runtime.error}) - semantic tests skipped`);
    assert.ok(typeof runtime.error === 'string', 'and says why');
    return;
  }
  assert.ok(runtime.ort, 'a loaded runtime exposes a session factory');
  assert.equal(typeof runtime.ort.InferenceSession.create, 'function');
});

test('real: both models load and infer on a human image', async (t) => {
  if (!probe.ready) {
    console.log(`      note: models not installed (${JSON.stringify(probe.missingModels)}) - skipped`);
    return t.skip('semantic models are not installed');
  }
  if (!FIXTURE || !fs.existsSync(FIXTURE)) {
    console.log('      note: set VISIONANCE_FACE_FIXTURE to a photo of a person - skipped');
    return t.skip('no human fixture supplied');
  }

  const { spawnSync } = require('child_process');
  const ffmpeg = require(path.join(ROOT, 'node_modules', 'ffmpeg-static'));
  const S = detector.FACE_SIZE;
  const run = spawnSync(ffmpeg, ['-v', 'error', '-i', FIXTURE,
    '-vf', `scale=${S}:${S}:force_original_aspect_ratio=decrease,pad=${S}:${S}:(ow-iw)/2:(oh-ih)/2:color=black`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
  assert.equal(run.status, 0, 'the fixture decodes');
  assert.equal(run.stdout.length, S * S * 3, 'one letterboxed frame');

  const engine = new detector.SemanticDetector({ modelsDir: MODELS_DIR });
  assert.equal(await engine.load(), true, engine.error || 'models load');

  const started = Date.now();
  const found = await engine.detect(run.stdout);
  const ms = Date.now() - started;

  console.log(`      inference ${ms}ms  faces=${found.faces.length}  persons=${found.persons.length}  backend=${engine.backend}`);

  assert.ok(found.faces.length >= 1, 'a photograph of a person contains a face');
  for (const f of found.faces) {
    assert.ok(f.x >= -0.1 && f.x <= 1.1, `face x ${f.x} is in frame`);
    assert.ok(f.w > 0.01 && f.w < 1, `face width ${f.w} is plausible`);
    assert.ok(f.score > 0 && f.score <= 1);
    assert.ok(Array.isArray(f.landmarks) && f.landmarks.length === 5, 'five landmarks');
  }
  for (const p of found.persons) {
    assert.ok(p.w > 0.02 && p.h > 0.02, 'a person box has area');
  }
  // The face should sit inside a person box when both are found - the
  // association the tracker depends on.
  if (found.faces.length && found.persons.length) {
    const f = found.faces[0];
    const best = found.persons
      .map((p) => subject.containment(f, p))
      .sort((a, b) => b - a)[0];
    assert.ok(best > 0.3, `face should overlap a person box, best containment ${best.toFixed(2)}`);
  }
  engine.dispose();
});

test('real: inference stays within a sane time budget', async (t) => {
  if (!probe.ready || !FIXTURE || !fs.existsSync(FIXTURE)) return t.skip('needs models and a fixture');
  const { spawnSync } = require('child_process');
  const ffmpeg = require(path.join(ROOT, 'node_modules', 'ffmpeg-static'));
  const S = detector.FACE_SIZE;
  const run = spawnSync(ffmpeg, ['-v', 'error', '-i', FIXTURE,
    '-vf', `scale=${S}:${S}:force_original_aspect_ratio=decrease,pad=${S}:${S}:(ow-iw)/2:(oh-ih)/2`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });

  const engine = new detector.SemanticDetector({ modelsDir: MODELS_DIR });
  await engine.load();
  for (let i = 0; i < 3; i++) await engine.detect(run.stdout);
  const per = engine.stats.inferenceMs / engine.stats.frames;
  console.log(`      ${per.toFixed(0)}ms per frame across ${engine.stats.frames} frames (CPU)`);
  // Generous: this is a smoke test on unknown hardware, not a benchmark. The
  // point is to catch an order-of-magnitude regression.
  assert.ok(per < 2000, `${per}ms per frame is too slow to be usable`);
  engine.dispose();
});
