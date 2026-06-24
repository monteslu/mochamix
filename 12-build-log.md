# 12 — Build Log

A running, append-only log of what was actually built and **why** — for future-me, who will look at a
cursed line of code and need to know whether it was a hack, a workaround, or load-bearing genius. Newest
entries at the bottom of each session.

Format: decisions and rationale, not a changelog (git is the changelog).

---

## Session 1 — Scaffold + first light (M0+M1 fused)

**Charter:** This is a personal project built out of technical hubris. No users, no deadline, no
market. The north star is "the moment that makes me grin," not a product DoD. Damn the torpedoes.
(See the brutal-honesty exchange that preceded this; the one real enemy is *annoyance*, e.g. xruns, so
keep a profiler handy but build the fun part first.)

**Decisions locked (from `11-development-plan.md` §0):**
- TypeScript throughout.
- Monorepo with shared packages (npm workspaces — no pnpm on this box; npm 11 / Node 24).
- Web Audio / AudioWorklet engine (Option B). Native addon only if pro multi-device DVS ever matters.
- WebGPU required, no fallback.
- Zero heavy lifting in JS — WASM/WebGPU only.
- React (DOM/CSS) + `<canvas>` for GPU surfaces.

**M0+M1 fused on purpose:** the M0 "two buttons toggle a control" demo has no value to a solo builder.
Goal of session 1 = *sound coming out* with a waveform, end to end.

### Tooling choices
- **npm workspaces**, not pnpm (not installed; npm matches Loukai). Packages under `packages/*`, the
  Electron app under `apps/desktop`.
- **TS project references** (composite builds) so packages typecheck/build independently and the app
  references them. `tsconfig.base.json` holds the strict compiler options; each package extends it.
- **`moduleResolution: Bundler`** + `verbatimModuleSyntax` — Vite/esbuild bundle everything; we never
  ship raw TS. `isolatedModules` keeps us honest for esbuild.
- **`noUncheckedIndexedAccess`** on — in a sample-processing codebase, indexing a `Float32Array` out of
  bounds should be a type smell, not a silent `undefined`.
- ESLint flat config, `typescript-eslint` unified package. `no-explicit-any` OFF (we touch a lot of Web
  Audio / WebGPU surface where `any` is pragmatic early).

### Why `internal-dj/` is the monorepo root
The research docs (`01`–`12`) live at the root next to `package.json`. They ARE the project's design
record; keeping them adjacent to the code they describe is the point. `apps/` + `packages/` + `vendor/`
(gitignored reference clones) sit alongside.

### control-bus package — DONE (14 tests green, typechecks clean)
The spine. `packages/control-bus`:
- `types.ts` — `ControlId = "[group],key"`, `parseControlId` splits on the FIRST comma (a key may
  contain commas; Mixxx effect group names are bracketed so this is safe).
- `keys.ts` — group constructors (`deck(n)` → `[Channel1]`, `effectUnit`, `quickEffect`, `eqEffect`,
  etc.) + key constant maps, ported from Mixxx EXACT so stock mappings address the same names. Mic
  quirk preserved: first mic is `[Microphone]` (no number).
- `sab.ts` — SharedArrayBuffer mirror: Int32 header (generation counter) + Float64 value array, one
  slot per control index. The JS analog of Mixxx atomic doubles for the worklet. Single-writer-per-slot
  discipline; generation bump is atomic and happens AFTER the value write so a reader seeing a new
  generation also sees the value.
- `bus.ts` — `ControlBus`: define/get/set, normalized parameter<->value mapping (`min`/`max`),
  pub/sub (`connect` = Mixxx `makeConnection`), `bIgnoreNops` (no emit on no-op set), persistence
  hooks, and SAB write-through. Stable dense integer index per control.
- `standard-controls.ts` — the Mixxx-compatible control surface for N decks + master + app, with
  Mixxx ranges. Smart-fader controls under `[Master]` (matches our fork, `09`).

Decisions:
- **Float64 SAB slots, not Float32.** Control values are conceptually Mixxx `double`s; no reason to lose
  precision for BPM/position math. 8 bytes × ~hundreds of controls is nothing.
- **Bus is environment-agnostic** (no Electron/DOM imports) so it unit-tests with plain vitest and is
  reusable in main, renderer, and worklet contexts. IPC + SAB *transport* wiring lives in the app.
- **`require()` throws on unknown controls** rather than silently creating them — catches typos in
  control names early (the #1 footgun when you have hundreds of string keys).

### audio-engine package — DONE (15 tests green, typechecks clean)
The real-time heart. `packages/audio-engine`:
- `deck-playback.ts` — `DeckPlayback`, the EngineBuffer+linear-scaler analog. Pure (no Web Audio/SAB),
  so it unit-tests sample-accurately. Linear interpolation varispeed; tracks fractional position in
  source frames; folds in `baseRate = trackSR/engineSR`; fans mono → stereo; stops at end. M1 =
  varispeed only (pitch follows speed); keylock is a separate M2 scaler.
- `rate.ts` — `calculateSpeed` (the RateControl slice): slider → tempo ratio.
- `crossfader.ts` — `getXfadeGains` (EngineXfader analog): equal-power curve w/ adjustable sharpness,
  orientation-aware (center channels ignore the xfader), reverse support.
- `deck-graph.ts` — the renderer-side channel strip (EQ biquads → volume → crossfader gain). EQ knob
  0..1..4 → dB curve. Native Web Audio nodes for the mixer side (cheap, glitch-free via AudioParam
  ramps); exact-parity Bessel/LR EQ deferred to a WASM/WGSL filter later (10 §2a).
- `protocol.ts` — the main↔worklet message protocol (init/loadTrack/eject/seek). Heavy data (control
  values, samples) goes via SAB; this carries setup/track-load only.
- `engine.worklet.ts` — the `AudioWorkletProcessor` (EngineMixer::process analog). One output per deck;
  reads control values from the control SAB each block (lock-free); produces deck audio; publishes
  position back to the SAB (rate-limited, every 4 blocks). NO allocation in process().
- `engine.ts` — `Engine`, the renderer-side controller (EngineMixer main-side + PlayerManager): builds
  AudioContext, loads the worklet, wires deck graphs, subscribes the control bus → AudioParams (UI
  side), loads decoded tracks into SABs.
- `decoded-track.ts` — `DecodedTrack` (SAB-backed planar Float32) + `packPlanarToSab`.

Decisions:
- **Deck samples live in a SAB the worklet indexes directly**, NOT an AudioBufferSourceNode. This is the
  Mixxx EngineBuffer model and the only thing that scales to keylock + sample-accurate loops + scratch
  (M2/M4). AudioBufferSourceNode can't do those cleanly. Costs us writing the scaler ourselves; that's
  the point of "engine in the worklet."
- **Mixer EQ/volume/crossfader as native Web Audio nodes** (not in the worklet) for M1 — cheap and
  glitch-free. The worklet only does sample production + pregain. If we later need sample-accurate
  mixer FX we move it in, but don't pay for that now.
- **Position published every 4 blocks** (~11ms) not every block — smooth enough for the UI marker,
  avoids hammering the generation counter. Mixxx rate-limits its VU/position similarly.
- **Two-output-channel worklet per deck**; deck outputs are separate worklet outputs so each gets its
  own channel strip. `outputChannelCount: [2,2,...]`.

### codec/decode package — DONE (2 tests, typechecks)
`packages/codec`: `decodeArrayBuffer(ctx, data)` → `decodeAudioData` → planar Float32 → SAB-backed
`DecodedTrack`. `isPlatformDecodable(filename)` heuristic. `decodeWithFfmpeg` is a clear throw-stub
pointing at the Loukai ffmpeg-wasm worker for exotic formats + the future encode path. Kept minimal on
purpose — the platform decoder covers MP3/WAV/FLAC/AAC/Ogg/Opus, which is all M1 needs.

### Monorepo resolution gotcha (fixed)
First `npm install` only symlinked `control-bus` because the other packages didn't exist yet at that
moment. Re-running `npm install` after all packages existed created all `node_modules/@internal-dj/*`
symlinks. For vitest, added `vitest.config.ts` with `resolve.alias` pointing each `@internal-dj/*` at
its `src/index.ts` so tests run against source with no build step. tsc resolves cross-package via the
symlinks + `main: src/index.ts` (bundler resolution follows `.ts`). Did NOT add tsconfig `paths` — they
fight project references and resolve relative to the wrong dir in nested packages.

### waveform package — DONE (6 tests, typechecks)
`packages/waveform`: `computePeaks` (max-abs buckets, 0..255 Uint8, Mixxx model — PEAK not RMS),
`computePeakSet` (detail + overview), Canvas2D `drawOverview` + `drawScrolling` (playhead-centered
scroll). Canvas2D first for fastest "I see a waveform"; WebGPU/WGSL render (porting Mixxx GLSL) is the
documented next step. The 4-band Bessel split is deferred to the analysis package (shares EQ filters).

Decision: **Float32 rounding bug caught by a test.** `0.9` stored in a Float32Array is `0.89999...`, so
`round(0.9*255)`=230 but the code (reading the f32) gives 229. The CODE was right; the test expectation
was naive. Fixed the test to read the f32 value. Noting it because this class of error (double vs f32)
will recur all over a sample-processing codebase — always compute expectations from the same storage
type the code uses.

### apps/desktop — DONE for M1 (boots clean, isolation + WebGPU confirmed)
The Electron app. `apps/desktop`:
- `src/main/main.ts` — main process. Serves the renderer from a custom **`app://` protocol** with
  COOP/COEP headers baked into the document response. File-open + dropped-file IPC.
- `src/main/preload.cts` — contextIsolated bridge (`window.dj`). `.cts` (CJS) via `import = require`.
- `src/shared/ipc.ts` — shared IPC types (so the renderer typecheck doesn't pull in the CJS preload).
- `src/renderer/` — React app: `dj-context.tsx` (builds the ControlBus w/ SAB + Engine, the
  `useControl` hook = the skin `<Connection>` analog), `App.tsx` (2 decks + center mixer, Mixxx
  layout), `components/` (Deck, Mixer, Knob, WaveformView). `styles.css` (LateNight-ish dark theme).
- `engine-worklet-entry.ts` + `vite.worklet.config.ts` — the worklet built as a SEPARATE self-contained
  ES module.

Decisions / gotchas (the valuable part):
- **Worklet bundling.** Vite's `new URL('./x.worklet.ts', import.meta.url)` does NOT bundle a .ts
  worklet — it copies raw TS the browser can't run. Fix: a dedicated `vite.worklet.config.ts` lib build
  emitting `dist-renderer/worklets/engine.worklet.js` (self-contained, `inlineDynamicImports`). The
  renderer references it by URL relative to `document.baseURI`. Build order matters: renderer first
  (it `emptyOutDir`s), then worklet (writes into the renderer dir).
- **THE cross-origin-isolation bug (caught by the headless smoke test, invisible to unit tests).**
  Injecting COOP/COEP via `session.webRequest.onHeadersReceived` does NOT reach the top-level `file://`
  document → `crossOriginIsolated=false` → `SharedArrayBuffer is not defined` → the entire SAB control
  mirror is dead. Also `require-corp` blocks `file://` subresources outright. **Fix:** serve the
  renderer from a registered privileged **`app://` protocol** (`registerSchemesAsPrivileged` +
  `protocol.handle`) and set COOP=`same-origin` / COEP=`credentialless` on the document response. After
  that: `crossOriginIsolated=true`, `SharedArrayBuffer=true`, `webgpu=true`. This is the single most
  important infra decision in the app and would have silently broken the whole architecture.
- **Main-process tsconfig uses `module: NodeNext`** so `main.ts` (ESM, under `type: module`) and
  `preload.cts` (CJS) both compile by extension. tsc nests output under `rootDir/src` → entry is
  `dist-main/main/main.js` (package.json `main` + renderer path adjusted for the extra level).
- **Control bus lives in the RENDERER for M1** (that's where the AudioContext is). Main-authoritative +
  IPC mirror is deferred — no second window/process touches it yet. Documented as an explicit M1
  simplification, not an accident.

### Verification status (this environment)
No display + Electron binary download blocked by the sandbox, so I can't *visually* run it here. Smoke-
tested headless using Loukai's Electron 42 binary: main process boots, `app://` protocol serves the
renderer, React mounts, **crossOriginIsolated=true / SharedArrayBuffer=true / webgpu=true**, no
uncaught errors, no renderer crash. Audio can't start headless (needs a user gesture + no audio device),
but the full boot + control-bus + SAB + worklet-URL path is clean. On a real machine `npm run dev` in
`apps/desktop` launches it. 37 unit tests green across the 4 packages.

### M1 status: COMPLETE (pending a human eyeballing it on a real display)
Load a track → decode → peaks → waveform render → play/seek, 2 decks + crossfader + EQ, all bound to
the control bus. Next: M2 (keylock-in-worklet — the one real risk).

---

## Session 1 (cont) — M2: keylock in the worklet (the one real risk)

The thing everyone says can't be done in a browser. Done — and it's the SAME engine Mixxx uses for its
"faster" keylock mode (SoundTouch), running in our AudioWorklet.

### What landed
- `packages/audio-engine/src/scaler.ts` — the `Scaler` interface (Mixxx EngineBufferScale contract):
  `setRatios(tempo, pitch)`, `process(outputs, n, pull)`, `reset()`. A `SourcePull` callback is how the
  scaler asks for source samples — so the scaler never owns the read position; DeckPlayback does.
- `packages/audio-engine/src/keylock-scaler.ts` — `KeylockScaler` wrapping `soundtouchjs` 0.3.0 (the
  core `SoundTouch` class, NOT the worklet wrapper — we call it from inside OUR worklet). Pulls planar
  source → interleaves → `inputBuffer.putSamples` → `process()` → drains `outputBuffer` into planar
  outputs. Independent tempo/pitch.
- `deck-playback.ts` refactored to two paths sharing one `pullResampled()` reader:
  - keylock OFF → linear varispeed (pitch follows speed; the only path that ramps through zero →
    scratch/reverse).
  - keylock ON → source resampled to engine rate at ORIGINAL pitch (baseRate only), KeylockScaler
    applies tempo=speed, pitch=1.
  - keylock auto-disengages for scratch/extreme speed (speed ≤0.1 or ≥1.9) → linear, exactly like Mixxx.
- Wired `keylock` control through protocol → worklet (`setKeylock`) → engine index map → Deck UI (🔒).

### SEEK PRIMING (the make-or-break detail, M2's whole point)
A naive stretcher emits its startup transient on the first block after every cue jump → audible click.
`KeylockScaler.prime()` pre-feeds PRIME_FRAMES (4096) of source after every `reset()` so the
outputBuffer already holds aligned samples before the caller reads. `seekFrames`/`setKeylock`/`loadTrack`
all `reset()` the scaler so priming re-runs. This is the JS equivalent of RubberBand's
getPreferredStartPad/getStartDelay dance (which we'll do when we add the "finer" engine).

### Honest status
Priming is IMPLEMENTED and STRUCTURALLY tested (8 keylock tests: fills exact frames, finite output,
tempo-independence — faster tempo consumes more source for the same output, reset-without-throw,
drain-to-silence, scratch fallback). But whether seeks are TRULY click-free is an ear test on real
hardware, which I can't do headless. The logic is the proven pattern; flag for human verification.

### Decisions
- **Call the SoundTouch CORE from our worklet**, not the `@soundtouchjs/audio-worklet` processor. Their
  worklet is fed by an input AudioNode; OUR worklet PRODUCES samples from a SAB, so the input-node model
  doesn't fit. The core `SoundTouch` class (putSamples/process/outputBuffer) does.
- **soundtouchjs has no types** → added `soundtouchjs.d.ts` (just the surface we use).
- **Worklet bundle is 20KB (5.6KB gz) with SoundTouch inside.** Negligible. No concern about shipping
  the stretcher in the worklet.
- RubberBand-WASM ("finer" engine) deferred — SoundTouch ships first (proven, smaller), exactly the
  Mixxx default-vs-fallback split in reverse.

### M2 status: COMPLETE (pending an ear test on real hardware)
45 tests green. App boots clean with keylock wired. The scary milestone is behind us and it's a
re-housing of Mixxx's own SoundTouch engine, not new science.

---

## Session 1 (cont) — M4: the EngineControl stack (cues + loops)

Skipped straight to M4 (cues/loops) over M3 (mixer polish) because M1 already gave a working mixer and
cues/loops are the heart of DJing + they exercise the seek/loop architecture.

### Architecture decision: where the EngineControl stack lives
Mixxx runs its EngineControl stack inside the audio callback. We split it: the sample-accurate part
(loop wrap) lives in the worklet's DeckPlayback; the *logic* (set cue, activate hotcue, size a
beatloop) lives MAIN-THREAD as bus subscribers (`packages/audio-engine/src/controls/`). Rationale:
cues/loops are about manipulating read position, which the worklet owns — but the triggers are sparse
(a click), so running them per-block in the worklet is wasteful. Main-thread controls translate bus
triggers → engine messages (`setLoop`/`loopEnable`/`seek`). Keeps the worklet lean and the
control-bus-as-spine pattern intact.

### What landed
- `deck-playback.ts` loop support: `setLoop/setLoopEnabled`, and a sample-accurate wrap in
  `pullResampled` — when position reaches loopEnd it jumps back to loopStart KEEPING the fractional
  overshoot (phase-continuous), with a **64-frame seam crossfade** (mix the pre-seam tail with the
  post-loopStart head) so the wrap is click-free. An active loop overrides end-of-track.
- `controls/cue-control.ts` — main cue + 36 hotcues (set/activate/clear) as bus subscribers.
- `controls/loop-control.ts` — loop in/out, reloop toggle, halve/double, loop exit, and beatloops
  (sized from `file_bpm` until M5 gives a real beatgrid).
- control-bus: added cue/loop/hotcue/beatloop keys + parameterized helpers (`hotcuePositionKey(n)`,
  `beatloopActivateKey(size)`), MAX_HOTCUES=36, BEATLOOP_SIZES (1/32..512). Registered all in
  `standardControls` (now 605 controls for 2 decks, 1187 for 4 — SAB bumped to 2048 in the app).
- Engine wires a CueControl + LoopControl per deck, providing positionFrames (from the bus),
  seekFrames (posts a seek message + reflects on the bus), and applyLoop/enableLoop (post messages).
- UI: `HotcueRow` (8 pads: click empty=set, set=jump, shift/right-click=clear) + `LoopRow` (IN/OUT/
  LOOP/½/2× + 1/2/4/8/16 beatloops). Waveform overlay: hotcue markers + loop region drawn on the
  overview (extended the Canvas2D renderer with a Marker/LoopRegion overlay).

### THE bug worth remembering: momentary triggers must self-reset
A loop test failed: pressing reloop_toggle twice only toggled once. Cause: the control bus suppresses
no-op sets (`bIgnoreNops`), so a trigger control left at 1 never fires again. **Fix:** trigger handlers
set the control back to 0 after acting (proper push-button semantics). This is now the standard pattern
for ALL momentary controls (`CueControl.on`/`LoopControl.on` wrap it). Every Mixxx mapping that does
`engine.setValue(g, 'beatloop_4_activate', 1)` relies on this; without it the second press is dead.

### M4 status: COMPLETE
56 tests green (11 new loop/cue tests incl. the sample-accurate wrap). App boots clean. Hotcues,
beatloops, manual loops, halve/double, reloop all wired end to end and visible on the waveform.
Real loop-seam audio quality is an ear test (the crossfade logic is in place + structurally tested).

---

## Session 1 (cont) — M5: analysis + sync + Smart Fader

The milestone that makes beatloops beat-accurate and brings the fork's headline feature to life.

### New package: `@internal-dj/analysis`
- `beats.ts` — the `Beats` beatgrid model (constant tempo: bpm + firstBeatFrame, in FRAMES).
  nearest/next/prev beat, beatDistance (0..1), scale/translate/withBpm, JSON round-trip.
- `beat-detector.ts` — a REAL, self-contained autocorrelation BPM+phase detector: onset-strength
  envelope (half-wave-rectified energy flux @100Hz) → autocorrelation over a BPM range → phase via a
  pulse-train correlation, with octave snapping toward the dance pocket. NO external WASM. The
  essentia.js/qm-dsp-WASM swap drops in behind the same interface later.
- `analysis.worker.ts` + protocol — runs detection off the main thread, sample data via SAB (no copy).
- TESTED with synthetic click tracks: detects 120 and 128 BPM within 2.5bpm, finds phase within 30ms.
  It actually works.

### Sync engine + Smart Fader (`audio-engine/src/sync/`)
- `sync-engine.ts` — `SyncEngine` (EngineSync analog): pick leader, follower rate = leaderBpm /
  (followerBpm × halfDoubleFactor), + a capped proportional phase correction. Pure math; drives the
  existing rate control. half/double tested (140 follower locks to 70 leader).
- `smart-fader.ts` — **the fork's signature feature** (09), ported: crossfader →
  targetBpm = lerp(leftBpm, rightBpm, t); both decks play at targetBpm (rate = targetBpm/fileBpm). No
  half/double (strictly between the two BPMs — no octave jump, the fork's dc6aea69 fix). Fully tested:
  hard-left→left bpm, hard-right→right bpm, center→avg, 90↔140 blend = 115 (no snap).

### Key infra: the rate-ratio override
Sync/SmartFader need ratios beyond the slider's ±10% (90↔140 = ratio 1.55). Added a
`rate_ratio_override` control per deck: the worklet uses it as speed when >0, else the slider calc.
Clean separation — sync writes the override, the user writes the slider, no fighting.

### Wiring into the app
- `AnalysisService` (renderer) wraps a Vite-bundled Web Worker (regular Workers DO bundle via
  `new Worker(new URL(...))` — unlike AudioWorklets). Track load → analyze → set `file_bpm` → beatloops
  + sync + smart fader all become live.
- Smart Fader toggle + live target-BPM readout in the Mixer. (DDJ-FLX4 button mapping comes with M7.)

### M5 status: COMPLETE
76 tests green (25 new: beats, detector, sync, smart fader). App boots clean. Real BPM detection in a
worker, beat-accurate loops, and the Smart Fader tempo blend all live. The fork feature survived the
re-architecture and is cleaner than the C++ original (one control + the override, no sync-engine
surgery).

### M3 leftovers — DONE (VU + pitch-bend)
- `vu-meter.ts` — `VuMeter`: mean-of-abs, fast-attack/slow-decay smoothing, peak-hold + clip flag.
  Worklet runs one per deck, meters the post-pregain signal, publishes vu_meter + peak_indicator to the
  SAB at ~30Hz (every 11 blocks @48k/128), volume-scaled. 5 tests (attack>decay, slow decay, clip).
- `VuMeterBar` UI — rAF-polls the bus value, sqrt-scaled vertical bar with a clip light. No React churn.
- Temporary pitch-bend buttons (‹ ›) — hold to nudge the rate ±0.08 for manual beatmatch; release
  restores. Pure UI (offset the rate control), no engine change.
- PFL/headphone cue DEFERRED — needs the multi-output-device work (the documented M3 friction, 10 §4a).
  Low value solo (you hear the main mix); revisit if a real 2-output setup matters.

### Where we are after session 1
M1 (first light) · M2 (keylock) · M3 (mixer: EQ/xfader/VU/pitch-bend) · M4 (cues/loops) ·
M5 (analysis/sync/smartfader) all COMPLETE. 6 packages + the Electron app, 81 tests, boots
cross-origin-isolated with WebGPU. Remaining: M6 (library/SQLite), M7 (controllers/Web MIDI + Mixxx
mappings), M8 (effects), M9 (record/broadcast/stems), + PFL cue. Everything pending a human ear/eye test
on real hardware (no display + no Electron binary in this env).
