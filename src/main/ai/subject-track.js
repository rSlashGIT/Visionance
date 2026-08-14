'use strict';

/**
 * Turning detections into a subject.
 *
 * This file is pure arithmetic over boxes: no ONNX, no ffmpeg, no I/O. That is
 * deliberate, because the policy is the part that decides whether a reframe
 * looks composed or looks drunk, and it has to be testable without a GPU or a
 * model. `verify:reframe` drives every scenario here with synthetic detections.
 *
 * The shape of the problem
 * ------------------------
 * A detector gives independent boxes per frame with no notion of identity.
 * Choosing the highest-scoring box each sample produces exactly the failure
 * this is written to avoid: two people in shot, confidence flickers between
 * them, and the crop ping-pongs. So detections are associated into *tracks*,
 * one track is elected the subject with hysteresis, and the crop follows the
 * subject rather than the argmax.
 *
 * Priority, in order:
 *
 *   manual > stable face > stable person > semantic track > saliency >
 *   previous stable crop > centre
 *
 * Saliency is not demoted to a legacy path. It remains the right answer for
 * gameplay, vehicles, wide action and anything non-human, and it fills the gaps
 * between semantic samples. What changed is that a stationary person no longer
 * loses to moving foliage.
 */

/* ------------------------------------------------------------------ *
 * Geometry helpers - all boxes are normalised 0..1 of the frame
 * ------------------------------------------------------------------ */

function centreOf(box) {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/** Is `inner` mostly inside `outer`? Used for face-in-person association. */
function containment(inner, outer) {
  const x1 = Math.max(inner.x, outer.x);
  const y1 = Math.max(inner.y, outer.y);
  const x2 = Math.min(inner.x + inner.w, outer.x + outer.w);
  const y2 = Math.min(inner.y + inner.h, outer.y + outer.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const area = inner.w * inner.h;
  return area > 0 ? inter / area : 0;
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

/* ------------------------------------------------------------------ *
 * Sampling plan
 * ------------------------------------------------------------------ */

/** Saliency grid rate, matching the existing tracker. */
const SALIENCY_FPS = 4;
/**
 * Upper bound on semantic inference calls for one clip.
 *
 * At ~120 ms for both models on the reference CPU, 150 calls is about 18
 * seconds of analysis for a source of any length. A 10-second clip lands on
 * the full 4 fps grid; a five-minute one samples every two seconds, which is
 * still far finer than subject position changes.
 */
const MAX_SEMANTIC_SAMPLES = 150;

/**
 * @returns {{intervalSeconds:number, count:number, everyNthSaliency:number}}
 */
function planSemanticSampling(durationSeconds) {
  const duration = Math.max(0.25, Number(durationSeconds) || 0);
  const finest = 1 / SALIENCY_FPS;
  let interval = Math.max(finest, duration / MAX_SEMANTIC_SAMPLES);
  // Snap to a multiple of the saliency grid so semantic samples land *on*
  // canonical samples. Otherwise every semantic result would be attributed to
  // a sample it does not quite belong to.
  const everyNth = Math.max(1, Math.round(interval / finest));
  interval = everyNth * finest;
  return {
    intervalSeconds: interval,
    count: Math.max(1, Math.floor(duration / interval)),
    everyNthSaliency: everyNth
  };
}

/* ------------------------------------------------------------------ *
 * Tracks
 * ------------------------------------------------------------------ */

/** How the crop position was decided for one sample. */
const SOURCES = ['face', 'person', 'saliency', 'hold', 'centre'];

const PROFILE_TUNING = {
  // `switchMargin`  how much better a challenger must be to steal the subject
  // `switchHold`    consecutive samples it must stay better
  // `maxMisses`     samples a track survives unseen before it is dropped
  film: { switchMargin: 0.35, switchHold: 4, maxMisses: 10, salienceWeight: 0.25 },
  dialogue: { switchMargin: 0.4, switchHold: 5, maxMisses: 12, salienceWeight: 0.15 },
  action: { switchMargin: 0.18, switchHold: 2, maxMisses: 6, salienceWeight: 0.6 },
  gaming: { switchMargin: 0.5, switchHold: 6, maxMisses: 4, salienceWeight: 0.85 },
  animation: { switchMargin: 0.3, switchHold: 3, maxMisses: 8, salienceWeight: 0.55 },
  screencast: { switchMargin: 0.45, switchHold: 5, maxMisses: 8, salienceWeight: 0.5 },
  lowlight: { switchMargin: 0.3, switchHold: 3, maxMisses: 8, salienceWeight: 0.4 },
  auto: { switchMargin: 0.28, switchHold: 3, maxMisses: 8, salienceWeight: 0.4 }
};

function tuningFor(profile) {
  return PROFILE_TUNING[profile] || PROFILE_TUNING.auto;
}

/**
 * Associates detections over time and elects one subject.
 *
 * Not an extended Kalman filter and not trying to be: subject position at 2-4
 * samples a second is a slow, smooth signal, and the expensive machinery would
 * buy accuracy that the crop smoothing throws away anyway.
 */
class SubjectTracker {
  constructor({ profile = 'auto' } = {}) {
    this.tuning = tuningFor(profile);
    this.profile = profile;
    this.tracks = [];
    this.nextId = 1;
    this.subjectId = null;
    this.challengerId = null;
    this.challengerRuns = 0;
  }

  /** A hard cut invalidates identity: nothing survives it. */
  reset() {
    this.tracks = [];
    this.subjectId = null;
    this.challengerId = null;
    this.challengerRuns = 0;
  }

  /**
   * Fold one semantic observation into the tracks.
   *
   * @param {object} o
   *   time     {number}
   *   faces    {Array} normalised boxes
   *   persons  {Array} normalised boxes
   * @returns {{subject:object|null, source:'face'|'person'|null}}
   */
  observe({ time, faces = [], persons = [] }) {
    /* ---- 1. fuse faces into persons ---- */
    // A face inside a person box is the same human. Keeping them as one
    // observation is what lets the person carry the track when the face turns
    // away, which is the single most common detector miss in real footage.
    const observations = [];
    const usedFaces = new Set();

    for (const person of persons) {
      let best = null;
      let bestIdx = -1;
      for (let i = 0; i < faces.length; i++) {
        if (usedFaces.has(i)) continue;
        const c = containment(faces[i], person);
        // A face must be substantially inside the body, and in its upper half:
        // a face overlapping someone else's torso is not that person's face.
        const faceCentre = centreOf(faces[i]);
        const upper = faceCentre.y < person.y + person.h * 0.55;
        if (c > 0.6 && upper && (!best || faces[i].score > best.score)) {
          best = faces[i];
          bestIdx = i;
        }
      }
      if (bestIdx >= 0) usedFaces.add(bestIdx);
      observations.push({ person, face: best, box: best || person });
    }
    // A face with no person box is still a subject - the body may be cropped
    // out of frame entirely, which is normal in an interview close-up.
    for (let i = 0; i < faces.length; i++) {
      if (usedFaces.has(i)) continue;
      observations.push({ person: null, face: faces[i], box: faces[i] });
    }

    /* ---- 2. associate with existing tracks ---- */
    const unmatched = new Set(this.tracks.map((t) => t.id));
    for (const obs of observations) {
      const anchor = obs.person || obs.face;
      let best = null;
      let bestScore = 0;
      for (const track of this.tracks) {
        if (!unmatched.has(track.id)) continue;
        const score = this._affinity(track, obs, anchor);
        if (score > bestScore) { bestScore = score; best = track; }
      }
      // 0.25 is deliberately forgiving: a subject that moved a long way
      // between samples should continue the same identity rather than
      // spawning a rival that then fights it for the crop.
      if (best && bestScore > 0.25) {
        unmatched.delete(best.id);
        this._update(best, obs, time);
      } else {
        this.tracks.push(this._create(obs, time));
      }
    }

    /* ---- 3. age out what was not seen ---- */
    for (const track of this.tracks) {
      if (unmatched.has(track.id)) {
        track.misses++;
        track.hasFace = false;
      }
    }
    this.tracks = this.tracks.filter((t) => t.misses <= this.tuning.maxMisses);

    /* ---- 4. elect a subject ---- */
    return this._elect(time);
  }

  _affinity(track, obs, anchor) {
    const overlap = iou(track.box, anchor);
    const tc = centreOf(track.box);
    const oc = centreOf(anchor);
    const dist = Math.hypot(tc.x - oc.x, tc.y - oc.y);
    // Distance tolerance scales with the subject: a large subject moving 10%
    // of frame is the same person; a tiny one probably is not.
    const tolerance = Math.max(0.08, track.box.w * 1.5);
    const proximity = Math.max(0, 1 - dist / tolerance);
    const sizeRatio = Math.min(track.box.w, anchor.w) / Math.max(track.box.w, anchor.w || 1e-6);
    return overlap * 0.5 + proximity * 0.35 + sizeRatio * 0.15;
  }

  _create(obs, time) {
    return {
      id: this.nextId++,
      box: obs.person || obs.face,
      face: obs.face || null,
      person: obs.person || null,
      hasFace: !!obs.face,
      faceEver: !!obs.face,
      hits: 1,
      misses: 0,
      firstSeen: time,
      lastSeen: time,
      score: (obs.face || obs.person).score
    };
  }

  _update(track, obs, time) {
    track.box = obs.person || obs.face;
    track.face = obs.face || null;
    track.person = obs.person || null;
    track.hasFace = !!obs.face;
    if (obs.face) track.faceEver = true;
    track.hits++;
    track.misses = 0;
    track.lastSeen = time;
    // Slow EMA: one bad frame should not unseat a subject.
    track.score = track.score * 0.7 + (obs.face || obs.person).score * 0.3;
  }

  /**
   * How good a subject is this track? Bigger, more central, more confident and
   * more persistent all help; a visible face helps a great deal, because a
   * face is what a viewer looks at.
   */
  _quality(track) {
    const c = centreOf(track.box);
    const area = Math.sqrt(Math.max(0, track.box.w * track.box.h));
    const centrality = 1 - Math.min(1, Math.abs(c.x - 0.5) * 2);
    const persistence = Math.min(1, track.hits / 6);
    return (
      area * 0.9 +
      centrality * 0.35 +
      track.score * 0.5 +
      persistence * 0.4 +
      (track.hasFace ? 0.7 : 0) +
      (track.faceEver ? 0.15 : 0) -
      track.misses * 0.12
    );
  }

  /**
   * Pick the subject, and be reluctant about changing it.
   *
   * Without hysteresis a two-person dialogue alternates every time confidence
   * wobbles, which is the exact "speaker ping-pong" that makes automatic
   * reframing unwatchable.
   */
  _elect(time) {
    if (!this.tracks.length) {
      this.subjectId = null;
      return { subject: null, source: null };
    }

    const ranked = [...this.tracks].sort((a, b) => this._quality(b) - this._quality(a));
    const leader = ranked[0];
    const incumbent = this.tracks.find((t) => t.id === this.subjectId) || null;

    if (!incumbent) {
      this.subjectId = leader.id;
      this.challengerId = null;
      this.challengerRuns = 0;
    } else if (leader.id !== incumbent.id) {
      const margin = this._quality(leader) - this._quality(incumbent);
      if (margin > this.tuning.switchMargin) {
        // Sustained superiority, not one lucky frame.
        if (this.challengerId === leader.id) this.challengerRuns++;
        else { this.challengerId = leader.id; this.challengerRuns = 1; }
        if (this.challengerRuns >= this.tuning.switchHold) {
          this.subjectId = leader.id;
          this.challengerId = null;
          this.challengerRuns = 0;
        }
      } else {
        this.challengerId = null;
        this.challengerRuns = 0;
      }
    } else {
      this.challengerId = null;
      this.challengerRuns = 0;
    }

    const subject = this.tracks.find((t) => t.id === this.subjectId) || null;
    if (!subject || subject.misses > 0) return { subject, source: null };
    return { subject, source: subject.hasFace ? 'face' : 'person' };
  }

  /**
   * Where should the crop centre be, given the elected subject?
   *
   * Not simply the subject's centre. Two people who both fit are framed
   * together rather than one being chosen; a face gets look-room in the
   * direction it faces rather than being nailed to the middle.
   *
   * @param {object} subject
   * @param {number} cropWidthFraction  crop width as a fraction of source width
   */
  compose(subject, cropWidthFraction) {
    if (!subject) return null;
    const width = Math.min(1, Math.max(0.05, cropWidthFraction || 1));

    /* ---- group framing ---- */
    // If another confident track sits close enough that both fit inside the
    // crop, centre on the pair. Cutting one person out of a two-shot is a
    // worse error than a slightly off-centre subject.
    const others = this.tracks.filter((t) => t.id !== subject.id && t.misses === 0 && t.hits >= 2);
    let focus = centreOf(subject.box).x;
    let grouped = false;
    for (const other of others) {
      const oc = centreOf(other.box).x;
      const lo = Math.min(focus, oc) - Math.max(subject.box.w, other.box.w) / 2;
      const hi = Math.max(focus, oc) + Math.max(subject.box.w, other.box.w) / 2;
      if (hi - lo <= width * 0.98 && this._quality(other) > this._quality(subject) - 0.9) {
        focus = (lo + hi) / 2;
        grouped = true;
        break;
      }
    }

    /* ---- look-room ---- */
    // A face looking left wants space on the left. The eye landmarks give the
    // direction for free; without them the crop is simply centred, which is
    // acceptable rather than wrong.
    if (!grouped && subject.face && subject.face.landmarks && subject.face.landmarks.length >= 2) {
      const face = subject.face;
      const fc = centreOf(face);
      const eyeMid = (face.landmarks[0].x + face.landmarks[1].x) / 2;
      // Positive means facing right-of-centre within their own face.
      const gaze = (eyeMid - fc.x) / Math.max(1e-6, face.w);
      const lookRoom = Math.max(-1, Math.min(1, gaze * 2)) * width * 0.12;
      focus += lookRoom;
    }

    return { x: clamp01(focus), grouped };
  }
}

/* ------------------------------------------------------------------ *
 * Fusion
 * ------------------------------------------------------------------ */

/**
 * Decide one sample's focal point from everything available.
 *
 * The order here *is* the priority list, and every branch records which
 * signal actually decided, so the queue can never claim face tracking for a
 * trajectory that came from saliency.
 *
 * @param {object} o
 *   semantic   {{subject, source, focus}|null}  from SubjectTracker
 *   saliency   {{center, confidence}|null}
 *   previous   {number|null}  last committed focus
 *   minSaliencyConfidence {number}
 * @returns {{center:number|null, source:string}}
 */
function fuseSample({ semantic = null, saliency = null, previous = null, minSaliencyConfidence = 0.18 }) {
  if (semantic && semantic.source && semantic.focus != null) {
    return { center: semantic.focus, source: semantic.source };
  }
  if (saliency && saliency.confidence >= minSaliencyConfidence) {
    return { center: saliency.center, source: 'saliency' };
  }
  if (previous != null) {
    return { center: previous, source: 'hold' };
  }
  return { center: 0.5, source: 'centre' };
}

module.exports = {
  SubjectTracker,
  fuseSample,
  planSemanticSampling,
  centreOf,
  iou,
  containment,
  tuningFor,
  PROFILE_TUNING,
  SOURCES,
  SALIENCY_FPS,
  MAX_SEMANTIC_SAMPLES
};
