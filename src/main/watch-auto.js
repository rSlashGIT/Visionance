'use strict';

/**
 * AUTO CONFIGURE for Watch.
 *
 * Watch and Create answer the same question - "choose the technical details
 * for me" - about two completely different machines. Create renders a file
 * offline and may spend an hour doing it. Watch has 16.7 milliseconds and
 * cannot spend 17. So this is a separate policy over the *same* source
 * classification: the bitrate, cadence and profile judgements come from
 * `auto-recipe.js` so the two workspaces can never disagree about what the
 * source is, and only the decisions differ.
 *
 * What Watch genuinely has, and therefore all this may configure:
 *
 *   look         - one of the realtime Looks (shader parameter sets)
 *   quality      - the realtime policy: auto | performance | balanced | quality | maximum
 *   adaptive     - whether the governor may reduce internal resolution
 *   renderScale  - how many pixels the enhanced frame is rendered at
 *
 * What Watch does not have, and therefore is never configured or implied here:
 * output frame rate (there is no realtime RIFE), output aspect ratio (there is
 * no realtime reframe), neural reconstruction, encoding, audio mastering.
 * Those are Create's, and Create is where they stay.
 *
 * The governing rule is Visionance's: smooth motion beats a sharper still
 * frame. Auto therefore never chooses `maximum`, because `maximum` switches
 * the governor off - an automatic mode that can make playback stutter is not
 * an automatic mode anyone should press.
 */

const autoRecipe = require('./auto-recipe');
// `resolutionClass` measures the long and short edges, so it is right about a
// vertical source and about an ultrawide one. It lives with the analyser
// because the analyser is what produces it; importing it is what stops a third
// copy of the thresholds existing here.
const { resolutionClass } = require('./media-analyzer');

/** Every Look this module may choose, and what each one is for. */
const LOOKS = {
  balanced: 'Balanced',
  streaming: 'Streaming Rescue',
  anime: 'Anime / Animation',
  film: 'Film / Cinematic',
  sports: 'Sports / Motion',
  lowlight: 'Low Light',
  screencast: 'Screencast / Text'
};

/** Realtime policies Auto is allowed to choose, weakest floor first. */
const POLICIES = ['performance', 'auto', 'balanced', 'quality'];

const QUALITY_LABEL = {
  poor: 'heavily compressed',
  compressed: 'compressed',
  clean: 'clean',
  unknown: 'bitrate unknown'
};

/**
 * What the content hint maps to. A hint is the user telling us something the
 * probe cannot: no container field says "this is animation".
 */
const PROFILE_LOOK = {
  film: 'film',
  animation: 'anime',
  action: 'sports',
  gaming: 'sports',
  lowlight: 'lowlight',
  screencast: 'screencast',
  dialogue: 'balanced'
};

/**
 * Classify whatever the GPU calls itself.
 *
 * Deliberately coarse and deliberately honest: three answers plus "unknown",
 * and unknown is treated as the weaker case rather than the stronger one.
 */
function classifyGpu(name) {
  const n = String(name || '').toLowerCase();
  if (!n || n === 'unknown') return 'unknown';
  if (/swiftshader|llvmpipe|software|basic render/.test(n)) return 'none';
  if (/geforce|rtx|gtx|quadro|tesla|radeon (rx|pro)|\brx \d{3,}|arc a\d|apple m\d/.test(n)) {
    return 'discrete';
  }
  if (/intel|uhd graphics|hd graphics|iris|vega \d|integrated|mali|adreno/.test(n)) {
    return 'integrated';
  }
  return 'unknown';
}

function throughputOf(width, height, fps) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  const f = Number(fps) || 30;
  return w * h * f;
}

/**
 * The device name inside whatever the renderer reported.
 *
 * A browser reports its GL device as an ANGLE string - `ANGLE (Intel, Intel(R)
 * UHD Graphics (0x00009BC4) Direct3D11 vs_5_0 ps_5_0, D3D11)` - and quoting
 * that at a person is not an explanation. The middle field is the device.
 */
function describeGpu(name) {
  const raw = String(name || '').trim();
  if (!raw || raw === 'unknown') return null;
  const angle = /^ANGLE \(([^,]+),\s*([^,]+?)(?:\s*\([^)]*\))?\s*(?:Direct3D|OpenGL|Vulkan)/.exec(raw);
  return angle ? angle[2].trim() : raw.slice(0, 44);
}

/**
 * @param {object} o
 *   analysis        {object}  a media analysis, or the thin descriptor a
 *                             stream resolves to. Missing fields stay missing.
 *   profile         {string}  content hint, or 'auto' to infer
 *   sourceKind      {'local'|'stream'}
 *   machine         {{gpu:string, cores:number, memoryBytes:number}}
 *   playback        {{dropRate:number, limited:boolean, fps:number}|null}
 *                             live evidence from the running player, if any
 *   availableLooks  {string[]} the Look ids the renderer actually has
 * @returns {{look, lookLabel, quality, adaptive, renderScale, profile,
 *            profileInferred, reasons:string[], warnings:string[], source:object}}
 */
function buildWatchAuto({
  analysis = null,
  profile: requestedProfile = 'auto',
  sourceKind = 'local',
  machine = null,
  playback = null,
  availableLooks = null
} = {}) {
  const reasons = [];
  const warnings = [];

  const v = (analysis && analysis.video) || {};
  const d = (analysis && analysis.derived) || {};
  const width = d.displayWidth || v.width || null;
  const height = d.displayHeight || v.height || null;
  const fps = v.nominalFps || null;
  const sourceClass = d.resolutionClass || null;

  // Source classification is shared with Create on purpose: one engine decides
  // what a source *is*, and the two workspaces decide what to do about it.
  const quality = analysis
    ? autoRecipe.assessQuality(analysis)
    : { known: false, level: 'unknown', bitsPerMpxPerS: null };

  /* ---------------- which Look ---------------- */

  let look = 'balanced';
  let profile = requestedProfile && requestedProfile !== 'auto' ? requestedProfile : 'auto';
  let profileInferred = false;

  if (profile !== 'auto' && PROFILE_LOOK[profile]) {
    look = PROFILE_LOOK[profile];
    reasons.push(`You chose ${profile} content, so the ${LOOKS[look]} look is applied.`);
  } else if (quality.level === 'poor' || quality.level === 'compressed') {
    // A measured bitrate is a real signal, and it is the one that matters most
    // for realtime work: blocking and banding get magnified by sharpening, so
    // they have to be cleaned up before anything is reconstructed.
    look = 'streaming';
    profile = 'auto';
    profileInferred = true;
    reasons.push(
      `The source measures ${QUALITY_LABEL[quality.level]} for its resolution, so ` +
      'Streaming Rescue is applied: artefacts are cleaned up before detail is rebuilt.'
    );
  } else if (analysis) {
    const inferred = autoRecipe.inferProfile(analysis, 'auto');
    if (inferred.profile === 'film') {
      look = 'film';
      profile = 'film';
      profileInferred = true;
      reasons.push(`${inferred.why} — the Film / Cinematic look leaves grain alone.`);
    } else {
      look = 'balanced';
      reasons.push('Nothing in the file identifies the content, so the Balanced look is applied.');
    }
  } else {
    reasons.push('The source has not been analysed, so the Balanced look is applied.');
  }

  if (quality.level === 'unknown' && look !== 'streaming') {
    warnings.push(
      sourceKind === 'stream'
        ? 'This stream did not report a bitrate, so no assumption was made about how compressed it is.'
        : 'The source bitrate is unknown, so no assumption was made about how compressed it is.'
    );
  }

  // Never choose a Look this build does not have.
  if (Array.isArray(availableLooks) && availableLooks.length && !availableLooks.includes(look)) {
    warnings.push(`The ${LOOKS[look] || look} look is not available in this build; Balanced was used.`);
    look = availableLooks.includes('balanced') ? 'balanced' : availableLooks[0];
  }

  /* ---------------- realtime policy ----------------
   *
   * Motion first. The policy sets the *floor* the governor may reduce to, so a
   * high policy is a promise the machine may not be able to keep: it is the
   * setting that produces a sharp, stuttering picture. Auto therefore picks
   * the conservative end and lets adaptive quality climb when it measures
   * headroom, which is the behaviour the governor already implements.
   */

  const tier = classifyGpu(machine && machine.gpu);
  const weak = tier === 'integrated' || tier === 'none' || tier === 'unknown';
  const gpuName = describeGpu(machine && machine.gpu);
  const throughput = throughputOf(width, height, fps);

  /*
   * The policy is decided by *throughput* - pixels per second - because that is
   * what a realtime renderer actually has to keep up with. The sentence that
   * comes with it has to describe the source that was measured, though, not
   * the threshold that was crossed: a 1440p60 stream is 221 million pixels a
   * second, which is past a 4K film's rate, and calling it "a 4K source"
   * because of that is simply wrong about the video the user is watching.
   */
  const sizeClass = sourceClass || (width && height ? resolutionClass(width, height) : null);
  const rate = fps ? Math.round(fps) : null;
  const describeSource = () =>
    [sizeClass, rate ? `${rate} fps` : null].filter(Boolean).join(' at ') || 'this source';
  const millionsPerSecond = Math.round(throughput / 1e6);
  /** Named after what it is: a source heavy enough to start conservatively. */
  const FILM_4K_RATE = 3840 * 2160 * 24 * 0.9;

  let heavy = false;
  let policy = 'auto';
  if (throughput >= FILM_4K_RATE) {
    policy = 'performance';
    heavy = true;
    reasons.push(
      `${describeSource()} is ${millionsPerSecond} million pixels a second, at or beyond what a ` +
      '4K film asks for, so realtime quality starts at Performance to protect playback.'
    );
  } else if (throughput >= 1920 * 1080 * 50 * 0.9 && weak) {
    policy = 'performance';
    // Never "this machine has no discrete GPU": what is known is which device
    // the realtime renderer is on, and on a laptop that is routinely the
    // integrated one even when a discrete adapter is present.
    reasons.push(
      `${describeSource()} is a heavy realtime load, and enhancement is running on ` +
      `${gpuName || 'a GPU the renderer did not name'}, so realtime quality starts at ` +
      'Performance so motion stays smooth.'
    );
  } else if (throughput > 0 && throughput <= 1280 * 720 * 30 * 1.1 && tier === 'discrete') {
    policy = 'quality';
    reasons.push(
      `${describeSource()} leaves ${gpuName || 'this GPU'} room, so realtime quality is set to Quality.`
    );
  } else {
    policy = 'auto';
    reasons.push(
      'Realtime quality is left on Auto: enhancement runs as hard as the frame budget allows and ' +
      'gives ground the moment it does not.'
    );
  }

  // Live evidence outranks every guess above it.
  if (playback && (playback.limited || Number(playback.dropRate) > 4)) {
    const before = policy;
    policy = stepDown(policy);
    if (policy !== before) {
      reasons.push(
        `Playback is currently dropping ${Math.round(Number(playback.dropRate) || 0)}% of frames, ` +
        `so realtime quality was lowered from ${capitalise(before)} to ${capitalise(policy)}.`
      );
    }
  }

  if (!width || !height) {
    warnings.push('The source resolution is unknown, so realtime quality was chosen conservatively.');
    policy = 'auto';
  }

  /* ---------------- render scale ----------------
   *
   * `auto` renders exactly enough pixels for the display. A fixed multiplier
   * is a way to ask for pixels the screen cannot show, which costs frames and
   * returns nothing, so Auto does not choose one.
   */
  const renderScale = 'auto';
  reasons.push('Render resolution stays on Auto — exactly enough pixels for this display, no more.');

  return {
    look,
    lookLabel: LOOKS[look] || look,
    quality: policy,
    adaptive: true,
    renderScale,
    profile,
    profileInferred,
    reasons,
    warnings,
    source: {
      width,
      height,
      fps,
      kind: sourceKind,
      quality: quality.level,
      /** The class measured off both edges, so a vertical source is not "1920p". */
      resolutionClass: sizeClass,
      /** Pixels per second - the number the policy is actually decided on. */
      throughput,
      heavy,
      gpuTier: tier,
      gpu: gpuName,
      label: [
        sizeClass,
        fps ? `${Math.round(fps * 100) / 100} fps` : null,
        QUALITY_LABEL[quality.level] || null
      ].filter(Boolean).join(' · ')
    }
  };
}

/** One step toward more headroom. Never past Performance. */
function stepDown(policy) {
  const i = POLICIES.indexOf(policy);
  if (i <= 0) return 'performance';
  return POLICIES[i - 1];
}

const capitalise = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

module.exports = { buildWatchAuto, classifyGpu, LOOKS, POLICIES };
