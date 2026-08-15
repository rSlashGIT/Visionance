'use strict';

/**
 * Auto: turn a source analysis into a processing recipe.
 *
 * The hard part of "Auto" is not deciding to enhance. It is deciding *not* to.
 * A clean 1080p24 cinematic master needs almost nothing done to it, and running
 * a 4x super-resolution network plus 60 fps interpolation over it would take
 * hours, cost quality, and change the character of the film. So the rules here
 * are deliberately conservative, and every one of them produces a sentence
 * explaining itself.
 *
 * Nothing in here assumes:
 *   4x > 2x        - upscaling beyond the display is wasted work
 *   60 > 24        - authored cadence is a creative choice, not a defect
 *   sharper > soft - oversharpening is the most common amateur tell
 *   more saturated > less
 *
 * Auto only ever *proposes*. The result is an ordinary recipe the user can edit,
 * and the UI tracks whether it is still Auto, Modified or fully Custom.
 */

const recipes = require('./recipe');
// Rates and thresholds only. Sharing the queue's own numbers is what stops Auto
// and the queue from describing the same job differently; `pipeline` reaches no
// further than `recipe`, which this module already depends on, so there is no
// cycle to worry about.
const pipeline = require('./jobs/pipeline');

/** Creator-facing content profiles. */
const PROFILES = {
  auto: { id: 'auto', label: 'Auto / General' },
  film: { id: 'film', label: 'Film / Cinematic' },
  action: { id: 'action', label: 'Action / Sports' },
  gaming: { id: 'gaming', label: 'Gaming' },
  animation: { id: 'animation', label: 'Animation / Anime' },
  dialogue: { id: 'dialogue', label: 'Dialogue / Podcast' },
  lowlight: { id: 'lowlight', label: 'Low Light' },
  screencast: { id: 'screencast', label: 'Screencast / Text' }
};

/** How willing Auto is to spend time. */
const INTENSITIES = ['light', 'balanced', 'strong', 'maximum', 'custom'];

/** Roughly how long a job will take, without inventing an ETA. */
const COST = ['fast', 'moderate', 'heavy', 'very-heavy'];

/**
 * Bitrate thresholds, in bits per second per megapixel, normalised to 30 fps.
 *
 * Calibrated against what real encodes look like: a healthy 1080p30 upload sits
 * around 8 Mbps, which is ~3.9 Mbps per megapixel; a good 720p30 around 4 Mbps,
 * or ~4.3 per megapixel. Below roughly 1.2 there is visible blocking.
 */
const BITRATE_POOR = 1.2e6;
const BITRATE_COMPRESSED = 2.6e6;

function megapixels(w, h) {
  return (Number(w) || 0) * (Number(h) || 0) / 1e6;
}

/**
 * How far a codec stretches a bitrate, relative to H.264.
 *
 * The thresholds above were calibrated against H.264, which is the right
 * reference for a camera file and the wrong one for anything a streaming site
 * delivers. A 1440p60 VP9 rendition at 6 Mbps measures 0.8 Mbps per megapixel
 * and was therefore classified "heavily compressed" - so Auto reached for
 * restoration and a neural pass on a perfectly healthy stream, which on a
 * ten-minute source is the difference between minutes and days.
 *
 * These are deliberately conservative: the published efficiency gains for VP9
 * and HEVC over H.264 are usually quoted around 40-50%, and AV1 higher again.
 * Under-crediting a modern codec costs a little unnecessary cleanup;
 * over-crediting it means missing real damage, so the numbers sit at the low
 * end of what is claimed for them.
 */
const CODEC_EFFICIENCY = [
  [/^(av01|av1)/, 2],
  [/^(vp0?9|vp9)/, 1.6],
  [/^(hevc|h\.?265|hvc1|hev1)/, 1.6],
  [/^(vp0?8|vp8)/, 0.9],
  [/^(h\.?264|avc)/, 1],
  [/^(mpeg-?4|msmpeg|divx|xvid)/, 0.7],
  [/^(mpeg-?2|h\.?263|wmv)/, 0.55]
];

function codecEfficiency(codec) {
  const c = String(codec || '').toLowerCase().trim();
  if (!c) return 1;
  for (const [pattern, factor] of CODEC_EFFICIENCY) {
    if (pattern.test(c)) return factor;
  }
  return 1;
}

/**
 * Is this source visibly compressed?
 * Only answerable when we actually know the bitrate; unknown stays unknown
 * rather than becoming a guess that triggers hours of processing.
 */
function assessQuality(analysis) {
  const v = analysis.video || {};
  const d = analysis.derived || {};
  const bitrate = (v.bitrate || analysis.container.bitrate || 0);
  const mpx = megapixels(d.displayWidth || v.width, d.displayHeight || v.height);
  const fps = v.nominalFps || 30;

  if (!bitrate || !mpx) {
    return { known: false, level: 'unknown', bitsPerMpxPerS: null };
  }
  // Normalise to 30 fps: 60 fps needs roughly twice the bitrate for the same
  // per-frame quality, so it should not be judged as though it were 30. And
  // normalise to H.264, because that is what the thresholds describe.
  const efficiency = codecEfficiency(v.codec);
  const perMpxPerS = (bitrate * efficiency) / mpx / (fps / 30);
  let level;
  if (perMpxPerS < BITRATE_POOR) level = 'poor';
  else if (perMpxPerS < BITRATE_COMPRESSED) level = 'compressed';
  else level = 'clean';
  return {
    known: true,
    level,
    bitsPerMpxPerS: Math.round(perMpxPerS),
    codec: v.codec || null,
    codecEfficiency: efficiency
  };
}

/** Cinematic rates that should be left alone unless asked otherwise. */
function isCinematicRate(fps) {
  return fps > 0 && fps < 26;
}

/**
 * Infer a content profile, but only from things the file actually tells us.
 * Bitrate does not reveal genre, and pretending otherwise produces confident
 * nonsense - so `auto` mostly stays `auto`.
 */
function inferProfile(analysis, requested) {
  if (requested && requested !== 'auto' && PROFILES[requested]) {
    return { profile: requested, inferred: false, why: 'you chose it' };
  }
  const d = analysis.derived || {};
  const v = analysis.video || {};

  // A very high frame rate with a game-typical resolution is weak evidence at
  // best; the honest default is the general profile.
  if (d.isVertical) {
    return { profile: 'auto', inferred: true, why: 'vertical source; using the general profile' };
  }
  if (isCinematicRate(v.nominalFps) && (d.resolutionClass === '1080p' || d.resolutionClass === '4K')) {
    return {
      profile: 'film',
      inferred: true,
      why: `${v.nominalFps} fps at ${d.resolutionClass} looks like authored film`
    };
  }
  return { profile: 'auto', inferred: true, why: 'no reliable signal; using the general profile' };
}

/* ------------------------------------------------------------------ *
 * Per-profile policy
 * ------------------------------------------------------------------ */

const POLICY = {
  auto: { restoreBias: 1, grade: 'neutral', allowInterpolation: false, sharpen: 0.18 },
  film: { restoreBias: 0.5, grade: 'cinematic', allowInterpolation: false, sharpen: 0.1 },
  action: { restoreBias: 1, grade: 'punchy', allowInterpolation: true, sharpen: 0.24 },
  gaming: { restoreBias: 0.8, grade: 'punchy', allowInterpolation: true, sharpen: 0.24 },
  animation: { restoreBias: 1.1, grade: 'neutral', allowInterpolation: false, sharpen: 0.14 },
  dialogue: { restoreBias: 0.9, grade: 'neutral', allowInterpolation: false, sharpen: 0.14 },
  lowlight: { restoreBias: 1.4, grade: 'lift', allowInterpolation: false, sharpen: 0.12 },
  screencast: { restoreBias: 0.4, grade: 'flat', allowInterpolation: false, sharpen: 0.3 }
};

const INTENSITY_FACTOR = { light: 0.55, balanced: 1, strong: 1.4, maximum: 1.8, custom: 1 };

/**
 * How much of a shape change Auto will hand to an anamorphic stretch instead of
 * the crop.
 *
 * Deliberately small. Broadcast practice puts the point where a viewer starts
 * to notice a horizontal stretch at around 5%, and faces are the first thing to
 * give it away. At 3% nothing reads as distorted, and on a 16:9 -> 21:9
 * conversion it hands back about three percent of the picture height a pure
 * crop would have discarded. Closing that gap by stretch alone would need 33%,
 * and splitting it evenly would still need 15%, so neither is on offer: the
 * crop takes whatever the tolerance does not.
 */
const AUTO_STRETCH_TOLERANCE = 0.03;

/* ------------------------------------------------------------------ *
 * User locks
 *
 * The handful of choices a normal user actually makes - where it is going,
 * what shape it is, how big, how fast - are *constraints*, not suggestions.
 * Auto configures everything else around them. When one of them cannot be met
 * truthfully, it is recorded in `unmet` and explained; it is never quietly
 * swapped for something cheaper, because "I asked for 60 and got 30" is the
 * single fastest way to stop trusting an automatic mode.
 * ------------------------------------------------------------------ */

/** Coerce whatever the UI sent into locks this module will actually honour. */
function normaliseLocks(locks) {
  const L = (locks && typeof locks === 'object') ? locks : {};
  const aspect = typeof L.aspect === 'string' &&
    Object.prototype.hasOwnProperty.call(recipes.CANVASES, L.aspect)
    ? L.aspect
    : null;
  const w = Number(L.width);
  const h = Number(L.height);
  const fps = Number(L.fps);
  return {
    aspect,
    aspectW: Number(L.aspectW) > 0 ? Math.round(Number(L.aspectW)) : null,
    aspectH: Number(L.aspectH) > 0 ? Math.round(Number(L.aspectH)) : null,
    // `resolution: 'source'` is an explicit choice ("keep the source size"),
    // which is not the same as saying nothing at all.
    resolution: L.resolution === 'source' ? 'source' : (w > 0 && h > 0 ? 'custom' : null),
    width: w > 0 ? evenDim(w) : null,
    height: h > 0 ? evenDim(h) : null,
    fps: Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : null,
    /** Present only so the caller can see what Auto believed it was given. */
    platform: typeof L.platform === 'string' ? L.platform : null
  };
}

function evenDim(v) {
  const n = Math.max(16, Math.round(Number(v) || 0));
  return n % 2 === 0 ? n : n + 1;
}

/**
 * Turn platform + locks into the one geometry/cadence contract the rest of the
 * engine works against.
 *
 * With no locks this resolves to exactly what the platform alone used to
 * produce, which is why the existing Auto path is unchanged by any of this.
 */
function resolveConstraints({ platformDef, locks }) {
  const L = normaliseLocks(locks);

  let canvas = 'source';
  if (L.aspect) canvas = L.aspect;
  else if (platformDef.canvas && platformDef.canvas !== 'source') canvas = platformDef.canvas;

  let width = null;
  let height = null;
  if (L.resolution === 'custom') {
    width = L.width;
    height = L.height;
  } else if (L.resolution === 'source') {
    // Explicitly "same as source": framing may still reshape the picture, but
    // nothing here asks for a different pixel count.
    width = null;
    height = null;
  } else if (platformDef.width && platformDef.height &&
             (!L.aspect || L.aspect === platformDef.canvas)) {
    width = platformDef.width;
    height = platformDef.height;
  } else if (canvas !== 'source') {
    const suggested = recipes.suggestedResolution(canvas, { aspectW: L.aspectW, aspectH: L.aspectH });
    if (suggested) {
      width = suggested.width;
      height = suggested.height;
    }
  }

  const label = L.aspect && L.aspect !== 'source'
    ? (L.aspect === 'custom' && L.aspectW && L.aspectH ? `${L.aspectW}:${L.aspectH}` : L.aspect)
    : (platformDef.id !== 'custom' ? platformDef.label : (canvas !== 'source' ? canvas : 'Source shape'));

  return {
    canvas,
    aspectW: L.aspectW,
    aspectH: L.aspectH,
    width,
    height,
    fps: L.fps,
    label,
    locked: {
      aspect: !!L.aspect,
      resolution: L.resolution !== null,
      fps: L.fps !== null,
      platform: !!L.platform
    },
    locks: L
  };
}

/* ------------------------------------------------------------------ *
 * The engine
 * ------------------------------------------------------------------ */

/**
 * @param {object} o
 *   analysis    {object}  required
 *   platform    {string}  recipe platform id
 *   profile     {string}  content profile or 'auto'
 *   intensity   {'light'|'balanced'|'strong'|'maximum'}
 *   engines     {{realesrgan:boolean, rife:boolean, reframe:boolean}} availability
 *   locks       {object}  user-facing constraints; see normaliseLocks()
 *   machine     {object}  {gpuTier, vramBytes, cores} - only ever reduces work
 *   outputPath  {string}
 *   preferences {object}  raw overrides applied last
 * @returns {{recipe, explanations:string[], warnings:string[], unmet:object[],
 *            cost:string, profile:string, decisions:object}}
 */
function buildAutoRecipe({
  analysis,
  platform = 'custom',
  profile: requestedProfile = 'auto',
  intensity = 'balanced',
  engines = {},
  locks = null,
  machine = null,
  outputPath = null,
  preferences = {}
} = {}) {
  if (!analysis) throw new Error('Auto needs a source analysis.');

  const explanations = [];
  const warnings = [];
  /**
   * Requests Auto could not meet. Each one names the setting, what was asked
   * for, why it could not happen, and what the user can do about it.
   */
  const unmet = [];
  const cannot = (setting, requested, reason, action = null) => {
    unmet.push({ setting, requested, reason, action });
    warnings.push(action ? `${reason} ${action}` : reason);
  };
  const v = analysis.video || {};
  const d = analysis.derived || {};

  const inferred = inferProfile(analysis, requestedProfile);
  const profile = inferred.profile;
  const policy = POLICY[profile] || POLICY.auto;
  const factor = INTENSITY_FACTOR[intensity] || 1;

  const quality = assessQuality(analysis);
  const srcW = d.displayWidth || v.width || 0;
  const srcH = d.displayHeight || v.height || 0;
  const srcFps = v.nominalFps || 0;
  /**
   * How to name this source's size in a sentence.
   *
   * The resolution class is measured off the long and short edges, so a
   * 720x1280 phone video is "720p" rather than "1280p" - which is what naming
   * a source by its height alone produces for anything vertical, and it reads
   * as a claim the file is four times the size it is.
   */
  const srcLabel = d.resolutionClass || (srcH ? `${srcH}p` : 'the source');
  const platformDef = recipes.PLATFORMS[platform] || recipes.PLATFORMS.custom;

  if (inferred.inferred && profile !== 'auto') {
    explanations.push(`Profile: ${PROFILES[profile].label} — ${inferred.why}.`);
  }

  /* ---------------- restoration ---------------- */
  const restore = { enabled: false, denoise: 0, deblock: 0, deband: 0, grain: 0 };
  if (quality.level === 'poor') {
    restore.enabled = true;
    restore.denoise = clamp(0.22 * policy.restoreBias * factor, 0, 0.6);
    restore.deblock = clamp(0.45 * policy.restoreBias * factor, 0, 0.8);
    restore.deband = clamp(0.35 * factor, 0, 0.7);
    explanations.push('Low source bitrate for this resolution — compression cleanup enabled.');
  } else if (quality.level === 'compressed') {
    restore.enabled = true;
    restore.denoise = clamp(0.1 * policy.restoreBias * factor, 0, 0.4);
    restore.deblock = clamp(0.2 * policy.restoreBias * factor, 0, 0.5);
    restore.deband = clamp(0.2 * factor, 0, 0.5);
    explanations.push('Moderately compressed source — light restoration enabled.');
  } else if (quality.level === 'clean') {
    explanations.push('Source is already clean — restoration left off.');
  } else {
    warnings.push('The source bitrate is unknown, so restoration was left off rather than guessed at.');
  }
  if (profile === 'screencast' && restore.enabled) {
    restore.denoise = Math.min(restore.denoise, 0.08);
    restore.grain = 0;
    explanations.push('Screencast: denoise kept minimal so text and UI edges stay crisp.');
  }

  /* ---------------- geometry ----------------
   *
   * The user's shape and size, if they gave one, are the contract. The
   * platform only fills in whatever they did not answer.
   */
  const constraints = resolveConstraints({ platformDef, locks });
  const wantsCanvas = constraints.canvas !== 'source';
  const targetW = constraints.width || srcW;
  const targetH = constraints.height || srcH;

  /*
   * Whether the picture will be cropped, decided once and used twice.
   *
   * How far the picture has to be *enlarged* is not the ratio of the output
   * height to the source height - it depends on what survives the crop. A
   * 2560x1440 source going to 1080x1920 keeps its full height and loses most
   * of its width, so it is enlarged 1.33x, not the 2x that comparing the raw
   * dimensions suggests. Getting this wrong is how a healthy stream ends up
   * being run through a super-resolution network it does not need.
   *
   * Screencasts are excluded here for the same reason they are excluded from
   * Smart Reframe below: the whole frame is the content.
   */
  const srcRatio = srcW && srcH ? srcW / srcH : 1;
  /*
   * A canvas without an explicit size still has a shape, and that shape is
   * what decides whether the picture is reframed. Taking the ratio from the
   * dimensions alone would read "9:16 at the source size" as no change at all
   * - and, where a resolution disagrees with the ratio, would read the shape
   * off the pair `resolveOutputGeometry()` is about to conform away.
   */
  const canvasRatio = wantsCanvas
    ? recipes.aspectRatioOf(constraints.canvas,
      { aspectW: constraints.aspectW, aspectH: constraints.aspectH })
    : null;
  const targetRatio = canvasRatio ||
    ((constraints.width && constraints.height) ? constraints.width / constraints.height : srcRatio);
  const reshapes = wantsCanvas && Math.abs(srcRatio - targetRatio) > 0.02;
  const sourceIsWider = srcRatio > targetRatio;
  const trackable = profile !== 'screencast';
  /*
   * This used to require `sourceIsWider` as well - that is, it only considered
   * cropping when the *target* was the narrower shape. For 16:9 into 21:9 the
   * target is the wider one, so the test was false, framing fell through to
   * `fit`, and a 1920x1080 picture was pillarboxed inside a 2560x1080 canvas:
   * an ultrawide container around a 16:9 picture, which is not an ultrawide
   * conversion at all. Cropping to fill is the right answer in both
   * directions; only the axis differs.
   */
  const willCrop = reshapes && trackable;
  /** The linear factor the picture is scaled by, after any crop. */
  const climb = (!srcW || !srcH || !targetW || !targetH)
    ? 1
    : willCrop
      ? (sourceIsWider ? targetH / srcH : targetW / srcW)
      // A fit scales the whole frame inside the canvas, so the limiting axis
      // decides.
      : Math.min(targetW / srcW, targetH / srcH);

  /* ---------------- neural reconstruction ---------------- */
  const reconstruction = {
    enabled: false,
    mode: 'classical',
    aiMode: 'upscale',
    aiScale: 2,
    model: profile === 'animation' ? 'animation' : 'general',
    targetResolution: (constraints.width && constraints.height)
      ? { mode: 'custom', width: constraints.width, height: constraints.height }
      : { mode: 'source' }
  };

  const needsMorePixels = climb > 1.2;
  const downscales = climb < 0.9;
  const damaged = quality.level === 'poor' || quality.level === 'compressed';

  if (!engines.realesrgan) {
    if (needsMorePixels || damaged) {
      cannot(
        'enhancement',
        needsMorePixels ? `neural reconstruction to ${targetW}×${targetH}` : 'neural cleanup',
        'Real-ESRGAN is not installed, so neural reconstruction was not used.',
        needsMorePixels
          ? 'The picture is resampled classically instead — install Real-ESRGAN to rebuild detail.'
          : 'Install Real-ESRGAN under Settings → AI engines to rebuild detail.'
      );
    }
    if (needsMorePixels) {
      reconstruction.enabled = true;
      reconstruction.mode = 'classical';
      explanations.push(`Scaling ${srcLabel} to ${targetW}×${targetH} with classical resampling.`);
    }
  } else if (needsMorePixels && damaged) {
    reconstruction.enabled = true;
    reconstruction.mode = 'neural';
    reconstruction.aiMode = 'upscale';
    reconstruction.aiScale = climb > 2.5 ? 4 : 2;
    explanations.push(
      `${srcLabel} source is compressed and the output is ${targetW}×${targetH} — ` +
      `neural ${reconstruction.aiScale}x reconstruction enabled.`
    );
  } else if (damaged && intensity !== 'light' && quality.level === 'poor') {
    reconstruction.enabled = true;
    reconstruction.mode = 'neural';
    reconstruction.aiMode = 'restore';
    reconstruction.aiScale = 1;
    explanations.push('Heavily compressed source — neural restore at the same resolution.');
  } else if (needsMorePixels) {
    // More pixels wanted, but the source is clean: a good resampler is the
    // right tool. A network here mostly invents texture that was not filmed.
    reconstruction.enabled = true;
    reconstruction.mode = 'classical';
    explanations.push(
      `${srcLabel} source is clean — scaled to ${targetW}×${targetH} with classical ` +
      'resampling rather than a network, which would invent detail.'
    );
  } else if (downscales) {
    // Fewer pixels than the source. Running a super-resolution network and
    // then throwing the result away is pure cost, so it does not happen.
    reconstruction.enabled = true;
    reconstruction.mode = 'classical';
    explanations.push(
      `${srcLabel} source down to ${targetW}×${targetH} — downscaled cleanly. Neural upscaling ` +
      'would be discarded by the resize, so it is not used.'
    );
  } else {
    explanations.push(`Output stays at ${srcLabel} — no upscaling needed.`);
    // A locked size that matches the source still has to be *reached*, so the
    // resize stays in the graph even though nothing is being rebuilt.
    if (constraints.width && constraints.height &&
        (constraints.width !== srcW || constraints.height !== srcH)) {
      reconstruction.enabled = true;
      reconstruction.mode = 'classical';
    }
  }

  if (reconstruction.mode === 'neural' && intensity === 'maximum' &&
      reconstruction.aiMode === 'upscale' && reconstruction.aiScale === 2 &&
      targetH > srcH * 1.9) {
    // Maximum is allowed to spend more, but still not to do pointless work.
    explanations.push('Maximum intensity: neural scale kept at 2x, which already exceeds the target.');
  }

  /* ---------------- how much inference to spend ----------------
   *
   * Scale and inference quality are separate decisions, and Auto has to make
   * the second one too. Left at the old default, a 2x request on general
   * footage ran the 4x network over every source pixel and resampled down -
   * measured at 12.66 s per 720p frame on the reference GPU, which is roughly
   * 53 minutes for a ten-second clip. That is not a default; that is a
   * surprise.
   */
  if (reconstruction.mode === 'neural') {
    reconstruction.aiQuality = neuralQualityFor({
      intensity, climb, srcH, targetH, quality, profile
    });

    /*
     * Machine reality, applied last and in one direction only.
     *
     * This may reduce what Auto asks for; it may never raise it. A modest GPU
     * running the expensive inference path on a long source is how a "sensible
     * default" becomes an overnight render, and the reference machine for this
     * project is exactly that GPU.
     */
    const capped = capForMachine({
      quality: reconstruction.aiQuality,
      intensity,
      machine,
      durationSeconds: d.durationSeconds || 0,
      outPixels: (targetW || srcW || 1920) * (targetH || srcH || 1080)
    });
    if (capped.quality !== reconstruction.aiQuality) {
      reconstruction.aiQuality = capped.quality;
      explanations.push(capped.why);
    }

    const q = reconstruction.aiQuality;
    if (q === 'maximum') {
      explanations.push(
        'Maximum intensity: neural reconstruction runs at the model\'s largest scale over every ' +
        'source pixel. This is the slowest path and is being chosen deliberately.'
      );
    } else if (q === 'quality') {
      explanations.push('Damaged source: inference runs on full-size frames for the most detail the model can use.');
    } else if (q === 'balanced') {
      explanations.push(
        'Inference quality set to Balanced — the network reaches the requested scale without ' +
        'processing four times the pixels it needs to.'
      );
    } else {
      explanations.push('Inference quality set to Fast to keep the render proportionate to the source.');
    }
  }

  /* ---------------- motion ---------------- */
  const motion = {
    enabled: false,
    targetFps: null,
    interpolation: 'none',
    sceneCutProtection: true,
    model: 'auto'
  };
  let outputFps = null;
  /** Set when RIFE was available and Auto chose the cheaper path anyway. */
  let interpolationDeclined = false;

  const platformMaxFps = platformDef.maxFps || null;

  if (constraints.fps) {
    /*
     * A locked frame rate is the user's answer, and Auto's job is to reach it
     * honestly.
     *
     *   asked for more frames than exist -> only RIFE can invent them
     *   asked for fewer                  -> a plain rate conversion is enough
     *   asked for what is already there  -> nothing to do
     *
     * Frame duplication is never described as interpolation: it is what
     * happens when the honest answer is unavailable, and it is labelled as
     * such in `unmet` so the UI can offer the install.
     */
    const wanted = constraints.fps;
    outputFps = wanted;
    motion.targetFps = wanted;

    if (!srcFps) {
      motion.enabled = true;
      motion.interpolation = 'none';
      explanations.push(`Output locked to ${wanted} fps; the source cadence could not be measured.`);
    } else if (wanted > srcFps * 1.05) {
      /*
       * More frames than exist, so something has to fill the gaps. Which
       * something depends on how big the gap is.
       *
       * The classical path is ffmpeg's `fps` filter: it repeats frames on a
       * fixed pattern and invents no motion. Going 24 -> 30 that repeats one
       * frame in four, and the result is ordinary 3:2-style judder that most
       * viewers never name. Going 24 -> 60, better than half the output frames
       * do not exist in the source, and repetition is plainly visible.
       *
       * RIFE's cost is charged on every *output* frame, so it is the same
       * price either way - and at a 1.25x change that price buys a correction
       * most people will not see. So a default Balanced run reaches for the
       * network once the cadence change is half again or more, and otherwise
       * takes the cheap truthful path and says the network is available.
       * A deliberate `strong` or `maximum` gets the network at any jump.
       *
       * The lock itself is untouched by all of this: the output is the frame
       * rate that was asked for either way. Only the method changes.
       */
      const jump = wanted / srcFps;
      const bigJump = jump >= 1.5;
      const wantsHeavy = intensity === 'strong' || intensity === 'maximum';
      motion.enabled = true;
      if (engines.rife && (bigJump || wantsHeavy)) {
        motion.interpolation = 'ai';
        explanations.push(
          `${Math.round(srcFps)} fps source to ${wanted} fps is a ${jump.toFixed(2)}x cadence ` +
          'change — RIFE generates the in-between frames. This changes the motion character: ' +
          'smoother, less filmic.'
        );
      } else if (engines.rife) {
        motion.interpolation = 'duplicate';
        interpolationDeclined = true;
        explanations.push(
          `${Math.round(srcFps)} fps to ${wanted} fps is a ${jump.toFixed(2)}x cadence change, ` +
          'reached by repeating frames on a fixed pattern. No motion is invented. RIFE could ' +
          'generate the in-between frames instead, at a cost charged on every output frame; ' +
          'raise the Auto intensity, or choose AI interpolation under Advanced → Motion.'
        );
      } else {
        motion.interpolation = 'duplicate';
        cannot(
          'fps',
          `${wanted} fps`,
          `${wanted} fps needs RIFE to generate new frames, and RIFE is not installed.`,
          'Frames will be duplicated to reach the rate — that is not interpolation. ' +
          'Install RIFE under Settings → AI engines for genuinely new frames.'
        );
      }
    } else if (wanted < srcFps * 0.95) {
      motion.enabled = true;
      motion.interpolation = 'none';
      explanations.push(
        `${Math.round(srcFps)} fps source to ${wanted} fps — a straight rate conversion. ` +
        'No frames are invented, so no interpolation is needed.'
      );
    } else {
      motion.enabled = false;
      motion.interpolation = 'none';
      explanations.push(`Output stays at ${wanted} fps, the source's own cadence.`);
    }
    if (platformMaxFps && wanted > platformMaxFps) {
      warnings.push(
        `${platformDef.label} documents a ${platformMaxFps} fps maximum; ${wanted} fps was ` +
        'kept because you asked for it, but the platform may re-encode it.'
      );
    }
  } else if (isCinematicRate(srcFps)) {
    explanations.push(`${srcFps} fps cinematic source — original frame rate preserved.`);
  } else if (srcFps >= 50) {
    explanations.push(`Source is already ${Math.round(srcFps)} fps — no interpolation needed.`);
  } else if (policy.allowInterpolation && engines.rife && intensity !== 'light') {
    motion.enabled = true;
    motion.interpolation = 'ai';
    motion.targetFps = 60;
    outputFps = 60;
    explanations.push(
      `${PROFILES[profile].label}: AI interpolation to 60 fps. ` +
      'This changes the motion character — smoother, but less filmic.'
    );
  } else if (policy.allowInterpolation && !engines.rife) {
    warnings.push('RIFE is not installed, so the frame rate was left alone rather than duplicating frames.');
  }
  if (!constraints.fps && platformMaxFps && outputFps && outputFps > platformMaxFps) {
    outputFps = platformMaxFps;
    motion.targetFps = platformMaxFps;
  }

  /* ---------------- framing ---------------- */
  const framing = { enabled: false, canvas: 'source', mode: 'fit', background: 'blur', tracking: 'none' };
  if (wantsCanvas) {
    framing.enabled = true;
    framing.canvas = constraints.canvas;
    framing.width = constraints.width;
    framing.height = constraints.height;
    if (constraints.canvas === 'custom') {
      framing.aspectW = constraints.aspectW;
      framing.aspectH = constraints.aspectH;
    }
    const where = constraints.label;
    /*
     * Choosing a shape is choosing to *see* the picture in that shape.
     *
     * The old rule was "crop if the source is wider, otherwise fit", which
     * meant half of all conversions silently produced bars. Auto now fills the
     * canvas whenever the shape changes, and the remaining question is only
     * how the picture is placed inside it. A deliberate Fit is still available
     * from the Framing control, and is still what Auto chooses for content
     * where the edges of the frame *are* the content.
     *
     * `trackable` and `sourceIsWider` were decided above, because how far the
     * picture has to be enlarged depends on whether it is about to be cropped.
     */
    if (!reshapes) {
      framing.mode = 'fit';
      framing.tracking = 'none';
      // Name the shape. "Source fits the canvas without cropping" is true and
      // uninformative when the size class already implied a different shape -
      // see the note in summarise() about 2560x1080 reporting as "1440p".
      explanations.push(
        `${where}: the source is already ${recipes.describeAspectRatio(srcRatio) || 'this shape'}, ` +
        'so it fits the canvas without cropping or padding.'
      );
    } else if (!trackable) {
      // Fit rather than crop: on a screencast the edges of the frame are
      // content, and cropping them away loses the thing being demonstrated.
      framing.mode = 'fit';
      framing.tracking = 'center';
      framing.background = 'black';
      explanations.push(
        `${where}: this is synthetic screen content, so the whole frame is kept and ` +
        'letterboxed rather than tracked — a crop would cut off part of the screen.'
      );
    } else {
      framing.mode = 'fill';
      // A little anamorphic give, so the crop does not have to absorb the whole
      // shape change on its own. See AUTO_STRETCH_TOLERANCE for why it is this
      // small and no smaller.
      framing.stretchTolerance = AUTO_STRETCH_TOLERANCE;

      if (!sourceIsWider) {
        /*
         * The canvas is the wider shape, so the trim is vertical - and the
         * tracker measures a horizontal position and nothing else. Putting a
         * Smart Reframe label on a crop the tracker cannot steer would be the
         * same class of claim as promising face detection with no models
         * installed, so this is a centred vertical crop and says so.
         */
        framing.tracking = 'center';
        explanations.push(
          `${where}: the canvas is wider than the source, so the picture is cropped top and ` +
          'bottom to fill it rather than floated between bars. The crop is centred — subject ' +
          'tracking follows a horizontal position, which a vertical trim cannot use.'
        );
      } else if (engines.reframe) {
        framing.tracking = 'auto';
        // Say which backend will actually run. Promising face tracking on a
        // machine with no models installed is the kind of small lie the
        // telemetry work exists to prevent.
        const semanticProfiles = ['film', 'dialogue', 'action', 'auto', 'lowlight'];
        const semanticWanted = engines.semanticReframe && semanticProfiles.includes(profile);
        if (semanticWanted) {
          explanations.push(
            `${where}: Smart Reframe enabled with face and person tracking, ` +
            'so a subject who is standing still is not lost to a busy background.'
          );
        } else if (engines.semanticReframe && profile === 'gaming') {
          // A webcam face is not the subject of a gameplay clip.
          explanations.push(
            `${where}: Smart Reframe enabled following the game action; ` +
            'face tracking is available but is not assumed to be the subject here.'
          );
        } else {
          explanations.push(
            `${where}: Smart Reframe enabled so the subject stays in the ${constraints.canvas} crop.`
          );
          if (!engines.semanticReframe) {
            explanations.push(
              'Face and person detection is not installed, so tracking follows motion and detail.'
            );
          }
        }
      } else {
        framing.tracking = 'center';
        cannot(
          'framing',
          'Smart Reframe',
          'Subject tracking is unavailable, so the crop is centred.',
          'The picture still fills the canvas; only the crop position is fixed rather than tracked.'
        );
      }
    }
  }

  /* ---------------- colour ---------------- */
  const color = buildColor(policy, factor, analysis, explanations, warnings);

  /* ---------------- audio ---------------- */
  const audio = { enabled: d.hasAudio !== false, mode: d.hasAudio === false ? 'none' : 'encode' };
  if (d.hasAudio === false) {
    explanations.push('Source has no audio track.');
  } else if (profile === 'dialogue') {
    audio.master = 'dialogue';
    explanations.push('Dialogue profile — speech-focused mastering with gentle compression.');
  } else if (intensity === 'light') {
    audio.master = 'normalize';
    explanations.push('Audio normalised to a consistent loudness.');
  } else {
    audio.master = 'creator';
    explanations.push('Creator master applied: consistent loudness with a limiter to prevent clipping.');
  }

  /* ---------------- assemble ---------------- */
  const overrides = {
    name: analysis.source && analysis.source.name ? `${analysis.source.name} (auto)` : 'Auto render',
    restore,
    reconstruction,
    motion,
    framing,
    color,
    audio,
    output: {
      platform,
      path: outputPath,
      fps: outputFps,
      quality: intensity === 'light' ? 62 : intensity === 'maximum' ? 82 : 72
    },
    processing: { verify: true }
  };

  const merged = recipes.deepMerge(
    recipes.defaultRecipe(analysis, overrides),
    preferences || {}
  );
  const { recipe, warnings: sanitiseWarnings } = recipes.sanitize(merged);
  warnings.push(...sanitiseWarnings);

  let geometry = recipes.resolveOutputGeometry(recipe, analysis);
  let cost = estimateCost({ recipe, geometry, analysis });

  /* ---------------- proportionality ----------------
   *
   * The last question Auto asks is whether what it just chose is a sensible
   * default *on this job*, and the honest answer is sometimes no.
   *
   * Measured on the reference machine: a six-second 720p clip going to
   * 1080x1920 at 60 fps resolved to x4 inference plus RIFE - about an hour of
   * GPU time for six seconds of video. Every individual decision was
   * defensible; their product was not. `balanced` has to mean balanced.
   *
   * The only knob touched here is the neural scale, and only when lowering it
   * cannot change the output geometry - a lock is never traded for speed. If
   * the job is still very heavy after that, Auto says so plainly rather than
   * quietly declining to do the work the user asked for.
   */
  const defaultIntensity = intensity === 'light' || intensity === 'balanced';

  /** Try a cheaper reconstruction, and keep it only if the output is identical. */
  const tryCheaper = (patch) => {
    const trial = recipes.sanitize({ ...recipe,
      reconstruction: { ...recipe.reconstruction, ...patch } }).recipe;
    const trialGeometry = recipes.resolveOutputGeometry(trial, analysis);
    if (trialGeometry.width !== geometry.width || trialGeometry.height !== geometry.height) {
      return false;
    }
    Object.assign(recipe.reconstruction, patch);
    geometry = trialGeometry;
    cost = estimateCost({ recipe, geometry, analysis });
    return true;
  };

  if (defaultIntensity && cost === 'very-heavy' &&
      recipe.reconstruction.mode === 'neural' && recipe.reconstruction.aiScale === 4 &&
      tryCheaper({ aiScale: 2 })) {
    explanations.push(
      'At 4x this render was very heavy for a Balanced result, so the neural scale is 2x: ' +
      'the output resolution is unchanged, and a quarter of the inference gets most of the ' +
      'way there. Raise the Auto intensity if you want the 4x pass.'
    );
  }

  /*
   * The second step: is the network earning what it costs?
   *
   * A ten-minute 1440p stream reframed to 1080x1920 resolved to 136 hours of
   * inference for a 1.33x enlargement. Long neural renders are not in
   * themselves wrong - an overnight upscale is exactly what the queue is for -
   * but at that little enlargement the network was barely doing the job it was
   * switched on for, and a good resampler lands within touching distance of it.
   *
   * So the test is proportionality, not duration: below a marginal enlargement
   * a very heavy neural pass gives way and says what it would have cost. Above
   * it, the network stays and the cost class speaks for itself, because
   * declining there would visibly damage the result that was asked for.
   */
  const MARGINAL_CLIMB = 1.4;
  let neuralDeclined = false;
  if (defaultIntensity && cost === 'very-heavy' &&
      recipe.reconstruction.mode === 'neural' && climb < MARGINAL_CLIMB) {
    const restores = recipe.reconstruction.aiMode === 'restore';
    const withNetwork = estimateJobSeconds({ recipe, geometry, analysis });
    if (tryCheaper({ mode: 'classical' })) {
      neuralDeclined = true;
      explanations.push(
        `Neural ${restores ? 'restoration' : 'reconstruction'} would have taken about ` +
        `${describeSeconds(withNetwork)} here, ` +
        (restores
          ? 'on a source that is not being enlarged'
          : `for a ${climb.toFixed(2)}x enlargement`) +
        ' — not a Balanced trade. The output is the same size, reached by classical ' +
        'resampling. Raise the Auto intensity to run the network anyway.'
      );
    }
  }

  if (cost === 'very-heavy') {
    warnings.push(
      'This is a very heavy render on hardware like this. The resolution and frame rate you ' +
      'chose are being met; lowering either is what makes it faster.'
    );
  }

  /*
   * The locks are checked against the *resolved* geometry, not against what
   * Auto meant to do. Everything above is intent; this is the only place that
   * knows what the recipe will actually produce, so it is the only honest
   * place to assert that the user got what they asked for.
   */
  if (constraints.locked.resolution && constraints.width && constraints.height &&
      geometry.width && geometry.height &&
      (geometry.width !== constraints.width || geometry.height !== constraints.height)) {
    cannot(
      'resolution',
      `${constraints.width}×${constraints.height}`,
      `The output resolves to ${geometry.width}×${geometry.height}, not the ` +
      `${constraints.width}×${constraints.height} you asked for.`,
      'Set the resolution manually under Advanced → Output.'
    );
  }
  if (constraints.locked.fps && geometry.fps &&
      Math.abs(geometry.fps - constraints.fps) > 0.01) {
    cannot(
      'fps',
      `${constraints.fps} fps`,
      `The output resolves to ${geometry.fps} fps, not the ${constraints.fps} fps you asked for.`,
      'Set the frame rate manually under Advanced → Motion.'
    );
  }

  /*
   * What the framing will actually do, read back off the finished recipe.
   *
   * Everything above is intent. This is the resolved contract the filter graph
   * builds from and the output verifier asserts against, so Auto's account of
   * the framing cannot describe something other than what runs — which is
   * exactly how a summary once said "Fit, blurred background" over a file with
   * solid black bars.
   */
  const framingPlan = recipes.resolveFramingPlan(recipe, geometry);
  if (framingPlan.active && framingPlan.fills) {
    const bits = [];
    const lostAxis = framingPlan.cropAxis;
    const lost = lostAxis === 'x'
      ? Math.round((1 - framingPlan.keepWidth) * 100)
      : lostAxis === 'y' ? Math.round((1 - framingPlan.keepHeight) * 100) : 0;
    if (lost > 0) bits.push(`${lost}% of the ${lostAxis === 'x' ? 'width' : 'height'} is cropped away`);
    if (framingPlan.stretch > 1.0005) {
      bits.push(
        `a ${((framingPlan.stretch - 1) * 100).toFixed(1)}% ` +
        `${framingPlan.stretchAxis === 'x' ? 'horizontal' : 'vertical'} stretch takes the rest`
      );
    }
    if (bits.length) {
      explanations.push(
        `Filling ${geometry.width}×${geometry.height}: ${bits.join('; ')}. ` +
        'The picture reaches every edge of the frame — no bars.'
      );
    }
  } else if (framingPlan.active && !framingPlan.fills) {
    explanations.push(
      `The whole frame is kept, so a ${framingPlan.activeWidth}×${framingPlan.activeHeight} ` +
      `picture sits inside the ${geometry.width}×${geometry.height} canvas with ` +
      `${framingPlan.background === 'blur' ? 'a blurred copy of the frame' : 'black'} ` +
      `${framingPlan.barAxis === 'x' ? 'either side' : 'above and below'}.`
    );
  }

  return {
    recipe,
    explanations,
    warnings,
    unmet,
    cost,
    profile,
    profileInferred: inferred.inferred,
    intensity,
    locks: constraints.locks,
    decisions: {
      sourceQuality: quality,
      needsMorePixels,
      downscales,
      climb: Math.round(climb * 100) / 100,
      /** The network was chosen and then declined as disproportionate. */
      neuralDeclined,
      /** RIFE was available and the cadence change did not warrant it. */
      interpolationDeclined,
      neural: recipe.reconstruction.mode === 'neural',
      neuralQuality: recipe.reconstruction.mode === 'neural' ? recipe.reconstruction.aiQuality : null,
      interpolation: recipe.motion.interpolation,
      tracking: recipe.framing.tracking,
      framingMode: recipe.framing.enabled ? recipe.framing.mode : null,
      /**
       * The resolved framing contract, so the UI and the tests can ask whether
       * the picture fills the frame instead of inferring it from a mode name.
       */
      framing: framingPlan.active ? {
        mode: framingPlan.mode,
        background: framingPlan.background,
        fills: framingPlan.fills,
        cropAxis: framingPlan.cropAxis,
        barAxis: framingPlan.barAxis,
        keepWidth: framingPlan.keepWidth,
        keepHeight: framingPlan.keepHeight,
        stretch: framingPlan.stretch,
        stretchAxis: framingPlan.stretchAxis,
        activeWidth: framingPlan.activeWidth,
        activeHeight: framingPlan.activeHeight
      } : null,
      grade: policy.grade,
      semanticTracking: recipe.framing.tracking === 'auto' && !!engines.semanticReframe,
      audioMaster: recipe.audio.master,
      outputFps: geometry.fps,
      outputResolution: geometry.width && geometry.height
        ? `${geometry.width}x${geometry.height}`
        : null
    }
  };
}

function buildColor(policy, factor, analysis, explanations, warnings) {
  const color = {
    enabled: true,
    contrast: 0,
    brightness: 0,
    saturation: 0,
    gamma: 0,
    sharpen: clamp(policy.sharpen * factor, 0, 0.5),
    toneMap: 'none'
  };

  switch (policy.grade) {
    case 'cinematic':
      color.contrast = 0.06 * factor;
      color.saturation = 0.03 * factor;
      explanations.push('Cinematic finish: restrained contrast, skin tones and highlights left alone.');
      break;
    case 'punchy':
      color.contrast = 0.12 * factor;
      color.saturation = 0.12 * factor;
      explanations.push('Punchy finish for high-motion content.');
      break;
    case 'lift':
      color.gamma = 0.14 * factor;
      color.contrast = 0.04 * factor;
      explanations.push('Low light: shadows lifted without crushing the noise floor.');
      break;
    case 'flat':
      color.contrast = 0.02;
      color.saturation = 0;
      explanations.push('Screencast: colour left essentially untouched.');
      break;
    default:
      color.contrast = 0.05 * factor;
      color.saturation = 0.05 * factor;
      break;
  }

  const d = analysis.derived || {};
  if (d.isHDR) {
    const filters = analysis.__availableFilters;
    const canToneMap = !filters || (filters.zscale && filters.tonemap);
    if (canToneMap) {
      color.toneMap = 'hable';
      explanations.push('HDR source — tone-mapped to SDR with the Hable curve.');
    } else {
      warnings.push(
        'This is an HDR source but this ffmpeg build has no zscale/tonemap filter, ' +
        'so the colours will not be converted correctly.'
      );
    }
  }
  return color;
}

/**
 * Cost class, not an ETA. An ETA before any frames have been processed would be
 * a guess, and on a 4 GB laptop GPU a wrong one is badly misleading.
 */
/**
 * How much inference should Auto spend?
 *
 * The rule is proportionality: the worse the source and the further it has to
 * travel, the more reconstruction is worth paying for. Nothing here reaches
 * for the expensive path on a source that does not need it, and only an
 * explicit `maximum` intensity gets the full-pixel 4x route.
 *
 * @returns {'fast'|'balanced'|'quality'|'maximum'}
 */
function neuralQualityFor({ intensity, climb = null, srcH = 0, targetH = 0, quality = {}, profile = 'auto' }) {
  // The user asked for everything, in as many words.
  if (intensity === 'maximum') return 'maximum';

  // Animation has genuine native 2x weights, so Balanced there is already a
  // real native inference - there is nothing cheaper worth having.
  if (profile === 'animation') return intensity === 'light' ? 'balanced' : 'quality';

  // `climb` is how far the picture is actually enlarged, after any crop. The
  // raw height ratio is accepted for callers that predate it.
  if (!(climb > 0)) climb = srcH > 0 && targetH > 0 ? targetH / srcH : 1;
  const poor = quality.level === 'poor';

  // A badly damaged source climbing a long way is the case full-pixel
  // inference was designed for: there is real damage to repair and little
  // detail to lose.
  if (poor && climb >= 2 && intensity === 'strong') return 'quality';

  if (intensity === 'light') return 'fast';

  // Everything else: reach the scale without paying four times over.
  return 'balanced';
}

/**
 * Machine reality, applied to the inference-quality choice.
 *
 * This function may only ever *reduce* what Auto asked for, and it explains
 * every reduction. The reference development machine is a 4 GB laptop GPU; a
 * default that assumes anything better is a default that produces overnight
 * renders on the hardware this app was actually built on.
 *
 * `maximum` intensity is exempt: the user said so in as many words.
 */
function capForMachine({ quality, intensity, machine, durationSeconds = 0, outPixels = 0 }) {
  if (intensity === 'maximum') return { quality };
  const order = ['fast', 'balanced', 'quality', 'maximum'];
  const reduceTo = (to, why) =>
    (order.indexOf(quality) > order.indexOf(to) ? { quality: to, why } : { quality });

  const tier = machine && machine.gpuTier;
  if (tier === 'integrated' || tier === 'none') {
    return reduceTo('balanced',
      'This machine reports no discrete GPU, so inference quality is held at Balanced — ' +
      'the full-pixel path would take hours here.');
  }
  if (durationSeconds > 600) {
    return reduceTo('balanced',
      `The source runs ${Math.round(durationSeconds / 60)} minutes, so inference quality is held ` +
      'at Balanced rather than multiplying that by the slowest path.');
  }
  if (outPixels >= 3840 * 2160 * 0.9) {
    return reduceTo('balanced',
      'The output is 4K, so inference quality is held at Balanced; full-pixel inference at ' +
      'this size is the slowest path there is.');
  }
  return { quality };
}

/**
 * How long this recipe will take, in seconds.
 *
 * This used to be an arbitrary score with its own thresholds, and it disagreed
 * with the queue's own estimate by more than an order of magnitude: a job the
 * resolved plan measured at an hour came out of here as `moderate`. Auto was
 * then making proportionality decisions against a number that did not describe
 * this machine at all.
 *
 * So it now uses the queue's measured rates and the queue's own thresholds.
 * The one thing it still has to approximate is what the engine planner will
 * choose, because that depends on which models are installed - the rules below
 * mirror `planInference()` for the default catalogue, where the general model
 * has 4x weights only. `pipeline.estimatePlanCost()` remains the authority and
 * supersedes this the moment a plan is resolved; this is the figure Auto
 * *decides* with.
 */
function estimateJobSeconds({ recipe, geometry, analysis }) {
  const duration = (analysis.derived && analysis.derived.durationSeconds) || 0;
  const srcW = geometry.sourceWidth || geometry.width || 1920;
  const srcH = geometry.sourceHeight || geometry.height || 1080;
  const srcFps = geometry.sourceFps || 30;
  const outFps = geometry.fps || srcFps;
  const frames = Math.max(1, Math.round(duration * srcFps));
  const srcMpx = (srcW * srcH) / 1e6;

  let seconds = 0;
  /** What the source dimensions are multiplied by before the next stage. */
  let netScale = 1;

  if (recipe.reconstruction.mode === 'neural') {
    const animation = recipe.reconstruction.model === 'animation';
    const rate = pipeline.SECONDS_PER_INPUT_MPX[
      animation ? 'realesr-animevideov3' : 'realesrgan-x4plus'
    ] || pipeline.SECONDS_PER_INPUT_MPX.default;
    const q = recipe.reconstruction.aiQuality || 'balanced';
    const scale = recipe.reconstruction.aiScale || 1;
    const nativeScale = animation ? Math.max(2, scale) : 4;
    // Balanced reaches a 2x output from a 4x-only model by feeding it a
    // half-size frame - a quarter of the pixels, and the whole point of the
    // setting. Fast on that model declines the network altogether.
    const declines = !animation && scale === 2 && q === 'fast';
    const preScale = (!animation && scale === 2 && q === 'balanced') ? 0.5 : 1;
    if (!declines) {
      seconds += frames * srcMpx * preScale * preScale * rate;
      netScale = preScale * nativeScale;
    }
  }

  if (recipe.motion.interpolation === 'ai') {
    // RIFE works on whatever the upscaler produced, at the output rate.
    const outFrames = Math.max(1, Math.round(duration * outFps));
    seconds += outFrames * srcMpx * netScale * netScale * 0.35;
  }

  if (recipe.framing.tracking === 'auto') seconds += duration * 0.04;

  const outMpx = ((geometry.width || 1920) * (geometry.height || 1080)) / 1e6;
  seconds += duration * Math.max(0.08, outMpx * 0.12);
  return Math.round(seconds);
}

/**
 * Cost class, not an ETA. Same thresholds as the queue, so the two cannot
 * describe the same job differently.
 */
function estimateCost({ recipe, geometry, analysis }) {
  const seconds = estimateJobSeconds({ recipe, geometry, analysis });
  let cost = seconds < 60 ? 'fast'
    : seconds < 600 ? 'moderate'
      : seconds < 3600 ? 'heavy'
        : 'very-heavy';

  // A job that runs a network is never `fast`, whatever the arithmetic says.
  // The cheapest measured neural path on the reference GPU still costs about
  // 0.6 s per frame, so even a short clip is minutes rather than seconds, and
  // "fast" beside a running Real-ESRGAN pass is the label that made the queue
  // untrustworthy in the first place.
  const runsNetwork = recipe.reconstruction.mode === 'neural' ||
    recipe.motion.interpolation === 'ai';
  if (runsNetwork && cost === 'fast') cost = 'moderate';
  return cost;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, Number(v) || 0));
}

/** A magnitude, never a countdown. */
function describeSeconds(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 90) return `${s} seconds`;
  if (s < 5400) return `${Math.round(s / 60)} minutes`;
  return `${(s / 3600).toFixed(1)} hours`;
}

/* ------------------------------------------------------------------ *
 * AUTO CONFIGURE - the product-level entry point
 *
 * Exactly the same decision engine as above; this only adds the plain-language
 * account a person who has never heard of Real-ESRGAN can read. There is no
 * second set of rules, and nothing here decides anything: every line is read
 * back off the recipe that was actually produced.
 * ------------------------------------------------------------------ */

const COST_LABEL = {
  fast: 'Fast',
  moderate: 'Moderate',
  heavy: 'Heavy',
  'very-heavy': 'Very heavy'
};

const QUALITY_LABEL = {
  poor: 'heavily compressed',
  compressed: 'compressed',
  clean: 'clean',
  unknown: 'bitrate unknown'
};

const GRADE_LABEL = {
  cinematic: 'Cinematic finish',
  punchy: 'Punchy finish',
  lift: 'Shadow lift',
  flat: 'Colour left alone',
  neutral: 'Neutral finish'
};

const MASTER_LABEL = {
  creator: 'Creator master',
  dialogue: 'Dialogue focus',
  normalize: 'Loudness normalised'
};

/**
 * @param {object} options same shape as buildAutoRecipe()
 * @returns {object} the buildAutoRecipe() result plus a `summary` a
 *   non-technical reader can act on
 */
function buildAutoConfigure(options = {}) {
  const result = buildAutoRecipe(options);
  return { ...result, summary: summarise(result, options.analysis) };
}

/** Read a finished recipe back as sentences. Never a wish - only what is set. */
function summarise(result, analysis) {
  const r = result.recipe;
  const v = (analysis && analysis.video) || {};
  const d = (analysis && analysis.derived) || {};
  const srcW = d.displayWidth || v.width || null;
  const srcH = d.displayHeight || v.height || null;
  const srcFps = v.nominalFps || null;
  const dec = result.decisions;

  /*
   * The source's *shape*, said out loud.
   *
   * A size class alone is not a description of a source, and for anything
   * ultrawide it actively misleads: `resolutionClass()` measures the long edge,
   * so a 2560x1080 21:9 file reports "1440p" — indistinguishable from a
   * 2560x1440 16:9 one. A user reading "1440p · 60 fps · clean" above a 21:9
   * output reasonably concluded Visionance had failed to convert a 16:9 source,
   * when the source was already 21:9 and there was nothing to convert. The
   * framing was right and the sentence describing it was not.
   */
  const sourceShape = srcW && srcH ? recipes.describeAspectRatio(srcW / srcH) : null;

  const sourceBits = [];
  if (srcW && srcH) sourceBits.push(d.resolutionClass || `${srcH}p`);
  if (sourceShape) sourceBits.push(sourceShape);
  if (srcFps) sourceBits.push(`${srcFps} fps`);
  sourceBits.push(QUALITY_LABEL[dec.sourceQuality.level] || dec.sourceQuality.level);

  const outBits = [];
  if (dec.outputResolution) outBits.push(dec.outputResolution.replace('x', '×'));
  if (dec.outputFps) outBits.push(`${dec.outputFps} fps`);

  const chose = [];
  const add = (label, detail = null) => chose.push({ label, detail });

  if (r.restore.enabled) {
    add(dec.sourceQuality.level === 'poor' ? 'Compression repair' : 'Light cleanup',
      'runs before anything is scaled');
  }
  if (r.reconstruction.mode === 'neural') {
    const scale = r.reconstruction.aiMode === 'restore' ? 'restore' : `${r.reconstruction.aiScale}×`;
    add(`Neural ${scale} — ${capitalise(r.reconstruction.aiQuality)}`,
      'Real-ESRGAN rebuilds detail on the GPU');
  } else if (r.reconstruction.enabled && dec.needsMorePixels) {
    add('Classical rescale', dec.neuralDeclined
      // Saying "the source is clean" here would be a different claim from the
      // one that was actually made, and the wrong one.
      ? 'the neural pass would have cost far more than it returned at this size'
      : 'the source is clean, so nothing is invented');
  } else if (r.reconstruction.enabled && dec.downscales) {
    add('Clean downscale', 'no neural work: the resize would discard it');
  }

  if (r.motion.interpolation === 'ai') {
    add(`RIFE interpolation → ${dec.outputFps} fps`, 'genuinely new in-between frames');
  } else if (r.motion.interpolation === 'duplicate') {
    // Two different situations wear the same recipe value, and saying the
    // wrong one is a lie in both directions: "RIFE is not installed" when it
    // is, or silence about a missing engine when it is not.
    add(`Rate change → ${dec.outputFps} fps`, dec.interpolationDeclined
      ? 'frames are repeated, not interpolated — too small a change to be worth the network'
      : 'frames are repeated, not interpolated — RIFE is not installed');
  } else if (r.motion.enabled && dec.outputFps && srcFps && dec.outputFps < srcFps) {
    add(`Rate conversion → ${dec.outputFps} fps`, 'frames are dropped, none invented');
  }

  if (r.framing.enabled) {
    /*
     * Read off the resolved plan, not the mode name. "Fit, blurred background"
     * was once shown for a render that produced solid black bars, and "Centre
     * crop" says nothing about which way the crop went or what it cost.
     */
    const fr = dec.framing;
    const lost = fr && fr.cropAxis === 'x'
      ? `${Math.round((1 - fr.keepWidth) * 100)}% of the width`
      : fr && fr.cropAxis === 'y'
        ? `${Math.round((1 - fr.keepHeight) * 100)}% of the height`
        : null;
    const stretched = fr && fr.stretch > 1.0005
      ? `${((fr.stretch - 1) * 100).toFixed(1)}% stretch`
      : null;
    const cost = [lost && `${lost} cropped`, stretched].filter(Boolean).join(' + ');

    if (r.framing.tracking === 'auto') {
      add(`Smart Reframe — ${dec.semanticTracking ? 'face + person' : 'motion + detail'}`,
        dec.semanticTracking ? null : 'the optional detector is not installed');
    } else if (r.framing.mode === 'fill') {
      add(fr && fr.cropAxis === 'y' ? 'Crop to fill (top and bottom)' : 'Centre crop',
        cost ? `the picture fills the frame — ${cost}` : 'the picture fills the frame');
    } else if (r.framing.mode === 'stretch') {
      add('Stretch to fill', 'aspect ratio is not preserved');
    } else {
      // "It already fits" is only useful if it says *what* it fits. Without the
      // shape this line reads as a refusal to convert rather than as the
      // statement that there is nothing to convert.
      add(r.framing.background === 'black' ? 'Fit, black bars' : 'Fit, blurred background',
        fr && fr.fills
          ? `the source is already ${sourceShape || 'this shape'}, so nothing is cropped or padded`
          : `the whole frame is kept — ${fr && fr.barAxis === 'x' ? 'bars either side' : 'bars above and below'}`);
    }
  }

  if (r.color.toneMap !== 'none') add('HDR → SDR tone map', `${r.color.toneMap} curve`);
  if (r.color.enabled && GRADE_LABEL[dec.grade]) add(GRADE_LABEL[dec.grade]);
  if (MASTER_LABEL[r.audio.master]) add(MASTER_LABEL[r.audio.master]);
  else if (!r.audio.enabled) add('No audio', 'the source has none');

  return {
    source: { width: srcW, height: srcH, fps: srcFps, quality: dec.sourceQuality.level,
      shape: sourceShape, label: sourceBits.join(' · ') },
    output: { resolution: dec.outputResolution, fps: dec.outputFps, label: outBits.join(' · ') },
    chose,
    cost: result.cost,
    costLabel: COST_LABEL[result.cost] || result.cost,
    profile: result.profile,
    profileLabel: (PROFILES[result.profile] || PROFILES.auto).label,
    intensity: result.intensity
  };
}

const capitalise = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

module.exports = {
  buildAutoRecipe,
  buildAutoConfigure,
  normaliseLocks,
  resolveConstraints,
  capForMachine,
  inferProfile,
  assessQuality,
  estimateCost,
  estimateJobSeconds,
  neuralQualityFor,
  isCinematicRate,
  PROFILES,
  INTENSITIES,
  COST,
  COST_LABEL
};
