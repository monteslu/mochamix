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
