/**
 * Render pipeline verification.
 *
 * Generates synthetic sources with ffmpeg, then drives the real JobManager
 * end to end and asserts that:
 *   - a plain re-encode produces a verified file
 *   - preset-derived recipes compile to filter graphs ffmpeg accepts
 *   - platform targets (Shorts/Reels) actually produce the requested canvas
 *   - frame-rate conversion lands on the requested rate
 *   - audio can be dropped, kept and loudness-normalised
 *   - chunked rendering produces a correct, concatenated file
 *   - cancellation stops ffmpeg and leaves no output behind
 *   - a job whose output fails verification does not report success
 *   - jobs persist, and a job that was running when the app died reloads as
 *     `interrupted` rather than as a progress bar that never moves
 *
 *   node tools/verify-export.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { JobManager } = require(path.join(ROOT, 'src', 'main', 'jobs', 'job-manager'));
const { JobStore } = require(path.join(ROOT, 'src', 'main', 'jobs', 'job-store'));
const { Workspace } = require(path.join(ROOT, 'src', 'main', 'jobs', 'workspace'));
const recipes = require(path.join(ROOT, 'src', 'main', 'recipe'));
const { analyze } = require(path.join(ROOT, 'src', 'main', 'media-analyzer'));
const { logger } = require(path.join(ROOT, 'src', 'main', 'logger'));

logger.level = process.env.VISIONANCE_LOG || 'warn';

/* ------------------------------------------------------------------ *
 * Binaries
 * ------------------------------------------------------------------ */

function which(name) {
  const exe = process.platform === 'win32' ? name + '.exe' : name;
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(d, exe);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function staticBinary(moduleName) {
  try {
    const mod = require(moduleName);
    const p = typeof mod === 'string' ? mod : mod && mod.path;
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

// Prefer the bundled binaries: they are what the app itself uses, and relying
// on PATH alone silently skipped this whole harness on a normal dev machine.
const FFMPEG = staticBinary('ffmpeg-static') || which('ffmpeg');
const FFPROBE = staticBinary('ffprobe-static') || which('ffprobe');

if (!FFMPEG || !FFPROBE) {
  console.error('ffmpeg/ffprobe unavailable (neither bundled nor on PATH); cannot verify rendering.');
  process.exit(1);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'visionance-test-'));
const OUT = path.join(TMP, 'out');
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (ok, label, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function makeSource(name, args) {
  const file = path.join(TMP, name);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args, file]);
  return file;
}

function probe(file) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE, [
      '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file
    ], (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))));
  });
}

function loadPresets() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'presets.js'), 'utf8');
  const sandbox = { window: {} };
  new Function('window', src)(sandbox.window);
  return sandbox.window.VSPresets;
}

/* ------------------------------------------------------------------ *
 * Harness plumbing
 * ------------------------------------------------------------------ */

function makeManager(dirName = 'jobs') {
  const dir = path.join(TMP, dirName);
  return new JobManager({
    dir,
    workDir: path.join(dir, 'work'),
    resolveBins: () => ({ ffmpeg: FFMPEG, ffprobe: FFPROBE, ytdlp: null })
  });
}

/** Resolve once a job reaches a terminal (or paused) state. */
function waitForJob(manager, id, states = ['completed', 'failed', 'cancelled', 'paused']) {
  return new Promise((resolve) => {
    const done = (j) => j.id === id && states.includes(j.status);
    const existing = manager.get(id);
    if (existing && done(existing)) return resolve(existing);
    const onUpdate = (job) => {
      if (!done(job)) return;
      manager.off('update', onUpdate);
      resolve(job);
    };
    manager.on('update', onUpdate);
  });
}

async function runJob(manager, { recipe, analysis, label }) {
  const created = await manager.create({ recipe, analysis });
  const final = await waitForJob(manager, created.id);
  if (final.status !== 'completed' && label) {
    console.log(`       ${label}: ${final.error ? `${final.error.code} ${final.error.message}` : 'no error recorded'}`);
    if (final.error && final.error.technicalDetails) {
      console.log(`       detail: ${final.error.technicalDetails.slice(0, 400)}`);
    }
  }
  return final;
}

/* ------------------------------------------------------------------ *
 * Suite
 * ------------------------------------------------------------------ */

(async () => {
  console.log('Generating test sources…');
  const SOURCE = makeSource('source.mp4', [
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '34',
    '-c:a', 'aac', '-shortest', '-pix_fmt', 'yuv420p'
  ]);
  const SILENT = makeSource('silent.mp4', [
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '34', '-pix_fmt', 'yuv420p'
  ]);
  const VERTICAL = makeSource('vertical.mp4', [
    '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '34', '-pix_fmt', 'yuv420p'
  ]);
  // Long enough to produce several chunks at the 5 s minimum chunk length.
  const LONG = makeSource('long.mp4', [
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=18',
    '-f', 'lavfi', '-i', 'sine=frequency=330:duration=18',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '36',
    '-c:a', 'aac', '-shortest', '-pix_fmt', 'yuv420p'
  ]);

  const analysis = await analyze(FFPROBE, SOURCE, { deep: true });
  console.log(
    `Source: ${analysis.video.width}x${analysis.video.height} @ ${analysis.video.nominalFps}fps, ` +
    `${analysis.container.duration.toFixed(2)}s, audio=${!!analysis.audio}, mode=${analysis.derived.frameRateMode}\n`
  );

  const manager = makeManager();
  manager.init();

  const base = (overrides) => recipes.defaultRecipe(analysis, overrides);

  /* ---------------- 1. straight re-encode ---------------- */
  console.log('Plain render');
  {
    const out = path.join(OUT, 'plain.mp4');
    const job = await runJob(manager, {
      recipe: base({ output: { path: out, quality: 55, encoder: 'libx264' } }),
      analysis,
      label: 'plain'
    });
    check(job.status === 'completed', 'a plain re-encode completes and verifies');
    check(fs.existsSync(out), 'output file exists at the chosen path');
    check(!fs.existsSync(out + '.vspart'), 'the temporary part file is cleaned up');
    if (job.verification) {
      check(job.verification.ok, 'every verification check passed',
        job.verification.failures.join('; '));
    }
    if (fs.existsSync(out)) {
      const info = await probe(out);
      const v = info.streams.find((s) => s.codec_type === 'video');
      const a = info.streams.find((s) => s.codec_type === 'audio');
      check(v.width === 640 && v.height === 360, 'source geometry preserved', `${v.width}x${v.height}`);
      check(!!a, 'audio preserved by default');
    }
  }

  /* ---------------- 2. preset-derived recipes ---------------- */
  console.log('\nPreset-derived recipes (1080p, libx264)');
  const { BUILTIN } = loadPresets();
  for (const preset of BUILTIN) {
    const out = path.join(OUT, `preset-${preset.id}.mp4`);
    const recipe = recipes.fromPreviewParams(preset.params, analysis, {
      output: { path: out, quality: 50, encoder: 'libx264', preset: 'ultrafast' },
      reconstruction: {
        enabled: true,
        mode: 'classical',
        targetResolution: { mode: 'custom', width: 1920, height: 1080 }
      }
    });
    const job = await runJob(manager, { recipe, analysis, label: preset.id });
    let detail = '';
    let ok = job.status === 'completed';
    if (ok) {
      const info = await probe(out);
      const v = info.streams.find((s) => s.codec_type === 'video');
      const size = Number(info.format.size);
      detail = `${v.width}x${v.height} ${(size / 1024).toFixed(0)}KB`;
      if (v.width !== 1920 || v.height !== 1080) { ok = false; detail += ' WRONG SIZE'; }
    }
    check(ok, preset.id.padEnd(12), detail);
  }

  /* ---------------- 3. platform targets ---------------- */
  console.log('\nPlatform targets');
  for (const [platformId, expect] of [
    ['youtube-shorts', { w: 1080, h: 1920 }],
    ['instagram-feed', { w: 1080, h: 1350 }]
  ]) {
    const out = path.join(OUT, `${platformId}.mp4`);
    let recipe = recipes.applyPlatform(base({}), platformId);
    recipe = recipes.sanitize({
      ...recipe,
      output: { ...recipe.output, path: out, quality: 45, encoder: 'libx264', preset: 'ultrafast' }
    }).recipe;
    const job = await runJob(manager, { recipe, analysis, label: platformId });
    let detail = '';
    let ok = job.status === 'completed';
    if (ok) {
      const info = await probe(out);
      const v = info.streams.find((s) => s.codec_type === 'video');
      detail = `${v.width}x${v.height}`;
      ok = v.width === expect.w && v.height === expect.h;
    }
    check(ok, `${platformId} produces ${expect.w}x${expect.h}`, detail);
  }

  /* ---------------- 4. frame rate conversion ---------------- */
  console.log('\nFrame rate');
  {
    const out = path.join(OUT, 'fps50.mp4');
    const job = await runJob(manager, {
      recipe: base({
        output: { path: out, quality: 40, encoder: 'libx264', preset: 'ultrafast', fps: 50 },
        motion: { enabled: true, targetFps: 50, interpolation: 'none' }
      }),
      analysis,
      label: 'fps'
    });
    let detail = '';
    let ok = job.status === 'completed';
    if (ok) {
      const info = await probe(out);
      const v = info.streams.find((s) => s.codec_type === 'video');
      const [n, d] = String(v.avg_frame_rate).split('/').map(Number);
      const fps = d ? n / d : 0;
      detail = `${fps.toFixed(2)} fps`;
      ok = Math.abs(fps - 50) < 0.6;
    }
    check(ok, '25 fps source converted to 50 fps', detail);
  }

  /* ---------------- 5. audio handling ---------------- */
  console.log('\nAudio');
  {
    const out = path.join(OUT, 'noaudio.mp4');
    const job = await runJob(manager, {
      recipe: base({
        output: { path: out, quality: 40, encoder: 'libx264', preset: 'ultrafast' },
        audio: { enabled: false, mode: 'none' }
      }),
      analysis,
      label: 'no-audio'
    });
    let ok = job.status === 'completed';
    if (ok) {
      const info = await probe(out);
      ok = !info.streams.some((s) => s.codec_type === 'audio');
    }
    check(ok, '"keep audio" off produces a video-only file');
  }
  {
    const out = path.join(OUT, 'loudnorm.mp4');
    const job = await runJob(manager, {
      recipe: base({
        output: { path: out, quality: 40, encoder: 'libx264', preset: 'ultrafast' },
        audio: { enabled: true, mode: 'encode', normalize: { enabled: true } }
      }),
      analysis,
      label: 'loudnorm'
    });
    check(job.status === 'completed', 'loudness normalisation renders and verifies');
  }
  {
    const silentAnalysis = await analyze(FFPROBE, SILENT, {});
    const out = path.join(OUT, 'from-silent.mp4');
    const job = await runJob(manager, {
      recipe: recipes.defaultRecipe(silentAnalysis, {
        output: { path: out, quality: 40, encoder: 'libx264', preset: 'ultrafast' }
      }),
      analysis: silentAnalysis,
      label: 'silent-source'
    });
    check(job.status === 'completed', 'a source with no audio renders without asking for one');
    check(silentAnalysis.audio === null, 'analyser reports no audio stream for a silent file');
  }

  /* ---------------- 6. vertical source ---------------- */
  console.log('\nVertical source');
  {
    const verticalAnalysis = await analyze(FFPROBE, VERTICAL, {});
    check(verticalAnalysis.derived.isVertical === true, 'vertical source detected as portrait',
      `${verticalAnalysis.derived.orientation} ${verticalAnalysis.derived.aspectRatioLabel}`);
    const out = path.join(OUT, 'vertical-to-16x9.mp4');
    let recipe = recipes.applyPlatform(recipes.defaultRecipe(verticalAnalysis, {}), 'youtube');
    recipe = recipes.sanitize({
      ...recipe,
      output: { ...recipe.output, path: out, quality: 40, encoder: 'libx264', preset: 'ultrafast' }
    }).recipe;
    const job = await runJob(manager, { recipe, analysis: verticalAnalysis, label: 'vertical' });
    let detail = '';
    let ok = job.status === 'completed';
    if (ok) {
      const info = await probe(out);
      const v = info.streams.find((s) => s.codec_type === 'video');
      detail = `${v.width}x${v.height}`;
      ok = v.width === 1920 && v.height === 1080;
    }
    check(ok, 'portrait source letterboxed into a 1920x1080 canvas', detail);
  }

  /* ---------------- 7. chunked rendering ---------------- */
  console.log('\nChunked rendering');
  {
    const longAnalysis = await analyze(FFPROBE, LONG, {});
    const out = path.join(OUT, 'chunked.mp4');
    const recipe = recipes.defaultRecipe(longAnalysis, {
      output: { path: out, quality: 40, encoder: 'libx264', preset: 'ultrafast' },
      processing: { chunking: { mode: 'on', chunkSeconds: 5 }, verify: true }
    });
    const job = await runJob(manager, { recipe, analysis: longAnalysis, label: 'chunked' });
    check(job.status === 'completed', 'a chunked render completes and verifies');
    check(job.plan && job.plan.chunked === true && job.plan.chunkCount >= 3,
      'the plan is genuinely split into chunks',
      job.plan ? `${job.plan.chunkCount} chunks (${job.plan.chunkReason})` : 'no plan');
    check(job.pauseSupported === true, 'a chunked job advertises pause support');
    check(job.checkpoint && job.checkpoint.completedChunks.length === job.plan.chunkCount,
      'every chunk is checkpointed',
      job.checkpoint ? `${job.checkpoint.completedChunks.length} recorded` : 'no checkpoint');
    if (fs.existsSync(out)) {
      const info = await probe(out);
      const duration = Number(info.format.duration);
      check(Math.abs(duration - longAnalysis.container.duration) < 0.8,
        'concatenated duration matches the source', `${duration.toFixed(2)}s`);
      check(info.streams.some((s) => s.codec_type === 'audio'),
        'audio survives the chunk-and-join round trip');
    }
  }

  /* ---------------- 7b. pause and resume ---------------- */
  console.log('\nPause and resume');
  {
    const longAnalysis = await analyze(FFPROBE, LONG, {});
    const out = path.join(OUT, 'paused.mp4');
    // Deliberately slow per chunk so the pause request lands mid-job rather
    // than after everything has already finished.
    const recipe = recipes.defaultRecipe(longAnalysis, {
      output: { path: out, quality: 95, encoder: 'libx264', preset: 'veryslow' },
      reconstruction: {
        enabled: true,
        mode: 'classical',
        targetResolution: { mode: 'custom', width: 1280, height: 720 }
      },
      processing: { chunking: { mode: 'on', chunkSeconds: 5 }, verify: true }
    });

    const created = await manager.create({ recipe, analysis: longAnalysis });
    let requested = false;
    const onUpdate = (job) => {
      if (job.id !== created.id || requested) return;
      if (job.status === 'running' && job.checkpoint && job.checkpoint.completedChunks.length >= 1) {
        requested = true;
        try { manager.pause(job.id); } catch (err) { console.log(`       pause refused: ${err.message}`); }
      }
    };
    manager.on('update', onUpdate);
    const paused = await waitForJob(manager, created.id);
    manager.off('update', onUpdate);

    check(paused.status === 'paused', 'a chunked job pauses at a chunk boundary', paused.status);
    const done = paused.checkpoint ? paused.checkpoint.completedChunks.length : 0;
    check(done > 0 && done < paused.plan.chunkCount,
      'the pause happened part-way through', `${done}/${paused.plan.chunkCount} chunks done`);
    check(!fs.existsSync(out), 'a paused job has not written its output yet');

    if (paused.status === 'paused') {
      manager.resume(created.id);
      const finished = await waitForJob(manager, created.id);
      check(finished.status === 'completed', 'a paused job resumes and completes', finished.status);
      check(finished.checkpoint.completedChunks.length === finished.plan.chunkCount,
        'resuming finishes the remaining chunks only',
        `${finished.checkpoint.completedChunks.length}/${finished.plan.chunkCount}`);
      if (fs.existsSync(out)) {
        const info = await probe(out);
        const duration = Number(info.format.duration);
        check(Math.abs(duration - longAnalysis.container.duration) < 0.8,
          'the resumed output covers the whole source', `${duration.toFixed(2)}s`);
      }
    }
  }

  /* ---------------- 8. cancellation ---------------- */
  console.log('\nCancellation');
  {
    const out = path.join(OUT, 'cancelled.mp4');
    const created = await manager.create({
      recipe: base({
        output: { path: out, quality: 100, encoder: 'libx264', preset: 'veryslow' },
        reconstruction: {
          enabled: true,
          mode: 'classical',
          targetResolution: { mode: 'custom', width: 3840, height: 2160 }
        }
      }),
      analysis
    });
    // Wait until ffmpeg is genuinely running before pulling the plug.
    await new Promise((resolve) => {
      const onUpdate = (j) => {
        if (j.id === created.id && j.status === 'running' && j.stage === 'ENCODE') {
          manager.off('update', onUpdate);
          resolve();
        }
      };
      manager.on('update', onUpdate);
      setTimeout(resolve, 6000);
    });
    manager.cancel(created.id);
    const final = await waitForJob(manager, created.id);
    check(final.status === 'cancelled', 'cancel drives the job to cancelled', final.status);
    check(!fs.existsSync(out), 'no output file is left behind');
    check(!fs.existsSync(out + '.vspart'), 'the partial file is removed');
  }

  /* ---------------- 9. failure paths ---------------- */
  console.log('\nFailure handling');
  {
    const job = await runJob(manager, {
      recipe: base({
        source: { type: 'local', path: path.join(TMP, 'does-not-exist.mp4') },
        output: { path: path.join(OUT, 'missing.mp4') }
      }),
      analysis: null
    });
    check(job.status === 'failed', 'a missing source fails the job', job.status);
    check(job.error && job.error.code === 'SOURCE_NOT_FOUND',
      'the failure carries a structured code', job.error && job.error.code);
    check(job.error && job.error.recoverable === false, 'a missing file is reported as unrecoverable');
  }
  {
    // Point the verifier at a real 640x360 render while claiming the recipe
    // asked for 1080p: this is exactly the "ffmpeg exited 0 but the file is
    // wrong" case that must never be reported as success.
    const { runVerify } = require(path.join(ROOT, 'src', 'main', 'jobs', 'stages', 'verify'));
    const result = await runVerify({
      filePath: path.join(OUT, 'plain.mp4'),
      recipe: base({ output: { path: path.join(OUT, 'plain.mp4') } }),
      geometry: { width: 1920, height: 1080, fps: 25 },
      plan: { totalDuration: analysis.container.duration },
      bins: { ffprobe: FFPROBE },
      report: () => {},
      log: logger,
      jobId: 'job_verifytest'
    });
    check(result.ok === false, 'verification rejects a file with the wrong resolution');
    check(result.failures.some((f) => /resolution/.test(f)),
      'the verification failure names the resolution check', result.failures[0]);
  }

  /* ---------------- 10. persistence and restart recovery ---------------- */
  console.log('\nPersistence');
  {
    const persisted = manager.list();
    check(persisted.length > 0, 'jobs are held in the store', `${persisted.length} jobs`);
    manager.store.flush();

    const reloaded = makeManager();
    const state = reloaded.init();
    check(state.jobs.length === persisted.length,
      'every job reloads from disk after a restart', `${state.jobs.length} jobs`);
    const completed = state.jobs.filter((j) => j.status === 'completed').length;
    check(completed > 0, 'completed jobs stay completed across a restart', `${completed} completed`);
  }
  {
    // Simulate a hard crash: write an index that still says "running".
    const dir = path.join(TMP, 'crash');
    const workspace = new Workspace(path.join(dir, 'work'));
    workspace.ensureRoot();
    const store = new JobStore({ dir, workspace });
    store.upsert({
      id: 'job_crashtest01',
      createdAt: Date.now(),
      status: 'running',
      progress: 0.42,
      stages: [],
      warnings: [],
      source: { type: 'local', path: SOURCE },
      recipe: base({ output: { path: path.join(OUT, 'crash.mp4') } }),
      output: { path: path.join(OUT, 'crash.mp4') }
    }, { immediate: true });

    const reopened = new JobStore({ dir, workspace: new Workspace(path.join(dir, 'work')) });
    const { jobs: loaded, recovered } = reopened.load();
    const job = loaded.find((j) => j.id === 'job_crashtest01');
    check(job && job.status === 'interrupted',
      'a job that was running at crash time reloads as interrupted', job && job.status);
    check(recovered.length === 1, 'the recovery pass reports what it changed');
    check(!!(job && job.error && job.error.recoverable),
      'the interrupted job carries a recoverable error the user can act on');
  }
  {
    // A damaged index must fall back to the backup rather than losing the queue.
    const dir = path.join(TMP, 'damaged');
    const workspace = new Workspace(path.join(dir, 'work'));
    workspace.ensureRoot();
    const store = new JobStore({ dir, workspace });
    store.upsert({
      id: 'job_damaged001',
      createdAt: Date.now(),
      status: 'completed',
      progress: 1,
      stages: [],
      warnings: [],
      source: { type: 'local', path: SOURCE },
      recipe: base({ output: { path: path.join(OUT, 'damaged.mp4') } }),
      output: { path: path.join(OUT, 'damaged.mp4') }
    }, { immediate: true });
    // Force a backup to exist, then corrupt the live index.
    store.upsert(store.get('job_damaged001'), { immediate: true });
    fs.writeFileSync(path.join(dir, 'index.json'), '{ this is not json', 'utf8');

    const reopened = new JobStore({ dir, workspace: new Workspace(path.join(dir, 'work')) });
    const { jobs: loaded, warnings } = reopened.load();
    check(loaded.length === 1, 'a corrupted index recovers from the backup copy', `${loaded.length} jobs`);
    check(warnings.length > 0, 'the recovery is reported rather than hidden', warnings[0]);
  }

  await manager.shutdown();

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem${failures === 1 ? '' : 's'})`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Harness error:', err);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
