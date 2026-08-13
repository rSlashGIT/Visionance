'use strict';

/**
 * Visionance - main process.
 *
 * Responsibilities:
 *   - create the (context-isolated) window
 *   - serve renderer assets and media over a privileged `vs://` scheme so that
 *     video frames can be read into WebGL without tainting the canvas
 *   - expose a narrow, validated IPC surface to the renderer
 *   - own the backend services: source analysis, stream resolution, the render
 *     job system and capability detection
 *
 * Everything with real logic lives in its own module. This file is wiring.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  shell,
  net,
  protocol,
  powerSaveBlocker,
  nativeTheme
} = require('electron');

const { Store } = require('./store');
const binaries = require('./binaries');
const ytdlp = require('./ytdlp');
const recipes = require('./recipe');
const autoRecipe = require('./auto-recipe');
const creatorPresets = require('./creator-presets');
const capabilities = require('./capabilities');
const analyzer = require('./media-analyzer');
const { StreamSessionRegistry } = require('./stream-session');
const streamPolicy = require('./stream-policy');
const streamProxy = require('./stream-proxy');
const { JobManager } = require('./jobs/job-manager');
const { EngineManager } = require('./ai/engine-manager');
const jsRuntime = require('./js-runtime');
const { detectEncoders } = require('./ffmpeg/encoders');
const { VisionanceError, CODES, toStructured } = require('./errors');
const { logger } = require('./logger');

/**
 * Development mode is an explicit choice, not "this happens to be unpackaged".
 * A user who double-clicks RUN_VISIONANCE.cmd runs from source and must not be
 * handed a detached DevTools window; a developer runs `npm run dev`.
 */
const IS_DEV =
  process.argv.includes('--dev') ||
  process.env.VISIONANCE_DEV === '1';

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const log = logger.child('main');

/**
 * Pin the application name before anything asks for a path.
 *
 * `app.getPath('userData')` is derived from the app name, and that name is
 * "Electron" when the app is started as `electron <script>` - which is how the
 * verification harnesses run it. Without this, the harnesses would look for
 * settings, installed binaries and AI engines in a different folder from the
 * real app and quietly test nothing.
 */
app.setName('Visionance');

// GPU switches: media playback plus shader work benefits from every bit of
// hardware acceleration we can legally ask for.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'vs',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

/** @type {BrowserWindow|null} */
let win = null;
let store = null;
let jobs = null;
let streams = null;
let engines = null;
let sleepBlockerId = null;
/** Per-leg transfer accounting, so buffering complaints have numbers behind them. */
const transferStats = new streamProxy.TransferStats();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2'
};

const VIDEO_EXTS = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'm4v', 'ts', 'mpg', 'mpeg', 'm2ts', 'ogv', '3gp'];

/** Only forward things that are plausibly playable, not any stray argument. */
function isPlayableFile(p) {
  if (!p || p.startsWith('-')) return false;
  const ext = path.extname(p).slice(1).toLowerCase();
  if (!VIDEO_EXTS.includes(ext)) return false;
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Custom protocol
 * ------------------------------------------------------------------ */

function registerProtocol() {
  protocol.handle('vs', async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    if (url.hostname !== 'app') return new Response('Not found', { status: 404 });

    // Media is served from the same origin as the page on purpose: a
    // cross-origin <video> would taint the WebGL canvas and make the whole
    // enhancement pipeline illegal to read back.
    if (url.pathname === '/__media') {
      return handleMedia(url, request);
    }

    // vs://app/<relative renderer asset>
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const target = path.normalize(path.join(RENDERER_DIR, rel));
    if (target !== RENDERER_DIR && !target.startsWith(RENDERER_DIR + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!fs.existsSync(target)) return new Response('Not found', { status: 404 });
    const body = await fs.promises.readFile(target);
    return new Response(body, {
      status: 200,
      headers: { 'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream' }
    });
  });
}

async function handleMedia(url, request) {
  const kind = url.searchParams.get('src');

  if (kind === 'local') {
    const filePath = url.searchParams.get('p');
    if (!filePath || !path.isAbsolute(filePath) || !fs.existsSync(filePath)) {
      return new Response('Not found', { status: 404 });
    }
    const headers = new Headers();
    const range = request.headers.get('range');
    if (range) headers.set('range', range);
    return net.fetch(pathToFileURL(filePath).toString(), {
      headers,
      bypassCustomProtocolHandlers: true
    });
  }

  if (kind === 'remote') {
    // The renderer never supplies a URL: it supplies a session token and which
    // leg of the stream it wants. That keeps this privileged fetcher from being
    // usable as a general-purpose proxy, and it means a refreshed session is
    // picked up automatically.
    const token = url.searchParams.get('t');
    const leg = url.searchParams.get('s') === 'audio' ? 'audio' : 'video';
    const target = streams.urlFor(token, leg);
    if (!target) return new Response('Unknown stream session', { status: 404 });

    try {
      // Chunked upstream ranges, not a single open-ended request: see the
      // measurements in stream-proxy.js. The video and audio legs arrive as
      // separate protocol.handle invocations and stream independently, so
      // neither waits on the other.
      return await streamProxy.serveRanged({
        url: target,
        headers: streams.headersFor(token, leg) || {},
        request,
        fetchImpl: net.fetch,
        stats: transferStats,
        token,
        leg
      });
    } catch (err) {
      log.warn('remote media fetch failed', { leg, error: err.message });
      return new Response('Upstream error', { status: 502 });
    }
  }

  return new Response('Bad request', { status: 400 });
}

/* ------------------------------------------------------------------ *
 * Window
 * ------------------------------------------------------------------ */

function createWindow() {
  const saved = store.get('window');
  win = new BrowserWindow({
    width: saved.width || 1360,
    height: saved.height || 860,
    x: Number.isInteger(saved.x) ? saved.x : undefined,
    y: Number.isInteger(saved.y) ? saved.y : undefined,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#07070c',
    show: false,
    autoHideMenuBar: true,
    title: 'Visionance',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webgl: true,
      backgroundThrottling: false,
      spellcheck: false
    }
  });

  if (saved.maximized) win.maximize();

  win.once('ready-to-show', () => {
    win.show();
    if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' });
  });

  const persistBounds = () => {
    if (!win || win.isDestroyed()) return;
    const maximized = win.isMaximized();
    const b = maximized ? store.get('window') : win.getBounds();
    store.set('window', {
      width: b.width, height: b.height, x: b.x, y: b.y, maximized
    });
  };
  win.on('resize', debounce(persistBounds, 400));
  win.on('move', debounce(persistBounds, 400));
  win.on('close', persistBounds);
  win.on('closed', () => { win = null; });

  // Never let the renderer navigate itself somewhere else; open real links
  // in the user's browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('vs://app/')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  win.loadURL('vs://app/index.html');
  buildMenu();
}

function buildMenu() {
  const send = (channel, payload) => () => win && win.webContents.send(channel, payload);
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open Video…', accelerator: 'CmdOrCtrl+O', click: send('menu', 'open-file') },
        { label: 'Open URL…', accelerator: 'CmdOrCtrl+L', click: send('menu', 'open-url') },
        { type: 'separator' },
        { label: 'Send to Create…', accelerator: 'CmdOrCtrl+E', click: send('menu', 'create') },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' }
      ]
    },
    {
      label: 'Playback',
      submenu: [
        { label: 'Play / Pause', accelerator: 'Space', click: send('menu', 'toggle-play') },
        { label: 'Toggle Enhancement', accelerator: 'CmdOrCtrl+B', click: send('menu', 'toggle-enhance') },
        { label: 'Compare (Split View)', accelerator: 'CmdOrCtrl+D', click: send('menu', 'toggle-compare') },
        { label: 'Fullscreen', accelerator: 'F11', click: send('menu', 'fullscreen') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Statistics Overlay', accelerator: 'CmdOrCtrl+I', click: send('menu', 'toggle-stats') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        // Kept deliberately: developers must always be able to open DevTools,
        // even though they no longer open by themselves.
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open Settings Folder',
          click: () => shell.openPath(app.getPath('userData'))
        },
        {
          label: 'Open Log Folder',
          click: () => shell.openPath(path.join(app.getPath('userData'), 'logs'))
        },
        {
          label: 'About Visionance',
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: 'About Visionance',
              message: `Visionance ${appVersion()}`,
              detail:
                'Real-time GPU video enhancement and creator finishing.\n\n' +
                `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/**
 * `app.getVersion()` reports Electron's own version when the app is launched as
 * `electron <script>` (as the verification harnesses do), so read our
 * package.json when that happens.
 */
function appVersion() {
  try {
    return require('../../package.json').version;
  } catch {
    return app.getVersion();
  }
}

/* ------------------------------------------------------------------ *
 * Services
 * ------------------------------------------------------------------ */

function binPaths() {
  const overrides = (store.get('settings').binaries) || {};
  return {
    ffmpeg: binaries.resolve('ffmpeg', { override: overrides.ffmpeg }),
    ffprobe: binaries.resolve('ffprobe', { override: overrides.ffprobe }),
    ytdlp: binaries.resolve('yt-dlp', { override: overrides.ytdlp })
  };
}

/**
 * Everything yt-dlp needs to know about this installation: where managed
 * runtimes live, and which executable to test as a Node runtime.
 */
function ytdlpEnv() {
  return {
    userDataDir: app.getPath('userData'),
    electronPath: process.execPath
  };
}

/** The user's configured authentication method, or none. */
function authSettings() {
  const s = store.get('settings').auth || {};
  const mode = ['none', 'browser', 'file'].includes(s.mode) ? s.mode : 'none';
  if (mode === 'browser' && !s.browser) return { mode: 'none' };
  if (mode === 'file' && !s.cookiesFile) return { mode: 'none' };
  return { mode, browser: s.browser || '', cookiesFile: s.cookiesFile || '' };
}

function localMediaUrl(filePath) {
  return `vs://app/__media?src=local&p=${encodeURIComponent(filePath)}`;
}

function remoteMediaUrl(token, leg) {
  return `vs://app/__media?src=remote&t=${encodeURIComponent(token)}&s=${leg}`;
}

function ok(data) { return { ok: true, ...data }; }
function fail(err, fallbackCode) {
  const structured = toStructured(err, fallbackCode || CODES.UNKNOWN);
  return { ok: false, error: structured.message, ...structured };
}

/** Re-resolve an online source for a render job. */
async function resolveRemoteForJob(job) {
  const bins = binPaths();
  const token = job.source.headerToken;

  if (token && streams.get(token) && !streams.isExpired(token)) {
    const s = streams.get(token);
    return {
      video: s.resolved.video.url,
      audio: s.resolved.audio ? s.resolved.audio.url : null,
      headers: {
        video: s.resolved.video.headers,
        audio: s.resolved.audio ? s.resolved.audio.headers : null
      }
    };
  }

  const pageUrl = job.source.webpageUrl;
  if (!pageUrl) {
    throw new VisionanceError(CODES.STREAM_EXPIRED, {
      message: 'This online source expired and cannot be re-resolved (no page URL was recorded).'
    });
  }
  if (!bins.ytdlp) throw new VisionanceError(CODES.YT_DLP_MISSING);

  const resolved = await ytdlp.resolveStream(bins.ytdlp, pageUrl, {
    maxHeight: store.get('settings').maxStreamHeight || null,
    auth: authSettings(),
    allowRemoteComponents: !!store.get('settings').allowRemoteComponents,
    ...ytdlpEnv()
  });
  const fresh = streams.register(resolved);
  job.source.headerToken = fresh;
  return {
    video: resolved.video.url,
    audio: resolved.audio ? resolved.audio.url : null,
    headers: {
      video: resolved.video.headers,
      audio: resolved.audio ? resolved.audio.headers : null
    }
  };
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

/** Wrap a handler so a thrown VisionanceError becomes a structured response. */
function handle(channel, fn, fallbackCode) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (err) {
      log.warn('ipc failed', { channel, code: err && err.code, message: err && err.message });
      return fail(err, fallbackCode);
    }
  });
}

function requireString(value, label, max = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new VisionanceError(CODES.INVALID_REQUEST, { message: `${label} is missing or invalid.` });
  }
  return value;
}

function registerIpc() {
  /* ---------- app ---------- */

  handle('app:info', async () => {
    const bins = binPaths();
    const [ffmpegVer, ytCaps] = await Promise.all([
      binaries.probeVersion(bins.ffmpeg, ['-version']),
      ytdlp.capabilities(bins.ytdlp, ytdlpEnv())
    ]);
    return ok({
      version: appVersion(),
      platform: process.platform,
      arch: process.arch,
      dev: IS_DEV,
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node
      },
      binaries: {
        ffmpeg: { path: bins.ffmpeg, version: ffmpegVer },
        ffprobe: { path: bins.ffprobe },
        ytdlp: {
          path: bins.ytdlp,
          version: ytCaps.version,
          stale: !!ytCaps.stale,
          ageDays: ytCaps.ageDays ?? null,
          jsRuntimes: (ytCaps.jsRuntimes || []).map((r) => r.name),
          supportsJsRuntimeConfig: !!ytCaps.supportsJsRuntimeConfig
        }
      },
      paths: { userData: app.getPath('userData'), videos: app.getPath('videos') },
      dark: nativeTheme.shouldUseDarkColors
    });
  });

  handle('app:capabilities', async (_e, opts = {}) => {
    const bins = binPaths();
    let gpuInfo = null;
    try {
      gpuInfo = await app.getGPUInfo('basic');
    } catch { /* not fatal */ }
    const ytCaps = await ytdlp.capabilities(bins.ytdlp, ytdlpEnv());
    const rep = await capabilities.report({
      bins,
      ytdlp: ytCaps,
      versions: process.versions,
      gpuInfo,
      force: !!opts.force
    });
    return ok({ capabilities: capabilities.serialisable(rep) });
  });

  handle('app:encoders', async () => {
    const encoders = await detectEncoders(binPaths().ffmpeg);
    return ok({ encoders });
  });

  handle('app:logs', () => ok({ lines: logger.recent(200) }));

  /* ---------- dialogs ---------- */

  handle('dialog:openVideo', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Open video',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Video files', extensions: VIDEO_EXTS },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths.length) return fail(new VisionanceError(CODES.CANCELLED));
    return ok({ files: res.filePaths });
  });

  handle('dialog:saveVideo', async (_e, defaultName, container) => {
    const dir = store.get('settings').exportDir || app.getPath('videos');
    const ext = ['mp4', 'mkv', 'mov', 'webm'].includes(container) ? container : 'mp4';
    const res = await dialog.showSaveDialog(win, {
      title: 'Render to…',
      defaultPath: path.join(dir, defaultName || `visionance-render.${ext}`),
      filters: [
        { name: 'MP4 video', extensions: ['mp4'] },
        { name: 'Matroska', extensions: ['mkv'] },
        { name: 'QuickTime', extensions: ['mov'] },
        { name: 'WebM', extensions: ['webm'] }
      ]
    });
    if (res.canceled || !res.filePath) return fail(new VisionanceError(CODES.CANCELLED));
    store.patchSettings({ exportDir: path.dirname(res.filePath) });
    return ok({ file: res.filePath });
  });

  handle('dialog:pickBinary', async (_e, which) => {
    if (!['ffmpeg', 'ffprobe', 'ytdlp'].includes(which)) {
      throw new VisionanceError(CODES.INVALID_REQUEST, { message: 'Unknown binary.' });
    }
    const res = await dialog.showOpenDialog(win, {
      title: `Locate ${which}`,
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths.length) return fail(new VisionanceError(CODES.CANCELLED));
    const p = res.filePaths[0];
    const settings = store.get('settings');
    store.patchSettings({ binaries: { ...settings.binaries, [which]: p } });
    ytdlp.invalidateCapabilities();
    capabilities.invalidate();
    return ok({ path: p });
  });

  handle('dialog:pickCookiesFile', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose a cookies.txt file',
      properties: ['openFile'],
      filters: [{ name: 'Cookies', extensions: ['txt'] }, { name: 'All files', extensions: ['*'] }]
    });
    if (res.canceled || !res.filePaths.length) return fail(new VisionanceError(CODES.CANCELLED));
    const settings = store.get('settings');
    store.patchSettings({ auth: { ...settings.auth, mode: 'file', cookiesFile: res.filePaths[0] } });
    return ok({ path: res.filePaths[0] });
  });

  /* ---------- media ---------- */

  handle('media:open', async (_e, filePath) => {
    requireString(filePath, 'File path');
    if (!path.isAbsolute(filePath) || !fs.existsSync(filePath)) {
      throw new VisionanceError(CODES.SOURCE_NOT_FOUND);
    }
    const bins = binPaths();
    let analysis = null;
    let analysisError = null;
    try {
      analysis = await analyzer.analyze(bins.ffprobe, filePath, { deep: false });
    } catch (err) {
      // Playback does not depend on ffprobe; only report the failure.
      analysisError = toStructured(err, CODES.PROBE_FAILED);
      log.warn('analysis failed on open', { code: analysisError.code });
    }
    const stat = fs.statSync(filePath);
    return ok({
      kind: 'local',
      source: filePath,
      title: path.basename(filePath),
      playbackUrl: localMediaUrl(filePath),
      audioUrl: null,
      analysis,
      analysisError,
      info: analyzer.toLegacyInfo(analysis),
      size: stat.size
    });
  });

  handle('media:analyze', async (_e, target, opts = {}) => {
    const bins = binPaths();
    if (!bins.ffprobe) throw new VisionanceError(CODES.FFPROBE_MISSING);

    if (target && typeof target === 'object' && target.token) {
      const session = streams.get(target.token);
      if (!session) throw new VisionanceError(CODES.STREAM_EXPIRED);
      const leg = target.leg === 'audio' ? 'audio' : 'video';
      const fmt = leg === 'audio' ? session.resolved.audio : session.resolved.video;
      if (!fmt) throw new VisionanceError(CODES.NO_PLAYABLE_FORMAT);
      const analysis = await analyzer.analyze(bins.ffprobe, fmt.url, {
        headers: fmt.headers,
        deep: false,
        timeoutMs: 45000
      });
      return ok({ analysis });
    }

    const filePath = requireString(target, 'File path');
    const analysis = await analyzer.analyze(bins.ffprobe, filePath, { deep: opts.deep !== false });
    return ok({ analysis });
  });

  handle('media:resolveUrl', async (_e, pageUrl, opts = {}) => {
    const bins = binPaths();
    if (!bins.ytdlp) throw new VisionanceError(CODES.YT_DLP_MISSING);
    requireString(pageUrl, 'URL');

    const settings = store.get('settings');

    // Decide how much stream this machine and this window can actually use,
    // rather than taking the largest rendition the site advertises.
    const decision = streamPolicy.chooseStreamHeight({
      viewportWidth: Number(opts.viewportWidth) || 0,
      viewportHeight: Number(opts.viewportHeight) || 0,
      devicePixelRatio: Number(opts.devicePixelRatio) || 1,
      screenWidth: Number(opts.screenWidth) || 0,
      screenHeight: Number(opts.screenHeight) || 0,
      userMaxHeight: Number(settings.maxStreamHeight) || 0,
      enhancement: !!opts.enhancement,
      watchQuality: opts.watchQuality || settings.watchQuality || 'auto',
      hardwareDecode: await hardwareDecodeAvailable(),
      sourceFps: 0
    });

    log.info('stream policy', {
      host: (() => { try { return new URL(pageUrl).host; } catch { return 'unknown'; } })(),
      maxHeight: decision.maxHeight,
      reason: decision.reason
    });

    const startedAt = Date.now();
    const resolved = await ytdlp.resolveStream(bins.ytdlp, pageUrl, {
      maxHeight: decision.maxHeight,
      // Watch is racing a clock: it wants the smallest rendition that covers
      // the window, in the codec most likely to decode in hardware. Offline
      // renders take the opposite view and keep the default 'quality'.
      purpose: 'watch',
      auth: authSettings(),
      allowAuth: opts.allowAuth !== false,
      allowRemoteComponents: !!settings.allowRemoteComponents,
      ...ytdlpEnv()
    });
    const resolveMs = Date.now() - startedAt;

    // The policy travels with the session, so a refresh re-resolves under the
    // decision that was actually made for this window. Reading the raw setting
    // instead used to let an expiring 1080p stream come back as 2160p.
    const token = streams.register(resolved, { policy: decision, purpose: 'watch' });
    const descriptor = descriptorFor(token, resolved);
    descriptor.streamPolicy = decision;
    descriptor.selectedQuality = streamPolicy.describeSelection(resolved.video, decision);
    descriptor.selection = resolved.selection || null;
    descriptor.resolveMs = resolveMs;

    log.info('stream selected', {
      resolveMs,
      cap: decision.maxHeight,
      ...(resolved.selection || {})
    });
    return ok(descriptor);
  });

  handle('media:refreshStream', async (_e, token) => {
    const bins = binPaths();
    requireString(token, 'Stream token', 64);
    const session = streams.get(token);
    const policy = (session && session.meta && session.meta.policy) || null;
    const resolved = await streams.refresh(token, bins.ytdlp, {
      maxHeight: policy ? policy.maxHeight : (store.get('settings').maxStreamHeight || null),
      purpose: (session && session.meta && session.meta.purpose) || 'watch',
      auth: authSettings(),
      allowRemoteComponents: !!store.get('settings').allowRemoteComponents,
      ...ytdlpEnv()
    });
    const descriptor = descriptorFor(token, resolved);
    descriptor.selection = resolved.selection || null;
    return ok(descriptor);
  });

  /**
   * Let go of a stream session the renderer has finished with.
   *
   * Without this, switching sources leaks a live token (and the CDN URLs and
   * header sets behind it) for every video watched in a session.
   */
  handle('media:releaseStream', (_e, token) => {
    if (typeof token !== 'string' || !token) return ok({ released: false });
    return ok({ released: streams.release(token) });
  });

  /** Real transfer numbers for the diagnostics panel and the harnesses. */
  handle('media:transferStats', () => ok({ legs: transferStats.snapshot() }));

  handle('ytdlp:install', async (event) => {
    const p = await binaries.installYtDlp((fraction) => {
      event.sender.send('ytdlp:progress', fraction);
    });
    ytdlp.invalidateCapabilities();
    capabilities.invalidate();
    const caps = await ytdlp.capabilities(p, { ...ytdlpEnv(), force: true });
    return ok({ path: p, version: caps.version });
  });

  /* ---------- settings / presets / recents ---------- */

  handle('settings:get', () => ok({ settings: store.get('settings') }));
  handle('settings:patch', (_e, patch) => {
    if (!patch || typeof patch !== 'object') {
      throw new VisionanceError(CODES.INVALID_REQUEST, { message: 'Settings patch must be an object.' });
    }
    const settings = store.patchSettings(patch);
    if (patch.binaries) {
      ytdlp.invalidateCapabilities();
      capabilities.invalidate();
    }
    return ok({ settings });
  });

  handle('presets:get', () => ok({ presets: store.get('presets') }));
  handle('presets:save', (_e, preset) => {
    if (!preset || typeof preset !== 'object' || typeof preset.id !== 'string' || !preset.id) {
      throw new VisionanceError(CODES.INVALID_REQUEST, { message: 'Invalid preset.' });
    }
    const presets = store.get('presets');
    presets[preset.id] = preset;
    store.set('presets', presets);
    return ok({ presets });
  });
  handle('presets:delete', (_e, id) => {
    const presets = store.get('presets');
    delete presets[id];
    store.set('presets', presets);
    return ok({ presets });
  });

  handle('recents:get', () => ok({ recents: store.get('recents') }));
  handle('recents:add', (_e, entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.source !== 'string') {
      throw new VisionanceError(CODES.INVALID_REQUEST, { message: 'Invalid recent entry.' });
    }
    return ok({ recents: store.addRecent(entry) });
  });
  handle('recents:remove', (_e, source) => ok({ recents: store.removeRecent(source) }));
  handle('recents:clear', () => ok({ recents: store.clearRecents() }));

  handle('resume:get', (_e, key) => ok({ seconds: store.getResume(key) }));
  handle('resume:set', (_e, key, seconds) => {
    store.setResume(key, Number(seconds) || 0);
    return ok({});
  });

  /* ---------- recipes ---------- */

  handle('recipe:platforms', () => ok({ platforms: recipes.PLATFORMS }));

  handle('recipe:default', (_e, analysis, overrides) =>
    ok({ recipe: recipes.defaultRecipe(analysis || null, overrides || {}) }));

  handle('recipe:fromPreview', (_e, params, analysis, overrides) =>
    ok({ recipe: recipes.fromPreviewParams(params || {}, analysis || null, overrides || {}) }));

  handle('recipe:applyPlatform', (_e, recipe, platformId) =>
    ok({ recipe: recipes.applyPlatform(recipe || {}, platformId) }));

  handle('recipe:sanitize', (_e, recipe) => {
    const { recipe: clean, warnings } = recipes.sanitize(recipe || {});
    const validation = recipes.validate(clean);
    return ok({
      recipe: clean,
      warnings,
      valid: validation.valid,
      errors: validation.errors,
      geometry: recipes.resolveOutputGeometry(clean, null)
    });
  });

  /* ---------- AI engines ---------- */

  handle('engines:status', async (_e, opts = {}) =>
    ok({ engines: await engines.statusAll({ force: !!opts.force }) }));

  handle('engines:install', async (_e, id) => {
    requireString(id, 'Engine id', 40);
    const status = await engines.install(id, {
      onProgress: (p) => {
        if (win && !win.isDestroyed()) win.webContents.send('engines:progress', { id, ...p });
      }
    });
    return ok({ engine: status });
  });

  handle('engines:cancelInstall', (_e, id) => ok({ cancelled: engines.cancelInstall(id) }));
  handle('engines:remove', (_e, id) => {
    requireString(id, 'Engine id', 40);
    return ok({ removed: engines.remove(id) });
  });

  /* ---------- JavaScript runtimes (for yt-dlp) ---------- */

  handle('runtime:status', async () => {
    const found = await jsRuntime.discover({
      userDataDir: app.getPath('userData'),
      electronPath: process.execPath,
      force: true
    });
    return ok({
      runtimes: found.map((r) => ({
        runtime: r.runtime, source: r.source, version: r.version, path: r.path
      }))
    });
  });

  handle('runtime:install', async (event) => {
    const installed = await jsRuntime.installManagedNode({
      userDataDir: app.getPath('userData'),
      onProgress: (p) => event.sender.send('runtime:progress', p)
    });
    ytdlp.invalidateCapabilities();
    return ok({ runtime: installed.runtime, version: installed.version, path: installed.path });
  });

  /* ---------- Auto + creator presets ---------- */

  handle('auto:profiles', () => ok({
    profiles: autoRecipe.PROFILES,
    intensities: autoRecipe.INTENSITIES,
    presets: creatorPresets.list()
  }));

  handle('auto:build', async (_e, request = {}) => {
    if (!request.analysis) {
      throw new VisionanceError(CODES.INVALID_REQUEST, {
        message: 'Analyse the source before using Auto.'
      });
    }
    // Auto must know what is actually installed so it can decline honestly.
    const status = await engines.statusAll();
    const available = {
      realesrgan: status.realesrgan && status.realesrgan.status === 'ready',
      rife: status.rife && status.rife.status === 'ready',
      // Smart Reframe needs no model; it needs ffmpeg, which Create needs anyway.
      reframe: !!binPaths().ffmpeg
    };
    const result = autoRecipe.buildAutoRecipe({
      analysis: request.analysis,
      platform: request.platform || 'custom',
      profile: request.profile || 'auto',
      intensity: request.intensity || 'balanced',
      outputPath: request.outputPath || null,
      preferences: request.preferences || {},
      engines: available
    });
    return ok(result);
  });

  handle('presets:creator', () => ok({ presets: creatorPresets.list() }));

  handle('presets:applyCreator', (_e, id, request = {}) => ok({
    recipe: creatorPresets.apply(id, {
      analysis: request.analysis || null,
      outputPath: request.outputPath || null,
      extra: request.extra || {}
    })
  }));

  /* ---------- saved user recipes ---------- */

  handle('recipes:list', () => ok({ recipes: store.get('userRecipes') || {} }));

  handle('recipes:save', (_e, name, recipe) => {
    requireString(name, 'Preset name', 80);
    const { recipe: clean } = recipes.sanitize(recipe || {});
    const saved = store.get('userRecipes') || {};
    const id = `ur_${Date.now().toString(36)}`;
    // A saved preset is a starting point, not a job: the destination path is
    // whatever the user picks next time.
    clean.output.path = null;
    clean.source = { ...clean.source, path: null, url: null, audioUrl: null, headerToken: null };
    saved[id] = { id, name: name.trim(), savedAt: Date.now(), recipe: clean };
    store.set('userRecipes', saved);
    return ok({ id, recipes: saved });
  });

  handle('recipes:rename', (_e, id, name) => {
    const saved = store.get('userRecipes') || {};
    if (!saved[id]) throw new VisionanceError(CODES.INVALID_REQUEST, { message: 'No such preset.' });
    saved[id].name = requireString(name, 'Preset name', 80).trim();
    store.set('userRecipes', saved);
    return ok({ recipes: saved });
  });

  handle('recipes:duplicate', (_e, id) => {
    const saved = store.get('userRecipes') || {};
    if (!saved[id]) throw new VisionanceError(CODES.INVALID_REQUEST, { message: 'No such preset.' });
    const copyId = `ur_${Date.now().toString(36)}`;
    saved[copyId] = { ...saved[id], id: copyId, name: `${saved[id].name} copy`, savedAt: Date.now() };
    store.set('userRecipes', saved);
    return ok({ id: copyId, recipes: saved });
  });

  handle('recipes:delete', (_e, id) => {
    const saved = store.get('userRecipes') || {};
    delete saved[id];
    store.set('userRecipes', saved);
    return ok({ recipes: saved });
  });

  /* ---------- jobs ---------- */

  handle('jobs:list', () => ok({ jobs: jobs.list() }));

  /** What a recipe would cost, resolved the same way a real run resolves it. */
  handle('jobs:preview', async (_e, request = {}) => {
    if (!request.analysis || !request.recipe) {
      throw new VisionanceError(CODES.INVALID_REQUEST, {
        message: 'A cost preview needs a source analysis and a recipe.'
      });
    }
    const { recipe } = recipes.sanitize(request.recipe);
    return ok(await jobs.previewPlan(recipe, request.analysis));
  });

  /** Aspect-ratio catalogue and the resolution each one suggests. */
  handle('recipe:aspects', () => ok({
    aspects: recipes.ASPECTS,
    canvases: Object.keys(recipes.CANVASES)
  }));
  handle('jobs:create', async (_e, request) => {
    if (!request || typeof request !== 'object') {
      throw new VisionanceError(CODES.INVALID_REQUEST, { message: 'A job request is required.' });
    }
    const job = await jobs.create({
      recipe: request.recipe,
      analysis: request.analysis || null,
      source: request.source || null,
      autoStart: request.autoStart !== false
    });
    return ok({ job });
  });
  handle('jobs:cancel', (_e, id) => ok({ job: jobs.cancel(id) }));
  handle('jobs:pause', (_e, id) => ok({ job: jobs.pause(id) }));
  handle('jobs:resume', (_e, id) => ok({ job: jobs.resume(id) }));
  handle('jobs:retry', (_e, id) => ok({ job: jobs.retry(id) }));
  handle('jobs:start', (_e, id) => ok({ job: jobs.start(id) }));
  handle('jobs:remove', (_e, id) => ok({ removed: jobs.remove(id) }));
  handle('jobs:clear', () => ok({ jobs: jobs.clearFinished() }));

  /* ---------- shell / window ---------- */

  handle('shell:reveal', (_e, p) => {
    if (p && typeof p === 'string' && fs.existsSync(p)) shell.showItemInFolder(p);
    return ok({});
  });
  handle('shell:open', async (_e, p) => {
    if (p && typeof p === 'string' && fs.existsSync(p)) await shell.openPath(p);
    return ok({});
  });
  handle('shell:external', async (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) await shell.openExternal(url);
    return ok({});
  });

  handle('window:fullscreen', (_e, value) => {
    if (!win) return ok({ fullscreen: false });
    const next = typeof value === 'boolean' ? value : !win.isFullScreen();
    win.setFullScreen(next);
    return ok({ fullscreen: next });
  });

  handle('power:keepAwake', (_e, enable) => {
    if (enable && sleepBlockerId === null) {
      sleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    } else if (!enable && sleepBlockerId !== null) {
      try { powerSaveBlocker.stop(sleepBlockerId); } catch { /* already stopped */ }
      sleepBlockerId = null;
    }
    return ok({ active: sleepBlockerId !== null });
  });

  handle('media:localUrl', (_e, filePath) => ok({ url: localMediaUrl(filePath) }));
}

/**
 * Is Chromium actually decoding video in hardware?
 *
 * Reported by Chromium itself rather than inferred from which GPU is busy: on
 * a hybrid laptop the discrete card sitting at 0% is normal and expected, and
 * says nothing about whether decode is accelerated.
 */
let hardwareDecodeCache = null;
async function hardwareDecodeAvailable() {
  if (hardwareDecodeCache !== null) return hardwareDecodeCache;
  try {
    if (!app.isHardwareAccelerationEnabled || !app.isHardwareAccelerationEnabled()) {
      hardwareDecodeCache = false;
      return false;
    }
    const status = app.getGPUFeatureStatus ? app.getGPUFeatureStatus() : {};
    const decode = String(status.video_decode || '');
    // Chromium words this as e.g. "enabled" / "disabled_software" /
    // "unavailable_off". Anything that is not plainly enabled counts as "no".
    hardwareDecodeCache = /^enabled/.test(decode);
    log.info('gpu feature status', {
      accelerated: true,
      videoDecode: decode || 'unknown',
      gpuCompositing: status.gpu_compositing || 'unknown',
      webgl: status.webgl || 'unknown',
      webgl2: status.webgl2 || 'unknown'
    });
  } catch (err) {
    log.warn('could not read GPU feature status', { error: err.message });
    hardwareDecodeCache = null;
  }
  return hardwareDecodeCache;
}

/** What the renderer gets for a resolved online stream. Never headers. */
function descriptorFor(token, resolved) {
  return {
    kind: 'stream',
    source: resolved.webpageUrl,
    streamToken: token,
    title: resolved.title,
    uploader: resolved.uploader,
    channelUrl: resolved.channelUrl,
    duration: resolved.duration,
    thumbnail: resolved.thumbnail,
    isLive: resolved.isLive,
    liveStatus: resolved.liveStatus,
    extractor: resolved.extractor,
    muxed: resolved.muxed,
    available: resolved.available,
    warnings: resolved.warnings || [],
    usedAuth: resolved.usedAuth || 'none',
    resolvedAt: resolved.resolvedAt,
    expiresAt: resolved.expiresAt,
    playbackUrl: remoteMediaUrl(token, 'video'),
    audioUrl: resolved.audio ? remoteMediaUrl(token, 'audio') : null,
    video: publicFormat(resolved.video),
    audio: publicFormat(resolved.audio),
    info: {
      width: resolved.video.width,
      height: resolved.video.height,
      fps: resolved.video.fps,
      vcodec: resolved.video.vcodec,
      duration: resolved.duration || 0
    }
  };
}

/** Formats without their URLs or headers - those stay in the main process. */
function publicFormat(f) {
  if (!f) return null;
  return {
    formatId: f.formatId,
    ext: f.ext,
    width: f.width,
    height: f.height,
    fps: f.fps,
    vcodec: f.vcodec,
    acodec: f.acodec,
    abr: f.abr,
    tbr: f.tbr,
    protocol: f.protocol,
    filesize: f.filesize,
    expiresAt: f.expiresAt
  };
}

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      const file = argv.slice(1).find(isPlayableFile);
      if (file) win.webContents.send('open-external-file', file);
    }
  });

  app.whenReady().then(async () => {
    const userData = app.getPath('userData');
    logger.setFile(path.join(userData, 'logs', 'main.log'));
    if (IS_DEV) logger.level = 'debug';
    log.info('starting', { version: appVersion(), dev: IS_DEV, platform: process.platform });

    store = new Store();
    streams = new StreamSessionRegistry();

    // Engines live outside the repository, and a harness can point at a real
    // installation so a throwaway user-data folder does not mean re-downloading
    // half a gigabyte.
    engines = new EngineManager({
      rootDir: process.env.VISIONANCE_ENGINES_DIR || path.join(userData, 'engines')
    });
    engines.on('install-progress', (p) => {
      if (win && !win.isDestroyed()) win.webContents.send('engines:progress', p);
    });
    engines.on('status', (s) => {
      if (win && !win.isDestroyed()) win.webContents.send('engines:status', s);
    });

    jobs = new JobManager({
      dir: path.join(userData, 'jobs'),
      workDir: path.join(userData, 'work'),
      resolveBins: binPaths,
      resolveRemote: resolveRemoteForJob,
      engines,
      logger
    });
    jobs.on('update', (job) => {
      if (win && !win.isDestroyed()) win.webContents.send('jobs:update', job);
    });
    jobs.on('removed', (id) => {
      if (win && !win.isDestroyed()) win.webContents.send('jobs:removed', id);
    });

    const recovery = jobs.init();
    if (recovery.recovered.length) {
      log.warn('jobs interrupted by a previous shutdown', { count: recovery.recovered.length });
    }

    registerProtocol();
    registerIpc();
    createWindow();

    // Deliver a file passed on the command line once the UI is ready.
    const cliFile = process.argv.slice(1).find(isPlayableFile);
    if (cliFile && win) {
      win.webContents.once('did-finish-load', () => {
        win.webContents.send('open-external-file', cliFile);
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (win) win.webContents.send('open-external-file', filePath);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  let quitting = false;
  app.on('before-quit', (event) => {
    if (sleepBlockerId !== null) {
      try { powerSaveBlocker.stop(sleepBlockerId); } catch { /* ignore */ }
      sleepBlockerId = null;
    }
    if (!jobs || quitting) return;
    // Give the job system a moment to tear ffmpeg down and write honest final
    // states, rather than leaving jobs claiming to be mid-render.
    quitting = true;
    event.preventDefault();
    jobs.shutdown().finally(() => {
      log.info('shutdown complete');
      app.quit();
    });
  });
}
