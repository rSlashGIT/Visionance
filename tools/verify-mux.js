'use strict';

/**
 * Final-mux regression.
 *
 *   npm run verify:mux
 *
 * The neural pipeline has its own final mux, separate from the ordinary
 * concat in `stages/mux.js`, and it is where a real render lost its sound: it
 * looked for audio inside `ctx.inputs.video`, which for a YouTube split source
 * is the video-only leg, and emitted `-an`. Two hours of inference finished
 * silent, and the job was marked Completed.
 *
 * This drives the real `finaliseNeural()` — the same helper production uses,
 * including the `.vspart` sidecar naming — with tiny fixtures. Seconds, and no
 * Real-ESRGAN or RIFE: muxing is not the thing the networks are for.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'src', 'main');
const neural = require(path.join(SRC, 'jobs', 'stages', 'neural'));
const recipes = require(path.join(SRC, 'recipe'));
const { Workspace } = require(path.join(SRC, 'jobs', 'workspace'));

const DIR = path.join(os.tmpdir(), 'visionance-mux-verify');
const ffmpeg = require('ffmpeg-static');
const ffprobe = path.join(__dirname, '..', 'node_modules', 'ffprobe-static',
  'bin', 'win32', 'x64', 'ffprobe.exe');

function ff(args) {
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args],
    { windowsHide: true, maxBuffer: 1 << 24 });
}

function probe(file) {
  const out = execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format',
    '-print_format', 'json', file], { windowsHide: true, maxBuffer: 1 << 24 }).toString();
  return JSON.parse(out);
}

/** A video-only chunk and a separate audio leg: the split-source shape. */
function fixtures() {
  fs.mkdirSync(DIR, { recursive: true });
  const video = path.join(DIR, 'chunk-video-only.mp4');
  const audio = path.join(DIR, 'leg-audio.m4a');
  if (!fs.existsSync(video)) {
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=60:duration=4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', video]);
  }
  if (!fs.existsSync(audio)) {
    ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
      '-c:a', 'aac', '-b:a', '128k', audio]);
  }
  return { video, audio };
}

/** The context `finaliseNeural()` actually consumes, with nothing faked. */
function contextFor({ jobId, outputPath, chunk, inputs, localAudio = null, analysis }) {
  const workspace = new Workspace(path.join(DIR, 'work'));
  workspace.ensureRoot();
  workspace.create(jobId);
  fs.copyFileSync(chunk, workspace.chunkPath(jobId, 0, 'mp4'));

  const recipe = recipes.sanitize({
    output: { path: outputPath, container: 'mp4', codec: 'h264', fps: 60 },
    audio: { enabled: true, mode: 'encode', codec: 'aac', bitrateKbps: 192 },
    motion: { enabled: true, targetFps: 60, interpolation: 'ai' }
  }).recipe;

  return {
    recipe,
    analysis,
    plan: { chunks: [{ index: 0 }], totalDuration: 4 },
    bins: { ffmpeg },
    workspace,
    jobId,
    chunkExt: 'mp4',
    inputs,
    headers: { video: null, audio: null },
    localAudio,
    control: { cancelled: false, pauseRequested: false, activeRun: null },
    reportStage: () => {},
    log: { info() {}, warn() {}, error() {} }
  };
}

/** A probed analysis of the video-only leg: no audio in it, which is the point. */
const VIDEO_ONLY_ANALYSIS = {
  video: { width: 320, height: 180, nominalFps: 60, codec: 'h264' },
  audio: null,
  derived: { displayWidth: 320, displayHeight: 180, durationSeconds: 4, hasAudio: false },
  container: { duration: 4 }
};

test('mux: a split source keeps its audio through the neural final mux', async () => {
  const { video, audio } = fixtures();
  const outputPath = path.join(DIR, 'out-split.mp4');
  const ctx = contextFor({
    jobId: 'job_muxsplit0000001',
    outputPath,
    chunk: video,
    // Exactly the real shape: the video leg carries no audio, the audio leg
    // is separate. Before the fix this produced `-an` and a silent file.
    inputs: { video, audio },
    analysis: VIDEO_ONLY_ANALYSIS
  });

  const result = await neural.finaliseNeural(ctx);
  assert.ok(result && result.outputPath, 'the mux must produce a part file');
  assert.ok(fs.existsSync(result.outputPath), `missing ${result.outputPath}`);
  // Production writes a `.vspart` sidecar so a failure cannot leave something
  // that looks finished.
  assert.ok(result.outputPath.endsWith('.vspart'), result.outputPath);

  const info = probe(result.outputPath);
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  assert.ok(v, 'video stream missing');
  assert.ok(a, 'AUDIO STREAM MISSING — the split leg was not muxed');
  assert.equal(a.codec_name, 'aac');
  assert.ok(Number(a.duration) > 3, `audio duration ${a.duration}`);
  assert.ok(Math.abs(Number(a.duration) - Number(v.duration)) < 0.5,
    `A/V duration drift: video ${v.duration} audio ${a.duration}`);
});

test('mux: a locally fetched audio file is used in preference to the URL', async () => {
  const { video, audio } = fixtures();
  const outputPath = path.join(DIR, 'out-local.mp4');
  const ctx = contextFor({
    jobId: 'job_muxlocal0000001',
    outputPath,
    chunk: video,
    // A URL that would 403 if it were opened, and a local copy that works:
    // the prefetch exists precisely because the signed URL cannot be reused.
    inputs: { video, audio: 'https://example.invalid/expired-audio.m4a' },
    localAudio: audio,
    analysis: VIDEO_ONLY_ANALYSIS
  });

  const result = await neural.finaliseNeural(ctx);
  const info = probe(result.outputPath);
  assert.ok(info.streams.find((s) => s.codec_type === 'audio'),
    'the local audio copy must be preferred over the expired URL');
});

test('mux: with no audio anywhere the file is video-only, and says so', async () => {
  const { video } = fixtures();
  const outputPath = path.join(DIR, 'out-silent.mp4');
  const ctx = contextFor({
    jobId: 'job_muxsilent000001',
    outputPath,
    chunk: video,
    inputs: { video, audio: null },
    analysis: VIDEO_ONLY_ANALYSIS
  });

  const result = await neural.finaliseNeural(ctx);
  const info = probe(result.outputPath);
  assert.equal(info.streams.filter((s) => s.codec_type === 'audio').length, 0);
  assert.ok(info.streams.find((s) => s.codec_type === 'video'));
});

test('mux: an output path containing spaces survives the spawn intact', async () => {
  // The path is passed as one argv element to `spawn` with no shell, so spaces
  // need no quoting — and quoting it would be the bug.
  const { video, audio } = fixtures();
  const spaced = path.join(DIR, 'a folder with spaces');
  fs.mkdirSync(spaced, { recursive: true });
  const outputPath = path.join(spaced, 'out with spaces.mp4');
  const ctx = contextFor({
    jobId: 'job_muxspaces00001',
    outputPath,
    chunk: video,
    inputs: { video, audio },
    analysis: VIDEO_ONLY_ANALYSIS
  });

  const result = await neural.finaliseNeural(ctx);
  assert.ok(fs.existsSync(result.outputPath), result.outputPath);
  assert.ok(probe(result.outputPath).streams.find((s) => s.codec_type === 'audio'));
});
