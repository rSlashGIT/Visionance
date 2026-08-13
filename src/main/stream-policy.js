'use strict';

/**
 * How good a stream should Watch actually ask for?
 *
 * yt-dlp will happily hand back 1440p or 2160p, and taking it is usually the
 * wrong call. On the reference laptop (Intel iGPU driving the display, 8 GB
 * RAM) a 1440p stream decoded into a ~900 px viewport costs a great deal of
 * decode bandwidth and memory to produce pixels nobody can see - and the same
 * video on youtube.com looks smoother precisely because YouTube picks a
 * sensible rendition for the window.
 *
 * The requirement therefore comes from the **viewport**, and the display is a
 * *ceiling* on it, never a floor. An earlier version took
 * `max(viewport, screen)`, which meant a 900 px window on a 1440p panel always
 * asked for 1440p - Auto could never choose anything smaller than the monitor,
 * which is exactly the defect this rewrite fixes.
 *
 * Deliberately pure and electron-free so the policy is unit-testable.
 */

/** Rungs a site is likely to offer; we snap to one of these. */
const LADDER = [360, 480, 720, 1080, 1440, 2160, 4320];

/**
 * How far below the requirement a rendition may sit and still be chosen.
 *
 * Without this, a 1150 px requirement jumps to 1440p - 78% more pixels to
 * decode to cover a 6% shortfall. Seven percent of vertical resolution is not
 * visible on moving video; the decode cost of the next rung up very much is.
 */
const TOLERANCE = 0.07;

/**
 * The smallest rung that adequately covers `needed` pixels of height.
 * @param {number} needed
 */
function snapUp(needed) {
  const floor = needed * (1 - TOLERANCE);
  for (const rung of LADDER) {
    if (rung >= floor) return rung;
  }
  return LADDER[LADDER.length - 1];
}

/**
 * @param {object} o
 *   viewportWidth/Height   CSS pixels of the video area
 *   devicePixelRatio
 *   screenWidth/Height     the display, in CSS pixels - a ceiling, not a floor
 *   userMaxHeight          the user's explicit cap (0/null = no cap)
 *   enhancement            is realtime enhancement on?
 *   watchQuality           'auto'|'performance'|'balanced'|'quality'|'maximum'
 *   hardwareDecode         boolean|null - null means unknown
 *   sourceFps              nominal fps of the best rendition, if known
 * @returns {{maxHeight:number, reason:string, ceiling:number|null,
 *            requirement:number|null, notes:string[], source:string}}
 */
function chooseStreamHeight({
  viewportWidth = 0,
  viewportHeight = 0,
  devicePixelRatio = 1,
  screenWidth = 0,
  screenHeight = 0,
  userMaxHeight = 0,
  enhancement = false,
  watchQuality = 'auto',
  hardwareDecode = null,
  sourceFps = 0
} = {}) {
  const notes = [];

  // An explicit user cap is a decision, not a hint: honour it exactly.
  if (userMaxHeight && userMaxHeight > 0) {
    return {
      maxHeight: userMaxHeight,
      ceiling: userMaxHeight,
      requirement: null,
      reason: 'user-set maximum',
      source: 'user',
      notes
    };
  }

  const dpr = Math.min(Math.max(Number(devicePixelRatio) || 1, 1), 3);

  // Device pixels the video area actually occupies right now.
  const viewport = Math.round((Number(viewportHeight) || 0) * dpr);
  // Device pixels the panel can show at all. Nothing above this can ever be
  // seen, not even in fullscreen, so it is a hard ceiling.
  const panel = Math.round((Number(screenHeight) || 0) * dpr);

  let requirement = viewport > 0 ? viewport : 0;
  if (requirement > 0 && panel > 0) requirement = Math.min(requirement, panel);

  let target;
  if (requirement > 0) {
    target = snapUp(requirement);
    notes.push(
      `viewport ${viewportWidth}×${viewportHeight} at ${dpr}× shows about ` +
      `${requirement} lines, so ${target}p covers it`
    );
  } else {
    // Nothing measurable yet: 1080p is the safe assumption, not the maximum.
    target = panel > 0 ? Math.min(snapUp(panel), 1080) : 1080;
    notes.push('window size was not reported, so 1080p was assumed');
  }

  // Never exceed the panel: those pixels cannot be displayed by anything.
  if (panel > 0) {
    const panelRung = snapUp(panel);
    if (target > panelRung) {
      target = panelRung;
      notes.push(`this display tops out at ${panelRung}p`);
    }
  }

  // Enhancement rebuilds detail, so it is better fed a clean smaller stream
  // than a bitrate-starved larger one - and it costs GPU time per source pixel.
  if (enhancement && target > 1080) {
    target = 1080;
    notes.push('realtime enhancement runs on the source pixels, so the stream is capped at 1080p');
  }

  switch (watchQuality) {
    case 'performance':
      target = Math.min(target, 720);
      notes.push('Performance mode caps the stream at 720p');
      break;
    case 'balanced':
      target = Math.min(target, 1080);
      break;
    case 'quality':
      // Quality allows one rung above what the window strictly needs, which is
      // what makes it different from Auto.
      target = Math.min(nextRung(target), 1440);
      notes.push('Quality mode allows one rung above the window requirement');
      break;
    case 'maximum':
      target = 2160;
      notes.push('Maximum mode allows up to 2160p');
      break;
    default:
      // Auto: exactly what the window needs, and never above 1440p unattended.
      target = Math.min(target, 1440);
      break;
  }

  if (hardwareDecode === false && target > 1080) {
    target = 1080;
    notes.push('no hardware video decode was reported, so the stream is capped at 1080p');
  }

  // High frame rate costs roughly as much as the next resolution rung up.
  if (sourceFps >= 50 && target > 1080 && watchQuality !== 'maximum') {
    target = 1080;
    notes.push(`${Math.round(sourceFps)} fps source: resolution capped at 1080p to keep the frame rate`);
  }

  return {
    maxHeight: target,
    ceiling: panel || null,
    requirement: requirement || null,
    reason: notes[0] || 'matched to the window',
    source: 'auto',
    notes
  };
}

function nextRung(height) {
  for (const rung of LADDER) {
    if (rung > height) return rung;
  }
  return height;
}

/**
 * A short, honest sentence about what was actually selected, for the UI.
 * Never claims a quality that was not chosen.
 */
function describeSelection(selected, decision) {
  if (!selected) return null;
  const height = selected.height ? `${selected.height}p` : 'unknown quality';
  const fps = selected.fps && selected.fps >= 50 ? `${Math.round(selected.fps)}` : '';
  const label = fps ? `${height}${fps}` : height;
  if (!decision || !decision.notes || !decision.notes.length) return label;
  return `${label} — ${decision.notes[0]}`;
}

module.exports = { chooseStreamHeight, describeSelection, LADDER, snapUp, TOLERANCE };
