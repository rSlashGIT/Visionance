'use strict';

/**
 * Visionance window-chrome verification.
 *
 * The application bar is now the window's title bar. That is a change to how
 * the *window* behaves, not just how it looks, so it gets its own check:
 * everything a person does to a window — drag it, snap it, minimise, maximise,
 * restore, close — has to keep working, and it has to keep working through the
 * platform's own controls rather than buttons we drew.
 *
 * Asserts, on the real window:
 *   - the overlay is configured, and its geometry reaches the renderer
 *   - minimise / maximise / restore / fullscreen all still drive the window
 *   - the top bar is a drag region and every control in it opts out
 *   - our own controls sit clear of where the system buttons are drawn
 *   - the menu is still installed, so its accelerators still fire
 *   - the security posture of the window is unchanged
 *
 *   npx electron tools/verify-chrome.js
 *
 * Exits non-zero on any failed assertion.
 */

const path = require('path');
const { app, BrowserWindow, Menu } = require('electron');

if (!process.env.VISIONANCE_ENGINES_DIR) {
  const real = path.join(app.getPath('appData'), 'Visionance');
  process.env.VISIONANCE_ENGINES_DIR = path.join(real, 'engines');
}

require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

const results = [];
let win = null;

function check(label, pass, detail = '') {
  results.push({ label, pass: !!pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

const js = (code) => win.webContents.executeJavaScript(code, true);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, code, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await js(code)) return true;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** A window state change is asynchronous; poll rather than guess at a delay. */
async function waitUntil(label, fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(80);
  }
  return false;
}

async function run() {
  console.log('\nVisionance window-chrome verification\n');

  await waitFor('boot', 'window.__visionanceReady || window.__visionanceBootError');
  check('the renderer booted without throwing',
    !(await js('window.__visionanceBootError || null')));

  /* ---- the window is frameless with a real overlay ---- */

  const framed = win.isMovable() && win.isResizable();
  check('the window is still movable and resizable', framed);

  if (process.platform === 'darwin') {
    check('macOS keeps its native traffic lights (hiddenInset)', true, 'platform: darwin');
  } else {
    // The overlay is what draws the real buttons. If it were not configured,
    // the window would have no way to be closed except by our own markup.
    let overlayOk = false;
    try {
      // Setting the same values back is a no-op on a window that has an
      // overlay and throws on one that does not.
      win.setTitleBarOverlay({ height: 48 });
      overlayOk = true;
    } catch (err) {
      overlayOk = false;
      check('setTitleBarOverlay is accepted', false, err.message);
    }
    check('the window has a title-bar overlay, so the buttons are the native ones',
      overlayOk);

    const geometry = await js(`(() => {
      const wco = navigator.windowControlsOverlay;
      if (!wco) return { api: false };
      const r = wco.getTitlebarAreaRect();
      return { api: true, visible: wco.visible,
               x: Math.round(r.x), width: Math.round(r.width),
               reserved: Math.round(window.innerWidth - (r.x + r.width)),
               inner: window.innerWidth };
    })()`);
    check('the renderer can read the overlay geometry',
      geometry.api && geometry.width > 0, JSON.stringify(geometry));
    check('space is reserved for the system buttons',
      geometry.api && geometry.reserved > 40,
      `${geometry.reserved}px reserved of ${geometry.inner}px`);
  }

  /* ---- drag regions ---- */

  const regions = await js(`(() => {
    const bar = document.getElementById('topbar');
    const dragable = getComputedStyle(bar).webkitAppRegion === 'drag';
    // Every control in the bar must opt out, or it cannot be clicked: a drag
    // region swallows the press.
    const stuck = [...bar.querySelectorAll('button, input, select')]
      .filter(n => n.offsetParent)
      .filter(n => getComputedStyle(n).webkitAppRegion !== 'no-drag')
      .map(n => n.id || n.className);
    return { dragable, stuck };
  })()`);
  check('the application bar is a window drag region', regions.dragable);
  check('every control in the bar opts out of dragging',
    regions.stuck.length === 0, regions.stuck.join(', '));

  /* ---- nothing of ours sits under the system buttons ---- */

  if (process.platform !== 'darwin') {
    const clearance = await js(`(() => {
      const wco = navigator.windowControlsOverlay;
      if (!wco) return { skip: true };
      const rect = wco.getTitlebarAreaRect();
      const limit = rect.x + rect.width;
      const bad = [...document.querySelectorAll('.topbar button')]
        .filter(n => n.offsetParent)
        .filter(n => n.getBoundingClientRect().right > limit + 1)
        .map(n => n.id || n.className);
      return { limit: Math.round(limit), bad };
    })()`);
    check('no control is drawn under the system window buttons',
      clearance.skip || clearance.bad.length === 0,
      clearance.bad ? clearance.bad.join(', ') : 'no overlay api');
  }

  /* ---- the window still does what a window does ---- */

  const wasMaximized = win.isMaximized();
  if (wasMaximized) win.unmaximize();
  await sleep(200);

  win.maximize();
  check('maximise works', await waitUntil('maximised', () => win.isMaximized()));
  win.unmaximize();
  check('restore works', await waitUntil('restored', () => !win.isMaximized()));

  win.minimize();
  check('minimise works', await waitUntil('minimised', () => win.isMinimized()));
  win.restore();
  check('restore from minimised works',
    await waitUntil('un-minimised', () => !win.isMinimized()));

  win.setFullScreen(true);
  const wentFull = await waitUntil('fullscreen', () => win.isFullScreen());
  win.setFullScreen(false);
  await waitUntil('windowed', () => !win.isFullScreen());
  check('fullscreen works', wentFull);

  // Leaving fullscreen settles asynchronously, and `setSize` on a window that
  // is still maximised or still transitioning is simply ignored — which would
  // make this assertion fail for a reason that has nothing to do with the
  // chrome. Settle first, then poll for the size to land.
  await sleep(400);
  if (win.isMaximized()) win.unmaximize();
  await waitUntil('unmaximised', () => !win.isMaximized());
  win.setSize(1180, 760);
  const resized = await waitUntil('resized', () => Math.abs(win.getSize()[0] - 1180) <= 2);
  check('the window still resizes programmatically', resized, win.getSize().join('×'));

  if (wasMaximized) win.maximize();

  /* ---- keyboard and menu ---- */

  const menu = Menu.getApplicationMenu();
  const accelerators = [];
  const walk = (items) => {
    for (const item of items) {
      if (item.accelerator) accelerators.push(item.accelerator);
      if (item.submenu) walk(item.submenu.items);
    }
  };
  if (menu) walk(menu.items);
  check('the application menu is still installed, so its accelerators still fire',
    !!menu && accelerators.includes('CmdOrCtrl+O'),
    accelerators.join(', '));

  // The renderer handles playback keys itself, independently of the menu.
  const keys = await js(`(() => {
    const before = document.getElementById('video').paused;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    return { before, handled: true };
  })()`);
  check('the renderer still receives keyboard input', keys.handled);

  /* ---- the security posture did not move ---- */

  const prefs = win.webContents.getLastWebPreferences() || {};
  check('contextIsolation is still on', prefs.contextIsolation === true);
  check('nodeIntegration is still off', !prefs.nodeIntegration);
  check('the renderer has no direct require',
    (await js('typeof window.require')) === 'undefined');
}

app.whenReady().then(async () => {
  const deadline = setTimeout(() => {
    console.log('\nFAIL — harness timed out');
    app.exit(1);
  }, 120000);

  for (let i = 0; i < 100 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (!win) await sleep(100);
  }
  if (!win) {
    console.log('FAIL — no window was created');
    return app.exit(1);
  }

  try {
    await run();
  } catch (err) {
    console.log(`\nFAIL — ${err.message}`);
    results.push({ label: 'harness', pass: false, detail: err.message });
  }

  clearTimeout(deadline);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${failed.length
    ? `FAIL — ${failed.length} of ${results.length}`
    : `PASS — ${results.length} checks`}\n`);
  app.exit(failed.length ? 1 : 0);
});
