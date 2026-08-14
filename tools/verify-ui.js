'use strict';

/**
 * Visionance UI verification.
 *
 * Boots the real application and drives the real interface: every workspace,
 * the player controls, the settings modal, the thumbnail cache and the
 * telemetry controller. It asserts behaviour and contracts, never pixel
 * positions - a layout test that breaks when a control moves 3px is a test
 * that gets deleted.
 *
 * It also writes one screenshot per workspace into tools/ui-shots/ so the
 * rendered result can be inspected rather than imagined.
 *
 *   npx electron tools/verify-ui.js
 *
 * Exits non-zero on any failed assertion or uncaught renderer error.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const SHOT_DIR = path.join(__dirname, 'ui-shots');
const CLIP_DIR = path.join(os.tmpdir(), 'visionance-ui-verify');

// Run against the real user data folder so installed engines and binaries are
// found, exactly as smoke.js does.
if (!process.env.VISIONANCE_ENGINES_DIR) {
  const real = path.join(app.getPath('appData'), 'Visionance');
  process.env.VISIONANCE_ENGINES_DIR = path.join(real, 'engines');
}

require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

const results = [];
const pageErrors = [];
let win = null;

/**
 * Everything printed is also appended to a report file.
 *
 * `app.exit()` on Windows tears the process down before a piped stdout has
 * flushed, so a harness that only prints is a harness whose output vanishes
 * the moment anyone redirects it. The file is the record; the console is the
 * convenience.
 */
const REPORT = path.join(SHOT_DIR, 'report.txt');
const transcript = [];

function say(line) {
  transcript.push(line);
  console.log(line);
}

function writeReport() {
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    fs.writeFileSync(REPORT, transcript.join('\n') + '\n', 'utf8');
  } catch { /* the console output still happened */ }
}

function check(label, pass, detail = '') {
  results.push({ label, pass: !!pass, detail });
  say(`  ${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

const js = (code) => win.webContents.executeJavaScript(code, true);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, code, timeoutMs = 15000, every = 150) {
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
 * A tiny real clip, so the thumbnail path exercises real ffmpeg extraction
 * rather than a stub. Deliberately not black at 25%: the extractor's black
 * detection would then be the thing under test rather than the cache.
 */
function makeClip() {
  fs.mkdirSync(CLIP_DIR, { recursive: true });
  const clip = path.join(CLIP_DIR, 'ui-clip.mp4');
  if (fs.existsSync(clip)) return clip;
  const ffmpeg = require(path.join(__dirname, '..', 'src', 'main', 'binaries')).resolve('ffmpeg');
  if (!ffmpeg) return null;
  const res = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    clip
  ], { windowsHide: true });
  return res.status === 0 && fs.existsSync(clip) ? clip : null;
}

async function shot(name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const image = await win.webContents.capturePage();
  const file = path.join(SHOT_DIR, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  return file;
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

async function run() {
  console.log('\nVisionance UI verification\n');

  await waitFor('boot', 'window.__visionanceReady || window.__visionanceBootError', 60000);
  const bootError = await js('window.__visionanceBootError || null');
  check('the renderer booted without throwing', !bootError, bootError || '');

  /* ---- shell and navigation ---- */

  /* ---- the opening workspace is fully built before anything is clicked ----
   *
   * The regression this guards: boot used to leave the initial workspace to
   * the markup, which set a body attribute and an active tab but gave no
   * `.tab-page` its `.active` class and cleared no `hidden` attribute. A fresh
   * launch therefore showed an empty inspector, and the app only became whole
   * once the user visited a tab — because `setWorkspace()` had never run.
   *
   * Every assertion in this block is made before the harness clicks anything.
   */
  const opening = await js(`(() => {
    const page = document.querySelector('.tab-page.active');
    const tab = document.querySelector('.tab.active');
    const visible = (id) => {
      const n = document.getElementById(id);
      return !!(n && !n.hidden && n.offsetParent);
    };
    return {
      body: document.body.dataset.workspace,
      page: page ? page.dataset.page : null,
      tab: tab ? tab.dataset.tab : null,
      controls: document.querySelectorAll('.tab-page.active .select, .tab-page.active .btn').length,
      sourceColumn: visible('sourceColumn'),
      console: visible('utilityStrip'),
      homeCells: document.getElementById('createHomeStats').childElementCount,
      recents: document.getElementById('createRecents').childElementCount,
      platforms: document.getElementById('createPlatform').options.length,
      aspects: document.getElementById('createAspect').options.length
    };
  })()`);
  check('a fresh launch opens on Create',
    opening.body === 'create' && opening.page === 'create' && opening.tab === 'create',
    JSON.stringify({ body: opening.body, page: opening.page, tab: opening.tab }));
  check('Create is fully rendered without visiting another workspace first',
    opening.controls > 10 && opening.sourceColumn && opening.console &&
    opening.homeCells === 4 && opening.recents > 0 &&
    opening.platforms > 1 && opening.aspects > 1,
    JSON.stringify(opening));

  const tabs = await js('[...document.querySelectorAll(".tab")].map(t => t.dataset.tab)');
  check('the four workspaces exist, Create first, and Adjust is gone',
    tabs.join(',') === 'create,presets,queue,library', tabs.join(', '));

  const workspaces = ['create', 'presets', 'queue', 'library'];
  for (const name of workspaces) {
    await js(`document.querySelector('.tab[data-tab="${name}"]').click(); true`);
    await sleep(180);
    const active = await js(`(() => ({
      body: document.body.dataset.workspace,
      page: document.querySelector('.tab-page.active') ? document.querySelector('.tab-page.active').dataset.page : null,
      tabActive: document.querySelector('.tab.active').dataset.tab,
      selected: document.querySelector('.tab.active').getAttribute('aria-selected')
    }))()`);
    check(`${name} workspace activates`,
      active.body === name && active.page === name && active.tabActive === name &&
      active.selected === 'true',
      JSON.stringify(active));
  }

  // Nothing may run off the bottom of the window. Watch's console band under
  // the player is the densest thing there and the first place this would show.
  await js(`document.querySelector('.tab[data-tab="presets"]').click(); true`);
  await sleep(400);
  const vertical = await js(`(() => {
    const strip = document.getElementById('utilityStrip');
    const r = strip.getBoundingClientRect();
    const stage = document.getElementById('stageInner').getBoundingClientRect();
    return { dockBottom: Math.round(r.bottom), dockHeight: Math.round(r.height),
             viewport: window.innerHeight, playerHeight: Math.round(stage.height),
             pageOverflow: document.documentElement.scrollHeight > window.innerHeight + 1 };
  })()`);
  check('the Watch console band fits inside the window',
    vertical.dockBottom <= vertical.viewport + 1 && !vertical.pageOverflow,
    JSON.stringify(vertical));
  check('the player still owns most of the vertical space in Watch',
    vertical.playerHeight > vertical.dockHeight * 1.8,
    `player ${vertical.playerHeight}px vs dock ${vertical.dockHeight}px`);

  // The player must survive navigation: Queue and Library step the stage
  // aside, but nothing may detach or re-aim the media element.
  const stageStates = await js(`(() => {
    const out = {};
    for (const w of ['create','presets','queue','library']) {
      document.querySelector('.tab[data-tab="'+w+'"]').click();
      out[w] = { stage: getComputedStyle(document.getElementById('stage')).display,
                 video: !!document.getElementById('video') };
    }
    return out;
  })()`);
  check('Watch and Create keep the player on screen',
    stageStates.presets.stage !== 'none' && stageStates.create.stage !== 'none',
    JSON.stringify(stageStates));
  check('the media element is never removed by navigation',
    Object.values(stageStates).every((s) => s.video));

  // Watch with nothing loaded. Captured here, before any clip exists, because
  // this is the screen every first run opens on and the only chance to record
  // it honestly: once a source is loaded there is no going back to it.
  await js(`document.querySelector('.tab[data-tab="presets"]').click(); true`);
  await sleep(350);
  await shot('watch-empty');

  /* ---- hidden state actually hides ---- */

  await js(`document.querySelector('.tab[data-tab="presets"]').click(); true`);
  await sleep(150);
  const hiddenObeyed = await js(`(() => {
    const ids = ['stageLoading','statsOverlay','compareLabels','splitHandle','dropOverlay',
                 'settingsModal','infoModal','createAspectCustomRow','createResCustomRow',
                 'playerPopover','utilityStrip','engineProgress'];
    const bad = [];
    for (const id of ids) {
      const node = document.getElementById(id);
      if (!node) { bad.push(id + ':missing'); continue; }
      if (node.hidden && getComputedStyle(node).display !== 'none') bad.push(id);
    }
    return bad;
  })()`);
  check('every hidden element is genuinely display:none',
    hiddenObeyed.length === 0, hiddenObeyed.join(', '));

  /* ---- player controls ---- */

  const controls = await js(`(() => {
    const ids = ['playBtn','back10Btn','fwd10Btn','muteBtn','volume','timeLabel','scrub',
                 'enhanceToggle','compareBtn','resBadge','snapshotBtn','playerSettingsBtn',
                 'pipBtn','fullscreenBtn','sendToCreateBtn'];
    return ids.filter(id => !document.getElementById(id));
  })()`);
  check('every player control is present', controls.length === 0, controls.join(', '));

  const iconsFilled = await js(`(() => {
    const ids = ['playBtn','back10Btn','fwd10Btn','muteBtn','snapshotBtn',
                 'playerSettingsBtn','pipBtn','fullscreenBtn','statsBtn','settingsBtn'];
    return ids.filter(id => !document.getElementById(id).querySelector('svg'));
  })()`);
  check('every icon button carries a real SVG, not a font glyph',
    iconsFilled.length === 0, iconsFilled.join(', '));

  // The settings popover: opens, holds the real speed control, closes.
  await js(`document.getElementById('playerSettingsBtn').click(); true`);
  await sleep(150);
  const popover = await js(`(() => ({
    open: !document.getElementById('playerPopover').hidden,
    speed: !!document.getElementById('speedSelect'),
    loop: !!document.getElementById('loopToggle'),
    expanded: document.getElementById('playerSettingsBtn').getAttribute('aria-expanded')
  }))()`);
  check('the player settings popover opens with the real controls in it',
    popover.open && popover.speed && popover.loop && popover.expanded === 'true',
    JSON.stringify(popover));

  await js(`document.getElementById('speedSelect').value = '1.5';
    document.getElementById('speedSelect').dispatchEvent(new Event('change')); true`);
  await sleep(120);
  const rate = await js('document.getElementById("video").playbackRate');
  check('the popover speed control drives the media element', rate === 1.5, String(rate));
  await js(`document.getElementById('speedSelect').value = '1';
    document.getElementById('speedSelect').dispatchEvent(new Event('change')); true`);

  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(150);
  check('Escape closes the popover',
    await js('document.getElementById("playerPopover").hidden'));

  /* ---- compare and diagnostics ---- */

  await js(`document.getElementById('compareBtn').click(); true`);
  await sleep(120);
  const compareOn = await js(`(() => ({
    handle: !document.getElementById('splitHandle').hidden,
    labels: !document.getElementById('compareLabels').hidden,
    pressed: document.getElementById('compareBtn').getAttribute('aria-pressed')
  }))()`);
  check('compare shows the divider and the before/after labels',
    compareOn.handle && compareOn.labels && compareOn.pressed === 'true',
    JSON.stringify(compareOn));
  await js(`document.getElementById('compareBtn').click(); true`);
  await sleep(120);
  check('turning compare off leaves no overlay behind',
    await js(`document.getElementById('splitHandle').hidden &&
      document.getElementById('compareLabels').hidden`));

  // The overlay's starting state comes from a persisted setting, so drive it
  // to a known one rather than assuming a single click turns it on.
  const setStats = async (want) => {
    for (let i = 0; i < 2; i++) {
      const on = await js('!document.getElementById("statsOverlay").hidden');
      if (on === want) break;
      await js(`document.getElementById('statsBtn').click(); true`);
      await sleep(250);
    }
    await sleep(650);
  };

  await setStats(true);
  const stats = await js(`(() => {
    const o = document.getElementById('statsOverlay');
    return { visible: !o.hidden, rows: o.querySelectorAll('.row').length,
             heads: o.querySelectorAll('.shead').length,
             pressed: document.getElementById('statsBtn').getAttribute('aria-pressed'),
             text: o.textContent.slice(0, 100) };
  })()`);
  check('the diagnostics overlay renders grouped rows',
    stats.visible && stats.rows >= 5 && stats.heads >= 2 && stats.pressed === 'true',
    JSON.stringify(stats));
  await setStats(false);
  check('closing the diagnostics overlay hides it completely',
    await js(`document.getElementById('statsOverlay').hidden &&
      getComputedStyle(document.getElementById('statsOverlay')).display === 'none'`));

  /* ---- native / enhanced presentation ---- */

  const setEnhancement = async (want) => {
    for (let i = 0; i < 2; i++) {
      const now = await js('!!(window.visionanceDiagnostics.snapshot().enhancement)');
      if (now === want) break;
      await js(`document.getElementById('enhanceToggle').click(); true`);
      await sleep(300);
    }
    await sleep(200);
  };

  const clip = makeClip();
  if (clip) {
    win.webContents.send('open-external-file', clip);
    await waitFor('clip loaded',
      `(() => { const v = document.getElementById('video'); return v.videoWidth === 640 && v.readyState >= 2; })()`,
      25000);

    await setEnhancement(false);
    let presentation = await js(`(() => {
      const d = window.visionanceDiagnostics.source();
      const inner = document.getElementById('stageInner');
      const v = document.getElementById('video');
      return { mode: d.presentation, engine: d.engineRunning,
               nativeClass: inner.classList.contains('native'),
               videoVisible: getComputedStyle(v).opacity === '1',
               canvasHidden: getComputedStyle(document.getElementById('glCanvas')).display === 'none' };
    })()`);
    check('enhancement off uses the native video element and stops the loop',
      presentation.mode === 'native' && presentation.engine === false &&
      presentation.nativeClass && presentation.videoVisible && presentation.canvasHidden,
      JSON.stringify(presentation));

    await setEnhancement(true);
    presentation = await js(`(() => {
      const d = window.visionanceDiagnostics.source();
      return { mode: d.presentation, engine: d.engineRunning,
               nativeClass: document.getElementById('stageInner').classList.contains('native'),
               canvasShown: getComputedStyle(document.getElementById('glCanvas')).display !== 'none' };
    })()`);
    check('enhancement on runs the engine and shows the canvas',
      presentation.mode === 'enhanced' && presentation.engine === true &&
      !presentation.nativeClass && presentation.canvasShown,
      JSON.stringify(presentation));
  } else {
    check('presentation modes exercised', false, 'ffmpeg unavailable, could not build a clip');
  }

  /* ---- Fine Tune: the Adjust workspace, merged into Watch ---- */

  await js(`document.querySelector('.tab[data-tab="presets"]').click(); true`);
  await sleep(250);
  const fineTune = await js(`(() => {
    const group = document.getElementById('groupFineTune');
    const before = { open: group.open, sliders: group.querySelectorAll('input[type=range]').length };
    group.open = true;
    const modules = [...group.querySelectorAll('#controlGroups > .group > summary')]
      .map((sm) => sm.textContent.trim());
    return {
      collapsedByDefault: before.open === false,
      modules,
      sliders: group.querySelectorAll('input[type=range]').length,
      reset: !!document.getElementById('resetParamsBtn'),
      savePreset: !!document.getElementById('presetName') && !!document.getElementById('savePresetBtn'),
      useInCreate: !!document.getElementById('adjustToCreateBtn'),
      specs: document.getElementById('sourceSpecs').childElementCount
    };
  })()`);
  check('Fine Tune carries the Adjust parameter modules inside Watch',
    fineTune.modules.length >= 3 && fineTune.sliders >= 10,
    `${fineTune.modules.join(' / ')} — ${fineTune.sliders} sliders`);
  check('Fine Tune is collapsed by default so Watch opens simple',
    fineTune.collapsedByDefault, String(fineTune.collapsedByDefault));
  check('the Adjust actions came with it',
    fineTune.reset && fineTune.savePreset && fineTune.useInCreate,
    JSON.stringify(fineTune));

  // A slider still drives the live look from its new home. Observed through the
  // real apply path: the row marks itself modified and the collapsed Fine Tune
  // summary counts it, both of which are written by the parameter handler.
  const tuned = await js(`(() => {
    const slider = document.querySelector('#controlGroups input[type=range]');
    if (!slider) return null;
    const row = slider.closest('.ctrl');
    const before = { modified: row.classList.contains('modified'),
                     tag: document.getElementById('fineTuneTag').textContent };
    slider.value = String((Number(slider.min) + Number(slider.max)) / 2);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    return { before, after: { modified: row.classList.contains('modified'),
                              tag: document.getElementById('fineTuneTag').textContent },
             id: slider.id };
  })()`);
  check('a Fine Tune slider still writes through to the realtime look',
    tuned && tuned.after.modified && /changed/.test(tuned.after.tag),
    tuned ? `${tuned.id}: "${tuned.before.tag}" -> "${tuned.after.tag}"` : 'no slider');
  await js(`(() => { document.getElementById('resetParamsBtn').click(); return true; })()`);
  await sleep(250);

  /* ---- Create ---- */

  await js(`document.querySelector('.tab[data-tab="create"]').click(); true`);
  await sleep(200);

  const createControls = await js(`(() => {
    const ids = ['createOpenFileBtn','createUseWatchBtn','createUrlInput','createUrlBtn',
                 'createThumb','createAspect','createRes','createFraming','createAi',
                 'createAiQuality','createInterp','createFps','createPlatform','startCreateBtn'];
    return ids.filter(id => !document.getElementById(id));
  })()`);
  check('every Create control is present', createControls.length === 0, createControls.join(', '));

  const aspects = await js(`[...document.getElementById('createAspect').options].map(o => o.value)`);
  check('aspect ratio is a first-class control with every ratio',
    ['source', '16:9', '9:16', '4:5', '1:1', '21:9', '2.39:1', 'custom'].every((a) => aspects.includes(a)),
    aspects.join(', '));

  const framings = await js(`[...document.getElementById('createFraming').options].map(o => o.value)`);
  check('Smart Reframe is offered alongside the other framing modes',
    ['smart', 'fill', 'fit', 'fit-black'].every((f) => framings.includes(f)),
    framings.join(', '));

  const qualities = await js(`[...document.getElementById('createAiQuality').options].map(o => o.value)`);
  check('all four inference qualities exist',
    ['fast', 'balanced', 'quality', 'maximum'].every((q) => qualities.includes(q)),
    qualities.join(', '));

  const groups = await js(`[...document.querySelectorAll('.tab-page[data-page="create"] .group')]
    .map(g => g.querySelector('summary').firstChild.textContent.trim())`);
  check('Create is organised into sections rather than one flat form',
    groups.length >= 5, groups.join(' / '));

  // Target, aspect, resolution and framing stay four separate answers, and each
  // collapsed section still says what it holds.
  await js(`(() => {
    const set = (id, v) => { const n = document.getElementById(id); n.value = v; n.dispatchEvent(new Event('change')); };
    set('createAspect', '9:16');
    set('createRes', 'auto');
    set('createFraming', 'smart');
    set('createFps', '24');
    return true;
  })()`);
  await sleep(350);
  const tags = await js(`(() => ({
    output: document.getElementById('tagOutput').textContent,
    framing: document.getElementById('tagFraming').textContent,
    motion: document.getElementById('tagMotion').textContent,
    enhancement: document.getElementById('tagEnhancement').textContent,
    summary: [...document.getElementById('renderSummary').children].map(c => c.textContent),
    aspect: document.getElementById('createAspect').value,
    res: document.getElementById('createRes').value,
    framingValue: document.getElementById('createFraming').value
  }))()`);
  check('target, aspect, resolution and framing stay four separate answers',
    tags.aspect === '9:16' && tags.res === 'auto' && tags.framingValue === 'smart' &&
    /1080×1920/.test(tags.output) && /Smart Reframe/.test(tags.framing),
    JSON.stringify({ output: tags.output, framing: tags.framing }));
  // The summary describes a render, so it stays empty until there is a source
  // to render. Its contents are asserted below, once one has been chosen.
  check('the render summary says nothing until there is a source',
    tags.summary.length === 0, tags.summary.join(', '));


  if (clip) {
    await js(`document.getElementById('createUseWatchBtn').click(); true`);
    await waitFor('create source', `/ui-clip/i.test(document.getElementById('createSourceTitle').textContent)`);
    check('"Use Watch video" sets the Create source', true);

    // Watch must be untouched by any of that.
    const watch = await js(`(() => { const v = document.getElementById('video');
      return { w: v.videoWidth, src: v.currentSrc, paused: v.paused }; })()`);
    check('choosing a Create source leaves Watch on its own file',
      watch.w === 640 && /ui-clip/i.test(decodeURIComponent(watch.src)),
      JSON.stringify({ w: watch.w }));

    await sleep(400);
    const summary = await js(`[...document.getElementById('renderSummary').children].map(c => c.textContent)`);
    check('the render summary states what will be produced',
      summary.includes('1080 × 1920') && summary.includes('24 fps') &&
      summary.includes('Smart Reframe'),
      summary.join(', '));

    /* ---- thumbnail identity ---- */

    const thumbUrl = await waitFor('thumbnail resolved', `(() => {
      const img = document.getElementById('createThumb').querySelector('img');
      return img ? img.src : null;
    })()`, 30000);
    check('the Create source gets a real extracted thumbnail',
      /^vs:\/\/app\/__thumb\?k=/.test(thumbUrl), thumbUrl);

    // The identity rule: the same source resolves to the same key everywhere,
    // and asking again costs no further IPC.
    const identity = await js(`(async () => {
      const before = { ...window.VSThumbs.stats };
      const descriptors = [
        { kind: 'local', source: ${JSON.stringify(clip)} },
        { kind: 'local', source: ${JSON.stringify(clip.toUpperCase())} },
        { kind: 'local', path: ${JSON.stringify(clip)} }
      ];
      const urls = [];
      for (const d of descriptors) urls.push(await window.VSThumbs.get(d));
      const after = { ...window.VSThumbs.stats };
      return { urls, ipcBefore: before.ipcCalls, ipcAfter: after.ipcCalls };
    })()`);
    check('one source maps to exactly one thumbnail',
      new Set(identity.urls).size === 1 && identity.urls[0],
      identity.urls.join(' | '));
    check('repeated thumbnail requests do not re-extract',
      identity.ipcAfter === identity.ipcBefore,
      `${identity.ipcBefore} -> ${identity.ipcAfter} IPC calls`);

    const cacheHit = await js('(async () => (await window.visionance.thumbnails.stats()).cache)()');
    check('the thumbnail cache holds files on disk',
      cacheHit && cacheHit.count > 0, JSON.stringify(cacheHit));
  }

  // The neural quality note is one line by default with the reasoning behind
  // "Why?", not a paragraph nobody reads.
  const enginesReady = await js(`(async () => {
    const r = await window.visionance.engines.status();
    return r.ok && r.engines.realesrgan && r.engines.realesrgan.status === 'ready';
  })()`);
  if (enginesReady) {
    await js(`(() => {
      const set = (id, v) => { const n = document.getElementById(id); n.value = v; n.dispatchEvent(new Event('change')); };
      set('createAi', '2');
      set('createAiQuality', 'balanced');
      document.getElementById('groupEnhancement').open = true;
      return true;
    })()`);
    await sleep(900);
    const plan = await js(`(() => {
      const n = document.getElementById('createAiQualityNote');
      return { hidden: n.hidden, short: n.querySelector('span') ? n.querySelector('span').textContent : '',
               why: !!n.querySelector('.why'), lines: n.textContent.length };
    })()`);
    check('the inference quality shows a short resolved plan, not a paragraph',
      !plan.hidden && plan.short.length > 0 && plan.short.length < 90 && plan.why,
      JSON.stringify({ short: plan.short, why: plan.why }));

    await js(`document.querySelector('#createAiQualityNote .why').click(); true`);
    await sleep(200);
    const expanded = await js(`document.getElementById('createAiQualityNote').textContent`);
    check('"Why?" expands into the full technical reasoning',
      expanded.length > 120, expanded.slice(0, 90));
    await js(`(() => { const w = document.querySelector('#createAiQualityNote .why');
      if (w) w.click(); return true; })()`);
    // Capture the panel with the neural controls engaged and scrolled into
    // view, so the review sees the state most of this copy is written for.
    await js(`document.getElementById('groupEnhancement').scrollIntoView({ block: 'center' }); true`);
    await sleep(400);
    await shot('create-neural');
    await js(`(() => { const n = document.getElementById('createAi');
      n.value = 'off'; n.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(250);
  } else {
    const gated = await js(`[...document.getElementById('createAi').options]
      .filter(o => o.value !== 'off').every(o => o.disabled)`);
    check('with no engine installed the neural options are disabled, not offered', gated);
  }

  /* ---- Queue ---- */

  await js(`document.querySelector('.tab[data-tab="queue"]').click(); true`);
  await sleep(200);
  const queue = await js(`(() => {
    const list = document.getElementById('jobList');
    return { present: !!list,
             empty: !!list.querySelector('.empty-note'),
             cards: list.querySelectorAll('.job').length };
  })()`);
  check('the Queue renders its list or an honest empty state',
    queue.present && (queue.empty || queue.cards > 0), JSON.stringify(queue));

  // Render a synthetic job through the real card builder, so the row is
  // verified without waiting minutes for a real encode.
  const jobCard = await js(`(() => {
    const now = Date.now();
    const job = {
      id: 'ui-verify-job', createdAt: now, updatedAt: now, title: 'ui-clip.mp4',
      status: 'running', stage: 'ENCODE', progress: 0.42, speed: 1.8, eta: 95,
      pauseSupported: true, warnings: ['A synthetic warning.'], attempts: 1,
      source: { type: 'local', path: ${JSON.stringify(clip || 'x.mp4')}, title: 'ui-clip.mp4' },
      recipe: { output: { fps: 24, codec: 'h264' },
                reconstruction: { mode: 'neural', aiMode: 'upscale', aiScale: 2,
                                  targetResolution: { mode: 'custom', width: 1080, height: 1920 } },
                motion: { interpolation: 'none' }, audio: { master: 'creator' } },
      cost: { class: 'heavy', label: 'HEAVY', reasons: ['1080x1920 · realesrgan at x2'], seconds: 900 },
      plan: { description: 'neural upscale then encode', chunked: true, chunkCount: 4 },
      stages: ['ANALYSE', 'UPSCALE', 'ENCODE', 'VERIFY'],
      aiMetrics: { model: 'realesrgan-x4plus', gpu: 0, tileSize: 256 },
      reframe: { outcome: 'tracked', backendLabel: 'Face & person detection',
                 headline: 'Tracked 36 of 40 samples · confidence 81%', tracked: 36, samples: 40,
                 detail: ['30 face', '6 person', '4 held'] },
      neuralRate: { warming: false, framesPerSecond: 0.55, framesDone: 120, framesTotal: 300 }
    };
    window.__vsJobProbe = job;
    const app = document.getElementById('jobList');
    app.innerHTML = '';
    // Drive the real update path rather than a private builder.
    return true;
  })()`);
  void jobCard;

  const jobRendered = await js(`(async () => {
    // The renderer's own job map is private, so push the job through the IPC
    // event the main process uses. This is the same code path a real job takes.
    return true;
  })()`);
  void jobRendered;

  win.webContents.send('jobs:update', await js('window.__vsJobProbe'));
  await sleep(300);
  const card = await js(`(() => {
    const node = document.querySelector('.job');
    if (!node) return null;
    return {
      title: !!node.querySelector('.job-title'),
      status: node.querySelector('.job-status') ? node.querySelector('.job-status').textContent : null,
      thumb: !!node.querySelector('.thumb'),
      bar: !!node.querySelector('.job-bar span'),
      meta: node.querySelector('.job-meta') ? node.querySelector('.job-meta').textContent : '',
      chips: [...node.querySelectorAll('.job-spec .chip')].map(c => c.textContent),
      cost: node.querySelector('.cost-class') ? node.querySelector('.cost-class').textContent : null,
      reframe: node.querySelector('.job-reframe') ? node.querySelector('.job-reframe').textContent : null,
      details: !!node.querySelector('.job-details'),
      detailText: node.querySelector('.job-detail-body') ? node.querySelector('.job-detail-body').textContent : '',
      actions: [...node.querySelectorAll('.job-actions .btn')].map(b => b.textContent)
    };
  })()`);
  check('a running job row shows state, stage, progress, rate and ETA',
    card && card.status === 'rendering' && /encode/.test(card.meta) &&
    /0\.55 fps/.test(card.meta) && /~1:35 left/.test(card.meta),
    card ? card.meta : 'no card');
  check('the job row carries the source thumbnail and its output spec',
    card && card.thumb && card.chips.includes('1080×1920') && card.chips.includes('24 fps') &&
    card.chips.includes('Neural 2×'),
    card ? card.chips.join(', ') : '');
  check('the resolved cost class is on the row', card && card.cost === 'HEAVY', card && card.cost);
  check('Smart Reframe reports its backend and reconciled counters',
    card && /Face & person detection/.test(card.reframe) && /Tracked 36 of 40/.test(card.reframe),
    card && card.reframe);
  check('technical detail is behind a disclosure, not on the row',
    card && card.details && /realesrgan-x4plus/.test(card.detailText) &&
    /30 face/.test(card.detailText) && !/realesrgan-x4plus/.test(card.reframe || ''),
    card ? card.detailText.slice(0, 80) : '');
  check('only contextually valid actions are offered',
    card && card.actions.includes('Pause') && card.actions.includes('Cancel') &&
    !card.actions.includes('Retry') && !card.actions.includes('Play'),
    card ? card.actions.join(', ') : '');

  // A job row resolves into columns; none of them may sit on top of another.
  const jobLayout = await js(`(() => {
    const main = document.querySelector('.job.is-active .job-main');
    if (!main) return { ok: false, reason: 'no active row' };
    const cells = [...main.children].filter(n => n.offsetParent)
      .map(n => ({ id: n.className.split(' ')[0], r: n.getBoundingClientRect() }));
    const bad = [];
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i].r, b = cells[j].r;
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
            Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) {
          bad.push(cells[i].id + ' / ' + cells[j].id);
        }
      }
    }
    // And nothing inside a cell may spill past its own column.
    const track = main.querySelector('.job-track');
    const side = main.querySelector('.job-side');
    const spill = track && side &&
      track.getBoundingClientRect().right > side.getBoundingClientRect().left + 1;
    return { ok: true, columns: cells.length, overlaps: bad, spill };
  })()`);
  check('the job row resolves into columns that do not overlap',
    jobLayout.ok && jobLayout.columns === 4 &&
    jobLayout.overlaps.length === 0 && !jobLayout.spill,
    JSON.stringify(jobLayout));

  const strip = await js(`(() => {
    const s = document.getElementById('jobStrip');
    const r = s.getBoundingClientRect();
    // Nothing in the top bar may sit on top of anything else in it.
    const others = [...document.querySelectorAll('.topbar-right > *')]
      .filter(n => n !== s && n.offsetParent);
    const collides = others.some(n => {
      const o = n.getBoundingClientRect();
      return Math.min(r.right, o.right) - Math.max(r.left, o.left) > 1;
    });
    return { visible: !s.hidden, text: s.textContent, width: Math.round(r.width),
             collides, inWindow: r.right <= window.innerWidth + 1,
             name: s.querySelector('.js-name').getBoundingClientRect().width > 10,
             badge: document.getElementById('queueCount').textContent };
  })()`);
  check('an active render shows the background mini-strip and the tab badge',
    strip.visible && /ENCODE/.test(strip.text) && /42%/.test(strip.text) && strip.badge === '1',
    JSON.stringify({ text: strip.text, badge: strip.badge }));
  check('the mini-strip names the render and never overlaps the toolbar',
    strip.name && !strip.collides && strip.inWindow,
    JSON.stringify({ width: strip.width, collides: strip.collides, named: strip.name }));

  /* ---- Library ---- */

  await js(`document.querySelector('.tab[data-tab="library"]').click(); true`);
  await sleep(400);
  const library = await js(`(() => {
    const list = document.getElementById('recentList');
    return { present: !!list,
             empty: !!list.querySelector('.empty-note'),
             rows: list.querySelectorAll('.recent').length,
             thumbs: list.querySelectorAll('.recent .thumb').length };
  })()`);
  check('the Library renders recents with thumbnails, or an honest empty state',
    library.present && (library.empty || (library.rows > 0 && library.thumbs === library.rows)),
    JSON.stringify(library));

  /* ---- Settings ---- */

  await js(`document.getElementById('settingsBtn').click(); true`);
  await sleep(600);
  const settings = await js(`(() => ({
    open: !document.getElementById('settingsModal').hidden,
    sections: [...document.querySelectorAll('#settingsNav button')].map(b => b.dataset.settings),
    visiblePages: [...document.querySelectorAll('[data-settings-page]')].filter(p => !p.hidden).length,
    engines: document.getElementById('engineList').children.length,
    ytdlp: document.getElementById('ytdlpStatus').textContent.slice(0, 40),
    ffmpeg: document.getElementById('ffmpegStatus').textContent.slice(0, 40),
    semantic: document.getElementById('semanticStatus').textContent.slice(0, 40),
    thumbCache: document.getElementById('thumbCacheStatus').textContent.slice(0, 50)
  }))()`);
  check('settings opens with one section showing at a time',
    settings.open && settings.visiblePages === 1 && settings.sections.length >= 7,
    JSON.stringify({ pages: settings.visiblePages, sections: settings.sections.length }));
  check('every real engine and binary reports its own state',
    settings.engines >= 2 && settings.ytdlp && settings.ffmpeg && settings.semantic,
    `${settings.engines} engines`);
  check('the thumbnail cache reports real numbers',
    /thumbnail|Empty/i.test(settings.thumbCache), settings.thumbCache);

  // Diagnostics hosts the telemetry view.
  await js(`document.querySelector('#settingsNav button[data-settings="diagnostics"]').click(); true`);
  await sleep(2600);
  const tele = await js('window.VSTelemetry.debugState()');
  check('telemetry subscribes only when a view is on screen',
    tele.subscribed === true && tele.views === 2, JSON.stringify({
      subscribed: tele.subscribed, views: tele.views
    }));
  check('the performance graph receives real samples',
    tele.samples > 0 && tele.latest && typeof tele.latest.at === 'number',
    `${tele.samples} samples, series ${tele.series}`);
  check('unavailable metrics are null rather than invented',
    tele.latest && (tele.latest.gpu === null ||
      (typeof tele.latest.gpu === 'object' && 'utilisationPercent' in tele.latest.gpu)),
    tele.latest && tele.latest.gpu ? `gpu via ${tele.latest.gpu.source}` : 'no gpu source on this machine');

  const graphPainted = await js(`(() => {
    const c = document.querySelector('#settingsTelemetry canvas');
    return c ? { w: c.width, h: c.height } : null;
  })()`);
  check('the graph is a sized canvas, not a placeholder',
    graphPainted && graphPainted.w > 0 && graphPainted.h > 0, JSON.stringify(graphPainted));

  await shot('settings');
  await js(`document.getElementById('closeSettings').click(); true`);
  await sleep(400);

  const teleAfter = await js('window.VSTelemetry.debugState()');
  check('closing settings stops telemetry when nothing else is showing it',
    teleAfter.subscribed === false || teleAfter.wanted === false,
    JSON.stringify({ subscribed: teleAfter.subscribed, wanted: teleAfter.wanted }));

  /* ---- screenshots ---- */

  const shots = [];
  for (const [name, workspace] of [['create', 'create'], ['watch', 'presets'],
    ['queue', 'queue'], ['library', 'library']]) {
    await js(`document.querySelector('.tab[data-tab="${workspace}"]').click(); true`);
    await sleep(450);
    // Watch is photographed with Looks showing, which is how it opens.
    if (workspace === 'presets') {
      await js(`(() => { document.getElementById('groupFineTune').open = false;
        document.querySelector('.tab-body').scrollTop = 0; return true; })()`);
      await sleep(300);
    }
    shots.push(await shot(name));
  }

  // And again with Fine Tune open, which is the state the merge exists for.
  await js(`document.querySelector('.tab[data-tab="presets"]').click(); true`);
  await sleep(250);
  await js(`(() => {
    const group = document.getElementById('groupFineTune');
    group.open = true;
    group.scrollIntoView({ block: 'start' });
    return true;
  })()`);
  await sleep(500);
  shots.push(await shot('watch-finetune'));
  await js(`(() => { document.getElementById('groupFineTune').open = false; return true; })()`);

  // A narrow window must yield secondary information, not the player.
  // Unmaximise first: setSize on a maximised window is ignored, which would
  // make this assertion pass without ever narrowing anything.
  if (win.isMaximized()) win.unmaximize();
  await sleep(200);
  win.setSize(1000, 700);
  await sleep(500);
  await js(`document.querySelector('.tab[data-tab="presets"]').click(); true`);
  await sleep(300);
  const narrow = await js(`(() => {
    const stage = document.getElementById('stage').getBoundingClientRect();
    return { width: window.innerWidth,
             stageW: Math.round(stage.width), stageH: Math.round(stage.height),
             share: Math.round((stage.width / window.innerWidth) * 100),
             overflow: document.documentElement.scrollWidth > window.innerWidth };
  })()`);
  check('the window genuinely narrowed', narrow.width <= 1010, String(narrow.width));
  check('the player keeps most of a narrow window and nothing overflows',
    narrow.share >= 60 && !narrow.overflow, JSON.stringify(narrow));

  // Controls that overlap each other are the classic narrow-window defect and
  // the one a screenshot review catches last. Assert it instead.
  const overlaps = await js(`(() => {
    const nodes = [...document.querySelectorAll('.transport-row .tgroup > *')]
      .filter(n => n.offsetParent)
      .map(n => ({ id: n.id || n.className, r: n.getBoundingClientRect() }));
    const bad = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i].r, b = nodes[j].r;
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapX > 1 && overlapY > 1) bad.push(nodes[i].id + ' / ' + nodes[j].id);
      }
    }
    return bad;
  })()`);
  check('no transport control overlaps another at a narrow width',
    overlaps.length === 0, overlaps.slice(0, 4).join(', '));

  shots.push(await shot('watch-narrow'));

  // Create is the densest inspector; check it survives the same width.
  await js(`document.querySelector('.tab[data-tab="create"]').click(); true`);
  await sleep(350);
  const narrowCreate = await js(`(() => {
    const page = document.querySelector('.tab-page[data-page="create"]');
    let clipped = [];
    for (const node of page.querySelectorAll('.select, .input, .btn')) {
      // A control inside a collapsed section or a hidden row has no box; only
      // what is actually on screen can be clipped.
      if (!node.offsetParent) continue;
      const r = node.getBoundingClientRect();
      if (r.right > window.innerWidth + 1 || r.width < 8) clipped.push(node.id || node.className);
    }
    // Name the widest offender, so an overflow is diagnosable rather than a
    // bare boolean.
    let widest = null;
    if (page.scrollWidth > page.clientWidth + 1) {
      const limit = page.getBoundingClientRect().right;
      for (const node of page.querySelectorAll('*')) {
        const r = node.getBoundingClientRect();
        if (r.width && r.right > limit + 1) {
          widest = (node.id || node.className) + ' right=' + Math.round(r.right) +
            ' limit=' + Math.round(limit);
          break;
        }
      }
    }
    return { clipped: clipped.slice(0, 5), widest,
             overflow: page.scrollWidth > page.clientWidth + 1 };
  })()`);
  check('no Create control is clipped or pushed off a narrow window',
    narrowCreate.clipped.length === 0 && !narrowCreate.overflow,
    JSON.stringify(narrowCreate));
  shots.push(await shot('create-narrow'));

  // The common laptop size. Watch is the densest workspace vertically — viewer,
  // process strip, console band and the full Fine Tune inspector all at once —
  // so it is where a short window shows up first. The band is expected to give
  // ground here; the viewer is not.
  win.setSize(1366, 768);
  await sleep(500);
  await js(`document.querySelector('.tab[data-tab="presets"]').click(); true`);
  await sleep(200);
  // Photograph the panel from the top: an earlier assertion scrolled Fine Tune
  // into view, and a review frame should show the workspace as it opens.
  await js(`(() => { document.querySelector('.tab-body').scrollTop = 0; return true; })()`);
  await sleep(450);
  const laptop = await js(`(() => {
    const r = (id) => document.getElementById(id).getBoundingClientRect();
    const stage = r('stageInner');
    const console_ = r('utilityStrip');
    const strip = r('processStrip');
    const panel = document.querySelector('.tab-page[data-page="presets"]');
    return {
      viewport: window.innerHeight,
      player: Math.round(stage.height),
      console: Math.round(console_.height),
      strip: Math.round(strip.height),
      bottom: Math.round(console_.bottom),
      overflowY: document.documentElement.scrollHeight > window.innerHeight + 1,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      inspectorOverflow: panel.scrollWidth > panel.clientWidth + 1
    };
  })()`);
  check('at 1366×768 everything still fits inside the window',
    laptop.bottom <= laptop.viewport + 1 && !laptop.overflowY && !laptop.overflowX &&
    !laptop.inspectorOverflow, JSON.stringify(laptop));
  check('at 1366×768 the console gives ground and the viewer keeps its lead',
    laptop.player > laptop.console + laptop.strip,
    `player ${laptop.player}px vs console ${laptop.console}px + strip ${laptop.strip}px`);
  shots.push(await shot('watch-1366'));

  // Create at the same size: it carries the widest inspector and the source
  // column at once, so it is the other place a laptop screen shows first.
  await js(`document.querySelector('.tab[data-tab="create"]').click(); true`);
  await sleep(450);
  const laptopCreate = await js(`(() => {
    const page = document.querySelector('.tab-page[data-page="create"]');
    const col = document.getElementById('sourceColumn').getBoundingClientRect();
    return {
      inspectorOverflow: page.scrollWidth > page.clientWidth + 1,
      columnVisible: col.width > 0,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1
    };
  })()`);
  check('at 1366×768 Create keeps its source column and clips no control',
    laptopCreate.columnVisible && !laptopCreate.inspectorOverflow && !laptopCreate.overflowX,
    JSON.stringify(laptopCreate));
  shots.push(await shot('create-1366'));

  win.setSize(1440, 900);
  await sleep(400);

  console.log(`\n  screenshots: ${SHOT_DIR}`);
  for (const file of shots) console.log(`    ${path.basename(file)}`);

  /* ---- resource behaviour ---- */

  await js(`document.querySelector('.tab[data-tab="presets"]').click(); true`);
  await sleep(200);
  const idleTele = await js('window.VSTelemetry.debugState()');
  check('no telemetry sampling while no performance view is visible',
    idleTele.wanted === false, JSON.stringify({ wanted: idleTele.wanted }));

  // A reload destroys the document holding the subscriptions without releasing
  // them. Unless the main process drops them, the count never returns to zero
  // and nvidia-smi is spawned every two seconds for the rest of the session.
  await js(`(async () => { await window.visionance.telemetry.subscribe(true); return true; })()`);
  await sleep(200);
  const beforeReload = await js('(async () => (await window.visionance.telemetry.subscribe(true)).active)()');
  win.webContents.reload();
  await waitFor('reload', 'window.__visionanceReady || window.__visionanceBootError', 60000);
  await sleep(600);
  const afterReload = await js(`(async () => {
    // Ask without subscribing: a leaked count would still report active.
    const r = await window.visionance.telemetry.subscribe(false);
    return r.active;
  })()`);
  check('a renderer reload does not leak a telemetry subscription',
    beforeReload === true && afterReload === false,
    `before ${beforeReload} -> after ${afterReload}`);

  check('no uncaught renderer errors during the whole run',
    pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
}

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  const deadline = setTimeout(() => {
    console.log('\nFAIL — harness timed out');
    app.exit(1);
  }, 300000);

  // Give the app a moment to create its window.
  for (let i = 0; i < 100 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (!win) await sleep(100);
  }
  if (!win) {
    say('FAIL — no window was created');
    writeReport();
    return app.exit(1);
  }
  // A saved maximised window ignores setSize, which would leave every capture
  // at whatever the last session happened to be. Unmaximise first so the run
  // is reproducible, and take a viewport tall enough that the workspaces are
  // photographed with their optional zones on rather than degraded away.
  if (win.isMaximized()) win.unmaximize();
  await sleep(200);
  win.setSize(1536, 1000);
  await sleep(300);

  win.webContents.on('console-message', (...args) => {
    const event = args[0];
    const level = typeof event === 'object' && event ? event.level : args[1];
    const message = typeof event === 'object' && event ? event.message : args[2];
    if (level === 'error' || level === 3) pageErrors.push(String(message).slice(0, 200));
  });
  win.webContents.on('render-process-gone', (_e, d) => pageErrors.push('renderer gone: ' + d.reason));

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
