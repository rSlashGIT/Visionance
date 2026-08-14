'use strict';

/**
 * Visionance local playback / seeking verification.
 *
 * Boots the real application, opens a real local file through the real
 * `open-external-file` route, and asserts that the media element is genuinely
 * seekable: that it reports a seekable range covering the file, that assigning
 * `currentTime` lands near the requested position instead of snapping back,
 * that playback resumes from there, and that enhancement-off still uses the
 * native Chromium video path.
 *
 * This exists because it did not. Local files were served by handing the path
 * to `net.fetch` as a `file://` URL, which answers with the whole body and
 * status 200 — no `Accept-Ranges`, no `Content-Range` — so Chromium concluded
 * the resource was not seekable and the scrubber could not move.
 *
 *   npx electron tools/verify-seek.js
 *
 * Exits non-zero on any failed assertion.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const CLIP_DIR = path.join(os.tmpdir(), 'visionance-seek-verify');

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

/**
 * A clip long enough that seeking is a real operation rather than a rounding
 * error, and with a moving picture so a landed seek can be told apart from a
 * frozen one. Sixty seconds at 30fps keeps the build under a couple of seconds.
 */
function makeClip() {
  fs.mkdirSync(CLIP_DIR, { recursive: true });
  const clip = path.join(CLIP_DIR, 'seek-clip.mp4');
  if (fs.existsSync(clip)) return clip;
  const ffmpeg = require(path.join(__dirname, '..', 'src', 'main', 'binaries')).resolve('ffmpeg');
  if (!ffmpeg) return null;
  const res = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=60',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30',
    '-c:a', 'aac', '-shortest', '-movflags', '+faststart',
    clip
  ], { windowsHide: true });
  return res.status === 0 && fs.existsSync(clip) ? clip : null;
}

const probe = `(() => {
  const v = document.getElementById('video');
  return {
    duration: v.duration,
    time: v.currentTime,
    paused: v.paused,
    seeking: v.seeking,
    readyState: v.readyState,
    ranges: v.seekable.length,
    seekableStart: v.seekable.length ? v.seekable.start(0) : null,
    seekableEnd: v.seekable.length ? v.seekable.end(0) : null,
    error: v.error ? v.error.code : null
  };
})()`;

async function run() {
  console.log('\nVisionance local seeking verification\n');

  await waitFor('boot', 'window.__visionanceReady || window.__visionanceBootError', 60000);
  const bootError = await js('window.__visionanceBootError || null');
  check('the renderer booted without throwing', !bootError, bootError || '');

  const clip = makeClip();
  if (!clip) {
    check('a local test clip could be built', false, 'ffmpeg unavailable');
    return;
  }
  const bytes = fs.statSync(clip).size;

  /* ---- the protocol answers ranges ------------------------------------ */

  // Asked of the same privileged scheme the media element uses, so this is the
  // real response Chromium sees rather than a separate code path.
  const head = await js(`(async () => {
    const url = 'vs://app/__media?src=local&p=' + encodeURIComponent(${JSON.stringify(clip)});
    const full = await fetch(url, { method: 'HEAD' });
    const ranged = await fetch(url, { headers: { Range: 'bytes=100-199' } });
    const body = await ranged.arrayBuffer();
    const bad = await fetch(url, { headers: { Range: 'bytes=99999999999-' } });
    return {
      fullStatus: full.status,
      acceptRanges: full.headers.get('accept-ranges'),
      length: full.headers.get('content-length'),
      type: full.headers.get('content-type'),
      rangedStatus: ranged.status,
      contentRange: ranged.headers.get('content-range'),
      rangedBytes: body.byteLength,
      unsatisfiable: bad.status
    };
  })()`);

  check('a local file advertises byte ranges',
    head.fullStatus === 200 && head.acceptRanges === 'bytes' &&
    Number(head.length) === bytes && head.type === 'video/mp4',
    JSON.stringify({ status: head.fullStatus, acceptRanges: head.acceptRanges,
      length: head.length, expected: bytes, type: head.type }));

  check('a range request is answered 206 with the exact window',
    head.rangedStatus === 206 && head.rangedBytes === 100 &&
    head.contentRange === `bytes 100-199/${bytes}`,
    JSON.stringify({ status: head.rangedStatus, contentRange: head.contentRange,
      bytes: head.rangedBytes }));

  check('an unsatisfiable range is refused rather than served whole',
    head.unsatisfiable === 416, String(head.unsatisfiable));

  /* ---- the media element agrees --------------------------------------- */

  win.webContents.send('open-external-file', clip);
  await waitFor('clip decoding',
    `(() => { const v = document.getElementById('video');
      return v.videoWidth === 640 && v.readyState >= 2 && v.duration > 0; })()`, 40000);

  // The restore of a remembered position happens shortly after load; let it
  // land so it cannot be mistaken for a failed seek.
  await sleep(2500);

  const loaded = await js(probe);
  check('the source reports a real duration',
    loaded.duration > 55 && loaded.duration < 65, `${loaded.duration}s`);
  check('the media element exposes a seekable range covering the file',
    loaded.ranges === 1 && loaded.seekableStart === 0 &&
    Math.abs(loaded.seekableEnd - loaded.duration) < 1.5,
    JSON.stringify({ ranges: loaded.ranges, start: loaded.seekableStart,
      end: loaded.seekableEnd, duration: loaded.duration }));

  /* ---- a seek actually lands ------------------------------------------ */

  const TARGET = 42;
  await js(`(() => { const v = document.getElementById('video');
    if (!v.paused) v.pause();
    v.currentTime = ${TARGET}; return true; })()`);
  await waitFor('seek completed',
    `(() => { const v = document.getElementById('video');
      return !v.seeking && v.readyState >= 2; })()`, 20000);
  const seeked = await js(probe);
  check('assigning currentTime lands near the requested position',
    Math.abs(seeked.time - TARGET) < 1.5,
    `asked ${TARGET}s, landed ${seeked.time.toFixed(3)}s`);
  check('the seek did not snap back to the start',
    seeked.time > 5, `${seeked.time.toFixed(3)}s`);

  /* ---- and playback continues from there ------------------------------- */

  await js(`document.getElementById('video').play(); true`);
  await sleep(1800);
  const playing = await js(probe);
  check('playback resumes from the seeked position',
    playing.time > seeked.time && playing.time < seeked.time + 4 && !playing.paused,
    `${seeked.time.toFixed(2)}s -> ${playing.time.toFixed(2)}s`);
  check('no media error was raised by seeking', playing.error === null,
    String(playing.error));

  /* ---- the scrubber, as a user drives it ------------------------------- */

  await js(`document.getElementById('video').pause(); true`);
  const scrub = await js(`(() => {
    const el = document.getElementById('scrub');
    const r = el.getBoundingClientRect();
    // 20% along the track: the same gesture the transport handler reads.
    const x = r.left + r.width * 0.2;
    // The transport binds mousedown on the track and reads clientX from it.
    el.dispatchEvent(new MouseEvent('mousedown', {
      clientX: x, clientY: r.top + r.height / 2, bubbles: true, cancelable: true
    }));
    window.dispatchEvent(new MouseEvent('mouseup', {
      clientX: x, clientY: r.top + r.height / 2, bubbles: true, cancelable: true
    }));
    return true;
  })()`);
  void scrub;
  await waitFor('scrub seek completed',
    `!document.getElementById('video').seeking`, 20000);
  await sleep(400);
  const scrubbed = await js(probe);
  check('dragging the scrubber to 20% seeks there',
    Math.abs(scrubbed.time - scrubbed.duration * 0.2) < 2.5,
    `expected ~${(scrubbed.duration * 0.2).toFixed(1)}s, got ${scrubbed.time.toFixed(2)}s`);

  /* ---- backwards, too -------------------------------------------------- */

  await js(`document.getElementById('video').currentTime = 3; true`);
  await waitFor('backward seek completed',
    `!document.getElementById('video').seeking`, 20000);
  const back = await js(probe);
  check('seeking backwards works as well as forwards',
    Math.abs(back.time - 3) < 1.5, `${back.time.toFixed(3)}s`);

  /* ---- native presentation is untouched -------------------------------- */

  for (let i = 0; i < 2; i++) {
    const on = await js('!!(window.visionanceDiagnostics.snapshot().enhancement)');
    if (!on) break;
    await js(`document.getElementById('enhanceToggle').click(); true`);
    await sleep(300);
  }
  await sleep(400);
  const presentation = await js(`(() => {
    const d = window.visionanceDiagnostics.source();
    const inner = document.getElementById('stageInner');
    return { mode: d.presentation, engine: d.engineRunning,
             nativeClass: inner.classList.contains('native'),
             videoVisible: getComputedStyle(document.getElementById('video')).opacity === '1',
             canvasHidden: getComputedStyle(document.getElementById('glCanvas')).display === 'none' };
  })()`);
  check('enhancement off still uses the native Chromium video path',
    presentation.mode === 'native' && presentation.engine === false &&
    presentation.nativeClass && presentation.videoVisible && presentation.canvasHidden,
    JSON.stringify(presentation));

  // And a seek still works on the native path, which is the one a user watching
  // an unenhanced file is actually on.
  await js(`(() => { const v = document.getElementById('video');
    v.currentTime = 30; return true; })()`);
  await waitFor('native-path seek completed',
    `!document.getElementById('video').seeking`, 20000);
  const nativeSeek = await js(probe);
  check('seeking works on the native path too',
    Math.abs(nativeSeek.time - 30) < 1.5, `${nativeSeek.time.toFixed(3)}s`);

  /* ---- ordinary playback is still smooth ------------------------------- */

  await js(`document.getElementById('video').play(); true`);
  await sleep(3000);
  const smooth = await js(`(() => {
    const v = document.getElementById('video');
    const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    return { time: v.currentTime, paused: v.paused,
             dropped: q ? q.droppedVideoFrames : 0,
             total: q ? q.totalVideoFrames : 0 };
  })()`);
  check('ordinary playback still runs without stalling',
    !smooth.paused && smooth.time > 32,
    `t=${smooth.time.toFixed(2)}s dropped=${smooth.dropped}/${smooth.total}`);

  check('no uncaught renderer errors during the run',
    pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
}

app.whenReady().then(async () => {
  const deadline = setTimeout(() => {
    console.log('\nFAIL — harness timed out');
    app.exit(1);
  }, 240000);

  for (let i = 0; i < 100 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (!win) await sleep(100);
  }
  if (!win) {
    console.log('FAIL — no window was created');
    return app.exit(1);
  }

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
