'use strict';

/**
 * The job system.
 *
 * One explicit state machine, one persistent store, one place that decides what
 * runs next. Everything the UI shows about a render comes from here, and every
 * state it shows is a state this file can actually be in - there are no
 * cosmetic statuses.
 *
 *   queued      accepted, waiting for a slot
 *   analysing   probing the source and planning
 *   ready       planned but deliberately not started (autoStart: false)
 *   running     a stage is executing
 *   paused      stopped cleanly at a chunk boundary, resumable
 *   cancelling  a stop was requested, the process is being torn down
 *   cancelled   stopped by the user
 *   failed      stopped by an error
 *   completed   finished *and* verified
 *   interrupted the app died mid-render; resumable
 *
 * `completed` is only reachable through verification. A render that produced a
 * file ffprobe cannot vouch for fails instead.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const { Workspace } = require('./workspace');
const { JobStore } = require('./job-store');
const chunking = require('./chunking');
const pipeline = require('./pipeline');
const { runEncode, partPathFor } = require('./stages/encode');
const { runMux } = require('./stages/mux');
const { runVerify, verificationError } = require('./stages/verify');
const neural = require('./stages/neural');
const tracking = require('../ai/tracking');
const scenes = require('../ai/scenes');
const { freeSpaceBytes } = require('../ai/downloads');

const recipes = require('../recipe');
const analyzer = require('../media-analyzer');
const { analyze } = analyzer;
const { chooseEncoder, detectEncoders } = require('../ffmpeg/encoders');
const { detectFilters, detectGpus } = require('../capabilities');
const { VisionanceError, CODES, toStructured } = require('../errors');
const { logger } = require('../logger');

const JOB_RECORD_VERSION = 1;

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const RESUMABLE = new Set(['paused', 'interrupted']);

/** Legal state transitions. Anything else is a bug and is refused loudly. */
const TRANSITIONS = {
  queued: ['analysing', 'ready', 'cancelled', 'failed'],
  ready: ['queued', 'cancelled'],
  analysing: ['running', 'cancelling', 'cancelled', 'failed'],
  running: ['running', 'cancelling', 'paused', 'completed', 'failed'],
  cancelling: ['cancelled', 'failed', 'completed'],
  paused: ['queued', 'cancelled', 'failed'],
  interrupted: ['queued', 'cancelled'],
  failed: ['queued', 'cancelled'],
  cancelled: ['queued'],
  completed: []
};

class JobManager extends EventEmitter {
  /**
   * @param {object} o
   *   dir           {string}   where index.json lives (usually <userData>/jobs)
   *   workDir       {string}   working-directory root (usually <userData>/work)
   *   resolveBins   {() => {ffmpeg,ffprobe,ytdlp}}
   *   resolveRemote {(job) => Promise<{video,audio,headers}>}  optional
   *   concurrency   {number}
   */
  constructor(o = {}) {
    super();
    this.log = (o.logger || logger).child('jobs');
    this.workspace = new Workspace(o.workDir || path.join(o.dir || process.cwd(), 'work'));
    this.store = new JobStore({ dir: o.dir, workspace: this.workspace });
    this.resolveBins = o.resolveBins || (() => ({ ffmpeg: null, ffprobe: null, ytdlp: null }));
    this.resolveRemote = o.resolveRemote || null;
    /** EngineManager; absent means neural stages simply cannot be planned. */
    this.engines = o.engines || null;
    /** SemanticManager; absent means Smart Reframe uses saliency only. */
    this.semantic = o.semantic || null;
    this.concurrency = Math.max(1, Number(o.concurrency) || 1);

    /** id -> { control, promise } for jobs currently executing. */
    this.active = new Map();
    this._filterCache = null;
    this._encoderCache = null;
    this._shuttingDown = false;
    this._progressThrottle = new Map();
  }

  /* ------------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------------ */

  init() {
    this.workspace.ensureRoot();
    const { jobs, recovered, warnings } = this.store.load();

    // Working directories with no job behind them are dead weight from a hard
    // crash; nothing references them, so they are safe to remove.
    const orphans = this.workspace.orphans(jobs.map((j) => j.id));
    for (const id of orphans) {
      this.workspace.destroy(id);
      this.log.info('removed orphan workspace', { job: id });
    }

    this.log.info('store loaded', {
      jobs: jobs.length,
      recovered: recovered.length,
      orphansRemoved: orphans.length
    });
    return { jobs: jobs.map((j) => this.publicOf(j)), recovered: recovered.map((j) => this.publicOf(j)), warnings };
  }

  async shutdown() {
    this._shuttingDown = true;
    for (const [id, entry] of this.active) {
      entry.control.cancelled = true;
      if (entry.control.activeRun) entry.control.activeRun.cancel('shutdown');
      if (entry.control.activeAi) entry.control.activeAi.cancel('shutdown');
      const job = this.store.get(id);
      if (job && !TERMINAL.has(job.status)) {
        // Be honest about what happened: the render did not finish and was not
        // cancelled by the user.
        job.status = 'interrupted';
        job.error = {
          code: 'INTERRUPTED',
          message: 'Visionance closed while this job was rendering.',
          recoverable: true,
          suggestedAction: 'Resume or retry the job.'
        };
        this.store.upsert(job, { immediate: true });
        this.store.checkpoint(job);
      }
    }
    this.store.flush();
  }

  /* ------------------------------------------------------------------ *
   * Queries
   * ------------------------------------------------------------------ */

  list() {
    return this.store.all().map((j) => this.publicOf(j));
  }

  get(id) {
    const job = this.store.get(id);
    return job ? this.publicOf(job) : null;
  }

  /** Everything the renderer is allowed to see about a job. */
  publicOf(job) {
    return {
      id: job.id,
      recordVersion: job.recordVersion,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      title: job.title,
      status: job.status,
      stage: job.stage,
      stages: job.stages,
      progress: job.progress,
      stageProgress: job.stageProgress,
      processedDuration: job.processedDuration,
      totalDuration: job.totalDuration,
      fps: job.fps,
      speed: job.speed,
      eta: job.eta,
      checkpoint: job.checkpoint,
      pauseSupported: !!job.pauseSupported,
      error: job.error,
      warnings: job.warnings,
      attempts: job.attempts,
      output: job.output,
      source: {
        type: job.source.type,
        path: job.source.path,
        webpageUrl: job.source.webpageUrl || null,
        title: job.source.title || null
      },
      recipe: job.recipe,
      sourceMetadata: job.sourceMetadata,
      verification: job.verification || null,
      plan: job.plan || null,
      cost: job.cost || null,
      neuralRate: job.neuralRate || null,
      aiMetrics: job.aiMetrics || null,
      reframe: job.reframe || null
    };
  }

  /* ------------------------------------------------------------------ *
   * Creation
   * ------------------------------------------------------------------ */

  /**
   * @param {object} o
   *   recipe    {object}  raw recipe (sanitised here)
   *   analysis  {object}  optional pre-computed analysis
   *   source    {object}  { type, path, url, audioUrl, headerToken, webpageUrl, title }
   *   autoStart {boolean} default true
   */
  async create(o = {}) {
    const { recipe, warnings } = recipes.sanitize(o.recipe);
    const validation = recipes.validate(recipe);
    if (!validation.valid) {
      throw new VisionanceError(CODES.INVALID_RECIPE, {
        message: validation.errors[0].message,
        technicalDetails: validation.errors.map((e) => `${e.field}: ${e.message}`).join('; ')
      });
    }

    const source = {
      type: recipe.source.type,
      path: recipe.source.path,
      url: (o.source && o.source.url) || recipe.source.url,
      audioUrl: (o.source && o.source.audioUrl) || recipe.source.audioUrl,
      headerToken: (o.source && o.source.headerToken) || recipe.source.headerToken,
      webpageUrl: (o.source && o.source.webpageUrl) || recipe.source.webpageUrl || null,
      title: recipe.source.title || (o.source && o.source.title) || null
    };

    if (source.type === 'remote' && !source.webpageUrl) {
      // Without the page URL a restarted job could never re-resolve, and the
      // stored CDN URL will be dead by then.
      warnings.push('This online source has no page URL recorded, so the job cannot be resumed after a restart.');
    }

    const id = `job_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    const now = Date.now();

    const record = {
      id,
      recordVersion: JOB_RECORD_VERSION,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      title: recipe.name || path.basename(recipe.output.path || 'render'),
      source,
      sourceMetadata: o.analysis ? compactAnalysis(o.analysis) : null,
      recipe,
      output: {
        path: recipe.output.path,
        container: recipe.output.container,
        codec: recipe.output.codec,
        expected: null,
        sizeBytes: null
      },
      status: o.autoStart === false ? 'ready' : 'queued',
      stage: null,
      stages: [],
      progress: 0,
      stageProgress: 0,
      processedDuration: 0,
      totalDuration: (o.analysis && o.analysis.derived && o.analysis.derived.durationSeconds) || 0,
      fps: 0,
      speed: 0,
      eta: null,
      checkpoint: null,
      pauseSupported: false,
      error: null,
      warnings,
      attempts: 0,
      plan: null,
      verification: null
    };

    this.workspace.create(id);
    this.store.upsert(record, { immediate: true });
    this.store.checkpoint(record);
    this.log.info('job created', {
      job: id,
      output: path.basename(record.output.path || ''),
      sourceType: source.type,
      autoStart: record.status === 'queued'
    });
    this._emit(record);
    this._pump();
    return this.publicOf(record);
  }

  /* ------------------------------------------------------------------ *
   * Control
   * ------------------------------------------------------------------ */

  start(id) {
    const job = this._require(id);
    if (job.status !== 'ready') {
      throw this._illegal(job, 'start');
    }
    this._transition(job, 'queued');
    this._pump();
    return this.publicOf(job);
  }

  cancel(id) {
    const job = this._require(id);

    if (job.status === 'queued' || job.status === 'ready' || RESUMABLE.has(job.status)) {
      this._transition(job, 'cancelled');
      job.finishedAt = Date.now();
      this._cleanupArtifacts(job, { keepChunks: false });
      this._persist(job, true);
      this._emit(job);
      return this.publicOf(job);
    }

    if (job.status === 'analysing' || job.status === 'running') {
      this._transition(job, 'cancelling');
      const entry = this.active.get(id);
      if (entry) {
        entry.control.cancelled = true;
        // Kill both kinds of child this job may own: an ffmpeg process and a
        // neural engine. Each is killed by pid, so a concurrent job running the
        // same executable is untouched.
        if (entry.control.activeRun) entry.control.activeRun.cancel('cancelled');
        if (entry.control.activeAi) entry.control.activeAi.cancel('cancelled');
      }
      this._persist(job, true);
      this._emit(job);
      return this.publicOf(job);
    }

    throw this._illegal(job, 'cancel');
  }

  /**
   * Pause is only offered where it is real: at a chunk boundary. A plain
   * single-pass ffmpeg render cannot be suspended and resumed safely, so we
   * refuse rather than stopping the process and calling it "paused".
   */
  pause(id) {
    const job = this._require(id);
    if (job.status !== 'running') throw this._illegal(job, 'pause');
    if (!job.pauseSupported) {
      throw new VisionanceError(CODES.PAUSE_UNSUPPORTED, {
        message: 'This render cannot be paused: it is a single ffmpeg pass with no checkpoint to stop at.',
        suggestedAction: 'Turn on chunked rendering in the recipe to make renders pausable.'
      });
    }
    const entry = this.active.get(id);
    if (entry) entry.control.pauseRequested = true;
    job.warnings = addWarning(job.warnings, 'Pausing at the end of the current chunk…');
    this._persist(job, true);
    this._emit(job);
    return this.publicOf(job);
  }

  resume(id) {
    const job = this._require(id);
    if (!RESUMABLE.has(job.status)) throw this._illegal(job, 'resume');
    job.error = null;
    job.warnings = [];
    this._transition(job, 'queued');
    this._pump();
    return this.publicOf(job);
  }

  retry(id) {
    const job = this._require(id);
    if (!['failed', 'cancelled', 'interrupted', 'paused'].includes(job.status)) {
      throw this._illegal(job, 'retry');
    }
    // A retry after a failure starts clean: whatever partial output exists
    // cannot be trusted, and chunks may have been produced by a different plan.
    this._cleanupArtifacts(job, { keepChunks: job.status === 'paused' || job.status === 'interrupted' });
    if (job.status === 'failed' || job.status === 'cancelled') {
      job.checkpoint = null;
      job.verification = null;
    }
    job.error = null;
    job.warnings = [];
    job.progress = 0;
    job.stageProgress = 0;
    job.finishedAt = null;
    this._transition(job, 'queued');
    this._pump();
    return this.publicOf(job);
  }

  remove(id) {
    const job = this._require(id);
    // A job can still be in `active` for a moment after it reaches a terminal
    // state, while the runner unwinds. Only a genuinely live one is refused.
    if (this.active.has(id) && !TERMINAL.has(job.status)) {
      throw new VisionanceError(CODES.ILLEGAL_TRANSITION, {
        message: 'Cancel the job before removing it.'
      });
    }
    this._cleanupArtifacts(job, { keepChunks: false });
    this.workspace.destroy(id);
    this.store.remove(id);
    this.emit('removed', id);
    return true;
  }

  clearFinished() {
    for (const job of this.store.all()) {
      if (TERMINAL.has(job.status)) {
        this._cleanupArtifacts(job, { keepChunks: false });
        this.workspace.destroy(job.id);
        this.store.remove(job.id);
        this.emit('removed', job.id);
      }
    }
    return this.list();
  }

  /* ------------------------------------------------------------------ *
   * Execution
   * ------------------------------------------------------------------ */

  _pump() {
    if (this._shuttingDown) return;
    while (this.active.size < this.concurrency) {
      const next = this.store.all()
        .filter((j) => j.status === 'queued')
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
      if (!next) return;

      const control = { cancelled: false, pauseRequested: false, activeRun: null, activeAi: null };
      const promise = this._run(next, control)
        .catch((err) => {
          this.log.error('job crashed', { job: next.id, error: err && err.message });
        })
        .finally(() => {
          this.active.delete(next.id);
          this._pump();
        });
      this.active.set(next.id, { control, promise });
    }
  }

  async _run(job, control) {
    const bins = this.resolveBins();
    job.attempts = (job.attempts || 0) + 1;
    job.startedAt = job.startedAt || Date.now();
    job.error = null;

    try {
      if (!bins.ffmpeg) throw new VisionanceError(CODES.FFMPEG_MISSING);
      if (!bins.ffprobe) throw new VisionanceError(CODES.FFPROBE_MISSING);

      /* ---- inputs ---- */
      this._transition(job, 'analysing');
      job.stage = 'ANALYSE';
      this._emit(job);

      const inputs = await this._resolveInputs(job);
      if (control.cancelled) throw new VisionanceError(CODES.CANCELLED);

      /* ---- analysis ----
       *
       * The probe is the best answer, not the only acceptable one. A site can
       * serve the stream and refuse ffprobe's request for it — measured
       * against YouTube, the resolve succeeds and the probe returns
       * PROBE_FAILED in a few hundred milliseconds. Failing the whole render
       * there throws away every fact the resolver already reported about the
       * exact rendition being rendered.
       *
       * A local file has no such excuse and still fails hard.
       */
      let analysis;
      try {
        analysis = await analyze(bins.ffprobe, inputs.video, {
          headers: inputs.headers.video,
          deep: inputs.isLocal,
          includeRaw: false
        });
      } catch (err) {
        const declared = inputs.isLocal ? null : analyzer.analysisFromDeclared(inputs.declared);
        if (!declared) throw err;
        analysis = declared;
        job.warnings = addWarning(job.warnings,
          'This stream could not be probed directly, so the render used the figures the site ' +
          'declares for the rendition it selected.');
        this.log.warn('probe refused; using declared rendition', {
          job: job.id, error: err && err.message
        });
      }
      job.sourceMetadata = compactAnalysis(analysis);
      job.totalDuration = analysis.derived.durationSeconds || 0;
      if (control.cancelled) throw new VisionanceError(CODES.CANCELLED);

      /* ---- plan ---- */
      const recipe = job.recipe;
      // Re-derive the analysis snapshot so intent is evaluated against what the
      // source *is* now, not what it was when the recipe was written.
      recipe.analysisRef = recipes.analysisRefFrom(analysis);
      const geometry = recipes.resolveOutputGeometry(recipe, analysis);

      const preliminary = pipeline.planStages(recipe, analysis, geometry, { chunked: false });

      /* ---- neural planning, before any work starts ---- */
      // Resolving engines here means a missing engine fails the job in seconds
      // with "install it", instead of an hour into a render.
      let aiPlan = { upscale: null, interpolate: null, notes: [] };
      if (preliminary.requiresChunking) {
        if (!this.engines) {
          throw new VisionanceError(CODES.ENGINE_MISSING, {
            message: 'This build cannot run neural stages.'
          });
        }
        aiPlan = await neural.planNeural({ recipe, analysis, geometry, engines: this.engines });
        for (const note of aiPlan.notes) job.warnings = addWarning(job.warnings, note);
      }
      const isNeural = !!(aiPlan.upscale || aiPlan.interpolate);

      const plan = chunking.planChunks({
        durationSeconds: analysis.derived.durationSeconds || 0,
        startSeconds: recipe.trim.startSeconds || 0,
        endSeconds: recipe.trim.endSeconds,
        // Frames for a whole film will not fit on any disk, so neural work has
        // a disk-derived ceiling on chunk length. It is a *ceiling*: a user who
        // explicitly asked for shorter chunks still gets them.
        chunkSeconds: isNeural
          ? Math.min(recipe.processing.chunking.chunkSeconds, neuralChunkSeconds(recipe, geometry))
          : recipe.processing.chunking.chunkSeconds,
        mode: recipe.processing.chunking.mode,
        requiresChunking: preliminary.requiresChunking
      });

      const planned = pipeline.planStages(recipe, analysis, geometry, {
        chunked: plan.enabled,
        neural: isNeural,
        // The engine planner has already decided; the stage list must agree
        // with it rather than with what the recipe asked for.
        neuralUpscale: !!aiPlan.upscale,
        neuralInterpolate: !!aiPlan.interpolate
      });
      job.stages = planned.stages;
      job.plan = {
        description: pipeline.describePlan(planned.stages),
        chunked: plan.enabled,
        chunkReason: plan.reason,
        chunkCount: plan.chunks.length,
        chunkSeconds: plan.chunkSeconds,
        totalDuration: plan.totalDuration,
        geometry,
        neural: isNeural ? {
          upscale: aiPlan.upscale ? {
            model: aiPlan.upscale.model.name,
            inferenceScale: aiPlan.upscale.inferenceScale,
            preScale: aiPlan.upscale.preScale || 1,
            downscaleAfter: aiPlan.upscale.downscaleAfter,
            quality: aiPlan.upscale.quality,
            qualityLabel: aiPlan.upscale.qualityLabel,
            reason: aiPlan.upscale.reason,
            tradeoff: aiPlan.upscale.tradeoff || null,
            gpu: aiPlan.upscale.gpuId
          } : null,
          interpolate: aiPlan.interpolate ? {
            model: aiPlan.interpolate.model.label,
            targetFps: geometry.fps,
            sceneCutProtection: aiPlan.interpolate.sceneCutProtection,
            gpu: aiPlan.interpolate.gpuId
          } : null
        } : null
      };
      // Cost is classified from the resolved plan, so it sees the model, the
      // pre-scale and whether the neural pass survived. Classifying the Auto
      // recipe instead is how a job running x4 inference got labelled `fast`.
      job.cost = pipeline.estimatePlanCost({
        stages: planned.stages,
        geometry,
        aiPlan,
        durationSeconds: plan.totalDuration
      });
      job.pauseSupported = plan.enabled && plan.chunks.length > 1;

      /* ---- disk safety ---- */
      if (isNeural) {
        const need = neural.estimateWorkingBytes({ recipe, geometry, plan, aiPlan });
        const free = freeSpaceBytes(this.workspace.root);
        if (need && free != null && free < need) {
          throw new VisionanceError(CODES.INSUFFICIENT_DISK_SPACE, {
            message: `This render needs roughly ${(need / 1e9).toFixed(1)} GB of working space; ` +
              `${(free / 1e9).toFixed(1)} GB is free.`,
            technicalDetails: `need=${need} free=${free} dir=${this.workspace.root}`
          });
        }
      }
      job.output.expected = {
        width: geometry.width,
        height: geometry.height,
        fps: geometry.fps,
        hasAudio: recipe.audio.enabled && recipe.audio.mode !== 'none'
      };
      job.checkpoint = job.checkpoint && job.checkpoint.chunkCount === plan.chunks.length
        ? chunking.reconcile(job.checkpoint, plan, this.workspace.existingChunks(job.id, extOf(recipe.output.path)))
        : chunking.newCheckpoint(plan);

      this._markStage(job, 'ANALYSE', 'completed', 1, `${analysis.derived.resolutionClass || ''} ${analysis.video.codec || ''}`.trim());

      /* ---- encoder + filters ---- */
      const [encoders, filters] = await Promise.all([
        this._encoders(bins.ffmpeg),
        this._filters(bins.ffmpeg)
      ]);
      const encoder = chooseEncoder({
        codec: recipe.output.codec,
        requested: recipe.output.encoder,
        available: encoders,
        hardware: recipe.processing.hardware,
        gpuVendors: await this._gpuVendors()
      });
      if (encoder.reason === 'requested-unavailable') {
        job.warnings = addWarning(job.warnings,
          `${encoder.requested} is not available in this ffmpeg build; ${encoder.id} was used instead.`);
      }

      /* ---- Smart Reframe: measure where the subject is ---- */
      let reframe = null;
      /*
       * The tracker produces a horizontal trajectory, so it can only steer a
       * crop that trims *width*. Asked for 21:9 from a 16:9 source the trim is
       * vertical, and running the analysis anyway would spend a pass on a
       * number the filter graph cannot use — and then report "Smart Reframe"
       * over a crop that was centred. The framing plan already knows which
       * axis is being trimmed, so it is what decides.
       */
      const framingPlan = recipes.resolveFramingPlan(recipe, geometry);
      if (recipe.framing.enabled && recipe.framing.tracking === 'auto' &&
          recipe.framing.mode === 'fill' && geometry.canvasWidth &&
          framingPlan.cropAxis !== 'x') {
        job.warnings = addWarning(job.warnings,
          framingPlan.cropAxis === 'y'
            ? 'This output is wider than the source, so the picture is cropped top and bottom. ' +
              'Subject tracking follows a horizontal position and cannot steer a vertical crop, ' +
              'so the crop is centred.'
            : 'The source is already this shape, so there is nothing for subject tracking to do.');
      }
      if (recipe.framing.enabled && recipe.framing.tracking === 'auto' &&
          recipe.framing.mode === 'fill' && geometry.canvasWidth &&
          framingPlan.cropAxis === 'x') {
        const stage = job.stages.find((s) => s.id === 'REFRAME');
        if (stage) { stage.status = 'running'; stage.startedAt = Date.now(); }
        job.stage = 'REFRAME';
        this._emit(job);
        try {
          const cuts = recipe.motion.sceneCutProtection === false ? { cuts: [] } : await scenes.detectCuts({
            ffmpeg: bins.ffmpeg,
            input: inputs.video,
            headers: inputs.headers.video,
            startSeconds: recipe.trim.startSeconds || 0,
            durationSeconds: plan.totalDuration,
            threshold: recipe.motion.sceneCutThreshold,
            control
          });
          const subject = await tracking.analyseSubject({
            ffmpeg: bins.ffmpeg,
            input: inputs.video,
            headers: inputs.headers.video,
            startSeconds: recipe.trim.startSeconds || 0,
            durationSeconds: plan.totalDuration,
            cuts: cuts.cuts || [],
            profile: recipe.profile || 'auto',
            // The shape the crop rectangle is actually cut to, not the canvas
            // ratio. With an anamorphic allowance in play the two differ, and
            // handing the tracker the canvas ratio would have it compose the
            // subject for a window narrower than the one that gets cropped.
            targetAspect: framingPlan.cropRatio || (geometry.canvasWidth / geometry.canvasHeight),
            sourceAspect: (geometry.sourceWidth || 16) / (geometry.sourceHeight || 9),
            control,
            // Null when the models are absent or the runtime will not load,
            // which degrades Smart Reframe to saliency rather than failing.
            semanticModelsDir: this.semantic ? this.semantic.readyModelsDir() : null
          });
          const expr = tracking.buildCropExpression(subject);
          reframe = { ...expr, cropWidthFraction: subject.cropWidthFraction };
          job.reframe = {
            backend: subject.backend,
            backendLabel: subject.backendLabel,
            // The reconciled summary, not a second opinion assembled here.
            outcome: subject.outcome,
            samples: subject.samples,
            tracked: subject.tracked,
            held: subject.held,
            centred: subject.centred,
            coverage: subject.coverage,
            confidence: subject.confidence,
            trackingConfidence: subject.trackingConfidence,
            scenes: subject.scenes,
            // Which signal decided what, so the label can never overstate.
            semanticSamples: subject.semanticSamples,
            faceSamples: subject.faceSamples,
            personSamples: subject.personSamples,
            saliencySamples: subject.saliencySamples,
            semanticAvailable: subject.semanticAvailable,
            primaryBackend: subject.primaryBackend,
            backendUsage: subject.backendUsage,
            semanticMs: subject.semantic ? subject.semantic.ms : null,
            semanticFrames: subject.semantic ? subject.semantic.frames : null,
            semanticReason: subject.semantic ? subject.semantic.reason : null,
            headline: subject.headline,
            detail: subject.detail,
            keyedPositions: expr.points,
            static: expr.static
          };
          for (const n of subject.notes) job.warnings = addWarning(job.warnings, n);
          if (stage) { stage.status = 'completed'; stage.progress = 1; stage.finishedAt = Date.now(); }
          this.log.info('smart reframe', { job: job.id, ...job.reframe });
        } catch (err) {
          // Reframing failing must not fail the export: fall back to a centre
          // crop and say so.
          if (err && err.code === CODES.CANCELLED) throw err;
          reframe = null;
          job.warnings = addWarning(job.warnings,
            'Subject tracking failed, so the crop is centred instead.');
          this.log.warn('smart reframe failed', { job: job.id, error: err && err.message });
          if (stage) { stage.status = 'completed'; stage.progress = 1; stage.message = 'centre fallback'; }
        }
      }

      this._transition(job, 'running');
      this._persist(job, true);
      this.store.checkpoint(job);
      this._emit(job);

      const ctx = {
        reframe,
        jobId: job.id,
        recipe,
        analysis,
        geometry,
        encoderId: encoder.id,
        availableFilters: filters,
        inputs: { video: inputs.video, audio: inputs.audio },
        headers: inputs.headers,
        bins,
        workspace: this.workspace,
        plan,
        checkpoint: job.checkpoint,
        control,
        log: this.log,
        report: () => {},
        onCheckpoint: (cp) => {
          job.checkpoint = cp;
          job.processedDuration = cp.completedDuration || job.processedDuration;
          this._persist(job, true);
          this.store.checkpoint(job);
          this._emit(job);
        }
      };

      /* ---- neural path ---- */
      if (isNeural) {
        ctx.engines = this.engines;
        ctx.aiPlan = aiPlan;
        ctx.addWarning = (m) => { job.warnings = addWarning(job.warnings, m); };
        ctx.reportStage = (stageId, fraction, message, metrics) =>
          this._reportStage(job, stageId, fraction, message, metrics);

        for (const id of ['UPSCALE', 'INTERPOLATE']) {
          const stage = job.stages.find((s) => s.id === id);
          if (stage && stage.mode === 'pass') {
            stage.status = 'running';
            stage.startedAt = Date.now();
          }
        }
        job.stage = aiPlan.upscale ? 'UPSCALE' : 'INTERPOLATE';
        this._emit(job);

        const neuralResult = await neural.runNeuralPipeline(ctx);
        if (neuralResult.paused) {
          this._transition(job, 'paused');
          job.warnings = addWarning(job.warnings,
            'Paused at a chunk boundary. Resume to continue where it stopped.');
          this._persist(job, true);
          this.store.checkpoint(job);
          this._emit(job);
          return;
        }

        for (const id of ['UPSCALE', 'INTERPOLATE', 'ENCODE']) {
          const stage = job.stages.find((s) => s.id === id);
          if (stage && stage.mode !== 'skipped') {
            stage.status = 'completed';
            stage.progress = 1;
            stage.finishedAt = Date.now();
            if (neuralResult.metrics) stage.metrics = { ...(stage.metrics || {}), ...neuralResult.metrics };
          }
        }
        job.aiMetrics = neuralResult.metrics;

        const finalised = await this._runStage(job, 'MUX', () => neural.finaliseNeural(ctx));
        if (!finalised || !finalised.outputPath) {
          throw new VisionanceError(CODES.STAGE_FAILED, {
            message: 'The processed chunks were never assembled into an output file.',
            technicalDetails: 'MUX stage did not run for a neural job'
          });
        }
        const partFileNeural = finalised.outputPath;
        await this._finish(job, partFileNeural, ctx, recipe);
        return;
      }

      /* ---- ENCODE ---- */
      let encodeResult;
      try {
        encodeResult = await this._runStage(job, 'ENCODE', (report) =>
          runEncode({ ...ctx, report, checkpoint: job.checkpoint }));
      } catch (err) {
        // `ffmpeg -encoders` reports what the build supports, not what this
        // machine can actually run. Rather than predicting that, fall back once
        // to CPU and say so - a slow render beats a failed one.
        const fallback = this._cpuFallbackFor(err, encoder, recipe, encoders, control);
        if (!fallback) throw err;

        job.warnings = addWarning(job.warnings,
          `${encoder.id} failed on this machine; the render was redone with ${fallback.id}.`);
        this.log.warn('hardware encoder failed, falling back to CPU', {
          job: job.id, from: encoder.id, to: fallback.id
        });
        this._cleanupChunks(job);
        job.checkpoint = chunking.newCheckpoint(plan);
        const stage = job.stages.find((s) => s.id === 'ENCODE');
        if (stage) { stage.status = 'pending'; stage.progress = 0; stage.message = null; }
        ctx.encoderId = fallback.id;
        encodeResult = await this._runStage(job, 'ENCODE', (report) =>
          runEncode({ ...ctx, report, checkpoint: job.checkpoint }));
      }

      if (encodeResult.paused) {
        this._transition(job, 'paused');
        job.stage = 'ENCODE';
        job.warnings = addWarning(job.warnings, 'Paused at a chunk boundary. Resume to continue where it stopped.');
        this._persist(job, true);
        this.store.checkpoint(job);
        this._emit(job);
        return;
      }

      let partFile = encodeResult.outputPath;

      /* ---- MUX ---- */
      if (plan.enabled) {
        const muxResult = await this._runStage(job, 'MUX', (report) =>
          runMux({ ...ctx, report, checkpoint: job.checkpoint }));
        partFile = muxResult.outputPath;
      }

      if (control.cancelled) throw new VisionanceError(CODES.CANCELLED);

      await this._finish(job, partFile, ctx, recipe);
    } catch (err) {
      this._fail(job, err, control);
    }
  }

  /** Verify, publish and close out a job. Shared by both execution paths. */
  async _finish(job, partFile, ctx, recipe) {
    if (ctx.control.cancelled) throw new VisionanceError(CODES.CANCELLED);

    /* ---- VERIFY ---- */
    if (recipe.processing.verify !== false) {
      const verification = await this._runStage(job, 'VERIFY', (report) =>
        // The contract the job was set up to satisfy travels with the check.
        // Deriving the expectation inside the verifier from the source
        // analysis is what let a silent render pass: for a split stream the
        // analysis sees no audio, so the verifier expected none.
        runVerify({
          ...ctx,
          report,
          filePath: partFile,
          expected: job.output.expected,
          sourceHasAudio: !!(ctx.inputs && ctx.inputs.audio) ||
            !!(ctx.analysis && ctx.analysis.audio)
        }));
      if (verification) {
        job.verification = {
          ok: verification.ok,
          checks: verification.checks,
          failures: verification.failures,
          warnings: verification.warnings
        };
        if (!verification.ok) throw verificationError(verification);
        for (const w of verification.warnings) job.warnings = addWarning(job.warnings, w);
      }
    }

    /* ---- publish ---- */
    const finalPath = recipe.output.path;
    moveIntoPlace(partFile, finalPath);
    try { job.output.sizeBytes = fs.statSync(finalPath).size; } catch { /* ignore */ }

    // Fused stages did their work inside the encode; say so, do not leave them
    // looking pending forever.
    for (const stage of job.stages) {
      if (stage.mode === 'fused') {
        stage.status = 'completed';
        stage.progress = 1;
        stage.message = 'Applied inside the encode pass';
      }
    }

    job.progress = 1;
    job.stageProgress = 1;
    job.stage = null;
    job.finishedAt = Date.now();
    job.processedDuration = job.totalDuration;
    this._transition(job, 'completed');
    if (!recipe.processing.keepIntermediates) this.workspace.cleanTemp(job.id);
    this._cleanupChunks(job);
    this._persist(job, true);
    this.store.checkpoint(job);
    this._emit(job);
    this.log.info('job completed', {
      job: job.id,
      seconds: Math.round((job.finishedAt - job.startedAt) / 1000),
      bytes: job.output.sizeBytes,
      ai: job.aiMetrics ? JSON.stringify(job.aiMetrics) : 'none'
    });
  }

  /**
   * What would this recipe cost, without starting anything?
   *
   * Resolves the same plan a real run would - geometry, the engine planner's
   * verdict on which model and inference path, the stage list - and classifies
   * it. Reusing the run's own resolution is the point: a preview derived from
   * the recipe alone is exactly the thing that labelled an x4 inference job
   * `fast`.
   *
   * Creates no job, touches no disk, spawns nothing.
   *
   * @returns {Promise<{cost, plan, geometry, notes:string[]}>}
   */
  async previewPlan(recipe, analysis) {
    const geometry = recipes.resolveOutputGeometry(recipe, analysis);
    const preliminary = pipeline.planStages(recipe, analysis, geometry, { chunked: false });

    let aiPlan = { upscale: null, interpolate: null, notes: [] };
    if (preliminary.requiresChunking && this.engines) {
      try {
        aiPlan = await neural.planNeural({ recipe, analysis, geometry, engines: this.engines });
      } catch (err) {
        // A missing engine is a real answer for a preview: report it as a note
        // rather than failing the panel the user is still editing.
        return {
          cost: null,
          geometry,
          notes: [err && err.message ? err.message : 'Neural stages are unavailable.'],
          unavailable: true
        };
      }
    }

    const durationSeconds = (analysis.derived && analysis.derived.durationSeconds) || 0;
    const stages = pipeline.planStages(recipe, analysis, geometry, {
      chunked: false,
      neural: !!(aiPlan.upscale || aiPlan.interpolate),
      neuralUpscale: !!aiPlan.upscale,
      neuralInterpolate: !!aiPlan.interpolate
    }).stages;

    return {
      cost: pipeline.estimatePlanCost({ stages, geometry, aiPlan, durationSeconds }),
      geometry,
      plan: {
        description: pipeline.describePlan(stages),
        neural: aiPlan.upscale ? {
          model: aiPlan.upscale.model.name,
          inferenceScale: aiPlan.upscale.inferenceScale,
          preScale: aiPlan.upscale.preScale || 1,
          quality: aiPlan.upscale.quality,
          qualityLabel: aiPlan.upscale.qualityLabel,
          reason: aiPlan.upscale.reason,
          tradeoff: aiPlan.upscale.tradeoff || null
        } : null,
        interpolate: aiPlan.interpolate ? { model: aiPlan.interpolate.model.label } : null
      },
      notes: aiPlan.notes || []
    };
  }

  /**
   * Progress for a stage the neural pipeline is driving.
   * Unlike _runStage this does not own the stage's lifecycle - the neural
   * pipeline moves between UPSCALE, INTERPOLATE and ENCODE many times per
   * chunk, so start/finish are handled by the caller.
   */
  _reportStage(job, stageId, fraction, message, metrics) {
    const stage = job.stages.find((s) => s.id === stageId);
    if (!stage) return;
    stage.progress = Math.min(1, Math.max(0, Number(fraction) || 0));
    if (message) stage.message = message;
    if (metrics) stage.metrics = { ...(stage.metrics || {}), ...metrics };

    job.stage = stageId;
    job.stageProgress = stage.progress;
    // Every neural stage advances together across chunks, so overall progress
    // is the chunk fraction rather than a per-stage weighting.
    job.progress = Math.min(0.99, stage.progress);
    if (metrics && metrics.framesPerSecond) job.fps = metrics.framesPerSecond;

    // A neural job has no ffmpeg `speed` to report, so the rate is measured
    // from frames the network has actually finished.
    if (metrics && metrics.neuralFramesTotal) {
      const rate = updateNeuralRate(job, {
        framesDone: metrics.neuralFramesDone || 0,
        framesTotal: metrics.neuralFramesTotal,
        startedAt: metrics.neuralStartedAt
      });
      if (rate) job.fps = rate.framesPerSecond;
    }

    if (job.totalDuration) job.processedDuration = job.totalDuration * job.progress;
    job.eta = estimateEta(job);
    this._emitThrottled(job);
  }

  /** Run one pass stage, wiring its progress into the job. */
  async _runStage(job, stageId, fn) {
    const stage = job.stages.find((s) => s.id === stageId);
    if (!stage || stage.mode === 'skipped') return null;

    stage.status = 'running';
    stage.startedAt = Date.now();
    job.stage = stageId;
    this._emit(job);

    const report = (fraction, message, metrics) => {
      stage.progress = Math.min(1, Math.max(0, Number(fraction) || 0));
      if (message) stage.message = message;
      if (metrics) {
        stage.metrics = { ...(stage.metrics || {}), ...metrics };
        if (metrics.fps != null) job.fps = metrics.fps;
        if (metrics.speed != null) job.speed = metrics.speed;
        if (metrics.processedSeconds != null) job.processedDuration = metrics.processedSeconds;
      }
      job.stageProgress = stage.progress;
      job.progress = pipeline.aggregateProgress(job.stages);
      job.eta = estimateEta(job);
      this._emitThrottled(job);
    };

    try {
      const result = await fn(report);
      if (result && result.paused) {
        // Stopping cleanly at a checkpoint is not the same as finishing.
        stage.status = 'paused';
        stage.message = 'Paused at a chunk boundary';
        this._emit(job);
        return result;
      }
      stage.status = 'completed';
      stage.progress = 1;
      stage.finishedAt = Date.now();
      job.progress = pipeline.aggregateProgress(job.stages);
      this._emit(job);
      return result;
    } catch (err) {
      stage.status = err && err.code === CODES.CANCELLED ? 'cancelled' : 'failed';
      stage.finishedAt = Date.now();
      stage.message = err && err.message ? String(err.message).slice(0, 300) : null;
      throw err;
    }
  }

  _markStage(job, id, status, progress, message) {
    const stage = job.stages.find((s) => s.id === id);
    if (!stage) return;
    stage.status = status;
    stage.progress = progress;
    stage.message = message || stage.message;
    if (status === 'completed') stage.finishedAt = Date.now();
    job.progress = pipeline.aggregateProgress(job.stages);
    this._emit(job);
  }

  _fail(job, err, control) {
    const structured = toStructured(err, CODES.STAGE_FAILED);
    const cancelled = structured.code === CODES.CANCELLED || (control && control.cancelled);

    job.finishedAt = Date.now();
    job.eta = null;
    job.fps = 0;
    job.speed = 0;

    if (cancelled) {
      this._transition(job, 'cancelled', { force: true });
      job.error = null;
      this._cleanupArtifacts(job, { keepChunks: false });
      this.log.info('job cancelled', { job: job.id });
    } else {
      this._transition(job, 'failed', { force: true });
      job.error = structured;
      // Keep chunks: a retry can reuse the ones that already rendered.
      this._cleanupArtifacts(job, { keepChunks: true });
      this.log.error('job failed', {
        job: job.id,
        code: structured.code,
        detail: structured.technicalDetails
      });
    }

    this._persist(job, true);
    this.store.checkpoint(job);
    this._emit(job);
  }

  /* ------------------------------------------------------------------ *
   * Inputs
   * ------------------------------------------------------------------ */

  async _resolveInputs(job) {
    if (job.source.type === 'local') {
      const p = job.source.path || job.recipe.source.path;
      if (!p || !fs.existsSync(p)) {
        throw new VisionanceError(CODES.SOURCE_NOT_FOUND, {
          message: 'The source file has moved or been deleted.',
          technicalDetails: `missing: ${p}`
        });
      }
      return { video: p, audio: null, headers: { video: null, audio: null }, isLocal: true };
    }

    if (!this.resolveRemote) {
      throw new VisionanceError(CODES.INVALID_REQUEST, {
        message: 'This build cannot render online sources.'
      });
    }
    const resolved = await this.resolveRemote(job);
    if (!resolved || !resolved.video) {
      throw new VisionanceError(CODES.STREAM_EXPIRED, {
        message: 'The online source could not be re-resolved for rendering.'
      });
    }
    return {
      video: resolved.video,
      audio: resolved.audio || null,
      headers: resolved.headers || { video: null, audio: null },
      isLocal: false
    };
  }

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  async _encoders(ffmpegBin) {
    if (!this._encoderCache) this._encoderCache = await detectEncoders(ffmpegBin);
    return this._encoderCache;
  }

  async _filters(ffmpegBin) {
    if (!this._filterCache) this._filterCache = await detectFilters(ffmpegBin);
    return this._filterCache;
  }

  /** Detected GPU vendors, used only to rank hardware encoders. */
  async _gpuVendors() {
    if (!this._gpuVendorCache) {
      try {
        const gpus = await detectGpus();
        this._gpuVendorCache = [...new Set(gpus.map((g) => g.vendor).filter((v) => v && v !== 'unknown'))];
      } catch {
        this._gpuVendorCache = [];
      }
    }
    return this._gpuVendorCache;
  }

  /**
   * Should a failed hardware encode be retried on the CPU?
   * Only for a genuine encoder failure, only once, and never after a cancel.
   */
  _cpuFallbackFor(err, encoder, recipe, encoders, control) {
    if (!encoder.hardware) return null;
    if (control && control.cancelled) return null;
    if (!err || err.code !== CODES.ENCODE_FAILED) return null;
    if (recipe.processing.hardware === 'cpu') return null;

    const cpu = chooseEncoder({
      codec: recipe.output.codec,
      requested: 'auto',
      available: encoders,
      hardware: 'cpu'
    });
    return cpu.id === encoder.id ? null : cpu;
  }

  _require(id) {
    const job = this.store.get(id);
    if (!job) throw new VisionanceError(CODES.JOB_NOT_FOUND);
    return job;
  }

  _illegal(job, action) {
    return new VisionanceError(CODES.ILLEGAL_TRANSITION, {
      message: `A ${job.status} job cannot be ${action}ed.`,
      technicalDetails: `job=${job.id} status=${job.status} action=${action}`
    });
  }

  _transition(job, next, opts = {}) {
    const from = job.status;
    const allowed = TRANSITIONS[from] || [];
    if (!opts.force && !allowed.includes(next)) {
      throw new VisionanceError(CODES.ILLEGAL_TRANSITION, {
        message: `A ${from} job cannot become ${next}.`,
        technicalDetails: `job=${job.id} ${from} -> ${next}`
      });
    }
    job.status = next;
    job.updatedAt = Date.now();
    if (from !== next) {
      this.log.info('state', { job: job.id, from, to: next, stage: job.stage || 'none' });
    }
    this._persist(job, true);
    return job;
  }

  _persist(job, immediate) {
    this.store.upsert(job, { immediate: !!immediate });
  }

  _emit(job) {
    this._progressThrottle.delete(job.id);
    this.emit('update', this.publicOf(job));
  }

  /** Progress ticks are frequent; state changes are not. Throttle only ticks. */
  _emitThrottled(job) {
    const now = Date.now();
    const last = this._progressThrottle.get(job.id) || 0;
    if (now - last < 250) return;
    this._progressThrottle.set(job.id, now);
    this._persist(job, false);
    this.emit('update', this.publicOf(job));
  }

  _cleanupArtifacts(job, { keepChunks }) {
    const output = job.recipe && job.recipe.output && job.recipe.output.path;
    if (output) {
      try { fs.rmSync(partPathFor(output), { force: true }); } catch { /* best effort */ }
    }
    if (!keepChunks) this._cleanupChunks(job);
    this.workspace.cleanTemp(job.id);
  }

  _cleanupChunks(job) {
    if (job.recipe && job.recipe.processing && job.recipe.processing.keepIntermediates) return;
    try {
      fs.rmSync(this.workspace.chunkDir(job.id), { recursive: true, force: true });
      fs.mkdirSync(this.workspace.chunkDir(job.id), { recursive: true });
    } catch { /* best effort */ }
  }
}

/* ------------------------------------------------------------------ *
 * Free functions
 * ------------------------------------------------------------------ */

/** Rename onto the destination, falling back to copy across volumes. */
function moveIntoPlace(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
    return;
  } catch (err) {
    if (err.code !== 'EXDEV') {
      // Destination may exist from an earlier run.
      try {
        fs.rmSync(to, { force: true });
        fs.renameSync(from, to);
        return;
      } catch { /* fall through to copy */ }
    }
  }
  fs.copyFileSync(from, to);
  fs.rmSync(from, { force: true });
}

function extOf(p) {
  return (path.extname(p || '') || '.mp4').slice(1).toLowerCase();
}

/** The parts of an analysis worth persisting with the job. */
function compactAnalysis(analysis) {
  if (!analysis) return null;
  const { raw, ...rest } = analysis;
  return rest;
}

function addWarning(list, message) {
  const out = Array.isArray(list) ? [...list] : [];
  if (!out.includes(message)) out.push(message);
  return out.slice(-10);
}

/**
 * Chunk length for a neural render.
 *
 * Frames live on disk uncompressed-ish, so chunk length is a disk-space
 * decision, not a taste one: a 4K chunk holds far fewer seconds than a 720p one
 * for the same footprint. Aim at roughly 3 GB of frames per chunk.
 */
function neuralChunkSeconds(recipe, geometry) {
  const TARGET_BYTES = 3e9;
  const w = geometry.sourceWidth || 1920;
  const h = geometry.sourceHeight || 1080;
  const fps = geometry.sourceFps || 30;
  // Chunk length is a disk decision, so it uses the scale the *frames on disk*
  // will land at. This runs before the engine planner, so it takes the
  // requested scale as the worst case; a pre-scaled path simply needs less than
  // this reserved, which is the safe direction to be wrong in.
  const scale = recipe.reconstruction.mode === 'neural'
    ? Math.max(1, recipe.reconstruction.aiScale || 1)
    : 1;
  // Decoded frames plus upscaled frames, ~1.2 bytes per pixel as PNG.
  const perSecond = w * h * 1.2 * fps * (1 + scale * scale);
  const seconds = Math.floor(TARGET_BYTES / Math.max(1, perSecond));
  return Math.max(5, Math.min(120, seconds));
}

/**
 * How many frames must be behind us before a remaining-time figure means
 * anything. The first frames of a neural job include model load, Vulkan
 * warm-up and the tile search, so an estimate taken from them is wrong by a
 * factor that matters.
 */
const ETA_MIN_FRAMES = 12;
const ETA_MIN_ELAPSED_MS = 8000;
/** Exponential smoothing on the rate. Enough to stop the number dancing. */
const ETA_SMOOTHING = 0.25;

/**
 * Remaining time from frames that have actually been processed.
 *
 * Two different jobs need two different sources of truth:
 *   - a fused ffmpeg encode reports `speed` (multiples of realtime), which is
 *     exactly what it says on the tin
 *   - a neural job has no such thing, so the rate comes from frames completed
 *     against wall clock, smoothed, and is not offered at all until enough
 *     frames exist to make it honest
 */
function estimateEta(job) {
  const neural = job.neuralRate;
  if (neural && neural.framesPerSecond > 0 && neural.framesRemaining > 0) {
    return Math.round(neural.framesRemaining / neural.framesPerSecond);
  }
  if (!job.totalDuration || !job.speed || job.speed <= 0) return null;
  const remaining = Math.max(0, job.totalDuration - (job.processedDuration || 0));
  return Math.round(remaining / job.speed);
}

/**
 * Fold one progress report into the job's rolling processing rate.
 * Mutates `job.neuralRate` and returns it, or null while it is too early.
 */
function updateNeuralRate(job, { framesDone, framesTotal, startedAt }) {
  if (!framesTotal || framesTotal <= 0) return null;
  const elapsed = Date.now() - (startedAt || job.startedAt || Date.now());
  if (framesDone < ETA_MIN_FRAMES || elapsed < ETA_MIN_ELAPSED_MS) {
    // Say nothing rather than something wrong. The queue shows the cost class
    // in the meantime, which is a claim we can actually support.
    job.neuralRate = {
      framesDone, framesTotal, framesRemaining: framesTotal - framesDone,
      framesPerSecond: 0, warming: true
    };
    return null;
  }
  const instant = (framesDone * 1000) / elapsed;
  const previous = (job.neuralRate && job.neuralRate.framesPerSecond) || 0;
  const smoothed = previous > 0
    ? previous + (instant - previous) * ETA_SMOOTHING
    : instant;
  job.neuralRate = {
    framesDone,
    framesTotal,
    framesRemaining: Math.max(0, framesTotal - framesDone),
    framesPerSecond: Math.round(smoothed * 1000) / 1000,
    warming: false
  };
  return job.neuralRate;
}

module.exports = {
  JobManager, TRANSITIONS, TERMINAL, moveIntoPlace,
  // Exported for the verification harnesses: the rate maths is the part that
  // decides whether a remaining time is honest, so it is tested directly.
  updateNeuralRate, estimateEta, ETA_MIN_FRAMES, ETA_MIN_ELAPSED_MS
};
