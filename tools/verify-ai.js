/**
 * Neural pipeline verification.
 *
 * Two halves, deliberately not conflated:
 *
 *   CORE   pure logic and process handling, using fakes. Always runs.
 *   REAL   actual Real-ESRGAN and RIFE inference on tiny clips. Only runs when
 *          the engines are installed, and says loudly when it is skipped.
 *
 * A green CORE run does NOT mean the neural engines work. The summary prints
 * which half ran.
 *
 *   node tools/verify-ai.js            both halves where possible
 *   node tools/verify-ai.js --core     skip the real inference
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const interpolation = require(path.join(ROOT, 'src', 'main', 'ai', 'interpolation-plan'));
const scenes = require(path.join(ROOT, 'src', 'main', 'ai', 'scenes'));
const aiProcess = require(path.join(ROOT, 'src', 'main', 'ai', 'process'));
const realesrgan = require(path.join(ROOT, 'src', 'main', 'ai', 'engines', 'realesrgan'));
const rife = require(path.join(ROOT, 'src', 'main', 'ai', 'engines', 'rife'));
const { EngineManager, STATUS } = require(path.join(ROOT, 'src', 'main', 'ai', 'engine-manager'));
const neuralStage = require(path.join(ROOT, 'src', 'main', 'jobs', 'stages', 'neural'));
const pipeline = require(path.join(ROOT, 'src', 'main', 'jobs', 'pipeline'));
const recipes = require(path.join(ROOT, 'src', 'main', 'recipe'));
const { JobManager } = require(path.join(ROOT, 'src', 'main', 'jobs', 'job-manager'));
const { analyze } = require(path.join(ROOT, 'src', 'main', 'media-analyzer'));
const { logger } = require(path.join(ROOT, 'src', 'main', 'logger'));

logger.level = process.env.VISIONANCE_LOG || 'error';

const CORE_ONLY = process.argv.includes('--core');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'visionance-ai-'));

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
  } catch {
    return null;
  }
}
const FFMPEG = staticBinary('ffmpeg-static');
const FFPROBE = staticBinary('ffprobe-static');

function enginesRoot() {
  if (process.env.VISIONANCE_ENGINES_DIR) return process.env.VISIONANCE_ENGINES_DIR;
  const appData = process.env.APPDATA ||
    path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Application Support' : '.config');
  return path.join(appData, 'Visionance', 'engines');
}

/* ================================================================== *
 * CORE: interpolation timing
 * ================================================================== */

function coreInterpolation() {
  console.log('\nInterpolation planning (timing)');

  // The conversions that actually occur in the wild, including the awkward ones.
  const conversions = [
    { src: 23.976, dst: 60, seconds: 5 },
    { src: 24, dst: 60, seconds: 5 },
    { src: 25, dst: 50, seconds: 4 },
    { src: 25, dst: 60, seconds: 4 },
    { src: 29.97, dst: 60, seconds: 3 },
    { src: 30, dst: 60, seconds: 3 },
    { src: 30, dst: 120, seconds: 2 },
    { src: 50, dst: 60, seconds: 2 },
    { src: 59.94, dst: 60, seconds: 2 }
  ];
  let allExact = true;
  for (const c of conversions) {
    const frameCount = Math.round(c.seconds * c.src);
    const plan = interpolation.planInterpolation({
      frameCount, fpsSrc: c.src, fpsDst: c.dst, cutFrames: []
    });
    const outSeconds = plan.outputCount / c.dst;
    const srcSeconds = frameCount / c.src;
    const drift = Math.abs(outSeconds - srcSeconds);
    const summed = plan.shots.reduce((s, x) => s + x.outputCount, 0);
    // Half an output frame is the most rounding can cost.
    const ok = drift <= (0.5 / c.dst) + 1e-9 && summed === plan.outputCount;
    if (!ok) allExact = false;
    if (!ok) console.log(`       ${c.src}->${c.dst}: drift ${drift}s summed ${summed}/${plan.outputCount}`);
  }
  check(allExact, 'every source rate converts with no duration drift',
    `${conversions.length} conversions incl. 23.976, 29.97, 59.94`);

  // Cuts
  const withCut = interpolation.planInterpolation({
    frameCount: 48, fpsSrc: 24, fpsDst: 48, cutFrames: [24]
  });
  check(withCut.shots.length === 2, 'a cut splits the chunk into two shots',
    `${withCut.shots.length} shots`);
  check(withCut.shots[0].endFrame === 23 && withCut.shots[1].startFrame === 24,
    'no shot spans the cut',
    `shot0 0..${withCut.shots[0].endFrame}, shot1 ${withCut.shots[1].startFrame}..`);
  check(withCut.shots[0].outputCount === 48 && withCut.shots[1].outputCount === 48,
    'output frames are split at the cut in proportion to time',
    `${withCut.shots[0].outputCount}/${withCut.shots[1].outputCount}`);
  check(withCut.shots.every((s) => s.anchor !== 'next'),
    'a shot ending at a cut never borrows the next shot\'s frame');
  check(withCut.shots.reduce((s, x) => s + x.outputCount, 0) === withCut.outputCount,
    'cut handling does not change the total frame count');

  // The double-conversion bug: indices must not be re-read as timestamps.
  const indices = interpolation.planInterpolation({
    frameCount: 48, fpsSrc: 24, fpsDst: 48, cutFrames: [24]
  });
  check(indices.shots.length === 2,
    'cut frames are treated as indices, not seconds',
    'regression: 24 must not become frame 576');

  // Chunk boundaries.
  const mid = interpolation.planInterpolation({
    frameCount: 24, fpsSrc: 24, fpsDst: 48, cutFrames: [], hasNextFrame: true
  });
  check(mid.shots[0].anchor === 'next',
    'a chunk that continues mid-shot uses the real next frame as its anchor');
  const end = interpolation.planInterpolation({
    frameCount: 24, fpsSrc: 24, fpsDst: 48, cutFrames: [], hasNextFrame: false
  });
  check(end.shots[0].anchor === 'duplicate',
    'the final chunk falls back to duplicating its own last frame');
  check(mid.shots[0].requestFrames === mid.shots[0].outputCount + 1 && mid.shots[0].dropTrailing === 1,
    'one extra frame is requested and dropped so samples cover the full interval',
    `req=${mid.shots[0].requestFrames} out=${mid.shots[0].outputCount}`);

  // Contiguity across chunks: two halves must tile exactly, no gap, no overlap.
  const a = interpolation.planInterpolation({ frameCount: 24, fpsSrc: 24, fpsDst: 60, hasNextFrame: true });
  const b = interpolation.planInterpolation({ frameCount: 24, fpsSrc: 24, fpsDst: 60, hasNextFrame: false });
  const whole = interpolation.planInterpolation({ frameCount: 48, fpsSrc: 24, fpsDst: 60 });
  check(a.outputCount + b.outputCount === whole.outputCount,
    'chunking a clip does not change how many frames come out',
    `${a.outputCount}+${b.outputCount} vs ${whole.outputCount}`);

  // Degenerate shots.
  const single = interpolation.planInterpolation({
    frameCount: 3, fpsSrc: 24, fpsDst: 48, cutFrames: [1, 2]
  });
  check(single.shots.every((s) => s.mode !== 'rife' || s.inputFrames >= 2),
    'a one-frame shot is held, never sent to a network that needs a pair');
  check(single.warnings.some((w) => /held/.test(w)),
    'holding a single-frame shot is reported, not hidden');

  const none = interpolation.planInterpolation({ frameCount: 0, fpsSrc: 24, fpsDst: 48 });
  check(none.outputCount === 0 && none.shots.length === 0, 'an empty chunk plans nothing');

  // A model that cannot do arbitrary time steps must say so.
  const oldModel = interpolation.planInterpolation({
    frameCount: 24, fpsSrc: 24, fpsDst: 60, arbitraryTimestep: false
  });
  check(oldModel.warnings.some((w) => /doubles frame rates/.test(w)),
    'a power-of-two-only model warns on a 2.5x conversion');
}

/* ================================================================== *
 * CORE: engines, planning, process handling
 * ================================================================== */

function coreEngines() {
  console.log('\nEngine planning');

  const models = [
    { id: 'general', name: 'realesrgan-x4plus', nativeScales: [4], availableScales: [4] },
    { id: 'animation', name: 'realesr-animevideov3', nativeScales: [2, 3, 4], availableScales: [2, 3, 4] }
  ];

  const native2x = realesrgan.planInference({ mode: 'upscale', scale: 2, modelId: 'animation', available: models });
  check(native2x.inferenceScale === 2 && !native2x.downscaleAfter,
    'a native 2x model runs at 2x with no downscale', native2x.reason);

  /* ---- inference quality: four names, four implementations ----
   *
   * The 4x-only General model has no native 2x weights, so what happens when
   * 2x is asked for is entirely a quality decision. Measured on the reference
   * GPU at 720p: full-frame x4 is 12.66 s/frame, half-frame x4 is 3.61.
   */
  const at = (quality) => realesrgan.planInference({
    mode: 'upscale', scale: 2, modelId: 'general', available: models, quality
  });

  const fast = at('fast');
  check(fast.neural === false,
    'Fast declines a 4x network for a 2x result and says so', fast.reason);
  check(typeof fast.tradeoff === 'string' && /classical|resampled/i.test(fast.tradeoff),
    'Fast labels its own quality cost honestly', fast.tradeoff);

  const balanced = at('balanced');
  check(balanced.neural && balanced.inferenceScale === 4 && balanced.preScale === 0.5 &&
    !balanced.downscaleAfter && balanced.effectiveScale === 2,
  'Balanced runs the 4x network on a half-size frame for an exact 2x', balanced.reason);

  const quality = at('quality');
  check(quality.neural && quality.inferenceScale === 4 && quality.preScale === 1 &&
    quality.downscaleAfter,
  'Quality runs the 4x network on every source pixel then resamples down', quality.reason);

  const maximum = at('maximum');
  check(maximum.neural && maximum.inferenceScale === 4 && maximum.preScale === 1 &&
    maximum.downscaleAfter,
  'Maximum keeps the full-pixel 4x path', maximum.reason);

  // The four are genuinely different, not four names for one thing.
  const signature = (p) => `${p.neural}|${p.inferenceScale}|${p.preScale}|${p.downscaleAfter}`;
  check(new Set([fast, balanced, quality].map(signature)).size === 3,
    'Fast, Balanced and Quality are three different implementations');

  // Where the model really has native weights, every mode uses them...
  const nativeFast = realesrgan.planInference({
    mode: 'upscale', scale: 2, modelId: 'animation', available: models, quality: 'fast'
  });
  check(nativeFast.neural && nativeFast.inferenceScale === 2 && nativeFast.preScale === 1,
    'a native 2x model is used natively even in Fast', nativeFast.reason);

  // ...except Maximum, which is allowed to spend more on purpose.
  const nativeMax = realesrgan.planInference({
    mode: 'upscale', scale: 2, modelId: 'animation', available: models, quality: 'maximum'
  });
  check(nativeMax.inferenceScale === 4 && nativeMax.downscaleAfter,
    'Maximum reconstructs at the largest native scale even when 2x weights exist', nativeMax.reason);

  // Every path must land on the scale that was actually requested.
  for (const p of [balanced, quality, maximum, nativeFast, nativeMax]) {
    check(p.effectiveScale === 2, `every neural path reaches the requested 2x (${p.reason})`);
  }

  const restore = realesrgan.planInference({ mode: 'restore', scale: 1, modelId: 'animation', available: models });
  check(restore.inferenceScale === 2 && restore.downscaleAfter,
    'restore is a real inference at native scale then a downscale, not a "1x model"', restore.reason);

  check(realesrgan.planInference({ mode: 'upscale', scale: 2, available: [] }) === null,
    'no installed models means no plan, rather than a pretend one');

  const rifeModels = [
    { id: 'rife-v3.1', label: 'v3.1', arbitraryTimestep: false, path: '/x' },
    { id: 'rife-v4.6', label: 'v4.6', arbitraryTimestep: true, path: '/y' }
  ];
  check(rife.pickModel(rifeModels, 'auto').id === 'rife-v4.6',
    'RIFE prefers a model that supports arbitrary time steps');
  check(rife.pickModel(rifeModels, 'rife-v3.1').id === 'rife-v3.1',
    'an explicitly requested RIFE model is honoured');
  check(rife.shouldUseUhd(3840, 2160) && !rife.shouldUseUhd(1280, 720),
    'UHD mode turns on for 4K frames and stays off for 720p');

  console.log('\nGPU selection');
  const ncnnOutput = [
    '[0 Intel(R) UHD Graphics]  queueC=0[1]  queueG=0[1]  queueT=0[1]',
    '[0 Intel(R) UHD Graphics]  bugsbn1=0',
    '[1 NVIDIA GeForce RTX 4060 Ti]  queueC=2[8]  queueG=0[16]',
    '[1 NVIDIA GeForce RTX 4060 Ti]  fp16-p/s/a=1/1/1'
  ].join('\n');
  const gpus = aiProcess.parseGpuList(ncnnOutput);
  check(gpus.length === 2 && gpus[1].name.includes('4060'),
    'ncnn device lines parse into a GPU list', JSON.stringify(gpus.map((g) => g.index)));
  check(aiProcess.preferredGpu(gpus) === 1,
    'auto picks the discrete GPU over the integrated one');
  check(aiProcess.preferredGpu([{ index: 0, name: 'Intel(R) UHD Graphics' }]) === 0,
    'a single GPU is used whatever it is');
  check(aiProcess.preferredGpu([]) === null, 'no GPUs means no choice to make');

  console.log('\nProcess result interpretation');
  const oom = aiProcess.interpretResult(
    { code: 1, produced: 3, stderrTail: 'vkAllocateMemory failed' }, { expected: 10 });
  check(oom.reason === 'oom', 'a Vulkan allocation failure is recognised as out-of-memory');
  const novk = aiProcess.interpretResult(
    { code: 1, produced: 0, stderrTail: 'vkCreateInstance failed' }, { expected: 10 });
  check(novk.reason === 'no-vulkan', 'a missing Vulkan instance is not mistaken for OOM');
  const partial = aiProcess.interpretResult(
    { code: 1, produced: 5, stderrTail: 'something odd' }, { expected: 10 });
  check(partial.reason === 'oom',
    'a crash part-way through a frame set is treated as memory pressure and retried smaller');
  const cancelled = aiProcess.interpretResult(
    { code: null, killed: true, produced: 2, stderrTail: '' }, { expected: 10 });
  check(cancelled.reason === 'cancelled', 'a killed process is cancellation, not failure');
  const incomplete = aiProcess.interpretResult(
    { code: 0, produced: 8, stderrTail: '' }, { expected: 10 });
  check(!incomplete.ok && incomplete.reason === 'incomplete',
    'exit code 0 with missing frames is still a failure');
  const good = aiProcess.interpretResult({ code: 0, produced: 10, stderrTail: '' }, { expected: 10 });
  check(good.ok, 'a complete run is a success');

  console.log('\nScene detection parsing');
  const meta = [
    'frame:0    pts:0       pts_time:0',
    'lavfi.scene_score=0.000000',
    'frame:24   pts:24576   pts_time:1.024',
    'lavfi.scene_score=0.912345'
  ].join('\n');
  const parsed = scenes.parseSceneOutput(meta);
  check(parsed.length === 2 && Math.abs(parsed[1].time - 1.024) < 1e-6,
    'ffmpeg scene metadata parses into timestamps', JSON.stringify(parsed.map((p) => p.time)));
  check(parsed[1].score > 0.9, 'the scene score is captured alongside the timestamp');
  check(interpolation.cutsToFrameIndices([1.024], 24, 48)[0] === 25,
    'a cut timestamp converts to a frame index once');
}

/* ================================================================== *
 * CORE: engine manager against a fabricated install
 * ================================================================== */

async function coreEngineManager() {
  console.log('\nEngine manager');

  const root = path.join(TMP, 'engines');
  const mgr = new EngineManager({ rootDir: root });

  const missing = await mgr.status('realesrgan', { force: true });
  check(missing.status === STATUS.NOT_INSTALLED && !missing.installed,
    'an engine that was never installed reports not-installed');
  check(Array.isArray(missing.models) && missing.models.length === 0,
    'a missing engine advertises no models');

  // An executable with no weights beside it is broken, not ready.
  const dir = path.join(root, 'realesrgan');
  fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
  const exeName = realesrgan.releaseFor().executable;
  fs.writeFileSync(path.join(dir, exeName), 'not a real binary');
  const noModels = await mgr.status('realesrgan', { force: true });
  check(noModels.status === STATUS.BROKEN && noModels.error.code === 'MODEL_MISSING',
    'an engine with no model weights is broken, never ready', noModels.status);

  let requireError = null;
  try {
    await mgr.require('realesrgan');
  } catch (err) {
    requireError = err;
  }
  check(requireError && requireError.code === 'ENGINE_BROKEN',
    'asking for a broken engine throws a structured, actionable error',
    requireError && requireError.code);

  let missingError = null;
  try {
    await mgr.require('rife');
  } catch (err) {
    missingError = err;
  }
  check(missingError && missingError.code === 'ENGINE_MISSING' && /Install/.test(missingError.suggestedAction || ''),
    'a missing engine tells the user how to install it');

  check(!!realesrgan.LICENSE.license && !!rife.LICENSE.license,
    'both engines carry their upstream licence information',
    `${realesrgan.LICENSE.license}, ${rife.LICENSE.license}`);
}

/* ================================================================== *
 * CORE: recipe and pipeline integration
 * ================================================================== */

function corePipeline() {
  console.log('\nRecipe and pipeline');

  const analysis = {
    video: { width: 1920, height: 1080, nominalFps: 24, codec: 'h264' },
    audio: { codec: 'aac' },
    derived: {
      displayWidth: 1920, displayHeight: 1080, nominalFps: 24, durationSeconds: 600,
      orientation: 'landscape', isHDR: false, isInterlaced: false, hasAudio: true,
      frameRateMode: 'constant'
    },
    container: { duration: 600 }
  };

  const neuralRecipe = recipes.sanitize({
    source: { type: 'local', path: 'x.mp4' },
    output: { path: 'y.mp4', fps: 60 },
    reconstruction: { enabled: true, mode: 'neural', aiMode: 'upscale', aiScale: 2 },
    motion: { enabled: true, interpolation: 'ai', targetFps: 60 }
  }).recipe;

  check(recipes.validate(neuralRecipe).valid,
    'a neural recipe is now valid (session 1 rejected it outright)');

  const geometry = recipes.resolveOutputGeometry(neuralRecipe, analysis);
  check(geometry.width === 3840 && geometry.height === 2160,
    'AI Upscale 2x on 1080p resolves to 3840x2160', `${geometry.width}x${geometry.height}`);
  check(geometry.fps === 60 && geometry.fpsChanged, 'the target frame rate is carried into the geometry');

  const stages = pipeline.planStages(neuralRecipe, analysis, geometry, { chunked: true, neural: true });
  const byId = Object.fromEntries(stages.stages.map((s) => [s.id, s]));
  check(byId.UPSCALE.mode === 'pass', 'neural upscaling is a discrete pass, not a filter');
  check(byId.INTERPOLATE.mode === 'pass', 'AI interpolation is a discrete pass');
  check(stages.requiresChunking, 'a neural plan forces chunked processing');
  check(byId.MUX.mode === 'pass', 'a neural job always muxes, so the audio can be re-attached');
  check(byId.UPSCALE.weight > byId.VERIFY.weight,
    'the expensive network dominates the progress weighting');

  // Restore keeps the resolution but still runs the network.
  const restore = recipes.sanitize({
    source: { type: 'local', path: 'x.mp4' },
    output: { path: 'y.mp4' },
    reconstruction: { enabled: true, mode: 'neural', aiMode: 'restore' }
  }).recipe;
  check(restore.reconstruction.aiScale === 1, 'restore normalises to scale 1');
  const restoreGeom = recipes.resolveOutputGeometry(restore, analysis);
  check(restoreGeom.width === 1920 && restoreGeom.height === 1080,
    'restore keeps the source resolution', `${restoreGeom.width}x${restoreGeom.height}`);
  const restoreStages = pipeline.planStages(restore, analysis, restoreGeom, { chunked: true, neural: true });
  check(restoreStages.stages.find((s) => s.id === 'UPSCALE').mode === 'pass',
    'restore still runs the network even though the resolution is unchanged');

  // Classical must stay classical.
  const classical = recipes.sanitize({
    source: { type: 'local', path: 'x.mp4' },
    output: { path: 'y.mp4', fps: 60 },
    motion: { enabled: true, interpolation: 'motion', targetFps: 60 }
  }).recipe;
  const classicalStages = pipeline.planStages(
    classical, analysis, recipes.resolveOutputGeometry(classical, analysis), { chunked: false });
  check(classicalStages.stages.find((s) => s.id === 'INTERPOLATE').mode === 'fused',
    'ffmpeg motion interpolation stays a fused filter and is never called AI');
  check(!classicalStages.requiresChunking,
    'a classical recipe does not drag in the neural chunking machinery');

  // v1 recipes still load.
  const v1 = recipes.migrate({
    schemaVersion: 1,
    output: { path: 'a.mp4', quality: 71 },
    motion: { enabled: true, interpolation: 'neural', targetFps: 60 }
  });
  check(v1.recipe.schemaVersion === recipes.SCHEMA_VERSION, 'a v1 recipe migrates to the current schema');
  check(v1.recipe.output.quality === 71, 'migration preserves what the user chose');
  check(v1.recipe.motion.interpolation === 'ai', "v1's 'neural' spelling maps onto 'ai'");

  console.log('\nDisk safety');
  const plan = { chunks: [{ durationSeconds: 20 }], totalDuration: 600 };
  const need = neuralStage.estimateWorkingBytes({
    recipe: neuralRecipe,
    geometry: { sourceWidth: 1920, sourceHeight: 1080, sourceFps: 24, fps: 60 },
    plan,
    aiPlan: { upscale: { inferenceScale: 2 }, interpolate: {} }
  });
  check(need > 1e9, 'a 4K neural render is estimated in gigabytes, so it can be refused early',
    `${(need / 1e9).toFixed(1)} GB`);
  const nothing = neuralStage.estimateWorkingBytes({
    recipe: neuralRecipe, geometry: {}, plan, aiPlan: { upscale: null, interpolate: null }
  });
  check(nothing === 0, 'a classical render needs no neural working space');
}

/* ================================================================== *
 * REAL: actual inference
 * ================================================================== */

function makeSource(name, args) {
  const file = path.join(TMP, name);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args, file]);
  return file;
}

function probe(file) {
  return JSON.parse(execFileSync(FFPROBE,
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]).toString());
}

/** Average RGB per frame, used to prove a cut was not blended. */
function frameColours(file) {
  const raw = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file,
    '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 });
  const out = [];
  for (let i = 0; i < raw.length; i += 3) out.push([raw[i], raw[i + 1], raw[i + 2]]);
  return out;
}

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

async function realTests(engineStatus) {
  console.log('\nREAL neural inference');
  const root = enginesRoot();
  const engines = new EngineManager({ rootDir: root });
  const mgr = new JobManager({
    dir: path.join(TMP, 'realjobs'),
    workDir: path.join(TMP, 'realwork'),
    resolveBins: () => ({ ffmpeg: FFMPEG, ffprobe: FFPROBE, ytdlp: null }),
    engines
  });
  mgr.init();

  const gpuNames = (engineStatus.realesrgan.availableGPUs || []).map((g) => g.name).join(', ');
  console.log(`  engines: realesrgan=${engineStatus.realesrgan.status} rife=${engineStatus.rife.status}`);
  console.log(`  gpus   : ${gpuNames || 'none'}`);

  /* ---- Real-ESRGAN 2x ---- */
  if (engineStatus.realesrgan.status === STATUS.READY) {
    const src = makeSource('up.mp4', [
      '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '34',
      '-c:a', 'aac', '-shortest', '-pix_fmt', 'yuv420p'
    ]);
    const analysis = await analyze(FFPROBE, src, {});
    const out = path.join(TMP, 'up-out.mp4');
    const started = Date.now();
    const job = await runJob(mgr, recipes.defaultRecipe(analysis, {
      output: { path: out, quality: 50, encoder: 'libx264', preset: 'ultrafast' },
      reconstruction: { enabled: true, mode: 'neural', aiMode: 'upscale', aiScale: 2, model: 'animation' }
    }), analysis);

    check(job.status === 'completed', 'Real-ESRGAN 2x render completes and verifies',
      job.error ? `${job.error.code}: ${job.error.message}` : `${((Date.now() - started) / 1000).toFixed(1)}s`);
    check(!!(job.plan && job.plan.neural && job.plan.neural.upscale),
      'the job records that a neural upscale actually ran',
      job.plan && job.plan.neural && job.plan.neural.upscale
        ? `${job.plan.neural.upscale.model} x${job.plan.neural.upscale.inferenceScale}` : 'no record');
    if (fs.existsSync(out)) {
      const info = probe(out);
      const v = info.streams.find((s) => s.codec_type === 'video');
      const a = info.streams.find((s) => s.codec_type === 'audio');
      check(v.width === 320 && v.height === 240, 'output is exactly 2x the source', `${v.width}x${v.height}`);
      check(Math.abs(Number(info.format.duration) - 2) < 0.2, 'duration is preserved',
        `${Number(info.format.duration).toFixed(3)}s`);
      check(!!a, 'audio survives a neural render');
      check(job.aiMetrics && job.aiMetrics.framesProcessed === 20,
        'every source frame was processed',
        job.aiMetrics ? `${job.aiMetrics.framesProcessed} frames` : 'no metrics');
      if (job.aiMetrics && job.aiMetrics.framesPerSecond) {
        console.log(`       observed: ${job.aiMetrics.framesPerSecond} frames/s, tile=${job.aiMetrics.tileSize}`);
      }
    }
  } else {
    console.log('  SKIP Real-ESRGAN tests — engine not ready');
  }

  /* ---- RIFE 24 -> 60 ---- */
  if (engineStatus.rife.status === STATUS.READY) {
    const src = makeSource('rife.mp4', [
      '-f', 'lavfi', '-i', 'testsrc2=size=192x108:rate=24:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '34',
      '-c:a', 'aac', '-shortest', '-pix_fmt', 'yuv420p'
    ]);
    const analysis = await analyze(FFPROBE, src, {});
    const out = path.join(TMP, 'rife-out.mp4');
    const job = await runJob(mgr, recipes.defaultRecipe(analysis, {
      output: { path: out, quality: 50, encoder: 'libx264', preset: 'ultrafast', fps: 60 },
      motion: { enabled: true, interpolation: 'ai', targetFps: 60, sceneCutProtection: true }
    }), analysis);

    check(job.status === 'completed', 'RIFE 24 -> 60 render completes and verifies',
      job.error ? `${job.error.code}: ${job.error.message}` : '');
    check(!!(job.plan && job.plan.neural && job.plan.neural.interpolate),
      'the job records that RIFE actually ran',
      job.plan && job.plan.neural && job.plan.neural.interpolate
        ? job.plan.neural.interpolate.model : 'no record');
    if (fs.existsSync(out)) {
      const info = probe(out);
      const v = info.streams.find((s) => s.codec_type === 'video');
      const [n, d] = String(v.avg_frame_rate).split('/').map(Number);
      const fps = d ? n / d : 0;
      check(Math.abs(fps - 60) < 0.5, 'the output really is 60 fps', `${fps.toFixed(3)} fps`);
      check(Math.abs(Number(info.format.duration) - 2) < 0.2,
        'interpolation does not change the running time',
        `${Number(info.format.duration).toFixed(3)}s`);
      check(Number(v.nb_frames) === 120, 'exactly the right number of frames was produced',
        `${v.nb_frames} frames`);
      check(!!info.streams.find((s) => s.codec_type === 'audio'), 'audio stays with the video');
    }
  } else {
    console.log('  SKIP RIFE tests — engine not ready');
  }

  /* ---- hard cut ---- */
  if (engineStatus.rife.status === STATUS.READY) {
    const src = makeSource('cut.mp4', [
      '-f', 'lavfi', '-i', 'color=c=red:s=192x108:d=1:r=24,format=yuv420p',
      '-f', 'lavfi', '-i', 'color=c=blue:s=192x108:d=1:r=24,format=yuv420p',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p'
    ]);
    const analysis = await analyze(FFPROBE, src, {});
    const out = path.join(TMP, 'cut-out.mp4');
    const job = await runJob(mgr, recipes.defaultRecipe(analysis, {
      output: { path: out, quality: 60, encoder: 'libx264', preset: 'ultrafast', fps: 48 },
      motion: {
        enabled: true, interpolation: 'ai', targetFps: 48,
        sceneCutProtection: true, sceneCutThreshold: 0.3
      },
      audio: { enabled: false, mode: 'none' }
    }), analysis);

    check(job.status === 'completed', 'the scene-cut fixture renders',
      job.error ? `${job.error.code}: ${job.error.message}` : '');
    check(job.aiMetrics && job.aiMetrics.sceneCuts === 1, 'the hard cut is detected',
      job.aiMetrics ? `${job.aiMetrics.sceneCuts} cuts` : 'no metrics');

    if (fs.existsSync(out)) {
      const colours = frameColours(out);
      let red = 0;
      let blue = 0;
      const blended = [];
      colours.forEach(([r, g, b], i) => {
        if (r > 60 && b < 40) red++;
        else if (b > 60 && r < 40) blue++;
        else blended.push(`#${i} rgb(${r},${g},${b})`);
      });
      check(blended.length === 0,
        'no frame blends across the cut — RIFE never saw the red/blue pair',
        blended.length ? blended.slice(0, 3).join(', ') : `${red} red + ${blue} blue`);
      check(colours.length === 96, 'the cut fixture produces the expected frame count',
        `${colours.length} frames`);
      check(Math.abs(red - blue) <= 1, 'the cut lands in the middle, so its timing is preserved',
        `${red}/${blue}`);
    }
  }

  /* ---- combined ---- */
  if (engineStatus.realesrgan.status === STATUS.READY && engineStatus.rife.status === STATUS.READY) {
    const src = makeSource('both.mp4', [
      '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=24:duration=1.5',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '34',
      '-c:a', 'aac', '-shortest', '-pix_fmt', 'yuv420p'
    ]);
    const analysis = await analyze(FFPROBE, src, {});
    const out = path.join(TMP, 'both-out.mp4');
    const job = await runJob(mgr, recipes.defaultRecipe(analysis, {
      output: { path: out, quality: 50, encoder: 'libx264', preset: 'ultrafast', fps: 48 },
      reconstruction: { enabled: true, mode: 'neural', aiMode: 'upscale', aiScale: 2, model: 'animation' },
      motion: { enabled: true, interpolation: 'ai', targetFps: 48, sceneCutProtection: true }
    }), analysis);

    check(job.status === 'completed', 'upscale + interpolation together complete',
      job.error ? `${job.error.code}: ${job.error.message}` : '');
    if (fs.existsSync(out)) {
      const info = probe(out);
      const v = info.streams.find((s) => s.codec_type === 'video');
      const [n, d] = String(v.avg_frame_rate).split('/').map(Number);
      check(v.width === 320 && v.height === 240 && Math.abs(n / d - 48) < 0.5,
        'the combined result is both bigger and smoother',
        `${v.width}x${v.height} @ ${(n / d).toFixed(2)}fps`);
      check(Math.abs(Number(info.format.duration) - 1.5) < 0.2,
        'the combined pipeline still preserves duration',
        `${Number(info.format.duration).toFixed(3)}s`);
    }
  }

  /* ---- an engine that is not installed must fail honestly ---- */
  {
    const emptyEngines = new EngineManager({ rootDir: path.join(TMP, 'no-engines') });
    const mgr2 = new JobManager({
      dir: path.join(TMP, 'jobs2'),
      workDir: path.join(TMP, 'work2'),
      resolveBins: () => ({ ffmpeg: FFMPEG, ffprobe: FFPROBE, ytdlp: null }),
      engines: emptyEngines
    });
    mgr2.init();
    const src = makeSource('tiny.mp4', [
      '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=10:duration=1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '40', '-pix_fmt', 'yuv420p'
    ]);
    const analysis = await analyze(FFPROBE, src, {});
    const job = await runJob(mgr2, recipes.defaultRecipe(analysis, {
      output: { path: path.join(TMP, 'never.mp4'), encoder: 'libx264' },
      reconstruction: { enabled: true, mode: 'neural', aiMode: 'upscale', aiScale: 2 }
    }), analysis);
    check(job.status === 'failed' && job.error.code === 'ENGINE_MISSING',
      'asking for AI without the engine fails fast instead of silently going classical',
      job.error ? job.error.code : job.status);
    check(!fs.existsSync(path.join(TMP, 'never.mp4')),
      'a refused AI job produces no output file');
    await mgr2.shutdown();
  }

  await mgr.shutdown();
}

/* ================================================================== *
 * Run
 * ================================================================== */

(async () => {
  console.log('Visionance neural verification');

  coreInterpolation();
  coreEngines();
  await coreEngineManager();
  corePipeline();

  let realRan = false;
  if (CORE_ONLY) {
    console.log('\nREAL neural inference — SKIPPED (--core)');
  } else if (!FFMPEG || !FFPROBE) {
    console.log('\nREAL neural inference — SKIPPED (ffmpeg unavailable)');
  } else {
    const engines = new EngineManager({ rootDir: enginesRoot() });
    const status = await engines.statusAll({ force: true });
    if (status.realesrgan.status !== STATUS.READY && status.rife.status !== STATUS.READY) {
      console.log(`\nREAL neural inference — SKIPPED (no engine ready in ${enginesRoot()})`);
      console.log(`  realesrgan=${status.realesrgan.status} rife=${status.rife.status}`);
      console.log('  Install them from Settings → AI engines, then re-run.');
    } else {
      await realTests(status);
      realRan = true;
    }
  }

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n${ran} checks, ${failures} failure(s)`);
  console.log(realRan
    ? 'Real neural inference: TESTED'
    : 'Real neural inference: NOT TESTED (core/adapter logic only)');
  console.log(failures === 0 ? 'PASS' : 'FAIL');
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Harness error:', err);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
