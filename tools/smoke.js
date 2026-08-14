/**
 * End-to-end boot smoke test.
 *
 * Boots the real application (main process, custom protocol, preload bridge,
 * renderer) and asserts that the pieces actually came up: the IPC bridge is
 * exposed, the renderer scripts loaded, the WebGL engine initialised, and the
 * UI rendered. Writes a screenshot so the result can be eyeballed.
 *
 *   xvfb-run -a npx electron tools/smoke.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.argv.push('--dev-smoke');

const { app, BrowserWindow } = require('electron');

/**
 * Run against a throwaway user-data folder.
 *
 * Two reasons, both learned the hard way:
 *   - the real app holds a single-instance lock on its user-data folder, so if
 *     Visionance is open this harness used to quit instantly and print nothing,
 *     which looks far too much like a pass
 *   - a test render should never land in the user's real queue
 *
 * Binaries and AI engines are expensive to install, so those are still read
 * from the real installation through the two env overrides below.
 */
const REAL_USER_DATA = path.join(app.getPath('appData'), 'Visionance');
const SMOKE_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'visionance-smoke-'));
app.setName('Visionance');
app.setPath('userData', SMOKE_USER_DATA);
if (!process.env.VISIONANCE_BIN_DIR) {
  process.env.VISIONANCE_BIN_DIR = path.join(REAL_USER_DATA, 'bin');
}
if (!process.env.VISIONANCE_ENGINES_DIR) {
  process.env.VISIONANCE_ENGINES_DIR = path.join(REAL_USER_DATA, 'engines');
}

require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

const CHECK = `
(async () => {
  const out = { errors: [] };
  out.bridge = typeof window.visionance === 'object' && window.visionance !== null;
  out.bridgeMethods = out.bridge ? Object.keys(window.visionance).sort() : [];
  out.shaders = typeof window.VSShaders === 'object';
  out.enginePresent = typeof window.VSEngine === 'object';
  out.presets = window.VSPresets ? window.VSPresets.BUILTIN.length : 0;

  const canvas = document.getElementById('glCanvas');
  out.canvas = !!canvas;
  out.glContext = !!(canvas && canvas.getContext('webgl2'));

  out.presetCards = document.querySelectorAll('.preset-card').length;
  out.sliders = document.querySelectorAll('.ctrl input[type=range]').length;
  out.tabs = document.querySelectorAll('.tab').length;
  out.tabNames = [...document.querySelectorAll('.tab')].map(t => t.dataset.tab);
  out.emptyStateVisible = !document.getElementById('stageEmpty').hidden;
  out.platformOptions = document.getElementById('createPlatform').options.length;
  out.aiControls = !!(document.getElementById('createAi') &&
    document.getElementById('createInterp') &&
    document.getElementById('createAiModel'));
  // An engine that is not installed must leave its options disabled rather
  // than offering a button that silently does something classical.
  out.aiOptionsGated = [...document.getElementById('createAi').options]
    .filter(o => o.value !== 'off').every(o => typeof o.disabled === 'boolean');
  out.bootError = window.__visionanceBootError || null;

  // Exercise the IPC surface the same way the UI does on boot.
  try {
    const info = await window.visionance.app.info();
    out.appInfo = info.ok;
    out.appVersion = info.version;
    out.ffmpeg = info.binaries.ffmpeg.path ? 'found' : 'missing';
    out.ytdlp = info.binaries.ytdlp.path ? 'found' : 'missing';
  } catch (e) { out.errors.push('app.info failed: ' + e.message); }

  try {
    const s = await window.visionance.settings.get();
    out.settings = s.ok;
  } catch (e) { out.errors.push('settings.get failed: ' + e.message); }

  try {
    const r = await window.visionance.presets.get();
    out.presetStore = r.ok;
  } catch (e) { out.errors.push('presets.get failed: ' + e.message); }

  // The session-1 backend surface: analysis, recipes, jobs, capabilities.
  try {
    const r = await window.visionance.jobs.list();
    out.jobsList = r.ok && Array.isArray(r.jobs);
  } catch (e) { out.errors.push('jobs.list failed: ' + e.message); }

  try {
    const r = await window.visionance.recipe.default(null, {});
    out.recipeSchema = r.ok ? r.recipe.schemaVersion : null;
    out.recipeSections = r.ok ? Object.keys(r.recipe).sort().join(',') : '';
  } catch (e) { out.errors.push('recipe.default failed: ' + e.message); }

  try {
    const r = await window.visionance.recipe.sanitize({ output: { quality: 9999, path: 'x.mp4' } });
    out.recipeClamped = r.ok && r.recipe.output.quality === 100;
  } catch (e) { out.errors.push('recipe.sanitize failed: ' + e.message); }

  try {
    const r = await window.visionance.media.analyze('not-an-absolute-path');
    // A bad input must come back as a structured refusal, not a crash.
    out.analysisRejects = r.ok === false && typeof r.code === 'string';
  } catch (e) { out.errors.push('media.analyze threw instead of failing cleanly: ' + e.message); }

  try {
    const r = await window.visionance.engines.status();
    out.engineIds = r.ok ? Object.keys(r.engines).sort().join(',') : '';
    out.engineStatuses = r.ok ? Object.values(r.engines).map(e => e.status).join(',') : '';
    // Whatever the state, an engine must never claim to be ready without models.
    out.enginesHonest = r.ok && Object.values(r.engines)
      .every(e => e.status !== 'ready' || (e.models && e.models.length > 0));
  } catch (e) { out.errors.push('engines.status failed: ' + e.message); }

  try {
    const r = await window.visionance.runtime.status();
    out.runtimes = r.ok ? r.runtimes.length : -1;
  } catch (e) { out.errors.push('runtime.status failed: ' + e.message); }

  try {
    const r = await window.visionance.app.capabilities();
    out.capabilities = r.ok && !!r.capabilities.os.platform;
    out.hwEncoders = r.ok ? r.capabilities.ffmpeg.hardwareEncoders.length : -1;
  } catch (e) { out.errors.push('app.capabilities failed: ' + e.message); }

  // Switch tabs to make sure every panel renders without throwing.
  for (const tab of document.querySelectorAll('.tab')) tab.click();
  out.tabsClicked = true;

  // Toggle the interactive affordances.
  document.getElementById('enhanceToggle').click();
  document.getElementById('enhanceToggle').click();
  document.getElementById('compareBtn').click();
  out.compareOn = !document.getElementById('splitHandle').hidden;
  document.getElementById('compareBtn').click();
  document.getElementById('statsBtn').click();
  out.statsOn = !document.getElementById('statsOverlay').hidden;
  document.getElementById('statsBtn').click();

  document.querySelector('.tab[data-tab="presets"]').click();
  return out;
})()
`;

const pageErrors = [];

/**
 * Electron 37 replaced the `console-message` signature.
 *   old: (event, level:number, message:string, line, sourceId)
 *   new: (event:{level:'info'|'warning'|'error'|'debug', message, ...})
 * Accept both so this harness runs against either.
 */
function normaliseConsoleMessage(args) {
  const [first, second, third] = args;
  if (first && typeof first === 'object' && 'message' in first) {
    return { level: first.level, message: String(first.message ?? '') };
  }
  return { level: second, message: String(third ?? '') };
}

const isError = (level) =>
  typeof level === 'number' ? level >= 2 : level === 'error';

app.whenReady().then(() => {
  setTimeout(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      // Boot does real work (probing binaries, engines, encoders); waiting for
      // it to finish is far more reliable than a fixed delay.
      await win.webContents.executeJavaScript(`
        new Promise((resolve) => {
          const started = Date.now();
          const tick = () => {
            if (window.__visionanceReady || window.__visionanceBootError ||
                Date.now() - started > 30000) return resolve(true);
            setTimeout(tick, 100);
          };
          tick();
        })
      `, true).catch(() => {});
    }
    if (!win) {
      console.error('FAIL: no window was created');
      app.exit(1);
      return;
    }

    win.webContents.on('console-message', (...args) => {
      const { level, message } = normaliseConsoleMessage(args);
      if (isError(level) && !/Security Warning/.test(message)) pageErrors.push(message);
    });
    win.webContents.on('preload-error', (_e, p, err) => {
      pageErrors.push(`preload ${p}: ${err.message}`);
    });

    let result;
    try {
      result = await win.webContents.executeJavaScript(CHECK, true);
    } catch (err) {
      console.error('FAIL: renderer check threw:', err.message);
      app.exit(1);
      return;
    }

    // Optional playback phase: VISIONANCE_TEST_VIDEO=/path/to/clip.mp4
    // Proves the vs:// media route, decoding, texture upload and the render
    // loop all work together, not just that the UI drew itself.
    let playback = null;
    const testVideo = process.env.VISIONANCE_TEST_VIDEO;
    if (testVideo && fs.existsSync(testVideo)) {
      win.webContents.send('open-external-file', testVideo);
      await new Promise((r) => setTimeout(r, 4000));
      playback = await win.webContents.executeJavaScript(`
        (async () => {
          const v = document.getElementById('video');
          const c = document.getElementById('glCanvas');
          const stage = document.getElementById('stageInner').getBoundingClientRect();

          // Force an explicit 2x render scale so the upscale assertion does not
          // depend on how large the window happens to be in this environment.
          // Adaptive quality is switched off first: this harness runs on a
          // software rasteriser, which would legitimately throttle the scale.
          const adaptive = document.getElementById('adaptiveToggle');
          adaptive.checked = false;
          adaptive.dispatchEvent(new Event('change'));

          const sel = document.getElementById('scaleSelect');
          sel.value = '2';
          sel.dispatchEvent(new Event('change'));
          await new Promise(r => setTimeout(r, 800));
          const forced = { w: c.width, h: c.height };
          sel.value = 'auto';
          sel.dispatchEvent(new Event('change'));
          adaptive.checked = true;
          adaptive.dispatchEvent(new Event('change'));

          return {
            stageWidth: Math.round(stage.width),
            stageHeight: Math.round(stage.height),
            forcedWidth: forced.w,
            forcedHeight: forced.h,
            readyState: v.readyState,
            videoWidth: v.videoWidth,
            videoHeight: v.videoHeight,
            currentTime: v.currentTime,
            paused: v.paused,
            duration: v.duration,
            canvasWidth: c.width,
            canvasHeight: c.height,
            canvasVisible: !c.classList.contains('hidden'),
            resBadge: document.getElementById('resBadge').textContent,
            emptyHidden: document.getElementById('stageEmpty').hidden,
            loadingHidden: document.getElementById('stageLoading').hidden
          };
        })()
      `, true);
    }

    // Optional online phase: resolves a real public URL and proves the picture
    // AND the sound actually run. "yt-dlp returned JSON" is not playback, and
    // a split video/audio pair can look fine while being silent.
    let online = null;
    const testUrl = process.env.VISIONANCE_TEST_URL;
    if (testUrl) {
      online = await win.webContents.executeJavaScript(`
        (async () => {
          const v = document.getElementById('video');
          const a = document.getElementById('audio');
          document.getElementById('urlInput').value = ${JSON.stringify(testUrl)};

          // Resolve exactly once, through the UI, the way a user does. Doing a
          // separate api.media.resolveUrl() first doubled every request to the
          // site and made this test a good way to get rate-limited.
          const started = await new Promise((resolve) => {
            let settled = false;
            const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
            v.addEventListener('playing', () => done(true), { once: true });
            v.addEventListener('error', () => done(false), { once: true });
            setTimeout(() => done(false), 45000);
            document.getElementById('goBtn').click();
          });
          const res = window.__vsLastMedia;
          if (!res) return { step: 'resolve', error: 'the URL never resolved', code: 'NO_MEDIA' };

          // Let it run so we can see the clocks actually advance.
          const t0 = v.currentTime;
          const a0 = a.currentTime;
          await new Promise((r) => setTimeout(r, 4000));
          const a1 = a.currentTime;

          return {
            step: 'done',
            resolved: true,
            title: res.title,
            muxed: res.muxed,
            usedAuth: res.usedAuth,
            split: !!res.audioUrl,
            warnings: res.warnings || [],
            started,
            videoWidth: v.videoWidth,
            videoHeight: v.videoHeight,
            readyState: v.readyState,
            t0,
            t1: v.currentTime,
            advanced: v.currentTime > t0 + 0.3,
            videoError: v.error ? v.error.code : null,
            audioReadyState: res.audioUrl ? a.readyState : null,
            audioTime: res.audioUrl ? a.currentTime : null,
            // Advancement, not the instantaneous paused flag: the player
            // legitimately pauses the audio element for a moment whenever the
            // video stalls, and catching that instant is not a failure.
            audioAdvanced: res.audioUrl ? (a1 - a0) > 0.3 : null,
            audioDrift: res.audioUrl ? Math.round((a1 - v.currentTime) * 1000) : null,
            audioError: res.audioUrl && a.error ? a.error.code : null
          };
        })()
      `, true);
      // Stop network activity before the rest of the checks.
      await win.webContents.executeJavaScript(
        `document.getElementById('video').pause(); document.getElementById('audio').pause(); true`
      );
    }

    // Optional Create phase: drives a real render entirely through the preload
    // bridge, so the renderer -> IPC -> job system -> ffmpeg -> verification
    // path is proven, not just the pieces in isolation.
    let render = null;
    if (testVideo && fs.existsSync(testVideo)) {
      const outPath = path.join(os.tmpdir(), `visionance-smoke-${Date.now()}.mp4`);
      render = await win.webContents.executeJavaScript(`
        (async () => {
          const api = window.visionance;
          const analysed = await api.media.analyze(${JSON.stringify(testVideo)}, { deep: false });
          if (!analysed.ok) return { step: 'analyze', error: analysed.message };

          const built = await api.recipe.default(analysed.analysis, {
            output: { path: ${JSON.stringify(outPath)}, quality: 40, encoder: 'libx264', preset: 'ultrafast' },
            trim: { startSeconds: 0, endSeconds: 2 }
          });
          if (!built.ok) return { step: 'recipe', error: built.message };

          const created = await api.jobs.create({ recipe: built.recipe, analysis: analysed.analysis });
          if (!created.ok) return { step: 'create', error: created.message };

          const finished = await new Promise((resolve) => {
            const off = api.jobs.onUpdate((job) => {
              if (job.id !== created.job.id) return;
              if (['completed', 'failed', 'cancelled'].includes(job.status)) { off(); resolve(job); }
            });
            setTimeout(() => { off(); resolve(null); }, 90000);
          });
          const result = {
            step: 'done',
            analysisWidth: analysed.analysis.video.width,
            status: finished && finished.status,
            verified: !!(finished && finished.verification && finished.verification.ok),
            error: finished && finished.error ? finished.error.message : null,
            outputPath: ${JSON.stringify(outPath)}
          };
          // Do not leave a test render sitting in the user's real queue.
          if (finished) await api.jobs.remove(finished.id);
          return result;
        })()
      `, true);
    }

    const shotPath = path.join(__dirname, '..', 'tools', 'smoke-screenshot.png');
    try {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(shotPath, image.toPNG());
    } catch { /* screenshot is a nicety */ }

    const assertions = [
      ['preload bridge exposed', result.bridge],
      ['shader module loaded', result.shaders],
      ['engine module loaded', result.enginePresent],
      ['WebGL2 context created', result.glContext],
      ['built-in presets defined', result.presets >= 8],
      ['preset cards rendered', result.presetCards >= 8],
      ['fine tune sliders rendered', result.sliders >= 15],
      ['create/watch/queue/library tabs rendered',
        result.tabs === 4 &&
        (result.tabNames || []).join(',') === 'create,presets,queue,library'],
      ['empty state visible', result.emptyStateVisible],
      ['platform targets populated', result.platformOptions >= 5],
      ['app.info over IPC', result.appInfo === true],
      ['settings over IPC', result.settings === true],
      ['presets over IPC', result.presetStore === true],
      ['job queue over IPC', result.jobsList === true],
      ['current recipe schema over IPC', result.recipeSchema === 2],
      ['recipe sanitisation clamps values', result.recipeClamped === true],
      ['bad analysis input fails cleanly', result.analysisRejects === true],
      ['capability report over IPC', result.capabilities === true],
      ['AI engine status over IPC', result.engineIds === 'realesrgan,rife'],
      ['no engine claims ready without models', result.enginesHonest === true],
      ['JavaScript runtime discovery over IPC', result.runtimes >= 0],
      ['AI controls present in Create', result.aiControls === true],
      ['compare toggles on', result.compareOn === true],
      ['stats overlay toggles on', result.statsOn === true],
      ['no renderer errors', pageErrors.length === 0 && result.errors.length === 0]
    ];

    if (playback) {
      assertions.push(
        ['test clip decoded', playback.readyState >= 2 && playback.videoWidth > 0],
        ['playback advanced', playback.currentTime > 0.1],
        ['loading overlay cleared', playback.loadingHidden === true],
        ['empty state dismissed', playback.emptyHidden === true],
        ['canvas revealed', playback.canvasVisible === true],
        ['engine rendered frames', playback.canvasWidth > 0 && playback.canvasHeight > 0],
        ['never renders below source resolution',
          playback.canvasWidth >= playback.videoWidth && playback.canvasHeight >= playback.videoHeight],
        ['2x render scale upscales',
          playback.forcedWidth >= playback.videoWidth * 1.9 &&
          playback.forcedHeight >= playback.videoHeight * 1.9],
        ['resolution badge populated', /→/.test(playback.resBadge)]
      );
    }

    if (online) {
      assertions.push(
        ['online URL resolves', online.resolved === true],
        ['online stream starts playing', online.started === true],
        ['online video decodes', online.videoWidth > 0 && online.readyState >= 2],
        ['online playback clock advances', online.advanced === true],
        ['no media error on the video element', online.videoError === null]
      );
      if (online.split) {
        assertions.push(
          ['separate audio track decodes', online.audioReadyState >= 2],
          ['separate audio track is running', online.audioAdvanced === true],
          ['separate audio stays in sync with video', Math.abs(online.audioDrift) < 400],
          ['no media error on the audio element', online.audioError === null]
        );
      }
    }

    if (render) {
      assertions.push(
        ['source analysed over IPC', render.analysisWidth > 0],
        ['render job reaches completed', render.status === 'completed'],
        ['render output passes verification', render.verified === true],
        ['render output exists on disk', !!render.outputPath && fs.existsSync(render.outputPath)]
      );
      try { fs.rmSync(render.outputPath, { force: true }); } catch { /* best effort */ }
    }

    console.log(`\nVisionance ${result.appVersion} boot smoke test`);
    console.log(`bridge namespaces : ${result.bridgeMethods.join(', ')}`);
    console.log(`ffmpeg            : ${result.ffmpeg}`);
    console.log(`yt-dlp            : ${result.ytdlp}`);
    console.log(`tabs              : ${(result.tabNames || []).join(', ')}`);
    console.log(`hw encoders       : ${result.hwEncoders}`);
    console.log(`ai engines        : ${result.engineStatuses || 'n/a'}`);
    console.log(`js runtimes       : ${result.runtimes}`);
    console.log(`screenshot        : ${fs.existsSync(shotPath) ? shotPath : 'not captured'}`);
    if (playback) {
      console.log(`playback          : ${playback.videoWidth}x${playback.videoHeight} source -> ` +
        `${playback.canvasWidth}x${playback.canvasHeight} auto / ${playback.forcedWidth}x${playback.forcedHeight} at 2x, ` +
        `t=${playback.currentTime.toFixed(2)}s badge="${playback.resBadge}"`);
      console.log(`stage box         : ${playback.stageWidth}x${playback.stageHeight}`);
    }
    if (online) {
      if (online.step === 'resolve') {
        console.log(`online            : resolve failed ${online.code} — ${online.error}`);
      } else {
        console.log(`online            : "${online.title}" ${online.videoWidth}x${online.videoHeight} ` +
          `${online.split ? 'split a/v' : 'muxed'} auth=${online.usedAuth} ` +
          `t ${online.t0.toFixed(2)}s→${online.t1.toFixed(2)}s` +
          (online.split ? ` audio t=${Number(online.audioTime).toFixed(2)}s drift=${online.audioDrift}ms` : ''));
        if (online.warnings.length) console.log(`online warnings   : ${online.warnings.join(' | ')}`);
      }
    }
    if (render) {
      console.log(`create render     : step=${render.step} status=${render.status || 'none'} ` +
        `verified=${render.verified}${render.error ? ` error="${render.error}"` : ''}`);
    }
    console.log('');

    let ok = true;
    for (const [label, pass] of assertions) {
      if (!pass) ok = false;
      console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}`);
    }
    if (pageErrors.length) {
      console.log('\nRenderer errors:');
      pageErrors.forEach((e) => console.log('  - ' + e));
    }
    if (result.bootError) console.log('\nBoot error: ' + result.bootError);
    if (result.errors.length) {
      console.log('\nCheck errors:');
      result.errors.forEach((e) => console.log('  - ' + e));
    }

    console.log(`\n${ok ? 'PASS' : 'FAIL'}`);
    try { fs.rmSync(SMOKE_USER_DATA, { recursive: true, force: true }); } catch { /* best effort */ }
    app.exit(ok ? 0 : 1);
  }, 2500);
});
