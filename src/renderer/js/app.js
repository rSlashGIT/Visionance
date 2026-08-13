/**
 * Visionance renderer application.
 *
 * Wires the DOM to the WebGL engine and the main-process API. Deliberately
 * framework-free: the whole UI is a few hundred lines of direct DOM work,
 * which keeps startup instant and the frame loop free of allocations.
 */

(function () {
  'use strict';

  const api = window.visionance;
  const { Engine } = window.VSEngine;
  const { BUILTIN, CONTROLS } = window.VSPresets;

  const $ = (id) => document.getElementById(id);

  /* ------------------------------------------------------------------ *
   * Icons
   *
   * Inline SVG rather than unicode glyphs: symbols like ⟲ and ⧉ render as
   * empty boxes on any machine without a font that covers them, which looks
   * broken on exactly the low-end hardware this app is aimed at.
   * ------------------------------------------------------------------ */

  const svg = (body, fill) =>
    `<svg viewBox="0 0 24 24" width="18" height="18" fill="${fill ? 'currentColor' : 'none'}" ` +
    `stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

  const ICONS = {
    play: svg('<path d="M7 4.5v15l12-7.5z"/>', true),
    pause: svg('<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>', true),
    back10: svg('<path d="M11 8H6.5V3.5"/><path d="M6.9 8.2A7.5 7.5 0 1 1 4.6 14"/><text x="12" y="15.6" font-size="7.5" stroke="none" fill="currentColor" text-anchor="middle" font-family="sans-serif">10</text>'),
    fwd10: svg('<path d="M13 8h4.5V3.5"/><path d="M17.1 8.2A7.5 7.5 0 1 0 19.4 14"/><text x="12" y="15.6" font-size="7.5" stroke="none" fill="currentColor" text-anchor="middle" font-family="sans-serif">10</text>'),
    volume: svg('<path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z"/><path d="M16 9a4.5 4.5 0 0 1 0 6"/><path d="M18.5 6.5a8 8 0 0 1 0 11"/>'),
    mute: svg('<path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z"/><path d="M16.5 10l4 4"/><path d="M20.5 10l-4 4"/>'),
    camera: svg('<rect x="3" y="7" width="18" height="13" rx="2.5"/><circle cx="12" cy="13.5" r="3.6"/><path d="M8.5 7l1.4-2.4h4.2L15.5 7"/>'),
    pip: svg('<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><rect x="12" y="11.5" width="8" height="6.5" rx="1.5" fill="currentColor" stroke="none"/>'),
    fullscreen: svg('<path d="M3.5 9V4.5H8"/><path d="M16 4.5h4.5V9"/><path d="M20.5 15v4.5H16"/><path d="M8 19.5H3.5V15"/>'),
    exitFullscreen: svg('<path d="M8 3.5V8H3.5"/><path d="M20.5 8H16V3.5"/><path d="M16 20.5V16h4.5"/><path d="M3.5 16H8v4.5"/>'),
    stats: svg('<path d="M4 19.5V13"/><path d="M9.3 19.5V8"/><path d="M14.7 19.5v-6"/><path d="M20 19.5V4.5"/>'),
    gear: svg('<circle cx="12" cy="12" r="3.2"/><path d="M19.4 14.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.56-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    folder: svg('<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>'),
    file: svg('<path d="M6 3.5h7.5L19 9v11.5H6z"/><path d="M13.5 3.5V9H19"/>'),
    link: svg('<path d="M10 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.5 1.5"/><path d="M14 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.5-1.5"/>')
  };

  function applyIcons() {
    const map = {
      playBtn: ICONS.play,
      back10Btn: ICONS.back10,
      fwd10Btn: ICONS.fwd10,
      muteBtn: ICONS.volume,
      snapshotBtn: ICONS.camera,
      pipBtn: ICONS.pip,
      fullscreenBtn: ICONS.fullscreen,
      statsBtn: ICONS.stats,
      settingsBtn: ICONS.gear
    };
    for (const [id, icon] of Object.entries(map)) {
      if (el[id]) el[id].innerHTML = icon;
    }
    el.openFileBtn.innerHTML = `${ICONS.folder}<span>Open file</span>`;
  }

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */

  const state = {
    engine: null,
    media: null,          // descriptor of what is loaded
    params: null,
    presetId: 'balanced',
    userPresets: {},
    settings: null,
    info: null,
    compare: 0,           // 0 off, 1 split
    presentation: null,   // 'native' | 'enhanced'
    playback: null,       // PlaybackStats
    watchQuality: 'auto',
    splitX: 0.5,
    splitDragging: false,
    scrubbing: false,
    dualStream: false,
    jobs: new Map(),
    analysis: null,        // full source analysis for the loaded media
    analysisPending: false,
    platforms: {},
    encoders: [],
    engines: {},
    autoResult: null,
    recipeState: 'custom',  // 'auto' | 'modified' | 'custom'
    resumeKey: null,
    lastSavedPosition: 0,
    idleTimer: null,

    /**
     * Everything about "which source is loaded" lives here, and only
     * switchSource() writes to it.
     *
     * `generation` is the race guard. Every switch takes the next number, and
     * any asynchronous step that finds the counter has moved on abandons its
     * work instead of writing it. That is what stops a slow URL resolution
     * from overwriting a local file the user chose while it was still in
     * flight - the failure mode is silent and confusing, because the picture
     * simply changes back on its own several seconds later.
     */
    source: {
      generation: 0,
      key: null,          // normalised identity of what is loaded
      token: null,        // live stream session, if any
      pendingKey: null,   // identity of the switch currently in flight
      pendingPromise: null,
      controller: null    // aborts the in-flight load
    }
  };

  const el = {};
  [
    'urlInput', 'goBtn', 'openFileBtn', 'statsBtn', 'settingsBtn',
    'stage', 'stageInner', 'glCanvas', 'video', 'audio', 'stageEmpty',
    'stageLoading', 'loadingText', 'statsOverlay', 'compareLabels', 'splitHandle',
    'toastStack', 'transport', 'scrub', 'scrubBuffered', 'scrubPlayed',
    'scrubKnob', 'scrubTooltip', 'playBtn', 'back10Btn', 'fwd10Btn', 'muteBtn',
    'volume', 'timeLabel', 'enhanceToggle', 'compareBtn', 'resBadge',
    'speedSelect', 'snapshotBtn', 'pipBtn', 'fullscreenBtn', 'panel',
    'presetGrid', 'watchQuality', 'scaleSelect', 'adaptiveToggle', 'presetName', 'savePresetBtn',
    'controlGroups', 'resetParamsBtn',
    'createSourceTitle', 'analyseBtn', 'analysisGrid', 'analysisNote',
    'autoBlock', 'autoState', 'autoProfile', 'autoIntensity', 'autoBuildBtn', 'autoExplain',
    'createPreset', 'recipeName', 'saveRecipeBtn', 'savedRecipeList', 'sendToCreateBtn',
    'createPlatform', 'createRes', 'createFraming', 'createFramingRow', 'createFramingHelp', 'createFps',
    'createEncoder', 'createQuality', 'createQualityVal', 'createUseLook',
    'createAudio', 'createLoudness', 'createChunked', 'startCreateBtn', 'recipeWarnings',
    'aiBlock', 'aiEngineState', 'createAi', 'createAiModelRow', 'createAiModel', 'createAiNote',
    'createInterp', 'createSceneRow', 'createScene', 'createSceneHelp', 'createFpsHelp',
    'installEnginesBtn', 'engineProgress', 'createGpu', 'createTile',
    'createSceneThreshold', 'createSceneThresholdVal', 'createModelDetail',
    'engineList', 'runtimeStatus', 'installRuntimeBtn',
    'jobList', 'clearJobsBtn', 'recentList', 'clearRecentsBtn', 'dropOverlay',
    'settingsModal', 'closeSettings', 'ytdlpStatus', 'installYtdlpBtn', 'locateYtdlpBtn',
    'maxHeight', 'authMode', 'authBrowser', 'authBrowserRow', 'authFileRow',
    'authFileStatus', 'pickCookiesBtn', 'capabilityText',
    'ffmpegStatus', 'locateFfmpegBtn',
    'autoplayToggle', 'resumeToggle', 'targetFpsSelect', 'aboutText',
    'infoModal', 'closeInfo', 'emptyOpenBtn', 'emptyDemoBtn', 'brandSub'
  ].forEach((id) => { el[id] = $(id); });

  /* ------------------------------------------------------------------ *
   * Utilities
   * ------------------------------------------------------------------ */

  function toast(message, kind = 'info', ms = 4200) {
    const node = document.createElement('div');
    node.className = `toast ${kind}`;
    node.textContent = message;
    el.toastStack.appendChild(node);
    setTimeout(() => {
      node.classList.add('leaving');
      setTimeout(() => node.remove(), 220);
    }, ms);
  }

  function fmtTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function fmtBytes(bytes) {
    if (!bytes) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = bytes;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function labelForHeight(h) {
    if (!h) return '—';
    if (h >= 4320) return '8K';
    if (h >= 2160) return '4K';
    if (h >= 1440) return '1440p';
    if (h >= 1080) return '1080p';
    if (h >= 720) return '720p';
    return `${h}p`;
  }

  const isUrl = (s) => /^(https?:\/\/|www\.)\S+$/i.test((s || '').trim());

  /* ------------------------------------------------------------------ *
   * Media control - handles both single-file and split video/audio
   * ------------------------------------------------------------------ */

  const media = {
    get v() { return el.video; },
    get a() { return el.audio; },

    /**
     * Detach both elements from whatever they were playing.
     *
     * Setting `src = ''` is not the same as removing the attribute: an empty
     * string is a *relative* URL, so the element dutifully tries to load the
     * page itself and reports a decode failure. Removing the attribute and
     * calling load() is the only way to genuinely release a source, and it is
     * what stops the previous stream's connection from being held open.
     */
    detach() {
      for (const element of [el.video, el.audio]) {
        try { element.pause(); } catch { /* not loaded */ }
        element.removeAttribute('src');
        try { element.load(); } catch { /* nothing to abort */ }
      }
      state.dualStream = false;
    },

    /**
     * Point the elements at a descriptor and resolve once the media is really
     * ready. Readiness is awaited here rather than handled by a global
     * listener, so a source switch owns its own completion instead of racing
     * an event that may belong to the previous source.
     *
     * @returns {Promise<void>} resolves on loadedmetadata, rejects on error
     */
    load(descriptor, { signal } = {}) {
      const v = el.video;
      const a = el.audio;

      state.dualStream = !!descriptor.audioUrl;
      v.pause();
      a.pause();
      a.removeAttribute('src');
      try { a.load(); } catch { /* nothing to abort */ }

      const ready = new Promise((resolve, reject) => {
        const cleanup = () => {
          v.removeEventListener('loadedmetadata', onReady);
          v.removeEventListener('error', onError);
          if (signal) signal.removeEventListener('abort', onAbort);
        };
        const onReady = () => { cleanup(); resolve(); };
        const onError = () => {
          cleanup();
          const code = v.error && v.error.code;
          reject(Object.assign(new Error(MEDIA_ERRORS[code] || 'Playback failed.'), {
            mediaErrorCode: code || 0
          }));
        };
        const onAbort = () => { cleanup(); reject(Object.assign(new Error('superseded'), { superseded: true })); };
        v.addEventListener('loadedmetadata', onReady, { once: true });
        v.addEventListener('error', onError, { once: true });
        if (signal) {
          if (signal.aborted) return onAbort();
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });

      v.src = descriptor.playbackUrl;
      if (state.dualStream) {
        a.src = descriptor.audioUrl;
        v.muted = true;         // audio comes from the separate element
        a.muted = !!state.settings.muted;
        a.volume = state.settings.volume;
      } else {
        v.muted = !!state.settings.muted;
        v.volume = state.settings.volume;
      }
      v.playbackRate = Number(el.speedSelect.value) || 1;
      a.playbackRate = v.playbackRate;
      v.load();

      return ready;
    },

    play() {
      const p = el.video.play();
      if (p && p.catch) p.catch((err) => {
        if (err && err.name !== 'AbortError') toast(`Playback blocked: ${err.message}`, 'error');
      });
      if (state.dualStream) this.playAudio();
    },

    /**
     * Start the separate audio track, and mean it.
     *
     * A `play()` that rejects because the element has no data yet used to be
     * swallowed, which left the audio element paused - and a paused media
     * element suspends its network activity, so the track that could not start
     * never loaded either and the video played silently. The audio element's
     * own readiness events retry this, so a slow start becomes a late start
     * rather than no sound at all.
     */
    playAudio() {
      if (!state.dualStream || el.video.paused) return;
      if (Math.abs(el.audio.currentTime - el.video.currentTime) > 0.25) {
        el.audio.currentTime = el.video.currentTime;
      }
      const ap = el.audio.play();
      if (ap && ap.catch) ap.catch(() => { /* retried from the audio element's own events */ });
    },

    pause() {
      el.video.pause();
      if (state.dualStream) el.audio.pause();
    },

    toggle() {
      if (el.video.paused) this.play(); else this.pause();
    },

    seek(seconds) {
      const d = el.video.duration;
      const t = Math.max(0, Math.min(Number.isFinite(d) ? d - 0.05 : seconds, seconds));
      el.video.currentTime = t;
      if (state.dualStream) el.audio.currentTime = t;
    },

    setVolume(vol) {
      const target = state.dualStream ? el.audio : el.video;
      target.volume = vol;
      if (vol > 0) target.muted = false;
    },

    setMuted(muted) {
      const target = state.dualStream ? el.audio : el.video;
      target.muted = muted;
    },

    get muted() {
      return state.dualStream ? el.audio.muted : el.video.muted;
    },

    setRate(rate) {
      el.video.playbackRate = rate;
      el.audio.playbackRate = rate;
    },

    /** Keep the separate audio track locked to the video clock. */
    syncDrift() {
      if (!state.dualStream || el.video.paused) return;
      const drift = el.audio.currentTime - el.video.currentTime;
      if (Math.abs(drift) > 0.25) {
        el.audio.currentTime = el.video.currentTime;
      } else if (Math.abs(drift) > 0.06) {
        // Nudge the rate instead of jumping, which is inaudible.
        el.audio.playbackRate = el.video.playbackRate * (drift > 0 ? 0.98 : 1.02);
      } else if (el.audio.playbackRate !== el.video.playbackRate) {
        el.audio.playbackRate = el.video.playbackRate;
      }
    }
  };

  /* ------------------------------------------------------------------ *
   * Loading sources
   * ------------------------------------------------------------------ */

  function showLoading(text) {
    el.loadingText.textContent = text;
    el.stageLoading.hidden = false;
  }

  function hideLoading() {
    el.stageLoading.hidden = true;
  }

  /** Structured backend failures: say what happened and what to do about it. */
  function reportFailure(res, fallback) {
    const message = (res && (res.message || res.error)) || fallback || 'Something went wrong.';
    const action = res && res.suggestedAction;
    toast(action ? `${message} ${action}` : message, 'error', action ? 9000 : 7000);
    if (res && res.technicalDetails) console.warn(`[${res.code}] ${res.technicalDetails}`);
  }

  /**
   * Normalise a URL enough that "is this already playing?" is a reliable
   * question. Deliberately conservative: the query string is preserved,
   * because for most video sites that is where the video id lives.
   */
  function normalizeUrl(raw) {
    let s = (raw || '').trim();
    if (!s) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    try {
      const u = new URL(s);
      u.hash = '';
      const host = u.host.toLowerCase().replace(/^www\./, '');
      const path = u.pathname.replace(/\/+$/, '');
      return `${u.protocol.toLowerCase()}//${host}${path}${u.search}`;
    } catch {
      return s.toLowerCase();
    }
  }

  /** Stable identity for a source, whatever kind it is. */
  function sourceKey(request) {
    if (!request) return null;
    if (request.kind === 'local') return 'file:' + String(request.path || '').toLowerCase();
    return 'url:' + normalizeUrl(request.url);
  }

  const MEDIA_ERRORS = {
    1: 'Loading was aborted.',
    2: 'A network error interrupted the stream.',
    3: 'This file could not be decoded — the codec may not be supported.',
    4: 'This source is not supported.'
  };

  /* ------------------------------------------------------------------ *
   * The one source-switch lifecycle
   *
   * Every route into playback goes through switchSource(): the omnibar, the
   * file picker, drag-and-drop, the recents list, the menu and a file opened
   * from the shell. There is no second path that "just sets video.src",
   * because two such paths racing each other is precisely what made pasting a
   * URL over a playing local file do nothing at all.
   * ------------------------------------------------------------------ */

  /**
   * @param {{kind:'local', path:string} | {kind:'url', url:string}} request
   * @param {{play?:boolean}} [options]
   */
  async function switchSource(request, options = {}) {
    const key = sourceKey(request);
    if (!key || key === 'url:' || key === 'file:') return;

    // A second request for the source already being loaded joins the switch in
    // flight rather than restarting it. Pasting a URL auto-loads it, and the
    // user then presses Play - without this, that is two resolutions of the
    // same video, and the second one tears down the first one's connection
    // just as it was starting to buffer.
    if (state.source.pendingKey === key && state.source.pendingPromise) {
      return state.source.pendingPromise;
    }

    const generation = ++state.source.generation;
    const stale = () => generation !== state.source.generation;

    // Abort anything the previous switch still has running, then take over.
    if (state.source.controller) state.source.controller.abort();
    const controller = new AbortController();
    state.source.controller = controller;
    state.source.pendingKey = key;

    const run = (async () => {
      /* ---- 1. tear the old source down completely ---- */
      const previousToken = state.source.token;

      media.detach();
      if (state.engine) {
        state.engine.stop();
        state.engine.resetPacing();
      }
      state.presentation = null;
      state.media = null;
      state.analysis = null;
      state.autoResult = null;
      state.resumeKey = null;
      state.lastSavedPosition = 0;
      state.source.token = null;
      state.source.key = null;
      window.__vsLastMedia = null;
      if (state.playback) state.playback.reset();
      el.resBadge.textContent = '—';
      hideLoading();

      // Release the previous stream session so its CDN URLs and header set do
      // not outlive the video they belonged to.
      if (previousToken) api.media.releaseStream(previousToken).catch(() => { /* best effort */ });

      /* ---- 2. resolve the new source ---- */
      let descriptor;
      if (request.kind === 'local') {
        showLoading('Reading file…');
        const res = await api.media.open(request.path);
        if (stale()) return;
        hideLoading();
        if (!res.ok) { reportFailure(res); return; }
        descriptor = res;
      } else {
        showLoading('Resolving stream…');
        // Tell the resolver what this window can actually display, so it does
        // not pick a 1440p rendition for a 900px viewport.
        const rect = el.stageInner.getBoundingClientRect();
        const res = await api.media.resolveUrl(request.url, {
          viewportWidth: Math.round(rect.width),
          viewportHeight: Math.round(rect.height),
          devicePixelRatio: window.devicePixelRatio || 1,
          screenWidth: window.screen ? window.screen.width : 0,
          screenHeight: window.screen ? window.screen.height : 0,
          enhancement: !!(state.params && state.params.enabled),
          watchQuality: state.watchQuality
        });

        // The user moved on while this was resolving. Hand the session back
        // rather than letting it linger, and write nothing.
        if (stale()) {
          if (res.ok && res.streamToken) api.media.releaseStream(res.streamToken).catch(() => {});
          return;
        }
        hideLoading();

        if (!res.ok) {
          const opensSettings = ['YT_DLP_MISSING', 'AUTH_REQUIRED', 'AGE_RESTRICTED', 'YT_DLP_OUTDATED']
            .includes(res.code);
          reportFailure(res);
          if (opensSettings) openSettings();
          return;
        }
        (res.warnings || []).forEach((w) => toast(w, 'warn', 6000));
        if (res.selectedQuality) toast(`Playing ${res.selectedQuality}`, 'info', 5000);
        descriptor = res;
      }

      /* ---- 3. adopt it ---- */
      state.media = descriptor;
      state.source.key = key;
      state.source.token = descriptor.streamToken || null;
      // Exposed for the playback-diagnostics harness; harmless in production.
      window.__vsLastMedia = descriptor;
      state.analysis = descriptor.analysis || null;
      state.resumeKey = descriptor.source;

      el.stageEmpty.hidden = true;
      el.brandSub.textContent = descriptor.title || 'Real-time enhancement';
      document.title = `${descriptor.title || 'Visionance'} — Visionance`;
      // A local file has no URL; leaving the previous one in the bar would make
      // the Play button refer to something that is no longer on screen.
      if (request.kind === 'local') el.urlInput.value = '';
      else el.urlInput.value = request.url;

      // Let the engine derive its frame budget from the real source rate rather
      // than assuming 60 fps.
      const srcFps = (descriptor.analysis && descriptor.analysis.video &&
        descriptor.analysis.video.nominalFps) ||
        (descriptor.info && descriptor.info.fps) || 0;
      el.video.__vsSourceFps = srcFps || 0;

      /* ---- 4. load and wait for real readiness ---- */
      try {
        await media.load(descriptor, { signal: controller.signal });
      } catch (err) {
        if (err && err.superseded) return;
        if (stale()) return;
        toast(err.message || 'Playback failed.', 'error', 8000);
        return;
      }
      if (stale()) return;

      /* ---- 5. presentation, resume, playback ---- */
      applyPresentationMode();
      updateResBadge();
      refreshCreateSource();
      api.system.keepAwake(true);

      api.recents.add({
        source: descriptor.source,
        kind: descriptor.kind,
        title: descriptor.title,
        duration: descriptor.info ? descriptor.info.duration : null
      }).then((r) => { if (!stale() && r.ok) renderRecents(r.recents); });

      if (state.settings.rememberPosition && state.resumeKey) {
        const r = await api.resume.get(state.resumeKey);
        // The resume position belongs to the source that asked for it. Seeking
        // a *different* video to it would be worse than not resuming at all.
        if (!stale() && r.ok && r.seconds > 15 &&
            r.seconds < (el.video.duration || Infinity) - 20) {
          media.seek(r.seconds);
          toast(`Resumed at ${fmtTime(r.seconds)}`, 'ok', 3000);
        }
      }
      if (stale()) return;

      const wantsPlay = options.play !== undefined ? options.play : !!state.settings.autoplay;
      if (wantsPlay) media.play();
    })();

    state.source.pendingPromise = run;
    try {
      await run;
    } finally {
      if (state.source.pendingKey === key) {
        state.source.pendingKey = null;
        state.source.pendingPromise = null;
      }
    }
  }

  const openLocalFile = (filePath) => switchSource({ kind: 'local', path: filePath });
  const openUrl = (rawUrl) => switchSource({ kind: 'url', url: rawUrl });

  /**
   * The omnibar's Play button.
   *
   * If the box holds something other than what is playing, Play means "load
   * and play that", not "resume what was already here". Resuming the previous
   * video after the user typed a new address and pressed Play is the single
   * most confusing thing this control could do.
   */
  function onOmnibarPlay() {
    const entered = (el.urlInput.value || '').trim();
    if (!entered) {
      if (state.media) media.toggle();
      else toast('Paste a video URL, or open a file.', 'warn');
      return;
    }
    const key = sourceKey({ kind: 'url', url: entered });
    if (state.media && state.source.key === key) {
      media.toggle();
      return;
    }
    openUrl(entered);
  }

  /* ------------------------------------------------------------------ *
   * Engine
   * ------------------------------------------------------------------ */

  function initPlaybackStats() {
    if (!window.VSPlaybackStats) return;
    state.playback = new window.VSPlaybackStats.PlaybackStats(el.video);
    // A developer diagnostics hook rather than an always-on HUD: the numbers
    // are collected continuously, but only surfaced when asked for.
    window.visionanceDiagnostics = {
      mark: (label) => state.playback.mark(label),
      snapshot: () => ({
        playback: state.playback.snapshot(),
        presentation: state.presentation,
        enhancement: !!(state.params && state.params.enabled),
        watchQuality: state.watchQuality,
        engine: state.engine ? { ...state.engine.stats, running: state.engine.running } : null,
        media: state.media ? {
          kind: state.media.kind,
          title: state.media.title,
          selected: state.media.selectedQuality || null,
          muxed: state.media.muxed !== false,
          // What the policy asked for and what it got, so a report can say
          // "1080p avc1, split" instead of "it looked fine".
          selection: state.media.selection || null,
          policy: state.media.streamPolicy || null,
          resolveMs: state.media.resolveMs || null
        } : null
      }),
      /** Bytes and throughput per leg, straight from the proxy. */
      transfer: () => api.media.transferStats(),
      /** Which source is loaded, and whether a switch is still in flight. */
      source: () => ({
        generation: state.source.generation,
        key: state.source.key,
        token: state.source.token,
        pendingKey: state.source.pendingKey,
        currentSrc: el.video.currentSrc || null,
        dualStream: state.dualStream,
        presentation: state.presentation,
        engineRunning: !!(state.engine && state.engine.running)
      })
    };
  }

  function initEngine() {
    try {
      state.engine = new Engine(el.glCanvas);
    } catch (err) {
      toast(err.message, 'error', 12000);
      el.stageEmpty.querySelector('p').textContent =
        'This machine does not expose WebGL2, which Visionance needs for real-time enhancement. Updating your graphics driver usually fixes it.';
      return;
    }
    state.engine.onError = (err) => toast(err.message, 'error', 9000);

    // The governor has run out of room: protect the motion, not the effect.
    state.engine.onOverload = (info) => {
      if (!state.params.enabled) return;
      // An explicit Quality/Maximum choice is the user's call to make; warn but
      // do not override it. Auto and Performance exist to be decided for you.
      if (state.watchQuality === 'quality' || state.watchQuality === 'maximum') {
        toast(
          `Enhancement is dropping about ${info.dropRate}% of frames at ${info.sourceFps || '?'} fps. ` +
          'Switch Playback quality to Auto to protect smooth motion.',
          'warn', 9000
        );
        return;
      }
      state.params.enabled = false;
      state.engine.setParams({ enabled: false });
      updateEnhanceToggle();
      toast(
        `Enhancement paused: this GPU could not keep up with a ${info.sourceFps || 'high'} fps source ` +
        `(about ${info.dropRate}% of frames were being dropped). Playback is now native and smooth.`,
        'warn', 11000
      );
    };
    state.engine.setVideo(el.video);
    // Deliberately not started here. The loop starts only when there is media
    // *and* the enhanced path is actually wanted; see applyPresentationMode().
  }

  function applyParams(params, presetId) {
    state.params = { ...params };
    if (presetId) state.presetId = presetId;
    if (state.engine) state.engine.setParams(state.params);
    syncControlValues();
    renderPresetGrid();
    updateEnhanceToggle();
  }

  function findPreset(id) {
    const builtin = BUILTIN.find((p) => p.id === id);
    if (builtin) return builtin;
    return state.userPresets[id] || null;
  }

  /* ------------------------------------------------------------------ *
   * UI - presets
   * ------------------------------------------------------------------ */

  function renderPresetGrid() {
    const all = [...BUILTIN, ...Object.values(state.userPresets)];
    el.presetGrid.innerHTML = '';
    for (const preset of all) {
      const card = document.createElement('button');
      card.className = 'preset-card' + (preset.id === state.presetId ? ' active' : '');
      card.title = preset.description || '';
      card.innerHTML =
        `<span class="pname"></span><span class="ptag"></span>`;
      card.querySelector('.pname').textContent = preset.name;
      card.querySelector('.ptag').textContent = preset.tag || 'Custom';

      if (state.userPresets[preset.id]) {
        const del = document.createElement('button');
        del.className = 'pdel';
        del.textContent = '✕';
        del.title = 'Delete preset';
        del.addEventListener('click', async (e) => {
          e.stopPropagation();
          const r = await api.presets.remove(preset.id);
          if (r.ok) {
            state.userPresets = r.presets;
            if (state.presetId === preset.id) applyParams(findPreset('balanced').params, 'balanced');
            else renderPresetGrid();
            toast('Preset deleted');
          }
        });
        card.appendChild(del);
      }

      card.addEventListener('click', () => applyParams(preset.params, preset.id));
      el.presetGrid.appendChild(card);
    }
  }

  /* ------------------------------------------------------------------ *
   * UI - adjust sliders
   * ------------------------------------------------------------------ */

  const sliderRefs = new Map();

  function buildControls() {
    el.controlGroups.innerHTML = '';
    for (const group of CONTROLS) {
      const wrap = document.createElement('div');
      wrap.className = 'ctrl-group';
      const h = document.createElement('h4');
      h.textContent = group.group;
      wrap.appendChild(h);
      if (group.hint) {
        const hint = document.createElement('p');
        hint.className = 'ghint';
        hint.textContent = group.hint;
        wrap.appendChild(hint);
      }

      for (const item of group.items) {
        const ctrl = document.createElement('div');
        ctrl.className = 'ctrl';

        const head = document.createElement('div');
        head.className = 'ctrl-head';
        const label = document.createElement('label');
        label.textContent = item.label;
        label.htmlFor = `ctrl_${item.key}`;
        const val = document.createElement('span');
        val.className = 'cval';
        head.append(label, val);

        const input = document.createElement('input');
        input.type = 'range';
        input.id = `ctrl_${item.key}`;
        input.min = item.min;
        input.max = item.max;
        input.step = item.step;

        input.addEventListener('input', () => {
          const v = parseFloat(input.value);
          val.textContent = v.toFixed(2);
          state.params[item.key] = v;
          state.engine && state.engine.setParams({ [item.key]: v });
          markCustom();
        });

        ctrl.append(head, input);
        if (item.help) {
          const help = document.createElement('p');
          help.className = 'chelp';
          help.textContent = item.help;
          ctrl.appendChild(help);
        }
        wrap.appendChild(ctrl);
        sliderRefs.set(item.key, { input, val });
      }
      el.controlGroups.appendChild(wrap);
    }
  }

  function syncControlValues() {
    for (const [key, ref] of sliderRefs) {
      const v = state.params[key];
      if (typeof v === 'number') {
        ref.input.value = v;
        ref.val.textContent = v.toFixed(2);
      }
    }
  }

  /** Once a slider moves, the selection is no longer a stock preset. */
  function markCustom() {
    if (state.presetId !== '__custom') {
      state.presetId = '__custom';
      renderPresetGrid();
    }
  }

  /* ------------------------------------------------------------------ *
   * UI - transport
   * ------------------------------------------------------------------ */

  function updatePlayButton() {
    el.playBtn.innerHTML = el.video.paused ? ICONS.play : ICONS.pause;
  }

  function updateTime() {
    const v = el.video;
    const d = Number.isFinite(v.duration) ? v.duration : 0;
    el.timeLabel.textContent = `${fmtTime(v.currentTime)} / ${fmtTime(d)}`;
    if (!state.scrubbing && d > 0) {
      const pct = (v.currentTime / d) * 100;
      el.scrubPlayed.style.width = pct + '%';
      el.scrubKnob.style.left = pct + '%';
    }
    if (v.buffered.length && d > 0) {
      let end = 0;
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= v.currentTime) end = Math.max(end, v.buffered.end(i));
      }
      el.scrubBuffered.style.width = Math.min(100, (end / d) * 100) + '%';
    }
  }

  function updateResBadge() {
    const v = el.video;
    if (!v.videoWidth) { el.resBadge.textContent = '—'; return; }
    const src = labelForHeight(v.videoHeight);
    // Read the canvas directly rather than the stats snapshot, which is only
    // refreshed twice a second and would lag behind a settings change.
    const outH = el.glCanvas.height || v.videoHeight;
    el.resBadge.textContent = state.params.enabled
      ? `${src} → ${labelForHeight(outH)}`
      : src;
  }

  /**
   * Switch between the two presentation paths.
   *
   * native   — the <video> element is the picture. Chromium decodes and
   *            composites it directly, with no per-frame texture upload, no
   *            shader pass and no canvas presentation. This is the playback
   *            baseline, and the WebGL loop is genuinely stopped, not hidden.
   * enhanced — the canvas is the picture and the engine runs.
   *
   * Compare mode needs the shader path even when enhancement is "off", because
   * the split view is drawn by the engine.
   */
  function applyPresentationMode() {
    const wantsEnhanced = !!(state.params && state.params.enabled) || state.compare !== 0;
    const mode = wantsEnhanced ? 'enhanced' : 'native';
    if (state.presentation === mode) return;
    state.presentation = mode;

    el.stageInner.classList.toggle('native', mode === 'native');
    el.glCanvas.classList.toggle('hidden', mode === 'native' || !state.media);

    if (!state.engine) return;
    if (mode === 'native') {
      // Stop the loop outright. A paused-but-running render loop still uploads
      // frames and still costs GPU bandwidth we have no use for.
      state.engine.stop();
    } else if (state.media) {
      state.engine.start();
    }
    positionSplitHandle();
  }

  function updateEnhanceToggle() {
    const on = !!state.params.enabled;
    el.enhanceToggle.classList.toggle('off', !on);
    el.enhanceToggle.innerHTML = `<span class="dot"></span> Enhancement ${on ? 'on' : 'off'}`;
    applyPresentationMode();
    updateResBadge();
  }

  function scrubPositionFromEvent(e) {
    const rect = el.scrub.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  function bindTransport() {
    el.playBtn.addEventListener('click', () => media.toggle());
    el.back10Btn.addEventListener('click', () => media.seek(el.video.currentTime - 10));
    el.fwd10Btn.addEventListener('click', () => media.seek(el.video.currentTime + 10));

    el.volume.addEventListener('input', () => {
      const v = parseFloat(el.volume.value);
      media.setVolume(v);
      media.setMuted(v === 0);
      updateMuteIcon();
      api.settings.patch({ volume: v, muted: v === 0 });
    });

    el.muteBtn.addEventListener('click', () => {
      media.setMuted(!media.muted);
      updateMuteIcon();
      api.settings.patch({ muted: media.muted });
    });

    el.speedSelect.addEventListener('change', () => {
      media.setRate(parseFloat(el.speedSelect.value));
    });

    el.enhanceToggle.addEventListener('click', () => {
      state.params.enabled = !state.params.enabled;
      state.engine && state.engine.setParams({ enabled: state.params.enabled });
      updateEnhanceToggle();
    });

    el.compareBtn.addEventListener('click', () => setCompare(state.compare ? 0 : 1));

    el.snapshotBtn.addEventListener('click', takeSnapshot);

    el.pipBtn.addEventListener('click', async () => {
      try {
        // Picture-in-picture works off a live capture of the enhanced canvas,
        // so the floating window shows the processed image, not the raw video.
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
          return;
        }
        const stream = el.glCanvas.captureStream(30);
        const pipVideo = document.createElement('video');
        pipVideo.muted = true;
        pipVideo.srcObject = stream;
        await pipVideo.play();
        await pipVideo.requestPictureInPicture();
      } catch (err) {
        toast(`Picture-in-picture unavailable: ${err.message}`, 'error');
      }
    });

    el.fullscreenBtn.addEventListener('click', toggleFullscreen);

    // Scrubbing
    const onScrubMove = (e) => {
      const p = scrubPositionFromEvent(e);
      const d = el.video.duration || 0;
      el.scrubTooltip.textContent = fmtTime(p * d);
      el.scrubTooltip.style.left = (p * 100) + '%';
      if (state.scrubbing) {
        el.scrubPlayed.style.width = (p * 100) + '%';
        el.scrubKnob.style.left = (p * 100) + '%';
      }
    };
    el.scrub.addEventListener('mousemove', onScrubMove);
    el.scrub.addEventListener('mousedown', (e) => {
      state.scrubbing = true;
      onScrubMove(e);
    });
    window.addEventListener('mousemove', (e) => { if (state.scrubbing) onScrubMove(e); });
    window.addEventListener('mouseup', (e) => {
      if (!state.scrubbing) return;
      state.scrubbing = false;
      const d = el.video.duration || 0;
      if (d) media.seek(scrubPositionFromEvent(e) * d);
    });

    // Media element events
    const v = el.video;
    v.addEventListener('play', () => {
      updatePlayButton();
      media.playAudio();
    });
    v.addEventListener('pause', () => { updatePlayButton(); if (state.dualStream) el.audio.pause(); });

    // The audio track catching up is the moment to try again: if its first
    // play() lost the race with its own loading, this is what rescues it.
    for (const event of ['loadeddata', 'canplay', 'canplaythrough']) {
      el.audio.addEventListener(event, () => media.playAudio());
    }
    v.addEventListener('timeupdate', () => { updateTime(); updateResBadge(); });
    v.addEventListener('progress', updateTime);
    v.addEventListener('durationchange', updateTime);
    v.addEventListener('seeking', () => { if (state.dualStream) el.audio.currentTime = v.currentTime; });
    v.addEventListener('waiting', () => { if (state.dualStream) el.audio.pause(); });
    v.addEventListener('playing', () => media.playAudio());
    v.addEventListener('ratechange', () => { el.speedSelect.value = String(v.playbackRate); });
    v.addEventListener('ended', () => { api.system.keepAwake(false); updatePlayButton(); });

    // Readiness, resume and autoplay belong to switchSource(), which knows
    // which source it is acting for. A global handler here cannot tell whether
    // the metadata it just received belongs to the video the user currently
    // wants, and used to seek a freshly opened clip to the previous one's
    // resume position.
    v.addEventListener('loadedmetadata', () => {
      updateTime();
      updateResBadge();
    });

    // Drift correction + position persistence
    setInterval(() => {
      media.syncDrift();
      if (
        state.settings && state.settings.rememberPosition && state.resumeKey &&
        !v.paused && Math.abs(v.currentTime - state.lastSavedPosition) > 5
      ) {
        state.lastSavedPosition = v.currentTime;
        api.resume.set(state.resumeKey, v.currentTime);
      }
    }, 1000);
  }

  function updateMuteIcon() {
    const silent = media.muted || parseFloat(el.volume.value) === 0;
    el.muteBtn.innerHTML = silent ? ICONS.mute : ICONS.volume;
  }

  async function takeSnapshot() {
    if (!state.engine || !state.media) return toast('Nothing is playing.', 'warn');
    const blob = await state.engine.snapshot();
    if (!blob) return toast('Could not capture the frame.', 'error');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const base = (state.media.title || 'frame').replace(/[^\w.-]+/g, '_').slice(0, 60);
    a.href = url;
    a.download = `${base}_${Math.round(el.video.currentTime)}s.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('Frame saved to your downloads folder.', 'ok');
  }

  /* ------------------------------------------------------------------ *
   * Compare split
   * ------------------------------------------------------------------ */

  function setCompare(mode) {
    state.compare = mode;
    el.compareBtn.classList.toggle('active', !!mode);
    el.compareLabels.hidden = !mode;
    el.splitHandle.hidden = !mode;
    if (state.engine) state.engine.setCompare(mode, state.splitX);
    // Split compare is drawn by the shader pipeline, so it needs the enhanced
    // presentation path even when enhancement itself is off.
    applyPresentationMode();
    positionSplitHandle();
  }

  function positionSplitHandle() {
    const rect = el.glCanvas.getBoundingClientRect();
    const stage = el.stageInner.getBoundingClientRect();
    const x = rect.left - stage.left + rect.width * state.splitX;
    el.splitHandle.style.left = `${x}px`;
  }

  function bindSplit() {
    const move = (e) => {
      if (!state.splitDragging) return;
      const rect = el.glCanvas.getBoundingClientRect();
      state.splitX = Math.max(0.02, Math.min(0.98, (e.clientX - rect.left) / rect.width));
      state.engine && state.engine.setCompare(state.compare, state.splitX);
      positionSplitHandle();
    };
    el.splitHandle.addEventListener('mousedown', (e) => {
      state.splitDragging = true;
      e.preventDefault();
    });
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', () => { state.splitDragging = false; });
    window.addEventListener('resize', positionSplitHandle);
  }

  /* ------------------------------------------------------------------ *
   * Fullscreen + idle chrome
   * ------------------------------------------------------------------ */

  async function toggleFullscreen() {
    const res = await api.system.setFullscreen();
    document.body.classList.toggle('is-fullscreen', res.fullscreen);
    el.fullscreenBtn.innerHTML = res.fullscreen ? ICONS.exitFullscreen : ICONS.fullscreen;
    setTimeout(positionSplitHandle, 120);
  }

  function bindIdle() {
    const wake = () => {
      document.body.classList.remove('idle');
      clearTimeout(state.idleTimer);
      state.idleTimer = setTimeout(() => {
        if (document.body.classList.contains('is-fullscreen') && !el.video.paused) {
          document.body.classList.add('idle');
        }
      }, 2600);
    };
    ['mousemove', 'mousedown', 'keydown', 'wheel'].forEach((evt) =>
      window.addEventListener(evt, wake, { passive: true })
    );
    wake();
  }

  /* ------------------------------------------------------------------ *
   * Stats overlay
   * ------------------------------------------------------------------ */

  function bindStats() {
    let visible = false;
    const render = () => {
      if (!visible || !state.engine) return;
      const s = state.engine.stats;
      const v = el.video;
      const pb = state.playback ? state.playback.snapshot() : null;
      const rows = [
        ['Path', state.presentation === 'native' ? 'native (no GPU work)' : 'enhanced'],
        ['Source', v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : '—'],
        // Compositor-counted, not callback-counted: see playback-stats.js.
        ['Presented', pb ? `${pb.presentedFps} fps${pb.presentedBasis === 'callbacks' ? ' (est.)' : ''}` : '—'],
        ['Dropped', pb ? `${pb.droppedFrames}/${pb.totalFrames} (${pb.droppedPercent}%)` : '—'],
        ['Jitter', pb ? `${pb.jitterMs} ms` : '—'],
        ['Buffer', pb ? `${pb.bufferedAheadSec}s` : '—']
      ];
      if (state.presentation === 'enhanced') {
        rows.push(
          ['Render', s.outputW ? `${s.outputW}×${s.outputH}` : '—'],
          ['Frame cost', `${s.cpuMs} ms / ${s.frameBudgetMs} ms budget`],
          ['Quality scale', `${Math.round(s.droppedScale * 100)}% (${s.policy})`]
        );
        if (s.skipped) rows.push(['Skipped', `${s.skipped} stale frame(s)`]);
      }
      rows.push(['GPU', String(s.gpu).slice(0, 34)]);
      if (s.limited) rows.push(['Status', 'GPU limited — lower Playback quality']);
      el.statsOverlay.innerHTML = rows
        .map(([k, val]) => `<div class="row"><span>${k}</span><b>${val}</b></div>`)
        .join('');
    };
    setInterval(render, 500);

    el.statsBtn.addEventListener('click', () => {
      visible = !visible;
      el.statsOverlay.hidden = !visible;
      el.statsBtn.classList.toggle('active', visible);
      api.settings.patch({ showStats: visible });
      render();
    });

    // Restore the persisted preference once settings arrive.
    setTimeout(() => {
      if (state.settings && state.settings.showStats) el.statsBtn.click();
    }, 60);
  }

  /* ------------------------------------------------------------------ *
   * Create
   *
   * Builds a processing recipe from the panel and hands it to the job
   * system. The recipe is *intent*: the main process re-analyses the source
   * and resolves the concrete geometry, so what the UI collects here never
   * has to guess at pixel dimensions.
   * ------------------------------------------------------------------ */

  async function populateEncoders() {
    const res = await api.app.encoders();
    if (!res.ok) return;
    state.encoders = res.encoders || [];
    const sel = el.createEncoder;
    for (const enc of state.encoders) {
      const opt = document.createElement('option');
      opt.value = enc.id;
      opt.textContent = enc.hardware ? `${enc.label} — hardware` : enc.label;
      sel.appendChild(opt);
    }
  }

  async function populatePlatforms() {
    const res = await api.recipe.platforms();
    if (!res.ok) return;
    state.platforms = res.platforms;
    el.createPlatform.innerHTML = '';
    for (const p of Object.values(state.platforms)) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      el.createPlatform.appendChild(opt);
    }
    const saved = state.settings.create && state.settings.create.lastPlatform;
    if (saved && state.platforms[saved]) el.createPlatform.value = saved;
    syncPlatformUi();
  }

  function syncPlatformUi() {
    const platform = state.platforms[el.createPlatform.value];
    const shapesCanvas = !!(platform && platform.canvas && platform.canvas !== 'source');
    el.createFramingRow.hidden = !shapesCanvas;
    el.createFramingHelp.hidden = !shapesCanvas;
    if (shapesCanvas && el.createRes.value === 'source') el.createRes.value = 'platform';
    if (!shapesCanvas && el.createRes.value === 'platform') el.createRes.value = 'source';
  }

  function refreshCreateSource() {
    if (!state.media) {
      el.createSourceTitle.textContent = 'No source selected';
      el.analysisGrid.innerHTML = '';
      el.analysisNote.textContent = 'Open a video in Watch, then come back.';
      return;
    }
    el.createSourceTitle.textContent = state.media.title || state.media.source;
    renderAnalysis(state.analysis);
  }

  function renderAnalysis(analysis) {
    el.analysisGrid.innerHTML = '';
    if (!analysis) {
      el.analysisNote.textContent = state.media && state.media.kind === 'stream'
        ? 'Online sources are analysed when the render starts. Press Analyse to probe now.'
        : 'Not analysed yet.';
      return;
    }

    const v = analysis.video || {};
    const d = analysis.derived || {};
    const c = analysis.color || {};
    const a = analysis.audio;
    const unknown = '—';
    const rows = [
      ['Resolution', d.displayWidth ? `${d.displayWidth}×${d.displayHeight}` : unknown],
      ['Frame rate', v.nominalFps ? `${v.nominalFps} fps (${d.frameRateMode})` : unknown],
      ['Duration', d.durationSeconds ? fmtTime(d.durationSeconds) : unknown],
      ['Codec', [v.codec, v.profile].filter(Boolean).join(' ') || unknown],
      ['Pixel format', `${v.pixelFormat || unknown}${v.bitDepth ? ` · ${v.bitDepth}-bit` : ''}`],
      ['Colour', c.isHDR ? `HDR (${c.hdrFormat || c.transfer})` : (c.transfer || 'SDR')],
      ['Orientation', d.orientation ? `${d.orientation} ${d.aspectRatioLabel || ''}`.trim() : unknown],
      ['Scan', d.isInterlaced === true ? `interlaced (${v.fieldOrder})` : d.isInterlaced === false ? 'progressive' : unknown],
      ['Bitrate', analysis.container.bitrate ? `${Math.round(analysis.container.bitrate / 1000)} kbps` : unknown],
      ['Size', analysis.container.size ? fmtBytes(analysis.container.size) : unknown],
      ['Audio', a ? `${a.codec} ${a.channels || '?'}ch ${a.sampleRate ? a.sampleRate + ' Hz' : ''}`.trim() : 'none']
    ];

    for (const [k, val] of rows) {
      const row = document.createElement('div');
      row.className = 'arow';
      const key = document.createElement('span');
      key.textContent = k;
      const value = document.createElement('b');
      value.textContent = val;
      row.append(key, value);
      el.analysisGrid.appendChild(row);
    }

    el.analysisNote.textContent = (analysis.warnings || []).join(' ');
  }

  async function analyseSource() {
    if (!state.media) return toast('Open a video first.', 'warn');
    if (state.analysisPending) return;
    state.analysisPending = true;
    el.analyseBtn.textContent = 'Analysing…';

    const target = state.media.kind === 'local'
      ? state.media.source
      : { token: state.media.streamToken, leg: 'video' };
    const res = await api.media.analyze(target, { deep: state.media.kind === 'local' });

    state.analysisPending = false;
    el.analyseBtn.textContent = 'Analyse';
    if (!res.ok) return reportFailure(res, 'The source could not be analysed.');
    state.analysis = res.analysis;
    renderAnalysis(state.analysis);
  }

  /* ------------------------------------------------------------------ *
   * AI engines
   *
   * The UI never offers a neural option as if it worked when the engine is
   * absent: the controls are disabled and replaced with an Install button.
   * ------------------------------------------------------------------ */

  const ENGINE_LABEL = { realesrgan: 'Real-ESRGAN (upscaling)', rife: 'RIFE (interpolation)' };

  async function refreshEngines(force) {
    const res = await api.engines.status({ force: !!force });
    if (!res.ok) return;
    state.engines = res.engines;
    renderEngineList();
    syncAiUi();
  }

  function engineReady(id) {
    const e = state.engines[id];
    return !!(e && e.status === 'ready');
  }

  function renderEngineList() {
    if (!el.engineList) return;
    el.engineList.innerHTML = '';
    for (const [id, engine] of Object.entries(state.engines)) {
      const row = document.createElement('div');
      row.className = 'dep-row';

      const info = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = ENGINE_LABEL[id] || engine.name;
      const status = document.createElement('p');
      status.className = 'muted';
      status.id = `engineStatus_${id}`;
      status.textContent = describeEngine(engine);
      info.append(name, status);

      const actions = document.createElement('div');
      actions.className = 'dep-actions';
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost';
      if (engine.status === 'installing') {
        btn.textContent = 'Cancel';
        btn.addEventListener('click', () => api.engines.cancelInstall(id));
      } else if (engine.status === 'ready') {
        btn.textContent = 'Remove';
        btn.addEventListener('click', async () => {
          await api.engines.remove(id);
          refreshEngines(true);
        });
      } else if (engine.status === 'unsupported') {
        btn.textContent = 'Unavailable';
        btn.disabled = true;
      } else {
        btn.textContent = engine.installed ? 'Reinstall' : 'Install';
        btn.addEventListener('click', () => installEngine(id));
      }
      actions.appendChild(btn);

      row.append(info, actions);
      el.engineList.appendChild(row);
    }
  }

  function describeEngine(engine) {
    if (engine.status === 'ready') {
      const gpus = (engine.availableGPUs || []).map((g) => g.name).join(', ');
      return `Ready — ${engine.models.length} model(s)${gpus ? ` · ${gpus}` : ''}`;
    }
    if (engine.status === 'installing') return 'Installing…';
    if (engine.status === 'unsupported') return 'No build for this platform.';
    if (engine.status === 'broken') {
      return (engine.error && engine.error.message) || 'Installed but not usable.';
    }
    const size = engine.downloadBytes ? ` (${fmtBytes(engine.downloadBytes)} download)` : '';
    return `Not installed${size}.`;
  }

  async function installEngine(id) {
    const node = document.getElementById(`engineStatus_${id}`);
    if (node) node.textContent = 'Starting…';
    const res = await api.engines.install(id);
    if (!res.ok) reportFailure(res, 'The engine could not be installed.');
    else toast(`${ENGINE_LABEL[id] || id} installed.`, 'ok');
    refreshEngines(true);
  }

  function bindEngineEvents() {
    api.engines.onProgress((p) => {
      const node = document.getElementById(`engineStatus_${p.id}`);
      const text = p.phase === 'download'
        ? `Downloading… ${Math.round((p.fraction || 0) * 100)}%`
        : p.phase === 'extract' ? 'Unpacking…' : 'Finishing…';
      if (node) node.textContent = text;
      if (!el.engineProgress.hidden || p.phase !== 'done') {
        el.engineProgress.hidden = false;
        el.engineProgress.textContent = `${ENGINE_LABEL[p.id] || p.id}: ${text}`;
      }
      if (p.phase === 'done') {
        setTimeout(() => { el.engineProgress.hidden = true; }, 1500);
      }
    });
    api.engines.onStatus(() => refreshEngines());
  }

  /** Show only what the installed engines can actually do. */
  function syncAiUi() {
    const upscaleReady = engineReady('realesrgan');
    const rifeReady = engineReady('rife');

    for (const opt of el.createAi.options) {
      if (opt.value !== 'off') opt.disabled = !upscaleReady;
    }
    const aiOpt = [...el.createInterp.options].find((o) => o.value === 'ai');
    if (aiOpt) aiOpt.disabled = !rifeReady;

    if (!upscaleReady && el.createAi.value !== 'off') el.createAi.value = 'off';
    if (!rifeReady && el.createInterp.value === 'ai') el.createInterp.value = 'off';

    const missing = [];
    if (!upscaleReady) missing.push('Real-ESRGAN');
    if (!rifeReady) missing.push('RIFE');
    el.aiEngineState.textContent = missing.length
      ? `${missing.join(' and ')} not installed`
      : 'Engines ready';
    el.aiEngineState.classList.toggle('ready', missing.length === 0);
    el.installEnginesBtn.hidden = missing.length === 0;

    const usingAi = el.createAi.value !== 'off';
    el.createAiModelRow.hidden = !usingAi;
    el.createAiNote.hidden = !usingAi;
    if (usingAi) el.createAiNote.textContent = describeAiChoice();

    const interpAi = el.createInterp.value === 'ai';
    el.createSceneRow.hidden = !interpAi;
    el.createSceneHelp.hidden = !interpAi;
    el.createFpsHelp.textContent = interpAi
      ? 'RIFE generates genuinely new intermediate frames. The running time and audio sync are unchanged.'
      : 'Frames are duplicated or dropped to hit the target. Choose AI interpolation above to generate genuinely new intermediate frames.';

    // GPU list comes from whichever engine reported one.
    const gpus = (state.engines.realesrgan && state.engines.realesrgan.availableGPUs.length
      ? state.engines.realesrgan.availableGPUs
      : (state.engines.rife && state.engines.rife.availableGPUs) || []);
    const current = el.createGpu.value;
    if (el.createGpu.options.length !== gpus.length + 1) {
      el.createGpu.innerHTML = '<option value="auto">Auto</option>';
      for (const g of gpus) {
        const opt = document.createElement('option');
        opt.value = String(g.index);
        opt.textContent = `${g.index}: ${g.name}`;
        el.createGpu.appendChild(opt);
      }
      el.createGpu.value = current || 'auto';
    }

    el.createModelDetail.textContent = describeInstalledModels();
  }

  /** Say plainly what the network will do, including the downscale step. */
  function describeAiChoice() {
    const value = el.createAi.value;
    const model = el.createAiModel.value;
    const animation = model === 'animation';
    if (value === 'restore') {
      return animation
        ? 'Restores at the source resolution: a native 2× pass, then a high-quality downscale. There is no 1× model.'
        : 'Restores at the source resolution: a native 4× pass, then a high-quality downscale. There is no 1× model.';
    }
    if (value === '2') {
      return animation
        ? 'Native 2× reconstruction.'
        : 'The General model is 4×-only, so 2× runs at 4× and is downscaled. Animation has native 2×.';
    }
    if (value === '4') return 'Native 4× reconstruction. Slow and memory-hungry on large sources.';
    return '';
  }

  function describeInstalledModels() {
    const bits = [];
    for (const [id, engine] of Object.entries(state.engines)) {
      if (engine.status !== 'ready') continue;
      const names = engine.models.map((m) => m.name || m.label || m.id).join(', ');
      bits.push(`${ENGINE_LABEL[id] || id}: ${names}`);
    }
    return bits.join(' — ') || 'No AI models installed.';
  }

  async function refreshRuntimeStatus() {
    const res = await api.runtime.status();
    if (!res.ok) return;
    const found = res.runtimes || [];
    if (!found.length) {
      el.runtimeStatus.textContent = 'None found. Some sites will not resolve without one.';
      el.installRuntimeBtn.hidden = false;
      return;
    }
    const best = found[0];
    el.runtimeStatus.textContent =
      `Using ${best.runtime} ${best.version || ''} (${best.source})`.trim();
    el.installRuntimeBtn.hidden = best.source !== 'electron';
  }

  /* ------------------------------------------------------------------ *
   * Auto, export presets and saved recipes
   * ------------------------------------------------------------------ */

  async function populateAuto() {
    const res = await api.auto.profiles();
    if (!res.ok) return;
    el.autoProfile.innerHTML = '';
    for (const p of Object.values(res.profiles)) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      el.autoProfile.appendChild(opt);
    }
    el.createPreset.innerHTML = '<option value="">Custom…</option>';
    for (const preset of res.presets) {
      const opt = document.createElement('option');
      opt.value = preset.id;
      opt.textContent = preset.label;
      opt.title = preset.description;
      el.createPreset.appendChild(opt);
    }
  }

  /** Ask Auto what it would do, and show its reasoning before committing. */
  async function runAuto() {
    if (!state.media) return toast('Open a video first.', 'warn');
    if (!state.analysis) {
      await analyseSource();
      if (!state.analysis) return;
    }
    el.autoBuildBtn.disabled = true;
    el.autoState.textContent = 'Thinking…';

    const res = await api.auto.build({
      analysis: state.analysis,
      platform: el.createPlatform.value,
      profile: el.autoProfile.value,
      intensity: el.autoIntensity.value,
      outputPath: null
    });
    el.autoBuildBtn.disabled = false;
    if (!res.ok) {
      el.autoState.textContent = 'Auto failed';
      return reportFailure(res, 'Auto could not build a recipe.');
    }

    state.autoResult = res;
    state.recipeState = 'auto';
    applyRecipeToControls(res.recipe);
    renderAutoExplanation(res);
    el.autoState.textContent = res.cost.replace('-', ' ') + ' job';
    el.autoState.classList.add('ready');
  }

  function renderAutoExplanation(res) {
    el.autoExplain.hidden = false;
    el.autoExplain.innerHTML = '';
    const head = document.createElement('p');
    head.className = 'auto-head';
    head.textContent = (res.profileInferred ? 'Detected' : 'Chosen') +
      ' profile: ' + res.profile + ' · ' + res.intensity +
      ' · ' + res.cost.replace('-', ' ') + ' job';
    el.autoExplain.appendChild(head);

    for (const line of res.explanations) {
      const p = document.createElement('p');
      p.className = 'auto-line';
      p.textContent = line;
      el.autoExplain.appendChild(p);
    }
    for (const line of res.warnings) {
      const p = document.createElement('p');
      p.className = 'auto-line warn';
      p.textContent = line;
      el.autoExplain.appendChild(p);
    }
  }

  /**
   * Reflect a recipe back into the panel controls.
   * Auto proposes; the user edits from there. Editing one control marks the
   * recipe 'modified' rather than silently discarding the rest of Auto's work.
   */
  function applyRecipeToControls(recipe) {
    if (!recipe) return;
    const r = recipe;
    el.createPlatform.value = r.output.platform || 'custom';

    if (r.reconstruction.mode === 'neural') {
      el.createAi.value = r.reconstruction.aiMode === 'restore'
        ? 'restore'
        : String(r.reconstruction.aiScale);
      el.createAiModel.value = r.reconstruction.model || 'auto';
    } else {
      el.createAi.value = 'off';
    }

    el.createInterp.value = r.motion.interpolation === 'ai' ? 'ai'
      : r.motion.interpolation === 'none' ? 'off' : 'classical';
    el.createFps.value = r.output.fps ? String(r.output.fps) : 'source';
    el.createScene.checked = r.motion.sceneCutProtection !== false;

    if (r.framing.enabled && r.framing.width) {
      el.createRes.value = 'platform';
      // Read tracking back too. Losing it here is what made Auto announce
      // "Smart Reframe enabled" while the control underneath said centre crop
      // and the render obeyed the control.
      el.createFraming.value = framingChoiceFor(r.framing);
    } else if (r.reconstruction.targetResolution.mode === 'custom') {
      const wh = r.reconstruction.targetResolution.width + 'x' +
        r.reconstruction.targetResolution.height;
      el.createRes.value = [...el.createRes.options].some((o) => o.value === wh) ? wh : 'source';
    } else {
      el.createRes.value = 'source';
    }

    el.createAudio.checked = r.audio.enabled;
    el.createLoudness.checked = !!(r.audio.normalize && r.audio.normalize.enabled);
    el.createQuality.value = String(r.output.quality);
    el.createQualityVal.textContent = String(r.output.quality);
    // Remember the mastering choice: the panel has a loudness switch, not a
    // full mastering picker, so Auto's choice would otherwise be lost.
    state.audioMaster = r.audio.master || 'preserve';
    syncPlatformUi();
    syncAiUi();
  }

  function markRecipeModified() {
    if (state.recipeState === 'auto') {
      state.recipeState = 'modified';
      if (!el.autoState.textContent.includes('edited')) {
        el.autoState.textContent += ' · edited';
      }
    }
  }

  async function applyCreatorPreset(id) {
    if (!id) return;
    const res = await api.creatorPresets.apply(id, { analysis: state.analysis, outputPath: null });
    if (!res.ok) return reportFailure(res, 'That preset could not be applied.');
    state.recipeState = 'custom';
    applyRecipeToControls(res.recipe);
    toast('Applied ' + el.createPreset.selectedOptions[0].textContent + '.', 'ok');
  }

  async function refreshSavedRecipes() {
    const res = await api.savedRecipes.list();
    if (!res.ok) return;
    const saved = Object.values(res.recipes || {});
    el.savedRecipeList.innerHTML = '';
    if (!saved.length) return;
    for (const entry of saved.sort((a, b) => b.savedAt - a.savedAt)) {
      const row = document.createElement('div');
      row.className = 'recent';
      const meta = document.createElement('div');
      meta.className = 'recent-meta';
      const t = document.createElement('div');
      t.className = 'recent-title';
      t.textContent = entry.name;
      const sub = document.createElement('div');
      sub.className = 'recent-sub';
      sub.textContent = describeRecipeBriefly(entry.recipe);
      meta.append(t, sub);

      const del = document.createElement('button');
      del.className = 'recent-del';
      del.textContent = '✕';
      del.title = 'Delete preset';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        const r = await api.savedRecipes.remove(entry.id);
        if (r.ok) refreshSavedRecipes();
      });

      row.addEventListener('click', () => {
        state.recipeState = 'custom';
        applyRecipeToControls(entry.recipe);
        toast('Loaded "' + entry.name + '".', 'ok');
      });
      row.append(meta, del);
      el.savedRecipeList.appendChild(row);
    }
  }

  function describeRecipeBriefly(r) {
    const bits = [];
    if (r.framing && r.framing.enabled && r.framing.canvas !== 'source') bits.push(r.framing.canvas);
    if (r.reconstruction && r.reconstruction.mode === 'neural') {
      bits.push(r.reconstruction.aiMode === 'restore'
        ? 'AI restore'
        : 'AI ' + r.reconstruction.aiScale + '×');
    }
    if (r.motion && r.motion.interpolation === 'ai') {
      bits.push('AI ' + (r.motion.targetFps || '') + 'fps');
    }
    if (r.audio && r.audio.master && r.audio.master !== 'preserve') bits.push(r.audio.master);
    return bits.join(' · ') || 'custom settings';
  }

  /* ------------------------------------------------------------------ *
   * Framing
   *
   * One mapping, used in both directions, so the control, the recipe and
   * what the renderer actually executes cannot disagree. Smart Reframe is a
   * crop that *tracks* - `mode: 'fill'` plus `tracking: 'auto'` - and the
   * centre crop is the same crop with the tracking turned off.
   * ------------------------------------------------------------------ */

  const FRAMING_CHOICES = {
    smart: { enabled: true, mode: 'fill', background: 'blur', tracking: 'auto' },
    fill: { enabled: true, mode: 'fill', background: 'blur', tracking: 'center' },
    fit: { enabled: true, mode: 'fit', background: 'blur', tracking: 'center' },
    'fit-black': { enabled: true, mode: 'fit', background: 'black', tracking: 'center' }
  };

  function framingOverride(choice) {
    return { ...(FRAMING_CHOICES[choice] || FRAMING_CHOICES.smart) };
  }

  /** The recipe's framing block -> the control's value. The exact inverse. */
  function framingChoiceFor(framing) {
    if (!framing || !framing.enabled) return 'smart';
    if (framing.mode === 'fill') return framing.tracking === 'auto' ? 'smart' : 'fill';
    return framing.background === 'black' ? 'fit-black' : 'fit';
  }

  /** Panel state -> recipe overrides. */
  function buildRecipeOverrides(outputPath) {
    const platformId = el.createPlatform.value;
    const platform = state.platforms[platformId] || null;
    const overrides = {
      output: {
        platform: platformId,
        encoder: el.createEncoder.value,
        quality: Number(el.createQuality.value),
        path: outputPath,
        container: (outputPath.split('.').pop() || 'mp4').toLowerCase()
      },
      audio: {
        enabled: el.createAudio.checked,
        mode: el.createAudio.checked ? 'encode' : 'none',
        // The panel exposes a loudness switch; Auto and the export presets can
        // pick a fuller mastering chain, and that choice is preserved here.
        master: el.createLoudness.checked
          ? (state.audioMaster && state.audioMaster !== 'preserve' ? state.audioMaster : 'creator')
          : 'preserve',
        normalize: { enabled: el.createLoudness.checked, targetLufs: -14, truePeak: -1, lra: 11 }
      },
      processing: {
        chunking: { mode: el.createChunked.checked ? 'on' : 'auto', chunkSeconds: 60 },
        verify: true
      }
    };

    // Resolution
    const resValue = el.createRes.value;
    if (resValue === 'source') {
      overrides.reconstruction = { enabled: false, targetResolution: { mode: 'source' } };
    } else if (resValue === 'platform' && platform && platform.width) {
      overrides.reconstruction = {
        enabled: true,
        mode: 'classical',
        targetResolution: { mode: 'custom', width: platform.width, height: platform.height }
      };
    } else if (/^\d+x\d+$/.test(resValue)) {
      const [w, h] = resValue.split('x').map(Number);
      overrides.reconstruction = {
        enabled: true,
        mode: 'classical',
        targetResolution: { mode: 'custom', width: w, height: h }
      };
    }

    // Canvas / framing
    if (platform && platform.canvas && platform.canvas !== 'source') {
      overrides.framing = { ...framingOverride(el.createFraming.value), canvas: platform.canvas, width: platform.width, height: platform.height };
    } else {
      overrides.framing = { enabled: false, canvas: 'source' };
    }

    // Frame rate and interpolation
    const fps = el.createFps.value;
    const interp = el.createInterp.value;
    overrides.output.fps = fps === 'source' ? null : Number(fps);
    overrides.motion = {
      enabled: fps !== 'source',
      targetFps: fps === 'source' ? null : Number(fps),
      // 'classical' is ffmpeg duplicating frames; 'ai' is RIFE. Never the same.
      interpolation: interp === 'ai' ? 'ai' : interp === 'classical' ? 'duplicate' : 'none',
      sceneCutProtection: el.createScene.checked,
      sceneCutThreshold: Number(el.createSceneThreshold.value)
    };

    // Neural reconstruction. The requested output size still comes from the
    // resolution control above; this only decides how the pixels are made.
    const ai = el.createAi.value;
    if (ai !== 'off') {
      const scale = ai === 'restore' ? 1 : Number(ai);
      overrides.reconstruction = {
        ...(overrides.reconstruction || {}),
        enabled: true,
        mode: 'neural',
        aiMode: ai === 'restore' ? 'restore' : 'upscale',
        aiScale: scale,
        model: el.createAiModel.value
      };
      // "Same as source" plus AI upscale means the AI scale decides the size.
      if (resValue === 'source' && ai !== 'restore') {
        overrides.reconstruction.targetResolution = { mode: 'source' };
      }
    }

    overrides.processing.gpu = el.createGpu.value === 'auto' ? 'auto' : Number(el.createGpu.value);
    overrides.processing.tileSize = el.createTile.value ? Number(el.createTile.value) : null;

    return overrides;
  }

  /**
   * Watch -> Create. Carries the source and any analysis already done, so the
   * Create tab does not re-probe what the player already knows.
   */
  async function sendToCreate() {
    if (!state.media) return toast('Open a video first.', 'warn');
    document.querySelector('.tab[data-tab="create"]').click();
    refreshCreateSource();
    if (!state.analysis) await analyseSource();
    toast('Ready to finish this video. Auto can suggest settings.', 'ok', 5000);
  }

  /**
   * Build the recipe the panel currently describes, without queueing it.
   * Shared by "render" and "save as preset" so the two can never disagree.
   */
  async function buildCurrentRecipe(outputPath) {
    if (!state.media) {
      toast('Open a video first.', 'warn');
      return null;
    }
    const overrides = buildRecipeOverrides(outputPath || 'preset.mp4');
    overrides.source = state.media.kind === 'local'
      ? { type: 'local', path: state.media.source, title: state.media.title }
      : { type: 'remote', webpageUrl: state.media.source, title: state.media.title };

    const built = el.createUseLook.checked
      ? await api.recipe.fromPreview(state.params, state.analysis, overrides)
      : await api.recipe.default(state.analysis, overrides);
    if (!built.ok) {
      reportFailure(built, 'The recipe could not be built.');
      return null;
    }
    return built.recipe;
  }

  async function startCreate() {
    if (!state.media) return toast('Open a video first.', 'warn');
    if (state.media.isLive) return toast('Live streams cannot be rendered to a file.', 'warn');

    const base = (state.media.title || 'visionance')
      .replace(/\.[a-z0-9]{2,4}$/i, '')
      .replace(/[^\w\s.-]+/g, '')
      .trim()
      .slice(0, 70) || 'visionance';
    const platform = state.platforms[el.createPlatform.value];
    const container = (platform && platform.container) || 'mp4';
    const suffix = platform && platform.id !== 'custom' ? ` (${platform.id})` : ' (visionance)';

    const dest = await api.dialog.saveVideo(`${base}${suffix}.${container}`, container);
    if (!dest.ok) return;

    const overrides = buildRecipeOverrides(dest.file);
    overrides.name = `${base}${suffix}`;
    overrides.source = state.media.kind === 'local'
      ? { type: 'local', path: state.media.source, title: state.media.title }
      // Only the page URL is recorded: the direct stream URL expires, so the
      // job re-resolves it when it actually runs.
      : { type: 'remote', webpageUrl: state.media.source, title: state.media.title };

    // "Apply the look" turns the preview parameters into a starting recipe.
    // The two engines are different; this is intent, not a pixel guarantee.
    const built = el.createUseLook.checked
      ? await api.recipe.fromPreview(state.params, state.analysis, overrides)
      : await api.recipe.default(state.analysis, overrides);
    if (!built.ok) return reportFailure(built, 'The recipe could not be built.');

    const check = await api.recipe.sanitize(built.recipe);
    el.recipeWarnings.innerHTML = '';
    if (check.ok && check.warnings.length) {
      for (const w of check.warnings) {
        const p = document.createElement('p');
        p.className = 'field-help warn';
        p.textContent = w;
        el.recipeWarnings.appendChild(p);
      }
    }
    if (check.ok && !check.valid) {
      return toast(check.errors.map((e) => e.message).join(' '), 'error', 9000);
    }

    const res = await api.jobs.create({
      recipe: check.ok ? check.recipe : built.recipe,
      analysis: state.analysis,
      source: {
        webpageUrl: state.media.kind === 'stream' ? state.media.source : null,
        headerToken: state.media.streamToken || null,
        title: state.media.title
      }
    });
    if (!res.ok) return reportFailure(res, 'The render could not be queued.');

    api.settings.patch({
      create: {
        lastPlatform: el.createPlatform.value,
        lastQuality: Number(el.createQuality.value),
        chunkedRenders: el.createChunked.checked
      }
    });

    toast('Render queued. You can keep watching while it runs.', 'ok');
    upsertJob(res.job);
    document.querySelector('.tab[data-tab="queue"]').click();
  }

  /* ------------------------------------------------------------------ *
   * Queue
   * ------------------------------------------------------------------ */

  function upsertJob(job) {
    state.jobs.set(job.id, job);
    renderJobs();
  }

  const STATUS_LABEL = {
    queued: 'queued',
    ready: 'ready',
    analysing: 'analysing',
    running: 'rendering',
    paused: 'paused',
    cancelling: 'stopping',
    cancelled: 'cancelled',
    failed: 'failed',
    completed: 'done',
    interrupted: 'interrupted'
  };

  function renderJobs() {
    const jobs = [...state.jobs.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    el.jobList.innerHTML = '';
    if (!jobs.length) {
      el.jobList.innerHTML = '<div class="empty-note">No renders yet. Queue one from the Create tab.</div>';
      return;
    }

    for (const job of jobs) {
      el.jobList.appendChild(renderJobCard(job));
    }
  }

  function renderJobCard(job) {
    const node = document.createElement('div');
    node.className = 'job';

    const head = document.createElement('div');
    head.className = 'job-head';
    const title = document.createElement('div');
    title.className = 'job-title';
    title.textContent = job.title;
    title.title = job.output ? job.output.path : '';
    const status = document.createElement('div');
    status.className = `job-status ${job.status}`;
    status.textContent = STATUS_LABEL[job.status] || job.status;
    head.append(title, status);

    const bar = document.createElement('div');
    bar.className = 'job-bar';
    const fill = document.createElement('span');
    fill.style.width = `${Math.round((job.progress || 0) * 100)}%`;
    bar.appendChild(fill);

    const meta = document.createElement('div');
    meta.className = 'job-meta';
    const left = document.createElement('span');
    const stageLabel = job.stage ? `${job.stage.toLowerCase()} · ` : '';
    left.textContent = `${stageLabel}${Math.round((job.progress || 0) * 100)}%`;
    const right = document.createElement('span');
    if (job.status === 'running') {
      right.textContent = `${job.speed ? job.speed.toFixed(2) + '×' : '—'}${job.eta ? ` · ${fmtTime(job.eta)} left` : ''}`;
    } else if (job.status === 'completed' && job.output && job.output.sizeBytes) {
      right.textContent = fmtBytes(job.output.sizeBytes);
    } else {
      right.textContent = '';
    }
    meta.append(left, right);
    node.append(head, bar, meta);

    if (job.plan && job.plan.description) {
      const plan = document.createElement('div');
      plan.className = 'job-plan';
      plan.textContent = job.plan.chunked
        ? `${job.plan.description} · ${job.plan.chunkCount} chunks`
        : job.plan.description;
      node.appendChild(plan);
    }

    // What Smart Reframe actually did, named by the backend that did it. The
    // panel never says "AI framing" when what ran was saliency tracking.
    if (job.reframe) {
      const rf = document.createElement('div');
      rf.className = 'job-plan';
      const pct = Math.round((job.reframe.confidence || 0) * 100);
      rf.textContent = job.reframe.static
        ? `${job.reframe.backendLabel}: subject was static, so the crop is fixed (${pct}% confidence)`
        : `${job.reframe.backendLabel}: crop follows the subject across ${job.reframe.samples} positions ` +
          `(${pct}% confidence${job.reframe.cuts ? `, ${job.reframe.cuts} cuts` : ''})`;
      node.appendChild(rf);
    }

    for (const w of job.warnings || []) {
      const warn = document.createElement('div');
      warn.className = 'job-warning';
      warn.textContent = w;
      node.appendChild(warn);
    }

    if (job.error) {
      const err = document.createElement('div');
      err.className = 'job-error';
      err.textContent = job.error.suggestedAction
        ? `${job.error.message} ${job.error.suggestedAction}`
        : job.error.message;
      if (job.error.technicalDetails) err.title = job.error.technicalDetails;
      node.appendChild(err);
    }

    if (job.verification && !job.verification.ok) {
      for (const failure of job.verification.failures) {
        const v = document.createElement('div');
        v.className = 'job-error';
        v.textContent = failure;
        node.appendChild(v);
      }
    }

    const actions = document.createElement('div');
    actions.className = 'job-actions';
    const button = (label, fn) => {
      const b = document.createElement('button');
      b.className = 'btn btn-ghost';
      b.textContent = label;
      b.addEventListener('click', async () => {
        b.disabled = true;
        const r = await fn();
        if (r && !r.ok) reportFailure(r);
        b.disabled = false;
      });
      actions.appendChild(b);
    };

    if (['queued', 'ready', 'analysing', 'running', 'cancelling'].includes(job.status)) {
      if (job.status === 'running' && job.pauseSupported) button('Pause', () => api.jobs.pause(job.id));
      if (job.status !== 'cancelling') button('Cancel', () => api.jobs.cancel(job.id));
    }
    if (['paused', 'interrupted'].includes(job.status)) {
      button('Resume', () => api.jobs.resume(job.id));
      button('Cancel', () => api.jobs.cancel(job.id));
    }
    if (['failed', 'cancelled'].includes(job.status)) {
      button('Retry', () => api.jobs.retry(job.id));
      button('Remove', () => api.jobs.remove(job.id));
    }
    if (job.status === 'completed' && job.output) {
      button('Play', () => api.system.openPath(job.output.path));
      button('Show in folder', () => api.system.reveal(job.output.path));
      button('Remove', () => api.jobs.remove(job.id));
    }
    if (actions.children.length) node.appendChild(actions);

    return node;
  }

  /* ------------------------------------------------------------------ *
   * Library
   * ------------------------------------------------------------------ */

  function renderRecents(recents) {
    el.recentList.innerHTML = '';
    if (!recents || !recents.length) {
      el.recentList.innerHTML = '<div class="empty-note">Nothing here yet. Videos you play will show up for one-click reopening.</div>';
      return;
    }
    for (const item of recents) {
      const row = document.createElement('div');
      row.className = 'recent';

      const icon = document.createElement('div');
      icon.className = 'recent-icon';
      icon.innerHTML = item.kind === 'stream' ? ICONS.link : ICONS.file;

      const meta = document.createElement('div');
      meta.className = 'recent-meta';
      const t = document.createElement('div');
      t.className = 'recent-title';
      t.textContent = item.title || item.source;
      const s = document.createElement('div');
      s.className = 'recent-sub';
      s.textContent = item.kind === 'stream' ? 'Online stream' : item.source;
      meta.append(t, s);

      const del = document.createElement('button');
      del.className = 'recent-del';
      del.textContent = '✕';
      del.title = 'Remove';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        const r = await api.recents.remove(item.source);
        if (r.ok) renderRecents(r.recents);
      });

      row.addEventListener('click', () => {
        if (item.kind === 'stream') openUrl(item.source);
        else openLocalFile(item.source);
      });

      row.append(icon, meta, del);
      el.recentList.appendChild(row);
    }
  }

  /* ------------------------------------------------------------------ *
   * Settings modal
   * ------------------------------------------------------------------ */

  function openSettings() {
    el.settingsModal.hidden = false;
    refreshDependencyStatus();
    refreshEngines();
    refreshRuntimeStatus();
  }

  async function refreshDependencyStatus() {
    const res = await api.app.info();
    if (!res.ok) return;
    state.info = res;

    const yt = res.binaries.ytdlp;
    if (yt.path) {
      const bits = [`Installed — ${yt.version || 'version unknown'}`];
      if (yt.stale) bits.push(`${yt.ageDays} days old; sites change faster than that.`);
      bits.push(yt.jsRuntimes && yt.jsRuntimes.length
        ? `JavaScript runtime: ${yt.jsRuntimes.join(', ')}.`
        : 'No JavaScript runtime found; some sites may withhold higher qualities.');
      el.ytdlpStatus.textContent = bits.join(' ');
      el.installYtdlpBtn.textContent = 'Reinstall';
    } else {
      el.ytdlpStatus.textContent = 'Not found. Online video playback needs it.';
      el.installYtdlpBtn.textContent = 'Install';
    }

    const ff = res.binaries.ffmpeg;
    el.ffmpegStatus.textContent = ff.path
      ? `Ready — ${(ff.version || '').replace('ffmpeg version ', '').split(' ')[0] || 'ok'}`
      : 'Not found. Exporting is unavailable until ffmpeg is located.';

    el.aboutText.textContent =
      `Visionance ${res.version} · Electron ${res.versions.electron} · Chromium ${res.versions.chrome} · ${res.platform}/${res.arch}`;

    const caps = await api.app.capabilities();
    if (caps.ok) {
      const c = caps.capabilities;
      const hw = c.ffmpeg.hardwareEncoders.map((e) => e.label).join(', ') || 'none detected';
      const gpu = c.gpus.length ? c.gpus.map((g) => g.name).filter(Boolean).join(', ') : 'unknown';
      el.capabilityText.textContent =
        `${c.cpu.model || 'CPU unknown'} · ${c.cpu.cores || '?'} cores · ` +
        `${Math.round(c.memory.totalBytes / 1073741824)} GB RAM\n` +
        `GPU: ${gpu}\nHardware encoders: ${hw}`;
    }
  }

  function bindSettings() {
    el.settingsBtn.addEventListener('click', openSettings);
    el.closeSettings.addEventListener('click', () => { el.settingsModal.hidden = true; });
    el.settingsModal.addEventListener('mousedown', (e) => {
      if (e.target === el.settingsModal) el.settingsModal.hidden = true;
    });

    el.closeInfo.addEventListener('click', () => { el.infoModal.hidden = true; });
    el.infoModal.addEventListener('mousedown', (e) => {
      if (e.target === el.infoModal) el.infoModal.hidden = true;
    });
    el.emptyDemoBtn.addEventListener('click', () => { el.infoModal.hidden = false; });

    el.installYtdlpBtn.addEventListener('click', async () => {
      el.installYtdlpBtn.disabled = true;
      el.ytdlpStatus.textContent = 'Downloading…';
      const off = api.ytdlp.onProgress((f) => {
        el.ytdlpStatus.textContent = `Downloading… ${Math.round(f * 100)}%`;
      });
      const res = await api.ytdlp.install();
      off();
      el.installYtdlpBtn.disabled = false;
      if (res.ok) {
        toast('yt-dlp installed. Online videos are ready.', 'ok');
        refreshDependencyStatus();
      } else {
        el.ytdlpStatus.textContent = res.error;
        toast(res.error, 'error', 8000);
      }
    });

    el.locateYtdlpBtn.addEventListener('click', async () => {
      const r = await api.dialog.pickBinary('ytdlp');
      if (r.ok) { toast('yt-dlp location saved.', 'ok'); refreshDependencyStatus(); }
    });
    el.locateFfmpegBtn.addEventListener('click', async () => {
      const r = await api.dialog.pickBinary('ffmpeg');
      if (r.ok) { toast('ffmpeg location saved.', 'ok'); refreshDependencyStatus(); }
    });

    el.maxHeight.addEventListener('change', () =>
      api.settings.patch({ maxStreamHeight: Number(el.maxHeight.value) }));

    el.authMode.addEventListener('change', () => {
      syncAuthUi();
      api.settings.patch({ auth: { mode: el.authMode.value } });
    });
    el.authBrowser.addEventListener('change', () =>
      api.settings.patch({ auth: { browser: el.authBrowser.value } }));
    el.pickCookiesBtn.addEventListener('click', async () => {
      const r = await api.dialog.pickCookiesFile();
      if (r.ok) {
        el.authFileStatus.textContent = r.path;
        toast('Cookies file saved.', 'ok');
      }
    });
    el.autoplayToggle.addEventListener('change', () => {
      state.settings.autoplay = el.autoplayToggle.checked;
      api.settings.patch({ autoplay: el.autoplayToggle.checked });
    });
    el.resumeToggle.addEventListener('change', () => {
      state.settings.rememberPosition = el.resumeToggle.checked;
      api.settings.patch({ rememberPosition: el.resumeToggle.checked });
    });
    el.targetFpsSelect.addEventListener('change', () => {
      const fps = Number(el.targetFpsSelect.value);
      if (state.engine) state.engine.targetFps = fps;
      api.settings.patch({ targetFps: fps });
    });
  }

  function syncAuthUi() {
    const mode = el.authMode.value;
    el.authBrowserRow.hidden = mode !== 'browser';
    el.authFileRow.hidden = mode !== 'file';
  }

  /* ------------------------------------------------------------------ *
   * Global bindings
   * ------------------------------------------------------------------ */

  function bindGlobal() {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        document.querySelectorAll('.tab-page').forEach((p) => p.classList.remove('active'));
        tab.classList.add('active');
        document.querySelector(`.tab-page[data-page="${tab.dataset.tab}"]`).classList.add('active');
      });
    });

    el.goBtn.addEventListener('click', onOmnibarPlay);
    el.urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') onOmnibarPlay();
    });
    el.urlInput.addEventListener('paste', () => {
      setTimeout(() => {
        if (isUrl(el.urlInput.value)) openUrl(el.urlInput.value);
      }, 30);
    });

    const pickFile = async () => {
      const res = await api.dialog.openVideo();
      if (res.ok) openLocalFile(res.files[0]);
    };
    el.openFileBtn.addEventListener('click', pickFile);
    el.emptyOpenBtn.addEventListener('click', pickFile);

    el.watchQuality.addEventListener('change', () => {
      state.watchQuality = el.watchQuality.value;
      if (state.engine) state.engine.setPolicy(state.watchQuality);
      api.settings.patch({ watchQuality: state.watchQuality });
    });

    el.scaleSelect.addEventListener('change', () => {
      const value = el.scaleSelect.value;
      state.engine && state.engine.setRenderScaleCap(value === 'auto' ? 'auto' : Number(value));
      api.settings.patch({ renderScale: value });
    });

    el.adaptiveToggle.addEventListener('change', () => {
      if (state.engine) state.engine.setAdaptive(el.adaptiveToggle.checked);
      api.settings.patch({ adaptiveQuality: el.adaptiveToggle.checked });
    });

    el.savePresetBtn.addEventListener('click', async () => {
      const name = el.presetName.value.trim();
      if (!name) return toast('Give the preset a name first.', 'warn');
      const preset = {
        id: `user_${Date.now()}`,
        name,
        tag: 'Custom',
        description: 'Your saved look.',
        params: { ...state.params }
      };
      const r = await api.presets.save(preset);
      if (r.ok) {
        state.userPresets = r.presets;
        state.presetId = preset.id;
        el.presetName.value = '';
        renderPresetGrid();
        toast(`Saved "${name}".`, 'ok');
      }
    });

    el.resetParamsBtn.addEventListener('click', () => {
      const preset = findPreset(state.presetId) || findPreset('balanced');
      applyParams(preset.params, preset.id);
      toast(`Reset to ${preset.name}.`);
    });

    el.createQuality.addEventListener('input', () => {
      el.createQualityVal.textContent = el.createQuality.value;
    });
    el.createPlatform.addEventListener('change', syncPlatformUi);
    el.createAi.addEventListener('change', syncAiUi);
    el.createAiModel.addEventListener('change', syncAiUi);
    el.createInterp.addEventListener('change', syncAiUi);
    el.createSceneThreshold.addEventListener('input', () => {
      el.createSceneThresholdVal.textContent = Number(el.createSceneThreshold.value).toFixed(2);
    });
    el.installEnginesBtn.addEventListener('click', async () => {
      el.installEnginesBtn.disabled = true;
      for (const id of ['realesrgan', 'rife']) {
        if (!engineReady(id)) await installEngine(id);
      }
      el.installEnginesBtn.disabled = false;
    });
    el.installRuntimeBtn.addEventListener('click', async () => {
      el.installRuntimeBtn.disabled = true;
      el.runtimeStatus.textContent = 'Installing…';
      const off = api.runtime.onProgress((p) => {
        el.runtimeStatus.textContent = p.phase === 'download'
          ? `Downloading… ${Math.round((p.fraction || 0) * 100)}%`
          : 'Unpacking…';
      });
      const res = await api.runtime.install();
      off();
      el.installRuntimeBtn.disabled = false;
      if (!res.ok) reportFailure(res, 'The runtime could not be installed.');
      refreshRuntimeStatus();
    });
    el.analyseBtn.addEventListener('click', analyseSource);
    el.autoBuildBtn.addEventListener('click', runAuto);
    el.createPreset.addEventListener('change', () => applyCreatorPreset(el.createPreset.value));
    for (const control of [el.createAi, el.createAiModel, el.createInterp, el.createRes,
      el.createFps, el.createFraming, el.createAudio, el.createLoudness, el.createQuality]) {
      control.addEventListener('change', markRecipeModified);
    }
    el.saveRecipeBtn.addEventListener('click', async () => {
      const name = el.recipeName.value.trim();
      if (!name) return toast('Give the preset a name first.', 'warn');
      const built = await buildCurrentRecipe(null);
      if (!built) return;
      const r = await api.savedRecipes.save(name, built);
      if (!r.ok) return reportFailure(r, 'The preset could not be saved.');
      el.recipeName.value = '';
      refreshSavedRecipes();
      toast('Saved "' + name + '".', 'ok');
    });
    el.sendToCreateBtn.addEventListener('click', sendToCreate);
    el.startCreateBtn.addEventListener('click', startCreate);
    el.clearJobsBtn.addEventListener('click', async () => {
      const r = await api.jobs.clear();
      if (r.ok) {
        state.jobs.clear();
        r.jobs.forEach((j) => state.jobs.set(j.id, j));
        renderJobs();
      }
    });
    el.clearRecentsBtn.addEventListener('click', async () => {
      const r = await api.recents.clear();
      if (r.ok) renderRecents(r.recents);
    });

    // Drag & drop
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragDepth++;
      el.dropOverlay.hidden = false;
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('dragleave', (e) => {
      e.preventDefault();
      if (--dragDepth <= 0) { dragDepth = 0; el.dropOverlay.hidden = true; }
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      el.dropOverlay.hidden = true;

      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) {
        const p = api.pathForFile(file);
        if (p) return openLocalFile(p);
      }
      const text = e.dataTransfer.getData('text/plain');
      if (isUrl(text)) {
        el.urlInput.value = text;
        openUrl(text);
      } else {
        toast('That does not look like a video file or link.', 'warn');
      }
    });

    // Keyboard
    window.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (typing) {
        if (e.key === 'Escape') document.activeElement.blur();
        return;
      }
      if (!el.settingsModal.hidden || !el.infoModal.hidden) {
        if (e.key === 'Escape') { el.settingsModal.hidden = true; el.infoModal.hidden = true; }
        return;
      }

      switch (e.key.toLowerCase()) {
        case ' ':
        case 'k': e.preventDefault(); media.toggle(); break;
        case 'arrowleft': media.seek(el.video.currentTime - (e.shiftKey ? 60 : 5)); break;
        case 'arrowright': media.seek(el.video.currentTime + (e.shiftKey ? 60 : 5)); break;
        case 'j': media.seek(el.video.currentTime - 10); break;
        case 'l': media.seek(el.video.currentTime + 10); break;
        case 'arrowup': e.preventDefault(); nudgeVolume(0.05); break;
        case 'arrowdown': e.preventDefault(); nudgeVolume(-0.05); break;
        case 'm': media.setMuted(!media.muted); updateMuteIcon(); break;
        case 'f': toggleFullscreen(); break;
        case 'c': setCompare(state.compare ? 0 : 1); break;
        case 'b': el.enhanceToggle.click(); break;
        case 's': takeSnapshot(); break;
        case 'escape':
          if (document.body.classList.contains('is-fullscreen')) toggleFullscreen();
          break;
        default:
          if (/^[0-9]$/.test(e.key) && el.video.duration) {
            media.seek((Number(e.key) / 10) * el.video.duration);
          }
      }
    });

    el.stageInner.addEventListener('click', (e) => {
      if (e.target === el.glCanvas) media.toggle();
    });
    el.stageInner.addEventListener('dblclick', (e) => {
      if (e.target === el.glCanvas) toggleFullscreen();
    });

    // Menu commands from the main process
    api.events.onMenu((command) => {
      const actions = {
        'open-file': pickFile,
        'open-url': () => el.urlInput.focus(),
        create: sendToCreate,
        'toggle-play': () => media.toggle(),
        'toggle-enhance': () => el.enhanceToggle.click(),
        'toggle-compare': () => setCompare(state.compare ? 0 : 1),
        'toggle-stats': () => el.statsBtn.click(),
        fullscreen: toggleFullscreen
      };
      const fn = actions[command];
      if (fn) fn();
    });

    api.events.onExternalFile((filePath) => openLocalFile(filePath));
    api.jobs.onUpdate((job) => upsertJob(job));
    api.jobs.onRemoved((id) => { state.jobs.delete(id); renderJobs(); });

    window.addEventListener('beforeunload', () => {
      if (state.resumeKey && state.settings && state.settings.rememberPosition) {
        api.resume.set(state.resumeKey, el.video.currentTime);
      }
      api.system.keepAwake(false);
    });
  }

  function nudgeVolume(delta) {
    const next = Math.max(0, Math.min(1, parseFloat(el.volume.value) + delta));
    el.volume.value = next;
    el.volume.dispatchEvent(new Event('input'));
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  async function boot() {
    const [settingsRes, presetsRes, recentsRes] = await Promise.all([
      api.settings.get(),
      api.presets.get(),
      api.recents.get()
    ]);

    state.settings = settingsRes.ok ? settingsRes.settings : {};
    state.userPresets = presetsRes.ok ? presetsRes.presets : {};

    applyIcons();
    buildControls();
    initPlaybackStats();
    initEngine();

    const startPreset = findPreset(state.settings.lastPresetId) || findPreset('balanced');
    applyParams(startPreset.params, startPreset.id);

    // Reflect persisted settings in the UI.
    el.volume.value = state.settings.volume ?? 1;
    el.scaleSelect.value = String(state.settings.renderScale ?? 'auto');
    el.adaptiveToggle.checked = state.settings.adaptiveQuality !== false;
    el.autoplayToggle.checked = state.settings.autoplay !== false;
    el.resumeToggle.checked = state.settings.rememberPosition !== false;
    el.targetFpsSelect.value = String(state.settings.targetFps || 60);
    state.watchQuality = state.settings.watchQuality || 'auto';
    el.watchQuality.value = state.watchQuality;
    el.maxHeight.value = String(state.settings.maxStreamHeight ?? 0);

    const auth = state.settings.auth || { mode: 'none' };
    el.authMode.value = auth.mode || 'none';
    if (auth.browser) el.authBrowser.value = auth.browser;
    el.authFileStatus.textContent = auth.cookiesFile || 'No file chosen.';
    syncAuthUi();

    const create = state.settings.create || {};
    el.createQuality.value = String(create.lastQuality ?? 70);
    el.createQualityVal.textContent = el.createQuality.value;
    el.createChunked.checked = !!create.chunkedRenders;
    updateMuteIcon();

    if (state.engine) {
      state.engine.setAdaptive(el.adaptiveToggle.checked);
      // Policy is applied last: 'maximum' means "do not adapt at all", and it
      // must not be re-enabled by the legacy adaptive checkbox.
      state.engine.setPolicy(state.watchQuality);
      state.engine.targetFps = Number(el.targetFpsSelect.value);
      state.engine.setRenderScaleCap(
        el.scaleSelect.value === 'auto' ? 'auto' : Number(el.scaleSelect.value)
      );
    }

    bindTransport();
    bindSplit();
    bindStats();
    bindSettings();
    bindGlobal();
    bindIdle();

    renderRecents(recentsRes.ok ? recentsRes.recents : []);
    populateEncoders();
    await populatePlatforms();
    refreshCreateSource();
    bindEngineEvents();
    await populateAuto();
    refreshSavedRecipes();
    refreshEngines();
    refreshRuntimeStatus();
    refreshDependencyStatus().then(() => {
      if (state.info && !state.info.binaries.ytdlp.path) {
        toast('Install yt-dlp in Settings to play online video links.', 'warn', 8000);
      }
    });

    const jobsRes = await api.jobs.list();
    if (jobsRes.ok) jobsRes.jobs.forEach((j) => state.jobs.set(j.id, j));
    renderJobs();
    const interrupted = [...state.jobs.values()].filter((j) => j.status === 'interrupted');
    if (interrupted.length) {
      toast(
        `${interrupted.length} render${interrupted.length === 1 ? '' : 's'} stopped when Visionance last closed. Resume them in the Queue tab.`,
        'warn', 9000
      );
    }

    // Persist the active preset so the next launch feels continuous.
    setInterval(() => {
      if (state.presetId !== '__custom' && state.settings.lastPresetId !== state.presetId) {
        state.settings.lastPresetId = state.presetId;
        api.settings.patch({ lastPresetId: state.presetId });
      }
      updateResBadge();
    }, 3000);
  }

  // A failure during boot must be visible, not a silently half-built UI.
  document.addEventListener('DOMContentLoaded', () => {
    boot().then(() => {
      // Lets a harness wait for a finished UI instead of guessing at a delay.
      window.__visionanceReady = true;
    }).catch((err) => {
      window.__visionanceBootError = `${err && err.message}
${err && err.stack}`;
      console.error('Visionance failed to start', err);
      toast(`Visionance did not start cleanly: ${err && err.message}`, 'error', 12000);
    });
  });
})();
