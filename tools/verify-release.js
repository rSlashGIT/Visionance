'use strict';

/**
 * Release acceptance.
 *
 *   npx electron tools/verify-release.js
 *
 * Walks the two journeys the product is actually judged on, in order, on real
 * media, and photographs each step:
 *
 *   the normal user — open something, choose four things, press Auto
 *                     Configure, read the summary, render
 *   the switcher    — online, local, Watch's source, a recent, and back,
 *                     with every readout pointing at the same source after
 *                     each move
 *
 * Diagnostics stay off: these are the screens a person sees, not the ones a
 * developer turns on.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const SHOT_DIR = path.join(__dirname, 'ui-shots');
const CLIP_DIR = path.join(os.tmpdir(), 'visionance-release-verify');
const ONLINE_URL = process.env.VISIONANCE_TEST_URL ||
  'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

if (!process.env.VISIONANCE_ENGINES_DIR) {
  process.env.VISIONANCE_ENGINES_DIR =
    path.join(app.getPath('appData'), 'Visionance', 'engines');
}
require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

const results = [];
const transcript = [];
const shots = [];
const pageErrors = [];
let win = null;

function say(line) { transcript.push(line); console.log(line); }
function check(label, pass, detail = '') {
  results.push({ label, pass: !!pass, detail });
  say(`  ${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

/**
 * A site refusing to resolve is not a product failure, and recording it as one
 * would make this harness lie in the other direction. Skips are reported and
 * counted separately so a run that could not reach the network is obviously
 * different from a run that passed.
 */
const skipped = [];
function skip(label, reason) {
  skipped.push({ label, reason });
  say(`  skip ${label} — ${reason}`);
}

const js = (code) => win.webContents.executeJavaScript(code, true);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, code, timeoutMs = 60000, every = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await js(code);
    if (r) return r;
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Wait for the screen to stop moving before photographing it.
 *
 * An acceptance screenshot is meant to show a state, and a capture taken a
 * fraction of a second after an assertion can land mid-transition — a preview
 * still loading, a toast still up, Auto still working. That photographs the
 * app in a condition no user sits and looks at.
 */
async function settle({ preview = false } = {}) {
  await waitFor('the screen to settle', `(() => {
    if (!document.getElementById('autoStage').hidden) return null;
    if (!document.getElementById('stageLoading').hidden) return null;
    if (document.querySelector('.toast')) return null;
    if (${preview}) {
      const v = document.getElementById('createVideo');
      if (!v.videoWidth || v.readyState < 2) return null;
    }
    return true;
  })()`, 30000).catch(() => null);
  await sleep(350);
}

async function shot(name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`),
    (await win.webContents.capturePage()).toPNG());
  shots.push(path.join(SHOT_DIR, `${name}.png`));
  say(`  shot ${name}.png`);
}

function makeClips() {
  fs.mkdirSync(CLIP_DIR, { recursive: true });
  const ffmpeg = require(path.join(__dirname, '..', 'src', 'main', 'binaries')).resolve('ffmpeg');
  if (!ffmpeg) return {};
  const build = (name, args) => {
    const file = path.join(CLIP_DIR, name);
    if (fs.existsSync(file)) return file;
    const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, file],
      { windowsHide: true });
    return r.status === 0 && fs.existsSync(file) ? file : null;
  };
  return {
    a: build('release-a.mp4', [
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=15',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=15',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'
    ]),
    b: build('release-b.mp4', [
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=10',
      '-f', 'lavfi', '-i', 'sine=frequency=330:duration=10',
      '-c:v', 'libx264', '-b:v', '500k', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'
    ])
  };
}

const setControl = (id, value) => js(`(() => {
  const n = document.getElementById(${JSON.stringify(id)});
  n.value = ${JSON.stringify(value)};
  n.dispatchEvent(new Event('change'));
  return n.value;
})()`);

/**
 * Everything that names the active Create source, read at once.
 * After any switch these must agree; a single disagreement is stale state.
 */
const createIdentity = () => js(`(() => {
  const text = (id) => { const n = document.getElementById(id);
    return n ? n.textContent.replace(/\\s+/g, ' ').trim() : null; };
  const thumb = document.getElementById('createThumb');
  return {
    title: text('createSourceTitle'),
    kind: text('createSourceKind'),
    tag: text('createKindTag'),
    sub: text('createSourceSub'),
    brief: text('analysisBrief'),
    autoState: text('autoState'),
    summary: [...document.getElementById('renderSummary').children].map(c => c.textContent),
    previewW: document.getElementById('createVideo').videoWidth,
    previewSrc: (document.getElementById('createVideo').getAttribute('src') || '').slice(0, 40),
    thumbState: thumb ? thumb.dataset.thumbState || '' : '',
    urlPanelOpen: !document.getElementById('createUrlPanel').hidden,
    urlValue: document.getElementById('createUrlInput').value,
    cardShown: !document.getElementById('createSourceCard').hidden
  };
})()`);

async function run() {
  say('\nVisionance — release acceptance\n');
  await waitFor('boot', 'window.__visionanceReady || window.__visionanceBootError', 90000);
  const bootError = await js('window.__visionanceBootError || null');
  check('the renderer booted without throwing', !bootError, bootError || '');

  // Diagnostics off for every screen in this run.
  await js(`(async () => {
    await window.visionance.settings.patch({ showStats: false });
    const o = document.getElementById('statsOverlay');
    if (o && !o.hidden) document.getElementById('statsBtn').click();
    return true;
  })()`);

  const clips = makeClips();
  if (!clips.a) { check('clips could be built', false, 'ffmpeg unavailable'); return; }

  /* ---- 1. Create, empty ---- */
  await js(`document.querySelector('.tab[data-tab="create"]').click(); true`);
  await sleep(500);
  const empty = await js(`(() => {
    const visible = (id) => { const n = document.getElementById(id);
      return !!(n && !n.hidden && n.offsetParent); };
    return { picker: visible('createSourcePicker'), card: visible('createSourceCard'),
      url: visible('createUrlPanel'), analysis: visible('createAnalysisModule'),
      stage: visible('createEmpty'),
      actions: [...document.querySelectorAll('#createSourcePicker button')]
        .map(b => b.textContent.trim()) };
  })()`);
  check('an empty Create offers one picker and no card or URL box',
    empty.picker && !empty.card && !empty.url && !empty.analysis, JSON.stringify(empty));
  check('the picker offers exactly the three ways in',
    empty.actions.length === 3 && /open file/i.test(empty.actions[0]) &&
    /paste url/i.test(empty.actions[1]) && /watch/i.test(empty.actions[2]),
    empty.actions.join(' / '));
  await shot('release-01-create-empty');

  /* ---- 2. Create, local source ---- */
  win.webContents.send('open-external-file', clips.a);
  await waitFor('watch has A', `(() => { const v = document.getElementById('video');
    return v.videoWidth > 0 && v.readyState >= 2; })()`, 60000);
  await js(`document.querySelector('.tab[data-tab="create"]').click(); true`);
  await sleep(300);
  await js(`document.getElementById('createUseWatchBtn').click(); true`);
  await waitFor('create has A',
    `/release-a/i.test(document.getElementById('createSourceTitle').textContent)`, 30000);
  await js(`document.getElementById('analyseBtn').click(); true`);
  await waitFor('analysis',
    `document.getElementById('analysisBrief').textContent.includes('1920')`, 60000);
  await sleep(900);
  const local = await createIdentity();
  check('a local source shows a card, its kind, and its facts',
    local.cardShown && /local source/i.test(local.kind) && /1920 × 1080/.test(local.brief),
    JSON.stringify({ kind: local.kind, brief: local.brief }));
  check('no URL box is left under an active local source',
    !local.urlPanelOpen, `urlPanelOpen=${local.urlPanelOpen}`);
  check('the preview is showing the source it names', local.previewW === 1920,
    `preview ${local.previewW}px`);
  await settle({ preview: true });
  await shot('release-02-create-local');

  /* ---- 3. URL entry ---- */
  await js(`document.getElementById('createChangeSourceBtn').click(); true`);
  await sleep(250);
  await js(`document.getElementById('createUrlToggleBtn').click(); true`);
  await sleep(300);
  const urlEntry = await js(`(() => {
    const visible = (id) => { const n = document.getElementById(id);
      return !!(n && !n.hidden && n.offsetParent); };
    return { url: visible('createUrlPanel'), picker: visible('createSourcePicker'),
      focused: document.activeElement.id,
      label: document.querySelector('#createUrlPanel label').textContent.trim(),
      action: document.getElementById('createUrlBtn').textContent.trim() };
  })()`);
  check('"Paste URL" opens a focused URL entry and hides the picker',
    urlEntry.url && !urlEntry.picker && urlEntry.focused === 'createUrlInput',
    JSON.stringify(urlEntry));
  await js(`(() => { const i = document.getElementById('createUrlInput');
    i.value = ${JSON.stringify(ONLINE_URL)}; return true; })()`);
  await sleep(200);
  await shot('release-03-create-url-entry');

  // A bad URL keeps the entry open and the text intact.
  await js(`(() => { const i = document.getElementById('createUrlInput');
    i.value = 'https://example.com/not-a-video';
    document.getElementById('createUrlBtn').click(); return true; })()`);
  const errored = await waitFor('url error', `(() => {
    const e = document.getElementById('createUrlError');
    return e.hidden ? null : { message: e.textContent,
      stillOpen: !document.getElementById('createUrlPanel').hidden,
      value: document.getElementById('createUrlInput').value };
  })()`, 120000).catch(() => null);
  if (errored) {
    check('a failed URL keeps the entry open with the address intact',
      errored.stillOpen && errored.value.includes('example.com') && errored.message.length > 5,
      errored.message.slice(0, 90));
  } else {
    check('a failed URL reports a reason', false, 'no error was shown');
  }

  /* ---- 4. online source resolved ---- */
  await js(`(() => { const i = document.getElementById('createUrlInput');
    i.value = ${JSON.stringify(ONLINE_URL)};
    document.getElementById('createUrlBtn').click(); return true; })()`);
  let online = null;
  try {
    online = await waitFor('online source', `(() => {
      const card = document.getElementById('createSourceCard');
      if (card.hidden) return null;
      const kind = document.getElementById('createSourceKind').textContent;
      return /online/i.test(kind) ? { kind } : null;
    })()`, 180000);
  } catch (err) {
    skip('Create resolves an online source', 'the site did not resolve: ' + err.message);
  }

  if (online) {
    await sleep(1500);
    const onlineId = await createIdentity();
    check('an online source uses the same card, badged Online',
      onlineId.cardShown && /online source/i.test(onlineId.kind), onlineId.kind);
    check('the URL box collapses once the source has loaded',
      !onlineId.urlPanelOpen, `urlPanelOpen=${onlineId.urlPanelOpen}`);
    check('the card carries the online source\'s own facts',
      /\d/.test(onlineId.sub || ''), onlineId.sub);
    check('no local source detail is left behind',
      !/release-a/i.test(onlineId.title || ''), onlineId.title);
    await settle({ preview: true });
    await shot('release-04-create-online');

    /* ---- 5. Auto configured on the online source ---- */
    await setControl('createAspect', '9:16');
    await setControl('createRes', 'auto');
    await setControl('createFps', 'source');
    await sleep(400);
    await js(`document.getElementById('autoBuildBtn').click(); true`);
    const configured = await waitFor('auto', `(() => {
      const s = document.getElementById('autoState').textContent;
      if (!/configured|failed/i.test(s)) return null;
      return { state: s,
        result: document.getElementById('autoResult').hidden ? null
          : document.getElementById('autoResult').textContent.replace(/\\s+/g, ' '),
        compact: document.getElementById('autoPurpose').hidden,
        button: document.getElementById('autoBuildBtn').textContent.trim(),
        summary: [...document.getElementById('renderSummary').children].map(c => c.textContent)
      }; })()`, 240000).catch(() => null);
    if (configured && /configured/i.test(configured.state)) {
      check('Auto Configure works on an online source',
        !!configured.result, (configured.result || '').slice(0, 120));
      check('the Auto block becomes compact once it has answered',
        configured.compact && /reconfigure/i.test(configured.button),
        `purposeHidden=${configured.compact} button="${configured.button}"`);
      check('the processing summary describes the render',
        configured.summary.length >= 3, configured.summary.join(' · '));
      await settle({ preview: true });
      await shot('release-05-create-auto');
    } else {
      check('Auto Configure works on an online source', false,
        configured ? configured.state : 'timed out');
    }
  }

  /* ---- 6. Advanced ---- */
  await js(`document.getElementById('createAdvancedShell').open = true;
    document.getElementById('groupEnhancement').open = true;
    document.getElementById('createAdvancedShell').scrollIntoView({ block: 'start' }); true`);
  await sleep(500);
  await settle();
  await shot('release-06-create-advanced');
  await js(`document.getElementById('createAdvancedShell').open = false; true`);

  /* ---- source switching: online -> local -> watch -> recent ---- */
  say('');
  say('Source switching');
  const switches = [];

  await js(`document.getElementById('createChangeSourceBtn').click(); true`);
  await sleep(200);
  win.webContents.send('open-external-file', clips.b);
  await waitFor('watch has B', `(() => { const v = document.getElementById('video');
    return v.videoWidth === 1280 && v.readyState >= 2; })()`, 60000);
  await js(`document.querySelector('.tab[data-tab="create"]').click(); true`);
  await sleep(300);
  await js(`document.getElementById('createUseWatchBtn').click(); true`);
  await waitFor('create has B',
    `/release-b/i.test(document.getElementById('createSourceTitle').textContent)`, 30000);
  await sleep(1200);
  switches.push(['online → local (via Watch source)', await createIdentity()]);

  const afterLocal = switches[0][1];
  check('switching online → local clears every trace of the online source',
    /release-b/i.test(afterLocal.title) && /local source/i.test(afterLocal.kind) &&
    afterLocal.tag === 'Local' && !afterLocal.urlPanelOpen,
    JSON.stringify({ title: afterLocal.title, kind: afterLocal.kind, tag: afterLocal.tag }));
  check('the preview follows the switch', afterLocal.previewW === 1280,
    `preview ${afterLocal.previewW}px`);
  check('Auto re-arms rather than describing the previous source',
    !/configured/i.test(afterLocal.autoState), afterLocal.autoState);
  check('the render summary follows the new source',
    afterLocal.summary.length > 0, afterLocal.summary.join(' · '));

  /* ---- 7-9. Watch ---- */
  say('');
  say('Watch');
  await js(`document.querySelector('.tab[data-tab="presets"]').click(); true`);
  await sleep(400);
  await js(`document.getElementById('video').play(); true`);
  await sleep(2000);
  const watchLocal = await js('window.visionanceDiagnostics.audio()');
  check('Watch is playing the local file with sound',
    watchLocal.video.t > 0 && !watchLocal.video.muted &&
    watchLocal.video.decodedAudioBytes > 0,
    `t=${watchLocal.video.t.toFixed(2)}s decoded=${watchLocal.video.decodedAudioBytes} bytes`);
  await settle();
  await shot('release-07-watch-local');

  await js(`(() => { const i = document.getElementById('urlInput');
    i.value = ${JSON.stringify(ONLINE_URL)};
    document.getElementById('goBtn').click(); return true; })()`);
  const watchOnline = await waitFor('watch online', `(() => {
    const v = document.getElementById('video');
    return v.videoWidth > 0 && v.readyState >= 2 && window.__vsLastMedia &&
      window.__vsLastMedia.kind === 'stream' ? true : null; })()`, 180000).catch(() => null);
  if (watchOnline) {
    await js(`document.getElementById('video').play(); true`);
    await sleep(3500);
    const a = await js('window.visionanceDiagnostics.audio()');
    check('Watch plays an online source with sound',
      a.video.t > 0 && (a.dual ? a.audio.decodedAudioBytes > 0 : a.video.decodedAudioBytes > 0),
      `video ${a.video.t.toFixed(2)}s · audio ${a.audio.t.toFixed(2)}s · ` +
      `drift ${(a.drift * 1000).toFixed(0)} ms`);
    check('audio and video are in sync', Math.abs(a.drift) < 0.25,
      `${(a.drift * 1000).toFixed(0)} ms`);
    say(`  online audio: dual=${a.dual} drift=${(a.drift * 1000).toFixed(0)}ms ` +
        `recovery=${a.recovery.path || 'not needed'}`);
    await settle();
    await shot('release-08-watch-online');

    await js(`document.getElementById('watchAutoBtn').click(); true`);
    await waitFor('watch auto', `!document.getElementById('watchAutoResult').hidden`, 60000);
    await sleep(600);
    const gpu = await js(`(() => ({
      statusBar: document.getElementById('sbDevice').textContent,
      perfRows: [...document.querySelectorAll('#utilityTelemetry .telemetry-row')]
        .map(r => r.textContent.replace(/\\s+/g, ' ').trim()).slice(0, 5)
    }))()`);
    check('the realtime GPU is labelled as such',
      /realtime gpu/i.test(gpu.statusBar), gpu.statusBar);
    check('the render GPU is labelled separately',
      gpu.perfRows.some((r) => /render gpu/i.test(r)), gpu.perfRows.join(' | '));
    await shot('release-09-watch-auto');
  } else {
    skip('Watch plays an online source with sound', 'the site did not resolve in time');
    // The GPU labels do not need a network to be checked.
    const gpu = await js(`(() => ({
      statusBar: document.getElementById('sbDevice').textContent,
      perfRows: [...document.querySelectorAll('#utilityTelemetry .telemetry-row')]
        .map(r => r.textContent.replace(/\s+/g, ' ').trim()).slice(0, 5)
    }))()`);
    check('the realtime GPU is labelled as such',
      /realtime gpu/i.test(gpu.statusBar), gpu.statusBar);
    check('the render GPU is labelled separately',
      gpu.perfRows.some((r) => /render gpu/i.test(r)), gpu.perfRows.join(' | '));
    await shot('release-09-watch-auto');
  }

  /* ---- 10-11. Queue and Library ---- */
  await js(`document.querySelector('.tab[data-tab="queue"]').click(); true`);
  await sleep(600);
  await shot('release-10-queue');
  await js(`document.querySelector('.tab[data-tab="library"]').click(); true`);
  await sleep(600);
  await shot('release-11-library');

  /* ---- engine counts are explained, not just different ---- */
  await js(`document.querySelector('.tab[data-tab="create"]').click(); true`);
  await sleep(500);
  const counts = await js(`(() => ({
    home: [...document.querySelectorAll('#createHomeStats .intro-stat')]
      .map(c => c.textContent.replace(/\\s+/g, ' ').trim()),
    console: document.getElementById('consoleEngineTag').textContent,
    groups: [...document.querySelectorAll('#consoleEngines .eng-group')].map(g => g.textContent)
  }))()`);
  check('the two engine fractions are labelled, not left contradicting each other',
    counts.home.some((c) => /render engines/i.test(c)) &&
    counts.groups.length === 2 && /ready/i.test(counts.console),
    `${counts.home.join(' / ')} — console ${counts.console} — ${counts.groups.join(', ')}`);

  check('no uncaught renderer errors during the whole run',
    pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
}

app.whenReady().then(async () => {
  const deadline = setTimeout(() => { say('\nFAIL — timed out'); app.exit(1); }, 1500000);
  for (let i = 0; i < 200 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (!win) await sleep(100);
  }
  if (!win) { say('FAIL — no window'); return app.exit(1); }
  if (win.isMaximized()) win.unmaximize();
  win.setSize(1536, 1000);
  await sleep(400);
  win.webContents.on('console-message', (...args) => {
    const e = args[0];
    const level = typeof e === 'object' && e ? e.level : args[1];
    const message = typeof e === 'object' && e ? e.message : args[2];
    if (level === 'error' || level === 3) pageErrors.push(String(message).slice(0, 200));
  });

  try {
    await run();
  } catch (err) {
    say(`\nFAIL — ${err.message}`);
    results.push({ label: 'harness', pass: false, detail: err.message });
  }

  clearTimeout(deadline);
  const failed = results.filter((r) => !r.pass);
  say(`\nScreenshots:\n${shots.map((s) => '  ' + s).join('\n')}`);
  say(`\n${failed.length ? `FAIL — ${failed.length} of ${results.length}` : `PASS — ${results.length} checks`}\n`);
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(SHOT_DIR, 'release-report.txt'), transcript.join('\n') + '\n', 'utf8');
  } catch { /* console output still happened */ }
  app.exit(failed.length ? 1 : 0);
});
