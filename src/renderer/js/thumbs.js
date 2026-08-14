/**
 * Thumbnail identity, renderer side.
 *
 * One source has one thumbnail, and every card that shows that source shows
 * the same image. This module is what makes that true across Create, the
 * Queue and the Library: it holds a single in-memory map from source identity
 * to resolved URL, so a Queue re-render costs a map lookup rather than an IPC
 * round trip, and a source that has already failed is never asked for again.
 *
 * The main process owns extraction and the on-disk cache. This side owns
 * *not asking twice*.
 */

(function () {
  'use strict';

  const api = window.visionance;

  /** identity -> { url } once resolved, or null when there is no thumbnail. */
  const resolved = new Map();
  /** identity -> Promise while a request is in flight. */
  const pending = new Map();
  /** Counters the UI verification suite asserts against. */
  const stats = { requests: 0, ipcCalls: 0, hits: 0, misses: 0 };

  /**
   * The renderer's own identity for a source, mirroring the main process's
   * rule. Kept here so a cache lookup never needs an IPC call to find out
   * whether it is a cache hit.
   */
  function identityOf(descriptor) {
    if (!descriptor) return null;
    const remote = descriptor.kind === 'stream' || descriptor.kind === 'remote';
    const raw = remote
      ? (descriptor.webpageUrl || descriptor.source || '')
      : (descriptor.source || descriptor.path || '');
    if (!raw) return null;
    return (remote ? 'r:' : 'l:') + (remote ? String(raw).trim() : String(raw).trim().toLowerCase());
  }

  /**
   * Resolve the thumbnail URL for a source.
   *
   * @returns {Promise<string|null>} a `vs://` URL, or null when there is none
   */
  function get(descriptor) {
    const identity = identityOf(descriptor);
    if (!identity) return Promise.resolve(null);
    stats.requests++;

    if (resolved.has(identity)) {
      stats.hits++;
      return Promise.resolve(resolved.get(identity));
    }
    if (pending.has(identity)) {
      stats.hits++;
      return pending.get(identity);
    }

    stats.misses++;
    stats.ipcCalls++;
    const request = api.thumbnails.get({
      kind: descriptor.kind,
      source: descriptor.source || descriptor.path || null,
      webpageUrl: descriptor.webpageUrl || null,
      thumbnail: descriptor.thumbnail || null,
      durationSeconds: descriptor.durationSeconds || null
    }).then((res) => {
      const url = (res && res.ok && res.url) ? res.url : null;
      resolved.set(identity, url);
      pending.delete(identity);
      return url;
    }).catch(() => {
      // A failure is remembered too. Retrying on every card render would turn
      // one missing thumbnail into a stream of ffmpeg processes.
      resolved.set(identity, null);
      pending.delete(identity);
      return null;
    });

    pending.set(identity, request);
    return request;
  }

  /**
   * Fill a `.thumb` element for a source: fallback mark immediately, real
   * image when it arrives.
   *
   * Idempotent by identity. Re-rendering a list that already shows the right
   * picture touches nothing, which is what keeps the Queue cheap while a job
   * updates several times a second.
   *
   * @param {HTMLElement} node   an element carrying the `.thumb` class
   * @param {object} descriptor  source descriptor
   * @param {{duration?:number, kind?:string}} [opts]
   */
  function paint(node, descriptor, opts = {}) {
    if (!node) return;
    const identity = identityOf(descriptor);
    if (node.dataset.thumbId === identity && node.dataset.thumbState === 'done') return;

    if (node.dataset.thumbId !== identity) {
      node.dataset.thumbId = identity || '';
      node.dataset.thumbState = 'pending';
      node.innerHTML = '';
      node.appendChild(fallbackFor(descriptor));
      if (opts.duration) node.appendChild(durationBadge(opts.duration));
    }
    if (!identity) { node.dataset.thumbState = 'done'; return; }

    // A cache hit paints synchronously; only a genuine miss waits.
    if (resolved.has(identity)) {
      applyImage(node, identity, resolved.get(identity), descriptor, opts);
      return;
    }
    get(descriptor).then((url) => {
      // The row may have been recycled for a different source while we waited.
      if (node.dataset.thumbId !== identity) return;
      applyImage(node, identity, url, descriptor, opts);
    });
  }

  function applyImage(node, identity, url, descriptor, opts) {
    node.dataset.thumbState = 'done';
    if (!url) return;
    if (node.querySelector('img')) return;
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = '';
    img.src = url;
    // Only replace the placeholder once the bytes are actually there, so a
    // card never flashes an empty box between the two.
    img.addEventListener('load', () => {
      if (node.dataset.thumbId !== identity) return;
      const fallback = node.querySelector('.thumb-fallback');
      if (fallback) fallback.remove();
    }, { once: true });
    img.addEventListener('error', () => { img.remove(); }, { once: true });
    node.insertBefore(img, node.firstChild);
    void descriptor;
    void opts;
  }

  function fallbackFor(descriptor) {
    const wrap = document.createElement('div');
    wrap.className = 'thumb-fallback';
    const remote = descriptor && (descriptor.kind === 'stream' || descriptor.kind === 'remote');
    // The product's own frame-and-aperture geometry, not a generic glyph: a
    // source without a poster should still read as a Visionance media slot.
    wrap.innerHTML = remote ? window.VSUiKit.ICONS.mediaMarkRemote : window.VSUiKit.ICONS.mediaMark;
    return wrap;
  }

  function durationBadge(seconds) {
    const badge = document.createElement('span');
    badge.className = 'thumb-duration';
    badge.textContent = window.VSUiKit.fmtTime(seconds);
    return badge;
  }

  /** Drop the in-memory map. Used after the on-disk cache is cleared. */
  function reset() {
    resolved.clear();
    pending.clear();
  }

  window.VSThumbs = { get, paint, identityOf, reset, stats };
})();
