# 10 — Electron Feasibility

The kneejerk objection to "a Mixxx-class DJ app in Electron" is that DJ software is hard-real-time C++
(PortAudio, RubberBand, qm-dsp) and a browser can't do that. **That objection is out of date**, and
critically, **we have already shipped the hard parts** in `../loukai`. This document makes the case
concretely, grounded in code we have running today, and states the architectural rules that keep it
viable.

## 0. The thesis

internal-dj is viable in Electron because of four platform capabilities that did not exist (or were not
mature) when Mixxx was designed, plus one hard rule:

1. **AudioWorklet** — a dedicated real-time audio render thread in the renderer (128-frame quanta), the
   browser analog of Mixxx's PortAudio callback. DSP runs here, not on the JS main thread.
2. **WASM with SIMD + threads** — near-native DSP/codec performance. RubberBand, SoundTouch, qm-dsp,
   FFmpeg, libebur128 all compile to WASM; SIMD + shared-memory threads close most of the gap to
   native.
3. **WebGPU + WebGL** — GPU compute + rendering. We use it for ML inference (stem separation,
   transcription, pitch) *and* it's the right tool for waveform/spinny/visualization rendering.
   **WebGPU is a hard requirement, no fallback** (see §0a).
4. **Web MIDI** — direct controller I/O in the renderer, and we can **reuse Mixxx's controller
   mappings in their native format** (see §6).

**The hard rule (non-negotiable): ZERO heavy processing in JavaScript itself.** JS is the orchestrator
and the UI. Every sample-crunching, codec, or ML operation runs in a WASM module (in an AudioWorklet or
a Web Worker) or on the GPU (WebGPU/WebGL). This is exactly the discipline Mixxx already enforces ("the
real-time thread never allocates, never locks, never does I/O", `03` §2) — we apply the same rule, just
with WASM/GPU as the compute substrate instead of native C++.

**The build-it-ourselves corollary.** Where Mixxx does native processing we *don't* already have a web
equivalent for, we build it as **our own WASM module or WebGPU compute shader** — we do not fall back to
JS, and we do not treat any such gap as a blocker. We already author WASM/worklet DSP and WebGPU/ONNX
pipelines in `../loukai`, so producing a new WASM lib (compile the C/C++ from Mixxx or its upstream
deps, e.g. qm-dsp / RubberBand / libebur128, to WASM) or a WGSL compute shader (for vectorizable
sample math, FFTs, filters, waveform reduction) is a known, repeatable workflow, not a research risk.
**Each "Mixxx does this in C++" item resolves to exactly one of: (a) reuse an existing Loukai building
block, (b) reuse a maintained WASM lib, (c) compile the relevant C/C++ to WASM ourselves, or (d) write
a WGSL/WebGL shader.** There is no (e) "do it in JS" and no (f) "can't be done."

## 0a. WebGPU is a hard requirement (no fallback path)

WebGPU is available on every platform we ship to (Windows/D3D12, macOS/Metal, Linux/Vulkan) in current
Chromium — and **we control the Chromium runtime because this is Electron**, so we can enable it
unconditionally (including via flags such as `enable-unsafe-webgpu` / `--enable-features=Vulkan` where a
platform still gates it). We therefore **require WebGPU and design with no CPU/WASM fallback for the
GPU-targeted work.** Consequences, made explicit so nobody wastes effort on dual paths:

- **No fallback branches.** ML inference (stem separation, any analysis models), waveform/spinny
  rendering, and visualizations assume a WebGPU device exists. We do not author and maintain a parallel
  WASM/CPU path for these. (Today's Loukai code carries `device === 'webgpu' ? ['webgpu'] : ['wasm']`
  EP selection for portability across browsers; **internal-dj drops the wasm EP fallback** and targets
  WebGPU only, since we own the runtime.)
- **Startup gate.** On launch, acquire a `GPUAdapter`/`GPUDevice` once; if absent, surface a hard,
  actionable error ("WebGPU unavailable — update GPU drivers / enable the flag"), not a degraded mode.
- **WASM (SIMD/threads) remains the substrate for the *audio-thread* and *codec* work** (worklet
  DSP, decode/encode) where the GPU isn't the right tool or the latency/round-trip doesn't fit a
  per-quantum budget. WebGPU is required; it does not *replace* WASM — the two are complementary (GPU
  for big parallel batch + rendering, WASM for real-time per-sample + codecs).

## 1. We have already shipped the hard parts (proof from `../loukai`)

This is not speculation. The Loukai Electron app already does, in a renderer:

| Capability we already run | Where (in `../loukai`) | Why it de-risks internal-dj |
|---|---|---|
| **Real-time time-stretch in an AudioWorklet** (SoundTouch) | `src/renderer/js/soundtouch-worklet.js` (`@soundtouchjs/audio-worklet`) | This **is the keylock primitive** (`04` §4). SoundTouch is literally one of Mixxx's two keylock engines. Already proven real-time in our worklet. |
| **FFT phase vocoder in an AudioWorklet** (pitch shift + formant preservation, real-time) | `src/renderer/js/phaseVocoderWorklet.js` | Proves we can run nontrivial spectral DSP per-quantum in a worklet without glitching. |
| **Real-time pitch detection worklets** | `micPitchDetectorWorklet.js`, `musicAnalysisWorklet.js`, `autoTuneWorklet.js` | Live analysis on the audio thread — the pattern for beat/transient/level work. |
| **4-stem source separation on WebGPU** (htdemucs / htdemucs_ft ensemble, ONNX via onnxruntime-web) | `src/shared/creator/createKaraoke.js`, `static/webgpu/ft-ensemble.js`, model repo `monteslu/htdemucs-ft-webgpu` on HF | Demucs is **heavier than anything in a DJ engine.** If we can run a full transformer-based stem separator on WebGPU in-app, BPM/key/beatgrid analysis is trivial by comparison. Directly enables 2.6-style **stem decks**. |
| **Whisper transcription on WebGPU** (transformers.js, q4f16 on webgpu) | `createKaraoke.js` | More proof the WebGPU ML path is production-grade in our Electron build. |
| **CREPE pitch model on WebGPU** (ONNX) | `static/webgpu/crepe_tiny.onnx`, `detectPitch()` | Same ONNX-on-WebGPU pattern we'd use for any analysis model (internal-dj targets the webgpu EP only — §0a). |
| **FFmpeg (WASM) encoding in a Worker** (AAC, off the main thread, JSON-RPC) | `src/shared/components/aacWorker.js` (ffmpeg-core.wasm) | This is exactly Mixxx's **sidechain** pattern (`04` §7): encode off the audio thread. Recording/broadcast reuse this. |
| **Same-origin asset/model proxy + cache** for WASM/models | `src/main/creator/webgpuAssets.js` | Solves WASM/model delivery + caching in a packaged Electron app — already done. |

**Takeaway:** every category of "impossible in a browser" work a DJ app needs — real-time
time-stretch, spectral DSP, ML analysis, codec encode off-thread — is already running in our shipping
Electron code. internal-dj reassembles proven pieces; it does not invent the risky ones.

## 2. Capability-by-capability: the DJ engine vs the web platform

| DJ requirement | Native (Mixxx) | internal-dj (web platform) | Status |
|---|---|---|---|
| Real-time mix callback | PortAudio thread → `EngineMixer::process` | `AudioWorkletProcessor.process` (128 frames) | Standard; we run worklets today |
| Sample format | CSAMPLE float32 `[-1,1]`, stereo | Float32, native to Web Audio | Identical model |
| Per-deck gain/EQ/fader/xfader | manual ramped gains | `GainNode`/`BiquadFilterNode` + `AudioParam` ramps | Trivially better (ramps are free) |
| **Keylock / time-stretch** | RubberBand / SoundTouch (C++) | **SoundTouch worklet (shipping) + RubberBand-WASM (port)** | **De-risked — we run SoundTouch in a worklet now** |
| Scratch / varispeed | linear scaler | `playbackRate` + a WASM scaler worklet for ramp-through-zero | Standard |
| BPM / key / beatgrid analysis | qm-dsp (C++) on worker threads | essentia.js (WASM) or qm-dsp→WASM in Web Workers | Lighter than Demucs, which we already run |
| Stem separation (2.6 stem decks) | — (Mixxx reads pre-split stem files) | **Demucs on WebGPU (shipping in Loukai)** | **We exceed Mixxx here** |
| Decode any format | 12 native decoders | FFmpeg-WASM / `decodeAudioData` / WebCodecs | Shipping (we use ffmpeg-wasm) |
| Encode (record/broadcast) | LAME/FDK/etc. on the sidechain thread | FFmpeg-WASM / `lamejs` in a Worker | **Shipping (AAC worker)** |
| Waveform render | OpenGL via rendergraph | **WebGL/WebGPU `<canvas>`** | Standard; GLSL ports |
| Visualizations | — | WebGPU/WebGL (we ship butterchurn) | `src/renderer/lib/butterchurn.min.js` |
| Controllers | PortMidi/HID + QJSEngine | **Web MIDI + reused Mixxx mappings** | §6 |
| Library DB | SQLite (Qt) | SQLite (`better-sqlite3`, main process) | Standard |
| Multi-thread compute | QThread workers + lock-free FIFOs | Web Workers + `SharedArrayBuffer` rings + Atomics | Standard; same discipline |

There is no row where the web platform *can't* do it. There are rows where it needs WASM/GPU (which is
the whole point) and two rows of genuine friction (§4).

## 2a. Mixxx native processing → our resolution (build-it-ourselves ledger)

Every piece of native C/C++ processing in Mixxx resolves to one of: **(a)** reuse a Loukai building
block, **(b)** reuse a maintained WASM lib, **(c)** compile the C/C++ to WASM ourselves, **(d)** write a
WGSL/WebGL shader. **Never JS, never "can't."** The deps below come from Mixxx's source (`08`).

| Mixxx native processing | Upstream C/C++ | Our resolution | Class |
|---|---|---|---|
| Keylock "faster" engine | SoundTouch | **Already shipping** as a worklet in Loukai | (a) |
| Keylock "finer" engine | RubberBand R3 | Compile RubberBand to WASM (SIMD) → worklet | (c) |
| Time-stretch math / WSOLA fallback | — | Our FFT phase-vocoder worklet (Loukai) as a base | (a) |
| Beat/BPM + key detection | qm-dsp | essentia.js (WASM) now; compile qm-dsp→WASM for Mixxx-parity | (b)/(c) |
| ReplayGain 2.0 / loudness | libebur128 | Compile libebur128→WASM (tiny, pure C) | (c) |
| ReplayGain 1.0 | bundled `replaygain.c` | Compile→WASM, or skip in favor of EBU R128 | (c) |
| Decode (FLAC/MP3/Opus/AAC/…) | libFLAC/libmad/FFmpeg/… | FFmpeg-WASM (shipping) / `decodeAudioData` / WebCodecs | (a)/(b) |
| Encode (MP3/AAC/Ogg/FLAC) | LAME/FDK/vorbis | FFmpeg-WASM in a Worker (shipping AAC) / `lamejs` | (a)/(b) |
| Mixer sample math (gain/mix/filter) | `SampleUtil` SIMD loops | Native Web Audio nodes; custom bits as WASM-SIMD or **WGSL compute** | (d)/(c) |
| EQ filters (Bessel/Linkwitz-Riley) | hand-written biquads | `BiquadFilterNode`, or a WASM/WGSL biquad for exact parity | (b)/(c) |
| Effects DSP (Echo/Reverb/Flanger/…) | builtin backend | Web Audio nodes + AudioWorklet effects; novel ones as WASM/WGSL | (a)/(c) |
| Waveform analysis (4-band peak reduction) | Bessel-split + max-abs | `OfflineAudioContext`/WGSL compute reduction | (d) |
| Waveform/spinny render | OpenGL + GLSL (`res/shaders`) | **WebGPU/WGSL** (port the GLSL) | (d) |
| Timecode vinyl decode (DVS) | libxwax | Compile libxwax→WASM → worklet (only if/when we add DVS) | (c) |
| Stem separation (new vs Mixxx) | — | **Demucs on WebGPU (shipping in Loukai)** | (a) |

The "(c) compile to WASM ourselves" items are the only net-new build work, and they're a known
workflow: take the same C/C++ Mixxx links against, build it with Emscripten (SIMD + threads on), wrap it
in a worklet or worker. We do this class of thing in Loukai already.

## 3. The compute-placement map (the "zero JS heavy-lifting" rule applied)

Every heavy operation has a home that is **not** the JS main thread and **not** plain JS:

```
                         JS main thread (renderer)  =  UI + orchestration ONLY
                         JS main thread (Node/main)  =  IPC + SQLite + Web MIDI routing

  AudioWorklet render thread (real-time, 128-frame quanta):
     • mixer graph (gains/EQ via native nodes; custom DSP via WASM-in-worklet)
     • keylock / time-stretch          → SoundTouch / RubberBand  (WASM + SIMD)
     • scratch / varispeed scaler      → WASM
     • per-deck EngineControl logic    → light JS is OK here (bookkeeping, not sample loops)
     • VU metering                     → WASM or light JS, rate-limited publish

  Web Workers (off-thread, not real-time):
     • decode (FFmpeg / WebCodecs)     → WASM / native codec
     • analysis: BPM/key/beat/loudness → essentia.js / qm-dsp / libebur128  (WASM + threads)
     • waveform peak precompute        → WASM or OfflineAudioContext on GPU
     • record / broadcast encode + net → FFmpeg-WASM  (the sidechain)

  GPU (WebGPU compute / WebGL):
     • stem separation (Demucs ONNX)   → WebGPU  (SHIPPING in Loukai)
     • waveform + spinny + scopes      → WebGL/WebGPU rendering
     • music-video visualizations      → WebGPU/WebGL (butterchurn)

  SharedArrayBuffer + Atomics: the lock-free rings between worklet ↔ workers,
     and the mirror of the ControlObject bus into the worklet (the JS analog of
     Mixxx's atomic-double ControlObjects, 03 §1, 04 §7).
```

This is a one-to-one re-housing of Mixxx's own thread map (`03` §2) onto web primitives. We are not
fighting the platform; we are using the same architecture with WASM/GPU as the engine room.

## 3a. UI strategy: Mixxx as visual reference, React + GPU canvases as the tech

We take **visual cues and UI organization from Mixxx** (deck-over-mixer layout, the waveform-on-top
arrangement, the library-at-bottom split, control grouping, the skin proportions in `res/skins/`), but
**we do not reuse Mixxx's UI tech.** Mixxx's legacy UI is an XML-skin → QWidget parser (`06` §1); we
build the layout in **React** (or similar) with **`<canvas>` elements for the WebGL/WebGPU-rendered
parts.** This matches where Mixxx itself is going (its 3.0/QML rewrite moves to a declarative,
proxy-bound UI — `01` §5, `06` §1 — which is structurally what a React tree bound to a state store is).

The split:
- **React (DOM/CSS)** owns layout, panels, buttons, knobs/faders (as styled components), the library
  table (virtualized), menus, preferences, drag-and-drop. Everything that is "widgets and structure."
- **`<canvas>` (WebGPU primary, WebGL where simpler)** owns the GPU-rendered surfaces: scrolling
  waveforms, the track overview, the spinning platter (spinny), VU meters if we want them
  GPU-drawn, and visualizations. These are React components that own a canvas ref and drive a render
  loop; they do **not** re-render through the DOM per frame.
- **The binding layer is the control bus** (`03` §1): a `useControl("[Channel1]","play")` hook is the
  React analog of a Mixxx skin `<Connection>` and of the QML `QmlControlProxy`. Components read the
  store to display and dispatch to it on input; high-rate values (play position, waveform scroll, VU)
  come over the batched path, not per-control React state churn.

Practical implication: porting a Mixxx skin is "read its layout XML as a reference for *what goes
where*, then rebuild it as React components + canvas surfaces," not a mechanical translation. The GLSL
shaders in `res/shaders/` port to WGSL/WebGL for the canvas surfaces (`2a`, class (d)). See `06` §1 for
the per-widget Mixxx→component mapping table.

## 4. The two genuine friction points (and our answers)

Everything else is "standard, we've done it." These two deserve honesty:

### 4a. Audio output latency & multi-device cueing
- **Latency:** Web Audio output latency is higher and less tunable than ASIO/CoreAudio (typically tens
  of ms, vs single-digit on native). For *mixing* (the crossfade/EQ/loop workflow) this is fine — the
  control-to-sound latency that matters for scratching is dominated by the worklet quantum, which is
  small. Use `AudioContext({ latencyHint: 'interactive' })` and keep the graph shallow.
- **Multi-device cueing (headphones on a separate sound card):** one `AudioContext` = one output
  device. True booth/headphone-on-a-second-interface needs either two `AudioContext`s (independent
  clocks → drift, the problem Mixxx solves with FIFOs) or `setSinkId`. **Answer:** for MVP do
  headphone cueing as a channel split of one stereo device (or a split-cue mono trick like Mixxx's
  `headSplit`); treat true dual-interface DVS cueing as the one scenario that may justify a small
  **native N-API audio addon** later (`07` §1 Option A). It does not block the product.

### 4b. Keylock quality/latency parity
- SoundTouch (shipping) is the "faster, lower-CPU" engine; RubberBand R3 is the "finer" one. **Answer:**
  ship SoundTouch-in-worklet first (proven), add RubberBand-WASM for the high-quality mode. The only
  real work is replicating the start-pad/start-delay priming so seeks don't glitch (`04` §4) — a known,
  bounded task, not a research risk.

Neither is a showstopper; both have concrete mitigations and a native escape hatch that's *optional*,
not required.

## 5. WASM + SIMD + threads: the performance argument

- **SIMD:** WASM SIMD (128-bit) gives ~2–4× on the vectorizable DSP that dominates a DJ engine (gain,
  mix, filter, FFT, resample). Mixxx's own hot loops (`SampleUtil`) are SIMD-friendly and map directly.
- **Threads:** WASM threads (shared memory + Atomics) let analysis/decode/encode fan out across cores
  exactly like Mixxx's `AnalyzerThread` pool (`05` §6) — one worker per core, lock-free queues.
- **Headroom proof:** htdemucs (a transformer source-separator) running interactively on WebGPU in our
  app is **orders of magnitude** more compute than the entire real-time mix path of a DJ engine. The
  performance ceiling is not the concern people assume.
- **Requirement:** WASM threads + `SharedArrayBuffer` need cross-origin isolation
  (`COOP: same-origin` + `COEP: require-corp`). In Electron we control the headers / `file://` origin,
  so this is a non-issue (we already meet it for the worklet/worker work in Loukai).

## 6. Web MIDI + reusing Mixxx's controller mappings (a strategic win)

This is a deliberate, high-leverage decision: **keep Mixxx's controller-mapping format so we can pull
mapping updates as Mixxx ships them.**

- **Web MIDI** (`navigator.requestMIDIAccess`) gives raw MIDI I/O in the renderer — the direct analog of
  Mixxx's PortMidi layer. HID controllers use WebHID (or `node-hid` in main if a device needs it).
- **The mappings are XML (`.midi.xml`) + JavaScript** that talk to an `engine`/`midi`/`console` global
  API (`06` §2). That JS is **plain ECMAScript running in a QJSEngine** — it runs unchanged in a browser
  JS context. We:
  1. Parse the `.midi.xml` (status/midino → group/key or script function) with a small XML reader.
  2. Provide the **same `engine` global** (`getValue`/`setValue`/`makeConnection`/`beginTimer`/
     `scratchEnable`/`softTakeover`/…) backed by our control-bus store.
  3. Keep `midi-components-0.0.js` and `common-controller-scripts.js` **byte-for-byte** (they only
     depend on those globals).
- **Result:** the **163 bundled Mixxx mappings + the entire community ecosystem run nearly unchanged**,
  and we can **track Mixxx's repo for mapping fixes/additions** indefinitely (`git subtree`/submodule on
  `res/controllers/`, or a periodic vendoring script). This is a huge content moat for near-zero cost,
  and it's why the mapping-format compatibility (`06` §2, `07` §6) is worth treating as a hard
  requirement, not a nice-to-have.

## 7. Where we can exceed Mixxx (because of this stack)

The web stack isn't just "good enough" — it unlocks features Mixxx can't easily do:

- **In-app stem separation** → real-time stem decks / acapella+instrumental on the fly from *any*
  track, not just pre-split stem files (Mixxx 2.6 only reads pre-made `.stem.mp4`). We already separate
  on WebGPU.
- **GPU visualizations** (butterchurn / custom WebGPU) tied to the mix — a natural differentiator.
- **ML analysis** (better key/beat, structure detection, vocal detection) via ONNX models, same path as
  our Demucs/Whisper/CREPE work.
- **Modern, touch-friendly, themeable UI** (HTML/CSS/React) and easy cloud/library sync — the same
  direction Mixxx's own 3.0/QML rewrite is heading (`01` §5), but we start there.
- **Cross-platform single codebase** with web distribution options.

## 8. Verdict

**Feasible, and substantially de-risked by work we have already shipped.** The architecture is a direct
re-housing of Mixxx's proven thread/compute model onto AudioWorklet + WASM(SIMD/threads) + WebGPU +
Web MIDI, under the strict "no heavy lifting in JS" rule. Three standing decisions make it concrete:

1. **WebGPU is required, no fallback** (§0a) — we own the Electron Chromium runtime, so we enable it
   unconditionally and never author a parallel CPU/WASM path for GPU-targeted work.
2. **Anything Mixxx does natively that we lack, we build ourselves** as a WASM module or WGSL/WebGL
   shader (§2a) — never JS, never "can't." The only net-new work is a handful of Emscripten builds of
   the same C/C++ Mixxx already uses.
3. **Mixxx is the visual/UX reference; React + GPU canvases are the implementation** (§3a) — we mine
   its layout, not its UI tech.

The only genuine frictions — output latency/multi-device cueing and high-quality keylock parity — have
concrete mitigations and an *optional* native-addon escape hatch that does not gate the MVP. And the
stack lets us **exceed** Mixxx on stems, visuals, ML, and UX.

Recommended path: build on Web Audio/WASM/WebGPU (Option B in `07` §1), reuse the Loukai building blocks
(SoundTouch worklet, ffmpeg-wasm worker, WebGPU ONNX runner, asset proxy), build the (c)-class WASM libs
as needed (§2a), and keep a native audio addon in reserve only for pro multi-interface DVS cueing.

### Building blocks to lift from `../loukai`
- `soundtouch-worklet.js` → the keylock/time-stretch worklet.
- `phaseVocoderWorklet.js`, `*PitchDetector*`, `musicAnalysisWorklet.js` → real-time DSP patterns.
- `aacWorker.js` + `webgpuAssets.js` → the record/broadcast sidechain (ffmpeg-wasm in a Worker) + WASM
  asset delivery/caching.
- `createKaraoke.js` + `static/webgpu/*` + `monteslu/htdemucs-ft-webgpu` → the WebGPU stem-separation
  pipeline for stem decks.
- `butterchurn.min.js` → visualization precedent.
