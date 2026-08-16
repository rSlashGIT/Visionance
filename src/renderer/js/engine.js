/**
 * WebGL2 rendering engine.
 *
 * Owns the GL context, the shader programs, the ping-pong framebuffers and the
 * frame loop. It is deliberately decoupled from the UI: give it a <video> and a
 * parameter object and it draws enhanced frames into its canvas.
 */

(function () {
  'use strict';

  const S = window.VSShaders;

  const QUAD = new Float32Array([-1, -1, 3, -1, -1, 3]); // full-screen triangle

  /** Texture unit reserved for allocations, never sampled by a shader. */
  const SCRATCH_UNIT = 7;

  class Pass {
    constructor(gl, fragSrc, name) {
      this.gl = gl;
      this.name = name;
      this.program = createProgram(gl, S.VERT_QUAD, fragSrc, name);
      this.uniforms = new Map();
      const count = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < count; i++) {
        const info = gl.getActiveUniform(this.program, i);
        if (!info) continue;
        const cleanName = info.name.replace(/\[0\]$/, '');
        this.uniforms.set(cleanName, gl.getUniformLocation(this.program, info.name));
      }
    }

    use() {
      this.gl.useProgram(this.program);
      return this;
    }

    loc(name) {
      return this.uniforms.get(name) || null;
    }

    f(name, value) {
      const l = this.loc(name);
      if (l) this.gl.uniform1f(l, value);
      return this;
    }

    i(name, value) {
      const l = this.loc(name);
      if (l) this.gl.uniform1i(l, value);
      return this;
    }

    v2(name, x, y) {
      const l = this.loc(name);
      if (l) this.gl.uniform2f(l, x, y);
      return this;
    }
  }

  function compile(gl, type, src, name) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`[${name}] shader compile failed: ${log}`);
    }
    return sh;
  }

  function createProgram(gl, vsSrc, fsSrc, name) {
    const vs = compile(gl, gl.VERTEX_SHADER, vsSrc, name + ':vert');
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc, name + ':frag');
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error(`[${name}] program link failed: ${log}`);
    }
    return prog;
  }

  class RenderTarget {
    constructor(gl, internalFormat, type) {
      this.gl = gl;
      this.internalFormat = internalFormat;
      this.type = type;
      this.width = 0;
      this.height = 0;
      this.texture = gl.createTexture();
      this.fbo = gl.createFramebuffer();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    resize(w, h) {
      w = Math.max(1, Math.floor(w));
      h = Math.max(1, Math.floor(h));
      if (w === this.width && h === this.height) return;
      const gl = this.gl;
      this.width = w;
      this.height = h;
      // Reallocate on a scratch texture unit. Using unit 0 here would replace
      // the source texture a pass has just bound and create a framebuffer
      // feedback loop the moment we draw into this target.
      gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, this.internalFormat, w, h, 0, gl.RGBA, this.type, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
    }

    dispose() {
      const gl = this.gl;
      gl.deleteTexture(this.texture);
      gl.deleteFramebuffer(this.fbo);
    }
  }

  const DEFAULT_PARAMS = {
    enabled: true,
    denoise: 0,
    deblock: 0,
    edge: 0.5,
    line: 0,
    sharpen: 0.35,
    haloGuard: 0.8,
    deband: 0.25,
    localContrast: 0.15,
    contrast: 0.06,
    brightness: 0,
    saturation: 0.08,
    vibrance: 0.1,
    gamma: 0,
    temperature: 0,
    tint: 0,
    blackLevel: 0.05,
    highlightRolloff: 0.25,
    bloom: 0,
    grain: 0,
    vignette: 0,
    scaleFactor: 2
  };

  class Engine {
    /**
     * @param {HTMLCanvasElement} canvas
     */
    constructor(canvas) {
      this.canvas = canvas;
      this.params = { ...DEFAULT_PARAMS };
      this.video = null;
      this.compareMode = 0; // 0 off, 1 split, 2 original
      this.splitX = 0.5;
      this.running = false;
      this.renderScaleCap = 'auto';
      this.adaptive = true;
      this.targetFps = 60;
      this.onError = null;

      /**
       * Watch quality policy. This only ever affects realtime enhancement -
       * Create's offline neural quality is a completely separate setting.
       */
      this.policy = 'auto';

      /*
       * Three clocks, never conflated.
       *
       *   media        what the decoder produced        (sourceFps, mediaVsWall)
       *   enhancement  what we drew and what it cost    (enhancedFps, gpuMs, misses)
       *   display      what the compositor refreshes at (presentedFps upstream)
       *
       * The old stats block mixed the first two and read the third from a
       * counter that does not describe it - see `_sampleDropRate()`.
       */
      this.stats = {
        fps: 0,
        /** CPU time spent *submitting* the frame. Not the cost of drawing it. */
        cpuMs: 0,
        /** Real GPU time per frame, where the driver exposes timer queries. */
        gpuMs: 0,
        gpuTimingAvailable: false,
        outputW: 0,
        outputH: 0,
        sourceW: 0,
        sourceH: 0,
        droppedScale: 1,
        gpu: 'unknown',
        /** Measured presentation cadence of the *media*, not of our renders. */
        sourceFps: 0,
        /** Enhanced frames we actually put on the canvas, per second. */
        enhancedFps: 0,
        frameBudgetMs: 0,
        /** Frames we chose not to enhance because they were already stale. */
        skipped: 0,
        /** Share of source frames that never became an enhanced frame. */
        missRate: 0,
        /** Media frames the compositor presented, per stats window. */
        framesOffered: 0,
        /** Enhanced frames we actually committed, per stats window. */
        framesPresented: 0,
        /** Replaced by a newer frame before ever being drawn. */
        superseded: 0,
        /** Missed because a draw was still running: genuine compute pressure. */
        computeMisses: 0,
        /** Missed for any other reason: scheduling, coalesced callbacks. */
        presentationMisses: 0,
        /** New frames found from the media clock when no callback arrived. */
        lateDetected: 0,
        /**
         * Media time advanced per second of wall clock. 1.0 means playback is
         * keeping real time, which is the contract. Immune to how the media
         * element is composited, unlike the decoder's dropped-frame counter.
         */
        mediaVsWall: 1,
        /** Decoder drops. Only meaningful while the element is on screen. */
        decoderDropRate: 0,
        decoderDropTrusted: false,
        scheduler: 'frame-gated',
        limited: false,
        policy: 'auto'
      };

      this._frameTimes = [];
      this._gpuTimes = [];
      this._lastStatsAt = performance.now();
      this._framesSinceStats = 0;
      this._qualityScale = 1;
      this._rvfcHandle = null;
      this._rafHandle = null;
      this._idleHandle = null;
      this._presentLoop = null;
      this._videoListeners = [];
      this._needsDraw = true;
      /** A new source frame is waiting to be drawn on the next refresh. */
      this._pendingFrame = false;
      /** Source frames signalled since the last stats tick. */
      this._sourceFrames = 0;
      /** Compositor's own frame counter, for counting media frames honestly. */
      this._lastPresentedFrames = null;
      /** Media time of the last frame we actually drew. */
      this._lastDrawnMediaTime = null;
      /** `expectedDisplayTime` of the frame waiting to be shown. */
      this._pendingDisplayTime = 0;
      /** Frames replaced by a newer one before they were ever drawn. */
      this._supersededSinceStats = 0;
      /** New frames found from the media clock because no callback arrived. */
      this._lateDetectedSinceStats = 0;
      /** Rolling display refresh interval, learned from rAF timestamps. */
      this._refreshMs = 0;
      this._lastRafAt = 0;
      /** Media/wall-clock tracking, the cadence contract's own measurement. */
      this._clockMark = null;

      // Frame pacing state.
      this._lastFrameAt = 0;
      this._frameIntervals = [];
      this._measuredIntervalMs = 0;
      this._rateWindow = [];
      this._drawing = false;
      this._skippedSinceStats = 0;
      // Governor smoothing: a single slow frame must not drop quality, and a
      // single fast one must not raise it. Both directions need sustained
      // evidence, otherwise the picture visibly pulses.
      this._pressure = 0;
      this._overloadStreak = 0;
      this._lastQuality = null;
      /** Called when enhancement cannot be sustained; see _adapt(). */
      this.onOverload = null;

      this._initGL();
    }

    _initGL() {
      const attrs = {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
        desynchronized: true
      };
      const gl = this.canvas.getContext('webgl2', attrs);
      if (!gl) throw new Error('WebGL2 is not available on this system.');
      this.gl = gl;

      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        this.stats.gpu = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || 'unknown';
      }

      // Half-float intermediates keep the grading maths clean; fall back to 8bpc.
      const hasHalfFloat = !!gl.getExtension('EXT_color_buffer_half_float') ||
        !!gl.getExtension('EXT_color_buffer_float');
      this.internalFormat = hasHalfFloat ? gl.RGBA16F : gl.RGBA8;
      this.textureType = hasHalfFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
      this.precision = hasHalfFloat ? '16-bit float' : '8-bit';

      this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

      /*
       * Real GPU time per frame.
       *
       * A `performance.now()` bracket around the draw calls measures how long
       * it took to *queue* them, not how long the GPU spent. Measured on the
       * reference laptop the two differ by more than twenty times: the bracket
       * reads 0.9 ms while the chain actually costs 20.2 ms of a 41.7 ms
       * budget. A governor fed the first number believes it has forty times
       * the headroom it has, which is precisely what it did.
       *
       * Queries are read back a frame later so nothing ever blocks on the GPU;
       * where the extension is missing the governor falls back to the cadence
       * signals, which need no driver support.
       */
      this._timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      this._pendingQueries = [];
      this.stats.gpuTimingAvailable = !!this._timerExt;

      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      this.vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);

      this.passes = {
        restore: new Pass(gl, S.FRAG_RESTORE, 'restore'),
        upscale: new Pass(gl, S.FRAG_UPSCALE, 'upscale'),
        sharpen: new Pass(gl, S.FRAG_SHARPEN, 'sharpen'),
        grade: new Pass(gl, S.FRAG_GRADE, 'grade')
      };

      this.videoTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

      this.rtA = new RenderTarget(gl, this.internalFormat, this.textureType);
      this.rtB = new RenderTarget(gl, this.internalFormat, this.textureType);
      this.rtC = new RenderTarget(gl, this.internalFormat, this.textureType);

      this.canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.stop();
        if (this.onError) this.onError(new Error('The GPU context was lost. Reloading the view will restore it.'));
      });
    }

    /**
     * Forget everything learned about the previous source's cadence.
     *
     * A 24 fps film followed by a 60 fps clip must not be judged against the
     * film's 41.7 ms budget for the first second, and vice versa.
     */
    resetPacing() {
      this._lastFrameAt = 0;
      this._frameIntervals = [];
      this._measuredIntervalMs = 0;
      this._rateWindow = [];
      this._lastPresentedFrames = null;
      this._lastDrawnMediaTime = null;
      this._pendingDisplayTime = 0;
    }

    setVideo(videoEl) {
      this._unbindVideo();
      this.video = videoEl;
      this._videoTextureSize = null;
      this._needsDraw = true;
      this._bindVideo();
      this._restartFrameSource();
    }

    _bindVideo() {
      const v = this.video;
      if (!v || !v.addEventListener) return;
      const wake = () => this._wakePresentation();
      // A paused engine draws on demand; these are the moments the picture
      // starts moving again and the presentation clock has to come back.
      const once = () => { this._needsDraw = true; this._scheduleIdleDraw(); };
      for (const [event, fn] of [
        ['play', wake], ['playing', wake], ['seeking', once], ['seeked', once],
        ['loadeddata', once], ['ratechange', wake]
      ]) {
        v.addEventListener(event, fn);
        this._videoListeners.push([event, fn]);
      }
    }

    _unbindVideo() {
      const v = this.video;
      if (v && v.removeEventListener) {
        for (const [event, fn] of this._videoListeners) v.removeEventListener(event, fn);
      }
      this._videoListeners = [];
    }

    /**
     * Mark the canvas stale and make sure something will redraw it.
     *
     * While playing, the presentation loop handles it on the next refresh.
     * While paused there is no loop - by design - so one callback is scheduled.
     */
    _invalidate() {
      this._needsDraw = true;
      this._scheduleIdleDraw();
    }

    setParams(patch) {
      Object.assign(this.params, patch || {});
      this._invalidate();
    }

    getParams() {
      return { ...this.params };
    }

    setCompare(mode, splitX) {
      this.compareMode = mode | 0;
      if (typeof splitX === 'number') this.splitX = Math.min(1, Math.max(0, splitX));
      this._invalidate();
    }

    setRenderScaleCap(cap) {
      this.renderScaleCap = cap;
      // Start from full quality: a throttle earned at the previous resolution
      // says nothing about the new one, and inheriting it makes the setting
      // look like it did nothing.
      this._qualityScale = 1;
      this.stats.limited = false;
      this._invalidate();
    }

    setAdaptive(enabled) {
      this.adaptive = !!enabled;
      if (!enabled) {
        this._qualityScale = 1;
        this.stats.limited = false;
      }
      this._invalidate();
    }

    start() {
      if (this.running) return;
      this.running = true;
      this._restartFrameSource();
    }

    stop() {
      this.running = false;
      this._cancelFrameSource();
      if (this._idleHandle) cancelAnimationFrame(this._idleHandle);
      this._idleHandle = null;
      this._presentLoop = null;
      this._pendingFrame = false;
    }

    /**
     * Two clocks, each doing the job it is good at.
     *
     * `requestVideoFrameCallback` answers *what* to draw: it fires once per
     * decoded frame, so a 24 fps film costs 24 draws per second and never 60.
     * It does no work itself - it raises a flag.
     *
     * `requestAnimationFrame` answers *when* to draw. The media's cadence has
     * no relationship to the display's refresh, so committing the canvas from
     * inside the video callback lands the new pixels at an arbitrary phase in
     * the refresh interval; the compositor then shows some frames for two
     * refreshes and some for four, irregularly. Measured on the reference
     * laptop with a 23.976 fps source on a 60 Hz panel, drawing inside rvfc put
     * 18.6% of frames outside the legal {2,3} refresh pattern against 12.4%
     * when the same draws were committed on a refresh boundary. Same draw
     * count, same source cadence, less judder.
     *
     * The expensive work is still gated on a genuinely new source frame, so
     * this is not an ambient 60 fps render loop: with no new frame the callback
     * returns immediately having touched nothing.
     *
     * Without rvfc there is no way to know when a frame is new, so the fallback
     * draws every refresh and says so in the stats.
     */
    _restartFrameSource() {
      if (!this.running) return;
      this._cancelFrameSource();

      const useRvfc = this.video && typeof this.video.requestVideoFrameCallback === 'function';
      this.stats.scheduler = useRvfc ? 'frame-gated' : 'refresh';

      if (!useRvfc) {
        const loop = () => {
          if (!this.running) return;
          this._rafHandle = requestAnimationFrame(loop);
          this._sourceFrames++;
          this._drawSafe();
        };
        this._rafHandle = requestAnimationFrame(loop);
        return;
      }

      const mark = (now, meta) => {
        if (!this.running) return;
        // Re-arm first: if the draw overruns, the callback for the frame we
        // missed is already registered and we resume on the newest frame
        // rather than working through a backlog.
        this._rvfcHandle = this.video.requestVideoFrameCallback(mark);
        this._notePresentation(now, meta);

        /*
         * Count media frames, not callbacks.
         *
         * `requestVideoFrameCallback` is not guaranteed to fire once per
         * presented frame - the browser coalesces callbacks precisely when the
         * page is busy, which is exactly when enhancement is running. Counting
         * invocations therefore under-counts the media, and because the engine
         * drew one frame per invocation the *draw* rate inherited that
         * under-count: measured in the real app, media presented 22.7 fps while
         * the enhanced canvas advanced at 14.5 fps and the miss rate read 0%,
         * because we had faithfully drawn one frame for every callback we
         * received. The denominator was wrong, so the shortfall was invisible.
         *
         * `presentedFrames` is the compositor's own running total and is
         * exposed by the spec for this reason.
         */
        if (meta && Number.isFinite(meta.presentedFrames)) {
          const prev = this._lastPresentedFrames;
          if (prev !== null && meta.presentedFrames > prev) {
            this._sourceFrames += Math.min(10, meta.presentedFrames - prev);
          } else if (prev === null) {
            this._sourceFrames++;
          }
          this._lastPresentedFrames = meta.presentedFrames;
        } else {
          this._sourceFrames++;
        }

        // A frame still waiting when the next one arrives was never shown.
        if (this._pendingFrame) this._supersededSinceStats++;
        this._pendingFrame = true;
        this._pendingDisplayTime = meta && Number.isFinite(meta.expectedDisplayTime)
          ? meta.expectedDisplayTime
          : 0;
      };
      this._rvfcHandle = this.video.requestVideoFrameCallback(mark);

      /*
       * The presentation loop exists only while the picture is moving.
       *
       * Leaving it armed over a paused video would be a 60 Hz callback for a
       * source that is not producing frames - the ambient render loop this
       * project does not allow. It stops itself when playback stops and the
       * media's own `play` event brings it back; a paused redraw goes through
       * `_scheduleIdleDraw()` instead, which fires once.
       */
      const present = (now) => {
        if (!this.running) return;
        if (this.video && this.video.paused) {
          this._rafHandle = null;
          if (this._needsDraw) this._drawSafe();
          return;
        }
        this._rafHandle = requestAnimationFrame(present);

        /*
         * Is there a new media frame to show?
         *
         * The video callback is the primary signal, but it is not a reliable
         * *count* - see `mark()`. When the browser coalesces callbacks, relying
         * on them alone means a genuinely new frame sits on screen unrefreshed
         * until the next callback happens to arrive. So the media element's own
         * clock is the second opinion: if `currentTime` has advanced by a frame
         * interval since the last thing we drew, there is new picture to show
         * whether or not a callback told us.
         *
         * This is still strictly per-media-frame work. With the media paused or
         * stalled neither condition fires and nothing expensive happens, which
         * is what keeps this from becoming an ambient 60 Hz enhancement loop.
         */
        const v = this.video;
        let fresh = this._pendingFrame;
        if (!fresh && v && Number.isFinite(v.currentTime) && this._lastDrawnMediaTime !== null) {
          const interval = this.frameBudgetMs() / 1000;
          if (v.currentTime - this._lastDrawnMediaTime >= interval * 0.9) {
            fresh = true;
            this._lateDetectedSinceStats++;
          }
        }
        if (!fresh && !this._needsDraw) return;

        /*
         * Hold a frame that is not due yet.
         *
         * `expectedDisplayTime` is the timestamp the compositor intends to show
         * this frame at. Committing it a refresh early is what produced the
         * irregular 1-and-4 refresh gaps measured earlier; waiting for the
         * refresh it belongs to keeps the 3,2 pattern a 23.976 fps source needs
         * on a 60 Hz panel. Only ever a *hold*, never a sleep or a spin - the
         * next rAF is already scheduled.
         */
        if (fresh && this._pendingDisplayTime && Number.isFinite(now)) {
          const refresh = this._refreshIntervalMs(now);
          if (this._pendingDisplayTime - now > refresh * 1.5) return;
        }

        this._pendingFrame = false;
        this._pendingDisplayTime = 0;
        if (v && Number.isFinite(v.currentTime)) this._lastDrawnMediaTime = v.currentTime;
        this._drawSafe();
      };
      this._presentLoop = present;
      if (!this.video.paused) this._rafHandle = requestAnimationFrame(present);
    }

    /**
     * The display's refresh interval, learned rather than assumed.
     *
     * 60 Hz is the common case and not the only one; a 120 Hz panel would make
     * a fixed 16.7 ms hold window nearly two refreshes long.
     */
    _refreshIntervalMs(now) {
      if (Number.isFinite(now) && this._lastRafAt) {
        const gap = now - this._lastRafAt;
        if (gap > 1 && gap < 100) {
          this._refreshMs = this._refreshMs ? this._refreshMs * 0.9 + gap * 0.1 : gap;
        }
      }
      if (Number.isFinite(now)) this._lastRafAt = now;
      return this._refreshMs || 16.7;
    }

    /** Restart the presentation loop when the media starts moving again. */
    _wakePresentation() {
      if (!this.running || this._rafHandle || !this._presentLoop) return;
      if (this.video && this.video.paused) return;
      this._rafHandle = requestAnimationFrame(this._presentLoop);
    }

    _cancelFrameSource() {
      if (this._rafHandle) cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
      if (this._rvfcHandle && this.video && this.video.cancelVideoFrameCallback) {
        try { this.video.cancelVideoFrameCallback(this._rvfcHandle); } catch { /* ignore */ }
      }
      this._rvfcHandle = null;
    }

    /**
     * Redraw once, outside playback.
     *
     * A parameter change while paused, a seek, a resize. The engine used to
     * keep a permanent 60 Hz rAF alive for this and check a flag inside it,
     * which is a render loop running for a source that is not moving. One
     * scheduled callback does the same job and then stops.
     */
    _scheduleIdleDraw() {
      if (!this.running || this._idleHandle) return;
      this._idleHandle = requestAnimationFrame(() => {
        this._idleHandle = null;
        if (!this.running) return;
        // While playing, the presentation loop already owns the canvas.
        if (this.video && !this.video.paused && this.stats.scheduler === 'frame-gated') return;
        if (this._needsDraw) this._drawSafe();
      });
    }

    /**
     * Learn the media's real presentation cadence.
     *
     * The enhancement budget has to come from the source, not from a fixed
     * 60 fps assumption: a 24 fps film gives us ~41.7 ms per frame, and
     * treating that as 16.7 ms makes the governor throw away quality it never
     * needed to.
     */
    _notePresentation(now, meta) {
      const gap = this._lastFrameAt ? now - this._lastFrameAt : 0;

      if (gap > 1 && gap < 500) {
        this._frameIntervals.push(gap);
        if (this._frameIntervals.length > 60) this._frameIntervals.shift();
        const sorted = [...this._frameIntervals].sort((a, b) => a - b);
        // Median: robust against the occasional long frame.
        this._measuredIntervalMs = sorted[Math.floor(sorted.length / 2)];
      }

      // The interval between *callbacks* overstates the frame interval whenever
      // the browser coalesces them - which is exactly what a heavy draw causes.
      // Taking the budget from it would hand the governor more time than the
      // media actually leaves, so where the compositor's own frame counter is
      // available it wins: span of wall clock divided by frames genuinely
      // presented in it.
      if (meta && Number.isFinite(meta.presentedFrames)) {
        if (gap >= 500 || !this._rateWindow) this._rateWindow = [];
        this._rateWindow.push({ at: now, frames: meta.presentedFrames });
        while (this._rateWindow.length > 2 && now - this._rateWindow[0].at > 2000) {
          this._rateWindow.shift();
        }
        const first = this._rateWindow[0];
        const last = this._rateWindow[this._rateWindow.length - 1];
        const frames = last.frames - first.frames;
        const span = last.at - first.at;
        if (frames > 0 && span > 250) this._measuredIntervalMs = span / frames;
      }

      this._lastFrameAt = now;
    }

    /** Milliseconds available per frame, from the media's own cadence. */
    frameBudgetMs() {
      if (this._measuredIntervalMs > 0) return this._measuredIntervalMs;
      const declared = this.video && this.video.__vsSourceFps;
      if (declared > 0) return 1000 / declared;
      return 1000 / Math.max(24, Math.min(120, this.targetFps));
    }

    _drawSafe() {
      // Never queue work behind work. If the previous draw is still running we
      // are already late, and the frame it was drawing is the newest one we
      // have - rendering this one too would only push us further behind.
      if (this._drawing) {
        this._skippedSinceStats++;
        return;
      }
      this._drawing = true;
      try {
        this.draw();
      } catch (err) {
        this.stop();
        if (this.onError) this.onError(err);
        else console.error(err);
      } finally {
        this._drawing = false;
      }
    }

    _computeOutputSize(srcW, srcH) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      // Measure the container, not the canvas: the canvas's own box depends on
      // the size we are about to choose, which would make this self-referential.
      const host = this.canvas.parentElement || this.canvas;
      const rect = host.getBoundingClientRect();
      const displayW = Math.max(320, Math.round(rect.width * dpr));
      const displayH = Math.max(180, Math.round(rect.height * dpr));

      // The factor at which one rendered pixel is one pixel on the panel.
      // Below this the viewer genuinely loses detail; above it we are rendering
      // for a display that cannot show the difference.
      const fitFactor = Math.max(displayW / srcW, displayH / srcH);

      let target;
      if (this.renderScaleCap === 'auto') {
        // Enough pixels to saturate the *viewport*, capped so a 360p clip on a
        // 4K panel does not try to hallucinate 12x detail.
        target = Math.min(Math.max(1, fitFactor), this._maxScaleForPolicy());
      } else {
        target = Number(this.renderScaleCap) || 1;
      }

      /*
       * Both ceilings are applied to the *target* before the quality scale
       * interpolates, not to the result afterwards.
       *
       * Clamping afterwards is what made the lever look connected and behave
       * as though it were not: the ceiling swallowed most of the travel, so
       * moving the scale from 1.0 to 0.5 changed the render by 2%.
       */
      const maxDim = Math.min(this.maxTextureSize, 7680);
      target = Math.min(
        target,
        // No point rendering far above what the panel can show. The 1.35 is the
        // supersampling allowance, and it is the first thing given up.
        Math.min((displayW * 1.35) / srcW, (displayH * 1.35) / srcH),
        Math.min(maxDim / srcW, maxDim / srcH)
      );

      /*
       * A quality scale that can actually change the cost.
       *
       * This used to read `Math.max(1, factor * qualityScale)`, with the
       * ceiling clamp below ending in `Math.max(srcW, ...)`. Between them the
       * output could never fall below the source, so on the reference laptop -
       * a 2560x1350 source in a ~1400px stage - render scales of 1, 1.5 and 2
       * all measured the same 2560x1350 and the same 20 ms. The governor spent
       * the session reporting "45%" while changing nothing at all.
       *
       * So the scale now interpolates between the full-quality target and the
       * size the panel actually shows, and the floor is that display-matched
       * size rather than the source. Rendering above the display is
       * supersampling - real, but the first thing to give up under pressure.
       * Rendering below it is the point where the viewer starts to lose
       * something, and the scale never goes there on its own.
       */
      const displayMatched = Math.min(target, fitFactor);
      const factor = displayMatched + (target - displayMatched) * this._qualityScale;

      const outW = Math.max(16, Math.round(srcW * factor));
      const outH = Math.max(16, Math.round(srcH * factor));
      return { outW, outH };
    }

    /** Upper bound on internal render scale, per Watch quality policy. */
    _maxScaleForPolicy() {
      switch (this.policy) {
        case 'performance': return 1;
        case 'balanced': return 2;
        case 'quality': return 3;
        case 'maximum': return 4;
        default: return 2.5; // auto
      }
    }

    _uploadVideo() {
      const gl = this.gl;
      const v = this.video;
      const w = v.videoWidth;
      const h = v.videoHeight;
      if (!w || !h) return false;

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

      const sizeChanged = !this._videoTextureSize ||
        this._videoTextureSize[0] !== w || this._videoTextureSize[1] !== h;

      if (sizeChanged) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, v);
        this._videoTextureSize = [w, h];
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, v);
      }
      return true;
    }

    _blit(pass, target, width, height) {
      const gl = this.gl;
      if (target) {
        target.resize(width, height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      gl.viewport(0, 0, width, height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      void pass;
    }

    /** Begin a GPU timer for this frame, if the driver offers one. */
    _beginGpuTimer() {
      const ext = this._timerExt;
      if (!ext || this._pendingQueries.length > 3) return null;
      const gl = this.gl;
      const query = gl.createQuery();
      try {
        gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      } catch {
        gl.deleteQuery(query);
        return null;
      }
      return query;
    }

    _endGpuTimer(query) {
      if (!query) return;
      const gl = this.gl;
      try {
        gl.endQuery(this._timerExt.TIME_ELAPSED_EXT);
        this._pendingQueries.push(query);
      } catch {
        gl.deleteQuery(query);
      }
    }

    /** Collect finished timers. Never blocks: unfinished queries simply wait. */
    _collectGpuTimers() {
      const ext = this._timerExt;
      if (!ext || !this._pendingQueries.length) return;
      const gl = this.gl;
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      const keep = [];
      for (const query of this._pendingQueries) {
        let ready = false;
        try {
          ready = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE);
        } catch { ready = true; }
        if (!ready) { keep.push(query); continue; }
        if (!disjoint) {
          try {
            const ns = gl.getQueryParameter(query, gl.QUERY_RESULT);
            if (Number.isFinite(ns) && ns > 0) {
              this._gpuTimes.push(ns / 1e6);
              if (this._gpuTimes.length > 60) this._gpuTimes.shift();
            }
          } catch { /* driver withdrew the result */ }
        }
        gl.deleteQuery(query);
      }
      this._pendingQueries = keep;
    }

    draw() {
      const gl = this.gl;
      const v = this.video;
      if (!v || v.readyState < 2) return;

      this._collectGpuTimers();
      const timer = this._beginGpuTimer();
      const t0 = performance.now();
      const srcW = v.videoWidth;
      const srcH = v.videoHeight;
      if (!srcW || !srcH) return;

      if (!this._uploadVideo()) return;

      const p = this.params;
      const bypass = !p.enabled;
      const { outW, outH } = bypass
        ? { outW: Math.min(srcW, 3840), outH: Math.min(srcH, 2160) }
        : this._computeOutputSize(srcW, srcH);

      if (this.canvas.width !== outW || this.canvas.height !== outH) {
        this.canvas.width = outW;
        this.canvas.height = outH;
      }

      gl.bindVertexArray(this.vao);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);

      // --- Pass 1: restoration (source resolution) --------------------
      let currentTex = this.videoTexture;
      const wantsRestore = !bypass && (p.denoise > 0.002 || p.deblock > 0.002);
      if (wantsRestore) {
        const pass = this.passes.restore.use();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
        pass.i('uTex', 0)
          .v2('uTexel', 1 / srcW, 1 / srcH)
          .f('uDenoise', p.denoise)
          .f('uDeblock', p.deblock);
        this._blit(pass, this.rtA, srcW, srcH);
        currentTex = this.rtA.texture;
      }

      // --- Pass 2: upscale / reconstruction (output resolution) -------
      {
        const pass = this.passes.upscale.use();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, currentTex);
        pass.i('uTex', 0)
          .v2('uSrcSize', srcW, srcH)
          .v2('uSrcTexel', 1 / srcW, 1 / srcH)
          .f('uEdge', bypass ? 0 : p.edge)
          .f('uLine', bypass ? 0 : p.line);
        this._blit(pass, this.rtB, outW, outH);
        currentTex = this.rtB.texture;
      }

      // --- Pass 3: contrast adaptive sharpening ----------------------
      if (!bypass && p.sharpen > 0.002) {
        const pass = this.passes.sharpen.use();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, currentTex);
        pass.i('uTex', 0)
          .v2('uTexel', 1 / outW, 1 / outH)
          .f('uSharpen', p.sharpen)
          .f('uHaloGuard', p.haloGuard);
        this._blit(pass, this.rtC, outW, outH);
        currentTex = this.rtC.texture;
      }

      // --- Pass 4: grade + compare, straight to the canvas -----------
      {
        const pass = this.passes.grade.use();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, currentTex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);

        pass.i('uTex', 0)
          .i('uOrig', 1)
          .v2('uTexel', 1 / outW, 1 / outH)
          .f('uTime', (t0 % 100000) / 1000)
          .f('uDeband', bypass ? 0 : p.deband)
          .f('uLocalContrast', bypass ? 0 : p.localContrast)
          .f('uContrast', bypass ? 0 : p.contrast)
          .f('uBrightness', bypass ? 0 : p.brightness)
          .f('uSaturation', bypass ? 0 : p.saturation)
          .f('uVibrance', bypass ? 0 : p.vibrance)
          .f('uGamma', bypass ? 0 : p.gamma)
          .f('uTemperature', bypass ? 0 : p.temperature)
          .f('uTint', bypass ? 0 : p.tint)
          .f('uBlackLevel', bypass ? 0 : p.blackLevel)
          .f('uHighlightRolloff', bypass ? 0 : p.highlightRolloff)
          .f('uBloom', bypass ? 0 : p.bloom)
          .f('uGrain', bypass ? 0 : p.grain)
          .f('uVignette', bypass ? 0 : p.vignette)
          .i('uCompareMode', bypass ? 2 : this.compareMode)
          .f('uSplitX', this.splitX);

        this._blit(pass, null, outW, outH);
      }

      gl.bindVertexArray(null);
      this._endGpuTimer(timer);
      this._needsDraw = false;

      this._updateStats(t0, srcW, srcH, outW, outH);
    }

    _updateStats(t0, srcW, srcH, outW, outH) {
      const cpuMs = performance.now() - t0;
      this._frameTimes.push(cpuMs);
      if (this._frameTimes.length > 60) this._frameTimes.shift();
      this._framesSinceStats++;

      const now = performance.now();
      const elapsed = now - this._lastStatsAt;
      if (elapsed >= 500) {
        const avg = this._frameTimes.reduce((a, b) => a + b, 0) / this._frameTimes.length;
        const gpuMs = this._medianGpuMs();

        /*
         * Did the media keep real time?
         *
         * This is the cadence contract stated as a number, and it is the one
         * measurement in here that cannot be confused by how the media element
         * is composited: with the element parked off-screen the decoder reports
         * up to 98% "dropped" frames while media time still advances at exactly
         * 1.0x. What the user is promised is that the clock keeps running, and
         * this is that promise, measured.
         */
        const v = this.video;
        let mediaVsWall = 1;
        if (v && !v.paused && Number.isFinite(v.currentTime)) {
          const mark = this._clockMark;
          if (mark && now > mark.at) {
            const wallSec = (now - mark.at) / 1000;
            const mediaSec = (v.currentTime - mark.mediaTime) * (v.playbackRate || 1);
            if (wallSec > 0.25 && mediaSec >= 0) {
              mediaVsWall = Math.max(0, Math.min(2, mediaSec / wallSec / (v.playbackRate || 1)));
            }
          }
          this._clockMark = { at: now, mediaTime: v.currentTime };
        } else {
          this._clockMark = null;
        }

        // Source frames that never became an enhanced frame. Measured from our
        // own counters, so it describes the enhanced picture rather than the
        // hidden element the decoder is accounting for.
        /*
         * Where the missing frames went.
         *
         * `seen` is media frames the compositor actually presented, so the
         * shortfall is real rather than an artefact of how often our callback
         * happened to run. It is split by cause because "0% missed" beside a
         * 22.7 fps source and a 14.5 fps enhanced picture is not an answer:
         *
         *   superseded  a frame was replaced before we drew it (scheduling)
         *   skipped     a draw was already in flight (compute)
         */
        const seen = this._sourceFrames;
        const drawn = this._framesSinceStats;
        const missing = Math.max(0, seen - drawn);
        const missRate = seen > 0 ? Math.min(1, missing / seen) : 0;
        const computeMisses = Math.min(missing, this._skippedSinceStats);
        const presentationMisses = Math.max(0, missing - computeMisses);

        this.stats.fps = Math.round((drawn * 1000) / elapsed);
        this.stats.enhancedFps = Math.round((drawn * 1000) / elapsed * 10) / 10;
        this.stats.cpuMs = Math.round(avg * 100) / 100;
        this.stats.gpuMs = Math.round(gpuMs * 100) / 100;
        this.stats.sourceW = srcW;
        this.stats.sourceH = srcH;
        this.stats.outputW = outW;
        this.stats.outputH = outH;
        this.stats.droppedScale = this._qualityScale;
        this.stats.sourceFps = this._measuredIntervalMs
          ? Math.round((1000 / this._measuredIntervalMs) * 10) / 10
          : 0;
        this.stats.frameBudgetMs = Math.round(this.frameBudgetMs() * 10) / 10;
        this.stats.skipped = this._skippedSinceStats;
        this.stats.missRate = Math.round(missRate * 1000) / 10;
        this.stats.framesOffered = seen;
        this.stats.framesPresented = drawn;
        this.stats.superseded = this._supersededSinceStats;
        this.stats.computeMisses = computeMisses;
        this.stats.presentationMisses = presentationMisses;
        this.stats.lateDetected = this._lateDetectedSinceStats;
        this.stats.mediaVsWall = Math.round(mediaVsWall * 1000) / 1000;
        this.stats.policy = this.policy;

        // Reported for the diagnostics panel, never fed to the governor while
        // the element is parked. See `_sampleDropRate()`.
        const decoderDrop = this._sampleDropRate();
        this.stats.decoderDropRate = Math.round(decoderDrop * 1000) / 10;
        this.stats.decoderDropTrusted = this._decoderDropsTrustworthy();

        this._skippedSinceStats = 0;
        this._framesSinceStats = 0;
        this._sourceFrames = 0;
        this._supersededSinceStats = 0;
        this._lateDetectedSinceStats = 0;
        this._lastStatsAt = now;

        if (this.adaptive) this._adapt({ gpuMs, cpuMs: avg, missRate, mediaVsWall });
      }
    }

    _medianGpuMs() {
      if (!this._gpuTimes.length) return 0;
      const sorted = [...this._gpuTimes].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    }

    /**
     * Is `droppedVideoFrames` describing what the user sees?
     *
     * Only when the media element is the picture. Watch parks it at 1x1,
     * opacity 0, off-screen whenever the canvas is the picture, and a measured
     * A/B on the reference laptop put the counter at 0% visible against 97.9%
     * parked over the same clip, with media time advancing at 1.0x throughout.
     * The frames were decoded and handed to us; they were simply never painted
     * by an element nobody can see.
     */
    _decoderDropsTrustworthy() {
      const v = this.video;
      if (!v || typeof v.getBoundingClientRect !== 'function') return false;
      try {
        const r = v.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      } catch {
        return false;
      }
    }

    /**
     * If a frame costs more than its share of the frame budget, shrink the
     * render resolution rather than dropping frames. Recovers automatically.
     */
    /**
     * The realtime governor.
     *
     * Smooth motion beats a sharper still frame, always: if enhancement cannot
     * keep up with the media's cadence, enhancement gives ground rather than
     * the playback. Both directions need sustained evidence (`_pressure`) so
     * the picture does not visibly pulse between quality levels.
     *
     *   comfortably inside budget  -> raise slowly
     *   near the budget            -> hold
     *   over the budget            -> lower
     *   far over the budget        -> lower quickly
     */
    _adapt({ gpuMs, cpuMs, missRate, mediaVsWall }) {
      const budget = this.frameBudgetMs();
      const floor = this._qualityFloor();

      /*
       * What the governor is allowed to believe.
       *
       * It used to run on two numbers that both described something else. The
       * CPU bracket around the draw calls measures submission, not rendering -
       * measured at 0.9 ms against a real 20.2 ms - so it permanently voted to
       * raise quality. And `droppedVideoFrames` on the parked element measured
       * the invisible element rather than the canvas - measured at 97.9% while
       * media time held 1.0x - so it permanently voted to lower it. The
       * quality scale ended up near its floor with the picture unchanged,
       * because the scale could not reduce anything either.
       *
       * These three can all be checked against the contract:
       *   cost      real GPU time where the driver exposes it
       *   misses    source frames we were handed and did not draw
       *   slip      media time falling behind the wall clock
       */
      const cost = gpuMs > 0 ? gpuMs : cpuMs;
      const ratio = cost / budget;
      const slipping = mediaVsWall < 0.97;

      if (missRate > 0.15 || slipping) this._pressure += 3;
      else if (missRate > 0.05) this._pressure += 2;
      else if (ratio > 0.9) this._pressure += 2;
      else if (ratio > 0.7) this._pressure += 1;
      else if (missRate < 0.02 && ratio < 0.45) this._pressure -= 1;
      else this._pressure = Math.sign(this._pressure) * Math.max(0, Math.abs(this._pressure) - 0.5);
      this._pressure = Math.max(-4, Math.min(6, this._pressure));

      if (this._pressure >= 4) {
        // Seriously behind: take a big step rather than bleeding frames while
        // we creep down in 10% increments.
        this._qualityScale = Math.max(floor, this._qualityScale - 0.25);
        this._pressure = 1;
      } else if (this._pressure >= 2) {
        this._qualityScale = Math.max(floor, this._qualityScale - 0.1);
        this._pressure = 0;
      } else if (this._pressure <= -3 && this._qualityScale < 1) {
        // Recover gently, so regaining headroom does not immediately cost it.
        // Deliberately a fifth of the emergency step: backing off must always
        // be faster than climbing back.
        this._qualityScale = Math.min(1, this._qualityScale + 0.05);
        this._pressure = 0;
      }

      // At the floor and still losing frames means the GPU cannot sustain this
      // look; the UI can tell the user rather than just stuttering silently.
      const atFloor = this._qualityScale <= floor + 0.001;
      this.stats.limited = (ratio > 1.05 || missRate > 0.05 || slipping) && atFloor;

      /*
       * Last resort: give up on enhancement rather than on the motion.
       *
       * Lowering the render scale shrinks the *output*, but the dominant cost
       * on weak hardware is uploading each source frame into a texture - a
       * 1080p60 source is roughly 500 MB/s of upload before a single shader
       * runs, and no output scale fixes that. When we are at the floor and
       * still losing a large share of frames, the only honest move left is to
       * stop enhancing and hand presentation back to the compositor.
       *
       * Smooth motion is the product promise; a sharper but stuttering picture
       * is not a trade we make silently.
       */
      if (atFloor && (missRate > 0.15 || slipping)) {
        this._overloadStreak++;
        if (this._overloadStreak >= 4 && this.onOverload) {
          this._overloadStreak = 0;
          this.onOverload({
            missRate: Math.round(missRate * 100),
            mediaVsWall,
            sourceFps: this.stats.sourceFps,
            policy: this.policy
          });
        }
      } else if (missRate < 0.05 && !slipping) {
        this._overloadStreak = 0;
      }
    }

    /**
     * Share of frames the decoder dropped since the last check.
     * Deltas, not totals: a video that stuttered once at startup must not hold
     * quality down for the rest of its runtime.
     */
    _sampleDropRate() {
      const v = this.video;
      if (!v || typeof v.getVideoPlaybackQuality !== 'function') return 0;
      let q;
      try {
        q = v.getVideoPlaybackQuality();
      } catch {
        return 0;
      }
      const total = q.totalVideoFrames || 0;
      const dropped = q.droppedVideoFrames || 0;
      const prev = this._lastQuality || { total: 0, dropped: 0 };
      this._lastQuality = { total, dropped };

      const dTotal = total - prev.total;
      const dDropped = dropped - prev.dropped;
      if (dTotal <= 0) return 0;
      return Math.max(0, Math.min(1, dDropped / dTotal));
    }

    /** How far the governor may reduce internal resolution, per policy. */
    _qualityFloor() {
      switch (this.policy) {
        case 'performance': return 0.34;
        case 'quality': return 0.6;
        case 'maximum': return 1;
        case 'balanced': return 0.5;
        default: return 0.4; // auto
      }
    }

    /**
     * Watch quality policy. Affects realtime enhancement only; Create's neural
     * quality is a separate setting and is never touched from here.
     */
    setPolicy(policy) {
      const allowed = ['auto', 'performance', 'balanced', 'quality', 'maximum'];
      this.policy = allowed.includes(policy) ? policy : 'auto';
      this.stats.policy = this.policy;
      // 'maximum' means "do not adapt"; everything else keeps the governor on.
      this.adaptive = this.policy !== 'maximum';
      if (this.policy === 'maximum') this._qualityScale = 1;
      this._pressure = 0;
      this._invalidate();
      return this.policy;
    }

    /** Grab the current enhanced frame as a PNG blob. */
    async snapshot() {
      this.draw();
      return new Promise((resolve) => {
        this.canvas.toBlob((blob) => resolve(blob), 'image/png');
      });
    }

    dispose() {
      this.stop();
      this._unbindVideo();
      const gl = this.gl;
      if (!gl) return;
      for (const q of this._pendingQueries || []) {
        try { gl.deleteQuery(q); } catch { /* already gone */ }
      }
      this._pendingQueries = [];
      this.rtA.dispose();
      this.rtB.dispose();
      this.rtC.dispose();
      gl.deleteTexture(this.videoTexture);
      gl.deleteBuffer(this.vbo);
      gl.deleteVertexArray(this.vao);
      Object.values(this.passes).forEach((p) => gl.deleteProgram(p.program));
    }
  }

  window.VSEngine = { Engine, DEFAULT_PARAMS };
})();
