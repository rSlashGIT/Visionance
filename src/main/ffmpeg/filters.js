'use strict';

/**
 * Recipe -> ffmpeg filter graph.
 *
 * The whole video chain is emitted as one `-filter_complex` graph ending in
 * `[vout]`, even when it is a single filter. One code path means the blurred-
 * background composite (which genuinely needs `split`/`overlay`) is not a
 * special case that only gets exercised occasionally.
 *
 * Filters are ordered by what each one needs from the ones before it:
 *   tone map -> deinterlace -> crop -> denoise/deblock -> fps -> scale ->
 *   canvas -> sharpen -> grade -> deband -> grain -> pixel format
 *
 * Cleanup happens at source resolution so noise is never magnified; debanding
 * happens after grading because grading is what exposes the banding.
 */

const { resolveFramingPlan } = require('../recipe');

const round3 = (n) => Math.round(n * 1000) / 1000;
const even = (n) => {
  const v = Math.max(2, Math.round(n));
  return v % 2 === 0 ? v : v + 1;
};

/** Escape a value used inside a filter argument. */
function esc(value) {
  return String(value).replace(/([\\:'])/g, '\\$1');
}

class GraphBuilder {
  constructor(inputLabel) {
    this.parts = [];
    this.cur = inputLabel;
    this.pending = [];
    this.seq = 0;
  }

  add(filter) {
    if (filter) this.pending.push(filter);
    return this;
  }

  /** Flush pending linear filters into a labelled node. */
  flush(label) {
    const name = label || `v${++this.seq}`;
    if (!this.pending.length && !label) return this.cur;
    this.parts.push(`[${this.cur}]${this.pending.length ? this.pending.join(',') : 'null'}[${name}]`);
    this.cur = name;
    this.pending = [];
    return name;
  }

  raw(part) {
    this.parts.push(part);
    return this;
  }

  setCurrent(label) {
    this.cur = label;
    return this;
  }

  finish(outLabel = 'vout') {
    this.flush(outLabel);
    return this.parts.join(';');
  }
}

/* ------------------------------------------------------------------ *
 * Individual stage contributions
 * ------------------------------------------------------------------ */

function toneMapFilters(recipe, analysis, has) {
  const isHDR = !!(analysis && analysis.derived && analysis.derived.isHDR) ||
    !!(recipe.analysisRef && recipe.analysisRef.isHDR);
  const mode = recipe.color.toneMap;
  if (!isHDR || mode === 'none') return { filters: [], note: null };
  if (!has('zscale') || !has('tonemap')) {
    return {
      filters: [],
      note: 'This ffmpeg build has no zscale/tonemap filter, so HDR was passed through untouched.'
    };
  }
  return {
    filters: [
      'zscale=transfer=linear:npl=100',
      'format=gbrpf32le',
      'zscale=primaries=bt709',
      `tonemap=tonemap=${mode}:desat=0`,
      'zscale=transfer=bt709:matrix=bt709:range=tv'
    ],
    note: `HDR source tone-mapped to SDR with ${mode}.`
  };
}

function deinterlaceFilter(recipe, analysis, has) {
  const setting = recipe.restore.deinterlace;
  if (setting === 'off') return null;
  const interlaced = (analysis && analysis.derived && analysis.derived.isInterlaced === true) ||
    (recipe.analysisRef && recipe.analysisRef.isInterlaced === true);
  if (setting === 'auto' && !interlaced) return null;
  if (setting === 'on' || interlaced) {
    return has('bwdif') ? 'bwdif=mode=send_frame:parity=auto:deint=all' : 'yadif=mode=0:parity=-1:deint=0';
  }
  return null;
}

function restoreFilters(recipe) {
  if (!recipe.restore.enabled) return [];
  const out = [];
  const { denoise, deblock } = recipe.restore;

  if (deblock > 0.02) {
    const alpha = round3(0.05 + deblock * 0.15);
    const beta = round3(0.05 + deblock * 0.1);
    out.push(`deblock=filter=weak:block=8:alpha=${alpha}:beta=${beta}`);
  }
  if (denoise > 0.02) {
    out.push(`hqdn3d=${round3(denoise * 4)}:${round3(denoise * 3)}:${round3(denoise * 6)}:${round3(denoise * 4.5)}`);
  }
  return out;
}

function motionFilter(recipe, geometry) {
  if (!recipe.motion.enabled && !recipe.output.fps) return { filter: null, note: null };
  const target = geometry.fps;
  const source = geometry.sourceFps;
  if (!target) return { filter: null, note: null };
  if (source && Math.abs(target - source) < 0.01) return { filter: null, note: null };

  const mode = recipe.motion.enabled ? recipe.motion.interpolation : 'none';

  if (mode === 'motion') {
    const scd = recipe.motion.sceneCutProtection
      ? `:scd=fdiff:scd_threshold=${round3(recipe.motion.sceneCutThreshold * 20)}`
      : ':scd=none';
    return {
      filter: `minterpolate=fps=${target}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1${scd}`,
      note: `Motion-compensated interpolation to ${target} fps (CPU, slow).`
    };
  }
  if (mode === 'blend') {
    return {
      filter: `framerate=fps=${target}:interp_start=0:interp_end=255:scene=${round3(recipe.motion.sceneCutThreshold * 100)}`,
      note: `Blended frame rate conversion to ${target} fps.`
    };
  }
  return {
    filter: `fps=${target}`,
    note: `Frame rate ${source ? `${source} → ` : 'set to '}${target} fps by duplicating/dropping frames (no new motion is invented).`
  };
}

const SWS_FLAGS = {
  lanczos: 'lanczos+accurate_rnd',
  bicubic: 'bicubic+accurate_rnd',
  spline: 'spline+accurate_rnd',
  bilinear: 'bilinear'
};

function scaleFilter(recipe, geometry) {
  const { scaleWidth, scaleHeight, sourceWidth, sourceHeight } = geometry;
  if (!scaleWidth || !scaleHeight) return null;
  if (scaleWidth === sourceWidth && scaleHeight === sourceHeight) return null;
  const flags = SWS_FLAGS[recipe.reconstruction.resampler] || SWS_FLAGS.lanczos;
  return `scale=${scaleWidth}:${scaleHeight}:flags=${flags}`;
}

/**
 * Fit or fill the output canvas. Returns either a linear filter list or a
 * composite that has to be spliced into the graph with explicit labels.
 */
function canvasStep(recipe, geometry, has, opts = {}) {
  const w = geometry.canvasWidth;
  const h = geometry.canvasHeight;
  if (!recipe.framing.enabled || !w || !h) return { kind: 'none' };

  const flags = SWS_FLAGS[recipe.reconstruction.resampler] || SWS_FLAGS.lanczos;

  if (recipe.framing.mode === 'stretch') {
    return { kind: 'linear', filters: [`scale=${w}:${h}:flags=${flags}`], note: 'Canvas filled by stretching (aspect ratio not preserved).' };
  }

  if (recipe.framing.mode === 'fill') {
    /*
     * Crop to the target shape, then one scale onto the canvas.
     *
     * The crop used to be `w=min(iw, ih*R):h=ih` - width only. That is correct
     * for the case it was written for, 16:9 into 9:16, and a no-op for the
     * opposite one: a 16:9 picture going to 21:9 is already narrower than
     * `ih*R`, so `min()` returned the full width, nothing was cropped, and the
     * scale that followed stretched the frame across the canvas. Taking the
     * largest rectangle of the wanted shape that the picture holds - trimming
     * whichever axis is long - is the same operation in both directions.
     *
     * Crop before scale, not after: the tracked x expression is in *source*
     * coordinates, which is what the trajectory was measured in.
     */
    const plan = resolveFramingPlan(recipe, geometry);
    const ratio = round3(plan.cropRatio || (w / h));
    const reframe = opts.reframe;
    // The tracker measures a horizontal position and nothing else, so it can
    // only steer a crop that trims width. On a vertical trim its trajectory
    // has nothing to say, and pretending otherwise would put a Smart Reframe
    // label on a centred crop.
    const tracked = recipe.framing.tracking === 'auto' && !!(reframe && reframe.expr) &&
      plan.cropAxis === 'x';
    const x = tracked ? `'min(max(${reframe.expr}\\,0)\\,iw-ow)'` : '(iw-ow)/2';

    const kept = plan.cropAxis === 'x'
      ? `${Math.round((1 - plan.keepWidth) * 100)}% of the width`
      : plan.cropAxis === 'y'
        ? `${Math.round((1 - plan.keepHeight) * 100)}% of the height`
        : null;
    const stretchNote = plan.stretch > 1.0005
      ? ` A ${((plan.stretch - 1) * 100).toFixed(1)}% ${plan.stretchAxis === 'x' ? 'horizontal' : 'vertical'} ` +
        'stretch absorbs the rest of the shape change.'
      : '';

    return {
      kind: 'linear',
      filters: [
        `crop=w=min(iw\\,ih*${ratio}):h=min(ih\\,iw/${ratio}):x=${x}:y=(ih-oh)/2`,
        `scale=${w}:${h}:flags=${flags}`
      ],
      // Geometry only. Whether the tracking *succeeded* is not something a
      // filter builder can know - it can only see whether the compiled
      // expression is a constant - and claiming it here is how a job ended
      // up saying "the crop follows the subject" next to "the subject could
      // not be located". The outcome is summarised once, in tracking.js.
      note: tracked
        ? (reframe.static
          ? `Smart Reframe crop into ${w}×${h}, fixed for the whole clip.${stretchNote}`
          : `Smart Reframe crop into ${w}×${h}, moving across ${reframe.points} keyed positions.${stretchNote}`)
        : `Centre-cropped to fill a ${w}×${h} canvas${kept ? `, losing ${kept}` : ''}.${stretchNote}`
    };
  }

  // fit
  if (recipe.framing.background === 'blur' && has('gblur')) {
    const sigma = Math.max(8, Math.round(Math.max(w, h) / 40));
    return {
      kind: 'composite',
      build: (g) => {
        const pre = g.flush();
        g.raw(`[${pre}]split=2[vsbg][vsfg]`);
        g.raw(`[vsbg]scale=${w}:${h}:force_original_aspect_ratio=increase:flags=${flags},crop=${w}:${h},gblur=sigma=${sigma}[vsbgb]`);
        g.raw(`[vsfg]scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=${flags}[vsfgs]`);
        g.raw(`[vsbgb][vsfgs]overlay=(W-w)/2:(H-h)/2:shortest=1[vsframed]`);
        g.setCurrent('vsframed');
      },
      note: `Letterboxed into a ${w}×${h} canvas over a blurred copy of the frame.`
    };
  }

  return {
    kind: 'linear',
    filters: [
      `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=${flags}`,
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`
    ],
    note: `Letterboxed into a ${w}×${h} canvas on black.`
  };
}

function colorFilters(recipe) {
  const out = [];
  if (!recipe.color.enabled) return out;

  const { sharpen, contrast, brightness, saturation, gamma } = recipe.color;

  if (sharpen > 0.02) {
    out.push(
      `unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=${round3(sharpen * 1.4)}` +
      `:chroma_msize_x=5:chroma_msize_y=5:chroma_amount=${round3(sharpen * 0.5)}`
    );
  }

  const c = round3(1 + contrast * 0.5);
  const s = round3(1 + saturation * 0.8);
  const b = round3(brightness * 0.2);
  const g = round3(1 / Math.max(0.4, 1 + gamma * 0.5));
  if (Math.abs(c - 1) > 0.01 || Math.abs(s - 1) > 0.01 || Math.abs(b) > 0.005 || Math.abs(g - 1) > 0.01) {
    out.push(`eq=contrast=${c}:saturation=${s}:brightness=${b}:gamma=${g}`);
  }
  return out;
}

function finishFilters(recipe) {
  const out = [];
  if (recipe.restore.enabled) {
    const { deband, grain } = recipe.restore;
    if (deband > 0.02) {
      const thr = round3(0.004 + deband * 0.03);
      out.push(`deband=1thr=${thr}:2thr=${thr}:3thr=${thr}:4thr=${thr}:range=16:blur=1`);
    }
    if (grain > 0.02) {
      out.push(`noise=alls=${Math.round(grain * 12)}:allf=t+u`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Public builders
 * ------------------------------------------------------------------ */

/**
 * @param {object} recipe    sanitised recipe
 * @param {object} geometry  result of recipe.resolveOutputGeometry()
 * @param {object} [analysis]
 * @param {object} [opts]    { availableFilters: Set<string>, inputLabel: '0:v', outputLabel: 'vout' }
 * @returns {{graph: string, outputLabel: string, notes: string[]}}
 */
function buildVideoGraph(recipe, geometry, analysis, opts = {}) {
  const available = opts.availableFilters instanceof Set ? opts.availableFilters : null;
  // With no detection data, assume the filter exists: every one used here is in
  // a stock ffmpeg build, and a wrong "missing" verdict would silently drop a
  // stage the user asked for.
  const has = (name) => (available ? available.has(name) : true);

  const notes = [];
  const g = new GraphBuilder(opts.inputLabel || '0:v');

  const tm = toneMapFilters(recipe, analysis, has);
  tm.filters.forEach((f) => g.add(f));
  if (tm.note) notes.push(tm.note);

  const di = deinterlaceFilter(recipe, analysis, has);
  if (di) {
    g.add(di);
    notes.push('Interlaced source deinterlaced.');
  }

  const crop = recipe.framing.enabled ? recipe.framing.crop : null;
  if (crop) {
    g.add(`crop=iw*${round3(crop.width)}:ih*${round3(crop.height)}:iw*${round3(crop.x)}:ih*${round3(crop.y)}`);
    notes.push('Manual crop applied before scaling.');
  }

  restoreFilters(recipe).forEach((f) => g.add(f));

  const motion = motionFilter(recipe, geometry);
  if (motion.filter) {
    g.add(motion.filter);
    notes.push(motion.note);
  }

  const scale = scaleFilter(recipe, geometry);
  if (scale) {
    g.add(scale);
    notes.push(
      `Rescaled to ${geometry.scaleWidth}×${geometry.scaleHeight} with ${recipe.reconstruction.resampler}` +
      ' (classical resampling — no detail is invented).'
    );
  }

  const canvas = canvasStep(recipe, geometry, has, opts);
  if (canvas.kind === 'linear') {
    canvas.filters.forEach((f) => g.add(f));
    notes.push(canvas.note);
  } else if (canvas.kind === 'composite') {
    canvas.build(g);
    notes.push(canvas.note);
  }

  colorFilters(recipe).forEach((f) => g.add(f));
  finishFilters(recipe).forEach((f) => g.add(f));

  // Widest playback compatibility; also normalises anything the graph left in
  // a float or high-bit-depth format.
  g.add('format=yuv420p');

  const outputLabel = opts.outputLabel || 'vout';
  return { graph: g.finish(outputLabel), outputLabel, notes };
}

/* ------------------------------------------------------------------ *
 * Neural path
 *
 * When a neural stage runs, the work is split either side of it rather than
 * fused into one graph:
 *
 *   pre   tone map, deinterlace, crop, denoise/deblock   (before inference)
 *   ---   Real-ESRGAN / RIFE on frames                   (no ffmpeg involved)
 *   post  scale to final, canvas, sharpen, grade, grain  (after inference)
 *
 * Cleanup belongs *before* the network: feeding compression artefacts into a
 * super-resolution model teaches it to reconstruct the artefacts. Grading
 * belongs after, because the network changes the image it would be grading.
 * ------------------------------------------------------------------ */

/**
 * Filters applied while decoding frames for the neural engines.
 * @returns {{filters:string[], notes:string[]}}
 */
function buildPreNeuralFilters(recipe, analysis, opts = {}) {
  const available = opts.availableFilters instanceof Set ? opts.availableFilters : null;
  const has = (name) => (available ? available.has(name) : true);
  const filters = [];
  const notes = [];

  const tm = toneMapFilters(recipe, analysis, has);
  filters.push(...tm.filters);
  if (tm.note) notes.push(tm.note);

  const di = deinterlaceFilter(recipe, analysis, has);
  if (di) {
    filters.push(di);
    notes.push('Interlaced source deinterlaced before neural processing.');
  }

  const crop = recipe.framing.enabled ? recipe.framing.crop : null;
  if (crop) {
    filters.push(`crop=iw*${round3(crop.width)}:ih*${round3(crop.height)}:iw*${round3(crop.x)}:ih*${round3(crop.y)}`);
    notes.push('Manual crop applied before neural processing.');
  }

  const restore = restoreFilters(recipe);
  if (restore.length) {
    filters.push(...restore);
    notes.push('Compression cleanup ran before the network, so artefacts are not reconstructed as detail.');
  }

  return { filters, notes };
}

/**
 * Filters applied when encoding the processed frames back to video.
 *
 * Returns either a flat `-vf` chain or, when the framing needs `split`/
 * `overlay`, a labelled `-filter_complex` graph. Both forms are handled by
 * `frames.encodeFrames()`.
 *
 * @param {object} frameSize { width, height } of the frames coming out of the engines
 * @returns {{filters:string[], graph:string|null, outputLabel:string|null, notes:string[]}}
 */
function buildPostNeuralFilters(recipe, geometry, frameSize, opts = {}) {
  const available = opts.availableFilters instanceof Set ? opts.availableFilters : null;
  const has = (name) => (available ? available.has(name) : true);
  const filters = [];
  const notes = [];
  const flags = SWS_FLAGS[recipe.reconstruction.resampler] || SWS_FLAGS.lanczos;

  /*
   * Bring the network's native output down (or up) to what the recipe asked
   * for. This is the step that makes "AI Restore at source resolution" and
   * "2x from a 4x-only model" honest rather than imaginary.
   *
   * It is skipped when framing owns the resample, for the same reason
   * `resolveOutputGeometry()` holds `scaleWidth` at the source there: with a
   * canvas active this scale targets the *source* size, so it would take a
   * 3840x2160 network output, throw it back down to 1920x1080, and hand the
   * canvas step a picture it then has to enlarge again to 2560x1080. One
   * resample, from the largest picture available, is both correct and better.
   */
  const framesToCanvas = !!(geometry.framesToCanvas && geometry.canvasWidth && geometry.canvasHeight);
  const targetW = geometry.scaleWidth || geometry.width;
  const targetH = geometry.scaleHeight || geometry.height;
  if (!framesToCanvas && targetW && targetH && frameSize &&
      (frameSize.width !== targetW || frameSize.height !== targetH)) {
    filters.push(`scale=${targetW}:${targetH}:flags=${flags}`);
    const direction = frameSize.width > targetW ? 'downscaled' : 'scaled';
    notes.push(
      `Network output ${frameSize.width}x${frameSize.height} ${direction} to ${targetW}x${targetH} with ` +
      `${recipe.reconstruction.resampler}.`
    );
  } else if (framesToCanvas && frameSize) {
    notes.push(
      `Network output ${frameSize.width}x${frameSize.height} taken straight into the ` +
      `${geometry.canvasWidth}x${geometry.canvasHeight} canvas — one resample, not two.`
    );
  }

  const canvas = canvasStep(recipe, geometry, has, opts);
  const tail = [...colorFilters(recipe), ...finishFilters(recipe), 'format=yuv420p'];

  if (canvas.kind !== 'composite') {
    if (canvas.kind === 'linear') {
      filters.push(...canvas.filters);
      notes.push(canvas.note);
    }
    filters.push(...tail);
    return { filters, graph: null, outputLabel: null, notes };
  }

  /*
   * The blurred-background composite needs `split` and `overlay`, which a flat
   * `-vf` chain cannot express. This used to substitute a black `pad` and say
   * so only in a note nobody reads - so a job whose summary said "Fit, blurred
   * background" produced solid black bars whenever a neural stage was in the
   * plan, which for any RIFE render is always. Emitting the whole post chain as
   * a labelled graph makes the label true instead.
   */
  const g = new GraphBuilder(opts.inputLabel || '0:v');
  filters.forEach((f) => g.add(f));
  canvas.build(g);
  notes.push(canvas.note);
  tail.forEach((f) => g.add(f));

  const outputLabel = opts.outputLabel || 'vout';
  return { filters: [], graph: g.finish(outputLabel), outputLabel, notes };
}

/**
 * Audio mastering chain (applied with -filter:a).
 *
 * Four opinionated presets built from standard ffmpeg filters. Visionance is
 * not a DAW and does not pretend to be: there is no spectral repair here, and
 * conventional EQ is never described as "AI voice isolation".
 *
 *   preserve   nothing at all
 *   normalize  loudness only
 *   creator    loudness + gentle glue compression + a true-peak limiter
 *   dialogue   creator, plus de-rumble and a presence lift for speech
 */
function buildAudioFilters(recipe) {
  const filters = [];
  const notes = [];
  if (!recipe.audio.enabled || recipe.audio.mode !== 'encode') return { filters, notes };

  const master = recipe.audio.master || 'preserve';
  const n = recipe.audio.normalize || {};

  if (master === 'dialogue') {
    // Roll off rumble and handling noise below speech.
    filters.push('highpass=f=85');
    // A restrained presence lift; enough to help intelligibility, not enough
    // to sound like a radio processor.
    filters.push('equalizer=f=200:t=q:w=1.2:g=-1.5');
    filters.push('equalizer=f=3000:t=q:w=1.4:g=2.5');
    notes.push('Dialogue: rumble removed and a small presence lift around 3 kHz.');
  }

  if (master === 'creator' || master === 'dialogue') {
    // Gentle glue compression. Slow enough not to pump, shallow enough that the
    // performance survives.
    const ratio = master === 'dialogue' ? 3 : 2;
    filters.push(`acompressor=threshold=-18dB:ratio=${ratio}:attack=15:release=250:makeup=1`);
    notes.push(master === 'dialogue'
      ? 'Dialogue: 3:1 compression to even out delivery.'
      : 'Creator master: 2:1 glue compression.');
  }

  if (master !== 'preserve' && n.enabled !== false) {
    const target = n.targetLufs ?? -14;
    const peak = n.truePeak ?? -1;
    filters.push(`loudnorm=I=${target}:TP=${peak}:LRA=${n.lra ?? 11}`);
    notes.push(`Loudness normalised to ${target} LUFS (single pass).`);
  } else if (n.enabled) {
    filters.push(`loudnorm=I=${n.targetLufs}:TP=${n.truePeak}:LRA=${n.lra}`);
    notes.push(`Loudness normalised to ${n.targetLufs} LUFS (single pass).`);
  }

  if (master === 'creator' || master === 'dialogue') {
    // Final safety net. loudnorm targets true peak but a limiter guarantees it,
    // and clipping is the one audio fault every viewer notices.
    filters.push('alimiter=limit=0.97:attack=5:release=50:level=disabled');
    notes.push('True-peak limiter prevents clipping.');
  }

  if (recipe.audio.sampleRate) filters.push(`aresample=${recipe.audio.sampleRate}`);
  return { filters, notes };
}

module.exports = {
  buildVideoGraph,
  buildAudioFilters,
  buildPreNeuralFilters,
  buildPostNeuralFilters,
  GraphBuilder,
  esc,
  even
};
