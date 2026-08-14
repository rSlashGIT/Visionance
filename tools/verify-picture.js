'use strict';

/**
 * Visionance picture verification.
 *
 * The one thing every other harness took on trust: that a loaded video is
 * actually *visible*. Metadata can populate, the timeline can advance, the
 * inspector can say "Enhancing", and the viewer can still be black — that was
 * a real shipped defect, and no assertion anywhere caught it, because they all
 * checked state rather than pixels.
 *
 * So this one samples the picture. For native playback it draws the media
 * element into a 2D canvas; for the enhanced path it asks the engine for its
 * own snapshot, which is the same readback the Save Frame button uses. Two
 * samples at separated playback positions, and the assertions are that the
 * frame is not blank and that it changed.
 *
 *   npx electron tools/verify-picture.js
 *
 * Exits non-zero on any failed assertion.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const CLIP_DIR = path.join(os.tmpdir(), 'visionance-picture-verify');
const SHOT_DIR = path.join(__dirname, 'ui-shots');

if (!process.env.VISIONANCE_ENGINES_DIR) {
  const real = path.join(app.getPath('appData'), 'Visionance');
  process.env.VISIONANCE_ENGINES_DIR = path.join(real, 'engines');
}

require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

const results = [];
const pageErrors = [];
let win = null;

function check(label, pass, detail = '') {
  results.push({ label, pass: !!pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}
function note(line) { console.log(`       ${line}`); }

const js = (code) => win.webContents.executeJavaScript(code, true);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, code, timeoutMs = 30000, every = 150) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await js(code);
    if (last) return last;
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

/** A clip with strong, moving, non-black content so a frame sample is decisive. */
function makeClip(name, seconds) {
  fs.mkdirSync(CLIP_DIR, { recursive: true });
  const clip = path.join(CLIP_DIR, name);
  if (fs.existsSync(clip)) return clip;
  const ffmpeg = require(path.join(__dirname, '..', 'src', 'main', 'binaries')).resolve('ffmpeg');
  if (!ffmpeg) return null;
  const res = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30',
    '-c:a', 'aac', '-shortest', '-movflags', '+faststart', clip
  ], { windowsHide: true });
  return res.status === 0 && fs.existsSync(clip) ? clip : null;
}

/*
 * Frame sampling, in the page.
 *
 * `native` draws the media element itself. `enhanced` goes through the
 * engine's snapshot, because the WebGL context runs with
 * preserveDrawingBuffer:false — drawImage against it after compositing would
 * read an empty buffer and this harness would report black for a picture that
 * is on screen.
 *
 * The digest is a coarse 8x8 luma grid plus a mean. Two of them differ when
 * the picture moved; a mean near zero with no spread is a black frame.
 */
const SAMPLER = `
window.__vsSample = async function (which) {
  const size = 8;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true });

  if (which === 'native') {
    const v = document.getElementById('video');
    if (!v.videoWidth) return { ok: false, reason: 'no video dimensions' };
    ctx.drawImage(v, 0, 0, size, size);
  } else {
    const blob = await window.visionanceDiagnostics.frame();
    if (!blob) return { ok: false, reason: 'engine returned no frame' };
    const bmp = await createImageBitmap(blob);
    ctx.drawImage(bmp, 0, 0, size, size);
    bmp.close();
  }

  const data = ctx.getImageData(0, 0, size, size).data;
  const luma = [];
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    luma.push(Math.round(y));
    sum += y;
  }
  const mean = sum / luma.length;
  let spread = 0;
  for (const y of luma) spread += Math.abs(y - mean);
  return { ok: true, mean: +mean.toFixed(2), spread: +(spread / luma.length).toFixed(2),
           digest: luma.join(',') };
};
true;
`;

/**
 * How far two digests differ.
 *
 * The peak cell delta rather than the mean: a picture whose motion is local —
 * a moving object over a steady background — barely moves the frame-wide mean,
 * which made a genuinely playing video look static. A frozen or black frame
 * has a peak of exactly zero either way, which is the case this exists to
 * catch, so the sharper metric loses nothing.
 */
function frameDelta(a, b) {
  const x = a.digest.split(',').map(Number);
  const y = b.digest.split(',').map(Number);
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    const d = Math.abs(x[i] - y[i]);
    if (d > peak) peak = d;
    sum += d;
  }
  return { peak, mean: +(sum / x.length).toFixed(2) };
}

const PROBE = `(() => {
  const v = document.getElementById('video');
  const c = document.getElementById('glCanvas');
  const d = window.visionanceDiagnostics.source();
  const vs = getComputedStyle(v);
  const cs = getComputedStyle(c);
  return {
    readyState: v.readyState,
    w: v.videoWidth, h: v.videoHeight,
    paused: v.paused, time: +v.currentTime.toFixed(2),
    error: v.error ? v.error.code : null,
    presentation: d.presentation,
    engineRunning: d.engineRunning,
    nativeClass: document.getElementById('stageInner').classList.contains('native'),
    videoDisplay: vs.display, videoOpacity: vs.opacity,
    videoBox: Math.round(v.getBoundingClientRect().width) + 'x' + Math.round(v.getBoundingClientRect().height),
    canvasDisplay: cs.display,
    canvasSize: c.width + 'x' + c.height,
    canvasBox: Math.round(c.getBoundingClientRect().width) + 'x' + Math.round(c.getBoundingClientRect().height),
    stageEmptyHidden: document.getElementById('stageEmpty').hidden
  };
})()`;

async function setEnhancement(want) {
  for (let i = 0; i < 3; i++) {
    const on = await js('!!(window.visionanceDiagnostics.snapshot().enhancement)');
    if (on === want) break;
    await js(`document.getElementById('enhanceToggle').click(); true`);
    await sleep(400);
  }
  await sleep(600);
}

/**
 * One presentation case, end to end: report the diagnostic fields, then prove
 * the picture is there and moving.
 */
async function pictureCase(label, mode) {
  await js(`document.getElementById('video').play().catch(() => {}); true`);
  await sleep(900);

  const probe = await js(PROBE);
  note(`${label}: ${JSON.stringify(probe)}`);

  const a = await js(`window.__vsSample(${JSON.stringify(mode)})`);
  await sleep(1400);
  const b = await js(`window.__vsSample(${JSON.stringify(mode)})`);

  if (!a.ok || !b.ok) {
    check(`${label}: a frame could be sampled at all`, false, (a.reason || b.reason));
    return probe;
  }

  const delta = frameDelta(a, b);
  note(`${label}: mean ${a.mean} -> ${b.mean}, spread ${a.spread}/${b.spread}, ` +
    `delta peak ${delta.peak} mean ${delta.mean}`);

  check(`${label}: the picture is not black`,
    a.mean > 6 && a.spread > 3,
    `mean ${a.mean}, spread ${a.spread}`);
  check(`${label}: the picture changes as playback advances`,
    delta.peak > 6,
    `peak cell delta ${delta.peak} (mean ${delta.mean}) at ${probe.time.toFixed(1)}s`);
  return probe;
}

async function run() {
  console.log('\nVisionance picture verification\n');

  await waitFor('boot', 'window.__visionanceReady || window.__visionanceBootError', 60000);
  const bootError = await js('window.__visionanceBootError || null');
  check('the renderer booted without throwing', !bootError, bootError || '');
  await js(SAMPLER);

  const clip = makeClip('picture-clip.mp4', 30);
  if (!clip) {
    check('a local test clip could be built', false, 'ffmpeg unavailable');
    return;
  }

  /* ------------------------------------------------------------------ *
   * A loaded source must be visible on the very first load, from the
   * workspace the app opens on, without any tab being visited first.
   * ------------------------------------------------------------------ */

  const openedOn = await js('document.body.dataset.workspace');
  win.webContents.send('open-external-file', clip);
  await waitFor('clip decoding',
    `(() => { const v = document.getElementById('video');
      return v.videoWidth === 640 && v.readyState >= 2; })()`, 40000);
  await sleep(1500);

  const onLoad = await js(PROBE);
  note(`first load (opened on ${openedOn}): ${JSON.stringify(onLoad)}`);
  // The app opens on Create, which shows its own preview rather than Watch's
  // viewer, so what has to be true here is that the source was taken up at all
  // and the empty state stood down. Watch's own presentation is asserted the
  // moment we arrive there, below — without a detour through a third
  // workspace, which is the regression this guards.
  check('opening a source is taken up without a tab switch',
    onLoad.stageEmptyHidden && onLoad.readyState >= 2 && onLoad.w > 0,
    JSON.stringify({ empty: onLoad.stageEmptyHidden, ready: onLoad.readyState,
      w: onLoad.w, workspace: openedOn }));

  // The player is on Watch; go there so the viewer is composited.
  await js(`document.querySelector('.tab[data-tab="presets"]').click(); true`);
  await sleep(700);
  const onArrival = await js(PROBE);
  check('arriving on Watch presents the picture immediately',
    onArrival.presentation === 'native'
      ? onArrival.canvasDisplay === 'none' && onArrival.videoOpacity === '1'
      : onArrival.canvasDisplay !== 'none' && onArrival.engineRunning === true,
    JSON.stringify({ presentation: onArrival.presentation,
      canvas: onArrival.canvasDisplay, engine: onArrival.engineRunning }));

  /* ---- A. local, enhancement OFF ---- */

  await setEnhancement(false);
  const off = await pictureCase('local / enhancement off', 'native');
  check('enhancement off shows the native element and hides the canvas',
    off.presentation === 'native' && off.nativeClass &&
    off.videoOpacity === '1' && off.videoDisplay !== 'none' &&
    off.canvasDisplay === 'none' && off.engineRunning === false,
    JSON.stringify({ mode: off.presentation, video: off.videoDisplay,
      opacity: off.videoOpacity, canvas: off.canvasDisplay, engine: off.engineRunning }));

  /* ---- B. local, enhancement ON ---- */

  await setEnhancement(true);
  const on = await pictureCase('local / enhancement on', 'enhanced');
  check('enhancement on runs the engine and shows a sized canvas',
    on.presentation === 'enhanced' && !on.nativeClass &&
    on.canvasDisplay !== 'none' && on.engineRunning === true &&
    /^[1-9]/.test(on.canvasSize) && /^[1-9]/.test(on.canvasBox),
    JSON.stringify({ mode: on.presentation, canvas: on.canvasDisplay,
      size: on.canvasSize, box: on.canvasBox, engine: on.engineRunning }));

  /* ---- the engine is genuinely consuming frames ---- */

  const pumped = await js(`(async () => {
    const before = window.visionanceDiagnostics.snapshot();
    await new Promise((r) => setTimeout(r, 1500));
    const after = window.visionanceDiagnostics.snapshot();
    return {
      beforeFrames: before.playback ? before.playback.presentedFrames : null,
      afterFrames: after.playback ? after.playback.presentedFrames : null,
      fps: after.playback ? after.playback.presentedFps : null
    };
  })()`);
  check('the enhanced path is presenting frames, not idling',
    pumped.afterFrames === null || pumped.afterFrames > pumped.beforeFrames,
    JSON.stringify(pumped));

  /* ---- C. toggling back and forth keeps working ---- */

  await setEnhancement(false);
  await pictureCase('local / back to off', 'native');
  await setEnhancement(true);
  await pictureCase('local / back to on', 'enhanced');

  /* ---- D. a second source, still visible ---- */

  const clip2 = makeClip('picture-clip-2.mp4', 20);
  if (clip2) {
    win.webContents.send('open-external-file', clip2);
    await waitFor('second clip decoding',
      `(() => { const v = document.getElementById('video');
        return v.videoWidth === 640 && v.readyState >= 2 && v.currentTime < 5; })()`, 40000);
    await sleep(1500);
    await pictureCase('second source / enhancement on', 'enhanced');
  }

  /* ------------------------------------------------------------------ *
   * A split stream whose audio leg dies.
   *
   * This is the shipped defect, reproduced deterministically instead of
   * waiting for the site to 403 again: a healthy video leg, an audio element
   * pointed at a source that cannot open, and the dual-stream coupling live.
   * Before the fix the video element sat at `seeking: true` for ever and the
   * viewer went black with a fully populated inspector.
   * ------------------------------------------------------------------ */

  await setEnhancement(false);
  await js(`document.getElementById('video').play().catch(() => {}); true`);
  await sleep(800);

  const broke = await js(`(() => {
    const a = document.getElementById('audio');
    // Force the arrangement a split stream produces, then kill the audio leg
    // exactly as an upstream refusal does.
    window.__vsBeforeRecovery = document.getElementById('video').currentTime;
    a.src = 'vs://app/__media?src=remote&t=st_no_such_session&s=audio';
    a.load();
    return true;
  })()`);
  void broke;
  // The recovery detaches the element, and `load()` clears `error` as it goes,
  // so the observable outcome is the detach rather than a lingering error code.
  await waitFor('the audio leg was recovered',
    `document.getElementById('audio').getAttribute('src') === null`, 20000);
  await sleep(2500);

  const recovered = await js(`(() => {
    const v = document.getElementById('video');
    const a = document.getElementById('audio');
    return { seeking: v.seeking, paused: v.paused, ready: v.readyState,
             time: +v.currentTime.toFixed(2), err: v.error ? v.error.code : null,
             audioErr: a.error ? a.error.code : null,
             audioSrc: a.getAttribute('src') };
  })()`);
  check('a dead audio leg does not leave the video stuck seeking',
    !recovered.seeking && recovered.err === null && recovered.ready >= 2,
    JSON.stringify(recovered));
  check('the failed audio element is detached rather than left errored in place',
    recovered.audioSrc === null && recovered.audioErr === null,
    JSON.stringify({ src: recovered.audioSrc, err: recovered.audioErr }));

  await pictureCase('audio leg dead / picture recovered', 'native');

  /* ---- an online fixture, when one is configured ---- */

  const url = process.env.VISIONANCE_TEST_URL;
  if (url) {
    await js(`(() => {
      const box = document.getElementById('urlInput');
      box.value = ${JSON.stringify(url)};
      document.getElementById('goBtn').click();
      return true;
    })()`);
    try {
      await waitFor('online source decoding',
        `(() => { const v = document.getElementById('video');
          return v.videoWidth > 0 && v.readyState >= 2; })()`, 90000);
      await sleep(2500);
      await setEnhancement(false);
      await pictureCase('online / enhancement off', 'native');
      await setEnhancement(true);
      await pictureCase('online / enhancement on', 'enhanced');
    } catch (err) {
      check('the online fixture resolved', false, err.message);
    }
  } else {
    note('no VISIONANCE_TEST_URL set — online cases skipped');
  }

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(SHOT_DIR, 'picture-proof.png'), image.toPNG());

  check('no uncaught renderer errors during the run',
    pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
}

app.whenReady().then(async () => {
  const deadline = setTimeout(() => {
    console.log('\nFAIL — harness timed out');
    app.exit(1);
  }, 300000);

  for (let i = 0; i < 100 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (!win) await sleep(100);
  }
  if (!win) { console.log('FAIL — no window'); return app.exit(1); }
  if (win.isMaximized()) win.unmaximize();
  await sleep(200);
  win.setSize(1536, 1000);

  win.webContents.on('console-message', (...args) => {
    const event = args[0];
    const level = typeof event === 'object' && event ? event.level : args[1];
    const message = typeof event === 'object' && event ? event.message : args[2];
    if (level === 'error' || level === 3) pageErrors.push(String(message).slice(0, 200));
  });

  try {
    await run();
  } catch (err) {
    console.log(`\nFAIL — ${err.message}`);
    results.push({ label: 'harness', pass: false, detail: err.message });
  }

  clearTimeout(deadline);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${failed.length ? `FAIL — ${failed.length} of ${results.length}` : `PASS — ${results.length} checks`}\n`);
  app.exit(failed.length ? 1 : 0);
});
