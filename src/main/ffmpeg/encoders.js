'use strict';

/**
 * Encoder catalogue, detection and selection.
 *
 * Hardware encoders turn an hour-long 4K render from hours into minutes, so we
 * prefer them - but only ones ffmpeg actually reports, and only for a codec the
 * chosen container can carry.
 */

const { execFile } = require('child_process');

/** Ordered by preference within each codec. */
const HW_ENCODERS = [
  { id: 'h264_nvenc', label: 'NVIDIA NVENC (H.264)', codec: 'h264', vendor: 'nvidia' },
  { id: 'hevc_nvenc', label: 'NVIDIA NVENC (HEVC)', codec: 'hevc', vendor: 'nvidia' },
  { id: 'av1_nvenc', label: 'NVIDIA NVENC (AV1)', codec: 'av1', vendor: 'nvidia' },
  { id: 'h264_qsv', label: 'Intel Quick Sync (H.264)', codec: 'h264', vendor: 'intel' },
  { id: 'hevc_qsv', label: 'Intel Quick Sync (HEVC)', codec: 'hevc', vendor: 'intel' },
  { id: 'av1_qsv', label: 'Intel Quick Sync (AV1)', codec: 'av1', vendor: 'intel' },
  { id: 'h264_amf', label: 'AMD AMF (H.264)', codec: 'h264', vendor: 'amd' },
  { id: 'hevc_amf', label: 'AMD AMF (HEVC)', codec: 'hevc', vendor: 'amd' },
  { id: 'av1_amf', label: 'AMD AMF (AV1)', codec: 'av1', vendor: 'amd' },
  { id: 'h264_videotoolbox', label: 'Apple VideoToolbox (H.264)', codec: 'h264', vendor: 'apple' },
  { id: 'hevc_videotoolbox', label: 'Apple VideoToolbox (HEVC)', codec: 'hevc', vendor: 'apple' },
  { id: 'h264_vaapi', label: 'VA-API (H.264)', codec: 'h264', vendor: 'vaapi' },
  { id: 'hevc_vaapi', label: 'VA-API (HEVC)', codec: 'hevc', vendor: 'vaapi' }
];

const SW_ENCODERS = [
  { id: 'libx264', label: 'H.264 (CPU, most compatible)', codec: 'h264', vendor: 'cpu' },
  { id: 'libx265', label: 'HEVC (CPU, smaller files)', codec: 'hevc', vendor: 'cpu' },
  { id: 'libvpx-vp9', label: 'VP9 (CPU)', codec: 'vp9', vendor: 'cpu' },
  { id: 'libsvtav1', label: 'AV1 (CPU, SVT)', codec: 'av1', vendor: 'cpu' },
  { id: 'libaom-av1', label: 'AV1 (CPU, aom)', codec: 'av1', vendor: 'cpu' }
];

const ALL_ENCODERS = [...HW_ENCODERS, ...SW_ENCODERS];

/**
 * Ask ffmpeg which encoders this build has. Returns the intersection of the
 * catalogue and reality - never a hardcoded assumption about the machine.
 * @returns {Promise<Array<{id,label,codec,vendor,hardware:boolean}>>}
 */
function detectEncoders(ffmpegBin, { hardwareOnly = false } = {}) {
  return new Promise((resolve) => {
    if (!ffmpegBin) return resolve([]);
    execFile(
      ffmpegBin,
      ['-hide_banner', '-encoders'],
      { timeout: 20000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err && !stdout) return resolve([]);
        const text = String(stdout);
        const pool = hardwareOnly ? HW_ENCODERS : ALL_ENCODERS;
        resolve(
          pool
            .filter((e) => new RegExp(`\\s${e.id}\\s`).test(text))
            .map((e) => ({ ...e, hardware: e.vendor !== 'cpu' }))
        );
      }
    );
  });
}

/** Software fallback per codec, used when nothing better is available. */
const SW_FALLBACK = {
  h264: 'libx264',
  hevc: 'libx265',
  vp9: 'libvpx-vp9',
  av1: 'libsvtav1'
};

/**
 * Choose the encoder id to use.
 *
 * `ffmpeg -encoders` reports what the *build* supports, not what the machine
 * can run: a build with AMF compiled in lists `h264_amf` on a laptop with no
 * AMD GPU in it. When we know which GPUs are present, matching encoders are
 * preferred; when we do not, catalogue order stands and a failure falls back to
 * CPU rather than being predicted.
 *
 * @param {object} opts
 *   codec      target codec family
 *   requested  explicit encoder id, or 'auto'
 *   available  result of detectEncoders()
 *   hardware   'auto' | 'cpu'
 *   gpuVendors array of detected vendors, e.g. ['nvidia','intel']
 */
function chooseEncoder({ codec = 'h264', requested = 'auto', available = [], hardware = 'auto', gpuVendors = [] }) {
  const byId = new Map(available.map((e) => [e.id, e]));

  if (requested && requested !== 'auto') {
    const found = byId.get(requested);
    if (found) return { id: found.id, hardware: found.hardware, reason: 'requested' };
    // The user picked something this build cannot do; say so by falling back
    // rather than handing ffmpeg an unknown encoder name.
    return {
      id: SW_FALLBACK[codec] || 'libx264',
      hardware: false,
      reason: 'requested-unavailable',
      requested
    };
  }

  if (hardware !== 'cpu') {
    const candidates = available.filter((e) => e.hardware && e.codec === codec);
    const vendors = (gpuVendors || []).filter((v) => v && v !== 'unknown');
    const matching = vendors.length
      ? candidates.filter((e) => vendors.includes(e.vendor) ||
        (e.vendor === 'vaapi' && vendors.some((v) => ['intel', 'amd'].includes(v))))
      : candidates;
    const hw = matching[0] || (vendors.length ? null : candidates[0]);
    if (hw) {
      return {
        id: hw.id,
        hardware: true,
        reason: vendors.length ? 'auto-hardware-matched' : 'auto-hardware'
      };
    }
  }

  const sw = available.find((e) => !e.hardware && e.codec === codec);
  if (sw) return { id: sw.id, hardware: false, reason: 'auto-cpu' };

  return { id: SW_FALLBACK[codec] || 'libx264', hardware: false, reason: 'fallback' };
}

/** Map a 0..100 quality dial onto whatever knob the encoder family exposes. */
function encoderArgs(encoderId, { quality = 70, preset = 'medium', bitrateMode = 'quality', bitrateKbps = null, maxBitrateKbps = null } = {}) {
  const q = Math.min(100, Math.max(0, Number(quality) || 0));
  const args = ['-c:v', encoderId];

  if (bitrateMode === 'bitrate' && bitrateKbps) {
    args.push('-b:v', `${bitrateKbps}k`);
    if (maxBitrateKbps) {
      args.push('-maxrate', `${maxBitrateKbps}k`, '-bufsize', `${maxBitrateKbps * 2}k`);
    }
    if (encoderId === 'libx264' || encoderId === 'libx265') args.push('-preset', preset);
    return args;
  }

  if (encoderId === 'libx264') {
    args.push('-crf', String(Math.round(30 - (q / 100) * 16)), '-preset', preset);
  } else if (encoderId === 'libx265') {
    args.push('-crf', String(Math.round(32 - (q / 100) * 16)), '-preset', preset, '-tag:v', 'hvc1');
  } else if (encoderId === 'libvpx-vp9') {
    args.push('-crf', String(Math.round(40 - (q / 100) * 20)), '-b:v', '0', '-row-mt', '1');
  } else if (encoderId === 'libsvtav1') {
    args.push('-crf', String(Math.round(45 - (q / 100) * 23)), '-preset', '6');
  } else if (encoderId === 'libaom-av1') {
    args.push('-crf', String(Math.round(45 - (q / 100) * 23)), '-b:v', '0', '-cpu-used', '5');
  } else if (encoderId.includes('nvenc')) {
    args.push('-rc', 'vbr', '-cq', String(Math.round(34 - (q / 100) * 16)), '-preset', 'p5', '-b:v', '0');
  } else if (encoderId.includes('qsv')) {
    args.push('-global_quality', String(Math.round(34 - (q / 100) * 16)), '-preset', 'medium');
  } else if (encoderId.includes('amf')) {
    args.push('-quality', 'quality', '-rc', 'cqp', '-qp_i', String(Math.round(32 - (q / 100) * 14)),
      '-qp_p', String(Math.round(33 - (q / 100) * 14)));
  } else if (encoderId.includes('videotoolbox')) {
    args.push('-q:v', String(Math.round(30 + (q / 100) * 40)));
  } else if (encoderId.includes('vaapi')) {
    args.push('-rc_mode', 'CQP', '-qp', String(Math.round(32 - (q / 100) * 14)));
  } else {
    args.push('-q:v', String(Math.round(31 - (q / 100) * 25)));
  }

  return args;
}

/** Container -> codecs Visionance is willing to put in it. */
const CONTAINER_CODECS = {
  mp4: ['h264', 'hevc', 'av1'],
  mov: ['h264', 'hevc'],
  mkv: ['h264', 'hevc', 'vp9', 'av1'],
  webm: ['vp9', 'av1']
};

module.exports = {
  HW_ENCODERS,
  SW_ENCODERS,
  ALL_ENCODERS,
  CONTAINER_CODECS,
  detectEncoders,
  chooseEncoder,
  encoderArgs
};
