'use strict';

/**
 * Semantic detection: faces and people, locally, on the CPU.
 *
 * Everything here is pure arithmetic over tensors plus one optional native
 * dependency. The decoding is written against output shapes that were
 * *measured* by running the models, not recalled from documentation - see the
 * comments on each decoder for the exact shapes.
 *
 * Memory discipline (this runs on an 8 GB laptop): one frame is in flight at a
 * time. A frame arrives as a letterboxed RGB buffer, is converted into the
 * input tensor, inferred, reduced to a handful of boxes, and dropped. Nothing
 * accumulates except the boxes.
 */

const path = require('path');
const fs = require('fs');
const { logger } = require('./../logger');
const semantic = require('./engines/semantic');

const log = logger.child('detect');

/**
 * The two models want different square inputs, and both are *fixed* - neither
 * accepts an arbitrary size. Measured by running them: YuNet rejects anything
 * but 640, NanoDet anything but 416.
 *
 * So one frame is decoded at 640 and box-downscaled to 416 in JS for NanoDet.
 * That is one ffmpeg decode per sample rather than two, and the letterbox
 * transform is identical for both because both are the same square fit.
 */
const FACE_SIZE = 640;
const PERSON_SIZE = 416;
/** What the frame source is asked to produce. */
const INPUT_SIZE = FACE_SIZE;

/**
 * NanoDet's exported graph does **not** carry its normalisation, so it has to
 * happen here: ImageNet BGR mean/std. Feeding raw 0-255 instead scores a
 * portrait's person box at stride 8 (a small object) rather than stride 32 (a
 * large one) - it "finds" something with the wrong geometry, which is worse
 * than finding nothing. Determined by comparing all four combinations.
 */
const NANODET_MEAN = [103.53, 116.28, 123.675];
const NANODET_STD = [57.375, 57.12, 58.395];

/**
 * Load ONNX Runtime, or explain why not.
 *
 * Deliberately lazy and deliberately soft: a missing runtime must degrade
 * Smart Reframe to saliency, never fail an export. The require is wrapped
 * because a native binding can fail at load time for reasons that have nothing
 * to do with this application (a missing VC++ runtime, a blocked DLL).
 */
let ortCache;
function loadRuntime() {
  if (ortCache !== undefined) return ortCache;
  try {
    // eslint-disable-next-line global-require
    const ort = require('onnxruntime-node');
    // Quiet: the models trip a benign "initializer appears in graph inputs"
    // warning that would otherwise be printed once per session creation.
    try { ort.env.logLevel = 'error'; } catch { /* older builds */ }
    ortCache = { ok: true, ort };
  } catch (err) {
    ortCache = { ok: false, error: err && err.message ? err.message : String(err) };
    log.warn('onnxruntime unavailable', { error: ortCache.error });
  }
  return ortCache;
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/**
 * Letterbox transform from source pixels into the square analysis input.
 *
 * Returned so detections can be mapped *back* exactly. Scaling to a square
 * without this would stretch faces and shift every box.
 */
function letterbox(srcW, srcH, size = FACE_SIZE) {
  const scale = Math.min(size / srcW, size / srcH);
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  return { scale, drawW: w, drawH: h, padX: Math.floor((size - w) / 2), padY: Math.floor((size - h) / 2), size };
}

/** Analysis-space box -> normalised source-space box (0..1). */
function unletterbox(box, lb) {
  const x = (box.x - lb.padX) / lb.scale;
  const y = (box.y - lb.padY) / lb.scale;
  const w = box.w / lb.scale;
  const h = box.h / lb.scale;
  const srcW = lb.drawW / lb.scale;
  const srcH = lb.drawH / lb.scale;
  return {
    ...box,
    x: x / srcW,
    y: y / srcH,
    w: w / srcW,
    h: h / srcH
  };
}

/* ------------------------------------------------------------------ *
 * Non-maximum suppression
 * ------------------------------------------------------------------ */

function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

function nms(boxes, threshold = 0.4, limit = 20) {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const keep = [];
  for (const box of sorted) {
    if (keep.length >= limit) break;
    if (keep.some((k) => iou(k, box) > threshold)) continue;
    keep.push(box);
  }
  return keep;
}

/* ------------------------------------------------------------------ *
 * YuNet - faces
 *
 * Measured outputs, per stride s in {8, 16, 32} over an SxS input:
 *   cls_s  [1, N, 1]   classification logit-ish score, already in 0..1
 *   obj_s  [1, N, 1]   objectness, already in 0..1
 *   bbox_s [1, N, 4]   cx, cy offsets in cell units; w, h as log-scale
 *   kps_s  [1, N, 10]  five landmarks, same cell units
 * with N = (S/s)^2 in row-major order.
 *
 * The published score is the geometric mean of cls and obj, which is why a
 * face barely visible to one head does not survive on the other's confidence.
 * ------------------------------------------------------------------ */

function decodeYuNet(results, size, minScore) {
  const boxes = [];
  for (const stride of [8, 16, 32]) {
    const cls = results[`cls_${stride}`];
    const obj = results[`obj_${stride}`];
    const bbox = results[`bbox_${stride}`];
    const kps = results[`kps_${stride}`];
    if (!cls || !obj || !bbox) continue;

    const cols = Math.floor(size / stride);
    const count = cols * cols;
    const clsData = cls.data;
    const objData = obj.data;
    const boxData = bbox.data;
    const kpsData = kps ? kps.data : null;

    for (let i = 0; i < count; i++) {
      const score = Math.sqrt(Math.max(0, clsData[i]) * Math.max(0, objData[i]));
      if (score < minScore) continue;

      const col = i % cols;
      const row = Math.floor(i / cols);
      const o = i * 4;
      const cx = (col + boxData[o]) * stride;
      const cy = (row + boxData[o + 1]) * stride;
      const w = Math.exp(boxData[o + 2]) * stride;
      const h = Math.exp(boxData[o + 3]) * stride;

      const box = { x: cx - w / 2, y: cy - h / 2, w, h, score, kind: 'face' };

      // The eye landmarks tell us which way the subject is facing, which is
      // what look-room needs. Landmark order is right eye, left eye, nose,
      // right mouth, left mouth.
      if (kpsData) {
        const k = i * 10;
        box.landmarks = [];
        for (let p = 0; p < 5; p++) {
          box.landmarks.push({
            x: (col + kpsData[k + p * 2]) * stride,
            y: (row + kpsData[k + p * 2 + 1]) * stride
          });
        }
      }
      boxes.push(box);
    }
  }
  return boxes;
}

/* ------------------------------------------------------------------ *
 * NanoDet-Plus - people
 *
 * Measured outputs at 416x416, three strides {8, 16, 32}:
 *   cls [1, 2704, 80]  [1, 676, 80]  [1, 169, 80]
 *   reg [1, 2704, 32]  [1, 676, 32]  [1, 169, 32]
 * 2704 = 52^2, 676 = 26^2, 169 = 13^2. Class 0 of the 80 COCO classes is
 * `person`; the other 79 are decoded and discarded, which costs nothing
 * because only the one column is read.
 *
 * `reg` is a Generalized Focal Loss distribution: 4 sides x 8 bins. Each
 * side's distance is the softmax-weighted expectation of the bin indices,
 * in stride units, measured from the cell centre. That integral step is the
 * part that is easy to get wrong, so it is written out plainly below.
 * ------------------------------------------------------------------ */

const NANODET_BINS = 8;   // regMax 7, inclusive

function decodeNanoDet(results, outputNames, size, minScore) {
  const boxes = [];
  const strides = [8, 16, 32];

  for (let s = 0; s < strides.length; s++) {
    const stride = strides[s];
    const cls = results[outputNames[s]];
    const reg = results[outputNames[s + 3]];
    if (!cls || !reg) continue;

    const cols = Math.floor(size / stride);
    const count = cols * cols;
    const numClasses = cls.dims[2];
    const clsData = cls.data;
    const regData = reg.data;

    for (let i = 0; i < count; i++) {
      const score = clsData[i * numClasses + semantic.modelById('person').personClass];
      if (score < minScore) continue;

      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = (col + 0.5) * stride;
      const cy = (row + 0.5) * stride;

      // Four sides: left, top, right, bottom.
      const dist = [0, 0, 0, 0];
      for (let side = 0; side < 4; side++) {
        const base = i * 32 + side * NANODET_BINS;
        // Softmax over the eight bins...
        let max = -Infinity;
        for (let b = 0; b < NANODET_BINS; b++) max = Math.max(max, regData[base + b]);
        let sum = 0;
        const exp = new Array(NANODET_BINS);
        for (let b = 0; b < NANODET_BINS; b++) {
          exp[b] = Math.exp(regData[base + b] - max);
          sum += exp[b];
        }
        // ...then the expectation, which is the distance in stride units.
        let acc = 0;
        for (let b = 0; b < NANODET_BINS; b++) acc += (b * exp[b]) / sum;
        dist[side] = acc * stride;
      }

      const x1 = cx - dist[0];
      const y1 = cy - dist[1];
      const x2 = cx + dist[2];
      const y2 = cy + dist[3];
      boxes.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1, score, kind: 'person' });
    }
  }
  return boxes;
}


/** Analysis-square pixels -> 0..1 of that square, so callers are size-agnostic. */
function normaliseBox(box, size) {
  const out = {
    ...box,
    x: box.x / size,
    y: box.y / size,
    w: box.w / size,
    h: box.h / size
  };
  if (box.landmarks) {
    out.landmarks = box.landmarks.map((p) => ({ x: p.x / size, y: p.y / size }));
  }
  return out;
}

/**
 * Box-average downscale of a square RGB buffer.
 *
 * Bilinear would be marginally better and measurably slower; at 640 -> 416 on
 * a detector input the difference is not observable in the boxes, and this
 * keeps one decode serving both models.
 */
function downscaleRgb(rgb, from, to) {
  const out = Buffer.allocUnsafe(to * to * 3);
  const ratio = from / to;
  for (let y = 0; y < to; y++) {
    const sy0 = Math.floor(y * ratio);
    const sy1 = Math.min(from, Math.floor((y + 1) * ratio));
    for (let x = 0; x < to; x++) {
      const sx0 = Math.floor(x * ratio);
      const sx1 = Math.min(from, Math.floor((x + 1) * ratio));
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const o = (sy * from + sx) * 3;
          r += rgb[o]; g += rgb[o + 1]; b += rgb[o + 2]; n++;
        }
      }
      const d = (y * to + x) * 3;
      out[d] = n ? r / n : 0;
      out[d + 1] = n ? g / n : 0;
      out[d + 2] = n ? b / n : 0;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The detector
 * ------------------------------------------------------------------ */

class SemanticDetector {
  constructor({ modelsDir, faceThreshold = 0.6, personThreshold = 0.35 }) {
    this.modelsDir = modelsDir;
    this.faceThreshold = faceThreshold;
    this.personThreshold = personThreshold;
    this.sessions = {};
    this.ready = false;
    this.backend = null;
    this.error = null;
    this.stats = { frames: 0, inferenceMs: 0, faces: 0, persons: 0 };
  }

  /**
   * @returns {Promise<boolean>} whether semantic detection can run at all.
   * Never throws: the caller falls back to saliency.
   */
  async load() {
    const runtime = loadRuntime();
    if (!runtime.ok) {
      this.error = `ONNX Runtime is unavailable (${runtime.error}).`;
      return false;
    }
    this.ort = runtime.ort;

    for (const model of semantic.MODELS) {
      const file = path.join(this.modelsDir, model.file);
      if (!fs.existsSync(file)) {
        this.error = `The ${model.label} model is not installed.`;
        return false;
      }
      try {
        this.sessions[model.id] = await this.ort.InferenceSession.create(file, {
          // CPU is the honest default: it is fast enough at this sample rate
          // and it works on every machine. A GPU provider adds 38 MB and a
          // class of driver-specific failures for a workload measured in
          // seconds per clip.
          executionProviders: ['cpu'],
          graphOptimizationLevel: 'all',
          logSeverityLevel: 4
        });
      } catch (err) {
        this.error = `The ${model.label} model could not be loaded (${err.message}).`;
        this.dispose();
        return false;
      }
    }

    this.backend = 'onnxruntime-cpu';
    this.ready = true;
    return true;
  }

  /**
   * Detect on one letterboxed RGB frame.
   *
   * @param {Buffer|Uint8Array} rgb  FACE_SIZE * FACE_SIZE * 3 bytes, RGB
   * @returns {Promise<{faces:Array, persons:Array}>} boxes in *normalised*
   *   analysis space (0..1 of the letterboxed square), so the caller does not
   *   have to know which model produced which pixel grid.
   */
  async detect(rgb) {
    if (!this.ready) return { faces: [], persons: [] };
    const started = Date.now();

    let faces = [];
    let persons = [];

    /* ---- faces: 640, BGR, raw 0-255 ---- */
    try {
      const model = semantic.modelById('face');
      const tensor = this._tensor(rgb, FACE_SIZE, FACE_SIZE, null, null);
      const out = await this.sessions.face.run({ [model.inputName]: tensor });
      faces = nms(decodeYuNet(out, FACE_SIZE, this.faceThreshold), 0.3, 8)
        .map((b) => normaliseBox(b, FACE_SIZE));
    } catch (err) {
      // Not silent: a shape or provider error here means the whole face path
      // is dead, and swallowing it is how "0 faces" looked like "no faces".
      this.faceError = err.message;
      log.warn('face inference failed', { error: err.message });
    }

    /* ---- people: 416, BGR, mean/std normalised ---- */
    try {
      const model = semantic.modelById('person');
      const small = downscaleRgb(rgb, FACE_SIZE, PERSON_SIZE);
      const tensor = this._tensor(small, PERSON_SIZE, PERSON_SIZE, NANODET_MEAN, NANODET_STD);
      const out = await this.sessions.person.run({ [model.inputName]: tensor });
      persons = nms(decodeNanoDet(out, model.outputs, PERSON_SIZE, this.personThreshold), 0.45, 8)
        .map((b) => normaliseBox(b, PERSON_SIZE));
    } catch (err) {
      this.personError = err.message;
      log.warn('person inference failed', { error: err.message });
    }

    this.stats.frames++;
    this.stats.inferenceMs += Date.now() - started;
    this.stats.faces += faces.length;
    this.stats.persons += persons.length;

    return { faces, persons };
  }

  /**
   * RGB bytes -> NCHW float tensor in **BGR** channel order.
   *
   * Both models were trained on OpenCV input, which is BGR. Feeding RGB is not
   * a catastrophic failure - it still detects things - which is exactly what
   * makes it dangerous: it degrades quietly.
   */
  _tensor(rgb, w, h, mean, std) {
    const px = w * h;
    const data = new Float32Array(3 * px);
    for (let i = 0; i < px; i++) {
      const b = rgb[i * 3 + 2];
      const g = rgb[i * 3 + 1];
      const r = rgb[i * 3];
      if (mean) {
        data[i] = (b - mean[0]) / std[0];
        data[px + i] = (g - mean[1]) / std[1];
        data[px * 2 + i] = (r - mean[2]) / std[2];
      } else {
        data[i] = b;
        data[px + i] = g;
        data[px * 2 + i] = r;
      }
    }
    return new this.ort.Tensor('float32', data, [1, 3, h, w]);
  }

  dispose() {
    for (const key of Object.keys(this.sessions)) {
      try {
        const s = this.sessions[key];
        if (s && typeof s.release === 'function') s.release();
      } catch { /* best effort */ }
    }
    this.sessions = {};
    this.ready = false;
  }
}

/**
 * Is the semantic layer installable/usable right now?
 * Cheap enough to call from a status handler.
 */
function probe(modelsDir) {
  const runtime = loadRuntime();
  const missing = semantic.MODELS
    .filter((m) => !fs.existsSync(path.join(modelsDir, m.file)))
    .map((m) => m.id);
  return {
    runtime: runtime.ok,
    runtimeError: runtime.ok ? null : runtime.error,
    missingModels: missing,
    ready: runtime.ok && missing.length === 0
  };
}

module.exports = {
  SemanticDetector,
  probe,
  loadRuntime,
  letterbox,
  unletterbox,
  nms,
  iou,
  decodeYuNet,
  decodeNanoDet,
  downscaleRgb,
  normaliseBox,
  INPUT_SIZE,
  FACE_SIZE,
  PERSON_SIZE
};
