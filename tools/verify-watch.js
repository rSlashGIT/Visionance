'use strict';

/**
 * Watch-path verification: stream selection, the ranged media proxy, the
 * presentation-rate measurement and the framing control mapping.
 *
 * All of it is pure logic, so this runs with no GPU, no network, no binaries
 * and no Electron:
 *
 *   npm run verify:watch
 *
 * The three defects these cover were all invisible to the existing suites -
 * `stream-policy.js` had no tests at all, which is exactly why Auto could pick
 * 1440p for a 900-pixel window for a whole session without anything failing.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const policy = require(path.join(__dirname, '..', 'src', 'main', 'stream-policy'));
const ytdlp = require(path.join(__dirname, '..', 'src', 'main', 'ytdlp'));
const proxy = require(path.join(__dirname, '..', 'src', 'main', 'stream-proxy'));
const stats = require(path.join(__dirname, '..', 'src', 'renderer', 'js', 'playback-stats'));

/* ------------------------------------------------------------------ *
 * Stream height policy
 * ------------------------------------------------------------------ */

/** The reference machine: a 1080p panel at 125% scaling, window maximised. */
const REFERENCE = {
  viewportWidth: 1360,
  viewportHeight: 700,
  devicePixelRatio: 1.25,
  screenWidth: 1536,
  screenHeight: 864,
  watchQuality: 'auto',
  hardwareDecode: true
};

test('policy: a ~875-line viewport asks for 1080p, not the panel size', () => {
  const d = policy.chooseStreamHeight(REFERENCE);
  assert.equal(d.maxHeight, 1080);
  assert.equal(d.requirement, 875);
});

test('policy: the display is a ceiling, never a floor', () => {
  // The defect: a 900-line window on a 1440p panel used to take max(viewport,
  // screen) and therefore always asked for 1440p, so Auto could never choose
  // anything smaller than the monitor.
  const d = policy.chooseStreamHeight({
    viewportWidth: 1200, viewportHeight: 900, devicePixelRatio: 1,
    screenWidth: 2560, screenHeight: 1440, watchQuality: 'auto', hardwareDecode: true
  });
  assert.equal(d.maxHeight, 1080, 'a 900-line window does not need 1440p');

  // ...and the panel still caps a viewport that could not be shown anyway.
  const small = policy.chooseStreamHeight({
    viewportWidth: 1280, viewportHeight: 700, devicePixelRatio: 1,
    screenWidth: 1280, screenHeight: 720, watchQuality: 'auto', hardwareDecode: true
  });
  assert.equal(small.maxHeight, 720);
});

test('policy: the whole 800-1000 line band lands on 1080p', () => {
  for (let lines = 800; lines <= 1000; lines += 20) {
    const d = policy.chooseStreamHeight({
      viewportWidth: 1600, viewportHeight: lines, devicePixelRatio: 1,
      screenWidth: 2560, screenHeight: 1440, watchQuality: 'auto', hardwareDecode: true
    });
    assert.equal(d.maxHeight, 1080, `${lines} lines should choose 1080p, got ${d.maxHeight}p`);
  }
});

test('policy: the tolerance stops a 6% shortfall costing a whole rung', () => {
  // 1150 lines is 6% more than 1080p provides and 20% less than 1440p does.
  // Taking 1440p would decode 78% more pixels to cover that 6%.
  assert.equal(policy.snapUp(1150), 1080);
  assert.equal(policy.snapUp(1250), 1440, 'a real shortfall still moves up a rung');
  assert.equal(policy.snapUp(1080), 1080);
  assert.equal(policy.snapUp(760), 720);
  assert.equal(policy.snapUp(800), 1080);
});

test('policy: an explicit user maximum is honoured exactly', () => {
  for (const height of [720, 1080, 1440, 2160]) {
    const d = policy.chooseStreamHeight({ ...REFERENCE, userMaxHeight: height });
    assert.equal(d.maxHeight, height);
    assert.equal(d.source, 'user');
  }
  // Even when it is far above what the window needs.
  const d = policy.chooseStreamHeight({ ...REFERENCE, userMaxHeight: 2160 });
  assert.equal(d.maxHeight, 2160);
});

test('policy: quality modes differ from each other and from Auto', () => {
  const at = (watchQuality) => policy.chooseStreamHeight({ ...REFERENCE, watchQuality }).maxHeight;
  assert.equal(at('performance'), 720);
  assert.equal(at('balanced'), 1080);
  assert.equal(at('auto'), 1080);
  assert.equal(at('quality'), 1440, 'Quality allows one rung above the window');
  assert.equal(at('maximum'), 2160);
});

test('policy: enhancement, missing hardware decode and high fps each cap at 1080p', () => {
  const big = {
    viewportWidth: 2560, viewportHeight: 1440, devicePixelRatio: 1,
    screenWidth: 2560, screenHeight: 1440, watchQuality: 'auto'
  };
  assert.equal(policy.chooseStreamHeight({ ...big, hardwareDecode: true }).maxHeight, 1440);
  assert.equal(policy.chooseStreamHeight({ ...big, hardwareDecode: true, enhancement: true }).maxHeight, 1080);
  assert.equal(policy.chooseStreamHeight({ ...big, hardwareDecode: false }).maxHeight, 1080);
  assert.equal(policy.chooseStreamHeight({ ...big, hardwareDecode: true, sourceFps: 60 }).maxHeight, 1080);
});

test('policy: an unmeasurable window assumes 1080p rather than the maximum', () => {
  const d = policy.chooseStreamHeight({ watchQuality: 'auto', hardwareDecode: true });
  assert.equal(d.maxHeight, 1080);
});

test('policy: the decision explains itself without inventing a quality', () => {
  const d = policy.chooseStreamHeight(REFERENCE);
  assert.ok(d.notes.length > 0);
  assert.match(policy.describeSelection({ height: 1080, fps: 25 }, d), /^1080p — /);
  assert.equal(policy.describeSelection(null, d), null);
  assert.match(policy.describeSelection({ height: 1080, fps: 60 }, null), /1080p60/);
});

/* ------------------------------------------------------------------ *
 * Watch format ranking
 *
 * Modelled on the real format list a 1440p YouTube video returns: above
 * 1080p there is no H.264 at all, only VP9 and AV1.
 * ------------------------------------------------------------------ */

const YT_FORMATS = [
  { url: 'https://cdn.example/18', format_id: '18', ext: 'mp4', protocol: 'https', height: 360, fps: 25, vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', tbr: 520 },
  { url: 'https://cdn.example/136', format_id: '136', ext: 'mp4', protocol: 'https', height: 720, fps: 25, vcodec: 'avc1.4d401f', acodec: 'none', tbr: 822 },
  { url: 'https://cdn.example/247', format_id: '247', ext: 'webm', protocol: 'https', height: 720, fps: 25, vcodec: 'vp9', acodec: 'none', tbr: 615 },
  { url: 'https://cdn.example/137', format_id: '137', ext: 'mp4', protocol: 'https', height: 1080, fps: 25, vcodec: 'avc1.640028', acodec: 'none', tbr: 1896 },
  { url: 'https://cdn.example/248', format_id: '248', ext: 'webm', protocol: 'https', height: 1080, fps: 25, vcodec: 'vp9', acodec: 'none', tbr: 999 },
  { url: 'https://cdn.example/399', format_id: '399', ext: 'mp4', protocol: 'https', height: 1080, fps: 25, vcodec: 'av01.0.08M.0', acodec: 'none', tbr: 862 },
  { url: 'https://cdn.example/271', format_id: '271', ext: 'webm', protocol: 'https', height: 1440, fps: 25, vcodec: 'vp9', acodec: 'none', tbr: 3373 },
  { url: 'https://cdn.example/400', format_id: '400', ext: 'mp4', protocol: 'https', height: 1440, fps: 25, vcodec: 'av01.0.12M.0', acodec: 'none', tbr: 2485 },
  { url: 'https://cdn.example/313', format_id: '313', ext: 'webm', protocol: 'https', height: 2160, fps: 25, vcodec: 'vp9', acodec: 'none', tbr: 8000 },
  { url: 'https://cdn.example/140', format_id: '140', ext: 'm4a', protocol: 'https', height: null, vcodec: 'none', acodec: 'mp4a.40.2', abr: 130 },
  { url: 'https://cdn.example/251', format_id: '251', ext: 'webm', protocol: 'https', height: null, vcodec: 'none', acodec: 'opus', abr: 139 }
];

test('ranking: the height cap decides the rung, and 1080p is what a 1080p cap gets', () => {
  const picked = ytdlp.pickBest(YT_FORMATS, 'video', 1080, 'watch');
  assert.equal(picked.height, 1080);
});

test('ranking: Watch prefers the codec most likely to decode in hardware', () => {
  // Three renditions of the same 1080p picture. AV1 is the smallest file and
  // the best codec per bit, and it is the one that will software-decode on the
  // hardware this app targets.
  const picked = ytdlp.pickBest(YT_FORMATS, 'video', 1080, 'watch');
  assert.equal(picked.format_id, '137', 'H.264 wins at equal height');
  assert.ok(ytdlp.watchCodecRank('avc1.640028') > ytdlp.watchCodecRank('vp9'));
  assert.ok(ytdlp.watchCodecRank('vp9') > ytdlp.watchCodecRank('av01.0.08M.0'));
});

test('ranking: offline Create keeps taking the highest quality it can', () => {
  const watch = ytdlp.pickBest(YT_FORMATS, 'video', 2160, 'watch');
  const quality = ytdlp.pickBest(YT_FORMATS, 'video', 2160, 'quality');
  assert.equal(watch.height, 2160);
  assert.equal(quality.height, 2160);
  // At 1080p the two purposes disagree, and that disagreement is the point.
  assert.equal(ytdlp.pickBest(YT_FORMATS, 'video', 1080, 'watch').format_id, '137');
});

test('ranking: a lower-bitrate encode wins only at equal height and codec', () => {
  const two = [
    { url: 'https://cdn.example/big', format_id: 'big', ext: 'mp4', protocol: 'https', height: 1080, fps: 30, vcodec: 'avc1.64', acodec: 'none', tbr: 4000 },
    { url: 'https://cdn.example/small', format_id: 'small', ext: 'mp4', protocol: 'https', height: 1080, fps: 30, vcodec: 'avc1.64', acodec: 'none', tbr: 1800 }
  ];
  assert.equal(ytdlp.pickBest(two, 'video', 1080, 'watch').format_id, 'small');
});

test('ranking: Watch does not fall back to 360p just to avoid a split pair', () => {
  const info = { formats: YT_FORMATS, http_headers: { 'user-agent': 'x' } };
  const r = ytdlp.normaliseInfo(info, 'https://example.com/v', { maxHeight: 1080, purpose: 'watch' });
  assert.equal(r.selection.height, 1080);
  assert.equal(r.selection.split, true, 'the only muxed format is 360p, so the split pair is right');
  assert.equal(r.selection.vcodec, 'avc1.640028');
  assert.ok(r.audio && r.audio.url !== undefined);
});

test('ranking: a competitive muxed stream is preferred over a split pair', () => {
  const formats = [
    { url: 'https://cdn.example/mux', format_id: 'mux', ext: 'mp4', protocol: 'https', url: 'https://c/mux', height: 1080, fps: 30, vcodec: 'avc1.64', acodec: 'mp4a.40.2', tbr: 2500 },
    { url: 'https://cdn.example/v', format_id: 'v', ext: 'mp4', protocol: 'https', url: 'https://c/v', height: 1080, fps: 30, vcodec: 'avc1.64', acodec: 'none', tbr: 1900 },
    { url: 'https://cdn.example/a', format_id: 'a', ext: 'm4a', protocol: 'https', url: 'https://c/a', height: null, vcodec: 'none', acodec: 'mp4a.40.2', abr: 130 }
  ];
  const r = ytdlp.normaliseInfo({ formats }, 'https://example.com/v', { maxHeight: 1080, purpose: 'watch' });
  assert.equal(r.selection.split, false, 'one connection beats two at the same quality');
  assert.equal(r.muxed, true);
});

test('ranking: the selection summary carries no URLs or headers', () => {
  const formats = YT_FORMATS.map((f) => ({ ...f, url: 'https://cdn/' + f.format_id, http_headers: { cookie: 'secret' } }));
  const r = ytdlp.normaliseInfo({ formats }, 'https://example.com/v', { maxHeight: 1080, purpose: 'watch' });
  const text = JSON.stringify(r.selection);
  assert.ok(!/secret/.test(text));
  assert.ok(!/https?:\/\//.test(text));
});

/* ------------------------------------------------------------------ *
 * The ranged media proxy
 * ------------------------------------------------------------------ */

function makeBody(bytes) {
  // Deliver in small pieces, the way a socket does, so backpressure is real.
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      const end = Math.min(offset + 4096, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    }
  });
}

/** A CDN that honours ranges and records exactly what it was asked for. */
function fakeCdn(total, { failFirst = null } = {}) {
  const data = Buffer.alloc(total);
  for (let i = 0; i < total; i++) data[i] = i % 251;
  const calls = [];
  let failures = 0;

  const fetchImpl = async (url, opts = {}) => {
    const range = opts.headers.get('range');
    const m = /^bytes=(\d+)-(\d*)$/.exec(range || '');
    calls.push(range);
    if (failFirst && calls.length === failFirst && failures === 0) {
      failures++;
      throw new Error('socket hang up');
    }
    if (!m) {
      return new Response(makeBody(data), {
        status: 200,
        headers: { 'content-length': String(total), 'content-type': 'video/mp4' }
      });
    }
    const start = Number(m[1]);
    const end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
    const slice = data.subarray(start, end + 1);
    return new Response(makeBody(slice), {
      status: 206,
      headers: {
        'content-range': `bytes ${start}-${end}/${total}`,
        'content-length': String(slice.length),
        'content-type': 'video/mp4'
      }
    });
  };

  return { data, calls, fetchImpl };
}

const req = (range) => ({ headers: new Headers(range ? { range } : {}) });

test('proxy: an open-ended client range becomes bounded upstream requests', async () => {
  // The whole point. Chromium sends `bytes=0-`; googlevideo paces that at 2x
  // the media bitrate, and bounded ranges get full line rate.
  const cdn = fakeCdn(5 * 1024 * 1024);
  const res = await proxy.serveRanged({
    url: 'https://cdn/v', request: req('bytes=0-'),
    fetchImpl: cdn.fetchImpl, chunkBytes: 1024 * 1024
  });

  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 0-${5 * 1024 * 1024 - 1}/${5 * 1024 * 1024}`);
  assert.equal(res.headers.get('content-length'), String(5 * 1024 * 1024));

  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.length, cdn.data.length);
  assert.ok(body.equals(cdn.data), 'the stitched body is byte-identical to the source');

  assert.equal(cdn.calls.length, 5, 'five 1 MiB requests, not one open-ended one');
  for (const call of cdn.calls) {
    assert.match(call, /^bytes=\d+-\d+$/, `every upstream range is bounded: ${call}`);
  }
});

test('proxy: a bounded client range is served exactly, not over-served', async () => {
  const cdn = fakeCdn(1_000_000);
  const res = await proxy.serveRanged({
    url: 'https://cdn/v', request: req('bytes=1000-1999'),
    fetchImpl: cdn.fetchImpl, chunkBytes: 256
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 1000-1999/1000000');
  assert.equal(res.headers.get('content-length'), '1000');
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.length, 1000);
  assert.ok(body.equals(cdn.data.subarray(1000, 2000)));
});

test('proxy: a client with no range gets a plain 200 and the whole resource', async () => {
  const cdn = fakeCdn(100_000);
  const res = await proxy.serveRanged({
    url: 'https://cdn/v', request: req(null), fetchImpl: cdn.fetchImpl, chunkBytes: 30_000
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-range'), null);
  assert.equal(res.headers.get('content-length'), '100000');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.length, 100_000);
});

test('proxy: nothing is fetched before the consumer reads it', async () => {
  // Backpressure, stated as a fact rather than a hope: with a 64 KiB chunk and
  // a 1 MiB resource, constructing the response must not walk the file.
  const cdn = fakeCdn(1024 * 1024);
  const res = await proxy.serveRanged({
    url: 'https://cdn/v', request: req('bytes=0-'),
    fetchImpl: cdn.fetchImpl, chunkBytes: 64 * 1024
  });
  assert.equal(cdn.calls.length, 1, 'exactly one chunk in flight before anything is read');

  const reader = res.body.getReader();
  await reader.read();
  assert.ok(cdn.calls.length <= 2, `still only the first chunks: ${cdn.calls.length}`);
  await reader.cancel();
});

test('proxy: cancelling stops the transfer instead of finishing it', async () => {
  const cdn = fakeCdn(4 * 1024 * 1024);
  const res = await proxy.serveRanged({
    url: 'https://cdn/v', request: req('bytes=0-'),
    fetchImpl: cdn.fetchImpl, chunkBytes: 64 * 1024
  });
  const reader = res.body.getReader();
  await reader.read();
  const soFar = cdn.calls.length;
  await reader.cancel();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(cdn.calls.length <= soFar + 1,
    `a seek must not keep paying for bytes: ${soFar} -> ${cdn.calls.length}`);
});

test('proxy: a dropped chunk is retried once rather than failing playback', async () => {
  const cdn = fakeCdn(300_000, { failFirst: 2 });
  const res = await proxy.serveRanged({
    url: 'https://cdn/v', request: req('bytes=0-'),
    fetchImpl: cdn.fetchImpl, chunkBytes: 100_000
  });
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.length, 300_000);
  assert.ok(body.equals(cdn.data));
});

test('proxy: a CDN that ignores ranges is passed straight through', async () => {
  const fetchImpl = async () => new Response(makeBody(Buffer.alloc(1000)), {
    status: 200, headers: { 'content-length': '1000' }
  });
  const res = await proxy.serveRanged({
    url: 'https://cdn/v', request: req('bytes=0-'), fetchImpl
  });
  assert.equal(res.status, 200);
});

test('proxy: hop-by-hop headers never reach the CDN, stream headers do', async () => {
  let seen = null;
  const fetchImpl = async (url, opts) => {
    seen = opts.headers;
    return new Response(makeBody(Buffer.alloc(10)), {
      status: 206,
      headers: { 'content-range': 'bytes 0-9/10', 'content-length': '10' }
    });
  };
  await proxy.serveRanged({
    url: 'https://cdn/v',
    headers: { 'user-agent': 'Visionance', cookie: 'a=b', host: 'evil', 'content-length': '99' },
    request: req('bytes=0-9'),
    fetchImpl
  });
  assert.equal(seen.get('user-agent'), 'Visionance');
  assert.equal(seen.get('cookie'), 'a=b', 'a leg that needs its own headers keeps them');
  assert.equal(seen.get('host'), null);
  assert.equal(seen.get('content-length'), null);
  assert.match(seen.get('range'), /^bytes=0-9$/);
});

test('proxy: range parsing accepts what browsers send and refuses what it cannot chunk', () => {
  assert.deepEqual(proxy.parseRange('bytes=0-'), { start: 0, end: null });
  assert.deepEqual(proxy.parseRange('bytes=100-199'), { start: 100, end: 199 });
  assert.equal(proxy.parseRange('bytes=-500').start, null, 'a suffix range is passed through');
  assert.equal(proxy.parseRange(''), null);
  assert.equal(proxy.parseRange(null), null);
  assert.equal(proxy.parseRange('bytes=0-1,5-6'), null, 'multipart is not chunked');
  assert.equal(proxy.totalFromContentRange('bytes 0-1023/4096'), 4096);
  assert.equal(proxy.totalFromContentRange('bytes 0-1023/*'), null);
});

test('proxy: transfer accounting reports bytes and throughput per leg', async () => {
  const cdn = fakeCdn(200_000);
  const accounting = new proxy.TransferStats();
  const res = await proxy.serveRanged({
    url: 'https://cdn/v', request: req('bytes=0-'),
    fetchImpl: cdn.fetchImpl, chunkBytes: 50_000,
    stats: accounting, token: 'st_test', leg: 'video'
  });
  await res.arrayBuffer();
  const [leg] = accounting.snapshot();
  assert.equal(leg.leg, 'video');
  assert.equal(leg.bytes, 200_000);
  assert.equal(leg.total, 200_000);
  assert.ok(leg.chunks >= 4);
  assert.ok(typeof leg.kbps === 'number');
  assert.ok(Number.isFinite(leg.firstByteMs));
});

test('proxy: accounting totals survive the re-requests a seek causes', async () => {
  // A media element re-requests on every seek, and the audio track is nudged
  // back into sync constantly. Per-request counters read zero most of the time
  // and make a healthy stream look dead.
  const accounting = new proxy.TransferStats();
  for (let i = 0; i < 3; i++) {
    const cdn = fakeCdn(90_000);
    const res = await proxy.serveRanged({
      url: 'https://cdn/a', request: req('bytes=0-'),
      fetchImpl: cdn.fetchImpl, chunkBytes: 30_000,
      stats: accounting, token: 'st_test', leg: 'audio'
    });
    await res.arrayBuffer();
  }
  const [leg] = accounting.snapshot();
  assert.equal(leg.requests, 3);
  assert.equal(leg.bytes, 270_000, 'bytes accumulate across requests');
  assert.ok(leg.chunks >= 9);
});

/* ------------------------------------------------------------------ *
 * Presentation rate
 * ------------------------------------------------------------------ */

/**
 * Build a window of frame samples for a real source rate.
 *
 * @param {number} fps
 * @param {number} seconds
 * @param {object} o
 *   coalesce  every Nth callback is dropped, but the compositor counter still
 *             advances - which is what a busy enhancement loop does
 */
function samplesFor(fps, seconds, { coalesce = 0, startAt = 1000 } = {}) {
  const interval = 1000 / fps;
  const out = [];
  const count = Math.round(fps * seconds);
  for (let i = 0; i <= count; i++) {
    if (coalesce && i % coalesce === 0 && i !== 0 && i !== count) continue;
    out.push({
      at: startAt + i * interval,
      presentedFrames: 10_000 + i,
      mediaTime: i / fps
    });
  }
  return out;
}

const RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

test('diagnostics: every representative source rate measures as itself', () => {
  for (const fps of RATES) {
    const r = stats.computePresentationRate(samplesFor(fps, 2));
    assert.ok(Math.abs(r.presentedFps - fps) < 0.15,
      `${fps} fps measured ${r.presentedFps}`);
    assert.equal(r.basis, 'compositor');
    assert.ok(Math.abs(r.mediaFps - fps) < 0.15, `${fps} fps media rate measured ${r.mediaFps}`);
  }
});

test('diagnostics: coalesced callbacks no longer under-report the rate', () => {
  // The reported defect: a steady ~30 fps source with 1.1% dropped frames read
  // "20.1 fps" because the rate came from the interval between callbacks, and
  // the enhancement draw was causing the browser to coalesce them.
  for (const fps of RATES) {
    const coalesced = samplesFor(fps, 2, { coalesce: 3 });
    const r = stats.computePresentationRate(coalesced);
    assert.ok(Math.abs(r.presentedFps - fps) < 0.2,
      `${fps} fps with a third of the callbacks missing measured ${r.presentedFps}`);
  }

  // And the old method, for contrast: counting callbacks alone loses a third.
  const noCounter = samplesFor(30, 2, { coalesce: 3 })
    .map((s) => ({ ...s, presentedFrames: null }));
  const fallback = stats.computePresentationRate(noCounter);
  assert.equal(fallback.basis, 'callbacks');
  assert.ok(fallback.presentedFps < 25,
    'without the compositor counter the estimate really is low, and says so');
});

test('diagnostics: genuine 3:2 pulldown is reported, not corrected away', () => {
  // 24 fps film presented on a 60 Hz display: frames alternate 2 and 3 vsyncs,
  // so 60 presentations carry 24 distinct media frames.
  const out = [];
  for (let i = 0; i <= 120; i++) {
    out.push({ at: 1000 + i * (1000 / 60), presentedFrames: 500 + i, mediaTime: i / 60 });
  }
  const r = stats.computePresentationRate(out);
  assert.ok(Math.abs(r.presentedFps - 60) < 0.5,
    'the display really is presenting 60 times a second, and we say so');
});

test('diagnostics: too little data reports nothing rather than a wrong number', () => {
  assert.equal(stats.computePresentationRate([]).presentedFps, 0);
  assert.equal(stats.computePresentationRate([{ at: 1, presentedFrames: 1, mediaTime: 0 }]).basis, 'none');
  const zeroSpan = [
    { at: 5, presentedFrames: 1, mediaTime: 0 },
    { at: 5, presentedFrames: 2, mediaTime: 0 },
    { at: 5, presentedFrames: 3, mediaTime: 0 }
  ];
  assert.equal(stats.computePresentationRate(zeroSpan).presentedFps, 0);
});

test('diagnostics: a stalled stream reports the low rate it really achieved', () => {
  // 30 fps source delivering only 20 frames a second because the network is
  // starving it. That number is true and must not be rounded up to nominal.
  const r = stats.computePresentationRate(samplesFor(20, 2));
  assert.ok(Math.abs(r.presentedFps - 20) < 0.2);
});

/* ------------------------------------------------------------------ *
 * Framing control <-> recipe
 *
 * The mapping lives in app.js inside an IIFE, so it is restated here in the
 * same shape and checked against the recipe schema the backend validates
 * against. If the two ever drift, the assertions below fail rather than a
 * user discovering that "Smart Reframe" rendered a centre crop.
 * ------------------------------------------------------------------ */

const recipes = require(path.join(__dirname, '..', 'src', 'main', 'recipe'));
const fs = require('fs');

const APP_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'js', 'app.js'), 'utf8');

test('reframe UI: the control offers Smart Reframe at all', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const select = /<select id="createFraming"[\s\S]*?<\/select>/.exec(html);
  assert.ok(select, 'the framing control exists');
  assert.match(select[0], /value="smart"/, 'Smart Reframe is offered');
  assert.match(select[0], /value="fill"/);
  assert.match(select[0], /value="fit"/);

  const help = /id="createFramingHelp"[^>]*>([\s\S]*?)<\/p>/.exec(html);
  assert.ok(help, 'the framing control explains itself');
  assert.match(help[1], /saliency|motion/i, 'the copy names the real backend');
  assert.match(help[1], /not face detection/i, 'and disclaims the one it is not');
  assert.doesNotMatch(help[1], /\bAI face\b|\bface tracking\b/i,
    'nothing claims semantic face tracking');
  assert.doesNotMatch(help[1], /arrives with the AI stages/i,
    'the "not implemented yet" copy is gone');
});

test('reframe UI: the control maps to a recipe the backend actually executes', () => {
  assert.match(APP_SOURCE, /smart:\s*\{[^}]*tracking:\s*'auto'/,
    'Smart Reframe sets tracking auto');
  assert.match(APP_SOURCE, /fill:\s*\{[^}]*tracking:\s*'center'/,
    'centre crop sets tracking center');

  // The job only runs the tracker for exactly this combination, so a recipe
  // built from "smart" has to survive sanitisation as that combination.
  const { recipe } = recipes.sanitize({
    output: { path: 'out.mp4' },
    framing: { enabled: true, canvas: '9:16', width: 1080, height: 1920, mode: 'fill', tracking: 'auto' }
  });
  assert.equal(recipe.framing.mode, 'fill');
  assert.equal(recipe.framing.tracking, 'auto');

  const { recipe: centred } = recipes.sanitize({
    output: { path: 'out.mp4' },
    framing: { enabled: true, canvas: '9:16', width: 1080, height: 1920, mode: 'fill', tracking: 'center' }
  });
  assert.equal(centred.framing.tracking, 'center');
});

test('reframe UI: reading a recipe back selects the same control value', () => {
  // The inverse mapping, restated. Losing tracking on the way back is what let
  // Auto say "Smart Reframe enabled" while the control said centre crop.
  const choiceFor = (framing) => {
    if (!framing || !framing.enabled) return 'smart';
    if (framing.mode === 'fill') return framing.tracking === 'auto' ? 'smart' : 'fill';
    return framing.background === 'black' ? 'fit-black' : 'fit';
  };
  assert.match(APP_SOURCE, /function framingChoiceFor/, 'app.js has the inverse mapping');

  assert.equal(choiceFor({ enabled: true, mode: 'fill', tracking: 'auto' }), 'smart');
  assert.equal(choiceFor({ enabled: true, mode: 'fill', tracking: 'center' }), 'fill');
  assert.equal(choiceFor({ enabled: true, mode: 'fit', background: 'blur' }), 'fit');
  assert.equal(choiceFor({ enabled: true, mode: 'fit', background: 'black' }), 'fit-black');
});

test('reframe UI: Auto asking for Smart Reframe produces a Smart recipe', () => {
  const autoRecipe = require(path.join(__dirname, '..', 'src', 'main', 'auto-recipe'));
  const analysis = {
    video: { width: 1920, height: 1080, nominalFps: 30, bitrate: 6_000_000, codec: 'h264' },
    audio: { channels: 2 },
    timing: { durationSeconds: 60 },
    derived: {}
  };
  const result = autoRecipe.buildAutoRecipe({
    analysis, platform: 'youtube-shorts', profile: 'auto', intensity: 'balanced',
    engines: { realesrgan: false, rife: false, reframe: true }
  });
  assert.equal(result.recipe.framing.tracking, 'auto');
  assert.equal(result.recipe.framing.mode, 'fill');
  assert.ok(result.explanations.some((e) => /Smart Reframe/.test(e)),
    'and it says so, in the same words the control uses');

  // With no tracker available it must not claim one.
  const without = autoRecipe.buildAutoRecipe({
    analysis, platform: 'youtube-shorts', profile: 'auto', intensity: 'balanced',
    engines: { realesrgan: false, rife: false, reframe: false }
  });
  assert.notEqual(without.recipe.framing.tracking, 'auto');
  assert.ok(!without.explanations.some((e) => /Smart Reframe enabled/.test(e)));
});

/* ------------------------------------------------------------------ *
 * Source identity
 *
 * The Play button compares the box against what is loaded, so the comparison
 * has to be stable across the trivial differences users actually paste.
 * ------------------------------------------------------------------ */

test('source identity: trivial URL differences compare equal', () => {
  // Restated from app.js's normalizeUrl for the same reason as the framing
  // mapping: this decides whether Play loads or resumes.
  const normalize = (raw) => {
    let s = (raw || '').trim();
    if (!s) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    try {
      const u = new URL(s);
      u.hash = '';
      const host = u.host.toLowerCase().replace(/^www\./, '');
      const p = u.pathname.replace(/\/+$/, '');
      return `${u.protocol.toLowerCase()}//${host}${p}${u.search}`;
    } catch { return s.toLowerCase(); }
  };
  assert.match(APP_SOURCE, /function normalizeUrl/);

  const base = normalize('https://www.youtube.com/watch?v=abc');
  assert.equal(normalize('www.youtube.com/watch?v=abc'), base);
  assert.equal(normalize('  https://youtube.com/watch?v=abc  '), base);
  assert.equal(normalize('https://www.youtube.com/watch?v=abc#t=10'), base);
  assert.equal(normalize('HTTPS://WWW.YouTube.com/watch?v=abc'), base);

  // ...and the query really does distinguish videos.
  assert.notEqual(normalize('https://www.youtube.com/watch?v=def'), base);
});
