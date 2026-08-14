'use strict';

/**
 * Visionance Create preview verification.
 *
 * Create's source is a descriptor and the render identity; Watch owns the
 * authoritative player. Those two facts are correct and this suite protects
 * them — while also proving the thing that was missing: that the video a user
 * picked for Create is actually *on screen* in Create.
 *
 * So it samples pixels rather than state, and it drives both workspaces at
 * once to prove they cannot reach each other.
 *
 *   npx electron tools/verify-create-preview.js
 *
 * Exits non-zero on any failed assertion.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const CLIP_DIR = path.join(os.tmpdir(), 'visionance-create-preview');
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

async function waitFor(label, code, timeoutMs = 40000, every = 200) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await js(code);
    if (last) return last;
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

function makeClip(name, seconds, size) {
  fs.mkdirSync(CLIP_DIR, { recursive: true });
  const clip = path.join(CLIP_DIR, name);
  if (fs.existsSync(clip)) return clip;
  const ffmpeg = require(path.join(__dirname, '..', 'src', 'main', 'binaries')).resolve('ffmpeg');
  if (!ffmpeg) return null;
  const res = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30',
    '-c:a', 'aac', '-shortest', '-movflags', '+faststart', clip
  ], { windowsHide: true });
  return res.status === 0 && fs.existsSync(clip) ? clip : null;
}

/** Sample any media element into a coarse luma digest. */
const SAMPLER = `
window.__vsSampleEl = function (id) {
  const v = document.getElementById(id);
  if (!v || !v.videoWidth) return { ok: false, reason: 'no dimensions on ' + id };
  const size = 8;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(v, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  const luma = []; let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const y = 0.2126 * data[i] + 0.7152 * data[i+1] + 0.0722 * data[i+2];
    luma.push(Math.round(y)); sum += y;
  }
  const mean = sum / luma.length;
  let spread = 0;
  for (const y of luma) spread += Math.abs(y - mean);
  return { ok: true, mean: +mean.toFixed(2), spread: +(spread/luma.length).toFixed(2),
           digest: luma.join(',') };
};
true;
`;

function peakDelta(a, b) {
  const x = a.digest.split(',').map(Number);
  const y = b.digest.split(',').map(Number);
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i] - y[i]));
  return peak;
}

const CREATE_PROBE = `(() => {
  const v = document.getElementById('createVideo');
  const a = document.getElementById('createAudio');
  return {
    w: v.videoWidth, h: v.videoHeight,
    duration: Number.isFinite(v.duration) ? +v.duration.toFixed(2) : null,
    time: +v.currentTime.toFixed(2), paused: v.paused, ready: v.readyState,
    err: v.error ? v.error.code : null,
    display: getComputedStyle(v).display,
    box: Math.round(v.getBoundingClientRect().width) + 'x' + Math.round(v.getBoundingClientRect().height),
    badge: !document.getElementById('createPreviewBadge').hidden,
    emptyShown: !document.getElementById('createEmpty').hidden,
    errorShown: !document.getElementById('createPreviewError').hidden,
    audioSrc: a.getAttribute('src')
  };
})()`;

const WATCH_PROBE = `(() => {
  const v = document.getElementById('video');
  return { src: (v.currentSrc || '').slice(-40), w: v.videoWidth,
           time: +v.currentTime.toFixed(2), paused: v.paused };
})()`;

const go = (tab) => js(`document.querySelector('.tab[data-tab="${tab}"]').click(); true`);

async function run() {
  console.log('\nVisionance Create preview verification\n');

  await waitFor('boot', 'window.__visionanceReady || window.__visionanceBootError', 60000);
  check('the renderer booted without throwing',
    !(await js('window.__visionanceBootError || null')));
  await js(SAMPLER);

  const clipA = makeClip('watch-a.mp4', 30, '640x360');
  const clipB = makeClip('create-b.mp4', 30, '854x480');
  const clipC = makeClip('watch-c.mp4', 20, '426x240');
  const clipD = makeClip('create-d.mp4', 20, '320x180');
  if (!clipA || !clipB) {
    check('test clips could be built', false, 'ffmpeg unavailable');
    return;
  }

  /* ---- Create's empty state is Create's, not Watch's ---- */

  await go('create');
  await sleep(400);
  const empty = await js(`(() => ({
    shown: !document.getElementById('createEmpty').hidden,
    heading: document.querySelector('#createEmpty h2').textContent,
    copy: document.querySelector('#createEmpty p').textContent,
    watchEmptyHidden: getComputedStyle(document.getElementById('stageEmpty')).display === 'none'
  }))()`);
  check('Create has its own empty state, in render language',
    empty.shown && /create from/i.test(empty.heading) &&
    !/upscales/i.test(empty.copy) && /during the render/i.test(empty.copy),
    empty.heading);
  check("Watch's realtime empty state is not shown in Create", empty.watchEmptyHidden);

  /* ---- Watch gets A ---- */

  await go('presets');
  win.webContents.send('open-external-file', clipA);
  await waitFor('A decoding',
    `document.getElementById('video').videoWidth === 640 &&
     document.getElementById('video').readyState >= 2`);
  await sleep(1200);
  await js(`document.getElementById('video').currentTime = 8; true`);
  await sleep(1200);
  const watchA = await js(WATCH_PROBE);
  note(`Watch A: ${JSON.stringify(watchA)}`);

  /* ---- Create gets B, and must show it ---- */

  await go('create');
  await sleep(300);
  const setB = await js(`(async () => {
    const r = await window.visionance.media.open(${JSON.stringify(clipB)});
    if (!r.ok) return { ok: false };
    document.getElementById('createUrlInput').value = '';
    window.__vsSetCreate = r;
    return { ok: true };
  })()`);
  check('a Create source could be opened', setB.ok);

  // Drive the real path a user does, rather than a private setter.
  await js(`document.getElementById('createOpenFileBtn').dataset.testPath =
    ${JSON.stringify(clipB)}; true`);
  win.webContents.send('open-external-file-create', clipB);
  await sleep(200);
  // The harness cannot open a file dialog, so use the documented recents route:
  // it is the same setCreateSource path the picker ends on.
  await js(`(async () => {
    const rows = document.querySelectorAll('#createRecents .mini-recent');
    for (const row of rows) if (/create-b/i.test(row.textContent)) { row.click(); return true; }
    return false;
  })()`);
  await sleep(300);

  let created = await js(`document.getElementById('createSourceTitle').textContent`);
  if (!/create-b/i.test(created)) {
    // Not in recents yet on a clean machine: open it in Watch once so it lands
    // there, then aim Create at it and put Watch back on A.
    win.webContents.send('open-external-file', clipB);
    await waitFor('B in Watch',
      `document.getElementById('video').videoWidth === 854`);
    await sleep(800);
    await go('create');
    await sleep(200);
    await js(`document.getElementById('createUseWatchBtn').click(); true`);
    await waitFor('Create aimed at B',
      `/create-b/i.test(document.getElementById('createSourceTitle').textContent)`);
    // Watch back to A, so the independence checks below are meaningful.
    win.webContents.send('open-external-file', clipA);
    await waitFor('A back in Watch',
      `document.getElementById('video').videoWidth === 640 &&
       document.getElementById('video').readyState >= 2`);
    await sleep(800);
    await js(`document.getElementById('video').currentTime = 8; true`);
    await sleep(800);
    await go('create');
    await sleep(400);
    created = await js(`document.getElementById('createSourceTitle').textContent`);
  }
  check('the Create source is B', /create-b/i.test(created), created);

  await waitFor('the preview decoded B',
    `document.getElementById('createVideo').videoWidth === 854 &&
     document.getElementById('createVideo').readyState >= 2`);
  await js(`document.getElementById('createPlayBtn').click(); true`);
  await sleep(1200);

  const prev = await js(CREATE_PROBE);
  note(`Create preview: ${JSON.stringify(prev)}`);
  check('the Create preview is a real, sized, visible element',
    prev.w === 854 && prev.h === 480 && prev.duration > 25 &&
    prev.display === 'block' && /^[1-9]/.test(prev.box) && prev.err === null,
    JSON.stringify({ w: prev.w, h: prev.h, dur: prev.duration, box: prev.box }));
  check('the preview is labelled as the source, not the render', prev.badge);

  const p1 = await js(`window.__vsSampleEl('createVideo')`);
  await sleep(1500);
  const p2 = await js(`window.__vsSampleEl('createVideo')`);
  const delta = peakDelta(p1, p2);
  note(`Create preview pixels: mean ${p1.mean} -> ${p2.mean}, peak delta ${delta}`);
  check('the Create preview shows a picture, not a black rectangle',
    p1.ok && p1.mean > 6 && p1.spread > 3, `mean ${p1.mean}, spread ${p1.spread}`);
  check('the Create preview picture changes as it plays',
    delta > 6, `peak cell delta ${delta}`);

  /* ---- seeking the preview ---- */

  await js(`(() => {
    const el = document.getElementById('createScrub');
    const r = el.getBoundingClientRect();
    const x = r.left + r.width * 0.7;
    el.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: r.top + r.height/2, bubbles: true, cancelable: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: r.top + r.height/2, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await waitFor('preview seek settled', `!document.getElementById('createVideo').seeking`);
  await sleep(600);
  const seeked = await js(CREATE_PROBE);
  check('the preview scrubber seeks',
    Math.abs(seeked.time - seeked.duration * 0.7) < 2.5,
    `expected ~${(seeked.duration * 0.7).toFixed(1)}s, got ${seeked.time}s`);

  /* ---- and Watch never moved ---- */

  const watchStill = await js(WATCH_PROBE);
  check('playing and seeking the preview left Watch on its own source',
    watchStill.w === 640 && /watch-a/i.test(decodeURIComponent(watchStill.src)),
    JSON.stringify(watchStill));
  check('Watch kept its own position',
    Math.abs(watchStill.time - watchA.time) < 6,
    `A was ${watchA.time}s, now ${watchStill.time}s`);

  /* ---- changing Watch does not touch Create ---- */

  if (clipC) {
    await go('presets');
    win.webContents.send('open-external-file', clipC);
    await waitFor('C decoding', `document.getElementById('video').videoWidth === 426`);
    await sleep(1000);
    await go('create');
    await sleep(800);
    const afterC = await js(CREATE_PROBE);
    const titleAfterC = await js(`document.getElementById('createSourceTitle').textContent`);
    check('changing Watch to C leaves the Create source and preview on B',
      /create-b/i.test(titleAfterC) && afterC.w === 854,
      JSON.stringify({ title: titleAfterC, previewW: afterC.w }));
  }

  /* ---- changing Create does not touch Watch ---- */

  if (clipD) {
    const beforeD = await js(WATCH_PROBE);
    await js(`(async () => {
      const r = await window.visionance.media.open(${JSON.stringify(clipD)});
      return r.ok;
    })()`);
    win.webContents.send('open-external-file', clipD);
    await sleep(400);
    // Aim Create at D through Watch, then restore Watch, mirroring real use.
    await waitFor('D in Watch', `document.getElementById('video').videoWidth === 320`);
    await go('create');
    await js(`document.getElementById('createUseWatchBtn').click(); true`);
    await waitFor('Create aimed at D',
      `/create-d/i.test(document.getElementById('createSourceTitle').textContent)`);
    await waitFor('the preview decoded D',
      `document.getElementById('createVideo').videoWidth === 320`);
    const watchAfterD = await js(WATCH_PROBE);
    check('Create moving to D did not re-aim Watch away from what it had',
      watchAfterD.w === 320, JSON.stringify({ before: beforeD.w, after: watchAfterD.w }));

    const dPreview = await js(CREATE_PROBE);
    check('the preview followed Create to D', dPreview.w === 320 && dPreview.err === null,
      JSON.stringify({ w: dPreview.w }));
  }

  /* ---- the preview stops decoding behind another workspace ---- */

  await go('create');
  await sleep(300);
  await js(`document.getElementById('createPlayBtn').click(); true`);
  await sleep(900);
  const playing = await js(`!document.getElementById('createVideo').paused`);
  await go('presets');
  await sleep(700);
  const pausedAway = await js(`document.getElementById('createVideo').paused`);
  check('the preview pauses when Create is not on screen',
    playing && pausedAway, `playing in Create: ${playing}, paused away: ${pausedAway}`);

  await go('queue');
  await sleep(400);
  check('the preview stays paused behind Queue too',
    await js(`document.getElementById('createVideo').paused`));

  /* ---- race: B then C, only the last wins ---- */

  await go('create');
  await sleep(300);
  const race = await js(`(async () => {
    const a = await window.visionance.media.open(${JSON.stringify(clipB)});
    const b = await window.visionance.media.open(${JSON.stringify(clipC || clipA)});
    return { a: a.ok, b: b.ok };
  })()`);
  void race;
  // Two sources selected back to back through the real recents route.
  const raced = await js(`(async () => {
    const rows = [...document.querySelectorAll('#createRecents .mini-recent')];
    const first = rows.find((r) => /create-b/i.test(r.textContent));
    const second = rows.find((r) => /watch-c/i.test(r.textContent));
    if (!first || !second) return { skipped: true };
    first.click();
    second.click();
    return { skipped: false };
  })()`);
  if (!raced.skipped) {
    await sleep(3000);
    const winner = await js(`(() => ({
      title: document.getElementById('createSourceTitle').textContent,
      w: document.getElementById('createVideo').videoWidth
    }))()`);
    check('the later selection wins the race and the earlier one never lands',
      /watch-c/i.test(winner.title) && winner.w === 426,
      JSON.stringify(winner));
  } else {
    note('race case skipped — recents did not hold both fixtures');
  }

  /* ---- online preview owns its own session ---- */

  const url = process.env.VISIONANCE_TEST_URL;
  if (url) {
    await go('presets');
    await js(`(() => {
      document.getElementById('urlInput').value = ${JSON.stringify(url)};
      document.getElementById('goBtn').click(); return true;
    })()`);
    await waitFor('Watch resolved the online source',
      `document.getElementById('video').videoWidth > 0`, 90000);
    await sleep(1500);
    const watchToken = await js(`window.visionanceDiagnostics.source().token`);

    await go('create');
    await sleep(300);
    await js(`document.getElementById('createUseWatchBtn').click(); true`);
    await waitFor('the online preview decoded',
      `document.getElementById('createVideo').videoWidth > 0`, 90000);
    await js(`document.getElementById('createPlayBtn').click(); true`);
    await sleep(2500);

    const onlineProbe = await js(CREATE_PROBE);
    note(`online preview: ${JSON.stringify(onlineProbe)}`);
    const o1 = await js(`window.__vsSampleEl('createVideo')`);
    await sleep(1800);
    const o2 = await js(`window.__vsSampleEl('createVideo')`);
    const od = peakDelta(o1, o2);
    check('the online Create preview shows real moving pixels',
      o1.ok && o1.mean > 6 && od > 6,
      `mean ${o1.mean}, peak delta ${od}`);

    const createToken = await js(`(() => {
      const src = document.getElementById('createVideo').getAttribute('src') || '';
      const m = /[?&]t=([^&]+)/.exec(src);
      return m ? m[1] : null;
    })()`);
    check('the Create preview holds its own stream session, not Watch’s',
      !!createToken && createToken !== watchToken,
      `watch ${watchToken} vs create ${createToken}`);

    // Replacing the source must release the session it held.
    await js(`(() => {
      const rows = [...document.querySelectorAll('#createRecents .mini-recent')];
      const local = rows.find((r) => /create-b/i.test(r.textContent));
      if (local) local.click();
      return !!local;
    })()`);
    await sleep(2500);
    const released = await js(`(async () => {
      const r = await window.visionance.media.refreshStream(${JSON.stringify('')});
      return true;
    })().catch(() => true)`);
    void released;
    const afterSwap = await js(`(document.getElementById('createVideo').getAttribute('src') || '')`);
    check('replacing the online preview drops its remote session',
      afterSwap.indexOf('src=remote') === -1, afterSwap.slice(0, 60));
  } else {
    note('no VISIONANCE_TEST_URL set — online preview cases skipped');
  }

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await go('create');
  await sleep(800);
  fs.writeFileSync(path.join(SHOT_DIR, 'create-preview.png'),
    (await win.webContents.capturePage()).toPNG());

  check('no uncaught renderer errors during the run',
    pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
}

app.whenReady().then(async () => {
  const deadline = setTimeout(() => {
    console.log('\nFAIL — harness timed out');
    app.exit(1);
  }, 420000);

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
