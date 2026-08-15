/**
 * Does hiding the <video> element inflate `droppedVideoFrames`?
 *
 *   VISIONANCE_TEST_VIDEO=clip.mp4 npx electron tools/measure-video-visibility.js
 *
 * Watch's enhanced path parks the media element at `1px x 1px, opacity 0,
 * left: -9999px` so the canvas can upload it as a texture without it being
 * painted twice. That is the right thing to do for cost. The open question -
 * and the one the whole Watch cadence investigation turns on - is what it does
 * to `getVideoPlaybackQuality().droppedVideoFrames`, which the governor, the
 * overload cut-out, Watch Auto Configure and the diagnostics panel all read as
 * "frames the user did not see".
 *
 * Chromium counts a frame as dropped when it was decoded and then not
 * displayed. An element that is one pixel wide, fully transparent and parked
 * off-screen has very little reason to display anything. If that is what the
 * counter reflects, then in enhanced mode it is measuring the invisible
 * element rather than the visible canvas, and every consumer of it is wrong.
 *
 * This is a measurement, not a test: it prints numbers and exits 0. Three
 * passes over the same clip, same window, same decoder:
 *
 *   visible          the element is the picture, as in native playback
 *   hidden           the element is parked exactly as enhanced mode parks it
 *   hidden+upload    parked, plus a per-frame texImage2D into a WebGL2 canvas,
 *                    which is the cheapest honest imitation of the real
 *                    enhanced path's dominant cost
 *
 * The ground truth for "is playback keeping up" is in none of those counters:
 * it is whether `mediaTime` advances as fast as the wall clock. That is
 * reported for every pass and is immune to how the element is composited.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const { app, BrowserWindow } = require('electron');

app.setName('Visionance');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'visionance-visibility-')));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const TEST_VIDEO = process.env.VISIONANCE_TEST_VIDEO;
const SAMPLE_MS = Number(process.env.VISIONANCE_SAMPLE_MS) || 10000;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body { margin:0; background:#0b0b0d; overflow:hidden; }
  #stage { position:relative; width:100vw; height:100vh; display:grid; place-items:center; }
  /* Exactly Watch's enhanced-mode parking rule. */
  video.parked { position:absolute; width:1px; height:1px; opacity:0; pointer-events:none; left:-9999px; }
  video.shown  { position:relative; max-width:100%; max-height:100%; opacity:1; display:block; }
  canvas { max-width:100%; max-height:100%; }
  canvas.off { display:none; }
</style></head><body>
  <div id="stage"><video id="v" muted playsinline></video><canvas id="c" class="off"></canvas></div>
</body></html>`;

/**
 * One measured pass. Returns the decoder's counters, the compositor's own
 * presented-frame count, and the media-time-versus-wall-clock ratio.
 */
function passScript(mode, sampleMs) {
  return `
  (async () => {
    const v = document.getElementById('v');
    const c = document.getElementById('c');
    const mode = ${JSON.stringify(mode)};

    v.className = (mode === 'visible') ? 'shown' : 'parked';
    c.className = (mode === 'hidden+upload') ? '' : 'off';

    if (window.__stopUpload) { window.__stopUpload(); window.__stopUpload = null; }

    try { v.currentTime = 1; } catch {}
    await v.play().catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    if (mode === 'hidden+upload') {
      const gl = c.getContext('webgl2', { alpha:false, antialias:false, desynchronized:true });
      c.width = v.videoWidth; c.height = v.videoHeight;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      let handle = null;
      let first = true;
      const step = () => {
        handle = v.requestVideoFrameCallback(step);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        if (first) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, v); first = false; }
        else { gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, v); }
        gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
      };
      handle = v.requestVideoFrameCallback(step);
      window.__stopUpload = () => { try { v.cancelVideoFrameCallback(handle); } catch {} };
      await new Promise(r => setTimeout(r, 500));
    }

    // --- start of measurement window ---
    const q0 = v.getVideoPlaybackQuality();
    const t0 = performance.now();
    const m0 = v.currentTime;

    // The compositor's own presented-frame counter, read via rvfc metadata.
    let firstPresented = null, lastPresented = null, callbacks = 0;
    let rvfc = null;
    const onFrame = (now, meta) => {
      rvfc = v.requestVideoFrameCallback(onFrame);
      callbacks++;
      if (Number.isFinite(meta.presentedFrames)) {
        if (firstPresented === null) firstPresented = meta.presentedFrames;
        lastPresented = meta.presentedFrames;
      }
    };
    rvfc = v.requestVideoFrameCallback(onFrame);

    await new Promise(r => setTimeout(r, ${sampleMs}));

    try { v.cancelVideoFrameCallback(rvfc); } catch {}
    const q1 = v.getVideoPlaybackQuality();
    const wallMs = performance.now() - t0;
    const mediaSec = v.currentTime - m0;

    if (window.__stopUpload) { window.__stopUpload(); window.__stopUpload = null; }

    const dTotal = q1.totalVideoFrames - q0.totalVideoFrames;
    const dDropped = q1.droppedVideoFrames - q0.droppedVideoFrames;
    const presented = (firstPresented !== null && lastPresented !== null)
      ? lastPresented - firstPresented : null;

    return {
      mode,
      wallSec: Math.round(wallMs) / 1000,
      mediaSec: Math.round(mediaSec * 1000) / 1000,
      // 1.0 means the media kept up with real time. This is the only number
      // here that cannot be confused by how the element is composited.
      mediaVsWall: Math.round((mediaSec / (wallMs / 1000)) * 1000) / 1000,
      decodedFrames: dTotal,
      decoderDropped: dDropped,
      decoderDroppedPct: dTotal > 0 ? Math.round((dDropped / dTotal) * 1000) / 10 : 0,
      compositorPresented: presented,
      rvfcCallbacks: callbacks,
      decodedFps: Math.round((dTotal / (wallMs / 1000)) * 10) / 10,
      presentedFps: presented !== null ? Math.round((presented / (wallMs / 1000)) * 10) / 10 : null,
      mediaFps: mediaSec > 0 ? Math.round((dTotal / mediaSec) * 10) / 10 : 0
    };
  })()`;
}

async function main() {
  if (!TEST_VIDEO || !fs.existsSync(TEST_VIDEO)) {
    console.error('Set VISIONANCE_TEST_VIDEO to a real clip.');
    app.exit(2);
    return;
  }

  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { backgroundThrottling: false }
  });

  // The page is written beside the clip and loaded from disk, so the media is
  // same-directory `file:` content. A `data:` page has an opaque origin and
  // cannot load `file:` media at all, and disabling webSecurity to work around
  // that would change the very scheduling this tool exists to measure.
  const pageFile = path.join(path.dirname(TEST_VIDEO), '.vs-visibility-probe.html');
  fs.writeFileSync(pageFile, PAGE, 'utf8');
  await win.loadFile(pageFile);
  win.showInactive();

  await win.webContents.executeJavaScript(`
    (async () => {
      const v = document.getElementById('v');
      v.src = ${JSON.stringify(path.basename(TEST_VIDEO))};
      await new Promise((res, rej) => {
        v.addEventListener('loadeddata', res, { once: true });
        v.addEventListener('error', () => rej(new Error('load failed: ' + (v.error && v.error.message))), { once: true });
      });
      return [v.videoWidth, v.videoHeight];
    })()`);

  const rows = [];
  for (const mode of ['visible', 'hidden', 'hidden+upload', 'visible']) {
    // eslint-disable-next-line no-await-in-loop
    rows.push(await win.webContents.executeJavaScript(passScript(mode, SAMPLE_MS)));
  }

  const gpu = await win.webContents.executeJavaScript(`
    (() => { const c = document.createElement('canvas');
      const gl = c.getContext('webgl2'); if (!gl) return 'none';
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown'; })()`);

  console.log('\nVideo element visibility vs droppedVideoFrames');
  console.log('clip :', path.basename(TEST_VIDEO));
  console.log('gpu  :', gpu);
  console.log('window per pass:', SAMPLE_MS, 'ms\n');

  const head = ['mode', 'decoded', 'drop', 'drop%', 'presented', 'rvfc', 'decFps', 'presFps', 'media/wall'];
  console.log(head.map((h, i) => h.padEnd(i === 0 ? 15 : 10)).join(''));
  for (const r of rows) {
    console.log([
      r.mode, r.decodedFrames, r.decoderDropped, r.decoderDroppedPct + '%',
      r.compositorPresented === null ? 'n/a' : r.compositorPresented,
      r.rvfcCallbacks, r.decodedFps, r.presentedFps === null ? 'n/a' : r.presentedFps,
      r.mediaVsWall
    ].map((c, i) => String(c).padEnd(i === 0 ? 15 : 10)).join(''));
  }

  const visible = rows.filter((r) => r.mode === 'visible');
  const hidden = rows.find((r) => r.mode === 'hidden');
  const visDrop = visible.reduce((s, r) => s + r.decoderDroppedPct, 0) / visible.length;
  console.log('\nVerdict');
  console.log(`  visible passes dropped ${visDrop.toFixed(1)}% on average`);
  console.log(`  parked (enhanced-mode styling) dropped ${hidden.decoderDroppedPct}%`);
  console.log(
    hidden.decoderDroppedPct > visDrop + 2
      ? '  => parking the element INFLATES droppedVideoFrames. The counter does not\n' +
        '     describe what the user sees when the canvas is the picture.'
      : '  => parking the element did not materially change the counter.');
  console.log('\n  media/wall stayed at ' +
    rows.map((r) => r.mediaVsWall).join(', ') +
    ' — 1.0 means playback kept real time in that pass.');

  try { fs.rmSync(pageFile, { force: true }); } catch { /* best effort */ }
  app.exit(0);
}

app.whenReady().then(main).catch((err) => {
  console.error(err);
  app.exit(1);
});
