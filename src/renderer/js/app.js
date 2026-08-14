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
  const { ICONS, togglePopover, closePopover, fmtTime, fmtBytes, chip } = window.VSUiKit;
  const thumbs = window.VSThumbs;
  const telemetry = window.VSTelemetry;

  const $ = (id) => document.getElementById(id);

  /**
   * The icon set lives in ui-kit.js; this only says which button wears which.
   * Every control that ships a glyph gets one here, so nothing depends on the
   * host having a font that covers an obscure unicode symbol.
   */
  function applyIcons() {
    const map = {
      playBtn: ICONS.play,
      back10Btn: ICONS.back10,
      fwd10Btn: ICONS.fwd10,
      muteBtn: ICONS.volume,
      snapshotBtn: ICONS.camera,
      playerSettingsBtn: ICONS.sliders,
      pipBtn: ICONS.pip,
      fullscreenBtn: ICONS.fullscreen,
      statsBtn: ICONS.stats,
      settingsBtn: ICONS.gear,
      // The top bar is the window's title bar now, so the file action is an
      // icon beside the other shell controls rather than a labelled button
      // competing with the workspace navigation.
      openFileBtn: ICONS.folder,
      // Create's preview transport uses the same icon set, so the two players
      // read as the same instrument at different jobs.
      createPlayBtn: ICONS.play,
      createMuteBtn: ICONS.volume,
      createFullscreenBtn: ICONS.fullscreen
    };
    for (const [id, icon] of Object.entries(map)) {
      if (el[id]) el[id].innerHTML = icon;
    }
  }

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */

  const state = {
    engine: null,
    media: null,          // descriptor of what is loaded
    params: null,
    baseParams: {},       // the preset values the current params started from
    presetId: 'balanced',
    userPresets: {},
    settings: null,
    info: null,
    compare: 0,           // 0 off, 1 split
    workspace: 'presets', // which top-level tab is showing
    presentation: null,   // 'native' | 'enhanced'
    playback: null,       // PlaybackStats
    watchQuality: 'auto',
    splitX: 0.5,
    splitDragging: false,
    scrubbing: false,
    dualStream: false,
    // Set once a split stream's audio leg has failed and playback has been
    // recovered as video-only, so the recovery runs once per source rather
    // than on every error event the dead element emits.
    audioLegFailed: false,
    jobs: new Map(),
    analysis: null,        // full source analysis for the loaded media

    /**
     * Create's own source, deliberately not `state.media`.
     *
     * A descriptor and its analysis, never a player handle. Watch owns the
     * video element; Create owns an intention to render something. Sharing one
     * object meant choosing a file to render changed what was playing, and
     * opening something to watch silently re-aimed a render being set up.
     */
    createSource: null,
    createAnalysis: null,
    previewTimer: null,
    previewGeneration: 0,
    /** The plan the main process resolved for the current panel state. */
    resolvedPlan: null,
    aspects: {},

    analysisPending: false,
    platforms: {},
    encoders: [],
    engines: {},
    semantic: null,
    /** Which reading of the job list the operations console is showing. */
    consoleTab: 'queue',
    /** Last thumbnail-cache answer, so the console can state it without asking. */
    thumbCache: null,
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
    'createOpenFileBtn', 'createUseWatchBtn', 'createUrlInput', 'createUrlBtn',
    'createPlatform', 'createRes', 'createFraming', 'createFramingRow', 'createFramingHelp', 'createFps',
    'createAspect', 'createAspectCustomRow', 'createAspectW', 'createAspectH',
    'createResCustomRow', 'createResW', 'createResH', 'createGeometryNote',
    'createCostPreview', 'createCostClass', 'createCostDetail',
    'createEncoder', 'createQuality', 'createQualityVal', 'createUseLook',
    'createAudio', 'createLoudness', 'createChunked', 'startCreateBtn', 'recipeWarnings',
    'aiBlock', 'aiEngineState', 'createAi', 'createAiModelRow', 'createAiModel', 'createAiNote',
    'createAiQualityRow', 'createAiQuality', 'createAiQualityNote',
    'createInterp', 'createSceneRow', 'createScene', 'createSceneHelp', 'createFpsHelp',
    'installEnginesBtn', 'engineProgress', 'createGpu', 'createTile',
    'createSceneThreshold', 'createSceneThresholdVal', 'createModelDetail',
    'engineList', 'runtimeStatus', 'installRuntimeBtn',
    'semanticStatus', 'installSemanticBtn', 'removeSemanticBtn',
    'jobList', 'clearJobsBtn', 'recentList', 'clearRecentsBtn', 'dropOverlay',
    'settingsModal', 'closeSettings', 'ytdlpStatus', 'installYtdlpBtn', 'locateYtdlpBtn',
    'maxHeight', 'authMode', 'authBrowser', 'authBrowserRow', 'authFileRow',
    'authFileStatus', 'pickCookiesBtn', 'capabilityText',
    'ffmpegStatus', 'locateFfmpegBtn',
    'autoplayToggle', 'resumeToggle', 'targetFpsSelect', 'aboutText',
    'infoModal', 'closeInfo', 'emptyOpenBtn', 'emptyDemoBtn', 'brandSub',
    // Shell, player settings, thumbnails, telemetry and the redesigned panels.
    'queueCount', 'jobStrip', 'playerSettingsBtn', 'playerPopover', 'loopToggle',
    'popoverQuality', 'popoverSource', 'popoverStats', 'popoverStatsState', 'popoverInfo',
    'utilityStrip', 'utilitySource', 'utilityQueue', 'utilityTelemetry',
    'settingsTelemetry', 'settingsNav', 'createThumb', 'createSourceSub',
    'createSemanticNote', 'renderSummary', 'queueSummary', 'librarySummary',
    'tagOutput', 'tagFraming', 'tagEnhancement', 'tagMotion', 'tagColor', 'tagAudio',
    'groupOutput', 'groupFraming', 'groupEnhancement', 'groupMotion',
    'ytdlpDot', 'runtimeDot', 'ffmpegDot', 'semanticDot', 'semanticDetail',
    'thumbCacheStatus', 'clearThumbsBtn', 'lookState',
    // Visual composition: the Watch source card, the console tags and the
    // render-scale tag. All read-only readouts of existing state.
    'watchSource', 'watchThumb', 'watchTitle', 'watchMeta', 'watchState',
    'renderScaleTag', 'utilitySourceTag', 'utilityQueueTag', 'utilityPerfTag',
    // The workstation shell: source column, process strip, operations console
    // and status bar. Every one of these is a readout of state that already
    // exists; none of them polls anything of its own.
    'topbar', 'sourceColumn', 'sourceSpecs', 'sourceDetails',
    'createKindTag', 'watchSourceTag',
    'processStrip', 'psLook', 'psLookTag', 'psEnhance', 'psEnhanceTag',
    'psEngine', 'psEngineTag',
    'consoleTabs', 'consoleEngines', 'consoleEngineTag',
    // Fine Tune, which is the former Adjust inspector living inside Watch.
    'groupFineTune', 'fineTuneTag', 'adjustEnhanceState', 'adjustRenderTag',
    'adjustToCreateBtn',
    'statusbar', 'sbVersion', 'sbHealth', 'sbRender', 'sbDevice',
    'queueStats', 'queueStateTag', 'queueEngines',
    'queueActive', 'queueActiveTag', 'queueStorage',
    // Create as the starting workspace: its state strip and its own recents
    // intake. Both are readouts of the job map and the recents list.
    'createHomeStats', 'createRecents', 'createRecentsTag',
    // Create's own preview player: a separate element, transport and empty
    // state, sharing the stage's geometry and nothing else.
    'createVideo', 'createAudio', 'createEmpty', 'createPreviewBadge',
    'createPreviewError', 'createPreviewErrorText', 'createPreviewTag',
    'createTransport', 'createScrub', 'createScrubBuffered', 'createScrubPlayed',
    'createScrubKnob', 'createPlayBtn', 'createMuteBtn', 'createVolume',
    'createTimeLabel', 'createFullscreenBtn',
    'createEmptyOpenBtn', 'createEmptyWatchBtn'
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
      state.audioLegFailed = false;
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
      if (el.audio.error) return media.recoverFromAudioFailure();
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
      if (state.dualStream && !el.audio.error) el.audio.currentTime = t;
    },

    setVolume(vol) {
      const target = state.dualStream && !el.audio.error ? el.audio : el.video;
      target.volume = vol;
      if (vol > 0) target.muted = false;
    },

    setMuted(muted) {
      const target = state.dualStream && !el.audio.error ? el.audio : el.video;
      target.muted = muted;
    },

    get muted() {
      return state.dualStream && !el.audio.error ? el.audio.muted : el.video.muted;
    },

    setRate(rate) {
      el.video.playbackRate = rate;
      el.audio.playbackRate = rate;
    },

    /**
     * Recover a split stream whose audio leg died.
     *
     * A site can serve the video format and refuse the audio one — YouTube
     * returns 403 on the opus URL often enough that it is an ordinary
     * condition, not an edge case. There was no handling for it at all, and
     * the result was the worst possible outcome: the `<audio>` element failed
     * with DEMUXER_ERROR, the video element sat at `seeking: true` forever on
     * the position the resume restored, and the user got a black picture with
     * a full inspector and no explanation.
     *
     * The video leg is healthy in this situation, so the picture is
     * recoverable. Drop to a single stream, re-arm the video element — which
     * is what clears the stuck seek — and say plainly that the sound is
     * missing rather than pretending nothing happened.
     */
    recoverFromAudioFailure() {
      const v = el.video;
      const a = el.audio;
      // Keyed on the element rather than on `dualStream`: "this element was
      // given a source and that source failed" is the condition that matters,
      // and it stays true however the split arrangement was arrived at.
      if (state.audioLegFailed || !a.getAttribute('src') || !a.error) return;
      state.audioLegFailed = true;
      state.dualStream = false;
      const resumeAt = v.currentTime;
      const wasPlaying = !v.paused;

      a.pause();
      a.removeAttribute('src');
      try { a.load(); } catch { /* nothing to abort */ }

      // The video element carries the sound settings again now that nothing
      // else does, even though a video-only leg has no audible track.
      v.muted = !!state.settings.muted;
      v.volume = state.settings.volume ?? 1;

      // Re-arm rather than leave the pipeline in its stuck seek. Restoring the
      // position afterwards keeps the recovery invisible apart from the sound.
      const src = v.getAttribute('src');
      if (src) {
        const restore = () => {
          if (Number.isFinite(resumeAt) && resumeAt > 0) {
            try { v.currentTime = resumeAt; } catch { /* start from the top */ }
          }
          if (wasPlaying) media.play();
        };
        v.addEventListener('loadedmetadata', restore, { once: true });
        v.load();
      }

      toast('This source refused its audio track, so it is playing without sound. ' +
        'The picture is unaffected.', 'warn', 9000);
      refreshWatchSurfaces();
    },

    /** Keep the separate audio track locked to the video clock. */
    syncDrift() {
      if (!state.dualStream || el.video.paused) return;
      if (el.audio.error) return;
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
  /** The same message reportFailure would toast, for callers that show it in place. */
  function describeFailure(res, fallback) {
    return (res && (res.message || res.error)) || fallback || 'Something went wrong.';
  }

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
   * Every route into playback goes through switchSource(): the source bar, the
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
      // Deliberately NOT state.createSource: Create holds its own source, and
      // changing what Watch is playing must not disturb a render being set up.
      state.resumeKey = null;
      state.lastSavedPosition = 0;
      state.source.token = null;
      state.source.key = null;
      window.__vsLastMedia = null;
      if (state.playback) state.playback.reset();
      el.resBadge.textContent = '—';
      refreshWatchSurfaces();
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
      el.brandSub.textContent = descriptor.title || 'No source';
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
      refreshWatchSurfaces();
      api.system.keepAwake(true);

      api.recents.add({
        source: descriptor.source,
        kind: descriptor.kind,
        title: descriptor.title,
        duration: descriptor.info ? descriptor.info.duration : null,
        // Recorded so the Library can show this source's real poster later,
        // without re-resolving the page to ask for it again.
        thumbnail: descriptor.thumbnail || null
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
   * Watch's Play button.
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
      /**
       * A readback of what is actually on the enhanced canvas.
       *
       * The WebGL context runs with `preserveDrawingBuffer: false`, so nothing
       * outside the engine can read the composited frame after the fact — the
       * picture harness would see an empty buffer and report black for a
       * picture that is plainly on screen. This is the same draw-then-read the
       * Save Frame button uses, and it costs nothing until it is called.
       */
      frame: () => (state.engine ? state.engine.snapshot() : null),
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
    // The baseline every "modified" marker and per-slider reset measures from.
    state.baseParams = { ...params };
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
    // No card is active once a slider has moved, so say so rather than leaving
    // the grid looking as if nothing is selected for no reason.
    el.lookState.hidden = state.presetId !== '__custom';
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

  /**
   * Fine Tune is generated from the slider definitions, so adding a
   * parameter is one line in presets.js. Each group is a collapsible section
   * whose summary reports how many of its parameters differ from the preset -
   * which is the question you actually have when the group is closed.
   *
   * Parameter changes go straight to the engine, as they always have: the
   * shader uniforms are set per draw, so there is nothing to debounce and
   * nothing that reaches the main process. Debouncing here would only add
   * latency to a control whose whole point is that it is live.
   */
  function buildControls() {
    el.controlGroups.innerHTML = '';
    for (const [index, group] of CONTROLS.entries()) {
      const wrap = document.createElement('details');
      wrap.className = 'group';
      // All three open: this is a parameter inspector, and a colourist opening
      // three disclosures before touching a slider is friction, not tidiness.
      wrap.open = true;
      void index;

      // A processing module, not a plain disclosure: an index, a name, a
      // one-line statement of where in the chain it runs, and a count of what
      // has been moved off the preset.
      const summary = document.createElement('summary');
      const index_mark = document.createElement('span');
      index_mark.className = 'module-index';
      index_mark.textContent = String(index + 1).padStart(2, '0');
      summary.append(index_mark, document.createTextNode(group.group));
      const tag = document.createElement('span');
      tag.className = 'gtag';
      summary.appendChild(tag);
      wrap.appendChild(summary);

      const body = document.createElement('div');
      body.className = 'group-body';
      if (group.hint) {
        const hint = document.createElement('p');
        hint.className = 'module-purpose in-body';
        hint.textContent = group.hint;
        body.appendChild(hint);
      }

      for (const item of group.items) {
        const ctrl = document.createElement('div');
        ctrl.className = 'ctrl';

        const head = document.createElement('div');
        head.className = 'ctrl-head';
        const label = document.createElement('label');
        label.textContent = item.label;
        label.htmlFor = `ctrl_${item.key}`;

        const right = document.createElement('div');
        right.className = 'ctrl-head-right';
        const val = document.createElement('span');
        val.className = 'cval';
        const reset = document.createElement('button');
        reset.className = 'ctrl-reset';
        reset.innerHTML =
          '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" ' +
          'stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
          '<path d="M4.5 9.5A8 8 0 1 1 4 13"/><path d="M3.5 4.5v5h5"/></svg>';
        reset.title = `Reset ${item.label} to the preset value`;
        reset.setAttribute('aria-label', `Reset ${item.label}`);
        right.append(val, reset);
        head.append(label, right);

        const input = document.createElement('input');
        input.type = 'range';
        input.id = `ctrl_${item.key}`;
        input.min = item.min;
        input.max = item.max;
        input.step = item.step;
        input.setAttribute('aria-label', item.label);

        // Where the handle sits in its own range, as a percentage the
        // stylesheet paints the travelled part of the track with.
        const paintFill = (v) => {
          const span = item.max - item.min;
          const fill = span > 0 ? ((v - item.min) / span) * 100 : 0;
          input.style.setProperty('--fill', `${Math.max(0, Math.min(100, fill)).toFixed(1)}%`);
        };

        const apply = (v) => {
          val.textContent = v.toFixed(2);
          paintFill(v);
          state.params[item.key] = v;
          state.engine && state.engine.setParams({ [item.key]: v });
          markCustom();
          markControlState(item.key);
          updateGroupTag(group);
        };

        input.addEventListener('input', () => apply(parseFloat(input.value)));
        reset.addEventListener('click', (e) => {
          e.preventDefault();
          // Back to the value the preset supplied, not to zero: "reset" means
          // undo my edit, not blank the parameter.
          const value = typeof state.baseParams[item.key] === 'number'
            ? state.baseParams[item.key]
            : 0;
          input.value = String(value);
          apply(value);
        });

        ctrl.append(head, input);
        if (item.help) {
          const help = document.createElement('p');
          help.className = 'chelp';
          help.textContent = item.help;
          ctrl.appendChild(help);
        }
        body.appendChild(ctrl);
        sliderRefs.set(item.key, { input, val, ctrl, group, paintFill });
      }
      wrap.appendChild(body);
      el.controlGroups.appendChild(wrap);
    }
  }

  /**
   * Highlight a parameter that no longer matches the look it came from.
   *
   * Compared against `state.baseParams`, the snapshot taken when a preset was
   * applied - not against the current preset id, which becomes `__custom` the
   * moment anything moves and would take every marker with it.
   */
  function markControlState(key) {
    const ref = sliderRefs.get(key);
    if (!ref) return;
    const base = state.baseParams ? state.baseParams[key] : undefined;
    const modified = typeof base === 'number' &&
      Math.abs(base - (state.params[key] || 0)) > 1e-6;
    ref.ctrl.classList.toggle('modified', modified);
  }

  function updateGroupTag(group) {
    const node = el.controlGroups.querySelector(`.group:nth-child(${CONTROLS.indexOf(group) + 1})`);
    if (!node) return;
    const tag = node.querySelector('.gtag');
    const modified = group.items.filter((item) => {
      const ref = sliderRefs.get(item.key);
      return ref && ref.ctrl.classList.contains('modified');
    }).length;
    if (tag) tag.textContent = modified ? `${modified} changed` : '';
    // The vermilion edge marker: a module that is no longer at its preset
    // value is visibly doing something of its own.
    node.classList.toggle('is-modified', modified > 0);
    // The strip and the inspector head both report how far this look has been
    // taken from its preset, so they move with the sliders.
    refreshLookReadouts();
  }

  function syncControlValues() {
    for (const [key, ref] of sliderRefs) {
      const v = state.params[key];
      if (typeof v === 'number') {
        ref.input.value = v;
        ref.val.textContent = v.toFixed(2);
        ref.paintFill(v);
      }
      markControlState(key);
    }
    for (const group of CONTROLS) updateGroupTag(group);
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
    el.resBadge.hidden = !v.videoWidth;
    if (!v.videoWidth) { el.resBadge.textContent = '—'; return; }
    const src = labelForHeight(v.videoHeight);
    // Read the canvas directly rather than the stats snapshot, which is only
    // refreshed twice a second and would lag behind a settings change.
    const outH = el.glCanvas.height || v.videoHeight;
    el.resBadge.textContent = state.params.enabled
      ? `${src} → ${labelForHeight(outH)}`
      : src;
    if (el.renderScaleTag) {
      // What the engine resolved, not what the control asked for: "Auto" is
      // only meaningful once it has landed on a real number.
      el.renderScaleTag.textContent = state.params.enabled && el.glCanvas.width
        ? `${el.glCanvas.width}×${el.glCanvas.height}`
        : '';
    }
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
    el.enhanceToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.enhanceToggle.innerHTML = `<span class="dot"></span> Enhancement ${on ? 'on' : 'off'}`;
    applyPresentationMode();
    updateResBadge();
    refreshWatchSurfaces();
  }

  /**
   * The Watch inspector's source card.
   *
   * A readout of what is already loaded - the descriptor, the video element
   * and the engine's own stats. It never asks the backend for anything and it
   * sits in the inspector rather than over the picture, so it costs the player
   * no space at all.
   */
  function refreshWatchSource() {
    if (!el.watchSource) return;
    const media = state.media;
    const v = el.video;

    if (!media) {
      el.watchThumb.dataset.thumbId = '';
      el.watchThumb.dataset.thumbState = '';
      el.watchThumb.innerHTML = `<div class="thumb-fallback">${ICONS.mediaMark}</div>`;
      el.watchTitle.textContent = 'Nothing loaded';
      el.watchTitle.removeAttribute('title');
      el.watchMeta.textContent = 'Open a file or paste a link to begin.';
      el.watchState.hidden = true;
      el.watchSourceTag.textContent = '';
      return;
    }
    el.watchSourceTag.textContent = media.kind === 'stream' ? 'Online' : 'Local';

    const duration = Number.isFinite(v.duration) ? v.duration : (media.info && media.info.duration) || null;
    thumbs.paint(el.watchThumb, {
      kind: media.kind,
      source: media.source,
      webpageUrl: media.kind === 'stream' ? media.source : null,
      thumbnail: media.thumbnail || null,
      durationSeconds: duration
    }, { duration });

    el.watchTitle.textContent = media.title || media.source;
    el.watchTitle.title = media.source;

    const bits = [];
    if (v.videoWidth) bits.push(`${v.videoWidth}×${v.videoHeight}`);
    const fps = (state.analysis && state.analysis.video && state.analysis.video.nominalFps) ||
      (media.info && media.info.fps) || 0;
    if (fps) bits.push(`${fps} fps`);
    if (duration) bits.push(fmtTime(duration));
    bits.push(media.kind === 'stream' ? (media.selectedQuality || 'Online') : 'Local file');
    el.watchMeta.textContent = bits.join(' · ');

    // The enhancement state, said as what is actually on screen.
    const on = !!(state.params && state.params.enabled);
    el.watchState.hidden = false;
    el.watchState.className = 'source-card-state' + (on ? ' on' : '');
    const badge = el.glCanvas.height && on
      ? `${labelForHeight(v.videoHeight)} → ${labelForHeight(el.glCanvas.height)}`
      : labelForHeight(v.videoHeight);
    el.watchState.innerHTML = '';
    const dot = document.createElement('span');
    dot.className = 'dot-state' + (on ? ' busy' : '');
    const label = document.createElement('span');
    label.className = 'state-label';
    label.textContent = on ? 'Enhancing' : 'Native playback';
    // The resolution keeps its own casing: uppercasing it renders "360P".
    const value = document.createElement('span');
    value.className = 'state-value';
    value.textContent = badge;
    el.watchState.append(dot, label, value);
  }

  function scrubPositionFromEvent(e) {
    const rect = el.scrub.getBoundingClientRect();
    // A track with no width — the transport is not the visible one right now —
    // would divide by zero and hand `currentTime` a NaN, which throws.
    if (!rect.width) return null;
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
      // The preset grid must not keep claiming "Original" while enhancement is
      // running, or the other way round: the toggle changes a parameter that
      // the preset also owns, so the selection stops being that preset.
      const preset = findPreset(state.presetId);
      if (preset && !!preset.params.enabled !== state.params.enabled) markCustom();
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
      if (p === null) return;
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
      const p = scrubPositionFromEvent(e);
      if (d && p !== null) media.seek(p * d);
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
    // And the moment it gives up is the moment to save the picture. Without
    // this the element sits errored, the video's seek never completes and the
    // viewer stays black with everything else looking healthy.
    el.audio.addEventListener('error', () => media.recoverFromAudioFailure());
    v.addEventListener('timeupdate', () => { updateTime(); updateResBadge(); });
    v.addEventListener('progress', updateTime);
    v.addEventListener('durationchange', updateTime);
    v.addEventListener('seeking', () => {
      if (state.dualStream && !el.audio.error) el.audio.currentTime = v.currentTime;
    });
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
    el.compareBtn.setAttribute('aria-pressed', mode ? 'true' : 'false');
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

  /**
   * The diagnostics overlay.
   *
   * Twice a second, and only while it is actually on screen. The numbers
   * underneath are collected continuously by playback-stats.js at one callback
   * per presented frame; writing them into the DOM at that rate would make the
   * measurement instrument the thing worth measuring.
   */
  function bindStats() {
    let visible = false;
    let timer = null;

    const render = () => {
      if (!visible || !state.engine) return;
      const s = state.engine.stats;
      const v = el.video;
      const pb = state.playback ? state.playback.snapshot() : null;

      const groups = [
        ['Playback', [
          ['Path', state.presentation === 'native' ? 'native — no GPU work' : 'enhanced'],
          ['Source', v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : '—'],
          // Compositor-counted, not callback-counted: see playback-stats.js.
          ['Presented', pb ? `${pb.presentedFps} fps${pb.presentedBasis === 'callbacks' ? ' est.' : ''}` : '—'],
          ['Dropped', pb ? `${pb.droppedFrames}/${pb.totalFrames} · ${pb.droppedPercent}%` : '—'],
          ['Jitter', pb ? `${pb.jitterMs} ms` : '—'],
          ['Buffer', pb ? `${pb.bufferedAheadSec}s` : '—']
        ]]
      ];

      if (state.presentation === 'enhanced') {
        const enhanced = [
          ['Render', s.outputW ? `${s.outputW}×${s.outputH}` : '—'],
          ['Frame cost', `${s.cpuMs} / ${s.frameBudgetMs} ms`],
          ['Quality scale', `${Math.round(s.droppedScale * 100)}% · ${s.policy}`]
        ];
        if (s.skipped) enhanced.push(['Skipped', `${s.skipped} stale`]);
        groups.push(['Enhancement', enhanced]);
      }

      groups.push(['Device', [['GPU', String(s.gpu).slice(0, 34)]]]);

      const html = [];
      for (const [heading, rows] of groups) {
        html.push(`<div class="shead">${heading}</div>`);
        for (const [key, value] of rows) {
          html.push(`<div class="row"><span>${escapeHtml(key)}</span><b>${escapeHtml(value)}</b></div>`);
        }
      }
      if (s.limited) {
        html.push('<div class="row alert"><span>Status</span><b>GPU limited</b></div>');
      }
      el.statsOverlay.innerHTML = html.join('');
    };

    const setVisible = (next) => {
      visible = next;
      el.statsOverlay.hidden = !visible;
      el.statsBtn.classList.toggle('active', visible);
      el.statsBtn.setAttribute('aria-pressed', visible ? 'true' : 'false');
      // No timer at all while the overlay is closed. An always-on interval
      // that computes a snapshot and throws it away is exactly the ambient
      // cost this UI is supposed to not have.
      if (visible && !timer) timer = setInterval(render, 500);
      if (!visible && timer) { clearInterval(timer); timer = null; }
      render();
    };

    el.statsBtn.addEventListener('click', () => {
      setVisible(!visible);
      api.settings.patch({ showStats: visible });
    });

    // A hidden window has nothing to show; resume on return.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' && timer) {
        clearInterval(timer);
        timer = null;
      } else if (document.visibilityState === 'visible' && visible && !timer) {
        timer = setInterval(render, 500);
      }
    });

    // Restore the persisted preference once settings arrive.
    setTimeout(() => {
      if (state.settings && state.settings.showStats) setVisible(true);
    }, 60);
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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
    const [res, aspectRes] = await Promise.all([
      api.recipe.platforms(),
      api.recipe.aspects()
    ]);
    if (aspectRes.ok) {
      state.aspects = aspectRes.aspects;
      populateAspects();
    }
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
    syncPlatformUi({ seedGeometry: true });
  }

  /**
   * A platform *suggests* geometry; it does not own it.
   *
   * Picking a target moves the aspect control to what that platform wants and
   * then stops. The user can immediately change it, and nothing here reaches
   * back to overrule them - which is what "platform presets must not make
   * direct geometry control impossible" means in practice.
   */
  function syncPlatformUi({ seedGeometry = false } = {}) {
    const platform = state.platforms[el.createPlatform.value];
    const canvas = platform && platform.canvas;

    if (seedGeometry) {
      const wanted = canvas && canvas !== 'source' ? canvas : 'source';
      if ([...el.createAspect.options].some((o) => o.value === wanted)) {
        el.createAspect.value = wanted;
      }
      // A platform with an exact size gets it; otherwise the ratio's own
      // suggestion applies.
      if (platform && platform.width && platform.height) {
        const wh = `${platform.width}x${platform.height}`;
        el.createRes.value = [...el.createRes.options].some((o) => o.value === wh) ? wh : 'auto';
      } else {
        el.createRes.value = wanted === 'source' ? 'source' : 'auto';
      }
    }
    syncGeometryUi();
  }

  /* ------------------------------------------------------------------ *
   * The Create source
   *
   * Create keeps its own source, separate from what Watch is playing. They
   * used to be the same object, which meant choosing something to render
   * changed what was on screen, and opening something to watch silently
   * re-aimed the Create panel at it. Both are surprising; the second one is
   * dangerous, because it happened while a render was being set up.
   *
   * `state.createSource` is a descriptor, not a player: it never touches the
   * video element, so nothing Create does can interrupt playback.
   * ------------------------------------------------------------------ */

  /** Take an immutable snapshot of a source descriptor for Create to hold. */
  function snapshotSource(descriptor, analysis) {
    if (!descriptor) return null;
    return {
      kind: descriptor.kind,
      source: descriptor.source,
      title: descriptor.title || descriptor.source,
      // A remote source keeps only the page URL. The job re-resolves it when it
      // runs, because a direct CDN URL will have expired by then, and because a
      // long render must not depend on the Watch tab's live stream session.
      webpageUrl: descriptor.kind === 'stream' ? descriptor.source : null,
      // Top level on the descriptor, not inside `info` - a snapshot that
      // looked for it in the wrong place would never refuse a live stream.
      isLive: !!descriptor.isLive,
      info: descriptor.info || null,
      analysis: analysis || descriptor.analysis || null,
      selectedAt: Date.now()
    };
  }

  /* ------------------------------------------------------------------ *
   * Create's preview player
   *
   * Its own native element, its own stream session, its own generation
   * counter. It shows the descriptor Create is aimed at without ever becoming
   * that descriptor: `state.createSource` remains the render identity, and
   * nothing in here writes to it. Playing, seeking or failing the preview
   * cannot change what a queued job renders.
   *
   * Deliberately no WebGL and no enhancement — the offline pipeline is what
   * applies those, and a live approximation of a render is a lie.
   * ------------------------------------------------------------------ */

  const createPreview = {
    generation: 0,
    /** The stream session Create owns. Never Watch's. */
    token: null,
    /** Which source is on the element, so an unchanged source is not re-resolved. */
    key: null,
    lastPosition: 0,

    /** Identity of a snapshot, for the "nothing changed" check. */
    keyFor(snapshot) {
      if (!snapshot) return null;
      return `${snapshot.kind}:${(snapshot.source || '').toLowerCase()}`;
    },

    /** Drop the session Create is holding, if any. Best effort by design. */
    releaseSession() {
      if (!this.token) return;
      const token = this.token;
      this.token = null;
      api.media.releaseStream(token).catch(() => { /* it expires on its own */ });
    },

    /** Tear the element down without touching Watch. */
    detach() {
      const v = el.createVideo;
      const a = el.createAudio;
      for (const element of [v, a]) {
        try { element.pause(); } catch { /* not loaded */ }
        element.removeAttribute('src');
        try { element.load(); } catch { /* nothing to abort */ }
      }
      v.classList.remove('is-ready');
      this.key = null;
      this.lastPosition = 0;
      this.releaseSession();
    },

    setStatus({ ready = false, error = null, tag = '' } = {}) {
      el.createVideo.classList.toggle('is-ready', !!ready);
      el.createEmpty.hidden = ready || !!error || !!state.createSource;
      el.createPreviewError.hidden = !error;
      el.createPreviewBadge.hidden = !ready;
      if (error) el.createPreviewErrorText.textContent = error;
      el.createPreviewTag.textContent = tag;
    },

    /**
     * Point the preview at a Create source.
     *
     * Generation-guarded the way `switchSource()` is: selecting B and then C
     * before B resolves must leave C on screen, and B's late resolution must
     * release its own session and then do nothing.
     */
    async show(snapshot) {
      const generation = ++this.generation;
      const stale = () => generation !== this.generation;

      if (!snapshot) {
        this.detach();
        this.setStatus({});
        return;
      }

      // Same source, still loaded: keep the position rather than restart it.
      if (this.key && this.key === this.keyFor(snapshot) && el.createVideo.getAttribute('src')) {
        this.setStatus({ ready: true, tag: this.tagFor(snapshot) });
        return;
      }

      this.detach();
      this.setStatus({ tag: 'Loading…' });
      el.createEmpty.hidden = true;

      let videoUrl = null;
      let audioUrl = null;

      if (snapshot.kind === 'stream') {
        // Create resolves its own session. Watch's token is never reused: a
        // render that outlives the Watch tab must not depend on it, and
        // releasing one must never disturb the other.
        const res = await api.media.resolveUrl(snapshot.webpageUrl || snapshot.source, {
          watchQuality: 'balanced'
        });
        if (stale()) {
          if (res.ok && res.streamToken) api.media.releaseStream(res.streamToken).catch(() => {});
          return;
        }
        if (!res.ok) {
          this.setStatus({ error: describeFailure(res), tag: 'Unavailable' });
          return;
        }
        this.token = res.streamToken || null;
        videoUrl = res.playbackUrl;
        audioUrl = res.audioUrl || null;
      } else {
        videoUrl = `vs://app/__media?src=local&p=${encodeURIComponent(snapshot.source)}`;
      }

      if (stale()) { this.releaseSession(); return; }

      const v = el.createVideo;
      const a = el.createAudio;
      v.muted = !!state.settings.muted;
      v.volume = state.settings.volume ?? 1;

      if (audioUrl) {
        // Split stream: the same arrangement Watch uses, and the same hazard.
        v.muted = true;
        a.src = audioUrl;
        a.muted = !!state.settings.muted;
        a.volume = state.settings.volume ?? 1;
      }
      v.src = videoUrl;
      v.load();

      this.key = this.keyFor(snapshot);
      this.setStatus({ ready: true, tag: this.tagFor(snapshot) });
    },

    tagFor(snapshot) {
      if (!snapshot) return '';
      return snapshot.kind === 'stream' ? 'Online source' : 'Local source';
    },

    /**
     * A split preview whose audio leg died.
     *
     * Same lesson as Watch, applied independently rather than shared: the
     * picture is what a Create preview is for, so a refused audio track drops
     * the preview to video-only instead of taking the frame down with it.
     */
    recoverFromAudioFailure() {
      const a = el.createAudio;
      if (!a.getAttribute('src') || !a.error) return;
      a.pause();
      a.removeAttribute('src');
      try { a.load(); } catch { /* nothing to abort */ }
      el.createVideo.muted = !!state.settings.muted;
      toast('The preview’s audio track was refused, so it is previewing without ' +
        'sound. This does not affect the render.', 'warn', 8000);
    },

    play() {
      // One audible player at a time. This arbitrates transport only — neither
      // side's *source* is touched, which is the independence that matters.
      if (!el.video.paused) media.pause();
      const p = el.createVideo.play();
      if (p && p.catch) p.catch(() => { /* reported by the element's error event */ });
      if (el.createAudio.getAttribute('src') && !el.createAudio.error) {
        el.createAudio.currentTime = el.createVideo.currentTime;
        const ap = el.createAudio.play();
        if (ap && ap.catch) ap.catch(() => {});
      }
    },

    pause() {
      try { el.createVideo.pause(); } catch { /* not loaded */ }
      try { el.createAudio.pause(); } catch { /* not loaded */ }
    },

    toggle() { if (el.createVideo.paused) this.play(); else this.pause(); },

    seek(seconds) {
      const v = el.createVideo;
      const d = v.duration;
      if (!Number.isFinite(seconds)) return;
      const t = Math.max(0, Math.min(Number.isFinite(d) ? d - 0.05 : seconds, seconds));
      v.currentTime = t;
      if (el.createAudio.getAttribute('src') && !el.createAudio.error) {
        el.createAudio.currentTime = t;
      }
    },

    /** Nothing decodes behind another workspace. */
    onWorkspaceChange(name) {
      if (name === 'create') {
        // `show(null)` is what paints the empty state, so it runs whether or
        // not there is a source: otherwise opening Create with nothing chosen
        // leaves the markup's initial `hidden` in place and the stage is bare.
        this.show(state.createSource);
        return;
      }
      if (!el.createVideo.paused) this.lastPosition = el.createVideo.currentTime;
      this.pause();
    }
  };

  async function setCreateSource(snapshot) {
    state.createSource = snapshot;
    state.createAnalysis = (snapshot && snapshot.analysis) || null;
    state.autoResult = null;
    state.recipeState = 'custom';
    el.autoState.textContent = snapshot ? 'Ready' : 'No source';
    refreshCreateSource();
    syncGeometryUi();
    schedulePreview();
    // The preview follows the render identity; it never sets it. Loading only
    // while Create is on screen keeps a background workspace from decoding.
    if (state.workspace === 'create') createPreview.show(snapshot);
    else createPreview.detach();
  }

  async function createOpenFile() {
    const res = await api.dialog.openVideo();
    if (!res.ok) return;
    const opened = await api.media.open(res.files[0]);
    if (!opened.ok) return reportFailure(opened);
    await setCreateSource(snapshotSource(opened, opened.analysis));
    toast('Create source set. Watch is untouched.', 'ok', 3500);
  }

  async function createOpenUrl() {
    const raw = (el.createUrlInput.value || '').trim();
    if (!raw) return toast('Paste a video URL first.', 'warn');
    el.createUrlBtn.disabled = true;
    el.createUrlBtn.textContent = 'Resolving…';
    // Resolved purely to identify and describe the source. The token is
    // released immediately: the job re-resolves the page URL when it runs, so
    // nothing long-lived depends on a session that expires in hours.
    const res = await api.media.resolveUrl(raw, { watchQuality: 'quality' });
    el.createUrlBtn.disabled = false;
    el.createUrlBtn.textContent = 'Load';
    if (!res.ok) return reportFailure(res);
    if (res.isLive) {
      api.media.releaseStream(res.streamToken).catch(() => {});
      return toast('Live streams cannot be rendered to a file.', 'warn', 6000);
    }
    const snapshot = snapshotSource(res, null);
    api.media.releaseStream(res.streamToken).catch(() => {});
    await setCreateSource(snapshot);
    toast(`Create source: ${snapshot.title}`, 'ok', 4000);
  }

  async function createUseWatchSource() {
    if (!state.media) return toast('Nothing is playing in Watch.', 'warn');
    await setCreateSource(snapshotSource(state.media, state.analysis));
    toast('Create is now aimed at the Watch video.', 'ok', 3500);
  }

  function refreshCreateSource() {
    const src = state.createSource;
    if (!src) {
      el.createSourceTitle.textContent = 'No source selected';
      el.createSourceSub.textContent =
        'Choose a video, paste a URL, or use whatever Watch is playing.';
      // A neutral placeholder, not an empty box: the slot is part of the
      // layout whether or not there is a source in it yet.
      el.createThumb.dataset.thumbId = '';
      el.createThumb.dataset.thumbState = '';
      el.createThumb.innerHTML =
        `<div class="thumb-fallback">${ICONS.mediaMark}</div>`;
      el.analysisGrid.innerHTML = '';
      el.analysisNote.textContent = '';
      el.createKindTag.textContent = '';
      updateRenderSummary();
      return;
    }
    el.createSourceTitle.textContent = src.title || src.source;
    el.createSourceTitle.title = src.source;
    el.createKindTag.textContent = src.kind === 'stream' ? 'Online' : 'Local';

    // The identity, and therefore the picture, that this source carries
    // everywhere else in the app.
    const analysis = state.createAnalysis;
    const duration = (analysis && analysis.derived && analysis.derived.durationSeconds) ||
      (src.info && src.info.duration) || null;
    thumbs.paint(el.createThumb, {
      kind: src.kind,
      source: src.source,
      webpageUrl: src.webpageUrl,
      thumbnail: src.thumbnail || null,
      durationSeconds: duration
    }, { duration });

    const bits = [src.kind === 'stream' ? 'Online source' : 'Local file'];
    if (analysis && analysis.derived) {
      const d = analysis.derived;
      if (d.displayWidth) bits.push(`${d.displayWidth}×${d.displayHeight}`);
      if (analysis.video && analysis.video.nominalFps) bits.push(`${analysis.video.nominalFps} fps`);
    }
    if (duration) bits.push(fmtTime(duration));
    el.createSourceSub.textContent = bits.join(' · ');

    renderAnalysis(state.createAnalysis);
  }

  /* ------------------------------------------------------------------ *
   * Create as the starting workspace
   *
   * Create is where a session begins, so it carries the two things a starting
   * page owes you: what this machine is currently doing, and the quickest way
   * back to something you already had open. Both are readouts of state the app
   * already holds — the job map, the engine status, the recents list. Nothing
   * here polls, and nothing here is a number that only exists to fill a card.
   *
   * The intake stays aimed at Create. Choosing a recent sets the *Create*
   * source and never touches the player, which is the same separation
   * `setCreateSource` exists to enforce.
   * ------------------------------------------------------------------ */

  function refreshCreateHome() {
    if (!el.createHomeStats) return;

    const jobs = [...state.jobs.values()];
    const active = jobs.filter(isActiveJob);
    const done = jobs.filter((j) => j.status === 'completed').length;
    const engines = ['realesrgan', 'rife'].filter((id) => engineState(id) === 'installed').length;

    const cells = [
      ['Queued', active.length ? String(active.length) : '—', active.length ? 'on' : '', 'queue'],
      ['Rendered', done ? String(done) : '—', '', 'queue'],
      ['Engines', `${engines}/2`, engines === 2 ? 'ok' : '', null],
      ['Recents', lastRecents.length ? String(lastRecents.length) : '—', '', 'library']
    ];

    el.createHomeStats.innerHTML = '';
    for (const [label, value, kind, target] of cells) {
      const cell = document.createElement(target ? 'button' : 'div');
      cell.className = 'intro-stat' + (target ? ' is-link' : '');
      if (target) {
        cell.type = 'button';
        cell.title = `Open ${target === 'queue' ? 'the render queue' : 'the library'}`;
        cell.addEventListener('click', () => setWorkspace(target));
      }
      const v = document.createElement('strong');
      v.className = 'intro-stat-value' + (kind ? ` ${kind}` : '');
      v.textContent = value;
      const l = document.createElement('span');
      l.textContent = label;
      cell.append(v, l);
      el.createHomeStats.appendChild(cell);
    }

    refreshCreateRecents();
  }

  function refreshCreateRecents() {
    const host = el.createRecents;
    if (!host) return;

    el.createRecentsTag.textContent = lastRecents.length ? String(lastRecents.length) : '';

    host.innerHTML = '';
    if (!lastRecents.length) {
      const note = document.createElement('p');
      note.className = 'mini-empty';
      note.textContent = 'Nothing opened yet. A video you play or render shows up here.';
      host.appendChild(note);
      return;
    }

    for (const item of lastRecents.slice(0, 5)) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'mini-recent';
      row.title = `Set as the Create source — ${item.source}`;

      const thumb = document.createElement('div');
      thumb.className = 'thumb xs';
      thumbs.paint(thumb, {
        kind: item.kind,
        source: item.source,
        webpageUrl: item.kind === 'stream' ? item.source : null,
        thumbnail: item.thumbnail || null,
        durationSeconds: item.duration || null
      }, { duration: item.duration || null });

      const body = document.createElement('span');
      body.className = 'mini-recent-body';
      const title = document.createElement('span');
      title.className = 'mini-recent-title';
      title.textContent = item.title || item.source;
      const sub = document.createElement('span');
      sub.className = 'mini-recent-sub';
      const bits = [item.kind === 'stream' ? 'Online' : 'Local'];
      if (item.duration) bits.push(fmtTime(item.duration));
      sub.textContent = bits.join(' · ');
      body.append(title, sub);

      row.append(thumb, body);
      row.addEventListener('click', () => useRecentAsCreateSource(item));
      host.appendChild(row);
    }
  }

  /**
   * A recent, aimed at Create.
   *
   * Both branches are the routes Create already uses: a local file is opened
   * and probed exactly as the file picker does, and a URL goes through the
   * same resolve-and-release path as the URL box — which is also what refuses
   * a live stream. Neither touches the video element.
   */
  async function useRecentAsCreateSource(item) {
    if (item.kind === 'stream') {
      el.createUrlInput.value = item.source;
      return createOpenUrl();
    }
    const opened = await api.media.open(item.source);
    if (!opened.ok) return reportFailure(opened);
    await setCreateSource(snapshotSource(opened, opened.analysis));
    toast('Create source set. Watch is untouched.', 'ok', 3500);
  }

  /* ------------------------------------------------------------------ *
   * Create's section summaries
   *
   * Every collapsed group states what it currently holds, so the form can be
   * closed and still readable. Read from the same controls the recipe is built
   * from, so a tag can never describe something the render will not do.
   * ------------------------------------------------------------------ */

  function refreshGroupTags() {
    const aspect = currentAspect();
    const size = resolveGeometryChoice(aspect, suggestedResolutionFor(aspect));
    const platform = state.platforms[el.createPlatform.value];

    const outBits = [];
    if (platform && platform.id !== 'custom') outBits.push(platform.label);
    if (size) outBits.push(`${size.width}×${size.height}`);
    else outBits.push('Source size');
    el.tagOutput.textContent = outBits.join(' · ');

    el.tagFraming.textContent = aspect
      ? `${aspect.id} · ${FRAMING_LABEL[el.createFraming.value] || el.createFraming.value}`
      : 'Source shape';

    const ai = el.createAi.value;
    el.tagEnhancement.textContent = ai === 'off'
      ? 'Off'
      : `${ai === 'restore' ? 'Restore' : `${ai}×`} · ${capitalise(el.createAiQuality.value)}`;

    const fps = el.createFps.value;
    const interp = el.createInterp.value;
    el.tagMotion.textContent = fps === 'source'
      ? (interp === 'ai' ? 'Source rate · RIFE' : 'Source rate')
      : `${fps} fps · ${INTERP_LABEL[interp]}`;

    el.tagColor.textContent = el.createUseLook.checked ? 'Player look applied' : 'No grade';

    el.tagAudio.textContent = !el.createAudio.checked
      ? 'Dropped'
      : (el.createLoudness.checked
        ? (AUDIO_MASTER_LABEL[state.audioMaster] && state.audioMaster !== 'preserve'
          ? AUDIO_MASTER_LABEL[state.audioMaster]
          : 'Normalized')
        : 'Preserve');

    updateRenderSummary();
  }

  const FRAMING_LABEL = {
    smart: 'Smart Reframe',
    fill: 'Centre crop',
    fit: 'Fit, blurred',
    'fit-black': 'Fit, black'
  };
  const INTERP_LABEL = { off: 'Preserve', classical: 'Classical', ai: 'RIFE' };
  const capitalise = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

  /**
   * The one-line account of what pressing render will produce. Built from the
   * panel, not from a wish: an entry appears only when the corresponding
   * control genuinely asks for it.
   */
  function updateRenderSummary() {
    el.renderSummary.innerHTML = '';
    if (!state.createSource) return;

    const aspect = currentAspect();
    const size = resolveGeometryChoice(aspect, suggestedResolutionFor(aspect));
    const add = (text, accent) => { if (text) el.renderSummary.appendChild(chip(text, accent)); };

    add(size ? `${size.width} × ${size.height}` : 'Source size');
    add(el.createFps.value === 'source' ? 'Source rate' : `${el.createFps.value} fps`);
    const platform = state.platforms[el.createPlatform.value];
    if (platform && platform.codec) add(platform.codec.toUpperCase());
    if (aspect) add(FRAMING_LABEL[el.createFraming.value] || el.createFraming.value);
    if (el.createAi.value !== 'off') {
      add(el.createAi.value === 'restore' ? 'Neural restore' : `Neural ${el.createAi.value}×`, true);
    }
    if (el.createInterp.value === 'ai') add('RIFE', true);
    if (el.createAudio.checked && el.createLoudness.checked) {
      add(AUDIO_MASTER_LABEL[state.audioMaster] && state.audioMaster !== 'preserve'
        ? AUDIO_MASTER_LABEL[state.audioMaster] : 'Normalized');
    } else if (!el.createAudio.checked) {
      add('No audio');
    }
  }

  function renderAnalysis(analysis) {
    el.analysisGrid.innerHTML = '';
    if (!analysis) {
      const src = state.createSource;
      el.analysisNote.textContent = src && src.kind === 'stream'
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
    const src = state.createSource;
    if (!src) return toast('Choose a Create source first.', 'warn');
    if (state.analysisPending) return;
    state.analysisPending = true;
    el.analyseBtn.textContent = 'Analysing…';

    let res;
    if (src.kind === 'local') {
      res = await api.media.analyze(src.source, { deep: true });
    } else {
      // A remote source has no live session here by design, so probe it by
      // re-resolving it for the length of this call only.
      const resolved = await api.media.resolveUrl(src.webpageUrl || src.source, { watchQuality: 'quality' });
      if (!resolved.ok) {
        state.analysisPending = false;
        el.analyseBtn.textContent = 'Analyse';
        return reportFailure(resolved, 'That source could not be resolved for analysis.');
      }
      res = await api.media.analyze({ token: resolved.streamToken, leg: 'video' }, { deep: false });
      api.media.releaseStream(resolved.streamToken).catch(() => {});
    }

    state.analysisPending = false;
    el.analyseBtn.textContent = 'Analyse';
    if (!res.ok) return reportFailure(res, 'The source could not be analysed.');
    state.createAnalysis = res.analysis;
    if (state.createSource) state.createSource.analysis = res.analysis;
    renderAnalysis(state.createAnalysis);
    syncGeometryUi();
    schedulePreview();
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
    refreshConsoleEngines();
    refreshQueueSide();
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
      const dot = document.createElement('span');
      dot.className = 'dot-state ' + (
        engine.status === 'ready' ? 'ok'
          : engine.status === 'installing' ? 'busy'
            : engine.status === 'broken' ? 'bad' : ''
      );
      name.append(dot, document.createTextNode(ENGINE_LABEL[id] || engine.name));
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
      ? `${missing.join(' + ')} missing`
      : 'Ready';
    el.aiEngineState.classList.toggle('ready', missing.length === 0);
    el.aiEngineState.classList.toggle('warn', missing.length > 0);
    el.aiEngineState.title = missing.length
      ? `${missing.join(' and ')} are not installed.`
      : 'Real-ESRGAN and RIFE are installed and usable.';
    el.installEnginesBtn.hidden = missing.length === 0;

    const usingAi = el.createAi.value !== 'off';
    el.createAiModelRow.hidden = !usingAi;
    el.createAiQualityRow.hidden = !usingAi;
    el.createAiQualityNote.hidden = !usingAi;
    el.createAiNote.hidden = !usingAi;
    if (usingAi) {
      el.createAiNote.textContent = describeAiChoice();
      renderResolvedPlanNote();
    }

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
    refreshGroupTags();
  }

  /**
   * The resolved plan, short by default.
   *
   * The full explanation is genuinely important - it is the difference between
   * a 3.6 s frame and a 12.7 s one - but a four-line orange paragraph under a
   * dropdown is a paragraph nobody reads. So the line states what will run,
   * and "Why?" opens the reasoning. Both come from the same resolved plan.
   */
  function renderResolvedPlanNote() {
    const node = el.createAiQualityNote;
    const full = describeAiQuality();
    const short = summarisePlan();
    const wasExpanded = node.classList.contains('expanded');

    node.innerHTML = '';
    node.classList.toggle('expanded', wasExpanded);
    const text = document.createElement('span');
    text.textContent = wasExpanded ? full : short;
    node.appendChild(text);

    if (full !== short) {
      const why = document.createElement('button');
      why.className = 'why';
      why.textContent = wasExpanded ? 'Less' : 'Why?';
      why.addEventListener('click', () => {
        node.classList.toggle('expanded');
        renderResolvedPlanNote();
      });
      node.appendChild(why);
    }
  }

  /**
   * One line naming the path the engine actually resolved. Prefers the plan
   * the main process returned; falls back to the local description only when
   * no preview has resolved yet.
   */
  function summarisePlan() {
    const resolved = state.resolvedPlan && state.resolvedPlan.neural;
    if (state.resolvedPlan && !state.resolvedPlan.neural && el.createAi.value !== 'off') {
      return 'Classical reconstruction · no neural inference';
    }
    if (resolved && resolved.reason) {
      // The backend's reason is a sentence fragment; take its first clause so
      // the row stays one line, with the rest behind "Why?".
      const clause = String(resolved.reason).split(/[,;]| — /)[0].trim();
      return clause.charAt(0).toUpperCase() + clause.slice(1);
    }
    const quality = el.createAiQuality.value;
    const animation = el.createAiModel.value === 'animation';
    const scale = el.createAi.value;
    if (scale === 'restore') return 'Native-scale inference, then a high-quality downscale';
    if (animation) return `Native ${scale}× inference`;
    if (quality === 'fast') return 'Classical reconstruction · no neural inference';
    if (quality === 'balanced') return 'Real-ESRGAN at reduced inference resolution';
    return 'Full-size neural reconstruction';
  }

  /**
   * What the chosen inference quality actually does, in this configuration.
   *
   * Four names pointing at one implementation would be a lie, so this says
   * which path each one takes for the model that is actually selected - and
   * where a mode declines to run the network at all, it says that too.
   */
  function describeAiQuality() {
    // Prefer what the engine planner actually resolved. Four names pointing at
    // one implementation would be a lie, and so would four *descriptions* of
    // one implementation: for General at 2x, Quality and Maximum genuinely
    // converge, because there is no larger native scale to reach for. Reading
    // the resolved plan says so instead of implying a difference.
    const resolved = state.resolvedPlan && state.resolvedPlan.neural;
    if (resolved && resolved.reason) {
      const bits = [`This will run ${resolved.reason}.`];
      if (resolved.tradeoff) bits.push(resolved.tradeoff);
      return bits.join(' ');
    }
    if (state.resolvedPlan && !state.resolvedPlan.neural && el.createAi.value !== 'off') {
      return 'No neural inference will run for this combination; the resize is classical. ' +
        'Detail is resampled and sharpened rather than reconstructed.';
    }

    const quality = el.createAiQuality.value;
    const animation = el.createAiModel.value === 'animation';
    const scale = el.createAi.value;
    const nativeAtScale = animation && (scale === '2' || scale === '4');

    if (scale === 'restore') {
      return quality === 'maximum'
        ? 'Maximum: restoration runs at the model’s largest native scale, then resamples back down. Slowest and most thorough.'
        : 'Restoration runs at the model’s smallest native scale, then resamples back down.';
    }
    if (nativeAtScale) {
      return quality === 'maximum'
        ? `Maximum: runs the 4× network and resamples down to ${scale}×, even though native ${scale}× weights exist. Much slower, marginally more reconstruction.`
        : `This model has native ${scale}× weights, so every quality setting runs a real ${scale}× inference. Fast on this hardware.`;
    }
    switch (quality) {
      case 'fast':
        return 'Fast: this model has no native weights at that scale, so Fast uses classical reconstruction instead of running its 4× network over every pixel. Visibly softer than the neural paths, and by far the quickest.';
      case 'balanced':
        return 'Balanced: runs the 4× network on a half-size frame to land on an exact 2×. About a quarter of the inference — measured 3.5× faster — reconstructing from less source detail than Quality.';
      case 'quality':
        return 'Quality: runs the 4× network on every source pixel and resamples down. The most detail the model can use, and slow.';
      default:
        return 'Maximum: the largest native scale over every source pixel, then a resample down. The slowest path there is; measured about 12.7s per 720p frame on a GTX 1650 Ti.';
    }
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
      // What happens next is the inference-quality control's business, and it
      // explains itself directly below. Saying "runs at 4× and is downscaled"
      // here would be true of only two of the four settings.
      return animation
        ? 'Native 2× reconstruction — this model really has 2× weights.'
        : 'The General model is 4×-only, so how 2× is reached depends on the inference quality below.';
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

  /**
   * Semantic detection is optional and says so.
   *
   * The copy never implies Smart Reframe is broken without it - it is not -
   * and never claims face tracking is running when the models are absent.
   */
  async function refreshSemanticStatus() {
    const res = await api.semantic.status();
    if (!res.ok) return;
    const s = res.semantic;
    state.semantic = s;
    refreshConsoleEngines();
    refreshQueueSide();
    el.semanticStatus.textContent = s.detail;
    el.semanticStatus.classList.toggle('ok', s.status === 'ready');
    el.installSemanticBtn.hidden = s.status === 'ready' || s.status === 'installing';
    el.removeSemanticBtn.hidden = s.status !== 'ready';
    el.installSemanticBtn.textContent =
      s.status === 'broken' && s.runtime.available ? 'Repair' : 'Install';
    // A runtime that will not load cannot be fixed by downloading weights.
    el.installSemanticBtn.disabled = !s.runtime.available;
    setDot(el.semanticDot, s.status === 'ready' ? 'ok'
      : s.status === 'installing' ? 'busy'
        : s.status === 'broken' ? 'bad' : '');

    // The model names belong in an advanced disclosure, not in the headline:
    // "YuNet and NanoDet-Plus" is not what the reader came for.
    if (el.semanticDetail) {
      const models = (s.models || []).map((m) =>
        `${m.label || m.id}${m.present ? '' : (m.truncated ? ' (incomplete)' : ' (not downloaded)')}`);
      const runtime = s.runtime && s.runtime.available
        ? 'ONNX Runtime loaded (CPU provider)'
        : `ONNX Runtime unavailable${s.runtime && s.runtime.error ? ` — ${s.runtime.error}` : ''}`;
      el.semanticDetail.textContent = models.length
        ? `${runtime}. Models: ${models.join(', ')}.`
        : `${runtime}.`;
    }
    refreshSemanticNote();
  }

  /** One status dot vocabulary across every dependency row. */
  function setDot(node, kind) {
    if (!node) return;
    node.className = `dot-state${kind ? ` ${kind}` : ''}`;
  }

  function bindSemantic() {
    el.installSemanticBtn.addEventListener('click', async () => {
      el.installSemanticBtn.disabled = true;
      const off = api.semantic.onProgress((p) => {
        el.semanticStatus.textContent =
          `Downloading ${p.label}… ${Math.round(p.fraction * 100)}%`;
      });
      const res = await api.semantic.install();
      off();
      el.installSemanticBtn.disabled = false;
      if (res.ok) toast('Face and person detection installed.', 'ok');
      else reportFailure(res, 'The detection models could not be installed.');
      refreshSemanticStatus();
    });

    el.removeSemanticBtn.addEventListener('click', async () => {
      const res = await api.semantic.remove();
      if (res.ok) toast('Detection models removed. Smart Reframe will use motion and detail.', 'ok', 5000);
      else reportFailure(res);
      refreshSemanticStatus();
    });

    api.semantic.onStatus(() => refreshSemanticStatus());
  }

  async function refreshRuntimeStatus() {
    const res = await api.runtime.status();
    if (!res.ok) return;
    const found = res.runtimes || [];
    if (!found.length) {
      el.runtimeStatus.textContent = 'None found. Some sites will not resolve without one.';
      el.installRuntimeBtn.hidden = false;
      setDot(el.runtimeDot, 'warn');
      return;
    }
    const best = found[0];
    el.runtimeStatus.textContent =
      `Using ${best.runtime} ${best.version || ''} (${best.source})`.trim();
    el.installRuntimeBtn.hidden = best.source !== 'electron';
    setDot(el.runtimeDot, 'ok');
  }

  async function refreshThumbCacheStatus() {
    const res = await api.thumbnails.stats();
    if (!res.ok || !res.cache) {
      state.thumbCache = null;
      el.thumbCacheStatus.textContent = 'Unavailable.';
      return;
    }
    const { count, bytes } = res.cache;
    // Kept so the console's storage line can be written from the answer this
    // call already produced, rather than asking again on its own schedule.
    state.thumbCache = { count, bytes };
    el.thumbCacheStatus.textContent = count
      ? `${count} thumbnail${count === 1 ? '' : 's'} · ${fmtBytes(bytes)}`
      : 'Empty. Thumbnails are extracted the first time a source is shown.';
    refreshConsoleEngines();
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

  /* ------------------------------------------------------------------ *
   * Cost preview
   *
   * Resolved by the main process the same way a real run resolves it, because
   * a preview computed from the recipe alone cannot see which model was
   * chosen, whether the network runs on full-size or pre-scaled frames, or
   * whether the neural pass survived at all. That blind spot is exactly how a
   * job executing x4 inference was labelled `fast`.
   * ------------------------------------------------------------------ */

  function schedulePreview() {
    clearTimeout(state.previewTimer);
    state.previewTimer = setTimeout(refreshCostPreview, 250);
  }

  async function refreshCostPreview() {
    if (!state.createSource || !state.createAnalysis) {
      state.resolvedPlan = null;
      el.createCostPreview.hidden = true;
      return;
    }
    const generation = ++state.previewGeneration;
    const recipe = await buildCurrentRecipe(null);
    if (!recipe || generation !== state.previewGeneration) return;

    const res = await api.jobs.preview({ recipe, analysis: state.createAnalysis });
    if (generation !== state.previewGeneration) return;
    if (!res.ok || !res.cost) {
      state.resolvedPlan = null;
      el.createCostPreview.hidden = true;
      return;
    }

    // The resolved plan is the truth about what the network will do, so the
    // inference-quality note reads from it rather than from a parallel guess.
    state.resolvedPlan = res.plan || null;
    syncAiUi();

    el.createCostPreview.hidden = false;
    el.createCostClass.textContent = res.cost.label;
    el.createCostClass.className = `cost-class ${res.cost.class}`;

    const bits = [];
    if (res.geometry && res.geometry.width) {
      bits.push(`${res.geometry.width}×${res.geometry.height}`);
    }
    for (const reason of res.cost.reasons) bits.push(reason);
    // A magnitude, never a countdown. The real remaining time appears in the
    // queue once frames have actually been processed.
    if (res.cost.seconds >= 120) {
      bits.push(`roughly ${fmtCoarse(res.cost.seconds)} on hardware like this`);
    }
    el.createCostDetail.textContent = bits.join(' · ');
  }

  /** Deliberately coarse: an order of magnitude, not a promise. */
  function fmtCoarse(seconds) {
    if (seconds < 120) return 'under two minutes';
    if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
    return `${(seconds / 3600).toFixed(1)} hours`;
  }

  /** Ask Auto what it would do, and show its reasoning before committing. */
  async function runAuto() {
    if (!state.createSource) return toast('Choose a Create source first.', 'warn');
    if (!state.createAnalysis) {
      await analyseSource();
      if (!state.createAnalysis) return;
    }
    el.autoBuildBtn.disabled = true;
    el.autoState.textContent = 'Working';

    const res = await api.auto.build({
      analysis: state.createAnalysis,
      platform: el.createPlatform.value,
      profile: el.autoProfile.value,
      intensity: el.autoIntensity.value,
      outputPath: null
    });
    el.autoBuildBtn.disabled = false;
    if (!res.ok) {
      el.autoState.textContent = 'Failed';
      return reportFailure(res, 'Auto could not build a recipe.');
    }

    state.autoResult = res;
    state.recipeState = 'auto';
    applyRecipeToControls(res.recipe);
    renderAutoExplanation(res);
    // The state chip says whether these are still Auto's settings, not what
    // they cost - the cost preview owns that, from the resolved plan.
    el.autoState.textContent = 'Applied';
    el.autoState.classList.add('ready');
  }

  function renderAutoExplanation(res) {
    el.autoExplain.hidden = false;
    el.autoExplain.innerHTML = '';
    const head = document.createElement('p');
    head.className = 'auto-head';
    // Deliberately no cost here. Auto's own estimate runs before the engine
    // planner has chosen a model or decided whether the network runs on
    // full-size frames, so it is the weaker of two claims about the same
    // thing - and two numbers in one panel that can disagree is worse than
    // one. The cost preview above the render button resolves the real plan.
    head.textContent = (res.profileInferred ? 'Detected' : 'Chosen') +
      ' profile: ' + res.profile + ' · ' + res.intensity;
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
      el.createAiQuality.value = r.reconstruction.aiQuality || 'balanced';
    } else {
      el.createAi.value = 'off';
    }

    el.createInterp.value = r.motion.interpolation === 'ai' ? 'ai'
      : r.motion.interpolation === 'none' ? 'off' : 'classical';
    el.createFps.value = r.output.fps ? String(r.output.fps) : 'source';
    el.createScene.checked = r.motion.sceneCutProtection !== false;

    // Aspect ratio, then resolution, then framing - read back in the same
    // three-part shape they are written in.
    if (r.framing.enabled && r.framing.canvas && r.framing.canvas !== 'source') {
      el.createAspect.value = [...el.createAspect.options].some((o) => o.value === r.framing.canvas)
        ? r.framing.canvas : 'custom';
      if (r.framing.canvas === 'custom') {
        if (r.framing.aspectW) el.createAspectW.value = String(r.framing.aspectW);
        if (r.framing.aspectH) el.createAspectH.value = String(r.framing.aspectH);
      }
      // Read tracking back too. Losing it here is what made Auto announce
      // "Smart Reframe enabled" while the control underneath said centre crop
      // and the render obeyed the control.
      el.createFraming.value = framingChoiceFor(r.framing);
    } else {
      el.createAspect.value = 'source';
    }

    const target = r.reconstruction.targetResolution;
    if (target.mode === 'custom' && target.width && target.height) {
      const wh = target.width + 'x' + target.height;
      const suggestion = suggestedResolutionFor(currentAspect());
      if (suggestion && suggestion.width === target.width && suggestion.height === target.height) {
        // It is exactly what the ratio suggests, so leave it on automatic and
        // let a later ratio change move it.
        el.createRes.value = 'auto';
      } else if ([...el.createRes.options].some((o) => o.value === wh)) {
        el.createRes.value = wh;
      } else {
        el.createRes.value = 'custom';
        el.createResW.value = String(target.width);
        el.createResH.value = String(target.height);
      }
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
    syncGeometryUi();
    syncAiUi();
    schedulePreview();
  }

  function markRecipeModified() {
    if (state.recipeState === 'auto') {
      state.recipeState = 'modified';
      if (!el.autoState.textContent.includes('edited')) {
        el.autoState.textContent = 'Applied · edited';
      }
    }
  }

  async function applyCreatorPreset(id) {
    if (!id) return;
    const res = await api.creatorPresets.apply(id, { analysis: state.createAnalysis, outputPath: null });
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

  /* ------------------------------------------------------------------ *
   * Geometry: target, aspect, resolution
   *
   * Four related settings that are not the same setting. The target seeds the
   * other three and then gets out of the way; aspect ratio decides the shape;
   * resolution decides the pixel count; framing decides what happens to the
   * picture when the source shape and the output shape disagree. Before this,
   * shape was only reachable by picking a social platform, which meant a
   * 21:9 master was not expressible at all.
   * ------------------------------------------------------------------ */

  function populateAspects() {
    el.createAspect.innerHTML = '';
    for (const aspect of Object.values(state.aspects)) {
      const opt = document.createElement('option');
      opt.value = aspect.id;
      opt.textContent = aspect.label;
      el.createAspect.appendChild(opt);
    }
    el.createAspect.value = 'source';
  }

  /** The ratio the aspect control currently describes, or null for source. */
  function currentAspect() {
    const id = el.createAspect.value;
    if (id === 'source') return null;
    if (id === 'custom') {
      const w = Number(el.createAspectW.value);
      const h = Number(el.createAspectH.value);
      return w > 0 && h > 0 ? { id: 'custom', ratio: w / h, w, h } : null;
    }
    const preset = state.aspects[id];
    if (!preset) return null;
    // Ids whose label is not their arithmetic. "21:9" is universally 64:27.
    const IRREGULAR = { '21:9': [64, 27], '2.39:1': [239, 100] };
    const [w, h] = IRREGULAR[id] || id.split(':').map(Number);
    return { id, ratio: w / h, w, h };
  }

  /** Resolution the current ratio suggests, honouring the long edge. */
  function suggestedResolutionFor(aspect) {
    if (!aspect) return null;
    const preset = state.aspects[aspect.id];
    if (preset && preset.suggested) return { ...preset.suggested };
    const even = (v) => { const n = Math.max(16, Math.round(v)); return n % 2 ? n + 1 : n; };
    return aspect.ratio >= 1
      ? { width: 1920, height: even(1920 / aspect.ratio) }
      : { width: even(1080 * aspect.ratio), height: 1920 };
  }

  /**
   * Reflect the geometry controls into each other.
   *
   * The rule for resolution is intent-preserving: while it is on `auto` a
   * ratio change moves it, and once the user has chosen a size themselves that
   * choice is left alone even if it no longer matches the ratio - they are
   * told about the mismatch rather than overruled.
   */
  function syncGeometryUi() {
    const aspect = currentAspect();
    el.createAspectCustomRow.hidden = el.createAspect.value !== 'custom';
    el.createResCustomRow.hidden = el.createRes.value !== 'custom';

    const suggestion = suggestedResolutionFor(aspect);
    const autoOption = [...el.createRes.options].find((o) => o.value === 'auto');
    if (autoOption) {
      autoOption.textContent = suggestion
        ? `Suggested for this ratio — ${suggestion.width} × ${suggestion.height}`
        : 'Suggested for this ratio';
    }

    const notes = [];
    const srcInfo = state.createAnalysis && state.createAnalysis.video;
    const srcW = srcInfo ? (state.createAnalysis.derived.displayWidth || srcInfo.width) : 0;
    const srcH = srcInfo ? (state.createAnalysis.derived.displayHeight || srcInfo.height) : 0;

    const resolved = resolveGeometryChoice(aspect, suggestion);
    if (resolved) {
      notes.push(`Output ${resolved.width} × ${resolved.height}.`);
      if (aspect) {
        const actual = resolved.width / resolved.height;
        if (Math.abs(actual - aspect.ratio) > 0.02) {
          // Never silently stretch: say what will happen instead.
          notes.push(
            `That size is ${formatRatio(actual)}, not ${formatRatio(aspect.ratio)} — ` +
            'the framing setting decides whether the difference is cropped or letterboxed.'
          );
        }
      }
      if (srcW && srcH) {
        const srcRatio = srcW / srcH;
        const outRatio = resolved.width / resolved.height;
        if (Math.abs(srcRatio - outRatio) > 0.02) {
          notes.push(`Source is ${formatRatio(srcRatio)}; reframing applies.`);
        }
      }
    } else if (srcW && srcH) {
      notes.push(`Output stays at the source shape, ${srcW} × ${srcH}.`);
    }
    el.createGeometryNote.textContent = notes.join(' ');

    // Framing only means something when the shapes differ.
    const reshapes = !!aspect;
    el.createFramingRow.hidden = !reshapes;
    el.createFramingHelp.hidden = !reshapes;
    refreshSemanticNote();
    refreshGroupTags();
  }

  /**
   * What Smart Reframe will actually track on this machine.
   *
   * Never claims face tracking when the models are absent: without them the
   * tracker is motion and detail saliency, which is a different and more
   * modest thing, and the note says so.
   */
  function refreshSemanticNote() {
    const node = el.createSemanticNote;
    if (!node) return;
    const relevant = !el.createFramingRow.hidden && el.createFraming.value === 'smart';
    node.hidden = !relevant;
    if (!relevant) return;
    const ready = state.semantic && state.semantic.status === 'ready';
    node.textContent = ready
      ? 'Face and person detection is installed, so a stationary subject is not lost to a busy background. The Queue reports which signal actually decided each sample.'
      : 'Face and person detection is not installed, so tracking will use motion and detail saliency alone. Install it under Settings → Models.';
  }

  /** The concrete output size the panel currently describes, or null. */
  function resolveGeometryChoice(aspect, suggestion) {
    const value = el.createRes.value;
    if (value === 'custom') {
      const w = Number(el.createResW.value);
      const h = Number(el.createResH.value);
      if (!(w > 0) || !(h > 0)) return null;
      return { width: evenDim(w), height: evenDim(h) };
    }
    if (/^\d+x\d+$/.test(value)) {
      const [w, h] = value.split('x').map(Number);
      return { width: w, height: h };
    }
    if (value === 'auto') return suggestion || null;
    return null;   // 'source'
  }

  function evenDim(v) {
    const n = Math.max(16, Math.round(Number(v) || 0));
    return n % 2 === 0 ? n : n + 1;
  }

  function formatRatio(r) {
    const known = [[16 / 9, '16:9'], [9 / 16, '9:16'], [4 / 5, '4:5'], [1, '1:1'],
      [21 / 9, '21:9'], [2.39, '2.39:1'], [4 / 3, '4:3'], [3 / 2, '3:2']];
    for (const [value, label] of known) {
      if (Math.abs(r - value) < 0.02) return label;
    }
    return `${r.toFixed(2)}:1`;
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

    // Aspect ratio and resolution, as two separate answers.
    const aspect = currentAspect();
    const suggestion = suggestedResolutionFor(aspect);
    const size = resolveGeometryChoice(aspect, suggestion);
    const resValue = el.createRes.value;

    if (!size) {
      overrides.reconstruction = { enabled: false, targetResolution: { mode: 'source' } };
    } else {
      overrides.reconstruction = {
        enabled: true,
        mode: 'classical',
        targetResolution: { mode: 'custom', width: size.width, height: size.height }
      };
    }

    // Framing owns the canvas. The aspect control sets its shape; the platform
    // only seeded that shape when it was chosen.
    if (aspect) {
      overrides.framing = {
        ...framingOverride(el.createFraming.value),
        canvas: aspect.id,
        aspectW: aspect.id === 'custom' ? aspect.w : null,
        aspectH: aspect.id === 'custom' ? aspect.h : null,
        width: size ? size.width : null,
        height: size ? size.height : null
      };
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
      overrides.reconstruction.aiQuality = el.createAiQuality.value;
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
    // Copies the descriptor across; it does not make the two share one.
    await setCreateSource(snapshotSource(state.media, state.analysis));
    if (!state.createAnalysis) await analyseSource();
    toast('Ready to finish this video. Auto can suggest settings.', 'ok', 5000);
  }

  /**
   * Build the recipe the panel currently describes, without queueing it.
   * Shared by "render" and "save as preset" so the two can never disagree.
   */
  async function buildCurrentRecipe(outputPath) {
    const src = state.createSource;
    if (!src) {
      toast('Choose a Create source first.', 'warn');
      return null;
    }
    const overrides = buildRecipeOverrides(outputPath || 'preset.mp4');
    overrides.source = src.kind === 'local'
      ? { type: 'local', path: src.source, title: src.title }
      : { type: 'remote', webpageUrl: src.webpageUrl || src.source, title: src.title };

    const built = el.createUseLook.checked
      ? await api.recipe.fromPreview(state.params, state.createAnalysis, overrides)
      : await api.recipe.default(state.createAnalysis, overrides);
    if (!built.ok) {
      reportFailure(built, 'The recipe could not be built.');
      return null;
    }
    return built.recipe;
  }

  async function startCreate() {
    // Everything this render needs is captured *now*, before the first await.
    // The panel stays editable while the dialog is open and while the job
    // runs; a job that read `state` later would follow those edits, which is
    // how changing the Create source could re-aim a render already underway.
    const src = state.createSource;
    if (!src) return toast('Choose a Create source first.', 'warn');
    if (src.isLive) return toast('Live streams cannot be rendered to a file.', 'warn');
    const snapshot = {
      source: src,
      analysis: state.createAnalysis,
      params: state.params ? { ...state.params } : null,
      useLook: el.createUseLook.checked
    };

    const base = (snapshot.source.title || 'visionance')
      .replace(/\.[a-z0-9]{2,4}$/i, '')
      .replace(/[^\w\s.-]+/g, '')
      .trim()
      .slice(0, 70) || 'visionance';
    const platform = state.platforms[el.createPlatform.value];
    const container = (platform && platform.container) || 'mp4';
    const suffix = platform && platform.id !== 'custom' ? ` (${platform.id})` : ' (visionance)';

    const overrides = buildRecipeOverrides('placeholder.' + container);

    const dest = await api.dialog.saveVideo(`${base}${suffix}.${container}`, container);
    if (!dest.ok) return;

    overrides.output.path = dest.file;
    overrides.output.container = (dest.file.split('.').pop() || container).toLowerCase();
    overrides.name = `${base}${suffix}`;
    overrides.source = snapshot.source.kind === 'local'
      ? { type: 'local', path: snapshot.source.source, title: snapshot.source.title }
      // Only the page URL is recorded: the direct stream URL expires, so the
      // job re-resolves it when it actually runs.
      : { type: 'remote', webpageUrl: snapshot.source.webpageUrl || snapshot.source.source, title: snapshot.source.title };

    // "Apply the look" turns the preview parameters into a starting recipe.
    // The two engines are different; this is intent, not a pixel guarantee.
    const built = snapshot.useLook
      ? await api.recipe.fromPreview(snapshot.params, snapshot.analysis, overrides)
      : await api.recipe.default(snapshot.analysis, overrides);
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
      analysis: snapshot.analysis,
      source: {
        webpageUrl: snapshot.source.kind === 'stream'
          ? (snapshot.source.webpageUrl || snapshot.source.source) : null,
        // Deliberately no stream token. A render that outlives the session it
        // was started from must re-resolve, not hold a handle to the Watch
        // tab's expiring one.
        headerToken: null,
        title: snapshot.source.title
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

  const ACTIVE_STATUSES = ['queued', 'ready', 'analysing', 'running', 'paused', 'cancelling'];
  const isActiveJob = (job) => ACTIVE_STATUSES.includes(job.status);

  /**
   * The Queue is capped rather than unbounded.
   *
   * The job store keeps history, and a list that builds a card plus a details
   * block for every render ever run would get slower every week. Active jobs
   * are always shown; finished ones are windowed, with an explicit control to
   * show more. No virtualisation library, no scroll maths - just a count.
   */
  const JOB_PAGE = 20;
  let jobsShown = JOB_PAGE;

  function renderJobs() {
    const jobs = [...state.jobs.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    el.jobList.innerHTML = '';

    const active = jobs.filter(isActiveJob);
    updateQueueBadge(active.length);
    updateJobStrip(active);
    refreshUtilityStrip();
    refreshQueueSide();
    refreshStatusBar();
    if (state.workspace === 'create') refreshCreateHome();

    if (!jobs.length) {
      el.jobList.innerHTML =
        '<div class="empty-note"><strong>No active jobs</strong>' +
        'Renders you queue from Create appear here, and survive a restart.</div>';
      el.queueSummary.textContent = '';
      return;
    }

    const visible = jobs.slice(0, Math.max(jobsShown, active.length));
    for (const job of visible) el.jobList.appendChild(renderJobCard(job));

    const hidden = jobs.length - visible.length;
    if (hidden > 0) {
      const more = document.createElement('button');
      more.className = 'btn btn-ghost full';
      more.textContent = `Show ${Math.min(hidden, JOB_PAGE)} older render${hidden === 1 ? '' : 's'}`;
      more.addEventListener('click', () => { jobsShown += JOB_PAGE; renderJobs(); });
      el.jobList.appendChild(more);
    }

    const done = jobs.filter((j) => j.status === 'completed').length;
    el.queueSummary.textContent =
      `${jobs.length} total · ${active.length} active · ${done} complete`;
  }

  function updateQueueBadge(count) {
    el.queueCount.hidden = count === 0;
    el.queueCount.textContent = String(count);
  }

  /**
   * The background render strip in the top bar.
   *
   * Small on purpose: a render can take an hour, and a status readout that
   * occupies a fifth of the window for that hour is a worse trade than a chip
   * you can click. Written in place rather than rebuilt, because a running job
   * emits updates continuously.
   */
  function updateJobStrip(active) {
    const job = active.find((j) => j.status === 'running') || active[0];
    if (!job) { el.jobStrip.hidden = true; return; }

    el.jobStrip.hidden = false;
    if (!el.jobStrip.childElementCount) {
      el.jobStrip.innerHTML =
        '<span class="js-name"></span><span class="js-stage"></span>' +
        '<span class="js-bar"><span></span></span><span class="js-num"></span>';
    }
    const pct = Math.round((job.progress || 0) * 100);
    const set = (selector, text) => {
      const node = el.jobStrip.querySelector(selector);
      if (node.textContent !== text) node.textContent = text;
    };
    set('.js-name', job.title || 'Render');
    set('.js-stage', (job.stage || STATUS_LABEL[job.status] || '').toUpperCase());
    el.jobStrip.querySelector('.js-bar span').style.width = `${pct}%`;

    const bits = [`${pct}%`];
    const rate = job.neuralRate;
    if (rate && !rate.warming && rate.framesPerSecond > 0) {
      bits.push(`${rate.framesPerSecond.toFixed(2)} fps`);
    } else if (job.speed) {
      bits.push(`${job.speed.toFixed(2)}×`);
    }
    if (job.eta) bits.push(`~${fmtTime(job.eta)}`);
    set('.js-num', bits.join(' · '));
    el.jobStrip.title = `${job.title} — ${STATUS_LABEL[job.status] || job.status}. Open the render queue.`;
  }

  /**
   * A job card.
   *
   * The row answers "what is this, how far along, how fast, and what will come
   * out" at a glance; everything a person only wants when something went wrong
   * - the stage path, the model, the GPU, the tile, the chunk plan, the full
   * Smart Reframe accounting, the verification failures - lives behind one
   * disclosure. Neither half invents anything: a field the backend did not
   * report is simply absent.
   */
  function renderJobCard(job) {
    const node = document.createElement('div');
    node.className = 'job';
    if (isActiveJob(job)) node.classList.add('is-active');
    if (job.status === 'completed') node.classList.add('done');
    if (job.status === 'failed') node.classList.add('bad');

    const main = document.createElement('div');
    main.className = 'job-main';

    // The same thumbnail this source has in Create and the Library.
    const thumb = document.createElement('div');
    thumb.className = 'thumb md';
    thumbs.paint(thumb, {
      kind: job.source.type === 'remote' ? 'stream' : 'local',
      source: job.source.path || job.source.webpageUrl,
      webpageUrl: job.source.webpageUrl
    }, { duration: job.totalDuration || null });

    const body = document.createElement('div');
    body.className = 'job-body';

    const head = document.createElement('div');
    head.className = 'job-head';
    const title = document.createElement('div');
    title.className = 'job-title';
    title.textContent = job.title;
    title.title = job.output ? job.output.path : '';
    head.append(title);

    // Progress and rate form their own column, so a row resolves left to right
    // as identity → what it makes → how far along → how fast → state.
    const track = document.createElement('div');
    track.className = 'job-track';

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
    right.className = 'job-meta-right';
    if (job.status === 'running') {
      // A neural job has no ffmpeg `speed`; it has a measured frame rate. Show
      // whichever the job actually produced, and show nothing at all while the
      // estimate is still warming up rather than a number that will be wrong.
      const parts = [];
      const rate = job.neuralRate;
      if (rate && !rate.warming && rate.framesPerSecond > 0) {
        parts.push(`${rate.framesPerSecond.toFixed(2)} fps`);
        parts.push(`${rate.framesDone}/${rate.framesTotal} frames`);
      } else if (rate && rate.warming) {
        parts.push('measuring rate…');
      } else if (job.speed) {
        parts.push(`${job.speed.toFixed(2)}×`);
      }
      if (job.eta) parts.push(`~${fmtTime(job.eta)} left`);
      right.textContent = parts.join(' · ');
    } else if (job.status === 'completed' && job.output && job.output.sizeBytes) {
      right.textContent = fmtBytes(job.output.sizeBytes);
    }
    meta.append(left, right);
    track.append(bar, meta);
    body.append(head);

    // What is going to come out, and what it will cost to get there.
    const spec = document.createElement('div');
    spec.className = 'job-spec';
    for (const text of describeJobOutput(job)) spec.appendChild(chip(text));
    if (job.cost && !['completed', 'cancelled'].includes(job.status)) {
      const badge = document.createElement('span');
      badge.className = `cost-class ${job.cost.class}`;
      badge.textContent = job.cost.label;
      badge.title = job.cost.reasons.join(' · ');
      spec.appendChild(badge);
    }
    if (spec.childElementCount) body.appendChild(spec);

    // Smart Reframe, in one line. The backend name comes from counted
    // contributions, so a run that fell back to saliency says saliency however
    // much detection is installed, and a failed run names no backend at all.
    if (job.reframe) {
      const rf = document.createElement('div');
      rf.className = `job-reframe ${job.reframe.outcome || ''}`;
      const mark = document.createElement('span');
      mark.className = 'rf-mark';
      const label = document.createElement('span');
      label.textContent = job.reframe.outcome === 'centred'
        ? 'Smart Reframe · centre framing used'
        : `Smart Reframe · ${job.reframe.backendLabel}`;
      rf.append(mark, label);
      if (job.reframe.outcome !== 'centred' &&
          Number.isFinite(job.reframe.tracked) && Number.isFinite(job.reframe.samples)) {
        const count = document.createElement('span');
        count.className = 'rf-count';
        // "Tracked N of M" rather than a bare ratio: the row has to say what
        // the numbers count, and verify-switch asserts this exact shape.
        count.textContent = `Tracked ${job.reframe.tracked} of ${job.reframe.samples}`;
        rf.appendChild(count);
      }
      body.appendChild(rf);
    }

    // Only genuinely actionable text stays on the row.
    if (job.error) {
      const err = document.createElement('div');
      err.className = 'job-note job-error';
      err.textContent = job.error.suggestedAction
        ? `${job.error.message} ${job.error.suggestedAction}`
        : job.error.message;
      body.appendChild(err);
    }

    const actions = document.createElement('div');
    actions.className = 'job-actions';
    const button = (label, fn, kind) => {
      const b = document.createElement('button');
      b.className = `btn ${kind || 'btn-ghost'}`;
      b.textContent = label;
      b.addEventListener('click', async () => {
        b.disabled = true;
        const r = await fn();
        if (r && !r.ok) reportFailure(r);
        b.disabled = false;
      });
      actions.appendChild(b);
    };

    // Only actions that are valid right now. A disabled row of every possible
    // verb is clutter that tells the user nothing.
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
      button('Play', () => api.system.openPath(job.output.path), 'btn-secondary');
      button('Show in folder', () => api.system.reveal(job.output.path));
      button('Remove', () => api.jobs.remove(job.id));
    }

    // Status and actions share the right-hand column.
    const side = document.createElement('div');
    side.className = 'job-side';
    const status = document.createElement('div');
    status.className = `job-status ${job.status}`;
    status.textContent = STATUS_LABEL[job.status] || job.status;
    side.appendChild(status);
    if (actions.children.length) side.appendChild(actions);

    main.append(thumb, body, track, side);
    node.appendChild(main);

    const details = buildJobDetails(job);
    if (details) node.appendChild(details);

    return node;
  }

  /** The chips on a job row: what the render is actually producing. */
  function describeJobOutput(job) {
    const bits = [];
    const r = job.recipe;
    if (!r) return bits;
    const target = r.reconstruction && r.reconstruction.targetResolution;
    if (target && target.width && target.height) bits.push(`${target.width}×${target.height}`);
    else if (target && target.mode === 'source') bits.push('Source size');
    if (r.output && r.output.fps) bits.push(`${r.output.fps} fps`);
    if (r.output && r.output.codec) bits.push(String(r.output.codec).toUpperCase());
    if (r.reconstruction && r.reconstruction.mode === 'neural') {
      bits.push(r.reconstruction.aiMode === 'restore'
        ? 'Neural restore'
        : `Neural ${r.reconstruction.aiScale}×`);
    }
    if (r.motion && r.motion.interpolation === 'ai') bits.push('RIFE');
    if (r.audio && r.audio.master && r.audio.master !== 'preserve') {
      bits.push(AUDIO_MASTER_LABEL[r.audio.master] || r.audio.master);
    }
    return bits;
  }

  const AUDIO_MASTER_LABEL = {
    preserve: 'Preserve',
    normalize: 'Normalize',
    creator: 'Creator Master',
    dialogue: 'Dialogue Focus'
  };

  /**
   * Everything a person only needs when they are investigating. Built as a
   * definition list so the labels align without a table, and skipped entirely
   * when there is nothing worth disclosing.
   */
  function buildJobDetails(job) {
    const rows = [];
    const add = (key, value, plain) => {
      if (value === null || value === undefined || value === '') return;
      rows.push([key, String(value), plain]);
    };

    if (job.plan && job.plan.description) {
      add('Plan', job.plan.chunked
        ? `${job.plan.description} · ${job.plan.chunkCount} chunks`
        : job.plan.description, true);
    }
    // Stage records are objects on a real job, so joining the array directly
    // printed "[object Object] → [object Object]" for every render that was
    // not the harness's synthetic one.
    const chain = stageChain(job);
    if (chain.length) {
      add('Stages', chain.map((s) => s.name.toUpperCase()).join(' → '), true);
    }
    if (job.cost) add('Cost', `${job.cost.label} — ${job.cost.reasons.join(' · ')}`, true);

    const metrics = job.aiMetrics;
    if (metrics) {
      add('Model', metrics.model || metrics.upscaleModel);
      add('GPU', metrics.gpu !== undefined && metrics.gpu !== null ? String(metrics.gpu) : null);
      add('Tile', metrics.tileSize);
    }
    if (job.checkpoint && job.checkpoint.chunkIndex !== undefined) {
      add('Checkpoint', `chunk ${job.checkpoint.chunkIndex}`);
    }
    if (job.output) {
      add('Output', job.output.path);
      if (job.output.sizeBytes) add('Size', fmtBytes(job.output.sizeBytes));
    }

    // The reconciled Smart Reframe account: tracked + held + centred always
    // equals the sample count, and the confidence is over the samples used.
    if (job.reframe) {
      add('Reframe', job.reframe.headline, true);
      if (job.reframe.detail && job.reframe.detail.length) {
        add('Tracking', job.reframe.detail.join(' · '), true);
      }
    }

    for (const w of job.warnings || []) rows.push(['Warning', w, true, 'warn']);
    if (job.error && job.error.technicalDetails) add('Detail', job.error.technicalDetails);
    if (job.verification && !job.verification.ok) {
      for (const failure of job.verification.failures) rows.push(['Verification', failure, true, 'bad']);
    }

    if (!rows.length) return null;

    const details = document.createElement('details');
    details.className = 'job-details';
    const summary = document.createElement('summary');
    summary.textContent = 'Technical detail';
    const body = document.createElement('dl');
    body.className = 'job-detail-body';
    for (const [key, value, plain, kind] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      dd.textContent = value;
      dd.className = [plain ? 'plain' : '', kind ? `dd-${kind}` : ''].filter(Boolean).join(' ');
      body.append(dt, dd);
    }
    details.append(summary, body);
    return details;
  }

  /* ------------------------------------------------------------------ *
   * Library
   * ------------------------------------------------------------------ */

  /**
   * Recent media.
   *
   * Rendered as rows, and restyled into a card grid by the Library workspace.
   * The thumbnail is the one this source already has everywhere else - the
   * cache is asked once per identity, not once per card, so re-rendering the
   * list is free.
   */
  let lastRecents = [];

  function renderRecents(recents) {
    lastRecents = recents || [];
    el.recentList.innerHTML = '';
    refreshLibrarySummary();
    // Create's intake reads the same list, so it can never fall behind it.
    if (state.workspace === 'create') refreshCreateHome();

    if (!lastRecents.length) {
      el.recentList.innerHTML =
        '<div class="empty-note"><strong>No recent media</strong>' +
        'Videos you play appear here for one-click reopening.</div>';
      return;
    }

    for (const item of lastRecents) {
      const row = document.createElement('div');
      row.className = 'recent';
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      // Drives the corner kind marker on a Library card.
      row.dataset.kind = item.kind || 'local';

      const thumb = document.createElement('div');
      thumb.className = 'thumb sm';
      thumbs.paint(thumb, {
        kind: item.kind,
        source: item.source,
        webpageUrl: item.kind === 'stream' ? item.source : null,
        thumbnail: item.thumbnail || null,
        durationSeconds: item.duration || null
      }, { duration: item.duration || null });

      const meta = document.createElement('div');
      meta.className = 'recent-meta';
      const t = document.createElement('div');
      t.className = 'recent-title';
      t.textContent = item.title || item.source;
      t.title = item.source;
      const s = document.createElement('div');
      s.className = 'recent-sub';
      const bits = [item.kind === 'stream' ? 'Online' : 'Local file'];
      if (item.duration) bits.push(fmtTime(item.duration));
      if (item.at) bits.push(relativeTime(item.at));
      s.textContent = bits.join(' · ');
      meta.append(t, s);

      const del = document.createElement('button');
      del.className = 'recent-del';
      del.textContent = '✕';
      del.title = 'Remove from recents';
      del.setAttribute('aria-label', 'Remove from recents');
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        const r = await api.recents.remove(item.source);
        if (r.ok) renderRecents(r.recents);
      });

      const open = () => {
        if (item.kind === 'stream') openUrl(item.source);
        else openLocalFile(item.source);
        setWorkspace('presets');
      };
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });

      row.append(thumb, meta, del);
      el.recentList.appendChild(row);
    }
  }

  function refreshLibrarySummary() {
    if (!el.librarySummary) return;
    if (!lastRecents.length) { el.librarySummary.textContent = ''; return; }
    const online = lastRecents.filter((r) => r.kind === 'stream').length;
    el.librarySummary.textContent =
      `${lastRecents.length} item${lastRecents.length === 1 ? '' : 's'}` +
      (online ? ` · ${online} online` : '');
  }

  /** Coarse on purpose: nobody needs "4 minutes and 12 seconds ago". */
  function relativeTime(at) {
    const seconds = Math.max(0, (Date.now() - at) / 1000);
    if (seconds < 90) return 'just now';
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
    const days = Math.round(seconds / 86400);
    return days === 1 ? 'yesterday' : `${days}d ago`;
  }

  /* ================================================================== *
   * The workstation surfaces
   *
   * The source column, the process strip under the picture, the operations
   * console and the status bar. Between them they are the difference between
   * a player with a settings panel and a workstation, and none of them owns
   * any state: every value below is read from `state`, the media element, the
   * engine's own stats or the telemetry controller's last sample.
   *
   * They are written on real events - a source change, an enhancement toggle,
   * a job update - plus the existing three-second housekeeping tick. Nothing
   * here starts a timer, subscribes to anything, or asks the main process for
   * a value it was not already going to receive.
   * ================================================================== */

  /** A key/value row for the source column's aligned spec tables. */
  function specRow(host, key, value, kind) {
    if (value === null || value === undefined || value === '') return;
    const k = document.createElement('span');
    k.className = 'sk';
    k.textContent = key;
    const v = document.createElement('span');
    v.className = 'sv' + (kind ? ` ${kind}` : '');
    v.textContent = value;
    v.title = value;
    host.append(k, v);
  }

  /** The descriptor a thumbnail request needs, from a player descriptor. */
  function thumbRequest(media, duration) {
    return {
      kind: media.kind,
      source: media.source,
      webpageUrl: media.kind === 'stream' ? media.source : null,
      thumbnail: media.thumbnail || null,
      durationSeconds: duration
    };
  }

  /** The look currently on the picture, named the way the user chose it. */
  function currentLookName() {
    if (state.presetId === '__custom') return 'Custom';
    const preset = findPreset(state.presetId);
    return preset ? preset.name : 'Custom';
  }

  /** How many parameters have been moved off the look they came from. */
  function modifiedParamCount() {
    let n = 0;
    for (const [key, ref] of sliderRefs) {
      void key;
      if (ref.ctrl.classList.contains('modified')) n++;
    }
    return n;
  }

  /* ---- Watch's source details ----------------------------------------
   *
   * The probe report and the resolved processing summary, as they were in the
   * Adjust source column. The identity half of that column — poster, title,
   * kind — is gone rather than moved: Watch's own source card already states
   * all three, and two readouts of one fact are two things to keep in step.
   */

  function refreshSourceDetails() {
    const specs = el.sourceSpecs;
    if (!specs) return;
    if (state.workspace !== 'presets') return;

    const media = state.media;
    const analysis = state.analysis;
    const v = el.video;
    specs.innerHTML = '';

    if (!media) {
      specRow(specs, 'Status', 'no source', 'muted');
      return;
    }

    const duration = Number.isFinite(v.duration)
      ? v.duration
      : (media.info && media.info.duration) || null;

    // Only fields the probe or the media element actually reported. A source
    // Visionance has not analysed simply has fewer rows.
    const vid = (analysis && analysis.video) || {};
    const derived = (analysis && analysis.derived) || {};
    const colour = (analysis && analysis.color) || {};
    const container = (analysis && analysis.container) || {};
    const audio = analysis && analysis.audio;

    specRow(specs, 'Decoded', v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : null, 'strong');
    if (derived.displayWidth && derived.displayWidth !== v.videoWidth) {
      specRow(specs, 'Container', `${derived.displayWidth}×${derived.displayHeight}`);
    }
    const fps = vid.nominalFps || (media.info && media.info.fps) || null;
    specRow(specs, 'Frame rate', fps ? `${fps} fps` : null, 'strong');
    specRow(specs, 'Duration', duration ? fmtTime(duration) : null);
    specRow(specs, 'Codec', [vid.codec, vid.profile].filter(Boolean).join(' ') || null);
    specRow(specs, 'Pixel format', vid.pixelFormat || null);
    specRow(specs, 'Bit depth', vid.bitDepth ? `${vid.bitDepth}-bit` : null);
    if (colour.isHDR) specRow(specs, 'Colour', `HDR ${colour.hdrFormat || colour.transfer || ''}`.trim(), 'accent');
    else if (colour.transfer) specRow(specs, 'Colour', colour.transfer);
    specRow(specs, 'Orientation', derived.orientation
      ? `${derived.orientation} ${derived.aspectRatioLabel || ''}`.trim()
      : null);
    specRow(specs, 'Bitrate', container.bitrate ? `${Math.round(container.bitrate / 1000)} kbps` : null);
    specRow(specs, 'Size', container.size ? fmtBytes(container.size) : null);
    if (audio) specRow(specs, 'Audio', `${audio.codec} ${audio.channels || '?'}ch`);

    if (!analysis) {
      const note = document.createElement('p');
      note.className = 'sfoot';
      note.textContent = media.kind === 'stream'
        ? 'Online sources are probed when a render starts; the player reports what it decoded.'
        : 'Not probed yet.';
      specs.appendChild(note);
    }

    // The Adjust column also carried a processing summary here — look, path,
    // render size, quality, frame cost, presented rate. Every one of those is
    // in the process strip directly under the picture, which Watch always
    // shows, so repeating them inside a disclosure would be a second copy to
    // keep in step with no second reader.
  }

  /* ---- Source / process strip under the picture --------------------- */

  /**
   * The strip's cells are built once and then written in place.
   *
   * Rebuilding them would re-create the thumbnail element on every update, and
   * a fresh element means a fresh placeholder — so a slider drag would make the
   * poster under the picture flicker several times a second.
   */
  function psCell(host, opts = {}) {
    let lines = host.querySelector('.ps-lines');
    if (!lines) {
      host.innerHTML = '';
      if (opts.thumb) {
        const thumb = document.createElement('div');
        thumb.className = 'thumb sm';
        host.appendChild(thumb);
      }
      lines = document.createElement('div');
      lines.className = 'ps-lines';
      const a = document.createElement('div');
      a.className = 'ps-primary';
      const b = document.createElement('div');
      b.className = 'ps-secondary';
      lines.append(a, b);
      host.appendChild(lines);
    }
    return {
      thumb: host.querySelector('.thumb'),
      set(primary, secondary) {
        const a = lines.children[0];
        const b = lines.children[1];
        if (a.textContent !== primary) { a.textContent = primary; a.title = primary; }
        if (b.textContent !== secondary) b.textContent = secondary;
      }
    };
  }

  function setTag(node, text, kind) {
    node.textContent = text;
    node.className = 'ps-tag' + (kind ? ` ${kind}` : '');
  }

  function refreshProcessStrip() {
    if (!el.processStrip || el.processStrip.hidden) return;

    const media = state.media;
    const v = el.video;
    const on = !!(state.params && state.params.enabled);

    /* SOURCE */
    const source = psCell(el.utilitySource, { thumb: true });
    if (!media) {
      setTag(el.utilitySourceTag, '');
      source.set('Nothing loaded', 'open a file or paste a link in Watch');
    } else {
      const duration = Number.isFinite(v.duration)
        ? v.duration
        : (media.info && media.info.duration) || null;
      setTag(el.utilitySourceTag, media.kind === 'stream' ? 'Online' : 'Local');
      thumbs.paint(source.thumb, thumbRequest(media, duration), { duration });

      const bits = [];
      if (v.videoWidth) bits.push(`${v.videoWidth}×${v.videoHeight}`);
      const fps = (state.analysis && state.analysis.video && state.analysis.video.nominalFps) ||
        (media.info && media.info.fps) || 0;
      if (fps) bits.push(`${fps} fps`);
      if (duration) bits.push(fmtTime(duration));
      source.set(media.title || media.source, bits.join(' · ') || '—');
    }

    /* LOOK */
    const changed = modifiedParamCount();
    setTag(el.psLookTag, changed ? `${changed} changed` : '', changed ? 'on' : '');
    psCell(el.psLook).set(currentLookName(),
      changed ? 'edited from the preset' : 'at preset values');

    /* ENHANCEMENT */
    setTag(el.psEnhanceTag, on ? 'On' : 'Off', on ? 'on' : '');
    const enhance = psCell(el.psEnhance);
    if (!media) {
      enhance.set('—', 'nothing to enhance');
    } else if (on && el.glCanvas.width) {
      const scale = v.videoWidth ? Math.round((el.glCanvas.width / v.videoWidth) * 100) : null;
      enhance.set(`${labelForHeight(v.videoHeight)} → ${labelForHeight(el.glCanvas.height)}`,
        `${el.glCanvas.width}×${el.glCanvas.height}${scale ? ` · ${scale}%` : ''}`);
    } else {
      enhance.set(on ? 'Starting…' : 'Native playback',
        on ? 'waiting for the first rendered frame'
          : 'decoded frames go straight to the compositor');
    }

    /* REALTIME ENGINE */
    const stats = state.engine ? state.engine.stats : null;
    const pb = state.playback ? state.playback.snapshot() : null;
    const limited = !!(stats && stats.limited);
    setTag(el.psEngineTag, limited ? 'GPU limited' : (on ? 'Running' : 'Stopped'),
      limited ? '' : (on ? 'ok' : ''));
    const engine = psCell(el.psEngine);
    if (on && stats) {
      engine.set(`${Math.round(stats.droppedScale * 100)}% · ${stats.policy}`,
        `${stats.cpuMs} / ${stats.frameBudgetMs} ms${pb ? ` · ${pb.presentedFps} fps` : ''}`);
    } else {
      engine.set('Idle', pb ? `${pb.presentedFps} fps presented` : 'no GPU work');
    }
  }

  /**
   * The look readouts alone.
   *
   * Called from the slider path, where a full strip rebuild would be work
   * proportional to how fast someone drags.
   */
  function refreshLookReadouts() {
    if (el.processStrip && !el.processStrip.hidden) {
      const changed = modifiedParamCount();
      setTag(el.psLookTag, changed ? `${changed} changed` : '', changed ? 'on' : '');
      psCell(el.psLook).set(currentLookName(),
        changed ? 'edited from the preset' : 'at preset values');
    }
    refreshFineTuneContext();
  }

  /* ---- Fine Tune's context (formerly the Adjust inspector's) ---------- */

  /**
   * What the parameters below are acting on.
   *
   * The collapsed summary has to be worth reading on its own, because the
   * whole point of collapsing Fine Tune is that most sessions never open it:
   * the tag says how far the look has been moved off its preset, so a glance
   * at the closed row answers "have I changed anything".
   */
  function refreshFineTuneContext() {
    if (!el.adjustEnhanceState) return;
    const on = !!(state.params && state.params.enabled);
    const changed = modifiedParamCount();

    if (el.fineTuneTag) {
      el.fineTuneTag.textContent = changed
        ? `${changed} changed`
        : (on ? 'at preset' : 'bypassed');
      el.fineTuneTag.className = 'gtag' + (changed ? ' on' : '');
    }
    el.adjustEnhanceState.textContent = on ? 'On' : 'Off';
    el.adjustEnhanceState.className = on ? 'on' : '';
    el.adjustRenderTag.textContent = on && el.glCanvas.width
      ? `${el.glCanvas.width}×${el.glCanvas.height}`
      : '—';
  }

  function setWatchQuality(value) {
    state.watchQuality = value;
    el.watchQuality.value = value;
    if (state.engine) state.engine.setPolicy(value);
    api.settings.patch({ watchQuality: value });
  }

  /* ---- Operations console -------------------------------------------- */

  /** Which reading of the job list the console is showing. */
  const CONSOLE_FILTER = {
    queue: (job) => isActiveJob(job),
    jobs: () => true,
    history: (job) => !isActiveJob(job)
  };

  function refreshUtilityStrip() {
    if (!el.utilityStrip || el.utilityStrip.hidden) return;

    const all = [...state.jobs.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const active = all.filter(isActiveJob);
    const rows = all.filter(CONSOLE_FILTER[state.consoleTab] || CONSOLE_FILTER.queue);

    el.utilityQueueTag.textContent = active.length
      ? `${active.length} active`
      : (all.length ? `${all.length} total` : '');

    el.utilityQueue.innerHTML = '';
    if (!rows.length) {
      const note = document.createElement('p');
      note.className = 'utility-empty';
      note.textContent = state.consoleTab === 'history'
        ? 'Nothing has finished yet.'
        : 'No renders queued. Create builds one from the current settings.';
      el.utilityQueue.appendChild(note);
    } else {
      // Four is what the bay can show without scrolling at the default window
      // height; the Queue workspace is where the whole list lives.
      for (const job of rows.slice(0, 6)) el.utilityQueue.appendChild(consoleJobRow(job));
    }

    refreshConsoleEngines();
  }

  /**
   * A console job row.
   *
   * Deliberately not the Queue's `.job` card: this is a status line, the card
   * is the job's full account, and collapsing the two would mean one of them
   * is wrong about how much room it has.
   */
  function consoleJobRow(job) {
    const node = document.createElement('div');
    node.className = 'op-job';
    if (isActiveJob(job)) node.classList.add('is-active');
    if (job.status === 'completed') node.classList.add('done');
    if (job.status === 'failed' || job.status === 'cancelled') node.classList.add('bad');

    const thumb = document.createElement('div');
    thumb.className = 'thumb sm';
    thumbs.paint(thumb, {
      kind: job.source.type === 'remote' ? 'stream' : 'local',
      source: job.source.path || job.source.webpageUrl,
      webpageUrl: job.source.webpageUrl
    }, { duration: job.totalDuration || null });

    const body = document.createElement('div');
    body.className = 'op-job-body';

    const title = document.createElement('div');
    title.className = 'op-job-title';
    title.textContent = job.title;
    title.title = job.title;

    const bar = document.createElement('div');
    bar.className = 'op-job-bar';
    const fill = document.createElement('span');
    fill.style.width = `${Math.round((job.progress || 0) * 100)}%`;
    bar.appendChild(fill);

    const meta = document.createElement('div');
    meta.className = 'op-job-meta';
    const stage = document.createElement('span');
    stage.className = 'op-stage';
    stage.textContent = (job.stage || STATUS_LABEL[job.status] || '').toLowerCase();
    const numbers = document.createElement('span');
    const bits = [`${Math.round((job.progress || 0) * 100)}%`];
    const rate = job.neuralRate;
    if (rate && !rate.warming && rate.framesPerSecond > 0) {
      bits.push(`${rate.framesPerSecond.toFixed(2)} fps`);
    } else if (job.speed) {
      bits.push(`${job.speed.toFixed(2)}×`);
    }
    if (job.eta) bits.push(`~${fmtTime(job.eta)} left`);
    numbers.textContent = bits.join(' · ');
    meta.append(stage, numbers);

    body.append(title, bar, meta);

    // Only actions the job is genuinely in a state to take. The Queue card is
    // the place for the full set; this offers the one you would reach for.
    const actions = document.createElement('div');
    actions.className = 'op-job-actions';
    const button = (label, fn) => {
      const b = document.createElement('button');
      b.className = 'btn btn-ghost';
      b.textContent = label;
      b.addEventListener('click', fn);
      actions.appendChild(b);
    };
    if (job.status === 'running' && job.pauseSupported) button('Pause', () => api.jobs.pause(job.id));
    else if (job.status === 'paused') button('Resume', () => api.jobs.resume(job.id));
    if (isActiveJob(job)) button('Cancel', () => api.jobs.cancel(job.id));
    else button('Open', () => setWorkspace('queue'));

    node.append(thumb, body, actions);
    return node;
  }

  /**
   * The engines-and-storage bay.
   *
   * States come from the engine status the app already fetched and the
   * detector's own status; nothing is polled for this panel, and an engine
   * whose state is unknown says "checking" rather than guessing.
   */
  function refreshConsoleEngines() {
    if (!el.consoleEngines) return;
    const rows = [
      ['Real-ESRGAN', engineState('realesrgan')],
      ['RIFE', engineState('rife')],
      ['Face & person detection', state.semantic
        ? (state.semantic.status === 'ready' ? 'installed' : 'not installed')
        : 'checking']
    ];

    const ready = rows.filter(([, s]) => s === 'installed').length;
    el.consoleEngineTag.textContent = `${ready}/${rows.length}`;

    el.consoleEngines.innerHTML = '';
    for (const [name, status] of rows) {
      const row = document.createElement('div');
      row.className = 'eng-row';
      const dot = document.createElement('span');
      dot.className = 'dot-state' + (status === 'installed' ? ' ok' : '');
      const label = document.createElement('span');
      label.className = 'eng-name';
      label.textContent = name;
      const state_label = document.createElement('span');
      state_label.className = 'eng-state' + (status === 'installed' ? ' ok' : ' off');
      state_label.textContent = status === 'installed' ? 'Ready' : status;
      row.append(dot, label, state_label);
      el.consoleEngines.appendChild(row);
    }

    const sep = document.createElement('div');
    sep.className = 'eng-sep';
    el.consoleEngines.appendChild(sep);

    const cache = document.createElement('div');
    cache.className = 'eng-row';
    const label = document.createElement('span');
    label.className = 'eng-name';
    label.textContent = 'Thumbnail cache';
    const value = document.createElement('span');
    value.className = 'eng-state';
    value.textContent = state.thumbCache
      ? `${state.thumbCache.count} · ${fmtBytes(state.thumbCache.bytes || 0)}`
      : '—';
    cache.append(label, value);
    el.consoleEngines.appendChild(cache);
  }

  function engineState(id) {
    const engine = state.engines && state.engines[id];
    if (!engine) return 'checking';
    return engine.status === 'ready' ? 'installed' : 'not installed';
  }

  /* ---- Queue workspace side column ----------------------------------- */

  function refreshQueueSide() {
    if (!el.queueStats) return;
    const all = [...state.jobs.values()];
    const active = all.filter(isActiveJob);
    const running = active.find((j) => j.status === 'running');
    const done = all.filter((j) => j.status === 'completed').length;
    const failed = all.filter((j) => j.status === 'failed').length;

    el.queueStateTag.textContent = running ? 'Rendering' : (active.length ? 'Waiting' : 'Idle');
    el.queueStateTag.className = 'col-tag' + (running ? ' on' : '');

    const stats = el.queueStats;
    stats.innerHTML = '';
    specRow(stats, 'Active', String(active.length), active.length ? 'accent' : 'muted');
    specRow(stats, 'Completed', String(done), done ? 'ok' : 'muted');
    if (failed) specRow(stats, 'Failed', String(failed), 'accent');
    if (running) {
      specRow(stats, 'Stage', (running.stage || STATUS_LABEL[running.status] || '—').toLowerCase(), 'strong');
      specRow(stats, 'Progress', `${Math.round((running.progress || 0) * 100)}%`, 'strong');
      const rate = running.neuralRate;
      if (rate && !rate.warming && rate.framesPerSecond > 0) {
        specRow(stats, 'Rate', `${rate.framesPerSecond.toFixed(2)} fps`);
      } else if (running.speed) {
        specRow(stats, 'Rate', `${running.speed.toFixed(2)}×`);
      }
      if (running.eta) specRow(stats, 'Remaining', `~${fmtTime(running.eta)}`, 'accent');
    }

    const engines = el.queueEngines;
    engines.innerHTML = '';
    specRow(engines, 'Real-ESRGAN', engineState('realesrgan') === 'installed' ? 'ready' : 'absent',
      engineState('realesrgan') === 'installed' ? 'ok' : 'muted');
    specRow(engines, 'RIFE', engineState('rife') === 'installed' ? 'ready' : 'absent',
      engineState('rife') === 'installed' ? 'ok' : 'muted');
    const semantic = state.semantic && state.semantic.status === 'ready';
    specRow(engines, 'Subject detection', semantic ? 'ready' : 'absent', semantic ? 'ok' : 'muted');
    specRow(engines, 'ffmpeg', state.info && state.info.binaries.ffmpeg.path ? 'ready' : 'missing',
      state.info && state.info.binaries.ffmpeg.path ? 'ok' : 'accent');

    refreshQueueActive(running || active[0] || null);

    const storage = el.queueStorage;
    if (storage) {
      storage.innerHTML = '';
      specRow(storage, 'Thumbnails', state.thumbCache
        ? `${state.thumbCache.count} · ${fmtBytes(state.thumbCache.bytes || 0)}`
        : '—', state.thumbCache ? null : 'muted');
      const delivered = all.filter((j) =>
        j.status === 'completed' && j.output && j.output.sizeBytes);
      const bytes = delivered.reduce((sum, j) => sum + j.output.sizeBytes, 0);
      specRow(storage, 'Rendered out', delivered.length ? fmtBytes(bytes) : '—',
        delivered.length ? 'strong' : 'muted');
      specRow(storage, 'Jobs held', String(all.length), all.length ? null : 'muted');
    }
  }

  /**
   * What the running render is actually doing.
   *
   * The stage chain comes off the job record, so it is the pipeline this job
   * resolved rather than a fixed diagram: a job with no neural stage has no
   * UPSCALE step and the module shows that. With nothing rendering it says so
   * — an idle render manager that draws a dimmed template is claiming to know
   * something it does not.
   */
  /**
   * A job's stage list, normalised.
   *
   * The job manager plans stages as records — `{ id, label, mode, status }` —
   * and a stage that does not apply to this recipe is planned as `skipped`
   * rather than left out, so the chain has to drop those itself or it claims
   * the job will do work it will not. Plain strings are also accepted because
   * that is the shape the verification harness pushes through the same IPC
   * event, and a readout that only survives one of its two real inputs is a
   * readout that throws in front of a user.
   *
   * State comes from each stage's own status where there is one, and falls
   * back to position against `job.stage` where there is not.
   */
  function stageChain(job) {
    if (!Array.isArray(job.stages) || !job.stages.length) return [];

    const steps = job.stages
      .map((s) => (typeof s === 'string' ? { id: s, status: null } : s))
      .filter((s) => s && s.id && s.status !== 'skipped' && s.mode !== 'skipped');

    const current = String(job.stage || '').toUpperCase();
    const at = steps.findIndex((s) => String(s.id).toUpperCase() === current);

    return steps.map((s, i) => {
      const isNow = s.status === 'running' || (s.status === null && i === at);
      const isDone = s.status === 'completed' ||
        (s.status === null && at >= 0 && i < at);
      return {
        name: String(s.id).toLowerCase(),
        state: isNow ? 'is-now' : (isDone ? 'is-done' : '')
      };
    });
  }

  function refreshQueueActive(job) {
    const host = el.queueActive;
    if (!host) return;

    el.queueActiveTag.textContent = job ? (STATUS_LABEL[job.status] || job.status) : '';
    el.queueActiveTag.className = 'col-tag' + (job && job.status === 'running' ? ' on' : '');

    host.innerHTML = '';
    if (!job) {
      const note = document.createElement('p');
      note.className = 'mini-empty';
      note.textContent = 'Nothing is rendering. Queue a build from Create and its stages appear here.';
      host.appendChild(note);
      return;
    }

    const title = document.createElement('div');
    title.className = 'qa-title';
    title.textContent = job.title;
    title.title = job.title;
    host.appendChild(title);

    // The resolved pipeline, with the stage it is on marked.
    const chainSteps = stageChain(job);
    if (chainSteps.length) {
      const chain = document.createElement('div');
      chain.className = 'qa-stages';
      for (const step of chainSteps) {
        const node = document.createElement('span');
        node.className = 'qa-stage' + (step.state ? ` ${step.state}` : '');
        node.textContent = step.name;
        chain.appendChild(node);
      }
      host.appendChild(chain);
    }

    const specs = document.createElement('div');
    specs.className = 'spec-list flush';
    if (job.plan && job.plan.description) specRow(specs, 'Plan', job.plan.description);
    if (job.plan && job.plan.chunked && job.plan.chunkCount) {
      specRow(specs, 'Chunks', String(job.plan.chunkCount));
    }
    if (job.cost && job.cost.label) {
      specRow(specs, 'Cost', job.cost.label.toLowerCase(), 'accent');
    }
    if (job.attempts > 1) specRow(specs, 'Attempts', String(job.attempts), 'accent');
    if (specs.childElementCount) host.appendChild(specs);

    // Why it costs what it costs, in the job's own words.
    const reasons = (job.cost && job.cost.reasons) || [];
    if (reasons.length) {
      const note = document.createElement('p');
      note.className = 'qa-note';
      note.textContent = reasons.join(' · ');
      host.appendChild(note);
    }
  }

  /* ---- Status bar ----------------------------------------------------- */

  /**
   * The window's bottom edge.
   *
   * Four real facts: the build, whether the binaries this app cannot work
   * without are present, the render actually running, and the device the
   * engine reported. No invented health, and no metric that would need its own
   * poll to keep honest.
   */
  function refreshStatusBar() {
    if (!el.statusbar) return;

    if (state.info) {
      el.sbVersion.textContent = `Visionance v${state.info.version}`;
    }

    const bins = state.info ? state.info.binaries : null;
    const dot = el.sbHealth.querySelector('.dot-state');
    const text = el.sbHealth.querySelector('.sb-text');
    if (!bins) {
      dot.className = 'dot-state';
      text.textContent = 'Starting…';
    } else if (!bins.ffmpeg.path) {
      dot.className = 'dot-state bad';
      text.textContent = 'ffmpeg not found — rendering unavailable';
    } else if (!bins.ytdlp.path) {
      dot.className = 'dot-state warn';
      text.textContent = 'yt-dlp not installed — local files only';
    } else {
      dot.className = 'dot-state ok';
      text.textContent = 'ffmpeg and yt-dlp ready';
    }

    const active = [...state.jobs.values()].filter(isActiveJob);
    const running = active.find((j) => j.status === 'running') || active[0];
    if (running) {
      const pct = Math.round((running.progress || 0) * 100);
      el.sbRender.textContent =
        `${(running.stage || STATUS_LABEL[running.status] || 'render').toUpperCase()} · ${pct}%` +
        (running.eta ? ` · ~${fmtTime(running.eta)} left` : '');
      el.sbRender.classList.add('is-active');
    } else {
      el.sbRender.textContent = 'No active renders';
      el.sbRender.classList.remove('is-active');
    }

    el.sbDevice.textContent = deviceName();
  }

  /**
   * A readable name for the device the picture is being drawn on.
   *
   * The engine reports WebGL's own renderer string, which on Windows is an
   * ANGLE description with the D3D feature levels and a PCI id in it. The
   * adapter name inside it is the part worth showing; the rest is noise on a
   * 26px bar. Nothing is invented — if the string cannot be read, the bar says
   * nothing rather than guessing.
   */
  function deviceName() {
    const raw = state.engine && state.engine.stats ? state.engine.stats.gpu : null;
    if (!raw) return '';
    const angle = /^ANGLE \(([^,]+),\s*([^,]+?)(?:\s*\([^)]*\))?\s*(?:Direct3D|OpenGL|Vulkan)/.exec(raw);
    if (angle) return angle[2].trim();
    return String(raw).slice(0, 44);
  }

  /* ---- Integrated window chrome --------------------------------------- *
   *
   * The top bar is the window's title bar. The minimise / maximise / close
   * buttons are the real native ones, drawn by the compositor over the right
   * of that bar, so this only has to keep our own controls out from under
   * them. Chromium reports where they are through the Window Controls Overlay
   * API and fires `geometrychange` when they move — an event, not a poll.
   * ------------------------------------------------------------------ */

  const TITLEBAR_FALLBACK_INSET = 148;

  function applyWindowChrome() {
    const platform = state.info && state.info.platform;
    // macOS keeps its traffic lights at the left, so the brand is inset there
    // instead. Nothing else about the bar changes.
    document.body.classList.toggle('is-mac', platform === 'darwin');
    if (platform === 'darwin') return;

    // The stylesheet takes the inset from the titlebar-area environment
    // variables, which Chromium keeps current on its own. This only has to
    // notice the case where the overlay exists and those are not available,
    // and reserve the buttons' usual width so nothing ends up underneath one.
    if (!navigator.windowControlsOverlay) {
      document.body.classList.add('no-titlebar-metrics');
      document.documentElement.style.setProperty(
        '--titlebar-inset', `${TITLEBAR_FALLBACK_INSET}px`);
    }
  }

  /** Everything Watch paints from player and engine state. */
  function refreshWatchSurfaces() {
    refreshWatchSource();
    refreshSourceDetails();
    refreshProcessStrip();
    refreshFineTuneContext();
  }

  /* ------------------------------------------------------------------ *
   * Settings modal
   * ------------------------------------------------------------------ */

  function openSettings() {
    refreshSemanticStatus();
    el.settingsModal.hidden = false;
    refreshDependencyStatus();
    refreshEngines();
    refreshRuntimeStatus();
    refreshThumbCacheStatus();
    // The Diagnostics section hosts a telemetry view; it only samples while it
    // is the visible section, which this re-evaluates.
    telemetry.refreshVisibility();
  }

  function closeSettings() {
    el.settingsModal.hidden = true;
    telemetry.refreshVisibility();
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
      setDot(el.ytdlpDot, yt.stale ? 'warn' : 'ok');
    } else {
      el.ytdlpStatus.textContent = 'Not found. Online video playback needs it.';
      el.installYtdlpBtn.textContent = 'Install';
      setDot(el.ytdlpDot, 'warn');
    }

    const ff = res.binaries.ffmpeg;
    el.ffmpegStatus.textContent = ff.path
      ? `Ready — ${(ff.version || '').replace('ffmpeg version ', '').split(' ')[0] || 'ok'}`
      : 'Not found. Exporting is unavailable until ffmpeg is located.';
    setDot(el.ffmpegDot, ff.path ? 'ok' : 'bad');

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
    el.closeSettings.addEventListener('click', closeSettings);
    el.settingsModal.addEventListener('mousedown', (e) => {
      if (e.target === el.settingsModal) closeSettings();
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

  /* ------------------------------------------------------------------ *
   * Workspaces
   *
   * The four tabs are the application's top-level navigation. Create and
   * Watch keep the player on screen because both are about a picture you are
   * looking at; Queue and Library are documents, so the stage steps aside and
   * they take the window.
   *
   * The media element is never touched here. Playback, the source lifecycle
   * and the presentation mode belong to switchSource() and
   * applyPresentationMode(); a navigation change that could pause a video or
   * re-aim a render would be exactly the coupling this app is built to avoid.
   * ------------------------------------------------------------------ */

  function setWorkspace(name) {
    if (!document.querySelector(`.tab-page[data-page="${name}"]`)) return;
    state.workspace = name;
    document.body.dataset.workspace = name;

    document.querySelectorAll('.tab').forEach((t) => {
      const active = t.dataset.tab === name;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.tab-page').forEach((p) => {
      p.classList.toggle('active', p.dataset.page === name);
    });

    /*
     * Which of the shell's tracks this workspace wants.
     *
     * Create is the full workstation: source column, viewer, console,
     * inspector. Watch is player-first but not bare — it takes the strip and
     * the console too, because both describe the thing Watch owns. What Watch
     * does not take is the performance bay: the stylesheet drops that one, and
     * that is load-bearing rather than cosmetic, because the telemetry
     * controller subscribes on a view being on screen and a perf bay in Watch
     * would mean nvidia-smi running every two seconds for anyone just watching
     * a video. Queue and Library are documents and take the window.
     */
    el.sourceColumn.hidden = name !== 'create';
    el.utilityStrip.hidden = !(name === 'create' || name === 'presets');
    // The strip reads the *player*. In Watch that is the source it names; in
    // Create the player is still Watch's video rather than the file being
    // rendered, so saying "Source" there would name the wrong one.
    el.processStrip.hidden = name !== 'presets';

    if (name === 'create' || name === 'presets') refreshUtilityStrip();
    if (name === 'create') refreshCreateHome();
    createPreview.onWorkspaceChange(name);
    if (name === 'presets') refreshWatchSurfaces();
    if (name === 'library') refreshLibrarySummary();
    if (name === 'queue') refreshQueueSide();

    // Telemetry samples only while a view is genuinely on screen.
    telemetry.refreshVisibility();
    // The canvas size follows the stage, which just changed.
    requestAnimationFrame(positionSplitHandle);
  }

  /* ------------------------------------------------------------------ *
   * Player settings popover
   *
   * Speed and loop are real controls living inside the popover, not mirrors
   * of controls kept elsewhere, so there is one source of truth for each. The
   * stream rows are read-only facts about what is actually playing.
   * ------------------------------------------------------------------ */

  function bindPlayerSettings() {
    el.playerSettingsBtn.addEventListener('click', () => {
      if (togglePopover(el.playerPopover, el.playerSettingsBtn)) refreshPlayerPopover();
    });

    el.loopToggle.addEventListener('change', () => {
      el.video.loop = el.loopToggle.checked;
      el.audio.loop = el.loopToggle.checked;
    });

    el.popoverStats.addEventListener('click', () => {
      el.statsBtn.click();
      refreshPlayerPopover();
    });

    el.popoverInfo.addEventListener('click', () => {
      closePopover();
      el.infoModal.hidden = false;
    });
  }

  /** Only refreshed when the popover is opened, never on a timer. */
  function refreshPlayerPopover() {
    const media = state.media;
    el.popoverQuality.textContent = media
      ? (media.selectedQuality || (media.kind === 'local' ? 'Local file' : '—'))
      : '—';
    const v = el.video;
    el.popoverSource.textContent = v.videoWidth
      ? `${v.videoWidth}×${v.videoHeight}`
      : '—';
    el.popoverStatsState.textContent = el.statsOverlay.hidden ? 'Off' : 'On';
    el.speedSelect.value = String(el.video.playbackRate || 1);
    el.loopToggle.checked = !!el.video.loop;
  }

  /**
   * Create's preview transport.
   *
   * Wired only to Create's own element. Nothing here can reach Watch's media
   * state, which is what keeps the two workspaces independent by construction
   * rather than by discipline.
   */
  function bindCreatePreview() {
    const v = el.createVideo;

    el.createPlayBtn.addEventListener('click', () => createPreview.toggle());
    el.createVideo.addEventListener('click', () => createPreview.toggle());

    el.createMuteBtn.addEventListener('click', () => {
      const target = el.createAudio.getAttribute('src') && !el.createAudio.error
        ? el.createAudio : v;
      target.muted = !target.muted;
      updateCreateMuteIcon();
    });
    el.createVolume.addEventListener('input', () => {
      const vol = parseFloat(el.createVolume.value);
      const target = el.createAudio.getAttribute('src') && !el.createAudio.error
        ? el.createAudio : v;
      target.volume = vol;
      target.muted = vol === 0;
      updateCreateMuteIcon();
    });

    el.createFullscreenBtn.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else v.requestFullscreen().catch(() => {});
    });

    const seekFromEvent = (e) => {
      const rect = el.createScrub.getBoundingClientRect();
      if (!rect.width) return;
      const p = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const d = v.duration;
      if (Number.isFinite(d) && d > 0) createPreview.seek(p * d);
    };
    el.createScrub.addEventListener('mousedown', (e) => {
      seekFromEvent(e);
      const move = (ev) => seekFromEvent(ev);
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });

    for (const event of ['timeupdate', 'progress', 'durationchange', 'loadedmetadata']) {
      v.addEventListener(event, updateCreateTime);
    }
    v.addEventListener('play', () => { el.createPlayBtn.innerHTML = ICONS.pause; });
    v.addEventListener('pause', () => {
      el.createPlayBtn.innerHTML = ICONS.play;
      try { el.createAudio.pause(); } catch { /* not loaded */ }
    });
    v.addEventListener('seeking', () => {
      if (el.createAudio.getAttribute('src') && !el.createAudio.error) {
        el.createAudio.currentTime = v.currentTime;
      }
    });
    // A preview that cannot decode says why, rather than leaving a black box.
    v.addEventListener('error', () => {
      const code = v.error && v.error.code;
      createPreview.setStatus({
        error: MEDIA_ERRORS[code] || 'This source could not be decoded for preview.',
        tag: 'Unavailable'
      });
    });
    el.createAudio.addEventListener('error', () => createPreview.recoverFromAudioFailure());

    el.createEmptyOpenBtn.addEventListener('click', createOpenFile);
    el.createEmptyWatchBtn.addEventListener('click', createUseWatchSource);
  }

  function updateCreateTime() {
    const v = el.createVideo;
    const d = Number.isFinite(v.duration) ? v.duration : 0;
    el.createTimeLabel.textContent = `${fmtTime(v.currentTime)} / ${fmtTime(d)}`;
    const pct = d > 0 ? (v.currentTime / d) * 100 : 0;
    el.createScrubPlayed.style.width = `${pct}%`;
    el.createScrubKnob.style.left = `${pct}%`;
    if (v.buffered.length) {
      const end = v.buffered.end(v.buffered.length - 1);
      el.createScrubBuffered.style.width = `${d > 0 ? (end / d) * 100 : 0}%`;
    }
  }

  function updateCreateMuteIcon() {
    const target = el.createAudio.getAttribute('src') && !el.createAudio.error
      ? el.createAudio : el.createVideo;
    el.createMuteBtn.innerHTML = target.muted || target.volume === 0
      ? ICONS.mute : ICONS.volume;
    el.createVolume.value = String(target.muted ? 0 : target.volume);
  }

  function bindConsole() {
    for (const tab of el.consoleTabs.querySelectorAll('.bay-tab')) {
      tab.addEventListener('click', () => {
        state.consoleTab = tab.dataset.console;
        for (const other of el.consoleTabs.querySelectorAll('.bay-tab')) {
          const active = other === tab;
          other.classList.toggle('active', active);
          other.setAttribute('aria-selected', active ? 'true' : 'false');
        }
        refreshUtilityStrip();
      });
    }
  }

  function bindGlobal() {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => setWorkspace(tab.dataset.tab));
    });

    // Settings section rail.
    el.settingsNav.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => {
        el.settingsNav.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        button.classList.add('active');
        document.querySelectorAll('[data-settings-page]').forEach((page) => {
          page.hidden = page.dataset.settingsPage !== button.dataset.settings;
        });
        telemetry.refreshVisibility();
      });
    });

    el.clearThumbsBtn.addEventListener('click', async () => {
      const r = await api.thumbnails.clear();
      if (!r.ok) return reportFailure(r);
      thumbs.reset();
      refreshThumbCacheStatus();
      renderJobs();
      const recents = await api.recents.get();
      if (recents.ok) renderRecents(recents.recents);
      toast(`Thumbnail cache cleared (${r.removed} file${r.removed === 1 ? '' : 's'}).`, 'ok');
    });

    el.jobStrip.addEventListener('click', () => setWorkspace('queue'));

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

    // One control, one writer. The Adjust workspace used to carry a second,
    // segmented view of this same value; with both panels merged into Watch a
    // duplicate would just be two controls to keep in step.
    el.watchQuality.addEventListener('change', () => setWatchQuality(el.watchQuality.value));
    el.adjustToCreateBtn.addEventListener('click', sendToCreate);

    el.scaleSelect.addEventListener('change', () => {
      const value = el.scaleSelect.value;
      state.engine && state.engine.setRenderScaleCap(value === 'auto' ? 'auto' : Number(value));
      api.settings.patch({ renderScale: value });
      updateResBadge();
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
    el.createPlatform.addEventListener('change', () => {
      syncPlatformUi({ seedGeometry: true });
      markRecipeModified();
      schedulePreview();
    });
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

    // Create's own source actions. None of them touch the video element.
    el.createOpenFileBtn.addEventListener('click', createOpenFile);
    el.createUseWatchBtn.addEventListener('click', createUseWatchSource);
    el.createUrlBtn.addEventListener('click', createOpenUrl);
    el.createUrlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') createOpenUrl();
    });

    for (const control of [el.createAi, el.createAiModel, el.createAiQuality, el.createInterp,
      el.createRes, el.createAspect, el.createFps, el.createFraming, el.createAudio,
      el.createLoudness, el.createQuality]) {
      control.addEventListener('change', markRecipeModified);
    }
    // Every control that a section summary or the render summary reports on.
    for (const control of [el.createAudio, el.createLoudness, el.createUseLook,
      el.createFps, el.createInterp, el.createFraming, el.createPlatform,
      el.createAi, el.createAiQuality, el.createAspect, el.createRes]) {
      control.addEventListener('change', refreshGroupTags);
    }
    // Geometry controls reflect into each other, then re-price the job.
    for (const control of [el.createAspect, el.createRes]) {
      control.addEventListener('change', () => { syncGeometryUi(); schedulePreview(); });
    }
    for (const input of [el.createAspectW, el.createAspectH, el.createResW, el.createResH]) {
      input.addEventListener('input', () => {
        markRecipeModified();
        syncGeometryUi();
        schedulePreview();
      });
    }
    for (const control of [el.createAi, el.createAiModel, el.createAiQuality, el.createInterp,
      el.createFps, el.createFraming]) {
      control.addEventListener('change', () => { syncAiUi(); schedulePreview(); });
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
        if (e.key === 'Escape') { closeSettings(); el.infoModal.hidden = true; }
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
        // The URL box lives in Watch's source module now, so Ctrl+L goes there
        // rather than focusing a control on a workspace you cannot see.
        'open-url': () => { setWorkspace('presets'); el.urlInput.focus(); },
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
    bindSemantic();
    bindPlayerSettings();
    bindGlobal();
    bindConsole();
    bindCreatePreview();
    // The preview's session is Create's to release. Watch's own teardown does
    // not know about it, and an abandoned session would sit in the registry
    // until it expired.
    window.addEventListener('beforeunload', () => createPreview.releaseSession());
    bindIdle();
    applyWindowChrome();

    // One telemetry controller, two views. Neither samples unless it is on
    // screen and the window is visible.
    telemetry.attach(el.utilityTelemetry, { compact: true });
    telemetry.attach(el.settingsTelemetry, { compact: false });

    refreshStatusBar();
    refreshWatchSource();
    renderRecents(recentsRes.ok ? recentsRes.recents : []);
    populateEncoders();
    await populatePlatforms();
    refreshCreateSource();
    bindEngineEvents();
    await populateAuto();
    refreshSavedRecipes();
    refreshEngines();
    refreshRuntimeStatus();
    refreshSemanticStatus();
    refreshDependencyStatus().then(() => {
      if (state.info && !state.info.binaries.ytdlp.path) {
        toast('Install yt-dlp in Settings to play online video links.', 'warn', 8000);
      }
    });

    const jobsRes = await api.jobs.list();
    if (jobsRes.ok) jobsRes.jobs.forEach((j) => state.jobs.set(j.id, j));
    renderJobs();

    /*
     * The opening workspace, chosen once and by one function.
     *
     * Boot used to leave this to the markup: the body carried a workspace
     * attribute and one tab carried `.active`, but nothing gave any
     * `.tab-page` its `.active` class and nothing cleared the `hidden`
     * attribute on the source column, the process strip or the console. So a
     * fresh launch showed a player with an empty inspector and no strip, and
     * the app only became whole when the user clicked a tab — because
     * `setWorkspace()` is what actually reconciles all of it, and until then
     * it had never run.
     *
     * Calling it here makes it the single authority: the static attributes are
     * now only a first-paint hint, and every workspace is fully rendered the
     * first time it is shown whether or not another was visited first. It runs
     * after the data above so the workspace it opens has something to paint.
     */
    setWorkspace('create');

    const interrupted = [...state.jobs.values()].filter((j) => j.status === 'interrupted');
    if (interrupted.length) {
      toast(
        `${interrupted.length} render${interrupted.length === 1 ? '' : 's'} stopped when Visionance last closed. Resume them in the Queue tab.`,
        'warn', 9000
      );
    }

    // Housekeeping, deliberately slow: persist the active preset so the next
    // launch feels continuous, and refresh the two derived readouts that no
    // event covers. Three seconds, not per frame - the picture is drawn by the
    // engine, and the UI has no business running at its cadence.
    setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (state.presetId !== '__custom' && state.settings.lastPresetId !== state.presetId) {
        state.settings.lastPresetId = state.presetId;
        api.settings.patch({ lastPresetId: state.presetId });
      }
      updateResBadge();
      refreshStatusBar();
      if (state.workspace === 'presets') refreshWatchSurfaces();
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
