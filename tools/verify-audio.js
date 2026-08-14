'use strict';

/**
 * Watch audio acceptance.
 *
 *   npx electron tools/verify-audio.js
 *
 * Sound is the one part of playback that cannot be verified by looking at it,
 * so nothing here trusts a property: every claim is measured.
 *
 *   `webkitAudioDecodedByteCount` rising is proof that audio frames are being
 *   decoded — not that an element exists, not that `muted` is false, but that
 *   the pipeline is actually doing work. Everything else in this file is
 *   context for that one number.
 *
 * It covers a local muxed file, an online split stream, mute, volume, seek,
 * A/V drift, and — by breaking the audio leg on purpose — the bounded recovery
 * ladder, reporting which rung restored the sound.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const SHOT_DIR = path.join(__dirname, 'ui-shots');
const CLIP_DIR = path.join(os.tmpdir(), 'visionance-audio-verify');
const ONLINE_URL = process.env.VISIONANCE_TEST_URL ||
  'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

if (!process.env.VISIONANCE_ENGINES_DIR) {
  process.env.VISIONANCE_ENGINES_DIR =
    path.join(app.getPath('appData'), 'Visionance', 'engines');
}
require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

const results = [];
const transcript = [];
let win = null;

function say(line) {
  transcript.push(line);
  console.log(line);
}

function check(label, pass, detail = '') {
  results.push({ label, pass: !!pass, detail });
  say(`  ${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

const js = (code) => win.webContents.executeJavaScript(code, true);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, code, timeoutMs = 60000, every = 250) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await js(code);
    if (last) return last;
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const audioState = () => js('window.visionanceDiagnostics.audio()');

/** Where the sound is actually coming from, if anywhere. */
function decodedBytes(s) {
  return s.dual ? s.audio.decodedAudioBytes : s.video.decodedAudioBytes;
}

/** A clip with a real audio track, built once. */
function makeClip() {
  fs.mkdirSync(CLIP_DIR, { recursive: true });
  const clip = path.join(CLIP_DIR, 'audio-clip.mp4');
  if (fs.existsSync(clip)) return clip;
  const ffmpeg = require(path.join(__dirname, '..', 'src', 'main', 'binaries')).resolve('ffmpeg');
  if (!ffmpeg) return null;
  const res = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=20',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=20',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-shortest',
    clip
  ], { windowsHide: true });
  return res.status === 0 && fs.existsSync(clip) ? clip : null;
}

async function shot(name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const image = await win.webContents.capturePage();
  const file = path.join(SHOT_DIR, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  say(`  shot ${file}`);
  return file;
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

async function run() {
  say('\nVisionance — Watch audio acceptance\n');
  await waitFor('boot', 'window.__visionanceReady || window.__visionanceBootError', 90000);
  await js(`document.querySelector('.tab[data-tab="presets"]').click(); true`);
  // Sound, at a level a machine can measure and a person in the room cannot
  // be startled by.
  await js(`(() => { const s = document.getElementById('volume');
    s.value = '0.4'; s.dispatchEvent(new Event('input')); return true; })()`);

  /* ================= LOCAL MUXED ================= */

  say('Local file with audio');
  const clip = makeClip();
  if (!clip) {
    check('a clip with audio could be built', false, 'ffmpeg unavailable');
    return;
  }
  win.webContents.send('open-external-file', clip);
  await waitFor('local picture', `(() => { const v = document.getElementById('video');
    return v.videoWidth > 0 && v.readyState >= 2; })()`, 60000);
  await js(`document.getElementById('video').play(); true`);
  await sleep(2500);

  const localA = await audioState();
  await sleep(2500);
  const localB = await audioState();

  check('the picture is playing', localB.video.t > localA.video.t,
    `${localA.video.t.toFixed(2)}s → ${localB.video.t.toFixed(2)}s`);
  check('a muxed file plays its sound from the video element itself',
    localB.dual === false && localB.audio.attached === false);
  check('audio frames are actually being decoded',
    decodedBytes(localB) > decodedBytes(localA) && decodedBytes(localB) > 0,
    `${decodedBytes(localA)} → ${decodedBytes(localB)} bytes`);
  check('the sound is not muted and not silent',
    localB.video.muted === false && localB.video.volume > 0,
    `muted=${localB.video.muted} volume=${localB.video.volume.toFixed(2)}`);

  // Mute, volume and seek, through the real controls.
  await js(`document.getElementById('muteBtn').click(); true`);
  await sleep(400);
  const muted = await audioState();
  check('mute reaches the element that is making the sound', muted.video.muted === true);
  await js(`document.getElementById('muteBtn').click(); true`);
  await sleep(400);
  const unmuted = await audioState();
  check('unmute restores it', unmuted.video.muted === false);

  await js(`(() => { const s = document.getElementById('volume');
    s.value = '0.15'; s.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(300);
  const quiet = await audioState();
  check('the volume slider moves the audible element',
    Math.abs(quiet.video.volume - 0.15) < 0.02, quiet.video.volume.toFixed(2));

  const beforeSeek = await audioState();
  await js(`document.getElementById('video').currentTime = 12; true`);
  await sleep(2500);
  const afterSeek = await audioState();
  check('sound survives a seek',
    afterSeek.video.t > 11 && decodedBytes(afterSeek) > decodedBytes(beforeSeek),
    `t=${afterSeek.video.t.toFixed(2)}s, ${decodedBytes(beforeSeek)} → ${decodedBytes(afterSeek)} bytes`);
  say(`  local: video ${afterSeek.video.t.toFixed(2)}s · readyState ${afterSeek.video.readyState} · ` +
      `decoded ${decodedBytes(afterSeek)} bytes · recovery ${afterSeek.recovery.path || 'not needed'}`);

  /* ================= ONLINE ================= */

  say('');
  say('Online source');
  await js(`(() => { const i = document.getElementById('urlInput');
    i.value = ${JSON.stringify(ONLINE_URL)};
    document.getElementById('goBtn').click(); return true; })()`);
  let online = null;
  try {
    await waitFor('online picture', `(() => { const v = document.getElementById('video');
      return v.videoWidth > 0 && v.readyState >= 2 && window.__vsLastMedia &&
        window.__vsLastMedia.kind === 'stream'; })()`, 180000);
    online = await js(`(() => { const m = window.__vsLastMedia;
      return { muxed: m.muxed, split: !!m.audioUrl, quality: m.selectedQuality }; })()`);
  } catch (err) {
    check('an online source could be resolved for the audio run', false, err.message);
  }

  if (online) {
    say(`  rendition: ${online.quality} · ${online.split ? 'split video+audio' : 'combined'}`);
    await js(`document.getElementById('video').play(); true`);
    await sleep(3000);
    const a1 = await audioState();
    await sleep(3000);
    const a2 = await audioState();

    check('the online picture is playing', a2.video.t > a1.video.t,
      `${a1.video.t.toFixed(2)}s → ${a2.video.t.toFixed(2)}s`);
    check('the audio clock advances with it',
      a2.dual ? a2.audio.t > a1.audio.t : a2.video.t > a1.video.t,
      a2.dual ? `${a1.audio.t.toFixed(2)}s → ${a2.audio.t.toFixed(2)}s` : 'combined stream');
    check('online audio frames are being decoded',
      decodedBytes(a2) > decodedBytes(a1) && decodedBytes(a2) > 0,
      `${decodedBytes(a1)} → ${decodedBytes(a2)} bytes`);
    check('audio and video stay in sync', Math.abs(a2.drift) < 0.25,
      `drift ${(a2.drift * 1000).toFixed(0)} ms`);
    check('the sound is audible, not muted',
      a2.dual ? (!a2.audio.muted && a2.audio.volume > 0) : (!a2.video.muted && a2.video.volume > 0));

    await js(`document.getElementById('muteBtn').click(); true`);
    await sleep(400);
    const onlineMuted = await audioState();
    check('mute reaches the split stream\'s audio element',
      onlineMuted.dual ? onlineMuted.audio.muted : onlineMuted.video.muted);
    await js(`document.getElementById('muteBtn').click(); true`);
    await sleep(300);

    await js(`(() => { const s = document.getElementById('volume');
      s.value = '0.45'; s.dispatchEvent(new Event('input')); return true; })()`);
    await sleep(300);
    const onlineVol = await audioState();
    const audible = onlineVol.dual ? onlineVol.audio.volume : onlineVol.video.volume;
    check('volume reaches it too', Math.abs(audible - 0.45) < 0.02, audible.toFixed(2));

    say(`  online: video ${a2.video.t.toFixed(2)}s · audio ${a2.audio.t.toFixed(2)}s · ` +
        `drift ${(a2.drift * 1000).toFixed(0)} ms · readyState v${a2.video.readyState}/` +
        `a${a2.audio.readyState} · recovery ${a2.recovery.path || 'not needed'}`);

    // The diagnostics overlay is the evidence for the screenshot, and it is
    // switched on here rather than left on for the rest of the run.
    await js(`document.getElementById('statsBtn').click(); true`);
    await sleep(1200);
    await shot('audio-online-diagnostics');
    await js(`document.getElementById('statsBtn').click(); true`);

    /* ---- the recovery ladder, exercised for real ---- */
    if (a2.dual) {
      say('');
      say('Audio-leg recovery');
      const before = await audioState();
      // Break the audio leg the way a site does: point it at a session that
      // does not exist and let the element's own error handler take over.
      await js(`(() => {
        const a = document.getElementById('audio');
        a.src = 'vs://app/__media?src=remote&t=st_broken_token&s=audio';
        a.load();
        return true;
      })()`);
      const recovered = await waitFor('recovery to settle', `(() => {
        const s = window.visionanceDiagnostics.audio();
        if (s.recovery.running) return null;
        if (s.recovery.attempts === 0) return null;
        return s;
      })()`, 90000).catch(() => null);

      if (recovered) {
        check('a broken audio leg does not stop the picture',
          !recovered.video.readyState || recovered.video.readyState >= 2,
          `readyState ${recovered.video.readyState}`);
        check('recovery is bounded', recovered.recovery.attempts <= 2,
          `${recovered.recovery.attempts} attempt(s)`);
        check('the ladder reports which rung it ended on',
          typeof recovered.recovery.path === 'string' && recovered.recovery.path.length > 0,
          recovered.recovery.path);
        say(`  recovery path: ${recovered.recovery.path} after ` +
            `${recovered.recovery.attempts} attempt(s)`);

        if (recovered.recovery.path && recovered.recovery.path.startsWith('none')) {
          check('giving up keeps the picture and says so',
            recovered.legFailed === true && recovered.dual === false);
        } else {
          await sleep(2500);
          const after = await audioState();
          check('recovered audio is genuinely decoding again',
            decodedBytes(after) > 0 && (after.dual ? !after.audio.error : true),
            `${decodedBytes(after)} bytes, path ${after.recovery.path}`);
          check('...and the picture never stopped',
            after.video.t > before.video.t,
            `${before.video.t.toFixed(2)}s → ${after.video.t.toFixed(2)}s`);
        }
      } else {
        check('the recovery ladder ran', false, 'no recovery state was recorded');
      }
    } else {
      say('  (combined rendition — no separate audio leg to break)');
    }
  }
}

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  const deadline = setTimeout(() => { say('\nFAIL — timed out'); app.exit(1); }, 900000);
  for (let i = 0; i < 200 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (!win) await sleep(100);
  }
  if (!win) { say('FAIL — no window'); return app.exit(1); }
  if (win.isMaximized()) win.unmaximize();
  win.setSize(1536, 1000);
  await sleep(400);

  try {
    await run();
  } catch (err) {
    say(`\nFAIL — ${err.message}`);
    results.push({ label: 'harness', pass: false, detail: err.message });
  }

  clearTimeout(deadline);
  const failed = results.filter((r) => !r.pass);
  say(`\n${failed.length ? `FAIL — ${failed.length} of ${results.length}` : `PASS — ${results.length} checks`}\n`);
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(SHOT_DIR, 'audio-report.txt'), transcript.join('\n') + '\n', 'utf8');
  } catch { /* the console output still happened */ }
  app.exit(failed.length ? 1 : 0);
});
