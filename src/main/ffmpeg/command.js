'use strict';

/**
 * ffmpeg argument construction.
 *
 * Kept as a pure function of its inputs so the exact argv can be unit-tested
 * without spawning anything, and logged (redacted) when a render fails.
 *
 * Split remote sources are the reason headers are built per input: yt-dlp can
 * hand back a video URL and an audio URL that belong to different hosts with
 * different required headers. Applying one header set to both is how you get an
 * intermittent 403 halfway through a render.
 */

const path = require('path');
const { buildVideoGraph, buildAudioFilters } = require('./filters');
const { encoderArgs } = require('./encoders');
const { headerBlob } = require('../media-analyzer');

/**
 * ffmpeg picks its muxer from the output file extension. Renders are written to
 * `.vspart` / `.tmp` sidecars so a failure can never leave something that looks
 * like a finished file, which means the muxer has to be named explicitly.
 */
const CONTAINER_FORMAT = {
  mp4: 'mp4',
  mov: 'mov',
  mkv: 'matroska',
  webm: 'webm'
};

function formatFor(recipe, outputPath) {
  const fromRecipe = CONTAINER_FORMAT[recipe && recipe.output && recipe.output.container];
  if (fromRecipe) return fromRecipe;
  const ext = path.extname(String(outputPath || '')).replace('.', '').toLowerCase();
  return CONTAINER_FORMAT[ext] || 'mp4';
}

/** The extension the finished file will have, used for the container checks. */
function finalExtOf(recipe, outputPath) {
  const stripped = String(outputPath || '').replace(/\.(vspart|tmp)$/i, '');
  return path.extname(stripped).toLowerCase();
}

/**
 * @param {object} o
 *   recipe, geometry, analysis, availableFilters
 *   input            {string}
 *   inputHeaders     {object|null}
 *   audioInput       {string|null}
 *   audioHeaders     {object|null}
 *   output           {string}
 *   encoderId        {string}
 *   sourceHasAudio   {boolean}
 *   segment          {{startSeconds:number, durationSeconds:number|null}|null}
 *   forConcat        {boolean}  chunk output that will be concatenated later
 * @returns {{args: string[], notes: string[], graph: string}}
 */
function buildEncodeCommand(o) {
  const {
    recipe,
    geometry,
    analysis = null,
    availableFilters = null,
    input,
    inputHeaders = null,
    audioInput = null,
    audioHeaders = null,
    output,
    encoderId,
    sourceHasAudio = true,
    segment = null,
    forConcat = false,
    reframe = null
  } = o;

  const notes = [];
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];

  const trimStart = segment
    ? segment.startSeconds
    : (recipe.trim.startSeconds != null ? recipe.trim.startSeconds : null);
  const trimDuration = segment
    ? segment.durationSeconds
    : null;
  const trimEnd = segment ? null : recipe.trim.endSeconds;

  /* ---- input 0: video (and usually audio) ---- */
  addInputOptions(args, inputHeaders, /^https?:/i.test(input));
  if (trimStart != null && trimStart > 0) args.push('-ss', String(trimStart));
  args.push('-i', input);

  /* ---- input 1: separate audio stream ---- */
  const useSeparateAudio = !!audioInput && recipe.audio.enabled && recipe.audio.mode !== 'none';
  if (useSeparateAudio) {
    addInputOptions(args, audioHeaders || inputHeaders, /^https?:/i.test(audioInput));
    if (trimStart != null && trimStart > 0) args.push('-ss', String(trimStart));
    args.push('-i', audioInput);
    notes.push('Video and audio were resolved as separate streams and are muxed during the render.');
  }

  if (trimDuration != null) args.push('-t', String(trimDuration));
  else if (trimEnd != null) args.push('-t', String(Math.max(0.04, trimEnd - (trimStart || 0))));

  /* ---- video graph ---- */
  const video = buildVideoGraph(recipe, geometry, analysis, { availableFilters, reframe });
  notes.push(...video.notes);
  args.push('-filter_complex', video.graph);
  args.push('-map', `[${video.outputLabel}]`);

  /* ---- audio ---- */
  const wantAudio = recipe.audio.enabled && recipe.audio.mode !== 'none' &&
    (useSeparateAudio || sourceHasAudio);

  if (!wantAudio) {
    args.push('-an');
  } else {
    args.push('-map', useSeparateAudio ? '1:a:0' : '0:a:0?');
    if (recipe.audio.mode === 'copy') {
      args.push('-c:a', 'copy');
    } else {
      const audioFilters = buildAudioFilters(recipe);
      notes.push(...audioFilters.notes);
      if (audioFilters.filters.length) args.push('-filter:a', audioFilters.filters.join(','));
      args.push('-c:a', recipe.audio.codec === 'opus' ? 'libopus' : recipe.audio.codec);
      if (recipe.audio.codec !== 'flac') args.push('-b:a', `${recipe.audio.bitrateKbps}k`);
      if (recipe.audio.channels) args.push('-ac', String(recipe.audio.channels));
      if (recipe.audio.sampleRate) args.push('-ar', String(recipe.audio.sampleRate));
    }
    if (useSeparateAudio) args.push('-shortest');
  }

  /* ---- video encoder ---- */
  args.push(...encoderArgs(encoderId, {
    quality: recipe.output.quality,
    preset: recipe.output.preset,
    bitrateMode: recipe.output.bitrateMode,
    bitrateKbps: recipe.output.bitrateKbps,
    maxBitrateKbps: recipe.output.maxBitrateKbps
  }));

  // The graph already produced the requested rate; -r pins the container so a
  // VFR source cannot leak a different nominal rate into the output header.
  if (geometry.fps) args.push('-r', String(geometry.fps));

  /* ---- container ---- */
  const ext = finalExtOf(recipe, output);
  if (recipe.output.faststart && (ext === '.mp4' || ext === '.mov') && !forConcat) {
    args.push('-movflags', '+faststart');
  }
  if (forConcat) args.push('-avoid_negative_ts', 'make_zero');
  args.push('-max_muxing_queue_size', '1024');
  args.push('-f', formatFor(recipe, output));
  args.push('-progress', 'pipe:1', '-nostats');
  args.push(output);

  return { args, notes, graph: video.graph };
}

function addInputOptions(args, headers, isRemote) {
  if (isRemote) {
    // Reconnect covers the CDN dropping a long-lived connection mid-render.
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  }
  const blob = headerBlob(headers);
  if (blob) args.push('-headers', blob);
}

/**
 * Concat previously rendered chunks without re-encoding.
 * The chunks were produced by the same command builder, so their codec
 * parameters match and stream copy is safe.
 */
function buildConcatCommand({ listFile, output, faststart = true, container = null }) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy'
  ];
  const fakeRecipe = { output: { container } };
  const ext = finalExtOf(fakeRecipe, output);
  if (faststart && (ext === '.mp4' || ext === '.mov')) args.push('-movflags', '+faststart');
  args.push('-f', formatFor(fakeRecipe, output));
  args.push('-progress', 'pipe:1', '-nostats', output);
  return { args };
}

module.exports = { buildEncodeCommand, buildConcatCommand, formatFor };
