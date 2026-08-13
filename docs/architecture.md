# Visionance architecture

Two workflows share one Electron application.

**Watch** plays a local file or an online stream and enhances every frame on the
GPU as it plays. Nothing is written to disk.

**Create** takes a finished edit and produces an upload-ready file: analyse,
repair, neural restore/upscale, AI frame interpolation, reframe, grade, audio,
encode, verify. Classical stages run as one fused ffmpeg graph; neural stages
run as discrete passes over decoded frames.

These are **different engines**. Watch is GLSL running per frame at display rate;
Create is an ffmpeg filter graph running as fast as the machine allows. They
share intent, never arithmetic. Anywhere the code converts one into the other it
says so out loud — see `recipe.fromPreviewParams()`.

---

## Process layout

```
main process (Node)                          renderer (no Node access)
├── main.js            wiring, window, IPC   ├── index.html   shell
├── preload.js         the only bridge  <──> ├── js/engine.js WebGL2 pipeline
│                                            ├── js/shaders.js
├── store.js           settings/presets      ├── js/presets.js
├── binaries.js        ffmpeg/ffprobe/yt-dlp ├── js/app.js    UI wiring
│                                            └── js/playback-stats.js  pacing
├── logger.js          structured logging
├── errors.js          structured errors + redaction
├── capabilities.js    what this machine can do
├── media-analyzer.js  ffprobe -> normalised analysis
├── recipe.js          versioned processing intent
├── ytdlp.js           URL resolution policy
├── stream-policy.js   how much stream Watch should ask for
├── stream-proxy.js    chunked ranged media proxy (throughput, backpressure)
├── auto-recipe.js     analysis -> recipe, with explanations
├── creator-presets.js production export presets
├── js-runtime.js      discover/validate/install a JS runtime for yt-dlp
├── stream-session.js  live stream tokens, headers, expiry
├── ai/
│   ├── engine-manager.js  install/status/removal of neural engines
│   ├── downloads.js       resumable, verified, atomic installs
│   ├── process.js         running ncnn tools; OOM and Vulkan detection
│   ├── frames.js          per-chunk frame decode/encode
│   ├── scenes.js          hard-cut detection
│   ├── tracking.js        Smart Reframe saliency + crop trajectory
│   ├── interpolation-plan.js  cut-safe frame timing (pure)
│   └── engines/           realesrgan.js, rife.js
├── ffmpeg/
│   ├── encoders.js    catalogue, detection, selection
│   ├── filters.js     recipe -> filter graph
│   ├── command.js     full argv construction
│   └── process.js     spawn, progress, cancellation
└── jobs/
    ├── job-manager.js state machine + orchestration
    ├── job-store.js   persistence and crash recovery
    ├── workspace.js   per-job directories, path safety
    ├── chunking.js    chunk plans and checkpoints
    ├── pipeline.js    stage identities and planning
    └── stages/        encode.js, mux.js, verify.js, neural.js
```

The renderer sees exactly the methods listed in `preload.js`. There is no
`ipcRenderer`, no `require`, no Node global in the page.

---

## The three data structures

They are deliberately separate, and confusing them is the mistake this design
exists to prevent.

| | What it is | Where it lives | Lifetime |
|---|---|---|---|
| **Analysis** | Measured facts about a source | `media-analyzer.js` | Recomputed per render |
| **Params** | Live preview settings, per frame | `renderer/js/presets.js` | Session |
| **Recipe** | Offline processing intent, versioned | `recipe.js` | Persisted with a job |

### Analysis

One ffprobe call, one normalised shape: `container`, `video`, `color`, `audio`,
`audioStreams`, `subtitleStreams`, `timing`, `derived`, `warnings`. Raw probe
output stays under `raw` (opt-in) and derived values under `derived`, so a
consumer can always tell measurement from inference.

**Unknown stays unknown.** If ffprobe does not report a value the field is
`null`. Frame-rate mode is estimated from `r_frame_rate` vs `avg_frame_rate`,
and upgraded to a measurement (`confidence: 'measured'`) by an optional deep
probe of packet timestamps before an offline render.

### Recipe

`schemaVersion` + `source`, `analysisRef`, `trim`, `restore`, `reconstruction`,
`motion`, `framing`, `color`, `audio`, `output`, `processing`.

- `sanitize()` clamps every value it keeps and **drops unknown keys**, so a
  recipe written by an older build simply picks up the new defaults, and one
  written by a newer build loses only the fields this build cannot honour.
- `validate()` handles what clamping cannot fix (no output path, a codec the
  container cannot carry, a stage this build does not implement).
- `migrate()` is the explicit upgrade step. v2 added the neural fields; a v1
  recipe loads unchanged, since the v2 defaults describe v1 behaviour.
- `resolveOutputGeometry()` turns intent + analysis into concrete width, height
  and fps. The encode planner **and** the output verifier both call it, so what
  we ask ffmpeg for cannot drift from what we assert afterwards.

---

## Stages

A fixed, ordered list of identities:

```
ANALYSE → RESTORE → UPSCALE → INTERPOLATE → REFRAME → GRADE → AUDIO → ENCODE → MUX → VERIFY
```

Each stage reports a **mode** for a given recipe:

- `fused` — expressible as ffmpeg filters, so it is folded into the encode pass.
  One decode, one encode, no intermediate files.
- `pass` — needs its own run over the media, producing an intermediate.
- `skipped` — the recipe does not ask for it.

Classical work is all `fused`; the `pass` stages are ANALYSE, ENCODE, MUX,
VERIFY, plus UPSCALE and INTERPOLATE **when the recipe asks for a neural
backend**. That is the split the abstraction was built for: `planStages` returns
`requiresChunking` as soon as a neural pass appears, and the orchestrator still
knows nothing about Real-ESRGAN or RIFE.

Progress is weighted across `pass` stages only, and a neural stage carries a
much larger weight than the same stage done as a filter (`neuralWeight`),
because it genuinely dominates the render.

---

## Watch: presentation and pacing

Watch has two presentation paths and switches between them explicitly.

| | Enhancement off | Enhancement on (or compare) |
|---|---|---|
| Picture | the `<video>` element | the WebGL canvas |
| Per frame | nothing | texture upload + shader passes + canvas present |
| Engine loop | **stopped** | running |

### One source-switch lifecycle

`switchSource(request, options)` in `app.js` is the only way media is loaded.
The omnibar's Play button, the file picker, drag-and-drop, the recents list,
the menu and a file opened from the shell all route through it; there is no
second path that sets `video.src` directly, because two such paths racing each
other is what made pasting a URL over a playing local file appear to do nothing
at all. (Pasting auto-loads, the user then presses Play, and the second load
tore down the first one's connection exactly as it was starting to buffer.)

It tears the old source down completely before touching the new one - detach
both elements by *removing* the src attribute (setting `''` is a relative URL,
so the element loads the page and reports a decode failure), stop the engine,
reset the pacing window and the diagnostics, drop the stale analysis and resume
key, and release the previous stream session so its CDN URLs and header set do
not outlive the video they belonged to.

Races are handled by a monotonic `generation` counter plus an `AbortController`.
Every switch takes the next number and any asynchronous step that finds the
counter has moved on abandons its work - including handing back a stream
session it had just created. The invariant is that **a slow URL resolution can
never overwrite a newer source**; the failure mode without it is silent and
baffling, because the picture changes back on its own several seconds later.
`tools/verify-switch.js` proves it with a resolver deliberately delayed by three
seconds.

Readiness is awaited by the switch that asked for it rather than by a global
`loadedmetadata` listener, which cannot tell whether the metadata it just
received belongs to the video the user currently wants - the old one seeked a
freshly opened clip to the *previous* clip's resume position.

A second request for the source already being loaded joins the switch in flight
instead of restarting it, and the Play button compares a normalised URL against
what is loaded: a different address means load it, the same address means
ordinary play/pause.

### Split-stream audio

A split stream plays through a second `<audio>` element, and both elements are
`preload="auto"` deliberately. A paused media element with the default preload
fetches metadata and then suspends the network, so an audio track whose first
`play()` lost the race with its own loading would never load the rest - the
video played silently and nothing reported an error. `media.playAudio()` is
therefore retried from the audio element's own readiness events, turning a slow
start into a late start rather than no sound at all.

`applyPresentationMode()` in `app.js` owns the switch. In native mode the
`<video>` is a normal visible element and Chromium runs decode → compositor →
display with no JavaScript in the loop; the engine's `stop()` is called, not
merely hidden. Before this existed, "enhancement off" still uploaded every
frame into a GL texture and presented a canvas the size of the source - about
500 MB/s of texture upload for a 1080p60 stream, on hardware that also had to
decode it. That was the frame-pacing bug.

### The governor

`engine.js` measures the media's own presentation cadence through
`requestVideoFrameCallback` and derives the frame budget from it, so a 24 fps
film is judged against 41.7 ms rather than a fixed 16.7 ms.

Three inputs drive quality, with hysteresis so the picture cannot pulse:

- our own draw time against the budget
- **the decoder's dropped-frame count** (`getVideoPlaybackQuality`), sampled as a
  delta. This matters because texture upload and compositing cost GPU bandwidth
  that never appears in a JavaScript timer: a pass can measure 0.8 ms of a
  16.7 ms budget while a quarter of the frames are being dropped
- how long the pressure has persisted

The next callback is requested *before* drawing, and a draw that arrives while
one is in flight is skipped. Visionance therefore always works on the newest
frame and can never accumulate a backlog.

At the floor and still losing frames, `onOverload` fires and the app switches
enhancement off, telling the user why. In `Quality`/`Maximum` the user's choice
stands and they get a warning instead.

### Stream selection

`stream-policy.js` decides how much stream Watch should ask for, from viewport
size, DPR, display size, frame rate, hardware-decode status, the Watch quality
policy and whether enhancement is running. Auto never exceeds 1440p unattended
and caps at 1080p when enhancement is on or hardware decode is unavailable. An
explicit user maximum is honoured exactly.

**The viewport is the requirement; the display is a ceiling on it.** An earlier
version took `max(viewport, screen)` to leave fullscreen headroom, which made
the monitor a *floor*: a 900-line window on a 1440p panel could never ask for
less than 1440p, so Auto's entire purpose was defeated on exactly the machines
that needed it. The relationship is now one-directional - nothing above the
panel's own pixel count can be displayed, so that caps the requirement, and
nothing below the window's is requested.

A rendition within `TOLERANCE` (7%) of the requirement is accepted rather than
climbing a rung. 1150 lines takes 1080p: the alternative is decoding 78% more
pixels to cover a 6% shortfall that is invisible on moving video.

Choosing for the current window means fullscreen does not re-resolve. That is a
stated limitation rather than an oversight - runtime switching means tearing
down and reloading the media element mid-playback.

Hardware decode is read from Chromium itself (`app.getGPUFeatureStatus()`), not
inferred from which GPU is busy: on a hybrid laptop the discrete card sitting at
0% while the iGPU decodes is normal.

### Format ranking, per purpose

Height is a cap, not a ranking. Below it, `pickBest(..., purpose)` orders
candidates differently depending on who is asking:

- **`watch`** — tallest that fits, then the codec most likely to decode in
  hardware (H.264 → VP9 → HEVC → AV1), then the *lower* bitrate. The codec term
  is not an opinion about compression quality: above 1080p YouTube offers only
  VP9 and AV1, and a software AV1 decode at 1080p spends the CPU the shader
  passes need. It also refuses to trade quality for simplicity - a muxed
  rendition wins only if it is within 7% of the split pair's height, so the
  360p progressive format YouTube always offers never gets chosen just to avoid
  a second connection.
- **`quality`** — the previous scoring, kept for offline Create. A render is not
  racing a clock, so it takes the best source available.

The chosen pair is summarised on the descriptor as `selection`, which carries
format ids, codecs, bitrates and whether the stream is split - and no URLs or
headers, so it can be logged and shown.

### The media proxy, and why it chunks

`stream-proxy.js`. Chromium's media stack requests progressive media with one
open-ended `Range: bytes=0-`. Measured against real googlevideo URLs:

```
format             open `bytes=0-`     bounded `bytes=0-N`
1080p avc1 1896k    3717 kbps (2.0x)   119403 kbps (63x)
1080p vp9   999k    2002 kbps (2.0x)   118227 kbps (118x)
1440p vp9  3373k    6607 kbps (2.0x)   118812 kbps (35x)
```

The open-ended form is paced at almost exactly **twice the media's own
bitrate**, whatever that bitrate is. Twice realtime cannot build a buffer
faster than one second per second, so the player never gets ahead and every
hiccup is a stall it cannot recover from. That was the "buffers far slower than
a browser" report, and it was never the user's connection.

So the proxy translates one open-ended client request into a sequence of
bounded upstream requests and stitches them into a single continuous response
body. 2 MiB per request, calibrated rather than guessed: sequential bounded
requests measured 89 Mbps at 1 MiB, 96 at 2 MiB, then 49 at 4 MiB and 8 MiB.

The span is a *request* boundary, never a buffer. Bytes go straight from the
upstream reader to the response as they arrive, and the ReadableStream's `pull`
means nothing is read until the consumer wants it, so peak memory per stream is
tens of kilobytes whatever the file size. Cancelling - a seek, a source switch,
a closed window - aborts the in-flight request instead of paying for bytes
nobody will decode. The video and audio legs are separate `protocol.handle`
invocations and stream independently.

A dropped chunk is retried once: a CDN URL close to expiry loses the odd
request, and failing the whole stream for it would stall playback that could
simply have continued.

`TransferStats` records bytes, chunks, requests, first-byte latency and
throughput per leg, cumulatively - a media element re-requests on every seek, so
per-request counters read zero most of the time and make a healthy stream look
dead.

### Diagnostics

`playback-stats.js` collects presented frames, dropped frames, the median and
p95 presentation interval, jitter, buffer depth and stall counts continuously,
and `window.visionanceDiagnostics.mark()/snapshot()/transfer()/source()`
exposes them. `tools/verify-playback.js` drives three passes (native, enhanced,
compare) and reports the numbers. There is no permanent HUD.

**Presented FPS counts frames, not callbacks.** `requestVideoFrameCallback` is
not guaranteed to fire once per presented frame: when the page is busy - which,
with enhancement on, is exactly when the number matters - the browser coalesces
callbacks and several frames are composited between two invocations. Deriving
the rate from the interval between callbacks therefore under-reports precisely
when it is being read to find out whether playback is smooth. A real 25 fps
stream measured a **49.9 ms median callback interval** on the reference machine
with **zero** dropped frames, which the interval method reports as 20.0 fps.

The metadata carries the compositor's own running total, `presentedFrames`,
for this reason - the spec exposes it so a client can tell that frames were
missed between callbacks. `computePresentationRate()` is therefore
`Δ presentedFrames / Δ wall clock` over a two-second sliding window, and it is
a pure function so all eight of the frame rates that matter (23.976 through 60)
are tested without a display. Counting callbacks remains as a labelled fallback
(`basis: 'callbacks'`) where the metadata is absent, and the panel marks that
estimate as one.

`mediaTime` is tracked alongside and reported separately as `sourceFps` rather
than reconciled with it: 3:2 pulldown genuinely presents more frames than the
source has, and flattening that into one number would be a lie in one direction
or the other.

The engine's frame *budget* comes from the same counter for the same reason. An
inflated interval would hand the governor more time than the media leaves,
which is the opposite of the protection it exists to provide.

---

## Auto

`auto-recipe.js` turns an analysis into a recipe plus an explanation for every
decision. It is conservative by construction and never assumes bigger is better.

Inputs: analysis, content profile, platform, intensity, engine availability.
Outputs: a versioned recipe, `explanations[]`, `warnings[]`, a `cost` class and
the `decisions` it made.

Source quality is judged from bitrate per megapixel normalised to 30 fps
(`poor` < 1.2 Mbps/Mpx, `compressed` < 2.6). Unknown bitrate stays unknown and
turns nothing on. Cost is a class, not an ETA: on a 4 GB laptop GPU a wrong ETA
is worse than none.

---

## Smart Reframe

`ai/tracking.js`. One ffmpeg pass decodes the clip to a 32x18 greyscale grid at
4 fps - about 1.4 MB for a minute of video, and no analysis images on disk.
Per sampled frame it computes inter-frame motion and local edge energy per
column, and takes the weighted centroid plus a confidence from how concentrated
that energy is.

`buildTrajectory()` turns those observations into a crop path with a dead zone
(no jitter on a static subject), a smoothing factor and a maximum step per
second, both taken from the content profile. A hard cut clears the lock so the
crop snaps to the new shot; a low-confidence sample holds the last good
position; no confident sample ever means the crop stays centred.

`buildCropExpression()` compiles the path into a piecewise-linear ffmpeg `crop`
`x` expression, so the crop is part of the normal filter graph - no second pass,
no frame dump, and it composes with chunking because `t` is chunk-relative.

The backend is **saliency, not face detection**, and says so: `TRACKER_BACKENDS`
names the face-detection slot for a future ONNX model, and the backend id is
recorded on every job.

### The control, and keeping it truthful

The backend has existed since session 3, but Create's picker offered only
`fit` / `fit-black` / `fill`, its help text said subject tracking "arrives with
the AI stages", and `applyRecipeToControls()` dropped `framing.tracking` when
reading a recipe back. So Auto could announce "Smart Reframe enabled" while the
control underneath read *centre crop* - and the control is what the render
obeyed. Three separate statements about the same setting, two of them wrong.

There is now one mapping, `FRAMING_CHOICES`, used in both directions:

| Control | `framing.mode` | `framing.tracking` |
|---|---|---|
| Smart Reframe | `fill` | `auto` |
| Centre crop to fill | `fill` | `center` |
| Fit, blurred background | `fit` | `center` |
| Fit, black bars | `fit` | `center` |

`framingChoiceFor()` is its exact inverse, so a recipe round-trips. The job only
runs the tracker for `mode: 'fill'` + `tracking: 'auto'`, which is precisely
what the Smart Reframe row produces. Changing the control by hand marks an Auto
result as edited, and the Queue card reports the backend that actually ran and
the confidence it reached - never "AI framing".

---

## Neural pipeline

When UPSCALE or INTERPOLATE resolve to `pass`, the job takes a different
execution path (`jobs/stages/neural.js`) instead of the fused ffmpeg encode.
Per chunk:

```
decode frames -> Real-ESRGAN -> RIFE (per shot) -> encode chunk (video only)
```

then once for the whole job: concatenate the chunks and mux the original audio.

### Order, and why

**UPSCALE runs before INTERPOLATE.** Real-ESRGAN is by far the more expensive
network, and running it first means it processes the *source* frame count rather
than the interpolated one - for 24 -> 60 that is 2.5x less super-resolution
work. RIFE copes with the resulting large frames through its UHD mode, which
computes optical flow at reduced scale. It is also the order the stage list
already declares, so the plan the user sees is the order that runs.

### Where the filters go

The fused graph is split in two around the network (`buildPreNeuralFilters` /
`buildPostNeuralFilters`):

- **before** - tone map, deinterlace, crop, denoise/deblock. Cleanup belongs
  here: feeding compression artefacts into a super-resolution model teaches it
  to reconstruct the artefacts.
- **after** - scale to the final size, canvas/reframe, sharpen, grade, deband,
  grain, pixel format. Grading belongs here because the network changes the
  image it would be grading.

### Scale is not resolution

`reconstruction.aiMode`/`aiScale` describe **intent**; the model's
`nativeScales` describe **reality**; `resolveOutputGeometry()` decides the
**output**. There is no 1x model, so `realesrgan.planInference()` returns the
scale it will actually run at plus whether a downscale follows, and that string
is shown in the UI and recorded on the job. A "1x AI" that does not exist is
never claimed.

### VRAM

Windows reports VRAM unreliably, so nothing is predicted from it. The first
attempt lets ncnn choose its own tile; an out-of-memory failure halves the tile
(`0 -> 256 -> 128 -> 64`) and retries, bounded. The tile that worked is reported
in `job.aiMetrics.tileSize`. RIFE has no tiling, so its OOM path switches to UHD
mode instead.

OOM is detected from ncnn's own wording (`vkAllocateMemory failed` and friends),
and - deliberately - also from "exited non-zero after producing some but not all
frames", which is what an allocation crash usually looks like from outside.

### GPU choice

`processing.gpu` is `auto` or a device index. `auto` does **not** mean ncnn's
default of device 0: on a laptop that is the integrated GPU sitting next to a
much faster discrete one. `preferredGpu()` ranks the devices ncnn enumerated and
picks the discrete part. The device list comes from a real (immediately killed)
inference, because these tools print their help without ever creating a Vulkan
instance.

### Interpolation timing

`ai/interpolation-plan.js` is pure arithmetic over frame indices, so every
timing rule is unit-testable without a GPU:

- a chunk of `n` frames at `fpsSrc` **displays** for `n / fpsSrc` seconds, so
  the output gets `round(duration * fpsDst)` frames - duration is preserved by
  construction and cannot drift
- output frame `j` sits at `j / fpsDst` and is assigned to whichever **shot**
  contains that timestamp
- each shot is interpolated on its own, so RIFE is never handed a pair spanning
  a cut - not filtered afterwards, never handed over in the first place
- RIFE's `-n` spreads output evenly across its inputs with the last output
  landing *on* the last input, so each shot gets one extra trailing **anchor**
  frame and one extra output, and that final output is discarded. Without this
  every shot would be quietly compressed by one frame interval.

The anchor is the **real** first frame of the next chunk when a shot continues
across a chunk boundary - which is what stops a freeze or a duplicated frame at
the seam - and a copy of the shot's own last frame at a genuine cut or at the
end of the video.

A shot of one frame cannot be interpolated at all; it is held, and the job says
so in its warnings rather than pretending.

### Scene cuts

`ai/scenes.js` runs ffmpeg's `scene` metric over the chunk at reduced size and
parses the `metadata=print` timestamps. Detection failing is not fatal: the
chunk is treated as a single shot, which is the safe direction (fewer
boundaries, never more).

Verified empirically by `verify:ai`: a RED->BLUE fixture renders with 48 red and
48 blue frames and **zero** blended frames with protection on; with protection
off the same fixture produces a blended frame at the boundary.

Cut timestamps are converted to frame indices exactly once. `planInterpolation`
takes indices, never seconds - converting twice turns frame 24 into frame 576,
which lands outside the chunk and silently discards the cut.

### Chunking and disk

Neural chunk length is a disk decision, not a taste one: `neuralChunkSeconds()`
sizes chunks to roughly 3 GB of frames based on resolution, frame rate and
inference scale, clamped to 5-120 s. Only one chunk's frames exist at a time and
they are removed as soon as the chunk is encoded. `estimateWorkingBytes()` is
checked against real free space before the job starts.

Resume is the session-1 checkpoint machinery unchanged: chunk files on disk are
reconciled against the manifest, so a crash at chunk 17 re-renders chunk 17 and
keeps 0-16.

### Audio

Chunks are encoded **video-only**. The original audio is muxed once, at the end,
straight from the source and trimmed to the same span. It is therefore encoded
exactly one time and cannot drift chunk by chunk. RIFE adds frames; it does not
change the timeline.

### Cancellation

A job owns two kinds of child: an ffmpeg process (`control.activeRun`) and a
neural engine (`control.activeAi`). Cancel kills both, by pid and process tree -
never by executable name, so two concurrent jobs running the same engine cannot
kill each other's work.

---

## AI engine lifecycle

`ai/engine-manager.js` owns install/status/removal and nothing about what the
engines do. Engines live in `<userData>/engines/<id>/`, never in the repository.

States: `not-installed -> installing -> ready | broken | unsupported`.

`ready` requires **all** of: the executable exists, at least one model's weights
are present, and a Vulkan device answered. So "installed" can never mean
"downloaded but unusable" - an engine with no weights reports `broken` with
`MODEL_MISSING`, not `ready`.

Downloads (`ai/downloads.js`) go to a `.part` file, resume with a Range request,
are verified before anything is unpacked or executed, unpack to a staging
directory and are swapped into place at the end. A cancelled install leaves no
half-populated engine folder. Where upstream publishes a SHA-256 (nodejs.org) it
is checked; where it does not (the ncnn releases) the size is checked and no
hash is invented.

Stages ask `engines.require(id)` and get either a ready engine or a structured
refusal - `ENGINE_MISSING` with "Settings -> AI engines -> Install", not a
silent fallback to classical processing.

---

## JavaScript runtime for yt-dlp

`js-runtime.js` discovers Deno / Node / QuickJS / Bun and **validates each by
executing it** - a path existing proves nothing. `process.execPath` is Electron,
not Node, so it only counts if it actually answers like Node, which needs
`ELECTRON_RUN_AS_NODE`; that environment is carried with the candidate and
applied to the yt-dlp child, whose own runtime child then inherits it.

The runtime is passed as the bare `--js-runtimes <name>` with the runtime's
directory prepended to the child's PATH - **not** as `RUNTIME:PATH`. The path
form is documented and works from a shell, but breaks when the runtime lives
somewhere with a space in it (the Windows default Node location does); verified
by experiment, yt-dlp then still reports "No supported JavaScript runtime". PATH
injection pins the exact validated binary, works for a managed runtime that is
on no PATH at all, and has no quoting hazard.

If nothing is found, a private Node can be installed into
`<userData>/runtimes/node`, verified against nodejs.org's `SHASUMS256.txt`.

---

## Jobs

### States

```
queued → analysing → running → completed
                  ↘  paused ↗
                  ↘  cancelling → cancelled
                  ↘  failed
ready → queued
interrupted → queued        (resume / retry)
```

`TRANSITIONS` in `job-manager.js` is the authority; an illegal transition throws
rather than silently corrupting the record.

`completed` is reachable **only through verification**. A render that produced a
file ffprobe cannot vouch for becomes `failed` with the failed checks attached.

### Persistence

- `<userData>/jobs/index.json` — the queue. Written to a temp file, fsynced,
  then renamed. The previous good copy is kept as `.bak` and used if the live
  one fails to parse; if both are gone the index is rebuilt from per-job
  manifests.
- `<userData>/work/<jobId>/` — `manifest.json`, `chunks/`, `tmp/`, `job.log`.

Never persisted: stream session tokens and direct CDN URLs. A remote job keeps
the *page* URL and re-resolves, because a stored CDN URL would be dead by the
time the job runs again.

On load, anything claiming `analysing`/`running`/`cancelling` becomes
`interrupted` with a recoverable error — the process that was rendering it is
gone, and showing a progress bar that will never move would be a lie.

### Output safety

Renders are written to `<output>.vspart` next to the destination, verified, then
renamed into place. A failed, cancelled or crashed render can never leave
something that looks like a finished file. (The muxer is named explicitly with
`-f` because ffmpeg cannot infer it from `.vspart`.)

### Chunking, pause and resume

`chunking.planChunks()` produces deterministic time ranges. `auto` only chunks
when a stage requires it — chunking costs an extra keyframe per boundary and a
concat pass, so it is not imposed on renders that do not need it. Users can
force it on to make a long render pausable.

Pause is offered **only** where it is real: at a chunk boundary. A single-pass
ffmpeg render cannot be suspended and resumed safely, so `pause()` refuses with
`PAUSE_UNSUPPORTED` instead of killing the process and calling it paused. The UI
reads `job.pauseSupported` and does not show a button that would lie.

Checkpoints are idempotent and reconciled against the filesystem on resume: a
chunk the manifest calls finished but whose file is missing gets redone.

---

## Online video

Policy, in order:

1. **Anonymous.** An ordinary public link never causes Visionance to read the
   browser cookie jar. That is a credential store; touching it "just in case" is
   both a privacy problem and a common cause of failures on links that needed no
   authentication at all.
2. **Escalate only on a matching failure.** `planAttempt()` is a pure function:
   given the previous error it returns the next attempt or `null`. A JS-runtime
   complaint escalates to a JavaScript runtime; an auth complaint escalates to
   the user's configured method. Each escalation is offered at most once, and
   only if the installed yt-dlp advertises support for it.

There is no anti-bot circumvention and there should never be.

### Capability detection, not hardcoded flags

Recent yt-dlp builds need an external JavaScript runtime for some extractors and
the option spelling has changed more than once. `capabilities()` runs
`--version` and `--help` on the *installed* binary, parses every advertised
`--flag`, and picks how to configure a runtime:

1. a first-class flag (`--js-runtime` / `--jsi`) if the build has one, else
2. `--extractor-args youtube:jsi=<runtime>` if the help text shows this build
   knows about JS interpreters at all, else
3. nothing — and a `JS_RUNTIME_REQUIRED` error that says what is missing.

Runtimes are discovered on PATH (Deno, Bun, Node, QuickJS). Node is always
offerable because Visionance ships on one; its directory is prepended to the
child's PATH so yt-dlp can find it.

### Structured errors

Raw yt-dlp stderr never reaches the UI. `classifyError()` maps it onto:

`UNSUPPORTED_URL` · `VIDEO_UNAVAILABLE` · `AUTH_REQUIRED` · `AGE_RESTRICTED` ·
`REGION_RESTRICTED` · `JS_RUNTIME_REQUIRED` · `COOKIE_FAILURE` ·
`NETWORK_TIMEOUT` · `YT_DLP_MISSING` · `YT_DLP_OUTDATED` · `NO_PLAYABLE_FORMAT` ·
`UNKNOWN`

Every structured error carries `{ code, message, technicalDetails, recoverable,
suggestedAction }`. `message` is for the user, `technicalDetails` for the log.

### Streams, headers and expiry

A resolved video can be one muxed URL or a **split** video/audio pair from
different hosts with different required headers. `stream-session.js` keeps both
sets behind a token; the renderer receives only the token.

`vs://app/__media?src=remote&t=<token>&s=video|audio` resolves the URL and the
correct header set inside the main process. The renderer cannot supply a URL, so
the privileged fetcher is not usable as a general proxy, and a refreshed session
is picked up automatically.

Expiry is read from the URL (`expire=`) rather than assumed. With no stated
expiry a session is treated as stale after three hours. `refreshStream()`
re-resolves with the policy that worked last time.

---

## Security posture

- `contextIsolation: true`, `nodeIntegration: false`, explicit IPC only.
- Every IPC handler validates its input and returns a structured failure rather
  than throwing across the bridge.
- Renderer assets *and* media are served over one custom `vs://app` scheme.
  Same-origin media matters: a cross-origin `<video>` would taint the WebGL
  canvas and make reading enhanced frames impossible.
- Asset paths are re-checked after joining, and job workspaces reject path
  traversal and malformed job ids.
- Certificate verification is on. `--no-check-certificate` was removed.
- `errors.redact()` / `redactHeaders()` / `redactArgs()` scrub cookies,
  authorization headers and signed URL parameters before anything is logged.
  Verified by test.

---

## Development mode

DevTools open only when development is explicitly requested:

```
npm run dev                  electron . --dev
RUN_VISIONANCE.cmd --dev     launcher passes --dev through
VISIONANCE_DEV=1             environment override
```

Being unpackaged is no longer treated as being in development, so a user who
double-clicks `RUN_VISIONANCE.cmd` gets the app, not a detached inspector.
*View → Toggle Developer Tools* still works everywhere.

---

## Logging

`logger.js` writes one line per event to `<userData>/logs/main.log` (rotating at
2 MB) and mirrors to the console: state transitions, stage boundaries,
resolution attempts, capability probes, verification results, failures. Values
pass through the redactor. Per-frame telemetry belongs in `debug`, which is off
unless `VISIONANCE_LOG=debug`.

---

## Verification

| Command | What it proves |
|---|---|
| `npm run verify:core` | Recipe schema, chunk planning, workspace path safety, error classification, yt-dlp policy and argument construction, ffmpeg builders. No network, no binaries. |
| `npm run verify:watch` | Stream-height policy against real viewport/display combinations and every quality mode, Watch codec ranking against a real YouTube format list, the ranged proxy (chunking, exact byte ranges, backpressure, cancellation, retry, header hygiene, accounting), presentation-rate maths at eight source frame rates including coalesced callbacks and 3:2 pulldown, and the framing control mapping in both directions. No network, no binaries, no GPU. |
| `npm run verify:switch` | Boots the app and drives real source changes through the real controls - fresh→local, local→local, local→URL, URL→local, URL→URL, while playing and while paused, with enhancement on and off - plus both directions of the stale-resolution race against a deliberately slow resolver, Play-button semantics, URL normalisation, session release, and a Smart Reframe render started from the Create panel and ffprobed for 9:16 geometry, audio and duration. |
| `npm run verify:gl` | Every shader compiles and links in a real GL context; each preset renders and differs measurably from a neutral resample. |
| `npm run verify:export` | Real ffmpeg renders through the real JobManager: geometry, platform canvases, fps conversion, audio, chunk-and-join, cancellation, verification failure, persistence and crash recovery. |
| `npm run verify:ai` | Interpolation timing across nine real frame rates, cut handling, engine lifecycle, OOM/Vulkan interpretation, GPU ranking, disk estimation - then **real** Real-ESRGAN and RIFE inference on tiny clips, including the RED/BLUE cut fixture. Prints whether the real half ran. |
| `npm run verify:creator` | Auto's decisions against nine source shapes, Smart Reframe trajectories (subject left/right, hard cut, lost detections, no detections, profile responsiveness), colour and audio chains, export presets, then real renders including a 9:16 Smart Reframe and each mastering preset. |
| `npx electron tools/verify-playback.js` | Frame pacing on real media: dropped frames, cadence, jitter and buffer for native, enhanced and compare passes. |
| `npm run verify:app` | Boots the app and drives the preload bridge; with `VISIONANCE_TEST_VIDEO` it decodes a clip through `vs://` and runs a complete render over IPC, and with `VISIONANCE_TEST_URL` it resolves a real public link and asserts picture *and* sound advance. |
