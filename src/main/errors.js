'use strict';

/**
 * Structured errors.
 *
 * Every failure that can reach the renderer is normalised into one shape:
 *
 *   { code, message, technicalDetails?, recoverable, suggestedAction? }
 *
 * `message` is written for a human looking at the UI. `technicalDetails` is the
 * raw material for a log line or a bug report and is never required to be
 * readable. Nothing in here is allowed to carry a cookie, a token or an
 * Authorization header - see `redact()`.
 *
 * Deliberately free of any electron import so it can be unit-tested as a plain
 * Node module.
 */

/** Canonical error codes. Keep in sync with docs/architecture.md. */
const CODES = {
  // URL resolution
  UNSUPPORTED_URL: 'UNSUPPORTED_URL',
  VIDEO_UNAVAILABLE: 'VIDEO_UNAVAILABLE',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AGE_RESTRICTED: 'AGE_RESTRICTED',
  REGION_RESTRICTED: 'REGION_RESTRICTED',
  JS_RUNTIME_REQUIRED: 'JS_RUNTIME_REQUIRED',
  COOKIE_FAILURE: 'COOKIE_FAILURE',
  NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
  RATE_LIMITED: 'RATE_LIMITED',
  REMOTE_COMPONENT_REQUIRED: 'REMOTE_COMPONENT_REQUIRED',
  YT_DLP_MISSING: 'YT_DLP_MISSING',
  YT_DLP_OUTDATED: 'YT_DLP_OUTDATED',
  NO_PLAYABLE_FORMAT: 'NO_PLAYABLE_FORMAT',
  LIVE_NOT_SUPPORTED: 'LIVE_NOT_SUPPORTED',
  STREAM_EXPIRED: 'STREAM_EXPIRED',

  // Media analysis
  SOURCE_NOT_FOUND: 'SOURCE_NOT_FOUND',
  FFPROBE_MISSING: 'FFPROBE_MISSING',
  PROBE_FAILED: 'PROBE_FAILED',
  NO_VIDEO_STREAM: 'NO_VIDEO_STREAM',

  // Recipes / jobs
  INVALID_RECIPE: 'INVALID_RECIPE',
  INVALID_REQUEST: 'INVALID_REQUEST',
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION',
  PAUSE_UNSUPPORTED: 'PAUSE_UNSUPPORTED',

  // Rendering
  FFMPEG_MISSING: 'FFMPEG_MISSING',
  ENCODE_FAILED: 'ENCODE_FAILED',
  STAGE_FAILED: 'STAGE_FAILED',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  CANCELLED: 'CANCELLED',
  WORKSPACE_ERROR: 'WORKSPACE_ERROR',

  // Neural engines
  ENGINE_MISSING: 'ENGINE_MISSING',
  ENGINE_BROKEN: 'ENGINE_BROKEN',
  ENGINE_INSTALL_FAILED: 'ENGINE_INSTALL_FAILED',
  ENGINE_UNSUPPORTED: 'ENGINE_UNSUPPORTED',
  MODEL_MISSING: 'MODEL_MISSING',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',
  VULKAN_UNAVAILABLE: 'VULKAN_UNAVAILABLE',
  GPU_OOM: 'GPU_OOM',
  AI_PROCESS_FAILED: 'AI_PROCESS_FAILED',
  INSUFFICIENT_DISK_SPACE: 'INSUFFICIENT_DISK_SPACE',
  DISK_FULL: 'DISK_FULL',
  PERMISSION_DENIED: 'PERMISSION_DENIED',

  UNKNOWN: 'UNKNOWN'
};

/** Default human copy + recoverability per code. */
const DEFAULTS = {
  UNSUPPORTED_URL: {
    message: 'That link is not something Visionance can play.',
    recoverable: false,
    suggestedAction: 'Use the direct page URL of a single video.'
  },
  VIDEO_UNAVAILABLE: {
    message: 'This video is unavailable — it may have been removed or made private.',
    recoverable: false
  },
  AUTH_REQUIRED: {
    message: 'This video needs a signed-in account you already have access to.',
    recoverable: true,
    suggestedAction: 'Settings → Online video → choose an authentication method, then retry.'
  },
  AGE_RESTRICTED: {
    message: 'This video is age-restricted and needs a confirmed account.',
    recoverable: true,
    suggestedAction: 'Settings → Online video → choose an authentication method, then retry.'
  },
  REGION_RESTRICTED: {
    message: 'This video is not available in your region.',
    recoverable: false
  },
  JS_RUNTIME_REQUIRED: {
    message: 'This site needs yt-dlp to run a JavaScript challenge, and no usable JavaScript runtime was found.',
    recoverable: true,
    suggestedAction: 'Install Deno (deno.land) or update yt-dlp, then retry.'
  },
  COOKIE_FAILURE: {
    message: 'Visionance could not read cookies from the selected browser.',
    recoverable: true,
    suggestedAction: 'Close the browser completely, or switch authentication to a cookies.txt file.'
  },
  NETWORK_TIMEOUT: {
    message: 'Timed out while contacting the site.',
    recoverable: true,
    suggestedAction: 'Check your connection and try again.'
  },
  RATE_LIMITED: {
    message: 'The site is temporarily refusing requests from this network (HTTP 429).',
    recoverable: true,
    suggestedAction: 'Wait a few minutes and try again. If it persists, signing in under Settings → Online video usually clears it.'
  },
  REMOTE_COMPONENT_REQUIRED: {
    message: 'yt-dlp needs to fetch an extra JavaScript component to read this site.',
    recoverable: true,
    suggestedAction: 'Settings → Online video → Reinstall yt-dlp; the official build ships the component.'
  },
  YT_DLP_MISSING: {
    message: 'yt-dlp is not installed, so online links cannot be resolved.',
    recoverable: true,
    suggestedAction: 'Settings → Online video → Install.'
  },
  YT_DLP_OUTDATED: {
    message: 'The installed yt-dlp is too old for this site.',
    recoverable: true,
    suggestedAction: 'Settings → Online video → Reinstall to fetch the latest build.'
  },
  NO_PLAYABLE_FORMAT: {
    message: 'No stream in a format this player can decode was offered for that link.',
    recoverable: false
  },
  LIVE_NOT_SUPPORTED: {
    message: 'Live streams cannot be rendered to a file.',
    recoverable: false
  },
  STREAM_EXPIRED: {
    message: 'The stream link expired. Visionance needs to resolve it again.',
    recoverable: true,
    suggestedAction: 'Reload the video.'
  },

  SOURCE_NOT_FOUND: { message: 'That file no longer exists.', recoverable: false },
  FFPROBE_MISSING: {
    message: 'ffprobe was not found, so the source cannot be analysed.',
    recoverable: true,
    suggestedAction: 'Settings → Encoding → Locate ffmpeg/ffprobe.'
  },
  PROBE_FAILED: {
    message: 'This file could not be read as video.',
    recoverable: false,
    suggestedAction: 'It may be corrupt, incomplete, or not a media file.'
  },
  NO_VIDEO_STREAM: { message: 'This file contains no video stream.', recoverable: false },

  INVALID_RECIPE: { message: 'The processing recipe is not valid.', recoverable: false },
  INVALID_REQUEST: { message: 'That request was rejected.', recoverable: false },
  JOB_NOT_FOUND: { message: 'That job no longer exists.', recoverable: false },
  ILLEGAL_TRANSITION: { message: 'That action is not possible in the job\'s current state.', recoverable: false },
  PAUSE_UNSUPPORTED: {
    message: 'This job cannot be paused safely.',
    recoverable: false,
    suggestedAction: 'Cancel it instead, or enable chunked rendering for pausable jobs.'
  },

  FFMPEG_MISSING: {
    message: 'ffmpeg was not found, so nothing can be rendered.',
    recoverable: true,
    suggestedAction: 'Settings → Encoding → Locate ffmpeg.'
  },
  ENCODE_FAILED: { message: 'ffmpeg could not finish this render.', recoverable: true },
  STAGE_FAILED: { message: 'A processing stage failed.', recoverable: true },
  VERIFICATION_FAILED: {
    message: 'The render finished but the output file did not pass verification.',
    recoverable: true,
    suggestedAction: 'Retry the job; if it repeats, try a different encoder.'
  },
  CANCELLED: { message: 'Cancelled.', recoverable: true },
  WORKSPACE_ERROR: { message: 'Visionance could not write to its working folder.', recoverable: true },

  ENGINE_MISSING: {
    message: 'The AI engine this render needs is not installed.',
    recoverable: true,
    suggestedAction: 'Settings → AI engines → Install.'
  },
  ENGINE_BROKEN: {
    message: 'The installed AI engine could not run on this machine.',
    recoverable: true,
    suggestedAction: 'Settings → AI engines → Reinstall. If it keeps failing, your GPU driver may not support Vulkan.'
  },
  ENGINE_INSTALL_FAILED: {
    message: 'The AI engine could not be installed.',
    recoverable: true,
    suggestedAction: 'Check your connection and free disk space, then try again.'
  },
  ENGINE_UNSUPPORTED: {
    message: 'This platform has no supported build of that AI engine.',
    recoverable: false
  },
  MODEL_MISSING: {
    message: 'The AI model this render asks for is not present.',
    recoverable: true,
    suggestedAction: 'Settings → AI engines → Reinstall to restore the bundled models.'
  },
  DOWNLOAD_FAILED: {
    message: 'A download did not finish.',
    recoverable: true,
    suggestedAction: 'Check your connection and try again; Visionance resumes where it stopped.'
  },
  CHECKSUM_MISMATCH: {
    message: 'A download did not match its published checksum and was discarded.',
    recoverable: true,
    suggestedAction: 'Try again. If it repeats, the mirror may be serving a corrupted file.'
  },
  VULKAN_UNAVAILABLE: {
    message: 'No Vulkan-capable GPU was found, so neural processing cannot run.',
    recoverable: false,
    suggestedAction: 'Update your graphics driver. Classical (non-AI) processing still works.'
  },
  GPU_OOM: {
    message: 'The GPU ran out of memory even at the smallest tile size.',
    recoverable: true,
    suggestedAction: 'Lower the output resolution, or set a smaller tile size under Advanced.'
  },
  AI_PROCESS_FAILED: {
    message: 'The AI engine stopped unexpectedly.',
    recoverable: true
  },
  INSUFFICIENT_DISK_SPACE: {
    message: 'There is not enough free disk space for this render.',
    recoverable: true,
    suggestedAction: 'Free some space, or render at a lower resolution or frame rate.'
  },
  DISK_FULL: {
    message: 'The disk filled up during the render.',
    recoverable: true,
    suggestedAction: 'Free some space and retry the job.'
  },
  PERMISSION_DENIED: {
    message: 'Visionance was not allowed to write where it needed to.',
    recoverable: true,
    suggestedAction: 'Choose a different output folder, or run without a restrictive antivirus lock.'
  },

  UNKNOWN: { message: 'Something went wrong.', recoverable: true }
};

/** Header / argument names whose values must never reach a log or the UI. */
const SECRET_KEYS = /^(cookie|cookies|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token|x-goog-visitor-id|x-youtube-identity-token)$/i;

/** Command-line flags whose *value* is sensitive. */
const SECRET_FLAGS = new Set([
  '--cookies',
  '--cookies-from-browser',
  '--username',
  '--password',
  '--video-password',
  '--ap-username',
  '--ap-password',
  '--proxy',
  '--add-header'
]);

const REDACTED = '[redacted]';

/** Strip secrets out of a header map before it is logged or returned. */
function redactHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SECRET_KEYS.test(k) ? REDACTED : String(v);
  }
  return out;
}

/** Strip secrets out of an argv array before it is logged. */
function redactArgs(args) {
  const out = [];
  for (let i = 0; i < (args || []).length; i++) {
    const a = String(args[i]);
    out.push(a);
    if (SECRET_FLAGS.has(a) && i + 1 < args.length) {
      out.push(REDACTED);
      i++;
    }
  }
  return out;
}

/** Best-effort scrub of free text (stderr, messages) before logging. */
function redact(text) {
  if (text == null) return '';
  let s = String(text);
  // Query-string credentials that show up in CDN URLs.
  s = s.replace(/([?&](?:signature|sig|token|key|pot|auth|Policy|Signature|Key-Pair-Id)=)[^&\s"']+/gi, `$1${REDACTED}`);
  // "Cookie: ..." style lines.
  s = s.replace(/^(\s*(?:set-)?cookie\s*:).*/gim, `$1 ${REDACTED}`);
  s = s.replace(/^(\s*authorization\s*:).*/gim, `$1 ${REDACTED}`);
  return s;
}

/**
 * A failure with a stable machine-readable code.
 * `toJSON()` is what crosses the IPC boundary.
 */
class VisionanceError extends Error {
  /**
   * @param {string} code    one of CODES
   * @param {object} [opts]  { message, technicalDetails, recoverable, suggestedAction, cause }
   */
  constructor(code, opts = {}) {
    const known = DEFAULTS[code] || DEFAULTS.UNKNOWN;
    super(opts.message || known.message);
    this.name = 'VisionanceError';
    this.code = CODES[code] ? code : CODES.UNKNOWN;
    this.userMessage = opts.message || known.message;
    this.technicalDetails = opts.technicalDetails
      ? redact(opts.technicalDetails).slice(0, 4000)
      : null;
    this.recoverable = typeof opts.recoverable === 'boolean' ? opts.recoverable : !!known.recoverable;
    this.suggestedAction = opts.suggestedAction || known.suggestedAction || null;
    if (opts.cause) this.cause = opts.cause;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.userMessage,
      technicalDetails: this.technicalDetails,
      recoverable: this.recoverable,
      suggestedAction: this.suggestedAction
    };
  }
}

/** Coerce anything thrown into the structured shape. */
function toStructured(err, fallbackCode = CODES.UNKNOWN) {
  if (err instanceof VisionanceError) return err.toJSON();
  if (err && typeof err === 'object' && err.code && CODES[err.code] && err.message) {
    return new VisionanceError(err.code, {
      message: err.message,
      technicalDetails: err.technicalDetails,
      recoverable: err.recoverable,
      suggestedAction: err.suggestedAction
    }).toJSON();
  }
  return new VisionanceError(fallbackCode, {
    technicalDetails: err && err.stack ? err.stack : String(err && err.message ? err.message : err)
  }).toJSON();
}

module.exports = {
  CODES,
  DEFAULTS,
  VisionanceError,
  toStructured,
  redact,
  redactHeaders,
  redactArgs
};
