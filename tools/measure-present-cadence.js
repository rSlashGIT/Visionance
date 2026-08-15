/**
 * Where does the enhanced canvas actually land on the display clock?
 *
 *   VISIONANCE_TEST_VIDEO=clip.mp4 npx electron tools/measure-present-cadence.js
 *
 * `measure-video-visibility.js` establishes that the media keeps real time in
 * every configuration (media/wall = 1.0) and that the decoder's dropped-frame
 * counter is meaningless for a parked element. So if enhanced Watch looks less
 * smooth than native, the loss is not in decode and not in the media clock. It
 * is in *when the enhanced pixels reach the screen*.
 *
 * Two schedulers over the same clip and the same shader work:
 *
 *   rvfc   draw inside requestVideoFrameCallback - what Watch does today. The
 *          callback fires on the media's cadence, which has no relationship to
 *          the display's refresh, so the canvas commit lands at an arbitrary
 *          phase within the refresh interval.
 *   raf    draw inside requestAnimationFrame, gated on "has a new source frame
 *          arrived since the last draw". Same number of draws - the expensive
 *          work still happens once per source frame - but each commit lands on
 *          a refresh boundary.
 *
 * A 23.976 fps source on a 60 Hz panel can only be shown as a repeating 3,2
 * pattern of refreshes per frame (2.5 average). What the eye reads as judder is
 * not that pattern; it is *irregularity* in it. So the number that matters is
 * the spread of refreshes-per-presented-frame, not the mean.
 *
 * Prints numbers and exits 0. This is a measurement, not a pass/fail test.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const { app, BrowserWindow } = require('electron');

app.setName('Visionance');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'visionance-cadence-')));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const TEST_VIDEO = process.env.VISIONANCE_TEST_VIDEO;
const SAMPLE_MS = Number(process.env.VISIONANCE_SAMPLE_MS) || 10000;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body { margin:0; background:#0b0b0d; overflow:hidden; }
  #stage { position:relative; width:100vw; height:100vh; display:grid; place-items:center; }
  video { position:absolute; width:1px; height:1px; opacity:0; pointer-events:none; left:-9999px; }
  canvas { max-width:100%; max-height:100%; }
</style></head><body>
  <div id="stage"><video id="v" muted playsinline></video><canvas id="c"></canvas></div>
</body></html>`;

function passScript(mode, sampleMs) {
  return `
  (async () => {
    const v = document.getElementById('v');
    const c = document.getElementById('c');
    const mode = ${JSON.stringify(mode)};

    if (window.__stop) { window.__stop(); window.__stop = null; }
    await new Promise(r => setTimeout(r, 300));

    const gl = window.__gl || (window.__gl = c.getContext('webgl2',
      { alpha:false, antialias:false, depth:false, stencil:false, desynchronized:true }));
    c.width = v.videoWidth; c.height = v.videoHeight;

    if (!window.__tex) {
      window.__tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, window.__tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      window.__first = true;
    }
    const tex = window.__tex;

    const upload = () => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      if (window.__first) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, v); window.__first = false; }
      else { gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, v); }
      gl.viewport(0, 0, c.width, c.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    };

    try { v.currentTime = 1; } catch {}
    await v.play().catch(() => {});
    await new Promise(r => setTimeout(r, 1200));

    // A passive rAF observer timestamps every display refresh in both modes,
    // so "which refresh did this draw land on" is answerable either way.
    let vsyncCount = 0;
    const vsyncTimes = [];
    let rafObs = null;
    const observe = (t) => { vsyncCount++; vsyncTimes.push(t); rafObs = requestAnimationFrame(observe); };
    rafObs = requestAnimationFrame(observe);

    /** Display refreshes elapsed between consecutive drawn frames. */
    const refreshGaps = [];
    let drawnFrames = 0;
    let lastDrawVsync = null;
    let newFrameFlag = false;
    let rvfcHandle = null;
    let rafDraw = null;

    const recordDraw = () => {
      drawnFrames++;
      if (lastDrawVsync !== null) refreshGaps.push(vsyncCount - lastDrawVsync);
      lastDrawVsync = vsyncCount;
    };

    if (mode === 'rvfc') {
      const step = () => { rvfcHandle = v.requestVideoFrameCallback(step); upload(); recordDraw(); };
      rvfcHandle = v.requestVideoFrameCallback(step);
      window.__stop = () => { try { v.cancelVideoFrameCallback(rvfcHandle); } catch {} };
    } else {
      // rvfc is used only as a "a new source frame exists" signal; it does no
      // work itself. The draw happens on the display's own clock.
      const mark = () => { rvfcHandle = v.requestVideoFrameCallback(mark); newFrameFlag = true; };
      rvfcHandle = v.requestVideoFrameCallback(mark);
      const loop = () => {
        rafDraw = requestAnimationFrame(loop);
        if (!newFrameFlag) return;      // no new media frame: no expensive work
        newFrameFlag = false;
        upload();
        recordDraw();
      };
      rafDraw = requestAnimationFrame(loop);
      window.__stop = () => {
        try { v.cancelVideoFrameCallback(rvfcHandle); } catch {}
        cancelAnimationFrame(rafDraw);
      };
    }

    const t0 = performance.now();
    const m0 = v.currentTime;
    const startDrawn = drawnFrames;
    const startVsync = vsyncCount;
    refreshGaps.length = 0;

    await new Promise(r => setTimeout(r, ${sampleMs}));

    const wallMs = performance.now() - t0;
    const mediaSec = v.currentTime - m0;
    const drew = drawnFrames - startDrawn;
    const refreshes = vsyncCount - startVsync;

    if (window.__stop) { window.__stop(); window.__stop = null; }
    cancelAnimationFrame(rafObs);

    // Distribution of refreshes per drawn frame. A clean 3,2,3,2 for 23.976 on
    // 60 Hz is smooth; the same mean spread over 1..5 is judder.
    const hist = {};
    for (const g of refreshGaps) hist[g] = (hist[g] || 0) + 1;
    const mean = refreshGaps.length
      ? refreshGaps.reduce((a, b) => a + b, 0) / refreshGaps.length : 0;
    const mad = refreshGaps.length
      ? refreshGaps.reduce((s, g) => s + Math.abs(g - mean), 0) / refreshGaps.length : 0;
    // Share of frames outside the only two legal gaps for this cadence.
    const legal = new Set([Math.floor(mean), Math.ceil(mean)]);
    const offPattern = refreshGaps.length
      ? refreshGaps.filter((g) => !legal.has(g)).length / refreshGaps.length : 0;

    return {
      mode,
      wallSec: Math.round(wallMs) / 1000,
      mediaVsWall: Math.round((mediaSec / (wallMs / 1000)) * 1000) / 1000,
      drawnFrames: drew,
      drawnFps: Math.round((drew / (wallMs / 1000)) * 10) / 10,
      displayHz: Math.round((refreshes / (wallMs / 1000)) * 10) / 10,
      refreshesPerFrameMean: Math.round(mean * 100) / 100,
      refreshesPerFrameMad: Math.round(mad * 1000) / 1000,
      offPatternPct: Math.round(offPattern * 1000) / 10,
      histogram: hist
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
  const pageFile = path.join(path.dirname(TEST_VIDEO), '.vs-cadence-probe.html');
  fs.writeFileSync(pageFile, PAGE, 'utf8');
  await win.loadFile(pageFile);
  win.showInactive();

  await win.webContents.executeJavaScript(`
    (async () => {
      const v = document.getElementById('v');
      v.src = ${JSON.stringify(path.basename(TEST_VIDEO))};
      await new Promise((res, rej) => {
        v.addEventListener('loadeddata', res, { once: true });
        v.addEventListener('error', () => rej(new Error('load failed')), { once: true });
      });
      return [v.videoWidth, v.videoHeight];
    })()`);

  const rows = [];
  for (const mode of ['rvfc', 'raf', 'rvfc', 'raf']) {
    // eslint-disable-next-line no-await-in-loop
    rows.push(await win.webContents.executeJavaScript(passScript(mode, SAMPLE_MS)));
  }

  console.log('\nEnhanced canvas presentation cadence');
  console.log('clip :', path.basename(TEST_VIDEO), '  window per pass:', SAMPLE_MS, 'ms\n');
  console.log(
    'mode'.padEnd(7) + 'drawnFps'.padEnd(10) + 'displayHz'.padEnd(11) +
    'refresh/frame'.padEnd(15) + 'spread(MAD)'.padEnd(13) + 'off-pattern'.padEnd(13) + 'media/wall');
  for (const r of rows) {
    console.log(
      String(r.mode).padEnd(7) + String(r.drawnFps).padEnd(10) + String(r.displayHz).padEnd(11) +
      String(r.refreshesPerFrameMean).padEnd(15) + String(r.refreshesPerFrameMad).padEnd(13) +
      (r.offPatternPct + '%').padEnd(13) + r.mediaVsWall);
  }
  console.log('\nrefreshes-per-frame histogram');
  for (const r of rows) console.log('  ' + r.mode.padEnd(6), JSON.stringify(r.histogram));

  const avg = (m, k) => {
    const rs = rows.filter((r) => r.mode === m);
    return rs.reduce((s, r) => s + r[k], 0) / rs.length;
  };
  console.log('\nVerdict');
  console.log(`  rvfc: spread ${avg('rvfc', 'refreshesPerFrameMad').toFixed(3)}, ` +
    `off-pattern ${avg('rvfc', 'offPatternPct').toFixed(1)}%`);
  console.log(`  raf : spread ${avg('raf', 'refreshesPerFrameMad').toFixed(3)}, ` +
    `off-pattern ${avg('raf', 'offPatternPct').toFixed(1)}%`);
  console.log('  Lower spread and fewer off-pattern frames is visibly smoother at the same fps.');

  try { fs.rmSync(pageFile, { force: true }); } catch { /* best effort */ }
  app.exit(0);
}

app.whenReady().then(main).catch((err) => { console.error(err); app.exit(1); });
