/**
 * What hardware does Visionance think it is running on?
 *
 *   npm run machine
 *
 * The one command to run after pulling this repository onto a different
 * computer. Nothing here is cached to disk and nothing is read from tracked
 * config: every line is probed on this launch, which is exactly why moving the
 * project between machines needs no retuning.
 *
 * Two GPUs are reported because Visionance genuinely uses two. Chromium picks
 * the adapter that composites Watch; ffmpeg and the ncnn engines pick the
 * adapter that renders Create. On a laptop those are routinely different
 * devices, and that is not a fault.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const { app } = require('electron');

app.setName('Visionance');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'visionance-machine-')));
// The WebGL probe opens and destroys a window. Electron quits by default once
// the last window closes, which cut this report off mid-way.
app.on('window-all-closed', () => { /* the report decides when to exit */ });

const SRC = path.join(__dirname, '..', 'src', 'main');

function bytes(n) {
  if (!n) return 'unknown';
  const gb = n / (1024 ** 3);
  return `${gb.toFixed(1)} GB`;
}

function line(label, value) {
  console.log('  ' + String(label).padEnd(22) + (value === null || value === undefined ? 'unknown' : value));
}

app.whenReady().then(async () => {
  const capabilities = require(path.join(SRC, 'capabilities'));
  const { binaries } = (() => {
    try { return { binaries: require(path.join(SRC, 'binaries')) }; } catch { return { binaries: null }; }
  })();

  const resolved = binaries && typeof binaries.resolve === 'function'
    ? binaries.resolve()
    : null;
  const bins = (resolved && resolved.ffmpeg)
    ? resolved
    : {
      ffmpeg: (() => { try { return require('ffmpeg-static'); } catch { return null; } })(),
      ffprobe: (() => { try { return require('ffprobe-static').path; } catch { return null; } })(),
      ytdlp: path.join(app.getPath('appData'), 'Visionance', 'bin',
        process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
    };

  let gpuInfo = null;
  try { gpuInfo = await app.getGPUInfo('basic'); } catch { /* not available */ }

  const rep = await capabilities.report({ bins, gpuInfo, force: true });

  console.log('\nVisionance — machine capability\n');
  console.log('CPU / memory');
  line('platform', `${os.platform()} ${os.release()} ${os.arch()}`);
  line('cpu', (os.cpus()[0] || {}).model || 'unknown');
  line('logical cores', (rep.cpu && rep.cpu.cores) || os.cpus().length);
  line('memory', bytes((rep.memory && rep.memory.totalBytes) || os.totalmem()));
  line('free memory', bytes((rep.memory && rep.memory.freeBytes) || os.freemem()));

  console.log('\nGPUs');
  const gpus = rep.gpus || [];
  if (!gpus.length) line('detected', 'none reported');
  for (const g of gpus) line(g.vendor || 'gpu', g.name || 'unknown');

  // The adapter Chromium actually composites and runs WebGL on. This is the one
  // that decides Watch's realtime headroom, and it is not always the strongest
  // device present.
  console.log('\nRealtime (Watch)');
  let realtime = 'unknown';
  try {
    const { BrowserWindow } = require('electron');
    const win = new BrowserWindow({ show: false, width: 320, height: 240 });
    await win.loadURL('data:text/html,<canvas id=c></canvas>');
    realtime = await win.webContents.executeJavaScript(`
      (() => {
        const gl = document.getElementById('c').getContext('webgl2');
        if (!gl) return 'WebGL2 unavailable';
        const d = gl.getExtension('WEBGL_debug_renderer_info');
        const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
        const name = d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
        return name + (timer ? '  [GPU timing available]' : '  [no GPU timing]');
      })()`);
    win.destroy();
  } catch (err) {
    realtime = 'could not probe (' + err.message + ')';
  }
  line('webgl renderer', realtime);

  console.log('\nRender (Create)');
  line('ffmpeg', (rep.ffmpeg && rep.ffmpeg.version) || 'missing');
  const encName = (e) => (typeof e === 'string' ? e : (e && (e.id || e.name)) || 'unknown');
  line('hw encoders', (rep.ffmpeg && rep.ffmpeg.hardwareEncoders || []).map(encName).join(', ') || 'none');
  line('hwaccels', (rep.ffmpeg && rep.ffmpeg.hwaccels || []).join(', ') || 'none');
  line('primary gpu vendor', rep.primaryGpuVendor);

  console.log('\nAI engines');
  // The whole probe is bounded. It spawns real binaries to ask them which
  // Vulkan devices they see, and a missing or wedged engine must degrade this
  // report to one honest line rather than hanging the command.
  await Promise.race([probeEngines(), new Promise((r) => setTimeout(r, 12000))])
    .catch(() => line('engines', 'could not probe'));

  console.log('\nyt-dlp');
  line('binary', bins.ytdlp && fs.existsSync(bins.ytdlp) ? bins.ytdlp : 'not installed');

  console.log('\nNothing above is cached to disk or read from tracked config;');
  console.log('it is probed on every launch, so a different machine reports itself.\n');
  app.exit(0);
}).catch((err) => { console.error(err); app.exit(1); });

async function probeEngines() {
  const { app: electronApp } = require('electron');
  try {
    const { EngineManager } = require(path.join(SRC, 'ai', 'engine-manager'));
    const engines = new EngineManager({
      rootDir: path.join(electronApp.getPath('appData'), 'Visionance', 'engines')
    });
    for (const id of ['realesrgan', 'rife']) {
      // Bounded: a probe that spawns a missing binary must not hang the report.
      // eslint-disable-next-line no-await-in-loop
      const status = await Promise.race([
        Promise.resolve().then(() => (typeof engines.status === 'function' ? engines.status(id) : null)),
        new Promise((r) => setTimeout(() => r('timeout'), 8000))
      ]).catch(() => null);
      if (status === 'timeout') { line(id, 'probe timed out'); continue; }
      line(id, status && status.installed
        ? `installed${status.availableGPUs && status.availableGPUs.length
          ? ` · ${status.availableGPUs.length} Vulkan device(s)` : ''}`
        : 'not installed');
    }
  } catch (err) {
    line('engines', 'could not probe (' + err.message + ')');
  }
}
