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
const { Readable } = require('stream');
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
const watchAuto = require('./watch-auto');
const creatorPresets = require('./creator-presets');
const capabilities = require('./capabilities');
const analyzer = require('./media-analyzer');
const { StreamSessionRegistry } = require('./stream-session');
const streamPolicy = require('./stream-policy');
const streamProxy = require('./stream-proxy');
const { JobManager } = require('./jobs/job-manager');
const { EngineManager } = require('./ai/engine-manager');
const { SemanticManager } = require('./ai/semantic-manager');
const { Thumbnails } = require('./thumbnails');
const { Telemetry } = require('./telemetry');
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
let semanticModels = null;
let thumbnails = null;
let telemetry = null;
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

/**
 * Container types for local playback.
 *
 * Chromium sniffs the container anyway, but the media element uses the declared
 * type when it decides whether a source is worth attaching at all, and
 * `application/octet-stream` is the value most likely to get a file rejected
 * before a single byte is demuxed.
 */
const VIDEO_MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.3gp': 'video/3gpp'
};

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

    // Cached thumbnails. The renderer only ever holds an opaque cache key, so
    // this cannot be used to read an arbitrary file: the key is validated
    // against the character set the cache itself produces, and the path is
    // rebuilt from the cache directory rather than taken from the request.
    if (url.pathname === '/__thumb') {
      return handleThumb(url);
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
    return serveLocalFile(url.searchParams.get('p'), request);
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

/**
 * Parse one HTTP byte range against a known resource size.
 *
 * Only a single range is honoured, which is all Chromium's media stack ever
 * asks for. `bytes=a-`, `bytes=a-b` and the suffix form `bytes=-n` are all
 * real requests it makes. Returns null for a header we do not understand (the
 * caller then serves the whole resource, which is the correct fallback) and
 * `false` for a syntactically valid but unsatisfiable range, which must be a
 * 416 rather than a silent full-body reply.
 */
function parseByteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  let start;
  let end;

  if (rawStart === '') {
    // Suffix range: the last N bytes.
    const suffix = Number(rawEnd);
    if (!rawEnd || !Number.isFinite(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    // A range that runs past the end is clamped, not refused: that is what the
    // spec says and what every media client relies on.
    end = Math.min(end, size - 1);
  }

  if (start > end || start >= size || start < 0) return false;
  return { start, end };
}

/**
 * Serve a local file to the media element, with real range support.
 *
 * This used to hand the path to `net.fetch` as a `file://` URL and forward the
 * Range header. Electron answers those with the entire body and status 200 —
 * no `Accept-Ranges`, no `Content-Range` — so Chromium's media stack concluded
 * the resource was not seekable: `video.seekable` stayed empty, and assigning
 * `currentTime` snapped straight back to wherever playback already was. Local
 * files could be played but never scrubbed.
 *
 * Answering the range ourselves is what makes the element seekable. The body is
 * an `fs` read stream over exactly the requested window, so nothing is buffered
 * whole, nothing is copied, and a seek costs one open at an offset.
 */
async function serveLocalFile(filePath, request) {
  if (!filePath || !path.isAbsolute(filePath)) {
    return new Response('Not found', { status: 404 });
  }

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return new Response('Not found', { status: 404 });
  }
  if (!stat.isFile()) return new Response('Not found', { status: 404 });

  const size = stat.size;
  const type = VIDEO_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = parseByteRange(request.headers.get('range'), size);

  // Valid syntax, impossible window. Chromium recovers from this correctly;
  // a 200 with the whole file here would desynchronise its demuxer.
  if (range === false) {
    return new Response(null, {
      status: 416,
      headers: { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' }
    });
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const length = size === 0 ? 0 : end - start + 1;

  const headers = new Headers({
    'content-type': type,
    'content-length': String(length),
    // The header that actually decides whether the element reports a seekable
    // range. Without it Chromium will not issue a range request at all.
    'accept-ranges': 'bytes',
    'cache-control': 'no-store'
  });
  if (range) headers.set('content-range', `bytes ${start}-${end}/${size}`);

  // HEAD is answered with the headers alone; the media stack uses it to learn
  // the length before it commits to a read.
  if (request.method === 'HEAD' || length === 0) {
    return new Response(null, { status: range ? 206 : 200, headers });
  }

  const stream = fs.createReadStream(filePath, { start, end });
  // A seek cancels the in-flight read. Without this the abandoned stream stays
  // open holding a file handle for every scrub.
  const signal = request.signal;
  if (signal) {
    if (signal.aborted) stream.destroy();
    else signal.addEventListener('abort', () => stream.destroy(), { once: true });
  }
  stream.on('error', (err) => {
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      log.warn('local media read failed', { error: err.message });
    }
  });

  return new Response(Readable.toWeb(stream), { status: range ? 206 : 200, headers });
}

/**
 * Serve one cached thumbnail.
 *
 * Cache-Control matters here: these images are immutable for a given key (a
 * new frame would be a new key), and without it Chromium re-reads every card's
 * image on every re-render of the Queue.
 */
async function handleThumb(url) {
  const key = url.searchParams.get('k');
  if (!thumbnails || !key || !/^[a-z]_[0-9a-f]{8,40}$/.test(key)) {
    return new Response('Not found', { status: 404 });
  }
  const file = thumbnails.fileFor(key);
  if (!fs.existsSync(file)) return new Response('Not found', { status: 404 });
  try {
    const body = await fs.promises.readFile(file);
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'image/jpeg',
        'cache-control': 'public, max-age=31536000, immutable'
      }
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

/* ------------------------------------------------------------------ *
 * Window
 * ------------------------------------------------------------------ */

/**
 * Integrated window chrome.
 *
 * The application bar *is* the title bar. On Windows and Linux that means
 * `titleBarStyle: 'hidden'` plus a title-bar overlay: Chromium keeps drawing
 * the real minimise / maximise / close buttons, so snapping, the system menu,
 * Win+Arrow and the accessibility affordances all keep working. macOS gets
 * `hiddenInset`, which leaves the native traffic lights in their expected
 * place; the renderer insets the brand for them.
 *
 * Deliberately not a frameless window with buttons of our own: hand-drawn
 * window controls lose snap layouts, double-click-to-maximise and every
 * platform convention, and they are the first thing to break on a DPI change.
 */
const TITLE_BAR_HEIGHT = 48;

function windowChrome() {
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 16 } };
  }
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0D0F10',
      symbolColor: '#A7ACB2',
      height: TITLE_BAR_HEIGHT
    }
  };
}

function createWindow() {
  const saved = store.get('window');
  win = new BrowserWindow({
    width: saved.width || 1360,
    height: saved.height || 860,
    x: Number.isInteger(saved.x) ? saved.x : undefined,
    y: Number.isInteger(saved.y) ? saved.y : undefined,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#08090A',
    show: false,
    autoHideMenuBar: true,
    title: 'Visionance',
    ...windowChrome(),
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
  // A reload destroys the document that owns the telemetry subscriptions
  // without it ever releasing them. Clearing them here, before the new
  // document runs, is what keeps "nothing samples while nobody is looking"
  // true across View → Reload.
  win.webContents.on('did-start-loading', () => {
    if (telemetry) telemetry.reset();
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
      // Only ever set by the audio-recovery ladder, after a split pair's audio
      // leg has actually been refused. It trades resolution for a stream whose
      // sound cannot be refused separately.
      preferMuxed: !!opts.preferMuxed,
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

  /* ---------- semantic detection ---------- */

  handle('semantic:status', () => ok({ semantic: semanticModels.status() }));

  handle('semantic:install', async (event) => {
    const status = await semanticModels.installModels((p) => {
      event.sender.send('semantic:progress', p);
    });
    return ok({ semantic: status });
  });

  handle('semantic:cancelInstall', () => ok({ cancelled: semanticModels.cancelInstall() }));

  handle('semantic:remove', () => ok({ semantic: semanticModels.remove() }));

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

  /**
   * What Auto is allowed to promise on this machine.
   * Asked fresh every time: an engine installed two minutes ago must change
   * the answer without a restart.
   */
  async function autoEngineAvailability() {
    const status = await engines.statusAll();
    return {
      realesrgan: status.realesrgan && status.realesrgan.status === 'ready',
      rife: status.rife && status.rife.status === 'ready',
      // Smart Reframe needs no model; it needs ffmpeg, which Create needs anyway.
      reframe: !!binPaths().ffmpeg,
      // Whether the *semantic* layer above it can run. Auto uses this to
      // choose tracking for talking-head profiles without ever promising
      // face tracking on a machine that has none.
      semanticReframe: semanticModels ? semanticModels.status().status === 'ready' : false
    };
  }

  /**
   * The hardware facts Auto is allowed to reason about. Only ever used to
   * reduce what Auto asks for, so an unknown GPU costs quality, never
   * stability.
   */
  async function autoMachineProfile() {
    let rep = null;
    try {
      rep = await capabilities.report({ bins: binPaths() });
    } catch { /* a missing report is a legitimate answer */ }
    const gpus = (rep && rep.gpus) || [];
    // The strongest adapter the machine reports is the one a render will use.
    let tier = 'unknown';
    for (const gpu of gpus) {
      const t = watchAuto.classifyGpu(gpu.name);
      if (t === 'discrete') { tier = 'discrete'; break; }
      if (t === 'integrated' && tier !== 'discrete') tier = 'integrated';
    }
    return {
      gpuTier: tier,
      gpuName: gpus.length ? gpus[0].name : null,
      cores: rep && rep.cpu ? rep.cpu.cores : null,
      memoryBytes: rep && rep.memory ? rep.memory.totalBytes : null
    };
  }

  handle('auto:build', async (_e, request = {}) => {
    if (!request.analysis) {
      throw new VisionanceError(CODES.INVALID_REQUEST, {
        message: 'Analyse the source before using Auto.'
      });
    }
    const result = autoRecipe.buildAutoRecipe({
      analysis: request.analysis,
      platform: request.platform || 'custom',
      profile: request.profile || 'auto',
      intensity: request.intensity || 'balanced',
      outputPath: request.outputPath || null,
      preferences: request.preferences || {},
      locks: request.locks || null,
      machine: await autoMachineProfile(),
      engines: await autoEngineAvailability()
    });
    return ok(result);
  });

  /**
   * AUTO CONFIGURE (Create).
   *
   * The same decision engine as `auto:build`, entered from the product level:
   * the caller passes the few choices a normal user makes as *locks*, and gets
   * back the recipe plus a plain-language account of what was chosen and what
   * could not be.
   */
  handle('auto:configure', async (_e, request = {}) => {
    if (!request.analysis) {
      throw new VisionanceError(CODES.INVALID_REQUEST, {
        message: 'Analyse the source before configuring it automatically.'
      });
    }
    const result = autoRecipe.buildAutoConfigure({
      analysis: request.analysis,
      platform: request.platform || 'custom',
      profile: request.profile || 'auto',
      intensity: request.intensity || 'balanced',
      outputPath: request.outputPath || null,
      preferences: request.preferences || {},
      locks: request.locks || null,
      machine: await autoMachineProfile(),
      engines: await autoEngineAvailability()
    });
    return ok(result);
  });

  /**
   * AUTO CONFIGURE (Watch).
   *
   * Realtime only. This can never reach Create's recipe, and it is deliberately
   * a different handler over a different module rather than a flag on the one
   * above - the two workspaces stay independent all the way down.
   */
  handle('watch:auto', (_e, request = {}) => ok(watchAuto.buildWatchAuto({
    analysis: request.analysis || null,
    profile: request.profile || 'auto',
    sourceKind: request.sourceKind === 'stream' ? 'stream' : 'local',
    machine: request.machine || null,
    playback: request.playback || null,
    availableLooks: Array.isArray(request.availableLooks) ? request.availableLooks : null
  })));

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

  /* ---------- thumbnails ---------- */

  /**
   * One thumbnail per source identity, produced once and reused everywhere.
   * The renderer sends a descriptor and gets back a `vs://` URL or `null`;
   * it never learns where the cache lives.
   */
  handle('thumbs:get', async (_e, descriptor) => {
    if (!thumbnails) return ok({ url: null, key: null });
    const key = thumbnails.keyFor(descriptor);
    if (!key) return ok({ url: null, key: null });
    const result = await thumbnails.ensure(descriptor);
    if (!result) return ok({ url: null, key, unavailable: true });
    return ok({
      url: `vs://app/__thumb?k=${encodeURIComponent(result.key)}`,
      key: result.key,
      cached: result.cached
    });
  });

  handle('thumbs:stats', () => ok({ cache: thumbnails ? thumbnails.stats() : null }));

  handle('thumbs:clear', () => ok({ removed: thumbnails ? thumbnails.clear() : 0 }));

  /* ---------- telemetry ---------- */

  /**
   * Sampling runs only while the renderer says a panel is on screen. Nothing
   * here is modelled: a metric this machine does not expose comes back null.
   */
  handle('telemetry:subscribe', (_e, active) =>
    ok({ ...telemetry.setActive(active !== false) }));

  handle('telemetry:sample', async () => ok({ sample: await telemetry.snapshot() }));
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

    // The semantic models sit beside the engines but are managed separately:
    // they are weights, not executables, and they must never gate a render.
    semanticModels = new SemanticManager({
      rootDir: process.env.VISIONANCE_ENGINES_DIR || path.join(userData, 'engines')
    });
    semanticModels.on('status', (s) => {
      if (win && !win.isDestroyed()) win.webContents.send('semantic:status', s);
    });

    // One thumbnail per source, cached outside the app folder so a reinstall
    // does not throw the cache away and a repo checkout never carries images.
    thumbnails = new Thumbnails({
      dir: path.join(userData, 'cache', 'thumbnails'),
      binPaths,
      net
    });

    telemetry = new Telemetry({
      app,
      onSample: (sample) => {
        if (win && !win.isDestroyed()) win.webContents.send('telemetry:sample', sample);
      }
    });

    jobs = new JobManager({
      dir: path.join(userData, 'jobs'),
      workDir: path.join(userData, 'work'),
      resolveBins: binPaths,
      resolveRemote: resolveRemoteForJob,
      engines,
      semantic: semanticModels,
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
    if (telemetry) telemetry.dispose();
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
