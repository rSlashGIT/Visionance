/**
 * Small UI primitives shared across the workspaces.
 *
 * Deliberately tiny and framework-free, matching the rest of the renderer: a
 * popover controller, an icon set and a couple of formatters. Anything that
 * needs application state lives in app.js; anything here is pure DOM.
 */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Icons
   *
   * Inline SVG rather than unicode glyphs: symbols like the picture-in-picture
   * and reload characters render as empty boxes on any machine without a font
   * that covers them, which looks broken on exactly the low-end hardware this
   * app is aimed at. One stroke weight, one cap style, one grid.
   * ------------------------------------------------------------------ */

  const svg = (body, filled) =>
    `<svg viewBox="0 0 24 24" width="16" height="16" fill="${filled ? 'currentColor' : 'none'}" ` +
    'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true">' + body + '</svg>';

  const ICONS = {
    play: svg('<path d="M8 5.2v13.6L19 12z"/>', true),
    pause: svg('<rect x="7.5" y="5.5" width="3.2" height="13" rx="1"/><rect x="13.3" y="5.5" width="3.2" height="13" rx="1"/>', true),
    back10: svg('<path d="M11 8H6.5V3.5"/><path d="M6.9 8.2A7.5 7.5 0 1 1 4.6 14"/>' +
      '<text x="13" y="15.4" font-size="7" stroke="none" fill="currentColor" text-anchor="middle" font-family="system-ui,sans-serif">10</text>'),
    fwd10: svg('<path d="M13 8h4.5V3.5"/><path d="M17.1 8.2A7.5 7.5 0 1 0 19.4 14"/>' +
      '<text x="11" y="15.4" font-size="7" stroke="none" fill="currentColor" text-anchor="middle" font-family="system-ui,sans-serif">10</text>'),
    volume: svg('<path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z"/><path d="M15.8 9.4a4 4 0 0 1 0 5.2"/><path d="M18.4 6.9a7.6 7.6 0 0 1 0 10.2"/>'),
    mute: svg('<path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z"/><path d="M16.2 10.2l4.3 3.9"/><path d="M20.5 10.2l-4.3 3.9"/>'),
    camera: svg('<rect x="3" y="7" width="18" height="13" rx="2.5"/><circle cx="12" cy="13.5" r="3.4"/><path d="M8.5 7l1.4-2.4h4.2L15.5 7"/>'),
    pip: svg('<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><rect x="12" y="11.5" width="8" height="6.5" rx="1.5" fill="currentColor" stroke="none"/>'),
    fullscreen: svg('<path d="M3.5 9V4.5H8"/><path d="M16 4.5h4.5V9"/><path d="M20.5 15v4.5H16"/><path d="M8 19.5H3.5V15"/>'),
    exitFullscreen: svg('<path d="M8 3.5V8H3.5"/><path d="M20.5 8H16V3.5"/><path d="M16 20.5V16h4.5"/><path d="M3.5 16H8v4.5"/>'),
    stats: svg('<path d="M4 20V13"/><path d="M9.3 20V8.5"/><path d="M14.7 20v-6.5"/><path d="M20 20V4.5"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/>' +
      '<path d="M12 2.6l1.5 2.2 2.6-.5.4 2.6 2.4 1.1-1.3 2.3 1.3 2.3-2.4 1.1-.4 2.6-2.6-.5L12 21.4l-1.5-2.2-2.6.5-.4-2.6-2.4-1.1 1.3-2.3-1.3-2.3 2.4-1.1.4-2.6 2.6.5z"/>'),
    sliders: svg('<path d="M4 7h10"/><path d="M18 7h2"/><path d="M4 17h4"/><path d="M12 17h8"/>' +
      '<circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
    folder: svg('<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>'),
    file: svg('<path d="M6 3.5h7.5L19 9v11.5H6z"/><path d="M13.5 3.5V9H19"/>'),
    link: svg('<path d="M10 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.5 1.5"/><path d="M14 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.5-1.5"/>'),
    film: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 5v14M16 5v14M3 12h18"/>'),
    check: svg('<path d="M4.5 12.5l5 5 10-11"/>'),

    /**
     * The media placeholder: the product mark's own geometry — a frame, a V,
     * an aperture centre — rather than a generic chain link. Used wherever a
     * source has no thumbnail, so an un-postered card still reads as a
     * Visionance media slot instead of a broken image.
     */
    mediaMark:
      '<svg viewBox="0 0 40 28" width="100%" height="100%" fill="none" ' +
      'stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="1" y="1" width="38" height="26" rx="2.5" stroke-width="1.1" opacity=".55"/>' +
      '<path d="M14 9l6 10 6-10" stroke-width="1.5"/>' +
      '<circle cx="20" cy="14" r="7.5" stroke-width="0.85" opacity=".3"/>' +
      '</svg>',

    /** The same mark with a link glyph, for a source that lives on the web. */
    mediaMarkRemote:
      '<svg viewBox="0 0 40 28" width="100%" height="100%" fill="none" ' +
      'stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="1" y="1" width="38" height="26" rx="2.5" stroke-width="1.1" opacity=".55"/>' +
      '<path d="M14 9l6 10 6-10" stroke-width="1.5"/>' +
      '<circle cx="20" cy="14" r="7.5" stroke-width="0.85" opacity=".3"/>' +
      '<path d="M30.5 20.5a2 2 0 0 0 2.8 0l1.3-1.3a2 2 0 0 0-2.8-2.8l-.7.7" stroke-width="1.1"/>' +
      '<path d="M32.5 19a2 2 0 0 0-2.8 0l-1.3 1.3a2 2 0 0 0 2.8 2.8l.7-.7" stroke-width="1.1"/>' +
      '</svg>'
  };

  /* ------------------------------------------------------------------ *
   * Popover
   *
   * One at a time, dismissed by Escape, an outside click or the trigger. The
   * element is real markup, not built here, so the controls inside it are the
   * genuine ones rather than mirrors that could drift from their originals.
   * ------------------------------------------------------------------ */

  let openPopover = null;

  function closePopover() {
    if (!openPopover) return;
    const { element, trigger } = openPopover;
    element.hidden = true;
    if (trigger) {
      trigger.setAttribute('aria-expanded', 'false');
      trigger.classList.remove('active');
    }
    openPopover = null;
  }

  function togglePopover(element, trigger) {
    if (openPopover && openPopover.element === element) {
      closePopover();
      return false;
    }
    closePopover();
    element.hidden = false;
    if (trigger) {
      trigger.setAttribute('aria-expanded', 'true');
      trigger.classList.add('active');
    }
    openPopover = { element, trigger };
    return true;
  }

  // Bound once, at module load, rather than per popover.
  document.addEventListener('mousedown', (e) => {
    if (!openPopover) return;
    if (openPopover.element.contains(e.target)) return;
    if (openPopover.trigger && openPopover.trigger.contains(e.target)) return;
    closePopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openPopover) {
      const trigger = openPopover.trigger;
      closePopover();
      if (trigger) trigger.focus();
    }
  }, true);

  /* ------------------------------------------------------------------ *
   * Formatters
   * ------------------------------------------------------------------ */

  function fmtTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function fmtBytes(bytes) {
    if (!bytes && bytes !== 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = bytes;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  /** A chip element. Used by the render summary and the job spec rows. */
  function chip(text, accent) {
    const node = document.createElement('span');
    node.className = accent ? 'chip accent' : 'chip';
    node.textContent = text;
    return node;
  }

  window.VSUiKit = {
    ICONS,
    svg,
    togglePopover,
    closePopover,
    isPopoverOpen: () => !!openPopover,
    fmtTime,
    fmtBytes,
    chip
  };
})();
