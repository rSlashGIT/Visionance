/**
 * Source-switch lifecycle verification.
 *
 * Boots the real application and drives real source changes through the real
 * user-facing routes - the omnibar's Play button, and the "open this file"
 * event the shell sends. There is no test-only entry point into switchSource(),
 * because a path only tests can reach is not the path the user takes.
 *
 *   npx electron tools/verify-switch.js
 *
 * yt-dlp is replaced by a controllable stand-in that serves local clips over
 * the remote code path after a delay we choose. That makes the race the
 * lifecycle exists to prevent - a slow URL resolution completing after the
 * user has already chosen something else - deterministic rather than a matter
 * of catching the network on a bad day.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

process.argv.push('--dev-smoke');

const { app, BrowserWindow } = require('electron');

const REAL_USER_DATA = path.join(app.getPath('appData'), 'Visionance');
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'visionance-switch-'));
app.setName('Visionance');
app.setPath('userData', USER_DATA);
if (!process.env.VISIONANCE_BIN_DIR) {
  process.env.VISIONANCE_BIN_DIR = path.join(REAL_USER_DATA, 'bin');
}

/* ------------------------------------------------------------------ *
 * Test media
 * ------------------------------------------------------------------ */

const ffmpegPath = (() => {
  try { return require('ffmpeg-static'); } catch { return null; }
})();

const CLIPS = {};
function makeClips() {
  const { spawnSync } = require('child_process');
  const specs = [
    ['a', 'testsrc2=size=640x360:rate=30:duration=6', 'sine=frequency=440:duration=6'],
    ['b', 'smptebars=size=854x480:rate=25:duration=5', 'sine=frequency=880:duration=5'],
    ['c', 'testsrc=size=320x240:rate=24:duration=5', 'sine=frequency=220:duration=5'],
    ['d', 'testsrc2=size=1280x720:rate=30:duration=5', 'sine=frequency=330:duration=5']
  ];
  for (const [id, video, audio] of specs) {
    const out = path.join(USER_DATA, `clip-${id}.mp4`);
    const r = spawnSync(ffmpegPath, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', video,
      '-f', 'lavfi', '-i', audio,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out
    ], { encoding: 'utf8' });
    if (r.status !== 0 || !fs.existsSync(out)) {
      throw new Error(`could not build clip ${id}: ${r.stderr || r.error}`);
    }
    CLIPS[id] = out;
  }
}

/* ------------------------------------------------------------------ *
 * A yt-dlp stand-in with a controllable delay
 * ------------------------------------------------------------------ */

const ytdlp = require(path.join(__dirname, '..', 'src', 'main', 'ytdlp'));

/** url -> { clip, delayMs }. The harness rewrites this between steps. */
const FAKE_STREAMS = new Map();
const resolveLog = [];

ytdlp.resolveStream = async (bin, pageUrl, opts = {}) => {
  const key = [...FAKE_STREAMS.keys()].find((k) => pageUrl.includes(k));
  const spec = key ? FAKE_STREAMS.get(key) : null;
  if (!spec) {
    const err = new Error('no fake stream registered for ' + pageUrl);
    err.code = 'UNSUPPORTED_URL';
    throw err;
  }
  resolveLog.push({ pageUrl, at: Date.now(), maxHeight: opts.maxHeight, purpose: opts.purpose });
  if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));

  const url = pathToFileURL(spec.clip).toString();
  return {
    resolvedAt: Date.now(),
    expiresAt: null,
    pageUrl,
    webpageUrl: pageUrl,
    title: spec.title,
    uploader: 'harness',
    channelUrl: null,
    duration: 5,
    thumbnail: null,
    description: null,
    isLive: false,
    liveStatus: null,
    extractor: 'harness',
    ageLimit: 0,
    muxed: true,
    video: {
      url, codecsKnown: true, formatId: 'fake', ext: 'mp4',
      height: spec.height, width: spec.width, fps: 30,
      vcodec: 'avc1.640028', acodec: 'mp4a.40.2', abr: 128, tbr: 2000,
      protocol: 'https', filesize: null, language: null, headers: {}, expiresAt: null
    },
    audio: null,
    formatNotes: [],
    selection: {
      purpose: opts.purpose || 'quality', capHeight: opts.maxHeight || null,
      videoFormatId: 'fake', audioFormatId: null, height: spec.height,
      fps: 30, vcodec: 'avc1.640028', acodec: 'mp4a.40.2',
      videoKbps: 2000, audioKbps: 128, split: false, hardwareCodecRank: 4
    },
    available: [{ height: spec.height, fps: 30, ext: 'mp4', vcodec: 'avc1', formatId: 'fake' }],
    warnings: [],
    usedAuth: 'none'
  };
};

/* ------------------------------------------------------------------ *
 * A save dialog that answers without a human
 *
 * The Create panel's only way to start a render is the real destination
 * picker, and a render started any other way would not be testing the path
 * the user takes. So the picker is answered, not bypassed.
 * ------------------------------------------------------------------ */

const electron = require('electron');
const RENDER_OUT = path.join(USER_DATA, 'reframe-out.mp4');
electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: RENDER_OUT });

require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

/* ------------------------------------------------------------------ *
 * Driving the renderer
 * ------------------------------------------------------------------ */

let win = null;
const results = [];
const pageErrors = [];

function check(label, pass, detail = '') {
  results.push({ label, pass: !!pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

const js = (code) => win.webContents.executeJavaScript(code, true);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn()` returns truthy or the deadline passes. */
async function waitFor(label, code, timeoutMs = 12000, every = 120) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await js(code);
    if (last) return last;
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

/** What is on screen right now, from the app's own diagnostics. */
const SNAP = `(() => {
  const d = window.visionanceDiagnostics;
  const v = document.getElementById('video');
  const s = d ? d.source() : {};
  return {
    key: s.key || null,
    generation: s.generation,
    pendingKey: s.pendingKey || null,
    token: s.token || null,
    engineRunning: !!s.engineRunning,
    presentation: s.presentation || null,
    width: v.videoWidth, height: v.videoHeight,
    readyState: v.readyState, paused: v.paused,
    currentTime: v.currentTime,
    currentSrc: (v.currentSrc || '').slice(0, 90),
    title: document.getElementById('brandSub').textContent,
    urlBox: document.getElementById('urlInput').value,
    errorCode: v.error ? v.error.code : null
  };
})()`;

/** The real Play button, exactly as a user drives it. */
const playUrl = (url) => js(`(() => {
  const box = document.getElementById('urlInput');
  box.value = ${JSON.stringify(url)};
  document.getElementById('goBtn').click();
  return true;
})()`);

/** The real "open this file" route the shell and the file picker both use. */
function openFile(clip) {
  win.webContents.send('open-external-file', clip);
}

/** Loaded and decoding, whichever source it is. */
const loadedAt = (w, h) =>
  `(() => { const v = document.getElementById('video');
    return v.videoWidth === ${w} && v.videoHeight === ${h} && v.readyState >= 2; })()`;

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

async function run() {
  console.log('\nVisionance source-switch verification\n');

  FAKE_STREAMS.set('vid-c', { clip: CLIPS.c, title: 'Stream C', width: 320, height: 240, delayMs: 150 });
  FAKE_STREAMS.set('vid-d', { clip: CLIPS.d, title: 'Stream D', width: 1280, height: 720, delayMs: 150 });
  FAKE_STREAMS.set('vid-slow', { clip: CLIPS.c, title: 'Slow stream', width: 320, height: 240, delayMs: 3000 });

  /* ---- fresh -> local ---- */
  openFile(CLIPS.a);
  await waitFor('fresh -> local', loadedAt(640, 360));
  let s = await js(SNAP);
  check('fresh -> local loads and decodes', s.width === 640 && s.height === 360, `${s.width}x${s.height}`);
  check('fresh -> local autoplays', !s.paused);
  check('opening a file clears the URL box', s.urlBox === '', `box="${s.urlBox}"`);

  /* ---- local A -> local B, while playing ---- */
  openFile(CLIPS.b);
  await waitFor('local A -> local B', loadedAt(854, 480));
  s = await js(SNAP);
  check('local A -> local B while playing', s.width === 854 && s.height === 480, `${s.width}x${s.height}`);
  check('the switch took a new generation', s.generation >= 2, `gen ${s.generation}`);

  /* ---- local -> URL, the reported defect ---- */
  await playUrl('https://example.com/vid-c');
  await waitFor('local -> URL', loadedAt(320, 240));
  s = await js(SNAP);
  check('local -> URL via the Play button replaces the local file',
    s.width === 320 && s.height === 240, `${s.width}x${s.height}`);
  check('local -> URL goes through the remote proxy',
    /src=remote/.test(s.currentSrc), s.currentSrc);
  check('local -> URL holds a stream session', !!s.token);
  check('local -> URL plays without waiting for another click', !s.paused);

  /* ---- URL -> local ---- */
  openFile(CLIPS.a);
  await waitFor('URL -> local', loadedAt(640, 360));
  s = await js(SNAP);
  check('URL -> local switches back', s.width === 640 && s.height === 360, `${s.width}x${s.height}`);
  check('URL -> local releases the stream session', !s.token, `token ${s.token}`);
  check('URL -> local uses the local media path', /src=local/.test(s.currentSrc), s.currentSrc);

  /* ---- URL A -> URL B ---- */
  await playUrl('https://example.com/vid-c');
  await waitFor('URL A', loadedAt(320, 240));
  const tokenA = (await js(SNAP)).token;
  await playUrl('https://example.com/vid-d');
  await waitFor('URL A -> URL B', loadedAt(1280, 720));
  s = await js(SNAP);
  check('URL A -> URL B switches', s.width === 1280 && s.height === 720, `${s.width}x${s.height}`);
  check('URL A -> URL B takes a fresh session', !!s.token && s.token !== tokenA);

  /* ---- switching while paused ---- */
  await js(`document.getElementById('video').pause(); true`);
  await sleep(150);
  openFile(CLIPS.b);
  await waitFor('paused -> local', loadedAt(854, 480));
  s = await js(SNAP);
  check('switching while paused still loads the new source', s.width === 854, `${s.width}x${s.height}`);

  /* ---- the race: a slow resolution must never win ---- */
  const beforeRace = (await js(SNAP)).generation;
  await playUrl('https://example.com/vid-slow');   // 3 s of resolution ahead of it
  await sleep(300);                                 // ...and the user changes their mind
  openFile(CLIPS.a);
  await waitFor('race: local wins', loadedAt(640, 360));
  const midRace = await js(SNAP);
  check('a slow URL resolution does not delay the local file',
    midRace.width === 640 && midRace.height === 360, `${midRace.width}x${midRace.height}`);

  // Now let the abandoned resolution finish and prove it writes nothing.
  await sleep(3600);
  s = await js(SNAP);
  check('the late URL resolution never replaces the newer local file',
    s.width === 640 && s.height === 360, `${s.width}x${s.height} src=${s.currentSrc}`);
  check('the late resolution leaves no stream session behind', !s.token, `token ${s.token}`);
  check('the late resolution does not steal the URL box',
    s.urlBox === '', `box="${s.urlBox}"`);
  check('the race advanced the generation past the loser', s.generation > beforeRace + 1);

  /* ---- the reverse race: URL A slow, URL B fast ---- */
  await playUrl('https://example.com/vid-slow');
  await sleep(200);
  await playUrl('https://example.com/vid-d');
  await waitFor('race: newer URL wins', loadedAt(1280, 720));
  await sleep(3400);
  s = await js(SNAP);
  check('a newer URL is not overwritten by an older slow one',
    s.width === 1280 && s.height === 720, `${s.width}x${s.height}`);

  /* ---- Play button semantics ---- */
  openFile(CLIPS.b);
  await waitFor('local before Play semantics', loadedAt(854, 480));
  await js(`document.getElementById('video').pause(); true`);
  await sleep(120);
  // A URL in the box that is *not* what is playing: Play must load it, not
  // resume the local file underneath.
  await playUrl('https://example.com/vid-c');
  await waitFor('Play loads the entered URL', loadedAt(320, 240));
  s = await js(SNAP);
  check('Play with a different URL in the box loads that URL',
    s.width === 320 && s.height === 240, `${s.width}x${s.height}`);
  check('Play with a different URL does not resume the old source', !s.paused);

  // The same URL again is an ordinary play/pause, not a reload.
  const srcBefore = s.currentSrc;
  const tokenBefore = s.token;
  await playUrl('https://example.com/vid-c');
  await sleep(600);
  s = await js(SNAP);
  check('Play on the source already loaded toggles instead of reloading',
    s.currentSrc === srcBefore && s.token === tokenBefore, s.currentSrc);
  check('...and that toggle actually paused it', s.paused);

  // Trivial URL differences must not count as a new source.
  await playUrl('https://www.example.com/vid-c/');
  await sleep(600);
  s = await js(SNAP);
  check('a trivially different spelling of the same URL is not a reload',
    s.token === tokenBefore, `token ${s.token} vs ${tokenBefore}`);

  /* ---- the native path survives all of this ----
   *
   * The default preset depends on what was last saved, so drive the toggle to
   * a known state rather than assuming one. */
  const setEnhancement = async (want) => {
    for (let i = 0; i < 2; i++) {
      const now = await js(`!!(window.visionanceDiagnostics.snapshot().enhancement)`);
      if (now === want) break;
      await js(`document.getElementById('enhanceToggle').click(); true`);
      await sleep(400);
    }
    await sleep(300);
  };

  await setEnhancement(false);
  s = await js(SNAP);
  check('enhancement off keeps the native path', s.presentation === 'native', s.presentation);
  check('enhancement off leaves the WebGL loop stopped', s.engineRunning === false);

  openFile(CLIPS.a);
  await waitFor('switch with enhancement off', loadedAt(640, 360));
  await sleep(500);
  s = await js(SNAP);
  check('a source switch with enhancement off stays native',
    s.presentation === 'native' && s.engineRunning === false,
    `${s.presentation}/${s.engineRunning}`);

  await setEnhancement(true);
  s = await js(SNAP);
  check('enhancement on runs the engine', s.engineRunning === true);
  check('enhancement on uses the enhanced path', s.presentation === 'enhanced', s.presentation);

  openFile(CLIPS.b);
  await waitFor('switch with enhancement on', loadedAt(854, 480));
  await sleep(600);
  s = await js(SNAP);
  check('switching with enhancement on still loads', s.width === 854, `${s.width}x${s.height}`);
  check('a source switch with enhancement on restarts the engine',
    s.presentation === 'enhanced' && s.engineRunning === true,
    `${s.presentation}/${s.engineRunning}`);

  await setEnhancement(false);
  openFile(CLIPS.a);
  await waitFor('switch back with enhancement off', loadedAt(640, 360));
  await sleep(500);
  s = await js(SNAP);
  check('turning enhancement back off restores the native path',
    s.presentation === 'native' && s.engineRunning === false,
    `${s.presentation}/${s.engineRunning}`);

  /* ------------------------------------------------------------------ *
   * Smart Reframe through the real Create panel
   *
   * Not a unit test of tracking.js: the control is set the way a user sets
   * it, Auto is asked for its opinion the way a user asks, and the render is
   * started with the button that starts renders.
   * ------------------------------------------------------------------ */

  openFile(CLIPS.d);                       // 1280x720, landscape
  await waitFor('create source', loadedAt(1280, 720));

  await js(`document.querySelector('.tab[data-tab="create"]').click(); true`);
  await sleep(200);
  await js(`(() => {
    const p = document.getElementById('createPlatform');
    p.value = 'youtube-shorts';
    p.dispatchEvent(new Event('change'));
    return true;
  })()`);
  await sleep(200);

  const framingVisible = await js(
    `!document.getElementById('createFramingRow').hidden`);
  check('a 9:16 target reveals the reframing control', framingVisible);

  const options = await js(
    `[...document.getElementById('createFraming').options].map(o => o.value)`);
  check('the control offers Smart Reframe', options.includes('smart'), options.join(','));

  // Analyse, then let Auto choose.
  await js(`document.getElementById('analyseBtn').click(); true`);
  await waitFor('analysis', `!!(window.visionanceDiagnostics && document.getElementById('autoBuildBtn') &&
    !document.getElementById('autoBuildBtn').disabled)`, 30000);
  await js(`document.getElementById('autoBuildBtn').click(); true`);
  await waitFor('auto', `/Smart Reframe|reframe/i.test(document.getElementById('autoExplain').textContent || '') ||
    document.getElementById('autoState').textContent.includes('suggested')`, 30000);

  let create = await js(`({
    framing: document.getElementById('createFraming').value,
    autoState: document.getElementById('autoState').textContent,
    explain: (document.getElementById('autoExplain').textContent || '').slice(0, 400)
  })`);
  check('Auto announcing Smart Reframe leaves the control showing Smart Reframe',
    create.framing === 'smart', `control="${create.framing}"`);
  check('...and the explanation says so in the same words',
    /Smart Reframe/i.test(create.explain), create.explain.slice(0, 120));

  // Changing the control by hand must move the recipe and mark Auto edited.
  await js(`(() => {
    const f = document.getElementById('createFraming');
    f.value = 'fill';
    f.dispatchEvent(new Event('change'));
    return true;
  })()`);
  await sleep(200);
  create = await js(`({
    framing: document.getElementById('createFraming').value,
    autoState: document.getElementById('autoState').textContent
  })`);
  check('choosing Centre crop marks the Auto result as edited',
    /edited/i.test(create.autoState), create.autoState);
  check('...and the control holds the choice', create.framing === 'fill');

  // Back to Smart Reframe, then render for real.
  await js(`(() => {
    const f = document.getElementById('createFraming');
    f.value = 'smart';
    f.dispatchEvent(new Event('change'));
    return true;
  })()`);
  await sleep(200);

  await js(`document.getElementById('startCreateBtn').click(); true`);
  const job = await waitFor('render', `(async () => {
    const r = await window.visionance.jobs.list();
    if (!r.ok || !r.jobs.length) return null;
    const j = r.jobs[r.jobs.length - 1];
    if (j.status === 'completed' || j.status === 'failed') return j;
    return null;
  })()`, 150000, 1000);

  check('a Smart Reframe render started from the panel completes',
    job.status === 'completed',
    job.status + (job.error ? ` — ${job.error.message}` : ''));
  check('the render executed REFRAME rather than skipping it',
    !!job.reframe, JSON.stringify(job.reframe || null));
  if (job.reframe) {
    check('the job records the saliency backend by name',
      /saliency/i.test(job.reframe.backend || '') || /saliency|motion/i.test(job.reframe.backendLabel || ''),
      `${job.reframe.backend} / ${job.reframe.backendLabel}`);
    check('the job records a confidence the panel can show',
      typeof job.reframe.confidence === 'number', String(job.reframe.confidence));
    check('the tracker took real samples', (job.reframe.samples || 0) > 0,
      `${job.reframe.samples} samples`);
  }
  check('the render was verified before being called complete',
    !!(job.verification && job.verification.ok),
    JSON.stringify(job.verification && job.verification.failures || null));
  // Measure the file itself rather than trusting the job record.
  let geometry = 'missing';
  let audioStreams = 0;
  let outDuration = 0;
  if (fs.existsSync(RENDER_OUT)) {
    check('the render produced a file on disk', fs.statSync(RENDER_OUT).size > 10000,
      `${fs.statSync(RENDER_OUT).size} bytes`);
    const ffprobe = require('ffprobe-static').path;
    const probe = require('child_process').spawnSync(ffprobe, [
      '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', RENDER_OUT
    ], { encoding: 'utf8' });
    try {
      const info = JSON.parse(probe.stdout);
      const v = info.streams.find((st) => st.codec_type === 'video');
      audioStreams = info.streams.filter((st) => st.codec_type === 'audio').length;
      outDuration = Number(info.format.duration) || 0;
      if (v) geometry = `${v.width}x${v.height}`;
    } catch { /* reported by the assertions below */ }
  } else {
    check('the render produced a file on disk', false, 'missing');
  }
  check('the output is 9:16', geometry === '1080x1920', geometry);
  check('the output kept its audio', audioStreams === 1, `${audioStreams} audio streams`);
  check('the output duration matches the source', Math.abs(outDuration - 5) < 0.6,
    `${outDuration.toFixed(2)}s vs 5s source`);

  const reframeShown = await js(`(() => {
    const cards = [...document.querySelectorAll('.job .job-plan')].map(n => n.textContent);
    return cards.join(' | ');
  })()`);
  check('the Queue card shows the backend and confidence',
    /saliency|motion/i.test(reframeShown) && /confidence/i.test(reframeShown),
    reframeShown.slice(0, 160));

  /* ---- repeated switching must not leak ---- */
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 6; i++) {
    openFile(i % 2 ? CLIPS.a : CLIPS.b);
    await waitFor(`churn ${i}`, loadedAt(...(i % 2 ? [640, 360] : [854, 480])), 8000);
  }
  await playUrl('https://example.com/vid-c');
  await waitFor('churn url', loadedAt(320, 240));
  openFile(CLIPS.a);
  await waitFor('churn back', loadedAt(640, 360));
  s = await js(SNAP);
  const after = process.memoryUsage().heapUsed;
  check('repeated switching leaves exactly one source loaded',
    s.width === 640 && !s.token && s.pendingKey === null,
    `token=${s.token} pending=${s.pendingKey}`);
  check('repeated switching does not report a media error', s.errorCode === null, `code ${s.errorCode}`);
  check('no renderer errors during any switch', pageErrors.length === 0, pageErrors.join(' | '));
  console.log(`\n  main-process heap ${(before / 1e6).toFixed(1)}MB -> ${(after / 1e6).toFixed(1)}MB`);
  console.log(`  resolutions attempted: ${resolveLog.length}`);
  console.log(`  stream policy asked for: ${[...new Set(resolveLog.map((r) => r.maxHeight + 'p'))].join(', ')}`);
  console.log(`  selection purpose: ${[...new Set(resolveLog.map((r) => r.purpose))].join(', ')}`);
}

app.whenReady().then(async () => {
  try {
    makeClips();
  } catch (err) {
    console.log('SKIPPED — could not build test clips: ' + err.message);
    app.exit(0);
    return;
  }

  const deadline = setTimeout(() => {
    console.log('\nFAIL — harness timed out');
    app.exit(1);
  }, 180000);

  await new Promise((resolve) => {
    const tick = setInterval(() => {
      const all = BrowserWindow.getAllWindows();
      if (all.length) { win = all[0]; clearInterval(tick); resolve(); }
    }, 100);
  });

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !/DevTools|Autofill|GPU stall/i.test(message)) pageErrors.push(message);
  });
  win.webContents.on('render-process-gone', (_e, d) => pageErrors.push('renderer gone: ' + d.reason));

  await new Promise((resolve) => {
    if (!win.webContents.isLoading()) return resolve();
    win.webContents.once('did-finish-load', resolve);
  });
  await sleep(1200);

  let ok = true;
  try {
    await run();
  } catch (err) {
    ok = false;
    console.log(`\n  FAIL — ${err.message}`);
  }
  clearTimeout(deadline);

  const failed = results.filter((r) => !r.pass);
  ok = ok && failed.length === 0;
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
  console.log(`\n${ok ? 'PASS' : 'FAIL'}`);
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch { /* best effort */ }
  app.exit(ok ? 0 : 1);
});
