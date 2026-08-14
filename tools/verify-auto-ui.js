'use strict';

/**
 * AUTO CONFIGURE — user-interface acceptance.
 *
 *   npx electron tools/verify-auto-ui.js
 *
 * Boots the real application and drives the real simple-user path end to end,
 * in both workspaces, on real clips:
 *
 *   choose a video -> choose the few things you care about -> AUTO CONFIGURE
 *   -> review -> (render)
 *
 * It asserts the promises the feature makes rather than pixel positions:
 *   - the four basic choices are locks and survive Auto untouched
 *   - Auto's account is a readout of the recipe, not a template
 *   - editing an advanced control afterwards says "edited", it does not reset
 *   - changing a lock re-arms Auto instead of silently recomputing
 *   - Watch's Auto configures realtime state and cannot touch Create's recipe
 *   - Fine Tune shows the values the chosen Look actually set
 *
 * Eight screenshots land in tools/ui-shots/ so the result can be looked at
 * rather than imagined.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const SHOT_DIR = path.join(__dirname, 'ui-shots');
const CLIP_DIR = path.join(os.tmpdir(), 'visionance-auto-verify');

if (!process.env.VISIONANCE_ENGINES_DIR) {
  const real = path.join(app.getPath('appData'), 'Visionance');
  process.env.VISIONANCE_ENGINES_DIR = path.join(real, 'engines');
}

require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

const results = [];
const pageErrors = [];
const shots = [];
let win = null;

const REPORT = path.join(SHOT_DIR, 'auto-report.txt');
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

async function waitFor(label, code, timeoutMs = 20000, every = 150) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await js(code);
    if (last) return last;
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

async function shot(name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const image = await win.webContents.capturePage();
  const file = path.join(SHOT_DIR, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  shots.push(file);
  say(`  shot ${file}`);
  return file;
}

/**
 * Real clips, made once.
 *
 * The landscape one is deliberately starved (400 kbps at 720p24) so the source
 * classification has something real to find: this is the case Auto exists for,
 * and a pristine test pattern would exercise none of it.
 */
function makeClips() {
  fs.mkdirSync(CLIP_DIR, { recursive: true });
  const ffmpeg = require(path.join(__dirname, '..', 'src', 'main', 'binaries')).resolve('ffmpeg');
  if (!ffmpeg) return null;

  const build = (name, args) => {
    const file = path.join(CLIP_DIR, name);
    if (fs.existsSync(file)) return file;
    const res = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, file],
      { windowsHide: true });
    return res.status === 0 && fs.existsSync(file) ? file : null;
  };

  const landscape = build('auto-16x9.mp4', [
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:v', 'libx264', '-b:v', '400k', '-maxrate', '400k', '-bufsize', '800k',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'
  ]);
  const vertical = build('auto-9x16.mp4', [
    '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30:duration=5',
    '-c:v', 'libx264', '-b:v', '2500k', '-pix_fmt', 'yuv420p'
  ]);
  return { landscape, vertical };
}

/** Set a control the way a person does, and let the app react. */
const setControl = (id, value) => js(`(() => {
  const n = document.getElementById(${JSON.stringify(id)});
  n.value = ${JSON.stringify(value)};
  n.dispatchEvent(new Event('change'));
  return n.value;
})()`);

const createState = () => js(`(() => ({
  platform: document.getElementById('createPlatform').value,
  aspect: document.getElementById('createAspect').value,
  res: document.getElementById('createRes').value,
  fps: document.getElementById('createFps').value,
  framing: document.getElementById('createFraming').value,
  ai: document.getElementById('createAi').value,
  aiQuality: document.getElementById('createAiQuality').value,
  interp: document.getElementById('createInterp').value,
  autoState: document.getElementById('autoState').textContent,
  summary: [...document.getElementById('renderSummary').children].map(c => c.textContent),
  result: document.getElementById('autoResult').hidden
    ? null : document.getElementById('autoResult').textContent,
  unmet: document.getElementById('autoUnmet').hidden
    ? null : document.getElementById('autoUnmet').textContent,
  why: document.getElementById('autoExplain').textContent
}))()`);

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

async function run() {
  say('\nVisionance AUTO CONFIGURE — UI acceptance\n');

  await waitFor('boot', 'window.__visionanceReady || window.__visionanceBootError', 60000);
  const bootError = await js('window.__visionanceBootError || null');
  check('the renderer booted without throwing', !bootError, bootError || '');

  const clips = makeClips();
  if (!clips || !clips.landscape) {
    check('a real clip could be built for the run', false, 'ffmpeg unavailable');
    return;
  }

  /* ================= WATCH ================= */

  say('\nWatch');
  await js(`document.querySelector('.tab[data-tab="presets"]').click(); true`);
  await sleep(200);

  win.webContents.send('open-external-file', clips.landscape);
  await waitFor('clip loaded', `(() => { const v = document.getElementById('video');
    return v.videoWidth > 0 && v.readyState >= 2; })()`, 40000);
  await sleep(900);

  const watchBefore = await js(`(() => ({
    state: document.getElementById('watchAutoState').textContent,
    armed: document.getElementById('watchAutoBtn').classList.contains('is-armed'),
    resultHidden: document.getElementById('watchAutoResult').hidden,
    quality: document.getElementById('watchQuality').value
  }))()`);
  check('Watch offers Auto Configure and claims nothing before it is pressed',
    watchBefore.resultHidden && /ready/i.test(watchBefore.state),
    JSON.stringify(watchBefore));
  await js(`document.getElementById('watchAutoBlock').scrollIntoView({ block: 'start' }); true`);
  await sleep(250);
  await shot('auto-watch-before');

  // Aim Create at the same clip *first*, so the independence assertion below
  // has a real Create recipe to be untouched.
  await js(`document.querySelector('.tab[data-tab="create"]').click(); true`);
  await sleep(250);
  await js(`document.getElementById('createUseWatchBtn').click(); true`);
  await waitFor('create source',
    `/auto-16x9/i.test(document.getElementById('createSourceTitle').textContent)`, 20000);
  await setControl('createAspect', '9:16');
  await setControl('createRes', 'auto');
  await setControl('createFps', '30');
  await sleep(400);
  const createBeforeWatchAuto = await createState();

  await js(`document.querySelector('.tab[data-tab="presets"]').click(); true`);
  await sleep(250);
  await js(`document.getElementById('watchAutoBtn').click(); true`);
  const watchAfter = await waitFor('watch auto',
    `(() => { const n = document.getElementById('watchAutoResult');
      return n.hidden ? null : {
        text: n.textContent,
        state: document.getElementById('watchAutoState').textContent,
        quality: document.getElementById('watchQuality').value,
        adaptive: document.getElementById('adaptiveToggle').checked,
        scale: document.getElementById('scaleSelect').value,
        why: document.getElementById('watchAutoExplain').textContent
      }; })()`, 20000);

  check('Watch Auto reports a Look, a realtime quality and adaptive quality',
    /Look/.test(watchAfter.text) && /Realtime quality/.test(watchAfter.text) &&
    /Adaptive quality/.test(watchAfter.text),
    watchAfter.text.replace(/\s+/g, ' ').slice(0, 160));
  check('Watch Auto applied the realtime quality it reported',
    ['auto', 'performance', 'balanced', 'quality'].includes(watchAfter.quality),
    `watchQuality=${watchAfter.quality}`);
  check('Watch Auto never switches the governor off',
    watchAfter.quality !== 'maximum' && watchAfter.adaptive === true,
    `quality=${watchAfter.quality} adaptive=${watchAfter.adaptive}`);
  check('Watch Auto leaves the render resolution on Auto',
    watchAfter.scale === 'auto', watchAfter.scale);
  check('Watch Auto explains itself in plain language',
    watchAfter.why.length > 60, watchAfter.why.replace(/\s+/g, ' ').slice(0, 140));
  check('the Watch panel offers no output frame rate or aspect control',
    await js(`(() => {
      const page = document.querySelector('.tab-page[data-page="presets"]');
      return !page.querySelector('#watchFps, #watchAspect, [id*="watchTargetFps"]');
    })()`));
  // Create's preview badge claims "final processing is applied during render",
  // which is a statement about a render. Over Watch's live picture it is false.
  check('Create\'s preview overlays do not appear over Watch\'s picture',
    await js(`(() => ['createPreviewBadge', 'createEmpty', 'createPreviewError', 'createCropGuide']
      .every(id => { const n = document.getElementById(id); return !n || !n.offsetParent; }))()`));
  await shot('auto-watch-after');

  // The Look's own parameters must be what Fine Tune now shows.
  const fineTune = await js(`(() => {
    document.getElementById('groupFineTune').open = true;
    const active = document.querySelector('.preset-card.active');
    const name = active ? active.querySelector('.pname').textContent : null;
    const preset = (window.VSPresets.BUILTIN || []).find(p => p.name === name);
    if (!preset) return { name, matched: null };
    // Every parameter the Look defines that has a slider must read that value.
    const checked = [];
    const mismatched = [];
    for (const [key, value] of Object.entries(preset.params)) {
      const input = document.getElementById('ctrl_' + key);
      if (!input) continue;
      checked.push(key);
      if (Math.abs(Number(input.value) - Number(value)) > 0.005) mismatched.push(key);
    }
    return { name, checked: checked.length, mismatched };
  })()`);
  check('Fine Tune shows the values the chosen Look actually set',
    fineTune.name && fineTune.checked > 0 && fineTune.mismatched &&
    fineTune.mismatched.length === 0,
    JSON.stringify(fineTune));
  await js(`document.getElementById('groupFineTune').scrollIntoView({ block: 'center' }); true`);
  await sleep(300);
  await shot('auto-watch-finetune');

  /* ================= CREATE ================= */

  say('\nCreate');
  await js(`document.querySelector('.tab[data-tab="create"]').click(); true`);
  await sleep(300);

  const createAfterWatchAuto = await createState();
  check('a Watch Auto run leaves the Create recipe entirely alone',
    JSON.stringify(createBeforeWatchAuto) === JSON.stringify(createAfterWatchAuto),
    `before=${JSON.stringify(createBeforeWatchAuto)} after=${JSON.stringify(createAfterWatchAuto)}`);

  // Reset to the state a first-time user meets, and photograph it.
  await setControl('createAspect', 'source');
  await setControl('createRes', 'auto');
  await setControl('createFps', 'source');
  await sleep(300);
  const simple = await js(`(() => {
    const advanced = document.getElementById('createAdvancedShell');
    const visible = (id) => { const n = document.getElementById(id);
      return !!(n && !n.hidden && n.offsetParent); };
    return {
      advancedOpen: advanced.open,
      basics: ['createPlatform','createAspect','createRes','createFps'].filter(visible).length,
      button: document.getElementById('autoBuildBtn').textContent.trim(),
      // Everything technical must be inside the disclosure, not beside it.
      neuralOutside: !!document.querySelector(
        '.tab-page[data-page="create"] > .module #createAi'),
      groups: document.querySelectorAll('#createAdvancedShell .group').length
    };
  })()`);
  check('Create opens on a simple path: four choices and one button',
    simple.advancedOpen === false && simple.basics === 4 &&
    /auto configure/i.test(simple.button) && !simple.neuralOutside,
    JSON.stringify(simple));
  check('the full workstation is still there, one disclosure away',
    simple.groups >= 5, `${simple.groups} advanced sections`);
  await shot('auto-create-simple');

  /* ---- one control per setting, and one element per id ----
   *
   * The rule is: BASIC asks what you want, ADVANCED asks how to achieve it.
   * A second frame-rate select under Motion breaks that rule and, worse,
   * makes two controls authoritative for one recipe field. */
  const duplication = await js(`(() => {
    const page = document.querySelector('.tab-page[data-page="create"]');
    const advanced = document.getElementById('createAdvancedShell');
    const labelsIn = (root) => [...root.querySelectorAll('label')]
      .map(l => l.textContent.replace(/\\s+/g, ' ').trim().toLowerCase());
    const BASIC = ['target', 'aspect ratio', 'resolution', 'frame rate'];
    const pageLabels = labelsIn(page);
    const advancedLabels = labelsIn(advanced);
    const counts = {};
    for (const name of BASIC) {
      counts[name] = pageLabels.filter(l => l === name).length;
    }
    // Any id appearing twice makes getElementById silently pick the first —
    // which is exactly how the "Keep audio" switch stopped being read at all.
    const ids = [...document.querySelectorAll('[id]')].map(n => n.id);
    const duplicateIds = ids.filter((id, i) => ids.indexOf(id) !== i);
    return {
      counts,
      inAdvanced: BASIC.filter(name => advancedLabels.includes(name)),
      selects: [...page.querySelectorAll('select')].length,
      duplicateIds
    };
  })()`);
  check('exactly one control per basic setting',
    Object.values(duplication.counts).every((n) => n === 1),
    JSON.stringify(duplication.counts));
  check('no basic setting is repeated inside Advanced',
    duplication.inAdvanced.length === 0, duplication.inAdvanced.join(', ') || 'none');
  check('no element id is used twice in the whole application',
    duplication.duplicateIds.length === 0, duplication.duplicateIds.join(', ') || 'none');

  /* ---- one source system, in two states ---- */
  const sourceModule = await js(`(() => {
    const visible = (id) => { const n = document.getElementById(id);
      return !!(n && !n.hidden && n.offsetParent); };
    return {
      card: visible('createSourceCard'),
      changeBtn: visible('createChangeSourceBtn'),
      picker: visible('createSourcePicker'),
      urlPanel: visible('createUrlPanel'),
      kind: document.getElementById('createSourceKind').textContent,
      brief: document.getElementById('analysisBrief').textContent.replace(/\\s+/g, ' ').trim(),
      detailsOpen: document.getElementById('analysisDetails').open
    };
  })()`);
  check('an active source shows a card, not a picker and not a URL box',
    sourceModule.card && sourceModule.changeBtn &&
    !sourceModule.picker && !sourceModule.urlPanel,
    JSON.stringify(sourceModule));
  check('the card says which kind of source it is',
    /local source/i.test(sourceModule.kind), sourceModule.kind);
  check('source analysis is compact by default, with the facts still visible',
    !sourceModule.detailsOpen && /\d+ × \d+/.test(sourceModule.brief), sourceModule.brief);

  // 1. the user states what they want
  await setControl('createAspect', '9:16');
  await setControl('createRes', 'auto');
  await setControl('createFps', '60');
  await sleep(450);
  const locked = await js(`(() => ({
    note: document.getElementById('createGeometryNote').textContent,
    armed: document.getElementById('autoBuildBtn').classList.contains('is-armed'),
    state: document.getElementById('autoState').textContent,
    guide: !document.getElementById('createCropGuide').hidden,
    guideLabel: document.getElementById('createCropGuideLabel').textContent
  }))()`);
  check('the panel states the output the choices describe',
    /1080\s*×\s*1920/.test(locked.note), locked.note);
  check('the crop guide shows the new shape over the source preview, labelled as a guide',
    locked.guide && /guide/i.test(locked.guideLabel), JSON.stringify(locked));
  await shot('auto-create-locks');

  // 2. Auto Configure
  await js(`document.getElementById('autoBuildBtn').click(); true`);
  const configured = await waitFor('auto configure',
    `(() => { const n = document.getElementById('autoResult');
      return n.hidden ? null : {
        text: n.textContent,
        state: document.getElementById('autoState').textContent,
        aspect: document.getElementById('createAspect').value,
        res: document.getElementById('createRes').value,
        fps: document.getElementById('createFps').value,
        framing: document.getElementById('createFraming').value,
        interp: document.getElementById('createInterp').value,
        ai: document.getElementById('createAi').value,
        unmet: document.getElementById('autoUnmet').hidden
          ? '' : document.getElementById('autoUnmet').textContent,
        why: document.getElementById('autoExplain').textContent
      }; })()`, 60000);

  check('Auto Configure reports source, output, what it chose and what it costs',
    /Source/.test(configured.text) && /Output/.test(configured.text) &&
    /Visionance chose/i.test(configured.text) && /Cost/.test(configured.text),
    configured.text.replace(/\s+/g, ' ').slice(0, 200));
  check('the recipe state says these are Visionance\'s settings',
    /configured/i.test(configured.state), configured.state);
  check('the user\'s own choices survived Auto untouched',
    configured.aspect === '9:16' && configured.res === 'auto' && configured.fps === '60',
    JSON.stringify({ aspect: configured.aspect, res: configured.res, fps: configured.fps }));
  check('the output really is what was asked for',
    /1080×1920/.test(configured.text) && /60 fps/.test(configured.text),
    configured.text.replace(/\s+/g, ' ').slice(0, 160));
  check('a 16:9 source into a 9:16 output produced a framing decision',
    ['smart', 'fill', 'fit', 'fit-black'].includes(configured.framing), configured.framing);

  // Two cost figures that can disagree is worse than one. The resolved plan is
  // the authority, and it must reach both places the cost is shown.
  // The chip starts life carrying Auto's own estimate, so the two agreeing is
  // itself the evidence that the resolved plan has landed and overwritten it.
  const cost = await waitFor('resolved cost',
    `(() => { const p = document.getElementById('createCostPreview');
      const chip = document.getElementById('autoCostChip');
      if (p.hidden || !chip) return null;
      const preview = document.getElementById('createCostClass').textContent;
      if (preview !== chip.textContent) return null;
      return { preview, auto: chip.textContent,
               neural: document.getElementById('createAi').value !== 'off',
               detail: document.getElementById('createCostDetail').textContent };
    })()`, 40000);
  check('the cost Auto reports is the cost the resolved plan reports',
    cost.preview === cost.auto, JSON.stringify(cost));
  check('a job that runs a network is never labelled fast',
    !cost.neural || !/fast/i.test(cost.auto), JSON.stringify(cost));

  // Whatever it decided about 24 -> 60, it must be truthful about it.
  const rifeReady = await js(`(async () => { const r = await window.visionance.engines.status();
    return !!(r.ok && r.engines.rife && r.engines.rife.status === 'ready'); })()`);
  if (rifeReady) {
    check('with RIFE installed, 60 fps is reached by generating frames',
      configured.interp === 'ai', `interpolation=${configured.interp}`);
    check('...and it is not described as anything else',
      /RIFE/.test(configured.text), configured.text.replace(/\s+/g, ' ').slice(0, 160));
  } else {
    check('without RIFE, the shortfall is stated rather than hidden',
      /RIFE/i.test(configured.unmet) && /not interpolation/i.test(configured.text),
      configured.unmet.replace(/\s+/g, ' ').slice(0, 160));
  }
  await shot('auto-create-configured');

  // 3. the reasoning
  await js(`document.getElementById('autoWhy').open = true;
    document.getElementById('autoWhy').scrollIntoView({ block: 'center' }); true`);
  await sleep(350);
  check('"Why these settings?" opens the full technical account',
    configured.why.length > 120, configured.why.replace(/\s+/g, ' ').slice(0, 140));
  await shot('auto-create-why');

  // 4. advanced, after Auto
  await js(`document.getElementById('createAdvancedShell').open = true;
    document.getElementById('groupEnhancement').open = true;
    document.getElementById('groupMotion').open = true;
    document.getElementById('groupEnhancement').scrollIntoView({ block: 'center' }); true`);
  await sleep(400);
  const advanced = await js(`(() => ({
    ai: document.getElementById('createAi').value,
    aiQuality: document.getElementById('createAiQuality').value,
    interp: document.getElementById('createInterp').value,
    framing: document.getElementById('createFraming').value,
    audio: document.getElementById('createKeepAudio').checked,
    sections: [...document.querySelectorAll('#createAdvancedShell .group summary')]
      .map(s => s.textContent.replace(/\\s+/g, ' ').trim())
  }))()`);
  check('Advanced shows the settings Auto actually chose, not defaults',
    advanced.interp === configured.interp && advanced.framing === configured.framing &&
    advanced.ai === configured.ai,
    JSON.stringify(advanced).slice(0, 200));
  check('every advanced section is still present after the restructure',
    advanced.sections.length >= 5, advanced.sections.join(' / '));
  await shot('auto-create-advanced');

  /* The processing summary has to describe the recipe that would run. The
     "Keep audio" switch shared an id with the preview's <audio> element, so it
     was never read: the summary said "No audio" about a clip that has some,
     and the recipe agreed with the summary. */
  const audioTruth = await js(`(() => {
    const keep = document.getElementById('createKeepAudio');
    const summary = () => [...document.getElementById('renderSummary').children]
      .map(c => c.textContent);
    const on = summary();
    keep.checked = false; keep.dispatchEvent(new Event('change'));
    const off = summary();
    keep.checked = true; keep.dispatchEvent(new Event('change'));
    return { on, off, tag: document.getElementById('tagAudio').textContent };
  })()`);
  check('the processing summary tells the truth about audio',
    !audioTruth.on.includes('No audio') && audioTruth.off.includes('No audio'),
    JSON.stringify(audioTruth));

  // 5. editing an advanced control marks the result edited without resetting it
  await setControl('createFraming', 'fill');
  await sleep(300);
  const edited = await js(`(() => ({
    state: document.getElementById('autoState').textContent,
    framing: document.getElementById('createFraming').value,
    resultStillThere: !document.getElementById('autoResult').hidden,
    aspect: document.getElementById('createAspect').value,
    fps: document.getElementById('createFps').value
  }))()`);
  check('editing an advanced setting marks the recipe edited rather than discarding it',
    /edited/i.test(edited.state) && edited.framing === 'fill' && edited.resultStillThere,
    JSON.stringify(edited));
  check('...and the locks are still the locks',
    edited.aspect === '9:16' && edited.fps === '60', JSON.stringify(edited));

  // 6. changing a lock re-arms Auto rather than silently recomputing
  await setControl('createRes', '1280x720');
  await sleep(350);
  const rearmed = await js(`(() => ({
    state: document.getElementById('autoState').textContent,
    armed: document.getElementById('autoBuildBtn').classList.contains('is-armed'),
    res: document.getElementById('createRes').value,
    // The previous account must not silently start describing the new request.
    result: document.getElementById('autoResult').textContent
  }))()`);
  check('changing a lock re-arms Auto Configure instead of recomputing behind the user',
    /ready/i.test(rearmed.state) && rearmed.armed && rearmed.res === '1280x720',
    JSON.stringify({ state: rearmed.state, armed: rearmed.armed }));

  await js(`document.getElementById('autoBuildBtn').click(); true`);
  const reconfigured = await waitFor('re-auto',
    `(() => { const s = document.getElementById('autoState').textContent;
      return /configured/i.test(s) ? {
        text: document.getElementById('autoResult').textContent,
        res: document.getElementById('createRes').value,
        framing: document.getElementById('createFraming').value
      } : null; })()`, 60000);
  check('re-running Auto decides again around the new requirement',
    /1280×720/.test(reconfigured.text) && reconfigured.res === '1280x720',
    reconfigured.text.replace(/\s+/g, ' ').slice(0, 160));

  /* ---- a second, differently-shaped real source ---- */

  if (clips.vertical) {
    win.webContents.send('open-external-file', clips.vertical);
    await waitFor('vertical clip', `(() => { const v = document.getElementById('video');
      return v.videoWidth > 0 && v.videoHeight > v.videoWidth; })()`, 40000);
    await js(`document.querySelector('.tab[data-tab="create"]').click(); true`);
    await sleep(200);
    await js(`document.getElementById('createUseWatchBtn').click(); true`);
    await waitFor('vertical create source',
      `/auto-9x16/i.test(document.getElementById('createSourceTitle').textContent)`, 20000);
    await setControl('createAspect', '9:16');
    await setControl('createRes', 'auto');
    await setControl('createFps', 'source');
    await sleep(300);
    await js(`document.getElementById('autoBuildBtn').click(); true`);
    const vertical = await waitFor('vertical auto',
      `(() => { const s = document.getElementById('autoState').textContent;
        return /configured/i.test(s) ? {
          text: document.getElementById('autoResult').textContent,
          why: document.getElementById('autoExplain').textContent,
          framing: document.getElementById('createFraming').value
        } : null; })()`, 60000);
    check('a vertical source into a vertical output is not cropped for no reason',
      !/Smart Reframe/.test(vertical.text),
      vertical.text.replace(/\s+/g, ' ').slice(0, 160));
    check('...and it says so',
      /without cropping|fits the canvas/i.test(vertical.why),
      vertical.why.replace(/\s+/g, ' ').slice(0, 160));
  }

  check('no uncaught renderer errors during the whole run',
    pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
}

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  const deadline = setTimeout(() => {
    say('\nFAIL — harness timed out');
    writeReport();
    app.exit(1);
  }, 420000);

  for (let i = 0; i < 100 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (!win) await sleep(100);
  }
  if (!win) {
    say('FAIL — no window was created');
    writeReport();
    return app.exit(1);
  }
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
    say(`\nFAIL — ${err.message}`);
    results.push({ label: 'harness', pass: false, detail: err.message });
  }

  clearTimeout(deadline);
  const failed = results.filter((r) => !r.pass);
  say(`\nScreenshots:\n${shots.map((s) => '  ' + s).join('\n')}`);
  say(`\n${failed.length ? `FAIL — ${failed.length} of ${results.length}` : `PASS — ${results.length} checks`}\n`);
  writeReport();
  app.exit(failed.length ? 1 : 0);
});
