'use strict';

/**
 * Frame-interpolation planning.
 *
 * This is the timing brain for RIFE. It is pure arithmetic on frame indices so
 * it can be tested exhaustively without a GPU, because every interesting bug in
 * frame interpolation is a timing bug:
 *
 *   - the output drifting out of sync with the audio
 *   - a hard cut being blended into a mutant frame
 *   - a micro-freeze where two chunks were joined
 *   - the last frame of the video going missing
 *
 * The model
 * ---------
 * A chunk holds `frameCount` source frames at `fpsSrc`, so it *displays* for
 * `frameCount / fpsSrc` seconds - each frame occupies a full frame interval,
 * including the last one. The output must display for exactly the same time, so
 * it gets `round(duration * fpsDst)` frames. Duration is preserved by
 * construction; there is no accumulating rounding error.
 *
 * Shots and cuts
 * --------------
 * Cuts split the chunk into shots. Output frames are assigned to whichever shot
 * contains their timestamp, and each shot is interpolated *on its own*. RIFE
 * therefore never receives a frame pair that spans a cut - not because the
 * result is filtered afterwards, but because those two frames are never handed
 * to it in the same call.
 *
 * The anchor
 * ----------
 * RIFE's `-n` spreads its output evenly across the input frames it is given,
 * with the last output landing exactly on the last input. A shot needs output
 * samples across `[first, last+1)` - the whole display interval - so it is
 * given one extra trailing "anchor" frame and one extra output, and the final
 * output (which lands on the anchor) is discarded.
 *
 *   - mid-shot chunk boundary: the anchor is the *real* first frame of the next
 *     chunk, so motion continues across the join with no freeze and no
 *     duplicated frame
 *   - at a cut, and at the end of the video: the anchor is a copy of the shot's
 *     own last frame, because the only alternative is reaching across the cut
 *
 * Without this the shot would be sampled across `[first, last]` instead of
 * `[first, last+1)`, quietly compressing every shot by one frame interval.
 */

const EPSILON = 1e-9;

/**
 * Frame indices where a new shot starts, from cut *timestamps*.
 *
 * Callers convert once. `planInterpolation` takes indices, not times - running
 * this twice turns frame 24 into frame 576, which lands outside the chunk and
 * silently discards the cut. That failure is invisible until you look at the
 * pixels either side of a cut, so `normaliseCutFrames` below refuses to guess.
 */
function cutsToFrameIndices(cutTimes, fpsSrc, frameCount) {
  const out = new Set();
  for (const t of cutTimes || []) {
    const idx = Math.round(Number(t) * fpsSrc);
    // A "cut" at frame 0 is just the start of the chunk, not a boundary.
    if (Number.isFinite(idx) && idx > 0 && idx < frameCount) out.add(idx);
  }
  return [...out].sort((a, b) => a - b);
}

/** Keep only in-range integer frame indices. No unit conversion happens here. */
function normaliseCutFrames(cutFrames, frameCount) {
  const out = new Set();
  for (const raw of cutFrames || []) {
    const idx = Math.round(Number(raw));
    if (Number.isFinite(idx) && idx > 0 && idx < frameCount) out.add(idx);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * @param {object} o
 *   frameCount   {number} source frames in this chunk
 *   fpsSrc       {number}
 *   fpsDst       {number}
 *   cutFrames    {number[]} source frame indices that begin a new shot
 *   hasNextFrame {boolean} is a real trailing frame available from the next chunk?
 *   arbitraryTimestep {boolean} does the chosen model support non-power-of-two?
 * @returns {{outputCount, duration, shots:Array, warnings:string[]}}
 */
function planInterpolation({
  frameCount,
  fpsSrc,
  fpsDst,
  cutFrames = [],
  hasNextFrame = false,
  arbitraryTimestep = true
} = {}) {
  const warnings = [];
  const n = Math.max(0, Math.floor(Number(frameCount) || 0));
  const src = Number(fpsSrc);
  const dst = Number(fpsDst);

  if (!n || !(src > 0) || !(dst > 0)) {
    return { outputCount: 0, duration: 0, shots: [], warnings: ['Nothing to interpolate.'] };
  }

  const duration = n / src;
  const outputCount = Math.max(1, Math.round(duration * dst));

  // Shot boundaries.
  // `cutFrames` are already frame indices; converting again would be a unit bug.
  const starts = [0, ...normaliseCutFrames(cutFrames, n)];
  const shots = [];
  for (let s = 0; s < starts.length; s++) {
    const a = starts[s];
    const b = (s + 1 < starts.length ? starts[s + 1] : n) - 1;
    if (b < a) continue;
    shots.push({ startFrame: a, endFrame: b });
  }

  // Assign every output frame to the shot whose display interval holds it. This
  // is what keeps cut timing exact and the total frame count honest.
  const planned = [];
  let assigned = 0;
  for (let s = 0; s < shots.length; s++) {
    const shot = shots[s];
    const isLastShot = s === shots.length - 1;
    const tStart = shot.startFrame / src;
    const tEnd = (shot.endFrame + 1) / src;

    // First output index at or after tStart, first at or after tEnd.
    const jStart = Math.max(assigned, Math.ceil(tStart * dst - EPSILON));
    const jEnd = isLastShot ? outputCount : Math.min(outputCount, Math.ceil(tEnd * dst - EPSILON));
    const count = Math.max(0, jEnd - jStart);

    const inputFrames = shot.endFrame - shot.startFrame + 1;
    /*
     * Only the final shot of a chunk can borrow a real frame from the next
     * chunk; every other shot ends at a cut and must not look past it, so its
     * trailing anchor is a copy of its own last frame.
     *
     * That duplicate looks like a bug and is not, which is worth writing down
     * because it was "fixed" once and had to be put back.
     *
     * RIFE spreads N samples evenly across the images it is given, endpoints
     * inclusive. With the duplicate, a shot's samples span source positions
     * a … b+1, so the samples landing in [b, b+1) show frame b — which is
     * exactly how long frame b is displayed in the source itself (1/23.976 =
     * 41.7 ms, about 2.5 samples at 60 fps). Measured over the mapping:
     *
     *   with the duplicate anchor   motion runs at 1.0010x   (correct)
     *   without it                  motion runs at 0.949x-0.988x, and the
     *                               error grows as shots get shorter
     *
     * Removing the anchor removes the hold by *stretching the motion*, which
     * is a worse defect than the thing it was removing: the hold is not an
     * invention, it is the last source frame's own display interval.
     *
     * A hold that genuinely should not be there comes from a *false* cut
     * detected inside continuous motion, and the fix for that is detection,
     * not this.
     */
    const anchor = count === 0 ? 'none'
      : (isLastShot && hasNextFrame) ? 'next'
        : 'duplicate';

    let mode;
    if (count === 0) mode = 'skip';
    else if (inputFrames < 2) mode = 'hold';
    else if (count === inputFrames && Math.abs(dst - src) < 0.001) mode = 'copy';
    else mode = 'rife';

    /*
     * How many samples to ask RIFE for, and why it is not `count + 1`.
     *
     * RIFE spreads N samples evenly across the images it is given, so the
     * spacing it uses is (images - 1) / (N - 1) source frames per sample. For
     * playback to run at 1x that spacing must be exactly fpsSrc / fpsDst.
     *
     * Asking for `count + 1` made the spacing depend on `count`, which is the
     * *rounded* number of output frames this shot happens to occupy. A shot
     * whose count rounded up came out slow; one that rounded down came out
     * fast. Measured on 23.976 -> 60: a 12-frame shot ran at 0.969x, a
     * 24-frame shot at 0.984x, and the error grows as shots get shorter — so
     * on a fast-cut music video the speed changes every second or so. That is
     * the "fast-forwarded in places" report, and it survives every check that
     * looks at frame counts, frame rate or total duration, because all three
     * are correct.
     *
     * Deriving N from the rate ratio instead pins the spacing to fpsSrc/fpsDst
     * for every shot, whatever its length.
     */
    const spacingSamples = 1 + Math.round((inputFrames * dst) / src);
    const requestFrames = mode === 'rife' ? Math.max(count, spacingSamples) : count;

    planned.push({
      index: planned.length,
      startFrame: shot.startFrame,
      endFrame: shot.endFrame,
      inputFrames,
      anchor,
      requestFrames,
      // Keep the first `count`; anything past them belongs to the next shot.
      dropTrailing: mode === 'rife' ? Math.max(0, requestFrames - count) : 0,
      outputStart: jStart,
      outputCount: count,
      mode,
      startsAfterCut: s > 0
    });
    assigned = jEnd;
  }

  const total = planned.reduce((sum, s) => sum + s.outputCount, 0);
  if (total !== outputCount) {
    // Should be unreachable; if it ever fires the output would drift, so say so
    // loudly rather than shipping a silently desynced render.
    warnings.push(`Interpolation plan produced ${total} frames for ${outputCount} expected.`);
  }

  if (!arbitraryTimestep) {
    const ratio = dst / src;
    const isPowerOfTwo = Math.abs(ratio - Math.pow(2, Math.round(Math.log2(ratio)))) < 0.01;
    if (!isPowerOfTwo) {
      warnings.push(
        'The installed RIFE model only doubles frame rates exactly; this conversion will be approximate.'
      );
    }
  }

  const holds = planned.filter((s) => s.mode === 'hold').length;
  if (holds) warnings.push(`${holds} single-frame shot(s) were held rather than interpolated.`);

  return { outputCount, duration, shots: planned, warnings };
}

/**
 * Which source frames a chunk must decode, including the trailing anchor.
 * Kept separate so the extractor and the planner cannot disagree about it.
 */
function sourceFrameRange(plan, frameCount) {
  const needsNext = plan.shots.some((s) => s.anchor === 'next');
  return { first: 0, last: frameCount - 1, anchorFrame: needsNext ? frameCount : null };
}

/**
 * Total output frames for a whole render, used for progress and for the
 * expected duration the verifier checks against.
 */
function totalOutputFrames(durationSeconds, fpsDst) {
  return Math.max(1, Math.round(Number(durationSeconds) * Number(fpsDst)));
}

module.exports = {
  planInterpolation,
  cutsToFrameIndices,
  normaliseCutFrames,
  sourceFrameRange,
  totalOutputFrames
};
