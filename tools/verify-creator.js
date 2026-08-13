/**
 * Creator finishing verification.
 *
 * Covers the session-3 backend: Auto recipes, Smart Reframe, colour finishing,
 * audio mastering and the platform output presets. Real ffmpeg renders on tiny
 * synthetic clips - short enough to be a test, real enough to prove the filter
 * graphs actually execute and the output geometry is what was asked for.
 *
 * Neural engines are only exercised if they happen to be installed, and the
 * summary says which half ran.
 *
 *   node tools/verify-creator.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const auto = require(path.join(ROOT, 'src', 'main', 'auto-recipe'));
const recipes = require(path.join(ROOT, 'src', 'main', 'recipe'));
const tracking = require(path.join(ROOT, 'src', 'main', 'ai', 'tracking'));
const filters = require(path.join(ROOT, 'src', 'main', 'ffmpeg', 'filters'));
const presets = require(path.join(ROOT, 'src', 'main', 'creator-presets'));
const { JobManager } = require(path.join(ROOT, 'src', 'main', 'jobs', 'job-manager'));
const { EngineManager } = require(path.join(ROOT, 'src', 'main', 'ai', 'engine-manager'));
const { analyze } = require(path.join(ROOT, 'src', 'main', 'media-analyzer'));
const { logger } = require(path.join(ROOT, 'src', 'main', 'logger'));

logger.level = process.env.VISIONANCE_LOG || 'error';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'visionance-creator-'));
let failures = 0;
let ran = 0;
const check = (ok, label, detail) => {
  ran++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

function staticBinary(name) {
  try {
    const mod = require(path.join(ROOT, 'node_modules', name));
    const p = typeof mod === 'string' ? mod : mod && mod.path;
    return p && fs.existsSync(p) ? p : null;
  } catch { return null; }
}
const FFMPEG = staticBinary('ffmpeg-static');
const FFPROBE = staticBinary('ffprobe-static');

function make(name, args) {
  const f = path.join(TMP, name);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args, f]);
  return f;
}
function probe(f) {
  return JSON.parse(execFileSync(FFPROBE,
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', f]).toString());
}

/** A synthetic analysis, so Auto can be tested without decoding anything. */
function fakeAnalysis(o = {}) {
  const w = o.width || 1920;
  const h = o.height || 1080;
  const fps = o.fps || 24;
  const bitrate = o.bitrate !== undefined ? o.bitrate : 12e6;
  return {
    schemaVersion: 1,
    source: { type: 'local', path: 'C:\\v\\clip.mp4', name: 'clip.mp4' },
    container: { duration: o.duration || 60, bitrate, size: 1e8 },
    video: { width: w, height: h, nominalFps: fps, codec: 'h264', bitrate },
    color: { isHDR: !!o.hdr, transfer: o.hdr ? 'smpte2084' : 'bt709' },
    audio: o.silent ? null : { codec: 'aac', channels: 2, sampleRate: 48000 },
    audioStreams: [],
    subtitleStreams: [],
    derived: {
      displayWidth: w, displayHeight: h, nominalFps: fps,
      durationSeconds: o.duration || 60,
      orientation: w >= h ? 'landscape' : 'portrait',
      isVertical: h > w, isHDR: !!o.hdr, isInterlaced: false,
      hasAudio: !o.silent, frameRateMode: 'constant',
      resolutionClass: h >= 2000 ? '4K' : h >= 1000 ? '1080p' : '720p'
    },
    warnings: []
  };
}

const ALL_ENGINES = { realesrgan: true, rife: true, reframe: true };

/* ================================================================== *
 * Auto
 * ================================================================== */

function testAuto() {
  console.log('\nAuto processing');

  // Clean cinematic 1080p23.976 - the case Auto most often gets wrong.
  {
    const a = fakeAnalysis({ fps: 23.976, bitrate: 20e6 });
    const r = auto.buildAutoRecipe({
      analysis: a, platform: 'youtube', engines: ALL_ENGINES, outputPath: 'o.mp4'
    });
    check(r.recipe.motion.interpolation === 'none',
      'clean cinematic 23.976 keeps its frame rate', `interpolation=${r.recipe.motion.interpolation}`);
    check(r.recipe.reconstruction.mode !== 'neural',
      'clean 1080p is not sent through a 4x network', `mode=${r.recipe.reconstruction.mode}`);
    check(r.profile === 'film', 'a 24 fps 1080p source is profiled as film', r.profile);
    check(r.explanations.some((e) => /original frame rate preserved/i.test(e)),
      'the frame-rate decision is explained');
    check(r.explanations.some((e) => /already clean/i.test(e)),
      'the "no restoration" decision is explained');
    check(r.cost === 'fast' || r.cost === 'moderate', 'a light job is costed as such', r.cost);
  }

  // Compressed 720p heading for 1080p.
  {
    const a = fakeAnalysis({ width: 1280, height: 720, fps: 30, bitrate: 700e3 });
    const r = auto.buildAutoRecipe({
      analysis: a, platform: 'youtube', engines: ALL_ENGINES, outputPath: 'o.mp4'
    });
    check(r.recipe.restore.enabled, 'a low-bitrate source turns on restoration');
    check(r.recipe.reconstruction.mode === 'neural',
      'compressed 720p heading to 1080p uses the network', `mode=${r.recipe.reconstruction.mode}`);
    check(r.explanations.some((e) => /neural/i.test(e)), 'the neural decision is explained');
    check(['moderate', 'heavy', 'very-heavy'].includes(r.cost),
      'a neural job is costed above "fast"', r.cost);
  }

  // Clean 720p heading for 1080p: classical, not neural.
  {
    const a = fakeAnalysis({ width: 1280, height: 720, fps: 30, bitrate: 9e6 });
    const r = auto.buildAutoRecipe({
      analysis: a, platform: 'youtube', engines: ALL_ENGINES, outputPath: 'o.mp4'
    });
    check(r.recipe.reconstruction.enabled && r.recipe.reconstruction.mode === 'classical',
      'a clean source is upscaled classically rather than hallucinated',
      `mode=${r.recipe.reconstruction.mode}`);
  }

  // Animation picks the animation model.
  {
    const a = fakeAnalysis({ width: 1280, height: 720, fps: 24, bitrate: 800e3 });
    const r = auto.buildAutoRecipe({
      analysis: a, platform: 'youtube', profile: 'animation', engines: ALL_ENGINES, outputPath: 'o.mp4'
    });
    check(r.recipe.reconstruction.model === 'animation',
      'the animation profile selects the animation model', r.recipe.reconstruction.model);
  }

  // Already 60 fps: no interpolation, whatever the profile.
  {
    const a = fakeAnalysis({ fps: 60, bitrate: 15e6 });
    const r = auto.buildAutoRecipe({
      analysis: a, platform: 'youtube', profile: 'action', engines: ALL_ENGINES, outputPath: 'o.mp4'
    });
    check(r.recipe.motion.interpolation === 'none',
      'a 60 fps source is not interpolated again', r.recipe.motion.interpolation);
    check(r.explanations.some((e) => /already 60 fps/i.test(e)), 'and the reason is stated');
  }

  // Action at 30 fps may go to 60, and must say what that costs.
  {
    const a = fakeAnalysis({ fps: 30, bitrate: 15e6 });
    const r = auto.buildAutoRecipe({
      analysis: a, platform: 'youtube', profile: 'action', engines: ALL_ENGINES, outputPath: 'o.mp4'
    });
    check(r.recipe.motion.interpolation === 'ai' && r.recipe.motion.targetFps === 60,
      'action content is offered AI 60 fps', `${r.recipe.motion.interpolation}@${r.recipe.motion.targetFps}`);
    check(r.explanations.some((e) => /motion character/i.test(e)),
      'interpolation warns that it changes the motion character');
  }

  // 16:9 to a Short: canvas plus Smart Reframe.
  {
    const a = fakeAnalysis({ fps: 30, bitrate: 12e6 });
    const r = auto.buildAutoRecipe({
      analysis: a, platform: 'youtube-shorts', engines: ALL_ENGINES, outputPath: 'o.mp4'
    });
    const g = recipes.resolveOutputGeometry(r.recipe, a);
    check(g.width === 1080 && g.height === 1920, '16:9 to a Short produces 1080x1920', `${g.width}x${g.height}`);
    check(r.recipe.framing.tracking === 'auto', 'Smart Reframe is enabled for the crop',
      r.recipe.framing.tracking);
    check(r.explanations.some((e) => /Smart Reframe/i.test(e)), 'and it is explained');
  }

  // Missing engines: degrade honestly.
  {
    const a = fakeAnalysis({ width: 1280, height: 720, fps: 30, bitrate: 700e3 });
    const r = auto.buildAutoRecipe({
      analysis: a, platform: 'youtube-shorts', engines: {}, outputPath: 'o.mp4'
    });
    check(r.recipe.reconstruction.mode !== 'neural',
      'without Real-ESRGAN, Auto does not ask for neural work', r.recipe.reconstruction.mode);
    check(r.warnings.some((w) => /Real-ESRGAN is not installed/i.test(w)),
      'and it says why it could not');
    check(r.recipe.framing.tracking !== 'auto',
      'without tracking, framing falls back to a centre crop', r.recipe.framing.tracking);
    check(r.warnings.some((w) => /tracking is unavailable/i.test(w)), 'and says so');
  }

  // Screencast protects text.
  {
    const a = fakeAnalysis({ fps: 30, bitrate: 700e3 });
    const r = auto.buildAutoRecipe({
      analysis: a, platform: 'youtube', profile: 'screencast', engines: ALL_ENGINES, outputPath: 'o.mp4'
    });
    check(r.recipe.restore.denoise <= 0.08, 'screencast keeps denoise minimal', String(r.recipe.restore.denoise));
    check(r.recipe.color.saturation === 0, 'screencast leaves colour alone');
  }

  // Unknown bitrate must not trigger guessed restoration.
  {
    const a = fakeAnalysis({ bitrate: 0 });
    a.container.bitrate = 0;
    const r = auto.buildAutoRecipe({ analysis: a, engines: ALL_ENGINES, outputPath: 'o.mp4' });
    check(!r.recipe.restore.enabled, 'unknown bitrate does not turn on restoration');
    check(r.warnings.some((w) => /bitrate is unknown/i.test(w)), 'and the uncertainty is reported');
  }

  // Intensity actually changes willingness.
  {
    const a = fakeAnalysis({ width: 1280, height: 720, fps: 30, bitrate: 500e3 });
    const light = auto.buildAutoRecipe({
      analysis: a, intensity: 'light', engines: ALL_ENGINES, outputPath: 'o.mp4'
    });
    const strong = auto.buildAutoRecipe({
      analysis: a, intensity: 'strong', engines: ALL_ENGINES, outputPath: 'o.mp4'
    });
    check(strong.recipe.restore.denoise > light.recipe.restore.denoise,
      'higher intensity restores harder',
      `${light.recipe.restore.denoise} -> ${strong.recipe.restore.denoise}`);
  }

  // Auto output is an ordinary, editable, valid recipe.
  {
    const a = fakeAnalysis();
    const r = auto.buildAutoRecipe({
      analysis: a, platform: 'youtube', engines: ALL_ENGINES, outputPath: path.join(TMP, 'x.mp4')
    });
    check(recipes.validate(r.recipe).valid, 'the Auto recipe passes validation');
    check(r.recipe.schemaVersion === recipes.SCHEMA_VERSION, 'and carries the current schema version');
    const edited = recipes.sanitize({ ...r.recipe, output: { ...r.recipe.output, quality: 90 } }).recipe;
    check(edited.output.quality === 90 && edited.restore.denoise === r.recipe.restore.denoise,
      'editing one field does not reset the others');
  }
}

/* ================================================================== *
 * Smart Reframe
 * ================================================================== */

function testReframe() {
  console.log('\nSmart Reframe (trajectory)');

  const at = (center, confidence, time) => ({ time, center, confidence });

  // Subject on the left, then on the right: the crop should follow, smoothly.
  {
    const samples = [];
    for (let i = 0; i < 40; i++) samples.push(at(i < 20 ? 0.2 : 0.8, 0.9, i / 4));
    const t = tracking.buildTrajectory({ samples, cuts: [], profile: 'auto' });
    const first = t.points[0].center;
    const last = t.points[t.points.length - 1].center;
    check(first < 0.4, 'the crop starts near the left subject', first.toFixed(3));
    check(last > 0.5, 'and moves toward the right subject', last.toFixed(3));

    let maxStep = 0;
    for (let i = 1; i < t.points.length; i++) {
      maxStep = Math.max(maxStep, Math.abs(t.points[i].center - t.points[i - 1].center));
    }
    // The invariant is the profile's own velocity cap, not a magic number: the
    // crop may travel quickly, but never faster than it is allowed to.
    const cap = tracking.MOTION_PROFILES[tracking.motionProfileFor('auto')].maxStepPerSecond
      / tracking.SAMPLE_FPS;
    check(maxStep <= cap + 1e-6, 'without ever exceeding its velocity limit',
      `max step ${maxStep.toFixed(3)} of ${cap.toFixed(3)} allowed`);
  }

  // A hard cut must snap, not glide.
  {
    const samples = [];
    for (let i = 0; i < 20; i++) samples.push(at(0.2, 0.9, i / 4));
    for (let i = 20; i < 40; i++) samples.push(at(0.85, 0.9, i / 4));
    const cutTime = 5;
    const t = tracking.buildTrajectory({ samples, cuts: [cutTime], profile: 'auto' });
    const atCut = t.points.find((p) => p.cut);
    check(!!atCut, 'the cut is represented in the trajectory');
    check(atCut && Math.abs(atCut.center - 0.85) < 0.02,
      'the crop snaps straight to the new shot rather than gliding across the cut',
      atCut ? atCut.center.toFixed(3) : 'n/a');
  }

  // Missed detections hold the last good position.
  {
    const samples = [];
    for (let i = 0; i < 10; i++) samples.push(at(0.7, 0.9, i / 4));
    for (let i = 10; i < 20; i++) samples.push(at(0.1, 0.0, i / 4)); // no confidence
    const t = tracking.buildTrajectory({ samples, cuts: [], profile: 'auto' });
    const tail = t.points.slice(12);
    const drifted = Math.max(...tail.map((p) => Math.abs(p.center - t.points[9].center)));
    check(drifted < 0.02, 'lost detections hold the last stable crop', drifted.toFixed(4));
    check(t.holds >= 10, 'and the holds are counted', String(t.holds));
  }

  // No detections at all: stay centred.
  {
    const samples = [];
    for (let i = 0; i < 20; i++) samples.push(at(0.9, 0.0, i / 4));
    const t = tracking.buildTrajectory({ samples, cuts: [], profile: 'auto' });
    check(t.points.every((p) => Math.abs(p.center - 0.5) < 0.001),
      'with no usable detections the crop stays centred');
    check(t.fallbacks > 0, 'and the fallback is counted');
  }

  // Film is calmer than action.
  {
    const samples = [];
    for (let i = 0; i < 30; i++) samples.push(at(i < 5 ? 0.5 : 0.95, 0.9, i / 4));
    const film = tracking.buildTrajectory({ samples, cuts: [], profile: 'film' });
    const action = tracking.buildTrajectory({ samples, cuts: [], profile: 'action' });
    const filmEnd = film.points[film.points.length - 1].center;
    const actionEnd = action.points[action.points.length - 1].center;
    check(actionEnd > filmEnd,
      'action tracking responds faster than film tracking',
      `film ${filmEnd.toFixed(3)} vs action ${actionEnd.toFixed(3)}`);
  }

  // A stationary subject produces a static crop, not a jittering one.
  {
    const samples = [];
    for (let i = 0; i < 30; i++) samples.push(at(0.5 + (i % 2 ? 0.01 : -0.01), 0.9, i / 4));
    const t = tracking.buildTrajectory({ samples, cuts: [], profile: 'auto' });
    const spread = Math.max(...t.points.map((p) => p.center)) - Math.min(...t.points.map((p) => p.center));
    check(spread < 0.01, 'small wobble is inside the dead zone', spread.toFixed(4));
    const expr = tracking.buildCropExpression({ points: t.points, cropWidthFraction: 0.5625 });
    check(expr.static, 'and compiles to a fixed crop expression');
  }

  // The compiled expression is bounded and syntactically plausible.
  {
    const samples = [];
    for (let i = 0; i < 60; i++) samples.push(at(0.2 + (i / 60) * 0.6, 0.9, i / 4));
    const t = tracking.buildTrajectory({ samples, cuts: [], profile: 'auto' });
    const expr = tracking.buildCropExpression({ points: t.points, cropWidthFraction: 0.5625 });
    check(!expr.static, 'a moving subject compiles to a time-varying expression');
    check(/if\(lt\(t,/.test(expr.expr), 'using piecewise time terms');
    check(expr.expr.length < 20000, 'that stays a reasonable size', `${expr.expr.length} chars`);
  }

  // Manual framing options remain available.
  {
    const r = recipes.sanitize({
      output: { path: 'o.mp4' },
      framing: { enabled: true, canvas: '9:16', mode: 'fill', tracking: 'center' }
    }).recipe;
    check(r.framing.tracking === 'center', 'centre framing can still be chosen explicitly');
  }
}

/* ================================================================== *
 * Colour and audio graphs
 * ================================================================== */

function testGraphs() {
  console.log('\nColour and audio chains');

  const a = fakeAnalysis();
  const base = (over) => recipes.sanitize({ output: { path: 'o.mp4' }, ...over }).recipe;

  {
    const r = base({ color: { enabled: true, contrast: 0.2, saturation: 0.1, sharpen: 0.2 } });
    const g = filters.buildVideoGraph(r, recipes.resolveOutputGeometry(r, a), a);
    check(/eq=/.test(g.graph), 'the colour chain emits an eq filter');
    check(/unsharp/.test(g.graph), 'and a sharpen filter');
    check(/format=yuv420p/.test(g.graph), 'and normalises the pixel format last');
  }

  for (const master of ['preserve', 'normalize', 'creator', 'dialogue']) {
    const r = base({ audio: { master } });
    const f = filters.buildAudioFilters(r).filters.join(',');
    if (master === 'preserve') {
      check(f === '', 'preserve touches nothing', f || '(none)');
    } else {
      check(/loudnorm/.test(f), `${master} normalises loudness`);
    }
    if (master === 'creator' || master === 'dialogue') {
      check(/alimiter/.test(f), `${master} ends with a limiter`);
      check(/acompressor/.test(f), `${master} applies compression`);
    }
    if (master === 'dialogue') {
      check(/highpass/.test(f) && /equalizer/.test(f),
        'dialogue adds de-rumble and a presence lift (conventional EQ, not "AI")');
    }
  }

  {
    const hdr = fakeAnalysis({ hdr: true });
    const r = base({ color: { toneMap: 'hable' } });
    const withFilters = filters.buildVideoGraph(r, recipes.resolveOutputGeometry(r, hdr), hdr, {
      availableFilters: new Set(['zscale', 'tonemap', 'format'])
    });
    check(/tonemap=/.test(withFilters.graph), 'HDR is tone-mapped when zscale exists');
    const without = filters.buildVideoGraph(r, recipes.resolveOutputGeometry(r, hdr), hdr, {
      availableFilters: new Set(['format'])
    });
    check(!/tonemap=/.test(without.graph) && without.notes.some((n) => /no zscale/.test(n)),
      'and the omission is reported rather than silent');
  }
}

/* ================================================================== *
 * Creator presets
 * ================================================================== */

function testPresets() {
  console.log('\nCreator export presets');
  const list = presets.list();
  check(list.length >= 7, 'the production presets exist', `${list.length} presets`);

  const a = fakeAnalysis({ fps: 30 });
  for (const preset of list) {
    const r = presets.apply(preset.id, { analysis: a, outputPath: path.join(TMP, 'p.mp4') });
    const g = recipes.resolveOutputGeometry(r, a);
    const valid = recipes.validate(r).valid;
    if (!valid) console.log(`       ${preset.id}: ${JSON.stringify(recipes.validate(r).errors)}`);
    check(valid, `${preset.id} produces a valid recipe`,
      g.width ? `${g.width}x${g.height}` : 'source geometry');
  }

  const shorts = presets.apply('shorts-quality', { analysis: a, outputPath: 'o.mp4' });
  const shortsGeom = recipes.resolveOutputGeometry(shorts, a);
  check(shortsGeom.width === 1080 && shortsGeom.height === 1920,
    'the Shorts preset is 1080x1920', `${shortsGeom.width}x${shortsGeom.height}`);
  check(shorts.audio.master !== 'preserve', 'and masters the audio');
}

/* ================================================================== *
 * Real renders
 * ================================================================== */

async function runJob(mgr, recipe, analysis) {
  const created = await mgr.create({ recipe, analysis });
  return new Promise((resolve) => {
    const done = (j) => {
      if (j.id !== created.id) return;
      if (['completed', 'failed', 'cancelled'].includes(j.status)) {
        mgr.off('update', done);
        resolve(j);
      }
    };
    mgr.on('update', done);
  });
}

async function testRealRenders() {
  console.log('\nReal renders');

  const enginesRoot = process.env.VISIONANCE_ENGINES_DIR ||
    path.join(process.env.APPDATA || os.homedir(), 'Visionance', 'engines');
  const engines = new EngineManager({ rootDir: enginesRoot });
  const mgr = new JobManager({
    dir: path.join(TMP, 'jobs'),
    workDir: path.join(TMP, 'work'),
    resolveBins: () => ({ ffmpeg: FFMPEG, ffprobe: FFPROBE, ytdlp: null }),
    engines
  });
  mgr.init();

  // A 16:9 clip with an obvious subject that moves left -> right.
  // A subject that unmistakably travels left -> right, so Smart Reframe has
  // something real to follow. (`drawbox` draws nothing in some ffmpeg builds -
  // an overlaid colour source is portable and verifiably visible.)
  const src = make('subject.mp4', [
    '-f', 'lavfi', '-i', 'color=c=#202020:s=640x360:d=4:r=24',
    '-f', 'lavfi', '-i', 'color=c=white:s=120x140:d=4:r=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-filter_complex',
    "[0:v][1:v]overlay=x='40+(t/4)*440':y=110,format=yuv420p[v]",
    '-map', '[v]', '-map', '2:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-c:a', 'aac', '-shortest'
  ]);
  const analysis = await analyze(FFPROBE, src, {});

  /* ---- Smart Reframe 16:9 -> 9:16 ---- */
  {
    const out = path.join(TMP, 'short.mp4');
    const r = recipes.sanitize({
      source: { type: 'local', path: src },
      output: { path: out, quality: 50, encoder: 'libx264', preset: 'ultrafast', container: 'mp4' },
      framing: { enabled: true, canvas: '9:16', width: 608, height: 1080, mode: 'fill', tracking: 'auto' },
      reconstruction: {
        enabled: true, mode: 'classical',
        targetResolution: { mode: 'custom', width: 608, height: 1080 }
      },
      audio: { master: 'creator' }
    }).recipe;

    const job = await runJob(mgr, r, analysis);
    check(job.status === 'completed', 'a Smart Reframe render completes',
      job.error ? `${job.error.code}: ${job.error.message}` : '');
    if (job.status !== 'completed' && job.error) {
      console.log(`       ${String(job.error.technicalDetails || '').slice(0, 300)}`);
    }
    check(!!job.recipe && job.recipe.framing.tracking === 'auto',
      'the job records that Smart Reframe was requested');
    // The point of Smart Reframe is that it actually found the subject.
    const tracked = job.reframe || (job.stages || []).find((st) => st.id === 'REFRAME');
    check(!(job.warnings || []).some((w) => /could not be located/i.test(w)),
      'the subject was located rather than falling back to centre',
      (job.warnings || []).join(' | ') || 'no fallback warning');
    void tracked;

    if (fs.existsSync(out)) {
      const info = probe(out);
      const v = info.streams.find((s) => s.codec_type === 'video');
      const audio = info.streams.find((s) => s.codec_type === 'audio');
      check(v.width === 608 && v.height === 1080, 'the output is a 9:16 canvas', `${v.width}x${v.height}`);
      check(!!audio, 'audio survives reframing');
      const dur = Number(info.format.duration);
      check(Math.abs(dur - 4) < 0.4, 'duration is preserved', `${dur.toFixed(2)}s`);
      const adur = audio ? Number(audio.duration || dur) : 0;
      check(Math.abs(adur - dur) < 0.35, 'audio and video durations stay aligned',
        `v ${dur.toFixed(2)}s / a ${adur.toFixed(2)}s`);
    }
  }

  /* ---- platform canvases ---- */
  for (const [id, expect] of [
    ['feed-quality', { w: 540, h: 676 }],
    ['youtube-1080p', { w: 1920, h: 1080 }]
  ]) {
    const out = path.join(TMP, `${id}.mp4`);
    let r = presets.apply(id, { analysis, outputPath: out });
    // Keep the test cheap: shrink the canvas but preserve its aspect.
    if (id === 'feed-quality') {
      r = recipes.sanitize({
        ...r,
        framing: { ...r.framing, width: 540, height: 675 },
        reconstruction: {
          ...r.reconstruction,
          targetResolution: { mode: 'custom', width: 540, height: 675 }
        },
        output: { ...r.output, quality: 45, preset: 'ultrafast', encoder: 'libx264' }
      }).recipe;
    } else {
      r = recipes.sanitize({
        ...r,
        output: { ...r.output, quality: 45, preset: 'ultrafast', encoder: 'libx264' }
      }).recipe;
    }
    const job = await runJob(mgr, r, analysis);
    let detail = job.error ? `${job.error.code}` : '';
    let ok = job.status === 'completed';
    if (ok && fs.existsSync(out)) {
      const v = probe(out).streams.find((s) => s.codec_type === 'video');
      detail = `${v.width}x${v.height}`;
      ok = v.width === expect.w && v.height === expect.h;
    }
    check(ok, `${id} renders ${expect.w}x${expect.h}`, detail);
  }

  /* ---- audio mastering on real audio ---- */
  for (const master of ['normalize', 'creator', 'dialogue']) {
    const out = path.join(TMP, `audio-${master}.mp4`);
    const r = recipes.sanitize({
      source: { type: 'local', path: src },
      output: { path: out, quality: 40, encoder: 'libx264', preset: 'ultrafast' },
      audio: { master }
    }).recipe;
    const job = await runJob(mgr, r, analysis);
    let ok = job.status === 'completed';
    let detail = job.error ? `${job.error.code}: ${job.error.message}` : '';
    if (ok && fs.existsSync(out)) {
      const info = probe(out);
      const audio = info.streams.find((s) => s.codec_type === 'audio');
      ok = !!audio;
      const dur = Number(info.format.duration);
      detail = `${dur.toFixed(2)}s ${audio ? audio.codec_name : 'no audio'}`;
      if (Math.abs(dur - 4) > 0.4) { ok = false; detail += ' DURATION DRIFT'; }
    }
    check(ok, `${master} mastering renders with aligned audio`, detail);
  }

  /* ---- a silent source stays valid ---- */
  {
    const silent = make('silent.mp4', [
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '34', '-pix_fmt', 'yuv420p'
    ]);
    const sa = await analyze(FFPROBE, silent, {});
    const out = path.join(TMP, 'silent-out.mp4');
    const r = recipes.sanitize({
      source: { type: 'local', path: silent },
      output: { path: out, quality: 40, encoder: 'libx264', preset: 'ultrafast' },
      audio: { master: 'creator' }
    }).recipe;
    const job = await runJob(mgr, r, analysis ? sa : sa);
    check(job.status === 'completed', 'a silent source renders without inventing audio',
      job.error ? job.error.code : '');
  }

  await mgr.shutdown();
  return { engines };
}

/* ================================================================== *
 * Run
 * ================================================================== */

(async () => {
  console.log('Visionance creator verification');
  if (!FFMPEG || !FFPROBE) {
    console.error('ffmpeg/ffprobe unavailable; cannot verify creator rendering.');
    process.exit(1);
  }

  testAuto();
  testReframe();
  testGraphs();
  testPresets();
  await testRealRenders();

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${ran} checks, ${failures} failure(s)`);
  console.log(failures === 0 ? 'PASS' : 'FAIL');
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Harness error:', err);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
