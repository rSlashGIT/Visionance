/**
 * What does a Watch enhancement frame actually cost on this GPU?
 *
 *   VISIONANCE_TEST_VIDEO=clip.mp4 npx electron tools/measure-enhance-cost.js
 *
 * The engine reports `cpuMs` from a `performance.now()` bracket around its GL
 * calls. GL calls return as soon as the command is queued, so that number is
 * the cost of *submitting* the frame, not of rendering it. On the reference
 * laptop it reads about 1 ms against a 41.9 ms budget while the picture is
 * visibly less smooth than native - which is exactly what a submission timer
 * looks like when the GPU behind it is saturated.
 *
 * This measures the real thing with `EXT_disjoint_timer_query_webgl2`, over the
 * real shader chain from `shaders.js`, at several internal render scales, so
 * the governor can be designed against the actual cost curve instead of a
 * number that cannot go up.
 *
 * Prints numbers and exits 0.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const { app, BrowserWindow } = require('electron');

app.setName('Visionance');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'visionance-cost-')));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const TEST_VIDEO = process.env.VISIONANCE_TEST_VIDEO;
const RENDERER = path.join(__dirname, '..', 'src', 'renderer');

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body { margin:0; background:#0b0b0d; overflow:hidden; }
  #stage { position:relative; width:100vw; height:100vh; display:grid; place-items:center; }
  video { position:absolute; width:1px; height:1px; opacity:0; pointer-events:none; left:-9999px; }
  canvas { max-width:100%; max-height:100%; }
</style></head><body>
  <div id="stage"><video id="v" muted playsinline></video><canvas id="c"></canvas></div>
  <script src="SHADERS"></script>
  <script src="ENGINE"></script>
</body></html>`;

/** Measure GPU and CPU time per enhanced frame at one internal scale. */
function costScript(scale, frames) {
  return `
  (async () => {
    const v = document.getElementById('v');
    const c = document.getElementById('c');
    const gl = window.__eng ? window.__eng.gl : null;

    if (!window.__eng) {
      window.__eng = new window.VSEngine.Engine(c);
      window.__eng.setVideo(v);
    }
    const eng = window.__eng;
    const g = eng.gl;

    // The engine times itself now, with the same TIME_ELAPSED mechanism. Two
    // overlapping TIME_ELAPSED queries are illegal in WebGL2, so this reads the
    // engine's own measurement rather than wrapping a second query around it -
    // which also makes this a test of the instrumentation that ships.
    if (!eng.stats.gpuTimingAvailable) return { scale: ${scale}, unsupported: true };

    // Fix the internal scale: this measurement is the cost curve, so the
    // governor must not be moving the thing being measured. The quality scale
    // is the lever the governor actually pulls, so that is what is swept here;
    // sweeping the render-scale cap instead is what hid the fact that the
    // lever was disconnected.
    eng.setAdaptive(false);
    eng.setRenderScaleCap('auto');
    eng.setParams({ ...window.VSEngine.DEFAULT_PARAMS, enabled: true });
    eng._qualityScale = ${scale};
    eng._needsDraw = true;

    // Several passes over a finite clip will run off the end, after which no
    // more frames are presented and every wait below would hang.
    v.loop = true;
    if (v.ended || v.currentTime > v.duration - 3) { try { v.currentTime = 1; } catch {} }
    await v.play().catch(() => {});
    await new Promise(r => setTimeout(r, 600));

    for (let i = 0; i < ${frames}; i++) {
      // One draw per real source frame, as the engine does. Bounded, so a
      // stalled source fails the measurement instead of hanging it.
      await new Promise((res) => {
        const h = v.requestVideoFrameCallback(() => { clearTimeout(t); res(); });
        const t = setTimeout(() => { try { v.cancelVideoFrameCallback(h); } catch {} res(); }, 1000);
      });
      eng.draw();
      // The engine reads its timers back a frame later, so give the queue a
      // moment rather than blocking on the GPU.
      await new Promise(r => setTimeout(r, 4));
    }
    // One more tick so the 500 ms stats window closes with these frames in it.
    await new Promise(r => setTimeout(r, 550));
    eng.draw();

    return {
      scale: ${scale},
      source: v.videoWidth + 'x' + v.videoHeight,
      render: c.width + 'x' + c.height,
      megapixels: Math.round((c.width * c.height) / 1e5) / 10,
      cpuMs: eng.stats.cpuMs,
      gpuMs: eng.stats.gpuMs,
      gpuSamples: eng._gpuTimes.length
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

  const dir = path.dirname(TEST_VIDEO);
  const pageFile = path.join(dir, '.vs-cost-probe.html');
  // The engine scripts are copied beside the page so everything is one origin.
  for (const f of ['shaders.js', 'engine.js']) {
    fs.copyFileSync(path.join(RENDERER, 'js', f), path.join(dir, '.vs-' + f));
  }
  fs.writeFileSync(pageFile,
    PAGE.replace('SHADERS', '.vs-shaders.js').replace('ENGINE', '.vs-engine.js'), 'utf8');

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
      try { v.currentTime = 1; } catch {}
      return [v.videoWidth, v.videoHeight];
    })()`);

  const gpu = await win.webContents.executeJavaScript(`
    (() => { const c = document.createElement('canvas'); const gl = c.getContext('webgl2');
      const d = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown'; })()`);

  const rows = [];
  for (const scale of [1, 0.75, 0.5, 0.4]) {
    // eslint-disable-next-line no-await-in-loop
    rows.push(await win.webContents.executeJavaScript(costScript(scale, 24)));
  }

  console.log('\nEnhancement cost per frame (real shader chain)');
  console.log('gpu  :', gpu);
  console.log('clip :', path.basename(TEST_VIDEO), '\n');

  if (rows[0] && rows[0].unsupported) {
    console.log('  EXT_disjoint_timer_query_webgl2 is unavailable; GPU time cannot be measured here.');
  } else {
    console.log('scale'.padEnd(8) + 'render'.padEnd(14) + 'Mpx'.padEnd(8) +
      'cpuMs'.padEnd(9) + 'gpuMs'.padEnd(9) + 'budget@23.976');
    for (const r of rows) {
      console.log(String(r.scale).padEnd(8) + String(r.render).padEnd(14) +
        String(r.megapixels).padEnd(8) + String(r.cpuMs).padEnd(9) +
        String(r.gpuMs).padEnd(9) + '41.7 ms');
    }
    console.log('\nVerdict');
    for (const r of rows) {
      const pct = Math.round((r.gpuMs / 41.7) * 100);
      console.log(`  scale ${r.scale}: GPU ${r.gpuMs} ms = ${pct}% of a 23.976 fps frame budget ` +
        `(cpu timer said ${r.cpuMs} ms)`);
    }
  }

  try {
    fs.rmSync(pageFile, { force: true });
    for (const f of ['.vs-shaders.js', '.vs-engine.js']) fs.rmSync(path.join(dir, f), { force: true });
  } catch { /* best effort */ }
  app.exit(0);
}

app.whenReady().then(main).catch((err) => { console.error(err); app.exit(1); });
