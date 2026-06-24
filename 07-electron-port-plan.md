# 07 — internal-dj: Electron Architecture & Build Plan

The synthesis. How Mixxx's design maps onto an Electron/Web Audio/Node/SQLite stack, the recommended
architecture, the hard parts, and a phased plan. Read `03`–`06` first.

## 1. Process & thread topology

Mirror Mixxx's threading model onto Electron's process model:

```
┌─ Electron MAIN process (Node) ───────────────────────────────────────────┐
│  • CoreServices equivalent: boot the service graph (see 03 §3)            │
│  • ControlObject store (authoritative; the engine reads it)               │
│  • SQLite (better-sqlite3), library/track repos, GlobalTrackCache         │
│  • ControllerManager: node-midi / node-hid + the JS `engine` API          │
│  • Worker threads: library scan, analysis (1/core), file decode, encode   │
│  • Recording/broadcast worker (encode + network I/O)                      │
└───────────────────────────────┬───────────────────────────────────────────┘
                                 │ IPC (control bus mirror; batched hi-rate path)
┌─ RENDERER process (Chromium) ──┴───────────────────────────────────────────┐
│  • Skin = HTML/CSS/JS components bound to the control store (07 §2)        │
│  • Waveforms/spinny/overview = WebGL/WebGPU <canvas>                       │
│  • AudioContext + the audio engine:                                        │
│      AudioWorklet "engine" ── SharedArrayBuffer rings ── Web Workers       │
│        (decks decode-ahead, keylock stretcher, effects, sidechain tap)    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Where does the audio engine live? (the key decision)
Two viable options:

**Option A — Native addon (best parity).** Wrap a C++ `EngineMixer` + PortAudio (or `naudiodon`/
`miniaudio`) as an N-API module in the main process. Keeps the real-time thread + lock-free discipline
+ RubberBand keylock exactly as Mixxx has it. Heaviest to build/ship; native build per platform.

**Option B — Web Audio / AudioWorklet (most "Electron-native").** Reimplement `EngineMixer::process()`
in an `AudioWorkletProcessor` in the renderer. Deck decode-ahead in Web Workers feeding ring buffers
via `SharedArrayBuffer`; keylock = RubberBand/SoundTouch compiled to WASM in a worklet; the
ControlObject bus mirrored into the worklet via SAB atomics (the JS analog of atomic-double
ControlObjects). Easiest to ship, fully sandboxed, but you reimplement the engine and own the keylock
WASM.

**Recommendation:** start with **Option B** (Web Audio) for MVP velocity and clean cross-platform
shipping; it covers everything except pro-grade multi-device output. Keep Option A as an escape hatch
if low-latency multi-soundcard / DVS becomes a hard requirement. Our existing browser-audio work
de-risks Option B substantially — see **`10-electron-feasibility.md`**, which grounds the whole
approach in code we already ship in `../loukai` (SoundTouch time-stretch in an AudioWorklet = the
keylock primitive, Demucs 4-stem separation on WebGPU, ffmpeg-wasm encode in a Worker). The governing
rule: **zero heavy processing in JS** — all DSP/codec/ML runs in WASM (worklet/worker) or on the GPU.

> Note: a renderer `AudioContext` is **one output device**. Routing Main vs Headphones to two sound
> cards (DJ cueing) needs two `AudioContext`s (independent clocks → the drift problem Mixxx solves
> with FIFOs) or `setSinkId`. For MVP, do headphone cueing as a split of one stereo device, or defer.

## 2. The control bus = the IPC contract (build this first)

Mixxx's `ControlObject` bus becomes a reactive `(group,item) → number` store. It is the spine; build it
before anything else.

- **Authoritative copy in the MAIN process** (the engine reads it). Keep Mixxx's exact group/key names
  (`[Channel1],play`, `[Master],crossfader`, …) — see `03` §1 — so you inherit skin/controller/effect
  conventions and the mapping ecosystem.
- **Renderer mirror over IPC:**
  - renderer → main: `valueChangeRequest({key, value})` (main validates, applies, confirms).
  - main → renderer: `controlChanged({key, value})` (pub/sub).
  - **Batched hi-rate path** for `play_position`, VU meters, waveform scroll (~30–60 Hz, coalesced;
    never one IPC message per audio block).
- **Audio worklet mirror via SharedArrayBuffer:** a flat `Float64Array` indexed by control id, written
  atomically. The worklet reads control values lock-free (exactly like Mixxx's atomic doubles).
- **Renderer binding hook:** `useControl("[Channel1]","play") → [value, setValue]` (the analog of a
  skin `<Connection>` and of `QmlControlProxy`). Display-only widgets subscribe one-way.

```
// shape
type ConfigKey = `[${string}],${string}`;
controlStore.get(key): number
controlStore.set(key, value): void            // renderer → requests; main → applies
controlStore.on(`change:${key}`, cb)          // pub/sub (this is engine.makeConnection)
```

## 3. Subsystem-by-subsystem mapping (quick reference)

| Mixxx subsystem | internal-dj (Electron) | Doc |
|-----------------|------------------------|-----|
| ControlObject bus | reactive `(group,key)→number` store; main-authoritative, IPC + SAB mirrors | 03 |
| CoreServices boot | main-process service graph, same order | 03 |
| EngineMixer::process | AudioWorklet `process()` (Option B) or N-API EngineMixer (Option A) | 04 |
| Per-deck signal chain | Web Audio node graph; gain ramps via `AudioParam` | 04 |
| EngineBufferScale keylock | **custom worklet wrapping RubberBand/SoundTouch WASM** (hard) | 04 |
| ReadAheadManager loop/reverse | port verbatim **inside** the stretcher worklet | 04 |
| CachingReader chunked decode | mostly drop — `decodeAudioData()` → in-memory `AudioBuffer` | 04 |
| EngineControl stack | per-deck control classes ticked over the shared store | 04 |
| Sync engine | pure JS math over the audio clock | 04 |
| Sidechain (record/broadcast) | AudioWorklet → SAB ring → Worker (WASM ffmpeg + net) | 04 |
| VU meters | rate-limited (~30 Hz) atomic publish, fast-attack/slow-decay | 04 |
| SQLite + DAOs | `better-sqlite3` + repository modules; same schema for import compat | 05 |
| GlobalTrackCache | `Map<id,Track>` + `WeakRef`/`FinalizationRegistry` | 05 |
| Track / Beats / Cue / Keys | JS classes; positions in **frames**; protobuf or JSON blobs | 05 |
| Audio decoding | **one FFmpeg** (`f32le`) or `decodeAudioData()`; `libopenmpt` WASM for trackers | 05 |
| Encoders | FFmpeg `-c:a …` / `lamejs`; WAV/AIFF = header + PCM | 05 |
| Analyzers | Node `worker_threads`; **essentia.js** (beats/key/loudness) or qm-dsp WASM | 05 |
| Waveform gen/store | OfflineAudioContext peaks (max-abs, 4-band biquad); `Uint8Array` + gzip in BLOB | 05 |
| LibraryFeature sidebar | sidebar-plugin interface emitting `showTrackModel`/`loadTrack` | 05 |
| BaseSqlTableModel | paginated SQL-backed virtual table + virtualized grid | 05 |
| Search parser | `QueryNode` tree → **parameterized** SQL fragments (port verbatim) | 05 |
| Skin (XML widgets) | HTML/CSS component tree + a component registry | 06 |
| QML + QmlControlProxy | the React/Vue component tree + the control hook | 06 |
| Waveform/spinny widgets | WebGL/WebGPU `<canvas>` (GLSL ports largely) | 06 |
| Controller system | `node-midi`/`node-hid` + the JS `engine` API | 06 |
| **midi-components-0.0.js + res/controllers** | **reuse nearly unchanged** (keep `engine`/`midi`/`console` globals) | 06 |
| Effects framework | Web Audio node subgraphs + AudioWorklet effects; JSON manifests | 06 |
| Effects message pipe / deferred-free | not needed (Web Audio atomic graph updates + GC) | 06 |

## 4. The hard parts (budget extra time)

1. **Keylock (independent tempo/pitch).** No Web Audio primitive. Compile **RubberBand** (or
   SoundTouch) to WASM, run it in a custom `AudioWorkletProcessor`, and replicate the start-pad /
   start-delay priming or every seek glitches. This is the single biggest engineering risk in Option
   B. (`playbackRate` only gives varispeed/vinyl-style pitch-follows-speed, which you still need for
   scratching/reverse.)
2. **Beat detection parity.** qm-dsp has no first-class JS port. `essentia.js` is the pragmatic choice
   (good beats/key/loudness, one WASM dep) but won't be bit-identical. For real Mixxx-library import
   parity, compile qm-dsp + libebur128 to WASM.
3. **Low-latency + multi-device audio.** Web Audio latency is higher and less controllable than
   PortAudio/ASIO; multi-soundcard cueing needs multiple `AudioContext`s (drift). If pro DVS/cueing is
   a hard requirement, that's the trigger for Option A.
4. **Scratching feel.** The alpha-beta jog filter (`engine.scratchEnable`) + ramp-through-zero in the
   linear scaler must run sample-accurately in the worklet. Port `ratecontrol.cpp` jog/scratch math
   carefully.
5. **Glitch-free everything.** Mixxx ramps every gain change and crossfades every seam (loop wrap,
   scaler switch, effect enable/disable). Skipping this = clicks. Use `AudioParam` ramps + short
   crossfades religiously.
6. **AAC licensing.** Deliberate choice (licensed FFmpeg build vs WebCodecs platform AAC). See the
   existing project memory on the Loukai AAC encoder decision (browser ffmpeg-wasm in the renderer was
   the chosen save-path).

## 5. Phased build plan

### Phase 0 — Foundation
- The control-bus store (main-authoritative) + IPC mirror + the renderer `useControl` hook + the SAB
  worklet mirror. Lock the group/key naming convention (copy Mixxx's).
- Boot skeleton (CoreServices-equivalent) wiring an empty engine + an empty store.
- `better-sqlite3` + the schema (port `res/schema.xml` revisions) + a migrations runner.

### Phase 1 — Core playback (MVP)
- One deck: `decodeAudioData()` → `AudioBufferSourceNode` → pregain → 3-band EQ (`BiquadFilterNode`) →
  volume → output. Play/pause/cue. Frames-based positions.
- Waveform: OfflineAudioContext peaks → WebGL scrolling + overview. Play marker.
- Tempo via `playbackRate` (varispeed first); rate slider ±10%.
- Then 2–4 decks + crossfader + per-channel VU + master out.

### Phase 2 — DJ features
- The `EngineControl` stack: hotcues (up to 36) + main cue + cue modes, beatloops + loop in/out +
  halve/double + roll + reloop, quantize.
- **Keylock** (the RubberBand WASM worklet) — the big one.
- Beat/key/ReplayGain analysis (essentia.js workers) + beatgrid storage (versioned blobs).
- Sync engine (internal clock + leader/follower + half/double).
- **Smart Fader** (`09`) — our fork's crossfader-drives-tempo-blend feature. Ports as a small control
  on top of the sync engine; do it right after sync + keylock land (it depends on both). Carry over
  the DDJ-FLX4 SMART FADER button mapping.

### Phase 3 — Library
- Schema + repos + GlobalTrackCache; the track table (virtualized grid + `BaseSqlTableModel`
  equivalent); search parser (`QueryNode` → parameterized SQL).
- Sidebar features: Tracks, Crates, Playlists, Browse, History, Analyze, Recordings.
- Auto DJ (the 5 transition modes); importers (start with one, e.g. Rekordbox or Serato).

### Phase 4 — Effects, recording, broadcasting
- Effects framework (Web Audio node subgraphs + JSON manifests + metaknob link math); the 24 native
  effects (or a useful subset: Filter, Echo, Reverb, Flanger, Bitcrusher, Distortion, the EQs).
- QuickEffect per deck; effect units routable to channels.
- Recording (AudioWorklet → SAB ring → Worker → ffmpeg-wasm/WAV); split + cue sheet.
- Broadcasting (Icecast/Shoutcast from the same sidechain worker).

### Phase 5 — Controllers & polish
- `node-midi`/`node-hid` + the JS `engine`/`midi` API + `midi-components-0.0.js` → **bring up real
  Mixxx mappings nearly unchanged.** MIDI-learn wizard.
- Sampler decks, preview deck, mic/aux inputs.
- Skins/theming, accessibility, settings UI.
- (Stretch / differentiators) stem support (aligns with 2.6 + our `../stem-mp4` work), inbound
  streaming services, cloud sync, touch UI.

## 6. Reuse leverage (don't rebuild these)
- **`res/controllers/`** — 163 mapping XMLs + `midi-components-0.0.js`: reuse with the `engine`/`midi`
  global contract preserved.
- **`res/skins/`** — reference layouts/proportions for our component tree; the GLSL shaders in
  `src/shaders/` port to WebGL/WebGPU.
- **`res/schema.xml`** — the SQLite schema, portable as-is for import compatibility.
- **`.proto` files** (beats/keys/waveform) — load into `protobufjs` to read/write real Mixxx DBs.
- **Search grammar, key-harmonic + BPM half/double logic, MIDI `computeValue` transforms, metaknob
  link math, sync proportional controller** — pure logic, port verbatim.
- **Our Smart Fader** (`../mixxx-monteslu` branch `smart-fader`, `09`) — `smartfadercontrol.cpp` (the
  crossfader→leader-BPM lerp), the DDJ-FLX4 button mapping, and the unit tests port nearly verbatim
  onto our sync-engine port.

## 7. Recommended JS/Node stack
- SQLite: `better-sqlite3`. Protobuf: `protobufjs`. Decode/encode: `@ffmpeg/ffmpeg` (WASM) and/or a
  native ffmpeg via `fluent-ffmpeg`; `lamejs` for pure-JS MP3; `libopenmpt` WASM for trackers.
- Analysis: `essentia.js` (or custom qm-dsp/libebur128 WASM). Keylock: RubberBand/SoundTouch WASM.
- MIDI/HID: `@julusian/midi` (or `easymidi`), `node-hid`. Tags: `music-metadata`.
- Waveforms: `wavesurfer.js` / `waveform-data.js` (or hand-rolled WebGL), BBC `audiowaveform` CLI.
- UI: React/Vue/Svelte + a virtualized list (TanStack Virtual). Sandbox controller scripts in
  `node:vm` or a worker.
