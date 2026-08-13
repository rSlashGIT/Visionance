/**
 * Backend unit tests.
 *
 * Covers the pure logic that the render harness cannot reach cheaply:
 * the recipe schema, chunk planning, workspace path safety, structured error
 * classification, yt-dlp argument construction and capability parsing, and the
 * ffmpeg filter/command builders.
 *
 * Nothing here touches the network. The URL resolver is tested through its
 * argument builder and its error classifier, so the suite stays green whether
 * or not yt-dlp is installed and whether or not YouTube is reachable.
 *
 *   node --test tools/verify-core.js
 *   node tools/verify-core.js          (same thing; node:test runs either way)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const recipes = require(path.join(ROOT, 'src', 'main', 'recipe'));
const chunking = require(path.join(ROOT, 'src', 'main', 'jobs', 'chunking'));
const pipeline = require(path.join(ROOT, 'src', 'main', 'jobs', 'pipeline'));
const { Workspace } = require(path.join(ROOT, 'src', 'main', 'jobs', 'workspace'));
const { JobStore } = require(path.join(ROOT, 'src', 'main', 'jobs', 'job-store'));
const ytdlp = require(path.join(ROOT, 'src', 'main', 'ytdlp'));
const jsRuntime = require(path.join(ROOT, 'src', 'main', 'js-runtime'));
const errors = require(path.join(ROOT, 'src', 'main', 'errors'));
const filters = require(path.join(ROOT, 'src', 'main', 'ffmpeg', 'filters'));
const command = require(path.join(ROOT, 'src', 'main', 'ffmpeg', 'command'));
const encoders = require(path.join(ROOT, 'src', 'main', 'ffmpeg', 'encoders'));
const analyzer = require(path.join(ROOT, 'src', 'main', 'media-analyzer'));
const { logger } = require(path.join(ROOT, 'src', 'main', 'logger'));

logger.level = 'silent';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'visionance-core-'));
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** A plausible analysis without needing ffprobe. */
function fakeAnalysis(overrides = {}) {
  const base = {
    schemaVersion: 1,
    analysedAt: Date.now(),
    source: { type: 'local', path: 'C:\\videos\\clip.mp4', url: null, name: 'clip.mp4', fileSize: 1000 },
    container: { formatName: 'mov,mp4', duration: 300, size: 1000, bitrate: 5_000_000, tags: {} },
    video: {
      width: 1920, height: 1080, codec: 'h264', profile: 'High', pixelFormat: 'yuv420p',
      bitDepth: 8, rotation: null, rotationSwapsAxes: false, fieldOrder: 'progressive',
      interlaced: false, rFps: 30, avgFps: 30, nominalFps: 30, duration: 300
    },
    color: { isHDR: false, transfer: 'bt709', hdrFormat: null },
    audio: { codec: 'aac', channels: 2, sampleRate: 48000 },
    audioStreams: [],
    subtitleStreams: [],
    derived: {
      displayWidth: 1920, displayHeight: 1080, orientation: 'landscape',
      aspectRatio: 1.7778, aspectRatioLabel: '16:9', isVertical: false, isHDR: false,
      isInterlaced: false, nominalFps: 30, frameRateMode: 'constant',
      resolutionClass: '1080p', durationSeconds: 300, hasAudio: true
    },
    warnings: []
  };
  return { ...base, ...overrides };
}

/* ================================================================== *
 * Recipes
 * ================================================================== */

test('recipe: defaults are complete and versioned', () => {
  const r = recipes.defaultRecipe(fakeAnalysis());
  assert.equal(r.schemaVersion, recipes.SCHEMA_VERSION);
  for (const section of ['source', 'trim', 'restore', 'reconstruction', 'motion',
    'framing', 'color', 'audio', 'output', 'processing']) {
    assert.ok(r[section], `missing section ${section}`);
  }
  assert.equal(r.restore.enabled, false, 'nothing is switched on without being asked for');
  assert.equal(r.reconstruction.enabled, false);
  assert.equal(r.analysisRef.width, 1920);
  assert.equal(r.analysisRef.frameRateMode, 'constant');
});

test('recipe: defaults adapt to the source', () => {
  const interlaced = recipes.defaultRecipe(fakeAnalysis({
    derived: { ...fakeAnalysis().derived, isInterlaced: true }
  }));
  assert.equal(interlaced.restore.deinterlace, 'on');

  const hdr = recipes.defaultRecipe(fakeAnalysis({
    derived: { ...fakeAnalysis().derived, isHDR: true }
  }));
  assert.equal(hdr.color.toneMap, 'hable');

  const silent = recipes.defaultRecipe(fakeAnalysis({ audio: null, derived: { ...fakeAnalysis().derived, hasAudio: false } }));
  assert.equal(silent.audio.enabled, false);
  assert.equal(silent.audio.mode, 'none');
});

test('recipe: sanitisation clamps, coerces and drops unknown keys', () => {
  const { recipe, warnings } = recipes.sanitize({
    schemaVersion: 1,
    output: { quality: 9999, container: 'mp4', codec: 'h264', path: 'C:\\out.mp4' },
    restore: { enabled: true, denoise: 5, deblock: -3 },
    reconstruction: { scale: 99 },
    color: { contrast: 'nonsense' },
    somethingInvented: { nope: true },
    audio: { bitrateKbps: 5 }
  });
  assert.equal(recipe.output.quality, 100);
  assert.equal(recipe.restore.denoise, 1);
  assert.equal(recipe.restore.deblock, 0);
  assert.equal(recipe.reconstruction.scale, 8);
  assert.equal(recipe.color.contrast, 0, 'non-numeric input falls back to the default');
  assert.equal(recipe.audio.bitrateKbps, 32);
  assert.equal(recipe.somethingInvented, undefined, 'unknown keys are dropped');
  assert.ok(warnings.length > 0, 'clamping is reported');
});

test('recipe: contradictory intent is resolved and explained', () => {
  const { recipe, warnings } = recipes.sanitize({
    audio: { mode: 'copy', normalize: { enabled: true } },
    framing: { enabled: true, tracking: 'auto' },
    output: { container: 'webm', codec: 'h264', path: 'x.webm', bitrateMode: 'bitrate' },
    trim: { startSeconds: 30, endSeconds: 10 }
  });
  assert.equal(recipe.audio.mode, 'encode', 'loudnorm forces a re-encode');
  // Smart Reframe is implemented now, so 'auto' survives sanitisation. Whether
  // a usable trajectory can be measured is decided at run time by the REFRAME
  // stage, which falls back to a centre crop and says so.
  assert.equal(recipe.framing.tracking, 'auto', 'subject tracking is a real option');
  assert.equal(recipe.output.container, 'mp4', 'webm cannot carry h264');
  assert.equal(recipe.output.bitrateMode, 'quality', 'bitrate mode needs a bitrate');
  assert.equal(recipe.trim.startSeconds, null, 'an inverted trim is discarded');
  assert.ok(warnings.length >= 3, `expected warnings for each fix, got ${warnings.length}`);
});

test('recipe: validation rejects what sanitisation cannot fix', () => {
  const missingOutput = recipes.sanitize({ source: { type: 'local', path: 'a.mp4' } }).recipe;
  const v1 = recipes.validate(missingOutput);
  assert.equal(v1.valid, false);
  assert.ok(v1.errors.some((e) => e.field === 'output.path'));

  // A remote job is valid with only the page URL: the stream URL expires and
  // is re-resolved at render time.
  const remote = recipes.sanitize({
    source: { type: 'remote', webpageUrl: 'https://example.com/watch' },
    output: { path: 'b.mp4' }
  }).recipe;
  assert.equal(recipes.validate(remote).valid, true);
  assert.equal(recipes.validate(recipes.sanitize({
    source: { type: 'remote' }, output: { path: 'b.mp4' }
  }).recipe).valid, false, 'a remote source with no way to reach it is rejected');

  // Neural stages are implemented now, so the recipe itself is valid; whether
  // the engine is installed is a run-time fact reported as ENGINE_MISSING.
  const neural = recipes.sanitize({
    source: { type: 'local', path: 'a.mp4' },
    output: { path: 'b.mp4' },
    reconstruction: { mode: 'neural', enabled: true }
  }).recipe;
  assert.equal(recipes.validate(neural).valid, true);

  // AI interpolation with no target rate is genuinely unsatisfiable.
  const noFps = recipes.sanitize({
    source: { type: 'local', path: 'a.mp4' },
    output: { path: 'b.mp4' },
    motion: { enabled: true, interpolation: 'ai' }
  }).recipe;
  assert.equal(recipes.validate(noFps).valid, false);
});

test('recipe: serialisation round-trips', () => {
  const original = recipes.defaultRecipe(fakeAnalysis(), {
    output: { path: 'C:\\out.mp4', quality: 63 },
    restore: { enabled: true, denoise: 0.4 }
  });
  const restored = recipes.deserialize(recipes.serialize(original)).recipe;
  assert.deepEqual(restored, original);
});

test('recipe: old and future schema versions still load', () => {
  const legacy = { schemaVersion: 0, output: { path: 'a.mp4', quality: 80 } };
  const up = recipes.migrate(legacy);
  assert.equal(up.recipe.schemaVersion, recipes.SCHEMA_VERSION);
  assert.equal(up.recipe.output.quality, 80, 'known fields survive the upgrade');
  assert.equal(up.migrated, true);

  const future = {
    schemaVersion: 99,
    output: { path: 'a.mp4', quality: 55 },
    holographicRelight: { enabled: true }
  };
  const down = recipes.migrate(future);
  assert.equal(down.recipe.schemaVersion, recipes.SCHEMA_VERSION);
  assert.equal(down.recipe.output.quality, 55);
  assert.equal(down.recipe.holographicRelight, undefined);
  assert.match(down.note, /schema v99/);
});

test('recipe: preview parameters become intent, not a pixel promise', () => {
  const params = {
    enabled: true, denoise: 0.3, deblock: 0.2, sharpen: 0.5,
    contrast: 0.1, saturation: 0.2, scaleFactor: 2
  };
  const r = recipes.fromPreviewParams(params, fakeAnalysis(), { output: { path: 'o.mp4' } });
  assert.equal(r.restore.enabled, true);
  assert.equal(r.color.enabled, true);
  assert.equal(r.reconstruction.enabled, true);
  assert.equal(r.reconstruction.targetResolution.mode, 'scale');
  assert.equal(r.reconstruction.scale, 2);

  const off = recipes.fromPreviewParams({ ...params, enabled: false }, fakeAnalysis(), { output: { path: 'o.mp4' } });
  assert.equal(off.restore.enabled, false, 'a disabled preview does not silently enable processing');
});

test('recipe: platform targets seed geometry', () => {
  const shorts = recipes.applyPlatform(recipes.defaultRecipe(fakeAnalysis()), 'youtube-shorts');
  assert.equal(shorts.framing.enabled, true);
  assert.equal(shorts.framing.canvas, '9:16');
  assert.equal(shorts.reconstruction.targetResolution.width, 1080);

  const geometry = recipes.resolveOutputGeometry(shorts, fakeAnalysis());
  assert.equal(geometry.width, 1080);
  assert.equal(geometry.height, 1920);
});

test('recipe: geometry stays even and honours fps intent', () => {
  const r = recipes.sanitize({
    output: { path: 'o.mp4', fps: 60 },
    reconstruction: { enabled: true, targetResolution: { mode: 'custom', width: 1921, height: 1081 } }
  }).recipe;
  const g = recipes.resolveOutputGeometry(r, fakeAnalysis());
  assert.equal(g.width % 2, 0);
  assert.equal(g.height % 2, 0);
  assert.equal(g.fps, 60);
  assert.equal(g.fpsChanged, true);
});

/* ================================================================== *
 * Pipeline planning
 * ================================================================== */

test('pipeline: only requested stages are active', () => {
  const analysis = fakeAnalysis();
  const recipe = recipes.defaultRecipe(analysis, { output: { path: 'o.mp4' } });
  const geometry = recipes.resolveOutputGeometry(recipe, analysis);
  const plan = pipeline.planStages(recipe, analysis, geometry, { chunked: false });

  const byId = Object.fromEntries(plan.stages.map((s) => [s.id, s]));
  assert.equal(byId.ANALYSE.mode, 'pass');
  assert.equal(byId.ENCODE.mode, 'pass');
  assert.equal(byId.VERIFY.mode, 'pass');
  assert.equal(byId.RESTORE.mode, 'skipped');
  assert.equal(byId.UPSCALE.mode, 'skipped');
  assert.equal(byId.MUX.mode, 'skipped', 'no mux without chunks');
  assert.equal(plan.requiresChunking, false);
});

test('pipeline: filter-expressible work fuses into the encode', () => {
  const analysis = fakeAnalysis();
  const recipe = recipes.sanitize({
    output: { path: 'o.mp4' },
    restore: { enabled: true, denoise: 0.3 },
    color: { enabled: true, contrast: 0.2 },
    framing: { enabled: true, canvas: '9:16', width: 1080, height: 1920 },
    reconstruction: { enabled: true, targetResolution: { mode: 'custom', width: 1080, height: 1920 } }
  }).recipe;
  const geometry = recipes.resolveOutputGeometry(recipe, analysis);
  const plan = pipeline.planStages(recipe, analysis, geometry, { chunked: true });
  const byId = Object.fromEntries(plan.stages.map((s) => [s.id, s]));

  assert.equal(byId.RESTORE.mode, 'fused');
  assert.equal(byId.GRADE.mode, 'fused');
  assert.equal(byId.REFRAME.mode, 'fused');
  assert.equal(byId.UPSCALE.mode, 'fused');
  assert.equal(byId.MUX.mode, 'pass');
  assert.equal(plan.requiresChunking, false, 'fused work does not force chunking');
  assert.match(pipeline.describePlan(plan.stages), /Encode/);
});

test('pipeline: progress only counts stages that really run', () => {
  const stages = [
    { id: 'ANALYSE', mode: 'pass', weight: 0.02, status: 'completed', progress: 1 },
    { id: 'RESTORE', mode: 'fused', weight: 0, status: 'pending', progress: 0 },
    { id: 'ENCODE', mode: 'pass', weight: 1, status: 'running', progress: 0.5 },
    { id: 'VERIFY', mode: 'pass', weight: 0.03, status: 'pending', progress: 0 }
  ];
  const p = pipeline.aggregateProgress(stages);
  assert.ok(p > 0.4 && p < 0.55, `expected roughly half, got ${p}`);

  stages.forEach((s) => { s.status = 'completed'; s.progress = 1; });
  assert.equal(pipeline.aggregateProgress(stages), 1);
});

/* ================================================================== *
 * Chunking
 * ================================================================== */

test('chunking: auto stays single-pass unless a stage needs it', () => {
  const single = chunking.planChunks({ durationSeconds: 3600, chunkSeconds: 120, mode: 'auto' });
  assert.equal(single.enabled, false);
  assert.equal(single.chunks.length, 1);

  const forced = chunking.planChunks({
    durationSeconds: 3600, chunkSeconds: 120, mode: 'auto', requiresChunking: true
  });
  assert.equal(forced.enabled, true);
  assert.equal(forced.reason, 'stage-requires-chunking');
});

test('chunking: boundaries are contiguous and cover the trim range', () => {
  const plan = chunking.planChunks({
    durationSeconds: 300, startSeconds: 30, endSeconds: 200, chunkSeconds: 60, mode: 'on'
  });
  assert.equal(plan.enabled, true);
  assert.equal(plan.totalDuration, 170);
  assert.equal(plan.chunks[0].startSeconds, 30);
  for (let i = 1; i < plan.chunks.length; i++) {
    assert.equal(plan.chunks[i].startSeconds, plan.chunks[i - 1].endSeconds, 'no gaps between chunks');
  }
  const last = plan.chunks[plan.chunks.length - 1];
  assert.equal(last.endSeconds, 200);
  const sum = plan.chunks.reduce((a, c) => a + c.durationSeconds, 0);
  assert.ok(Math.abs(sum - 170) < 0.01);
});

test('chunking: no sliver chunk at the end', () => {
  const plan = chunking.planChunks({ durationSeconds: 122, chunkSeconds: 60, mode: 'on' });
  const last = plan.chunks[plan.chunks.length - 1];
  assert.ok(last.durationSeconds >= 12, `sliver chunk of ${last.durationSeconds}s`);
});

test('chunking: unknown duration refuses to invent boundaries', () => {
  const plan = chunking.planChunks({ durationSeconds: 0, mode: 'on' });
  assert.equal(plan.enabled, false);
  assert.equal(plan.reason, 'unknown-duration');
  assert.equal(plan.chunks[0].durationSeconds, null);
});

test('chunking: checkpoints are idempotent and reconcile against disk', () => {
  const plan = chunking.planChunks({ durationSeconds: 300, chunkSeconds: 60, mode: 'on' });
  let cp = chunking.newCheckpoint(plan);
  cp = chunking.markChunkComplete(cp, plan, 0);
  cp = chunking.markChunkComplete(cp, plan, 0);
  assert.equal(cp.completedChunks.length, 1, 'replaying a completion does not double count');
  assert.equal(cp.completedDuration, 60);
  assert.equal(cp.nextChunk, 1);

  cp = chunking.markChunkComplete(cp, plan, 1);
  // Chunk 1's file vanished; it must be redone.
  const reconciled = chunking.reconcile(cp, plan, new Set([0]));
  assert.deepEqual(reconciled.completedChunks, [0]);
  assert.equal(reconciled.nextChunk, 1);
});

/* ================================================================== *
 * Workspace
 * ================================================================== */

test('workspace: refuses path traversal and bad job ids', () => {
  const ws = new Workspace(path.join(TMP, 'ws'));
  ws.ensureRoot();
  assert.throws(() => ws.resolve('job_abcd', '..', '..', 'evil.txt'), /outside the job workspace/);
  assert.throws(() => ws.resolve('../../etc'), /Invalid job identifier/);
  assert.throws(() => ws.resolve('job_'), /Invalid job identifier/);
  assert.ok(ws.resolve('job_abcd', 'chunks', 'chunk_0001.mp4').includes('job_abcd'));
});

test('workspace: atomic json survives being read back', () => {
  const ws = new Workspace(path.join(TMP, 'ws2'));
  ws.create('job_atomic01');
  ws.writeManifest('job_atomic01', { id: 'job_atomic01', status: 'queued' });
  assert.deepEqual(ws.readManifest('job_atomic01'), { id: 'job_atomic01', status: 'queued' });
  assert.equal(ws.readManifest('job_missing01'), null);
});

test('workspace: orphan directories are identified', () => {
  const ws = new Workspace(path.join(TMP, 'ws3'));
  ws.create('job_known0001');
  ws.create('job_orphan001');
  assert.deepEqual(ws.orphans(['job_known0001']), ['job_orphan001']);
});

/* ================================================================== *
 * Job store
 * ================================================================== */

test('job store: secrets and expiring URLs are never written to disk', () => {
  const dir = path.join(TMP, 'store1');
  const ws = new Workspace(path.join(dir, 'work'));
  ws.ensureRoot();
  const store = new JobStore({ dir, workspace: ws });
  store.upsert({
    id: 'job_secret0001',
    createdAt: Date.now(),
    status: 'queued',
    stages: [],
    warnings: [],
    source: { type: 'remote', url: 'https://cdn.example/video?sig=abc', headerToken: 'st_deadbeef', webpageUrl: 'https://example.com/watch' },
    recipe: { source: { type: 'remote', url: 'https://cdn.example/video?sig=abc', headerToken: 'st_deadbeef' } }
  }, { immediate: true });

  const raw = fs.readFileSync(path.join(dir, 'index.json'), 'utf8');
  assert.equal(raw.includes('st_deadbeef'), false, 'header tokens must not be persisted');
  assert.equal(raw.includes('sig=abc'), false, 'expiring CDN URLs must not be persisted');
  assert.ok(raw.includes('https://example.com/watch'), 'the page URL is kept so the job can re-resolve');
});

test('job store: a debounced write still lands, and the queue survives reload', () => {
  const dir = path.join(TMP, 'store2');
  const ws = new Workspace(path.join(dir, 'work'));
  ws.ensureRoot();
  const store = new JobStore({ dir, workspace: ws });
  for (const id of ['job_aaaa0001', 'job_bbbb0002', 'job_cccc0003']) {
    store.upsert({
      id, createdAt: Date.now(), status: 'queued', stages: [], warnings: [],
      source: { type: 'local', path: 'x.mp4' },
      recipe: { output: { path: 'y.mp4' } }
    });
  }
  store.flush();

  const reopened = new JobStore({ dir, workspace: new Workspace(path.join(dir, 'work')) });
  const { jobs } = reopened.load();
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs.map((j) => j.status), ['queued', 'queued', 'queued'],
    'a queued job stays queued across a restart');
});

/* ================================================================== *
 * Errors and redaction
 * ================================================================== */

test('errors: structured shape with human copy and technical detail', () => {
  const e = new errors.VisionanceError('AUTH_REQUIRED', { technicalDetails: 'ERROR: Sign in to confirm' });
  const json = e.toJSON();
  assert.equal(json.code, 'AUTH_REQUIRED');
  assert.equal(json.recoverable, true);
  assert.ok(json.message.length > 10);
  assert.ok(json.suggestedAction);
  assert.ok(json.technicalDetails.includes('Sign in'));

  const unknown = errors.toStructured(new Error('boom'));
  assert.equal(unknown.code, 'UNKNOWN');
  assert.ok(unknown.technicalDetails.includes('boom'));
});

test('errors: redaction strips credentials from text, headers and argv', () => {
  const text = errors.redact('GET /v?expire=1&signature=SECRETVALUE\nCookie: SID=abc123');
  assert.equal(text.includes('SECRETVALUE'), false);
  assert.equal(text.includes('abc123'), false);

  const headers = errors.redactHeaders({ Cookie: 'SID=abc', 'User-Agent': 'Visionance' });
  assert.equal(headers.Cookie, '[redacted]');
  assert.equal(headers['User-Agent'], 'Visionance');

  const args = errors.redactArgs(['--cookies-from-browser', 'chrome', '--no-playlist', '--cookies', 'C:\\c.txt']);
  assert.deepEqual(args, ['--cookies-from-browser', '[redacted]', '--no-playlist', '--cookies', '[redacted]']);
});

/* ================================================================== *
 * yt-dlp policy (no network, no binary required)
 * ================================================================== */

test('ytdlp: the first attempt is always anonymous', () => {
  const caps = { jsRuntimeFlag: null, jsRuntimes: [], supportsCookiesFromBrowser: true };
  const first = ytdlp.planAttempt({
    caps,
    auth: { mode: 'browser', browser: 'chrome' },
    allowAuth: true,
    tried: []
  });
  assert.equal(first.label, 'anonymous');
  assert.equal(first.useAuth, false, 'a configured browser must not be used on the first attempt');

  const args = ytdlp.buildResolveArgs({
    pageUrl: 'https://example.com/watch?v=1',
    auth: first.useAuth ? { mode: 'browser', browser: 'chrome' } : { mode: 'none' },
    caps
  });
  assert.equal(args.includes('--cookies-from-browser'), false,
    'a first attempt must never touch the browser cookie jar');
  assert.ok(args.includes('--dump-single-json'));
  assert.ok(args.includes('--no-playlist'));
  assert.equal(args.includes('--no-check-certificate'), false, 'certificate checking must stay on');
  assert.equal(args[args.length - 2], '--', 'the URL is separated from the options');
});

test('ytdlp: escalation happens only for the failure that calls for it', () => {
  const caps = {
    jsRuntimeFlag: { kind: 'flag', flag: '--js-runtime' },
    jsRuntimes: [{ name: 'deno', path: '/usr/bin/deno' }],
    supportsCookiesFromBrowser: true,
    supportsCookiesFile: true
  };
  const auth = { mode: 'browser', browser: 'edge' };
  const plan = (code, tried) => ytdlp.planAttempt({
    error: code ? { code } : null, caps, auth, allowAuth: true, tried
  });

  assert.equal(plan('VIDEO_UNAVAILABLE', ['anonymous']), null,
    'an unavailable video is not retried with credentials');
  assert.equal(plan('REGION_RESTRICTED', ['anonymous']), null);
  assert.equal(plan('UNKNOWN', ['anonymous']), null);

  assert.equal(plan('AUTH_REQUIRED', ['anonymous']).label, 'authenticated');
  assert.equal(plan('AGE_RESTRICTED', ['anonymous']).label, 'authenticated');
  assert.equal(plan('AUTH_REQUIRED', ['anonymous', 'authenticated']), null,
    'credentials are offered at most once');

  assert.equal(plan('JS_RUNTIME_REQUIRED', ['anonymous']).label, 'js-runtime');
  assert.equal(plan('JS_RUNTIME_REQUIRED', ['anonymous']).jsRuntime.name, 'deno');

  const noAuthConfigured = ytdlp.planAttempt({
    error: { code: 'AUTH_REQUIRED' }, caps, auth: { mode: 'none' }, allowAuth: true, tried: ['anonymous']
  });
  assert.equal(noAuthConfigured, null, 'nothing to escalate to when the user configured nothing');

  const authForbidden = ytdlp.planAttempt({
    error: { code: 'AUTH_REQUIRED' }, caps, auth, allowAuth: false, tried: ['anonymous']
  });
  assert.equal(authForbidden, null);

  // An escalation the installed build cannot perform is reported, not attempted.
  const warnings = [];
  const unsupported = ytdlp.planAttempt({
    error: { code: 'AUTH_REQUIRED' },
    caps: { ...caps, supportsCookiesFromBrowser: false },
    auth,
    allowAuth: true,
    tried: ['anonymous'],
    warn: (m) => warnings.push(m)
  });
  assert.equal(unsupported, null);
  assert.equal(warnings.length, 1);

  // Once escalated, the authenticated attempt does carry the credential flag.
  const args = ytdlp.buildResolveArgs({ pageUrl: 'https://e/v', auth, caps });
  assert.ok(args.includes('--cookies-from-browser'));
  assert.ok(args.includes('edge'));
});

test('ytdlp: a JS runtime is configured only in a way the build supports', () => {
  const noSupport = ytdlp.buildResolveArgs({
    pageUrl: 'https://example.com/v',
    jsRuntime: { name: 'deno' },
    caps: { jsRuntimeFlag: null }
  });
  assert.equal(noSupport.some((a) => /deno/.test(a)), false,
    'never pass a flag the installed build does not advertise');

  const viaFlag = ytdlp.buildResolveArgs({
    pageUrl: 'https://example.com/v',
    jsRuntime: { name: 'deno' },
    caps: { jsRuntimeFlag: { kind: 'flag', flag: '--js-runtime' } }
  });
  assert.ok(viaFlag.includes('--js-runtime'));
  assert.ok(viaFlag.includes('deno'));

  const viaExtractorArg = ytdlp.buildResolveArgs({
    pageUrl: 'https://example.com/v',
    jsRuntime: { name: 'node' },
    caps: { jsRuntimeFlag: { kind: 'extractor-arg', flag: '--extractor-args', template: 'youtube:jsi=%s' } }
  });
  assert.ok(viaExtractorArg.includes('--extractor-args'));
  assert.ok(viaExtractorArg.includes('youtube:jsi=node'));
});

test('ytdlp: the modern --js-runtimes flag is detected and used', () => {
  // The wording of the real 2026.07.04 help output.
  const help = `
      --js-runtimes RUNTIME[:PATH]    Additional JavaScript runtime to enable,
                                      with an optional location for the runtime.
                                      Supported runtimes are (in order of
                                      priority): deno, node, quickjs, bun. Only
                                      "deno" is enabled by default.
      --no-js-runtimes                Clear JavaScript runtimes to enable
      --remote-components COMPONENT   Remote components to allow
  `;
  const flags = ytdlp.parseFlags(help);
  const spec = ytdlp.detectRuntimeFlag(flags, help.toLowerCase());
  assert.equal(spec.kind, 'js-runtimes');
  assert.equal(spec.flag, '--js-runtimes');

  const args = ytdlp.buildResolveArgs({
    pageUrl: 'https://youtube.com/watch?v=x',
    jsRuntime: { runtime: 'node', path: 'C:\\Program Files\\nodejs\\node.exe' },
    caps: { jsRuntimeFlag: spec }
  });
  const idx = args.indexOf('--js-runtimes');
  assert.ok(idx >= 0, 'the flag is passed');
  assert.equal(args[idx + 1], 'node',
    'the bare runtime name is used; RUNTIME:PATH breaks when the path has spaces');
  assert.equal(args.some((a) => a.includes('Program Files')), false,
    'the runtime path never reaches the command line');
});

test('ytdlp: an older build falls back to the spelling it does support', () => {
  const legacy = ytdlp.detectRuntimeFlag(new Set(['--js-runtime']), '');
  assert.equal(legacy.flag, '--js-runtime');

  const viaExtractor = ytdlp.detectRuntimeFlag(
    new Set(['--extractor-args']), 'pass args; see "jsi" for interpreter selection');
  assert.equal(viaExtractor.kind, 'extractor-arg');

  const none = ytdlp.detectRuntimeFlag(new Set(['--cookies']), 'nothing relevant');
  assert.equal(none, null, 'a build with no runtime support advertises none');
});

test('ytdlp: a degraded extraction is a JS-runtime problem, not a mystery', () => {
  const err = Object.assign(new Error('x'), {
    stderr: 'WARNING: [youtube] No supported JavaScript runtime could be found. ' +
      'Only deno is enabled by default; to use another runtime add --js-runtimes RUNTIME[:PATH]'
  });
  assert.equal(ytdlp.classifyError(err).code, 'JS_RUNTIME_REQUIRED');
});

test('ytdlp: rate limiting is not mistaken for a bot challenge', () => {
  // YouTube answers a 429 with a "prove you are not a bot" page; the 429 is the
  // actual cause and the one the user can do something about.
  const err = Object.assign(new Error('x'), {
    stderr: 'WARNING: Unable to download webpage: HTTP Error 429: Too Many Requests\n' +
      "ERROR: Sign in to confirm you're not a bot. Use --cookies-from-browser"
  });
  const classified = ytdlp.classifyError(err);
  assert.equal(classified.code, 'RATE_LIMITED');
  assert.match(classified.suggestedAction, /Wait/);
});

test('ytdlp: format selection copes with codecs the site never stated', () => {
  // archive.org and plenty of direct links report no codecs at all. Session 1
  // rejected every such format and surfaced "This source is not supported".
  const info = {
    title: 'Big Buck Bunny',
    webpage_url: 'https://archive.org/details/x',
    duration: 596,
    formats: [
      { format_id: '0', url: 'https://a/x.ogv', ext: 'ogv', height: 300, protocol: 'https' },
      { format_id: '1', url: 'https://a/x.mp4', ext: 'mp4', height: 360, protocol: 'https' },
      { format_id: '2', url: 'https://a/x.avi', ext: 'avi', height: 720, protocol: 'https' }
    ]
  };
  const result = ytdlp.normaliseInfo(info, 'https://archive.org/details/x', {});
  assert.equal(result.video.ext, 'mp4', 'the mp4 is chosen over the higher-resolution avi');
  assert.equal(result.video.codecsKnown, false);
  assert.ok(result.formatNotes.some((n) => /did not state/.test(n)),
    'the guess is disclosed rather than presented as fact');

  assert.equal(ytdlp.classifyFormat({ url: 'u', ext: 'avi', protocol: 'https' }).playable, false,
    'a container Chromium cannot decode is still rejected');
  assert.equal(ytdlp.classifyFormat({ url: 'u', ext: 'mkv', protocol: 'https' }).playable, false);
  assert.equal(ytdlp.classifyFormat({ url: 'u', ext: 'mp4', protocol: 'm3u8_native' }).playable, false,
    'an adaptive manifest is not directly playable');
  assert.equal(ytdlp.classifyFormat({ url: 'u', ext: 'm4a', protocol: 'https' }).kind, 'audio');
});

test('ytdlp: a height cap never becomes the reason nothing plays', () => {
  const info = {
    title: 'x',
    formats: [
      { format_id: '299', url: 'https://v/1', ext: 'mp4', vcodec: 'avc1.64', acodec: 'none', height: 1080, protocol: 'https' },
      { format_id: '140', url: 'https://a/1', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, protocol: 'https' }
    ]
  };
  const capped = ytdlp.normaliseInfo(info, 'https://e/x', { maxHeight: 480 });
  assert.ok(capped.video, 'something still plays');
  assert.ok(capped.formatNotes.some((n) => /higher one was used/.test(n)),
    'exceeding the cap is reported');
});

test('ytdlp: an HLS-only source explains itself instead of failing blankly', () => {
  const info = {
    title: 'live',
    formats: [
      { format_id: 'hls-1', url: 'https://x/1.m3u8', ext: 'mp4', protocol: 'm3u8_native', height: 720 },
      { format_id: 'hls-2', url: 'https://x/2.m3u8', ext: 'mp4', protocol: 'm3u8', height: 1080 }
    ]
  };
  assert.throws(
    () => ytdlp.normaliseInfo(info, 'https://e/x', {}),
    (e) => e.code === 'NO_PLAYABLE_FORMAT' && /adaptive stream/.test(e.userMessage)
  );
});

test('ytdlp: YouTube prefers a muxed stream when splitting buys no resolution', () => {
  const info = {
    title: 'Me at the zoo',
    formats: [
      { format_id: '18', url: 'https://m/1', ext: 'mp4', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', height: 240, protocol: 'https' },
      { format_id: '134', url: 'https://v/1', ext: 'mp4', vcodec: 'avc1.4d400c', acodec: 'none', height: 240, protocol: 'https' },
      { format_id: '140', url: 'https://a/1', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, protocol: 'https' }
    ]
  };
  const result = ytdlp.normaliseInfo(info, 'https://youtube.com/watch?v=x', {});
  assert.equal(result.muxed, true, 'no reason to juggle two streams at the same height');
  assert.equal(result.audio, null);
});

test('ytdlp: YouTube splits when the video-only ladder goes higher', () => {
  const info = {
    title: 'BBB',
    formats: [
      { format_id: '18', url: 'https://m/1', ext: 'mp4', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', height: 360, protocol: 'https' },
      { format_id: '299', url: 'https://v/1', ext: 'mp4', vcodec: 'avc1.64002a', acodec: 'none', height: 1080, fps: 60, protocol: 'https', http_headers: { 'User-Agent': 'v' } },
      { format_id: '140', url: 'https://a/1', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, protocol: 'https', http_headers: { 'User-Agent': 'a' } }
    ]
  };
  const result = ytdlp.normaliseInfo(info, 'https://youtube.com/watch?v=x', { maxHeight: 1080 });
  assert.equal(result.muxed, false);
  assert.equal(result.video.height, 1080);
  assert.equal(result.video.headers['User-Agent'], 'v');
  assert.equal(result.audio.headers['User-Agent'], 'a');
});

test('ytdlp: capability parsing reads the installed build, not a hardcoded list', () => {
  const help = `
    Usage: yt-dlp [OPTIONS] URL
      --no-playlist            Download only the video
      --cookies-from-browser BROWSER  Load cookies
      --extractor-args IE_KEY:ARGS    Pass ARGS; see "jsi" for JavaScript runtime selection
      --impersonate CLIENT
  `;
  const flags = ytdlp.parseFlags(help);
  assert.ok(flags.has('--cookies-from-browser'));
  assert.ok(flags.has('--extractor-args'));
  assert.equal(flags.has('--js-runtime'), false);

  assert.equal(ytdlp.parseVersionDate('2025.09.05').toISOString().slice(0, 10), '2025-09-05');
  assert.equal(ytdlp.parseVersionDate('not a version'), null);
});

test('js-runtime: Electron is offered as a Node runtime, with the env it needs', () => {
  // A path distinct from the Node running this test, so it is not deduped
  // against the copy already found on PATH.
  const fakeElectron = path.join(TMP, 'electron-stand-in.exe');
  fs.writeFileSync(fakeElectron, 'placeholder');

  const list = jsRuntime.candidates({
    userDataDir: path.join(TMP, 'userdata'),
    electronPath: fakeElectron
  });
  const electron = list.find((c) => c.source === 'electron');
  assert.ok(electron, 'Electron is offered as a possible Node runtime');
  assert.equal(electron.env.ELECTRON_RUN_AS_NODE, '1',
    'and carries the environment that makes it behave like one');
  assert.ok(list.every((c) => typeof c.path === 'string' && c.path.length),
    'every candidate has a concrete path');
  assert.ok(list.some((c) => c.source === 'path' && c.runtime === 'node'),
    'the Node on PATH is a candidate too');
});

test('js-runtime: a candidate is only accepted if it actually answers', async () => {
  // The real Node running this test must validate.
  const good = await jsRuntime.validate({ runtime: 'node', path: process.execPath, env: null });
  assert.equal(good.ok, true);
  assert.match(good.version, /^v?\d+\./);

  // A path that is not an executable must not be believed.
  const notARuntime = path.join(TMP, 'fake-node.txt');
  fs.writeFileSync(notARuntime, 'this is not a program');
  const bad = await jsRuntime.validate({ runtime: 'node', path: notARuntime, env: null });
  assert.equal(bad.ok, false);

  // Something that runs but answers wrongly is also rejected.
  const wrong = await jsRuntime.validate({ runtime: 'deno', path: process.execPath, env: null });
  assert.equal(wrong.ok, false, 'Node must not be accepted as Deno');
});

test('js-runtime: discovery returns validated runtimes in yt-dlp priority order', async () => {
  const found = await jsRuntime.discover({
    userDataDir: path.join(TMP, 'userdata'),
    electronPath: process.execPath,
    force: true
  });
  assert.ok(found.length >= 1, 'at least one runtime is available on a machine running this test');
  assert.ok(found.every((r) => r.ok && r.version), 'only validated runtimes are returned');
  for (let i = 1; i < found.length; i++) {
    const a = jsRuntime.RUNTIME_PRIORITY.indexOf(found[i - 1].runtime);
    const b = jsRuntime.RUNTIME_PRIORITY.indexOf(found[i].runtime);
    assert.ok(a <= b, 'ordered by yt-dlp priority');
  }
});

test('ytdlp: failures classify into actionable codes', () => {
  const cases = [
    ['ERROR: Sign in to confirm your age', 'AGE_RESTRICTED'],
    ['ERROR: Private video. Sign in if you have been granted access', 'AUTH_REQUIRED'],
    ['ERROR: Video unavailable. This video has been removed', 'VIDEO_UNAVAILABLE'],
    ['ERROR: The uploader has not made this video available in your country', 'REGION_RESTRICTED'],
    ['ERROR: Unsupported URL: https://example.com/', 'UNSUPPORTED_URL'],
    ['WARNING: nsig extraction failed: Some formats may be missing', 'JS_RUNTIME_REQUIRED'],
    ['ERROR: could not copy Chrome cookie database', 'COOKIE_FAILURE'],
    ['ERROR: Unable to download webpage: The read operation timed out', 'NETWORK_TIMEOUT'],
    ['ERROR: Requested format is not available', 'NO_PLAYABLE_FORMAT'],
    ['ERROR: something nobody has ever seen before', 'UNKNOWN']
  ];
  for (const [stderr, expected] of cases) {
    const err = Object.assign(new Error('yt-dlp failed'), { stderr });
    const classified = ytdlp.classifyError(err);
    assert.equal(classified.code, expected, `"${stderr}" should classify as ${expected}`);
    assert.ok(classified.userMessage && !classified.userMessage.includes('ERROR:'),
      'the user-facing message is not raw stderr');
  }
});

test('ytdlp: a cookie failure is not mistaken for an auth prompt', () => {
  const err = Object.assign(new Error('x'), {
    stderr: 'ERROR: could not find chrome cookies database; you may need to sign in'
  });
  assert.equal(ytdlp.classifyError(err).code, 'COOKIE_FAILURE');
});

test('ytdlp: the JS runtime error explains what is actually missing', () => {
  const err = Object.assign(new Error('x'), { stderr: 'nsig extraction failed' });
  const noFlag = ytdlp.classifyError(err, { capabilities: { jsRuntimeFlag: null, jsRuntimes: [] } });
  assert.match(noFlag.suggestedAction, /Update yt-dlp/);

  const noRuntime = ytdlp.classifyError(err, {
    capabilities: { jsRuntimeFlag: { flag: '--extractor-args' }, jsRuntimes: [] }
  });
  assert.match(noRuntime.suggestedAction, /Deno/);
});

test('ytdlp: stream expiry is read from the URL, not assumed', () => {
  const soon = Math.floor(Date.now() / 1000) + 60;
  assert.equal(ytdlp.expiryOf(`https://cdn/x?expire=${soon}`), soon * 1000);
  assert.equal(ytdlp.expiryOf('https://cdn/x'), null);

  assert.equal(ytdlp.isExpired({ resolvedAt: Date.now(), expiresAt: Date.now() + 30_000 }), true,
    'a URL about to expire is treated as expired');
  assert.equal(ytdlp.isExpired({ resolvedAt: Date.now(), expiresAt: Date.now() + 3_600_000 }), false);
  assert.equal(ytdlp.isExpired({ resolvedAt: Date.now() - 4 * 3600 * 1000, expiresAt: null }), true,
    'with no stated expiry, a stale session is not assumed to still work');
});

test('ytdlp: split streams keep their own headers', () => {
  const info = {
    title: 'Clip',
    webpage_url: 'https://example.com/w',
    duration: 100,
    http_headers: { 'User-Agent': 'base' },
    formats: [
      { format_id: '137', url: 'https://v.cdn/x', vcodec: 'avc1.64', acodec: 'none', height: 1080, protocol: 'https', http_headers: { 'User-Agent': 'video-ua', Origin: 'https://v.cdn' } },
      { format_id: '140', url: 'https://a.cdn/y', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, protocol: 'https', http_headers: { 'User-Agent': 'audio-ua' } },
      { format_id: '18', url: 'https://m.cdn/z', vcodec: 'avc1.42', acodec: 'mp4a.40.2', height: 360, protocol: 'https' }
    ]
  };
  const result = ytdlp.normaliseInfo(info, 'https://example.com/w', {});
  assert.equal(result.muxed, false, '1080p video-only beats 360p muxed');
  assert.equal(result.video.headers['User-Agent'], 'video-ua');
  assert.equal(result.audio.headers['User-Agent'], 'audio-ua');
  assert.equal(result.video.headers.Origin, 'https://v.cdn');
  assert.equal(result.audio.headers.Origin, undefined, 'audio does not inherit video-specific headers');
});

test('ytdlp: unplayable format sets produce a structured refusal', () => {
  assert.throws(
    () => ytdlp.normaliseInfo({ formats: [{ url: 'x', vcodec: 'theora', acodec: 'none' }] }, 'https://e/x', {}),
    (e) => e.code === 'NO_PLAYABLE_FORMAT'
  );
});

/* ================================================================== *
 * ffmpeg builders
 * ================================================================== */

test('filters: an untouched recipe still produces a valid graph', () => {
  const analysis = fakeAnalysis();
  const recipe = recipes.defaultRecipe(analysis, { output: { path: 'o.mp4' } });
  const geometry = recipes.resolveOutputGeometry(recipe, analysis);
  const { graph } = filters.buildVideoGraph(recipe, geometry, analysis);
  assert.match(graph, /\[0:v\]/);
  assert.match(graph, /\[vout\]$/);
  assert.match(graph, /format=yuv420p/);
});

test('filters: cleanup runs before scaling, debanding after grading', () => {
  const analysis = fakeAnalysis();
  const recipe = recipes.sanitize({
    output: { path: 'o.mp4' },
    restore: { enabled: true, denoise: 0.4, deband: 0.5 },
    color: { enabled: true, contrast: 0.3 },
    reconstruction: { enabled: true, targetResolution: { mode: 'custom', width: 3840, height: 2160 } }
  }).recipe;
  const geometry = recipes.resolveOutputGeometry(recipe, analysis);
  const { graph } = filters.buildVideoGraph(recipe, geometry, analysis);

  const denoise = graph.indexOf('hqdn3d');
  const scale = graph.indexOf('scale=3840');
  const eq = graph.indexOf('eq=');
  const deband = graph.indexOf('deband');
  assert.ok(denoise >= 0 && scale >= 0 && eq >= 0 && deband >= 0, graph);
  assert.ok(denoise < scale, 'noise must not be magnified by the upscale');
  assert.ok(eq < deband, 'debanding follows the grade that exposes the banding');
});

test('filters: a blurred-background canvas builds a real composite', () => {
  const analysis = fakeAnalysis();
  const recipe = recipes.sanitize({
    output: { path: 'o.mp4' },
    framing: { enabled: true, canvas: '9:16', width: 1080, height: 1920, mode: 'fit', background: 'blur' }
  }).recipe;
  const geometry = recipes.resolveOutputGeometry(recipe, analysis);
  const { graph, notes } = filters.buildVideoGraph(recipe, geometry, analysis);
  assert.match(graph, /split=2/);
  assert.match(graph, /gblur/);
  assert.match(graph, /overlay=/);
  assert.ok(notes.some((n) => /blurred/.test(n)));
});

test('filters: a missing filter degrades honestly instead of silently', () => {
  const analysis = fakeAnalysis({
    color: { isHDR: true, transfer: 'smpte2084', hdrFormat: 'PQ' },
    derived: { ...fakeAnalysis().derived, isHDR: true }
  });
  const recipe = recipes.sanitize({ output: { path: 'o.mp4' }, color: { toneMap: 'hable' } }).recipe;
  const geometry = recipes.resolveOutputGeometry(recipe, analysis);

  const withZscale = filters.buildVideoGraph(recipe, geometry, analysis, {
    availableFilters: new Set(['zscale', 'tonemap', 'format'])
  });
  assert.match(withZscale.graph, /tonemap=/);

  const withoutZscale = filters.buildVideoGraph(recipe, geometry, analysis, {
    availableFilters: new Set(['format'])
  });
  assert.equal(/tonemap=/.test(withoutZscale.graph), false);
  assert.ok(withoutZscale.notes.some((n) => /no zscale\/tonemap/.test(n)),
    'the user is told the tone map was skipped');
});

test('filters: frame-rate conversion says what it actually does', () => {
  const analysis = fakeAnalysis();
  const recipe = recipes.sanitize({
    output: { path: 'o.mp4', fps: 60 },
    motion: { enabled: true, targetFps: 60, interpolation: 'none' }
  }).recipe;
  const geometry = recipes.resolveOutputGeometry(recipe, analysis);
  const { graph, notes } = filters.buildVideoGraph(recipe, geometry, analysis);
  assert.match(graph, /fps=60/);
  assert.ok(notes.some((n) => /no new motion is invented/.test(n)));
});

test('command: split remote inputs get their own headers', () => {
  const analysis = fakeAnalysis();
  const recipe = recipes.sanitize({
    source: { type: 'remote', url: 'https://v.cdn/x' },
    output: { path: 'o.mp4' }
  }).recipe;
  const geometry = recipes.resolveOutputGeometry(recipe, analysis);
  const { args } = command.buildEncodeCommand({
    recipe,
    geometry,
    analysis,
    input: 'https://v.cdn/x',
    inputHeaders: { 'User-Agent': 'video-ua' },
    audioInput: 'https://a.cdn/y',
    audioHeaders: { 'User-Agent': 'audio-ua' },
    output: 'C:\\out.mp4',
    encoderId: 'libx264',
    sourceHasAudio: true
  });

  const headerArgs = args.filter((a, i) => args[i - 1] === '-headers');
  assert.equal(headerArgs.length, 2, 'one header blob per input');
  assert.match(headerArgs[0], /video-ua/);
  assert.match(headerArgs[1], /audio-ua/);
  assert.ok(args.includes('-shortest'), 'split streams are trimmed to the shorter of the two');
  assert.ok(args.includes('1:a:0'), 'audio is mapped from the second input');
});

test('command: trimming and chunk segments are mutually exclusive', () => {
  const analysis = fakeAnalysis();
  const recipe = recipes.sanitize({
    output: { path: 'o.mp4' },
    trim: { startSeconds: 10, endSeconds: 40 }
  }).recipe;
  const geometry = recipes.resolveOutputGeometry(recipe, analysis);

  const whole = command.buildEncodeCommand({
    recipe, geometry, analysis, input: 'in.mp4', output: 'o.mp4', encoderId: 'libx264'
  }).args;
  assert.equal(whole[whole.indexOf('-ss') + 1], '10');
  assert.equal(whole[whole.indexOf('-t') + 1], '30');

  const chunk = command.buildEncodeCommand({
    recipe, geometry, analysis, input: 'in.mp4', output: 'c.mp4', encoderId: 'libx264',
    segment: { startSeconds: 70, durationSeconds: 60 }, forConcat: true
  }).args;
  assert.equal(chunk[chunk.indexOf('-ss') + 1], '70');
  assert.equal(chunk[chunk.indexOf('-t') + 1], '60');
  assert.ok(chunk.includes('-avoid_negative_ts'));
  assert.equal(chunk.includes('+faststart'), false, 'chunks are not finalised for streaming');
});

test('command: audio can be dropped and copied', () => {
  const analysis = fakeAnalysis();
  const geometry = recipes.resolveOutputGeometry(
    recipes.defaultRecipe(analysis, { output: { path: 'o.mp4' } }), analysis);

  const silent = recipes.sanitize({ output: { path: 'o.mp4' }, audio: { enabled: false } }).recipe;
  const silentArgs = command.buildEncodeCommand({
    recipe: silent, geometry, analysis, input: 'in.mp4', output: 'o.mp4', encoderId: 'libx264'
  }).args;
  assert.ok(silentArgs.includes('-an'));

  const copied = recipes.sanitize({ output: { path: 'o.mp4' }, audio: { mode: 'copy' } }).recipe;
  const copiedArgs = command.buildEncodeCommand({
    recipe: copied, geometry, analysis, input: 'in.mp4', output: 'o.mp4', encoderId: 'libx264'
  }).args;
  assert.equal(copiedArgs[copiedArgs.indexOf('-c:a') + 1], 'copy');
});

test('encoders: selection prefers hardware but never invents one', () => {
  const available = [
    { id: 'libx264', codec: 'h264', hardware: false },
    { id: 'h264_nvenc', codec: 'h264', hardware: true }
  ];
  assert.equal(chooseId({ codec: 'h264', available }), 'h264_nvenc');
  assert.equal(chooseId({ codec: 'h264', available, hardware: 'cpu' }), 'libx264');
  assert.equal(chooseId({ codec: 'h264', available, requested: 'libx264' }), 'libx264');

  const missing = encoders.chooseEncoder({ codec: 'h264', available, requested: 'h264_qsv' });
  assert.equal(missing.id, 'libx264');
  assert.equal(missing.reason, 'requested-unavailable');

  // Nothing detected at all still yields a runnable command.
  assert.equal(chooseId({ codec: 'hevc', available: [] }), 'libx265');

  function chooseId(o) { return encoders.chooseEncoder(o).id; }
});

test('encoders: a build-supported encoder is not chosen for absent hardware', () => {
  // `ffmpeg -encoders` lists AMF on a machine with no AMD GPU in it.
  const available = [
    { id: 'libx264', codec: 'h264', vendor: 'cpu', hardware: false },
    { id: 'h264_amf', codec: 'h264', vendor: 'amd', hardware: true },
    { id: 'h264_qsv', codec: 'h264', vendor: 'intel', hardware: true }
  ];
  assert.equal(
    encoders.chooseEncoder({ codec: 'h264', available, gpuVendors: ['intel'] }).id,
    'h264_qsv',
    'the encoder is matched to a GPU that is actually present'
  );
  assert.equal(
    encoders.chooseEncoder({ codec: 'h264', available, gpuVendors: ['nvidia'] }).id,
    'libx264',
    'no matching hardware means CPU, not a wrong-vendor guess'
  );
  assert.equal(
    encoders.chooseEncoder({ codec: 'h264', available, gpuVendors: [] }).id,
    'h264_amf',
    'with no GPU information, catalogue order stands and failures fall back at runtime'
  );
});

test('encoders: quality maps onto each family\'s own knob', () => {
  assert.ok(encoders.encoderArgs('libx264', { quality: 100 }).includes('-crf'));
  assert.ok(encoders.encoderArgs('h264_nvenc', { quality: 50 }).includes('-cq'));
  assert.ok(encoders.encoderArgs('h264_qsv', { quality: 50 }).includes('-global_quality'));
  const bitrate = encoders.encoderArgs('libx264', { bitrateMode: 'bitrate', bitrateKbps: 8000, maxBitrateKbps: 12000 });
  assert.ok(bitrate.includes('-b:v'));
  assert.ok(bitrate.includes('-maxrate'));
});

/* ================================================================== *
 * Analyzer pure helpers
 * ================================================================== */

test('analyzer: rational frame rates and resolution classes', () => {
  assert.equal(analyzer.parseRational('30000/1001'), 29.97);
  assert.equal(analyzer.parseRational('0/0'), null);
  assert.equal(analyzer.parseRational(''), null);
  assert.equal(analyzer.resolutionClass(1920, 1080), '1080p');
  assert.equal(analyzer.resolutionClass(1080, 1920), '1080p', 'orientation does not change the class');
  assert.equal(analyzer.resolutionClass(3840, 2160), '4K');
  assert.equal(analyzer.resolutionClass(null, null), null);
});

test('analyzer: header blobs are CRLF joined or absent', () => {
  assert.equal(analyzer.headerBlob(null), null);
  assert.equal(analyzer.headerBlob({}), null);
  assert.equal(analyzer.headerBlob({ A: '1', B: '2' }), 'A: 1\r\nB: 2\r\n');
});

test('analyzer: rejects relative paths and missing files', async () => {
  await assert.rejects(
    () => analyzer.analyze('ffprobe', 'relative/path.mp4'),
    (e) => e.code === 'INVALID_REQUEST'
  );
  await assert.rejects(
    () => analyzer.analyze('ffprobe', path.join(TMP, 'nope.mp4')),
    (e) => e.code === 'SOURCE_NOT_FOUND'
  );
  await assert.rejects(
    () => analyzer.analyze(null, path.join(TMP, 'nope.mp4')),
    (e) => e.code === 'FFPROBE_MISSING'
  );
});
