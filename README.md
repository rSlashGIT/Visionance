# Visionance

Two things, one app.

**Watch** — play a local file or paste a link, and Visionance upscales, cleans
and grades every frame on your GPU as it plays. No download, no re-encode, no
waiting.

**Create** — take a finished edit and render an upload-ready file: analyse the
source, repair it, rescale it, reframe it for Shorts or Reels, grade, handle
audio, encode, and verify the result before calling it done.

The problem Watch solves: a 1080p stream and a 4K file often look far more
similar than the 20 GB size difference suggests, because most of what you notice
is compression damage, not missing resolution. Visionance repairs the damage and
reconstructs edges live, so you get most of the "premium" look from the file you
already have.

> Watch and Create are **different engines** — GLSL per frame versus an ffmpeg
> filter graph. They share intent, not arithmetic. A render is *based on* your
> preview, never pixel-identical to it, and the app says so rather than
> pretending otherwise.

---

## Watch

### What it actually does

Every frame runs through four shader stages before it reaches the screen:

| Stage | Runs at | What it fixes |
|---|---|---|
| **Restore** | source resolution | Edge-aware denoise and compression-artefact cleanup. Runs *before* scaling so noise is never magnified. |
| **Reconstruct** | output resolution | Catmull-Rom resampling plus edge-directed correction, which removes staircase edges instead of blurring them. Optional line darkening keeps animation line art from fading out. |
| **Sharpen** | output resolution | AMD-style contrast-adaptive sharpening: strong where the picture is soft, restrained where it is already detailed, with halo suppression. |
| **Finish** | output resolution | Debanding, local contrast, filmic tone curve, colour, bloom, grain, vignette. |

Nothing is written to disk during playback. Rendering happens in a WebGL2
context using half-float intermediates where the GPU supports them.

### Presets

Nine built-ins, each tuned for a specific failure mode rather than a vague
"quality" dial:

`Original` · `Balanced` · `Streaming Rescue` · `Anime / Animation` ·
`Film / Cinematic` · `Sports / Motion` · `Low Light` · `Screencast / Text` ·
`Vivid Showcase`

Every parameter is exposed in the **Adjust** tab, and any combination can be
saved as your own preset.

### Playback comes first

With enhancement **off**, Visionance gets out of the way completely: the
`<video>` element itself is the picture, Chromium decodes and composites it
directly, and the WebGL loop is stopped — not hidden, stopped. There is no
per-frame texture upload, no shader pass and no canvas presentation. That is the
playback baseline, and on the reference laptop it measures 0 dropped frames with
0.1–0.3 ms of frame-interval jitter at 1080p60.

With enhancement **on**, a governor protects the motion:

- the frame budget comes from the *source* cadence, so a 24 fps film gets
  41.7 ms per frame rather than being judged against 16.7 ms
- the governor watches the decoder's own dropped-frame count, not just our
  render time — uploading a 1080p frame costs GPU bandwidth that never appears
  in a JavaScript timer
- if a frame arrives while the previous one is still being drawn, the stale work
  is skipped rather than queued, so Visionance can never fall behind the clock
- if it still cannot keep up at the lowest quality, **enhancement switches
  itself off** and tells you why. A sharper picture that stutters is not a trade
  worth making silently.

**Playback quality** (Watch tab): `Auto`, `Performance`, `Balanced`, `Quality`,
`Maximum`. Auto seeks the best quality that keeps motion smooth. None of these
affect Create's offline AI quality — that is a separate setting.

**Stream quality is chosen for your window**, not for the biggest number a site
offers, and not for the size of your monitor. The requirement is the *video
area* in device pixels; the display is a ceiling on that, never a floor. A
900-line window on a 1440p panel therefore asks for 1080p, because a 1440p
rendition decoded into it costs decode bandwidth to produce pixels nobody can
see. Viewport size, DPR, display, frame rate, hardware-decode status and
whether enhancement is running all feed the decision, and the app shows what it
actually chose. Settings → Online video → *Maximum stream height* overrides it
exactly.

**Codec matters as much as resolution for Watch.** Above 1080p, YouTube offers
only VP9 and AV1 — and AV1 has no hardware decode on most of the hardware this
app runs on, so a "better" rendition can mean a software decode that eats the
CPU budget the shaders need. Watch therefore prefers H.264, then VP9, then
HEVC, then AV1 at a given size. Offline Create takes the opposite view and
keeps the highest-quality source it can get, because a render is not racing a
clock.

**Buffering is chunked, deliberately.** A `<video>` asks for the rest of the
file in one open-ended `Range: bytes=0-` request, and YouTube's CDN paces that
at almost exactly twice the media's own bitrate — measured at 2.0× for three
different formats. Twice realtime sounds survivable and is not: the buffer can
only grow one second per second, so it never gets ahead, and every hiccup is a
stall. A bounded range gets full line rate — measured 35× to 118× faster on the
same URLs — so Visionance's media proxy turns one open-ended request into a
sequence of bounded ones and stitches them back into a single response. Bytes
pass straight through to the player as they arrive; nothing is accumulated in
memory or written to disk.

### Other things worth knowing

- **Split compare** — drag a divider across the frame to see original versus
  enhanced on the same moving picture.
- **Adaptive quality** — if the GPU can't hold the frame budget, the render
  resolution drops instead of the playback stuttering. It never goes below the
  source resolution, because that would destroy real detail.
- **Auto render resolution** — renders exactly enough pixels to saturate your
  display, capped at 4×. No point computing 8K for a 1080p panel.
- **Resume, recents, snapshots, picture-in-picture** — the picture-in-picture
  window shows the *enhanced* frame, not the raw video.

---

## Create

The **Create** tab renders a real file with ffmpeg, and the **Queue** tab tracks
it.

**Create has its own source.** Choose a file, paste a URL, or press *Use current
Watch video* — and whatever Watch is playing keeps playing. The two used to
share one source object, so picking something to render changed what was on
screen, and opening something to watch silently re-aimed the render you were
setting up. A render also takes an immutable snapshot of its source when you
press the button: changing the Create panel afterwards, or opening something
else in Watch, cannot re-aim a job that is already running.

What works today:

| Setting | What it does |
|---|---|
| **Target** | Custom, YouTube, YouTube 4K, YouTube Shorts, Instagram Reels, Instagram feed (4:5), TikTok. *Seeds* aspect ratio, resolution, container, codec and audio bitrate — and then gets out of the way. |
| **Aspect ratio** | Source, 16:9, 9:16, 4:5, 1:1, 21:9, 2.39:1, or a custom `w : h`. A first-class control: you never have to pretend to target TikTok to get a vertical crop. |
| **Output resolution** | The ratio's suggestion, source, a fixed size up to 4K, or custom dimensions. While it is on *Suggested* a ratio change moves it; once you type a size, that size is kept and any mismatch with the ratio is explained rather than stretched away. |
| **Reframing** | Smart Reframe (follows the subject), centre crop to fill, letterbox on a blurred copy of the frame, or letterbox on black. Shown whenever the target reshapes the canvas. |
| **Frame rate** | 24 / 25 / 30 / 48 / 50 / 60 / 120, or keep the source rate. Classical conversion duplicates and drops frames; AI interpolation (below) generates new ones. |
| **Encoder** | Automatic (prefers a detected hardware encoder) or an explicit one. NVENC / Quick Sync / AMF / VideoToolbox / VA-API when ffmpeg reports them. |
| **Apply the look from the player** | Turns the current preview parameters into a starting recipe: denoise, artefact cleanup, debanding, grain, sharpening, contrast/brightness/saturation/gamma. |
| **Audio** | Keep or drop; optional single-pass loudness normalisation to −14 LUFS. |
| **Chunked render** | Renders in segments and joins them losslessly, which makes the job pausable at a segment boundary. |

### Auto

Press **Suggest settings** and Visionance reads the source and proposes a
recipe — then tells you, in sentences, why. It is deliberately conservative: the
hard part of Auto is knowing when *not* to enhance.

```
1080p source is already clean          -> neural 4x skipped
23.976 fps cinematic source            -> original frame rate preserved
Low source bitrate                     -> light restoration enabled
9:16 output requested                  -> Smart Reframe enabled
Real-ESRGAN is not installed           -> classical resampling used instead
```

It never assumes 4x beats 2x, 60 fps beats 24, or that more sharpening is
better. Content profiles: `Auto / General`, `Film / Cinematic`,
`Action / Sports`, `Gaming`, `Animation / Anime`, `Dialogue / Podcast`,
`Low Light`, `Screencast / Text`. Intensity: `Light`, `Balanced`, `Strong`,
`Maximum`.

Auto is also **performance-aware**: it chooses an inference quality, not just a
scale. Only an explicit *Maximum* intensity reaches the full-pixel 4× path; a
badly damaged source climbing a long way (480p → 1080p) earns full-size
inference at *Strong*; everything else reaches the scale the cheap way. Left at
the old default, a 2× request on general footage ran the 4× network over every
source pixel — 12.66 s per 720p frame, or roughly 53 minutes for a ten-second
clip. That is not a default; that is a surprise.

Auto only ever *proposes*. The result is an ordinary recipe you can edit, and
changing one control does not reset the rest.

### Knowing what a render will cost

Every job carries a cost class — `Fast`, `Moderate`, `Heavy`, `Very heavy` —
and Create shows it *before* you render, with the reasoning:

```
HEAVY     1920×1080 · realesrgan-x4plus at x4 on 1280×720 frames
          ≈ 32m of inference · roughly 32 minutes on hardware like this
MODERATE  1920×1080 · realesrgan-x4plus at x4 on 640×360 frames
          ≈ 8m of inference · roughly 8 minutes on hardware like this
```

Crucially this is derived from the **resolved** plan — after the engine planner
has chosen a model and decided whether the network runs on full-size or
pre-scaled frames — not from the recipe beforehand. A job that is about to run
x4 inference can never be labelled `Fast`, which is what the old estimate did.

Once enough frames have genuinely been processed, the Queue replaces the class
with a measured rate and a remaining time:

```
13%   0.42 fps   126/300 frames   ~7m left
```

Nothing is estimated before there is data to estimate from: the first frames of
a neural job include model load, Vulkan warm-up and the tile search, so until
twelve frames and eight seconds are behind it the queue says `measuring rate…`
rather than a number that would be wrong.

### Smart Reframe (16:9 → 9:16)

Turning a landscape edit into a Short with a static centre crop usually cuts the
subject in half. Smart Reframe samples the video at low resolution, finds where
the interesting content is, builds a smoothed crop path and applies it as part
of the normal filter graph.

- **Backend: motion + detail saliency.** This is *not* face detection — it finds
  the moving, in-focus subject, which covers most creator footage. The backend
  id travels with every job so the app never claims more than it does. A
  face/person detector is the obvious upgrade and the interface is built for it.
- **Scene cuts reset the tracker.** At a hard cut the crop snaps to the new
  shot's subject rather than gliding across, which would look like a camera move
  that never happened.
- **Motion is profile-aware.** Film and Dialogue track calmly; Action and Gaming
  respond faster. A stationary subject gets a genuinely static crop.
- **Fallbacks are stable.** A lost detection holds the last good position; a clip
  with nothing trackable stays centred and says so. Tracking failing never fails
  the export.
- **It is a control, not a hidden mode.** Whenever the output ratio differs
  from the source, Create's *Reframing* picker offers `Smart Reframe (follow
  the subject)`, `Centre crop to fill`, `Fit, blurred background` and `Fit,
  black bars`. Smart Reframe is the default, Auto selects it for a 9:16 target,
  and the choice survives a round trip through the recipe — so what the control
  shows is what the render executes.
- **The Queue reports one reconciled account of what happened**, not three
  competing ones:

  ```
  Smart Reframe · Motion & detail saliency
  Tracked 34 of 40 samples · confidence 78%
  4 scenes · 6 held near the previous crop
  ```

  `tracked + held + centred` always equals the sample count, confidence is the
  mean over the samples that were *used* rather than over every sample the
  detector looked at, and the warning — when there is one — comes from the same
  summary as the numbers. A failure message can no longer appear beside a
  fabricated success metric. If tracking genuinely fails, the card says
  `Subject could not be tracked reliably; centre framing was used.` and quotes
  no confidence at all.

### Colour and audio finishing

Colour finishing runs *after* any neural stage, because the network changes the
image being graded: exposure/contrast/gamma, saturation, sharpen, deband, grain,
plus HDR→SDR tone mapping when the ffmpeg build can do it (and an honest warning
when it cannot).

Audio mastering is four opinionated chains built from standard ffmpeg filters —
Visionance is not a DAW, and conventional EQ is never labelled "AI voice
isolation":

| Preset | What it does |
|---|---|
| **Preserve** | Nothing at all. |
| **Normalize** | Loudness only, to −14 LUFS. |
| **Creator Master** | Gentle 2:1 glue compression, loudness, true-peak limiter. |
| **Dialogue Focus** | De-rumble, a small 3 kHz presence lift, 3:1 compression, loudness, limiter. |

Audio is encoded exactly once, at the final mux, so it cannot drift chunk by
chunk no matter how the video was processed.

### Export presets

`YouTube Short — Quality` · `Instagram Reel — Quality` ·
`Instagram Feed — Quality` · `YouTube 1080p` · `YouTube 1440p` ·
`YouTube 4K` · `High Quality Master`

A preset seeds canvas, resolution, codec, quality and audio; it never drags a
24 fps film up to 60 just because the platform allows it. You can also save your
own named recipes (Movie Shorts, Gaming 60, Anime 60 …) and reload them later.

### AI enhancement

Two neural engines run locally on your GPU through Vulkan. They work on NVIDIA,
AMD and Intel hardware, and need **no Python, no PyTorch, no CUDA toolkit and no
conda environment** — Visionance downloads and manages them, and nothing has to
be configured in a terminal.

| Control | What it does |
|---|---|
| **Neural enhancement** | `Off`, `Restore` (repair at the current size), `Upscale 2×`, `Upscale 4×` — Real-ESRGAN. |
| **Inference quality** | `Fast`, `Balanced`, `Quality`, `Maximum` — how much inference to spend reaching that scale. Four genuinely different paths, not four names for one. |
| **Model** | `Auto`, `General` (live action), `Animation` (anime/cel). |
| **Interpolation** | `Off`, `Classical` (ffmpeg duplicates frames), `AI` (RIFE invents new ones). These are never conflated. |
| **Scene-cut protection** | Detects hard cuts and interpolates each shot separately. |
| **Advanced** | GPU choice, manual tile size, scene-cut sensitivity, installed model list. |

**About inference quality, honestly.** Output scale and inference quality are
different questions. `realesrgan-x4plus` has 4× weights and nothing else, so
reaching 2× with it is a *choice*, and the wrong choice costs hours. Measured
on the reference laptop (GTX 1650 Ti, 8 frames per run):

| 720p source → 2× output | seconds/frame |
|---|---|
| 4× network on the full frame, Lanczos back down | **12.66** |
| 4× network on a half-size frame, exact 2× | **3.61** (3.5× faster) |
| `realesr-animevideov3` native 2× | **0.64** (19.9× faster) |

So the four modes take four different routes:

| Mode | With native weights at the scale | Without them (General 2×) |
|---|---|---|
| **Fast** | native inference | **no inference** — classical reconstruction, and it says so |
| **Balanced** | native inference | 4× network on a half-size frame → exact 2× |
| **Quality** | native inference | 4× network on every source pixel → Lanczos down |
| **Maximum** | largest native scale → Lanczos down | largest native scale → Lanczos down |

For General at 2× that is three implementations, not four: Quality and Maximum
converge, because there is no larger native scale for `realesrgan-x4plus` to
reach for. The panel says so — it describes the plan the engine actually
resolved rather than four descriptions of one thing.

The Balanced row is a real technique, not a shortcut: these networks are
trained to reconstruct from degraded low-resolution input, so a half-size frame
into a 4× model is exactly the job they were built for, and cost follows input
area. It *is* lower fidelity than Quality — half the source detail never
reaches the network — which is why it is called Balanced, and why the panel
says which path it took.

**Is there a native General 2× model?** No, and Visionance does not pretend
otherwise. `RealESRGAN_x2plus` exists upstream as PyTorch weights, but the
official ncnn portable release ships no x2 param/bin for it, and community
conversions have no published provenance or checksums. Native 2× exists only
for the Animation model (`realesr-animevideov3`), where it is used by every
quality mode because it is both real and fast.

**About scale, honestly.** These models have a native scale baked into their
weights and there is no 1× model. So:

- *Restore* is a real inference at the model's native scale followed by a
  high-quality Lanczos downscale back to the source resolution. The network
  still removes compression damage and rebuilds detail — but it is not a "1× AI
  model", and the app says so in the panel.
- *Upscale 2×* with the **Animation** model is a native 2× pass. With
  **General** (which is 4×-only) it runs at 4× and is downscaled, which is
  slower; the panel tells you before you start.
- Neural inference scale and final output resolution are separate settings. You
  can restore a 720p clip and output 1080p, or upscale 1080p and output 4K.

If an engine is not installed, its options are **disabled** and an *Install AI
engines* button appears. AI upscaling never silently becomes Lanczos, and AI
interpolation never silently becomes ffmpeg's `minterpolate`; a job that asks
for an engine you do not have fails immediately with "install it" rather than
quietly producing something else.

**VRAM.** Tiling shrinks automatically when the GPU runs out of memory
(auto → 256 → 128 → 64) and the tile that worked is recorded in the job's
metrics. RIFE switches to UHD mode for large frames. Nothing is hardcoded for a
particular card; a machine with two GPUs gets the discrete one by default.

**Disk.** Neural work needs frames on disk. Only one chunk's frames exist at a
time and they are deleted as soon as that chunk is encoded, so a 90-minute
source costs about the same working space as a 20-second one. A job that
obviously will not fit is refused before it starts rather than filling your
system drive.

Every completed render is **ffprobe-verified** before the job reports success:
the file exists, is non-trivial, decodes, has a plausible duration, matches the
requested resolution and frame rate, and has audio when audio was asked for. If
a check fails the job fails and says which check.

The queue survives restarts. A render that was in progress when Visionance
closed comes back as **interrupted** — resumable, and never shown as still
running.

### What Create does *not* do yet

Speech transcription, subtitles, and **semantic** subject tracking — a face or
person detector — are absent. Smart Reframe tracks motion and detail saliency,
which is a different and more modest thing, and the UI says so rather than
calling it face AI. Nothing in the UI claims a capability that is not
implemented.

Visionance is a finishing processor, not an editor. There is no timeline, no
transitions, no keyframe animation — bring a finished edit.

---

## Run it

**Double-click `RUN_VISIONANCE.cmd`.**

That's it. It installs anything missing and opens the app.

<details>
<summary>Prerequisites and other scripts</summary>

**Prerequisite:** [Node.js](https://nodejs.org) 22.12 or newer. Nothing else —
no Docker, no database, no separate backend. If Node is missing, the launcher
says so and links you to the installer.

You also need a GPU with WebGL2 (anything from roughly 2014 onwards).

| Script | What it does |
|---|---|
| `RUN_VISIONANCE.cmd` | Checks prerequisites, installs dependencies if needed, starts the app |
| `RUN_VISIONANCE.cmd --dev` | The same, with DevTools open |
| `STOP_VISIONANCE.cmd` | Stops a running instance. Never deletes anything |
| `RESET_VISIONANCE.cmd` | Deletes `node_modules`, `dist`, `logs`. Asks for confirmation first; leaves your source, Git history and saved presets alone |

### Developer mode

DevTools open **only** when you ask for them: `npm run dev`,
`RUN_VISIONANCE.cmd --dev`, or `VISIONANCE_DEV=1`. Running from source is no
longer treated as being in development, so a normal launch gives you the app
rather than a detached inspector. *View → Toggle Developer Tools* still works in
every build.

The first run downloads the Electron runtime (~200 MB) and takes a few minutes.
Later runs start immediately. Logs stream in the console window and are written
to `logs/`.

On macOS or Linux, use `npm install && npm start`.

### External tools

| Tool | Needed for | How it's found |
|---|---|---|
| **ffmpeg / ffprobe** | Create renders, source analysis | Bundled via `ffmpeg-static`; a system install or a manual path set in Settings also works |
| **yt-dlp** | Playing online links | Not bundled. Settings → *Install* downloads the latest build into your user data folder |

Both can be overridden from **Settings** if you keep your own builds.

### Dependency install scripts

npm v12 blocks dependency install scripts by default. This project approves
exactly one, in the `allowScripts` field of `package.json`:

- `ffmpeg-static` — **approved**. It is a direct dependency and its install
  script downloads the ffmpeg binary the Create tab needs.
- `electron-winstaller` — **denied**. It arrives transitively with
  electron-builder and is only used by the Squirrel.Windows target, which this
  project does not build (it builds NSIS and portable).

Electron needs no approval: since v43 it has no install script and fetches its
runtime on first use instead.

</details>

---

## Building installers

```bash
npm run dist:win     # NSIS installer + portable exe
npm run dist:mac     # dmg
npm run dist:linux   # AppImage + deb
```

To ship ffmpeg and yt-dlp inside the installer, drop the binaries into `bin/`
before building — see `bin/README.md`.

---

## Keyboard

| Key | Action |
|---|---|
| `Space` / `K` | Play / pause |
| `←` `→` | ±5 s (hold `Shift` for ±60 s) |
| `J` / `L` | ±10 s |
| `↑` `↓` | Volume |
| `0`–`9` | Jump to 0–90% |
| `M` | Mute |
| `F` | Fullscreen |
| `C` | Split compare |
| `B` | Toggle enhancement |
| `S` | Save the current enhanced frame as PNG |

---

## Architecture

```
src/
  main/
    main.js             Window, menus, the vs:// protocol, IPC surface
    preload.js          The only renderer<->Node bridge (context-isolated)
    binaries.js         Locates/downloads ffmpeg, ffprobe, yt-dlp
    store.js            Atomic JSON store for settings, presets, recents
    logger.js           Structured logging with secret redaction
    errors.js           Structured error codes + redaction helpers
    capabilities.js     OS, CPU, GPU, encoder and filter detection
    media-analyzer.js   ffprobe -> one normalised analysis shape
    recipe.js           Versioned processing recipe (intent, validated)
    ytdlp.js            URL resolution policy and capability detection
    stream-session.js   Stream tokens, per-leg headers, expiry, refresh
    ffmpeg/             encoders · filters · command · process
    jobs/               job-manager · job-store · workspace · chunking ·
                        pipeline · stages/{encode,mux,verify}
  renderer/
    index.html          UI shell
    styles.css          Theme
    js/shaders.js       GLSL ES 3.00 sources for all four passes
    js/engine.js        WebGL2 context, framebuffers, frame loop, adaptive quality
    js/presets.js       Built-in presets and the slider definitions
    js/app.js           UI wiring
docs/architecture.md    How the pieces fit, and why
tools/                  Verification harnesses (dev only, not shipped)
```

[docs/architecture.md](docs/architecture.md) covers the recipe schema, the stage
model, job persistence and crash recovery, and the online-video policy.

### Security posture

- `contextIsolation: true`, `nodeIntegration: false`; the renderer sees exactly
  the methods listed in `preload.js` and nothing else.
- A Content-Security-Policy restricts the page to its own origin.
- Renderer assets *and* media are served over one custom `vs://app` scheme.
  Same-origin media matters: a cross-origin `<video>` would taint the WebGL
  canvas and make reading enhanced frames impossible.
- Remote streams are proxied through the main process, which is also how
  yt-dlp's required request headers get applied. The renderer holds an opaque
  session token, never a URL or a header, so the privileged fetcher cannot be
  used as a general-purpose proxy.
- Cookies, authorization headers and signed URL parameters are stripped before
  anything is logged, and are never written into a saved job.
- Certificate verification is on for every yt-dlp call.
- External links open in the system browser; the window itself can't navigate
  away from the app.

---

## Online video

Public links are resolved **anonymously**. Visionance does not read your
browser's cookie jar to play an ordinary video — that is a credential store, and
reaching for it "just in case" is both a privacy problem and a common cause of
failures on links that never needed authentication.

If a site specifically says a video needs a signed-in account, and only then,
Visionance escalates once to whatever you configured under **Settings → Online
video → Sign-in for restricted videos**: cookies from a named browser, or a
`cookies.txt` file. Choosing nothing means public videos only. There is no
anti-bot circumvention.

Modern yt-dlp needs an external JavaScript runtime to read YouTube. Without one
it does not fail outright — it *succeeds badly*, returning a handful of formats
the player cannot use, which is far harder to diagnose than an error. So
Visionance:

1. reads the installed yt-dlp's own `--help` to see which spelling that build
   supports (current builds take `--js-runtimes RUNTIME[:PATH]`; older ones used
   other flags),
2. finds a runtime — Deno, Bun, Node or QuickJS — and **validates it by running
   it**, rather than trusting that a path exists,
3. passes it on the *first* attempt, not as a retry.

Node is normally already present, since Visionance runs on it. If nothing is
found, **Settings → JavaScript runtime → Install** fetches a private copy of
Node into your user data folder, verified against nodejs.org's published
SHA-256. Nothing is installed system-wide.

Failures arrive as categories — `AUTH_REQUIRED`, `AGE_RESTRICTED`,
`REGION_RESTRICTED`, `JS_RUNTIME_REQUIRED`, `COOKIE_FAILURE`, `NETWORK_TIMEOUT`,
`YT_DLP_OUTDATED`, `NO_PLAYABLE_FORMAT` and friends — each with a plain-English
message and a suggested next step. Technical detail goes to the log, not the UI.

Visionance streams; it does not download or store copies. You are responsible
for only using it with content you are entitled to access, and for complying
with the terms of service of the sites you point it at. yt-dlp is not bundled —
the app downloads it on request.

---

## Verification

Nine harnesses:

```bash
npm run verify:creator   # Auto decisions, Smart Reframe trajectories, colour
                         # and audio chains, export presets, and real renders
npm run verify:core      # recipe schema, chunk planning, path safety, error
                         # classification, yt-dlp policy and format selection,
                         # JS runtime discovery, ffmpeg builders
npm run verify:watch     # stream-height policy, Watch codec ranking, the
                         # chunked range proxy, presentation-rate maths at
                         # eight source frame rates, framing control mapping
npm run verify:create    # aspect-ratio geometry and validation, resolved-plan
                         # cost classification, Auto's inference-quality
                         # decisions, Smart Reframe telemetry consistency
npm run verify:switch    # boots the app and drives real source switching
                         # through the real controls: local↔URL↔URL, races,
                         # Play-button semantics, Watch/Create independence,
                         # job source snapshots, background rendering, and a
                         # Smart Reframe render started from the Create panel
npm run verify:gl        # compiles every shader in a real GL context,
                         # renders each preset, checks for GL errors
npm run verify:export    # real ffmpeg renders through the real job system:
                         # geometry, platform canvases, fps, audio, chunking,
                         # cancellation, verification failure, crash recovery
npm run verify:ai        # interpolation timing, engine lifecycle, OOM handling,
                         # then REAL Real-ESRGAN and RIFE inference on tiny clips
npm run verify:ai:core   # the same without touching the GPU
npm run verify:app       # boots the app and asserts the IPC bridge, engine
                         # and UI all came up
npm run verify           # all of the above

# measure real frame pacing: dropped frames, cadence, jitter, buffer health
VISIONANCE_TEST_VIDEO=clip.mp4 npx electron tools/verify-playback.js
VISIONANCE_TEST_URL=https://... npx electron tools/verify-playback.js

# add a real playback pass and a full render over IPC to the boot test
VISIONANCE_TEST_VIDEO=/path/to/clip.mp4 npm run verify:app

# add a real public URL to the boot test: resolves it and asserts that the
# picture AND the sound actually run
VISIONANCE_TEST_URL=https://www.youtube.com/watch?v=... npm run verify:app
```

`verify:ai` prints whether the real engines were exercised or only the adapter
logic, and never conflates the two: if no engine is installed it says
`Real neural inference: NOT TESTED` and still exits non-zero on any core
failure.

`verify:core`, `verify:watch`, `verify:create` and `verify:export` need no
network and do not depend on any particular website being reachable. On a headless Linux box, prefix the Electron
harnesses with `xvfb-run -a`.

---

## Known limitations

- **Pause only works on chunked renders.** A single-pass ffmpeg render cannot be
  suspended and resumed safely, so the app refuses instead of pretending. Turn
  on *Chunked render* in Create to make a job pausable.
- **Online sources cannot be resumed after a restart** unless the page URL was
  recorded; direct CDN URLs expire and are never persisted.
- **Live streams cannot be rendered** to a file.
- **HDR tone mapping needs an ffmpeg build with `zscale`.** Without it the tone
  map is skipped and the job says so.
- **Smart Reframe is saliency-based, not face detection.** It follows motion and
  detail, which suits most footage but can prefer a moving hand over a still
  face. A face/person detector is the planned upgrade.
- **The stream quality is chosen once, when the video is opened.** Going
  fullscreen afterwards does not re-resolve to a larger rendition, and a
  sustained-buffer downgrade is not implemented either. Runtime switching would
  mean tearing down and reloading the media element mid-playback, which is a
  worse experience than the occasional mismatch; choosing well up front is the
  trade this build makes. An explicit *Maximum stream height* is the escape
  hatch if you always watch fullscreen on a large panel.
- **Realtime enhancement cannot sustain 1080p60 on a weak integrated GPU.** The
  cost is the per-frame texture upload, not the shaders. Visionance detects this
  and switches enhancement off to protect the motion, rather than stuttering.
- **yt-dlp is not bundled**, so online playback does nothing until you install
  it from Settings.
- **Adaptive-only sources (HLS/DASH) cannot be played in Watch.** Where a site
  offers nothing but a manifest, Visionance says so instead of showing a black
  frame. Progressive MP4 links play fine.
- **AI engines are a large download** — about 45 MB for Real-ESRGAN and 430 MB
  for RIFE, because the RIFE release bundles every model version.
- **Neural renders are slow**, as neural renders are — but how slow is now a
  setting rather than a fixed cost. The measured spread on a GTX 1650 Ti is
  0.55 to 0.16 frames per second depending on inference quality, so read the
  cost class before starting a long one.
- **There is no native General 2× model**, so Fast declines neural 2× on live
  action entirely and reconstructs classically. That is a visible quality
  difference and the panel says so. Animation has genuine native 2× weights and
  uses them at every quality setting.
- **The AI engines' releases publish no per-asset checksums**, so downloads are
  verified by size and by the archive unpacking cleanly rather than by a
  published hash. The managed Node runtime *is* SHA-256 verified, because
  nodejs.org publishes one.

---

## Licence

MIT. Bundled and downloaded third-party tools carry their own licences:

| Component | Licence | Notes |
|---|---|---|
| ffmpeg | LGPL/GPL depending on build | bundled via `ffmpeg-static` |
| yt-dlp | Unlicense | downloaded on request |
| Electron | MIT | |
| Real-ESRGAN | BSD-3-Clause | Xintao Wang et al.; ncnn port by nihui. Downloaded on request; bundled models carry their own upstream terms. |
| rife-ncnn-vulkan | MIT | RIFE by Zhewei Huang et al.; ncnn port by nihui. Downloaded on request. |
| Node.js (managed runtime) | MIT | only if you install the private copy |

The contrast-adaptive sharpening pass follows the algorithm published by AMD as
part of FidelityFX CAS (MIT).
