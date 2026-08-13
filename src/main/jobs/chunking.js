'use strict';

/**
 * Chunk planning.
 *
 * Long videos - and every future neural stage - need work split into pieces
 * that can be finished, checkpointed and resumed. The plan is deliberately
 * simple and deterministic: given a duration and a chunk length, the same
 * boundaries come out every time, so a resumed job lands exactly where the
 * previous run stopped.
 *
 * What this is *not*: a scheme that explodes a two-hour film into a million
 * PNGs before any work starts. Chunks are time ranges over the source; a stage
 * decides for itself whether it needs frames on disk, and only for the chunk it
 * is currently working on.
 *
 * Chunking is not free - each chunk starts on its own keyframe and the pieces
 * are concatenated afterwards - so `auto` only turns it on when a stage
 * genuinely requires it. Users who want pausable renders can force it on.
 */

const DEFAULT_CHUNK_SECONDS = 120;
const MIN_CHUNK_SECONDS = 5;

/**
 * @param {object} o
 *   durationSeconds  {number}  total source duration
 *   startSeconds     {number}  trim start (default 0)
 *   endSeconds       {number|null} trim end
 *   chunkSeconds     {number}
 *   mode             {'auto'|'on'|'off'}
 *   requiresChunking {boolean} a stage in the plan cannot stream the whole file
 * @returns {{enabled:boolean, reason:string, chunkSeconds:number,
 *            totalDuration:number, startOffset:number, chunks:Array}}
 */
function planChunks({
  durationSeconds = 0,
  startSeconds = 0,
  endSeconds = null,
  chunkSeconds = DEFAULT_CHUNK_SECONDS,
  mode = 'auto',
  requiresChunking = false
} = {}) {
  const start = Math.max(0, Number(startSeconds) || 0);
  const total = Number(durationSeconds) || 0;
  const end = endSeconds != null && endSeconds > start
    ? Math.min(endSeconds, total || endSeconds)
    : (total || null);

  const span = end != null ? Math.max(0, end - start) : 0;
  const size = Math.max(MIN_CHUNK_SECONDS, Number(chunkSeconds) || DEFAULT_CHUNK_SECONDS);

  let enabled;
  let reason;
  if (mode === 'off') {
    enabled = false;
    reason = requiresChunking
      ? 'chunking-disabled-by-user'
      : 'single-pass';
  } else if (mode === 'on') {
    enabled = span > size;
    reason = enabled ? 'user-requested' : 'shorter-than-one-chunk';
  } else {
    enabled = requiresChunking && span > size;
    reason = enabled ? 'stage-requires-chunking' : (requiresChunking ? 'shorter-than-one-chunk' : 'single-pass');
  }

  if (!span) {
    // Unknown duration: we cannot place boundaries honestly, so do not pretend.
    return {
      enabled: false,
      reason: 'unknown-duration',
      chunkSeconds: size,
      totalDuration: 0,
      startOffset: start,
      chunks: [{ index: 0, startSeconds: start, durationSeconds: null, endSeconds: null }]
    };
  }

  if (!enabled) {
    return {
      enabled: false,
      reason,
      chunkSeconds: size,
      totalDuration: span,
      startOffset: start,
      chunks: [{ index: 0, startSeconds: start, durationSeconds: span, endSeconds: start + span }]
    };
  }

  const chunks = [];
  let cursor = start;
  let index = 0;
  const limit = start + span;
  while (cursor < limit - 0.001) {
    let length = Math.min(size, limit - cursor);
    // Avoid a sliver at the end; fold anything under a fifth of a chunk into
    // the previous one rather than encoding a half-second file.
    const remaining = limit - (cursor + length);
    if (remaining > 0 && remaining < size * 0.2) length += remaining;
    chunks.push({
      index,
      startSeconds: round3(cursor),
      durationSeconds: round3(length),
      endSeconds: round3(cursor + length)
    });
    cursor += length;
    index++;
  }

  return {
    enabled: true,
    reason,
    chunkSeconds: size,
    totalDuration: span,
    startOffset: start,
    chunks
  };
}

/** Fresh checkpoint for a plan. */
function newCheckpoint(plan) {
  return {
    chunkCount: plan.chunks.length,
    chunkSeconds: plan.chunkSeconds,
    chunked: plan.enabled,
    completedChunks: [],
    completedDuration: 0,
    nextChunk: 0,
    muxed: false,
    updatedAt: Date.now()
  };
}

/**
 * Fold a finished chunk into the checkpoint.
 * Idempotent: replaying the same completion cannot double-count progress.
 */
function markChunkComplete(checkpoint, plan, index) {
  const cp = { ...checkpoint, completedChunks: [...(checkpoint.completedChunks || [])] };
  if (!cp.completedChunks.includes(index)) cp.completedChunks.push(index);
  cp.completedChunks.sort((a, b) => a - b);
  cp.completedDuration = cp.completedChunks.reduce((sum, i) => {
    const c = plan.chunks[i];
    return sum + ((c && c.durationSeconds) || 0);
  }, 0);
  cp.nextChunk = nextPendingChunk(cp, plan);
  cp.updatedAt = Date.now();
  return cp;
}

function nextPendingChunk(checkpoint, plan) {
  const done = new Set(checkpoint.completedChunks || []);
  for (const chunk of plan.chunks) {
    if (!done.has(chunk.index)) return chunk.index;
  }
  return plan.chunks.length;
}

function isComplete(checkpoint, plan) {
  return (checkpoint.completedChunks || []).length >= plan.chunks.length;
}

/**
 * Reconcile a stored checkpoint against what is actually on disk. A chunk that
 * the manifest calls finished but whose file is gone must be redone.
 */
function reconcile(checkpoint, plan, existingIndices) {
  const present = existingIndices instanceof Set ? existingIndices : new Set(existingIndices || []);
  const completed = (checkpoint.completedChunks || []).filter((i) => present.has(i));
  const cp = {
    ...checkpoint,
    completedChunks: completed,
    chunkCount: plan.chunks.length,
    chunked: plan.enabled
  };
  cp.completedDuration = completed.reduce((sum, i) => {
    const c = plan.chunks[i];
    return sum + ((c && c.durationSeconds) || 0);
  }, 0);
  cp.nextChunk = nextPendingChunk(cp, plan);
  cp.updatedAt = Date.now();
  return cp;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

module.exports = {
  planChunks,
  newCheckpoint,
  markChunkComplete,
  nextPendingChunk,
  isComplete,
  reconcile,
  DEFAULT_CHUNK_SECONDS,
  MIN_CHUNK_SECONDS
};
