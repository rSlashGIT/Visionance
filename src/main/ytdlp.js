'use strict';

/**
 * yt-dlp integration.
 *
 * Visionance never downloads a copy of an online video. It asks yt-dlp to
 * resolve the direct stream URL(s) for a page and hands those to the player or
 * to ffmpeg, so playback is streamed and enhanced live.
 *
 * Policy, in order:
 *
 *   1. Anonymous. An ordinary public link must never cause Visionance to read
 *      the user's browser cookie jar. That is a credential store, and touching
 *      it "just in case" is both a privacy problem and a common cause of
 *      failures on links that needed no authentication at all.
 *   2. Authenticated, only when the failure says authentication is the problem,
 *      only with a method the user explicitly configured, and only once.
 *
 * There is no anti-bot circumvention here, and there never should be. If a site
 * says "prove you are signed in", the answer is the user's own credentials via
 * an explicit setting, or a clear error.
 *
 * Capability detection instead of hardcoded flags: recent yt-dlp builds need an
 * external JavaScript runtime for some extractors, and the option spelling has
 * changed more than once. We read `--help` from the installed binary, look for
 * what it actually supports, and degrade to a structured error when the build
 * cannot do what the site needs.
 */

const path = require('path');
const { execFile } = require('child_process');
const { VisionanceError, CODES, redactArgs, redact } = require('./errors');
const jsRuntime = require('./js-runtime');
const { logger } = require('./logger');

const log = logger.child('ytdlp');

const RESOLVE_TIMEOUT = 60000;
const CAPABILITY_TIMEOUT = 15000;

/** Codecs Chromium plays reliably inside Electron. */
const SAFE_VCODEC = /^(avc1|h264|vp0?9|vp8|av01)/i;
const SAFE_ACODEC = /^(mp4a|aac|opus|vorbis)/i;

/* ------------------------------------------------------------------ *
 * Process helper
 * ------------------------------------------------------------------ */

function runYtDlp(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!bin) return reject(new VisionanceError(CODES.YT_DLP_MISSING));

    const env = { ...process.env, ...(opts.extraEnv || {}) };
    if (opts.extraPath) {
      env.PATH = `${opts.extraPath}${path.delimiter}${env.PATH || ''}`;
    }

    execFile(
      bin,
      args,
      {
        timeout: opts.timeout || RESOLVE_TIMEOUT,
        maxBuffer: 128 * 1024 * 1024,
        windowsHide: true,
        env
      },
      (err, stdout, stderr) => {
        const errText = String(stderr || '');
        if (err) {
          const e = new Error(String(err.message || 'yt-dlp failed'));
          e.stderr = errText;
          e.stdout = String(stdout || '');
          e.timedOut = !!err.killed;
          return reject(e);
        }
        resolve({ stdout: String(stdout), stderr: errText });
      }
    );
  });
}

/* ------------------------------------------------------------------ *
 * Capability detection
 * ------------------------------------------------------------------ */

const capabilityCache = new Map(); // bin -> { at, value }
const CAPABILITY_TTL = 5 * 60 * 1000;

/** Every `--flag` the installed build advertises in its help output. */
function parseFlags(helpText) {
  const flags = new Set();
  const re = /(^|\s)(--[a-z0-9][a-z0-9-]*)/gi;
  let m;
  while ((m = re.exec(helpText))) flags.add(m[2].toLowerCase());
  return flags;
}

/** yt-dlp versions are dates: 2025.09.05 (sometimes with a .nnnnnn suffix). */
function parseVersionDate(version) {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(String(version || '').trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * How this build wants to be told about a JavaScript runtime.
 *
 * Current yt-dlp takes `--js-runtimes RUNTIME[:PATH]` (plural), with priority
 * deno > node > quickjs > bun and only deno enabled by default. Older builds
 * used other spellings. We read the installed binary's own help rather than
 * guessing, because passing a flag this build does not have makes yt-dlp exit
 * immediately with a usage error - turning a working link into a hard failure.
 */
function detectRuntimeFlag(flags, helpLower) {
  if (flags.has('--js-runtimes')) {
    return { kind: 'js-runtimes', flag: '--js-runtimes', supportsPath: true };
  }
  if (flags.has('--js-runtime')) {
    return { kind: 'js-runtime', flag: '--js-runtime', supportsPath: false };
  }
  if (flags.has('--jsi')) {
    return { kind: 'js-runtime', flag: '--jsi', supportsPath: false };
  }
  if (flags.has('--extractor-args') && /(\bjsi\b|jsinterp)/.test(helpLower)) {
    return { kind: 'extractor-arg', flag: '--extractor-args', template: 'youtube:jsi=%s', supportsPath: false };
  }
  return null;
}

/**
 * Inspect the installed binary. Cached briefly: this runs two short child
 * processes and the answer cannot change while the app is open unless the user
 * reinstalls, which invalidates the cache explicitly.
 */
async function capabilities(bin, { userDataDir = null, electronPath = process.execPath, force = false } = {}) {
  if (!bin) {
    return {
      available: false,
      version: null,
      flags: new Set(),
      jsRuntimes: [],
      preferredRuntime: null,
      supportsJsRuntimeConfig: false,
      jsRuntimeFlag: null,
      stale: false
    };
  }

  const cached = capabilityCache.get(bin);
  if (!force && cached && Date.now() - cached.at < CAPABILITY_TTL) return cached.value;

  let version = null;
  let help = '';
  try {
    const v = await runYtDlp(bin, ['--version'], { timeout: CAPABILITY_TIMEOUT });
    version = v.stdout.trim().split('\n')[0] || null;
  } catch (err) {
    log.warn('version probe failed', { error: redact(err.message) });
  }
  try {
    const h = await runYtDlp(bin, ['--help'], { timeout: CAPABILITY_TIMEOUT });
    help = h.stdout;
  } catch (err) {
    // Some builds print help to stderr on a non-zero exit; use whatever we got.
    help = String((err && err.stdout) || '') + String((err && err.stderr) || '');
  }

  const flags = parseFlags(help);
  const helpLower = help.toLowerCase();
  const jsRuntimeFlag = detectRuntimeFlag(flags, helpLower);

  // Every candidate here has actually been executed and answered like the
  // runtime it claims to be - see js-runtime.js.
  const jsRuntimes = await jsRuntime.discover({ userDataDir, electronPath, force });

  const versionDate = parseVersionDate(version);
  const ageDays = versionDate ? Math.floor((Date.now() - versionDate.getTime()) / 86400000) : null;

  const value = {
    available: true,
    bin,
    version,
    versionDate: versionDate ? versionDate.toISOString().slice(0, 10) : null,
    ageDays,
    // yt-dlp ships roughly monthly and sites break faster than that; six months
    // is where "probably fine" turns into "probably your problem".
    stale: ageDays != null && ageDays > 180,
    flags,
    flagCount: flags.size,
    supportsCookiesFromBrowser: flags.has('--cookies-from-browser'),
    supportsCookiesFile: flags.has('--cookies'),
    supportsExtractorArgs: flags.has('--extractor-args'),
    supportsImpersonate: flags.has('--impersonate'),
    supportsRemoteComponents: flags.has('--remote-components'),
    jsRuntimes,
    // The one we will actually hand over, already validated by execution.
    preferredRuntime: jsRuntimeFlag ? (jsRuntimes[0] || null) : null,
    jsRuntimeFlag,
    supportsJsRuntimeConfig: !!jsRuntimeFlag && jsRuntimes.length > 0
  };

  capabilityCache.set(bin, { at: Date.now(), value });
  log.info('capabilities probed', {
    version,
    ageDays,
    flags: flags.size,
    jsRuntimes: jsRuntimes.map((r) => `${r.runtime}/${r.source}`).join(',') || 'none',
    preferred: value.preferredRuntime ? value.preferredRuntime.runtime : 'none',
    jsRuntimeConfig: jsRuntimeFlag ? jsRuntimeFlag.flag : 'unsupported'
  });
  return value;
}

function invalidateCapabilities(bin) {
  if (bin) capabilityCache.delete(bin);
  else capabilityCache.clear();
}

/* ------------------------------------------------------------------ *
 * Error classification
 * ------------------------------------------------------------------ */

/**
 * Map raw yt-dlp output onto a structured error. Ordered most specific first;
 * "private video" has to beat "video unavailable", and a cookie failure has to
 * beat the auth prompt it produces.
 */
const PATTERNS = [
  // Rate limiting is checked first: everything downstream of a 429 is a
  // symptom, including the "prove you're not a bot" prompt YouTube then shows.
  [/http error 429|too many requests|rate[- ]?limit/i, CODES.RATE_LIMITED],
  [/could not (copy|find|open|read).{0,40}cookie|cookie.{0,30}database.{0,30}(locked|in use)|failed to decrypt.{0,20}cookie|unsupported browser|no cookies? (found|for)/i, CODES.COOKIE_FAILURE],
  [/--remote-components|remote component/i, CODES.REMOTE_COMPONENT_REQUIRED],
  [/no supported javascript runtime|only deno is enabled by default|--js-runtimes|nsig extraction failed|unable to (extract|decrypt) (n|signature)|player (js|javascript).{0,30}(failed|not found)|requires? (a |an )?(external )?(javascript|js) (runtime|interpreter)|install (deno|bun|quickjs)|jsi(nterp)? (is )?(unavailable|required|not)/i, CODES.JS_RUNTIME_REQUIRED],
  [/sign in to confirm your age|age[- ]restricted|inappropriate for some users|confirm your age/i, CODES.AGE_RESTRICTED],
  [/private video|members[- ]only|join this channel|available to.{0,30}members|requires? (a )?(login|account|subscription)|sign in to (confirm|view|watch)|use --cookies|this video is only available|login required|not a bot/i, CODES.AUTH_REQUIRED],
  [/available in your (country|region)|not made this video available|geo[- ]?(restricted|blocked)|blocked it (in|on) .{0,30}country|content is not available in/i, CODES.REGION_RESTRICTED],
  [/unsupported url|is not a valid url|no suitable extractor|unable to (find|extract) .{0,20}(extractor|video id)/i, CODES.UNSUPPORTED_URL],
  [/video unavailable|has been removed|no longer available|account (associated|has been) terminated|this video (does not exist|is unavailable)|http error 404/i, CODES.VIDEO_UNAVAILABLE],
  [/requested format (is )?not available|no video formats found|no formats found/i, CODES.NO_PLAYABLE_FORMAT],
  [/yt-dlp is out of date|please (re)?install or update|update to (the )?(nightly|master)|confirm you.{0,10}re not a bot.{0,80}update/i, CODES.YT_DLP_OUTDATED],
  [/timed out|timeout|etimedout|read timed out|connection (reset|aborted)|getaddrinfo|name (or service )?not known|network is unreachable|temporary failure in name resolution|ssl|certificate verify failed/i, CODES.NETWORK_TIMEOUT]
];

/**
 * @param {Error|string} err
 * @param {object} [ctx] { capabilities, attemptedAuth }
 * @returns {VisionanceError}
 */
function classifyError(err, ctx = {}) {
  if (err instanceof VisionanceError) return err;

  const raw = typeof err === 'string'
    ? err
    : String((err && (err.stderr || err.message)) || '');
  const text = raw.replace(/\s+/g, ' ');

  if (err && err.timedOut) {
    return new VisionanceError(CODES.NETWORK_TIMEOUT, { technicalDetails: raw });
  }

  for (const [re, code] of PATTERNS) {
    if (re.test(text)) {
      return buildError(code, raw, ctx);
    }
  }

  return new VisionanceError(CODES.UNKNOWN, {
    message: 'Visionance could not resolve that link.',
    technicalDetails: raw
  });
}

function buildError(code, raw, ctx) {
  const caps = ctx.capabilities || null;

  if (code === CODES.JS_RUNTIME_REQUIRED) {
    let suggested;
    if (!caps || !caps.jsRuntimeFlag) {
      suggested = 'Update yt-dlp (Settings → Online video → Reinstall); this build cannot use an external JavaScript runtime.';
    } else if (!caps.jsRuntimes.length) {
      suggested = 'Settings → Online video → Install JavaScript runtime, or install Node.js or Deno yourself.';
    } else {
      suggested = `A JavaScript runtime was found and used (${caps.jsRuntimes[0].runtime}), but the site still refused. Updating yt-dlp usually fixes this.`;
    }
    return new VisionanceError(code, { technicalDetails: raw, suggestedAction: suggested });
  }

  if (code === CODES.RATE_LIMITED) {
    return new VisionanceError(code, {
      message: 'The site is temporarily refusing anonymous requests from this network (HTTP 429).',
      technicalDetails: raw
    });
  }

  if ((code === CODES.AUTH_REQUIRED || code === CODES.AGE_RESTRICTED) && ctx.attemptedAuth) {
    return new VisionanceError(code, {
      message: code === CODES.AGE_RESTRICTED
        ? 'This video is age-restricted and the configured account did not satisfy it.'
        : 'This video needs an account, and the configured sign-in did not grant access.',
      technicalDetails: raw,
      suggestedAction: 'Check that the account you configured actually has access to this video.'
    });
  }

  if (code === CODES.YT_DLP_OUTDATED && caps && caps.version) {
    return new VisionanceError(code, {
      message: `The installed yt-dlp (${caps.version}) is too old for this site.`,
      technicalDetails: raw
    });
  }

  return new VisionanceError(code, { technicalDetails: raw });
}

/* ------------------------------------------------------------------ *
 * Format selection
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Format classification
 *
 * Not every extractor reports codecs. archive.org, direct file links and
 * plenty of smaller sites return formats whose `vcodec`/`acodec` are simply
 * absent. Rejecting those - as a naive `f.vcodec !== 'none'` filter does -
 * throws away the only playable stream the site offered and surfaces as
 * "This source is not supported" in the player.
 *
 * So: use the codec when it is stated, and fall back to the container when it
 * is not. Containers Chromium cannot decode are excluded either way.
 * ------------------------------------------------------------------ */

/** Containers Chromium decodes inside Electron. */
const PLAYABLE_VIDEO_EXT = /^(mp4|m4v|mov|webm|ogv|ogg)$/i;
const PLAYABLE_AUDIO_EXT = /^(m4a|mp3|opus|weba|webm|oga|ogg|wav|flac|aac)$/i;
/** Containers it definitely cannot, whatever the codec inside them. */
const UNPLAYABLE_EXT = /^(avi|mkv|flv|wmv|asf|rm|rmvb|ts|m2ts|mpg|mpeg|3gp|divx|vob)$/i;

/** Only a plain HTTP byte stream can be handed to a <video> element. */
function isProgressive(f) {
  return !f.protocol || /^(https?|m3u8_native_progressive)$/i.test(f.protocol);
}

function isManifest(f) {
  return !!f.protocol && /^(m3u8|http_dash_segments|dash|rtmp|rtsp|ism)/i.test(f.protocol);
}

const known = (codec) => !!codec && codec !== 'none' && codec !== 'unknown' && codec !== '?';

/**
 * @returns {{kind:'muxed'|'video'|'audio'|'none', playable:boolean,
 *            codecsKnown:boolean, reason:string|null}}
 */
function classifyFormat(f) {
  const ext = String(f.ext || '').toLowerCase();
  const hasV = known(f.vcodec);
  const hasA = known(f.acodec);
  const codecsKnown = hasV || hasA;

  if (!f.url) return { kind: 'none', playable: false, codecsKnown, reason: 'no url' };
  if (isManifest(f)) return { kind: 'none', playable: false, codecsKnown, reason: `protocol ${f.protocol}` };
  if (!isProgressive(f)) return { kind: 'none', playable: false, codecsKnown, reason: `protocol ${f.protocol}` };
  if (UNPLAYABLE_EXT.test(ext)) return { kind: 'none', playable: false, codecsKnown, reason: `container ${ext}` };

  if (codecsKnown) {
    const videoOk = hasV && SAFE_VCODEC.test(f.vcodec);
    const audioOk = hasA && SAFE_ACODEC.test(f.acodec);
    if (hasV && hasA) {
      return {
        kind: 'muxed',
        playable: videoOk && audioOk,
        codecsKnown: true,
        reason: videoOk && audioOk ? null : `codecs ${f.vcodec}/${f.acodec}`
      };
    }
    if (hasV) {
      return { kind: 'video', playable: videoOk, codecsKnown: true, reason: videoOk ? null : `vcodec ${f.vcodec}` };
    }
    return { kind: 'audio', playable: audioOk, codecsKnown: true, reason: audioOk ? null : `acodec ${f.acodec}` };
  }

  // Codecs unstated. Infer from the container, and assume a video container
  // carries its own audio - which is what a whole-file download actually is.
  if (PLAYABLE_VIDEO_EXT.test(ext)) {
    return { kind: 'muxed', playable: true, codecsKnown: false, reason: null };
  }
  if (PLAYABLE_AUDIO_EXT.test(ext)) {
    return { kind: 'audio', playable: true, codecsKnown: false, reason: null };
  }
  if (!ext && (f.height || f.width)) {
    // No extension either, but it declares a picture size, so treat it as video
    // and let the player decide. Better than discarding the only candidate.
    return { kind: 'muxed', playable: true, codecsKnown: false, reason: null };
  }
  return { kind: 'none', playable: false, codecsKnown: false, reason: ext ? `container ${ext}` : 'unidentifiable' };
}

function scoreVideo(f) {
  // Resolution, then fps, then bitrate. Slight bias to h264: cheaper to
  // decode, which leaves more GPU headroom for the shader passes.
  const codecBonus = /^(avc1|h264)/i.test(f.vcodec || '') ? 1.05 : 1;
  // A format with stated codecs is a safer bet than one we inferred.
  const knownBonus = known(f.vcodec) ? 1.02 : 1;
  return ((f.height || 0) * 10000 + (f.fps || 0) * 100 + (f.tbr || f.abr || 0)) * codecBonus * knownBonus;
}

/**
 * How confident are we that this machine class decodes the codec in hardware?
 *
 * This ordering is not a quality judgement - AV1 is the better codec per bit.
 * It is a *realtime playback* judgement: on the hardware Visionance targets
 * (Intel iGPU compositing, a mid-range discrete GPU) H.264 is decoded in
 * hardware everywhere, VP9 nearly everywhere, and AV1 usually is not - and a
 * software AV1 decode at 1080p spends the CPU budget the shader passes need.
 *
 * Offline Create does not use this: a render is not racing a clock, so it
 * takes the highest-quality source it can get.
 */
const WATCH_CODEC_RANK = [
  [/^(avc1|avc3|h264)/i, 4],
  [/^vp0?9/i, 3],
  [/^(hev1|hvc1|h265)/i, 2],
  [/^av01/i, 1]
];

function watchCodecRank(vcodec) {
  const c = String(vcodec || '');
  for (const [re, rank] of WATCH_CODEC_RANK) {
    if (re.test(c)) return rank;
  }
  return 0;
}

/**
 * Watch's own ordering, applied after the height cap has already excluded
 * anything too large. Highest rendition that fits, then the codec most likely
 * to decode in hardware, then the *lower* bitrate - because at equal picture
 * size and codec the smaller file starts sooner and buffers deeper.
 */
function compareForWatch(a, b) {
  const ha = a.height || 0;
  const hb = b.height || 0;
  if (ha !== hb) return hb - ha;

  const ca = watchCodecRank(a.vcodec);
  const cb = watchCodecRank(b.vcodec);
  if (ca !== cb) return cb - ca;

  const fa = a.fps || 0;
  const fb = b.fps || 0;
  if (fa !== fb) return fb - fa;

  const ba = a.tbr || a.abr || 0;
  const bb = b.tbr || b.abr || 0;
  if (ba && bb && ba !== bb) return ba - bb;

  return (known(b.vcodec) ? 1 : 0) - (known(a.vcodec) ? 1 : 0);
}

function scoreAudio(f) {
  return (f.abr || 0) * 1000 + (f.tbr || 0) + (known(f.acodec) ? 1 : 0);
}

/**
 * Pick the best playable format of a kind.
 * @param {'muxed'|'video'|'audio'} kind
 * @param {number|null} maxHeight
 * @param {'watch'|'quality'} purpose  how to break ties below the cap
 */
function pickBest(formats, kind, maxHeight, purpose = 'quality') {
  const list = formats.filter((f) => {
    const c = classifyFormat(f);
    if (!c.playable) return false;
    if (kind === 'audio') return c.kind === 'audio';
    if (kind === 'video') return c.kind === 'video';
    return c.kind === 'muxed';
  }).filter((f) => {
    if (kind === 'audio') return true;
    return !maxHeight || !f.height || f.height <= maxHeight;
  });

  if (kind === 'audio') return list.sort((a, b) => scoreAudio(b) - scoreAudio(a))[0] || null;
  if (purpose === 'watch') return list.sort(compareForWatch)[0] || null;
  return list.sort((a, b) => scoreVideo(b) - scoreVideo(a))[0] || null;
}

/**
 * Why nothing was playable, in terms a user can act on.
 * Distinguishing "the site only offers HLS" from "the site offered nothing" is
 * the difference between a fixable report and a shrug.
 */
function explainNoFormat(formats) {
  const reasons = formats.map(classifyFormat);
  const total = formats.length;
  const manifestOnly = total > 0 && formats.every((f) => isManifest(f));
  if (manifestOnly) {
    return new VisionanceError(CODES.NO_PLAYABLE_FORMAT, {
      message: 'This source is only offered as an adaptive stream (HLS/DASH), which Watch cannot play directly yet.',
      technicalDetails: `${total} formats, all manifest protocols: ` +
        [...new Set(formats.map((f) => f.protocol))].join(','),
      suggestedAction: 'Try a different quality or source; progressive MP4 links play fine.'
    });
  }
  const summary = reasons
    .map((r, i) => `${formats[i].format_id || i}:${r.reason || r.kind}`)
    .slice(0, 12)
    .join(' ');
  return new VisionanceError(CODES.NO_PLAYABLE_FORMAT, {
    technicalDetails: total ? `${total} formats offered, none decodable: ${summary}` : 'no formats offered'
  });
}

/** Direct CDN URLs are short-lived; most carry their own expiry. */
function expiryOf(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    for (const key of ['expire', 'expires', 'Expires', 'oe', 'ei']) {
      const raw = u.searchParams.get(key);
      if (!raw) continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      // Unix seconds in a sane window (2001..2100).
      if (n > 1_000_000_000 && n < 4_102_444_800) return n * 1000;
    }
    const m = /\/expire\/(\d{10})(\/|$)/.exec(u.pathname);
    if (m) return Number(m[1]) * 1000;
  } catch { /* not a parseable URL */ }
  return null;
}

function slimFormat(f, fallbackHeaders) {
  if (!f) return null;
  const c = classifyFormat(f);
  return {
    url: f.url,
    codecsKnown: c.codecsKnown,
    formatId: f.format_id || null,
    ext: f.ext || null,
    height: f.height || null,
    width: f.width || null,
    fps: f.fps || null,
    vcodec: f.vcodec && f.vcodec !== 'none' ? f.vcodec : null,
    acodec: f.acodec && f.acodec !== 'none' ? f.acodec : null,
    abr: f.abr || null,
    tbr: f.tbr || null,
    protocol: f.protocol || null,
    filesize: f.filesize || f.filesize_approx || null,
    language: f.language || null,
    // Per-format headers matter: a split video/audio pair can come from
    // different hosts with different requirements.
    headers: { ...(fallbackHeaders || {}), ...(f.http_headers || {}) },
    expiresAt: expiryOf(f.url)
  };
}

/* ------------------------------------------------------------------ *
 * Argument construction
 * ------------------------------------------------------------------ */

/**
 * Build the argv for one resolution attempt. Pure, so the policy is testable
 * without a yt-dlp binary present.
 *
 * @param {object} o
 *   pageUrl   {string}
 *   auth      {{mode:'none'|'browser'|'file', browser?:string, cookiesFile?:string}}
 *   jsRuntime {{name:string}|null}
 *   caps      capability object
 */
function buildResolveArgs({
  pageUrl, auth = { mode: 'none' }, jsRuntime = null, caps = null, allowRemoteComponents = false
}) {
  const args = [
    '--no-playlist',
    '--dump-single-json',
    '--socket-timeout', '15',
    '--retries', '2'
  ];

  // Warnings are intentionally *not* suppressed: "No supported JavaScript
  // runtime could be found" arrives as a warning, and it is how we detect that
  // extraction was degraded rather than outright broken.

  if (jsRuntime && caps && caps.jsRuntimeFlag) {
    const spec = caps.jsRuntimeFlag;
    const name = jsRuntime.runtime || jsRuntime.name;
    if (spec.kind === 'extractor-arg') {
      args.push(spec.flag, spec.template.replace('%s', name));
    } else {
      // Deliberately the bare `RUNTIME` form, never `RUNTIME:PATH`.
      //
      // The path form is documented and works from a shell, but breaks when the
      // runtime lives somewhere with a space in it - "C:\Program Files\nodejs"
      // is the default Node location on Windows - because of how the argument
      // survives quoting on the way to yt-dlp. Verified: with `node:<that
      // path>` yt-dlp still reports "No supported JavaScript runtime".
      //
      // Instead the runtime's directory is prepended to the child's PATH (see
      // resolveStream), which pins the exact validated binary, works for a
      // managed runtime that is on no PATH at all, and has no quoting hazard.
      args.push(spec.flag, name);
    }
  }

  if (allowRemoteComponents && caps && caps.supportsRemoteComponents) {
    // Off unless the user opts in: this lets yt-dlp fetch JavaScript at run
    // time, which is a supply-chain decision that is not ours to make quietly.
    args.push('--remote-components', 'ejs:github');
  }

  if (auth.mode === 'browser' && auth.browser) {
    args.push('--cookies-from-browser', auth.browser);
  } else if (auth.mode === 'file' && auth.cookiesFile) {
    args.push('--cookies', auth.cookiesFile);
  }

  args.push('--', pageUrl);
  return args;
}

/** Is this failure one that a second, authenticated attempt could fix? */
function isAuthFailure(code) {
  return code === CODES.AUTH_REQUIRED || code === CODES.AGE_RESTRICTED;
}

/**
 * The escalation policy, as a pure function so it can be tested without a
 * yt-dlp binary or a network.
 *
 * The first attempt is always anonymous. Nothing else is even considered until
 * a failure tells us specifically what is missing, and each escalation is tried
 * at most once.
 *
 * @param {object} o
 *   error      {VisionanceError|null} the previous attempt's failure
 *   caps       capability object
 *   auth       user-configured authentication method
 *   allowAuth  {boolean}
 *   tried      {string[]} attempt labels already used
 *   warn       {(msg:string)=>void} optional sink for "could not escalate" notes
 * @returns {{label:string, useAuth:boolean, jsRuntime:object|null}|null}
 */
function planAttempt({ error = null, caps = null, auth = { mode: 'none' }, allowAuth = true, tried = [], warn = null } = {}) {
  // The runtime goes in from the very first attempt. Without it modern yt-dlp
  // does not fail - it *succeeds badly*, returning a handful of formats the
  // player cannot use, which is far harder to diagnose than an error.
  const runtime = (caps && caps.jsRuntimeFlag && caps.jsRuntimes && caps.jsRuntimes[0]) || null;

  if (!tried.length) return { label: 'anonymous', useAuth: false, jsRuntime: runtime };
  if (!error) return null;

  if (error.code === CODES.JS_RUNTIME_REQUIRED && !tried.includes('js-runtime')) {
    // Only reachable when the first attempt had no runtime to offer.
    if (runtime && !tried.includes('anonymous-with-runtime')) {
      return { label: 'js-runtime', useAuth: false, jsRuntime: runtime };
    }
    return null;
  }

  if (isAuthFailure(error.code) && !tried.includes('authenticated')) {
    if (!allowAuth || !auth || auth.mode === 'none') return null;
    if (auth.mode === 'browser' && caps && !caps.supportsCookiesFromBrowser) {
      if (warn) warn('This yt-dlp build cannot read browser cookies.');
      return null;
    }
    if (auth.mode === 'file' && caps && !caps.supportsCookiesFile) {
      if (warn) warn('This yt-dlp build cannot read a cookies file.');
      return null;
    }
    // Keep the runtime: authentication and the JS challenge are independent
    // problems, and dropping it here would re-break extraction.
    return { label: 'authenticated', useAuth: true, jsRuntime: runtime };
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

function normaliseInfo(info, pageUrl, opts) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const baseHeaders = info.http_headers || (formats[0] && formats[0].http_headers) || {};
  const notes = [];

  const purpose = opts.purpose === 'watch' ? 'watch' : 'quality';

  let muxed = pickBest(formats, 'muxed', opts.maxHeight, purpose);
  let videoOnly = pickBest(formats, 'video', opts.maxHeight, purpose);
  const audioOnly = pickBest(formats, 'audio');

  // A height cap must never be the reason nothing plays. If it filtered
  // everything out, drop it and say so rather than failing.
  if (!muxed && !videoOnly && opts.maxHeight) {
    muxed = pickBest(formats, 'muxed', null, purpose);
    videoOnly = pickBest(formats, 'video', null, purpose);
    if (muxed || videoOnly) {
      notes.push(`No format at or below ${opts.maxHeight}p was available; a higher one was used.`);
    }
  }

  // Some extractors describe a single file on the info object rather than in a
  // formats list (direct links, some archives).
  if (!muxed && !videoOnly && info.url) {
    const direct = {
      url: info.url,
      ext: info.ext,
      vcodec: info.vcodec,
      acodec: info.acodec,
      protocol: info.protocol,
      height: info.height,
      width: info.width,
      fps: info.fps,
      http_headers: baseHeaders
    };
    if (classifyFormat(direct).playable) muxed = direct;
  }

  const muxedHeight = (muxed && muxed.height) || 0;
  const splitHeight = (videoOnly && videoOnly.height) || 0;
  // Prefer the split pair only when it genuinely buys resolution; a muxed
  // stream keeps playback simpler and cannot drift out of sync.
  //
  // For Watch the bar is a little higher: a muxed rendition within the same
  // ladder rung is taken even if the split pair is nominally taller, because
  // one connection starts faster and cannot desynchronise. It is *not* taken
  // just because it is muxed - YouTube's only progressive format is 360p, and
  // serving 360p to avoid a second connection would be the wrong trade.
  let useSplit = !!(videoOnly && audioOnly && (splitHeight > muxedHeight || !muxed));
  if (useSplit && purpose === 'watch' && muxedHeight > 0 && splitHeight > 0 &&
      muxedHeight >= splitHeight * 0.93) {
    useSplit = false;
    notes.push('A single combined stream of the same quality was available, so it was used.');
  }
  /*
   * The audio-recovery ladder's last rung.
   *
   * When a split pair's audio leg has been refused twice, resolution stops
   * being the thing that matters: a combined stream cannot lose its sound,
   * because there is no second request to refuse. The caller only asks for
   * this after a real failure, and it is told what it gave up.
   */
  if (opts.preferMuxed && useSplit && muxed) {
    useSplit = false;
    notes.push(
      muxedHeight && splitHeight && muxedHeight < splitHeight
        ? `A combined ${muxedHeight}p stream was used so the sound is part of the video.`
        : 'A combined stream was used so the sound is part of the video.'
    );
  }

  const video = slimFormat(useSplit ? videoOnly : muxed, baseHeaders);
  const audio = useSplit ? slimFormat(audioOnly, baseHeaders) : null;

  if (!video || !video.url) throw explainNoFormat(formats);

  if (!video.codecsKnown) {
    notes.push('The site did not state this stream\'s codecs; playback was attempted from its container.');
  }

  const expiries = [video.expiresAt, audio && audio.expiresAt].filter(Boolean);

  return {
    resolvedAt: Date.now(),
    expiresAt: expiries.length ? Math.min(...expiries) : null,
    pageUrl,
    webpageUrl: info.webpage_url || pageUrl,
    title: info.title || info.fulltitle || pageUrl,
    uploader: info.uploader || info.channel || info.uploader_id || null,
    channelUrl: info.channel_url || info.uploader_url || null,
    duration: info.duration || null,
    thumbnail: info.thumbnail || null,
    description: typeof info.description === 'string' ? info.description.slice(0, 500) : null,
    isLive: !!(info.is_live || info.live_status === 'is_live'),
    liveStatus: info.live_status || null,
    extractor: info.extractor_key || info.extractor || null,
    ageLimit: info.age_limit || 0,
    muxed: !useSplit,
    video,
    audio,
    formatNotes: notes,
    // What was actually chosen, in terms a diagnostic report can print without
    // going anywhere near a URL or a header.
    selection: {
      purpose,
      capHeight: opts.maxHeight || null,
      videoFormatId: video.formatId,
      audioFormatId: audio ? audio.formatId : null,
      height: video.height,
      fps: video.fps,
      vcodec: video.vcodec,
      acodec: (audio && audio.acodec) || video.acodec,
      videoKbps: video.tbr || null,
      audioKbps: (audio && (audio.abr || audio.tbr)) || null,
      split: useSplit,
      hardwareCodecRank: watchCodecRank(video.vcodec)
    },
    available: formats
      .filter((f) => classifyFormat(f).playable && classifyFormat(f).kind !== 'audio')
      .map((f) => ({
        height: f.height || null,
        fps: f.fps || null,
        ext: f.ext,
        vcodec: f.vcodec && f.vcodec !== 'none' ? f.vcodec : null,
        formatId: f.format_id
      }))
      .filter((v, i, a) => a.findIndex((x) => x.height === v.height && x.fps === v.fps) === i)
      .sort((a, b) => (b.height || 0) - (a.height || 0))
      .slice(0, 12)
  };
}

/**
 * Resolve a page URL into playable stream URLs.
 *
 * @param {string} bin  path to yt-dlp
 * @param {string} pageUrl
 * @param {object} opts
 *   maxHeight   {number|null}
 *   auth        {{mode:'none'|'browser'|'file', browser?, cookiesFile?}}  user-configured method
 *   allowAuth   {boolean}  may we escalate to the configured method? default true
 *   nodePath    {string}   runtime to offer yt-dlp when it needs JavaScript
 * @returns {Promise<object>} normalised stream descriptor
 */
async function resolveStream(bin, pageUrl, opts = {}) {
  if (!bin) throw new VisionanceError(CODES.YT_DLP_MISSING);
  if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) {
    throw new VisionanceError(CODES.UNSUPPORTED_URL, {
      message: 'That does not look like a web address.'
    });
  }

  const caps = await capabilities(bin, {
    userDataDir: opts.userDataDir,
    electronPath: opts.electronPath || process.execPath
  });
  const auth = opts.auth && opts.auth.mode ? opts.auth : { mode: 'none' };
  const allowAuth = opts.allowAuth !== false;
  const warnings = [];
  const attempts = [];
  const tried = [];

  let raw = null;
  let lastError = null;
  let attemptedAuth = false;
  let usedRuntime = null;

  for (;;) {
    const step = planAttempt({
      error: lastError,
      caps,
      auth,
      allowAuth,
      tried,
      warn: (m) => warnings.push(m)
    });
    if (!step) break;

    const args = buildResolveArgs({
      pageUrl,
      auth: step.useAuth ? auth : { mode: 'none' },
      jsRuntime: step.jsRuntime,
      caps,
      allowRemoteComponents: !!opts.allowRemoteComponents
    });
    const runtimeName = step.jsRuntime ? (step.jsRuntime.runtime || step.jsRuntime.name) : null;
    // The runtime yt-dlp spawns inherits yt-dlp's environment, so a candidate
    // that needs one (Electron behaving as Node) gets it here.
    const extraPath = step.jsRuntime && step.jsRuntime.path ? path.dirname(step.jsRuntime.path) : null;
    const extraEnv = (step.jsRuntime && step.jsRuntime.env) || null;

    log.info('resolve attempt', {
      attempt: step.label,
      host: safeHost(pageUrl),
      auth: step.useAuth ? auth.mode : 'none',
      jsRuntime: runtimeName || 'none',
      args: redactArgs(args).join(' ')
    });
    tried.push(step.label);
    attempts.push({
      label: step.label,
      auth: step.useAuth ? auth.mode : 'none',
      jsRuntime: runtimeName
    });
    if (step.useAuth) attemptedAuth = true;

    try {
      raw = await runYtDlp(bin, args, {
        timeout: opts.timeoutMs || RESOLVE_TIMEOUT,
        extraPath,
        extraEnv
      });
      lastError = null;
      usedRuntime = step.jsRuntime || null;
      if (step.label === 'js-runtime') {
        warnings.push(`The site needed a JavaScript challenge solved; used ${runtimeName}.`);
      } else if (step.label === 'authenticated') {
        warnings.push(`Signed-in access was used (${auth.mode}).`);
      }
      break;
    } catch (err) {
      lastError = classifyError(err, { capabilities: caps, attemptedAuth });
    }
  }

  if (!raw) {
    const error = lastError || new VisionanceError(CODES.UNKNOWN);
    log.warn('resolve failed', {
      host: safeHost(pageUrl),
      code: error.code,
      attempts: attempts.map((a) => a.label).join('>') || 'none'
    });
    throw error;
  }

  /* ---- parse ---- */
  let info;
  try {
    info = JSON.parse(raw.stdout);
  } catch (err) {
    throw new VisionanceError(CODES.UNKNOWN, {
      message: 'yt-dlp returned something Visionance could not read.',
      technicalDetails: `${err.message} :: ${raw.stdout.slice(0, 400)}`
    });
  }

  const result = normaliseInfo(info, pageUrl, opts);

  // A successful resolve can still be degraded - yt-dlp warns rather than fails
  // when it could only reach a subset of formats.
  if (/nsig extraction failed|some formats may be missing/i.test(raw.stderr || '')) {
    warnings.push('Some higher-quality formats were unavailable; yt-dlp may need updating or a JavaScript runtime.');
  }
  if (caps.stale) {
    warnings.push(`The installed yt-dlp is ${caps.ageDays} days old; sites change faster than that.`);
  }

  warnings.push(...(result.formatNotes || []));
  result.warnings = warnings;
  result.usedAuth = attemptedAuth ? auth.mode : 'none';
  result.usedRuntime = usedRuntime
    ? { runtime: usedRuntime.runtime || usedRuntime.name, source: usedRuntime.source, version: usedRuntime.version }
    : null;
  result.attempts = attempts;
  result.ytdlpVersion = caps.version;

  log.info('resolved', {
    host: safeHost(pageUrl),
    extractor: result.extractor,
    muxed: result.muxed,
    height: result.video.height,
    ext: result.video.ext,
    codecsKnown: result.video.codecsKnown,
    live: result.isLive,
    auth: result.usedAuth,
    runtime: result.usedRuntime ? result.usedRuntime.runtime : 'none',
    expiresInSec: result.expiresAt ? Math.round((result.expiresAt - Date.now()) / 1000) : null
  });

  return result;
}

/** Host only - a full URL in a log can carry identifiers we should not keep. */
function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

/**
 * Would this descriptor's URLs still be accepted by the CDN?
 * @param {object} resolved
 * @param {number} [skewSeconds] treat anything expiring sooner than this as expired
 */
function isExpired(resolved, skewSeconds = 120) {
  if (!resolved) return true;
  if (!resolved.expiresAt) {
    // No stated expiry: assume a conservative session lifetime rather than
    // pretending a direct CDN URL is permanent.
    return Date.now() - (resolved.resolvedAt || 0) > 3 * 3600 * 1000;
  }
  return Date.now() > resolved.expiresAt - skewSeconds * 1000;
}

/** Re-resolve the same page with the same policy that worked last time. */
async function refreshStream(bin, resolved, opts = {}) {
  if (!resolved || !resolved.webpageUrl) {
    throw new VisionanceError(CODES.STREAM_EXPIRED, {
      message: 'This stream cannot be refreshed because its source page is unknown.'
    });
  }
  return resolveStream(bin, resolved.webpageUrl, {
    ...opts,
    allowAuth: opts.allowAuth !== false && resolved.usedAuth !== 'none'
  });
}

/**
 * Legacy helper kept for callers that only want a sentence.
 * Prefer the structured error object.
 */
function explainError(err) {
  return classifyError(err).userMessage;
}

module.exports = {
  resolveStream,
  refreshStream,
  isExpired,
  capabilities,
  invalidateCapabilities,
  classifyError,
  explainError,
  buildResolveArgs,
  planAttempt,
  parseFlags,
  parseVersionDate,
  detectRuntimeFlag,
  classifyFormat,
  expiryOf,
  pickBest,
  normaliseInfo,
  runYtDlp,
  compareForWatch,
  watchCodecRank,
  SAFE_VCODEC,
  SAFE_ACODEC
};
