# 11 — Development Plan

The actionable plan, synthesizing all prior docs. Read `03` (architecture), `04` (engine), `07` (port
plan), and `10` (feasibility) for the "why" behind each choice here.

## 0. Decisions locked (these shape everything below)

| Decision | Choice | Why |
|----------|--------|-----|
| **North star** | **Playable 2-deck MVP, fast** | Get to "this is a real DJ app" (load, waveform, play/cue, EQ, crossfader, manual beatmatch) ASAP, then layer features. Milestones below front-load the mixer. |
| **Language** | **TypeScript throughout** | The control-bus contract, frame/sample types, and worklet↔worker message protocols benefit hugely from types. |
| **Loukai reuse** | **Extract to shared packages (monorepo)** | The proven blocks (SoundTouch worklet, ffmpeg-wasm worker, WebGPU ONNX runner, asset proxy) become shared packages both apps consume — no drift. |
| **Audio path** | **Web Audio / AudioWorklet (Option B, `07` §1)** | Native N-API addon kept in reserve only for pro multi-interface DVS cueing. |
| **WebGPU** | **Hard requirement, no fallback (`10` §0a)** | We own the Electron Chromium runtime. |
| **Heavy compute** | **Zero in JS — WASM(SIMD/threads) / WebGPU only (`10`)** | Anything Mixxx does natively that we lack → we build as a WASM lib or WGSL shader (`10` §2a). |
| **UI** | **React (DOM/CSS) + `<canvas>` for GPU surfaces (`10` §3a)** | Mixxx skins are the visual reference, not the implementation. |
| **Stack** | **Electron + Vite + React 19 + Vitest + TS** | Matches Loukai; lets us lift shared code cleanly. |

## 1. Repo & package layout (monorepo)

A pnpm/npm-workspaces monorepo. internal-dj is an app; the reusable substrate lives in `packages/` so
Loukai can adopt the same packages over time.

```
internal-dj/                      (this becomes the monorepo root, or a sibling root holding both apps)
  apps/
    internal-dj/                  the Electron app
      src/main/                   Node main process (CoreServices-equivalent, SQLite, Web MIDI routing)
      src/renderer/               React UI + AudioContext + worklets
      src/shared/                 IPC contracts, control-key constants, types
      electron-builder config, vite config
  packages/
    control-bus/                  the ControlObject store + SAB mirror + useControl hook   (03 §1)
    audio-engine/                 mixer graph, EngineBuffer, EngineControl stack, sync     (04)
    dsp-worklets/                 keylock (SoundTouch/RubberBand), scaler, VU              (04 §4)
    analysis/                     beat/key/loudness workers (essentia.js / WASM)           (05 §6)
    waveform/                     peak precompute + WebGPU/WGSL render                     (05 §7)
    codec/                        ffmpeg-wasm decode/encode worker (from Loukai aacWorker)  (05 §4-5)
    stem-gpu/                     Demucs/ONNX WebGPU runner (from Loukai)                   (10 §1)
    controller-host/              Web MIDI + Mixxx-mapping engine (the `engine`/`midi` API) (06 §2)
    mixxx-mappings/              vendored res/controllers/ (git subtree, tracked upstream) (06 §2, §6)
    db/                           SQLite schema + repos + GlobalTrackCache                 (05 §1)
  vendor/
    mixxx-src/                    reference clone (gitignored)
    mixxx-monteslu/               our smart-fader fork (reference)
```

The package boundaries are the same seams Mixxx has (`03` §5): control bus, engine, data, presentation.

## 2. The critical path (what unblocks what)

```
control-bus ──┬──> audio-engine ──┬──> [MVP mixer]
              │                   ├──> EngineControl stack (cue/loop/quantize)
              │                   ├──> dsp-worklets (keylock)        [the hard one]
              │                   └──> sync ──> smart-fader
              ├──> renderer UI (React + useControl)
              └──> controller-host (engine API over the same bus)
db ─────────> library UI
codec ──> decode (feeds engine) ; encode (feeds recording/broadcast)
waveform ──> deck UI ; analysis ──> beatgrid/key (feeds sync + library)
stem-gpu ──> stem decks (differentiator, later)
```

**`control-bus` is the spine and the first thing built.** Everything binds to it. **Keylock
(`dsp-worklets`) is the one true risk** — prototyped in M2 so it can't ambush us late.

## 3. Milestones

Each milestone ends in something demonstrable. "DoD" = definition of done.

### M0 — Skeleton & spine (foundation)
**Goal:** an Electron window that boots a service graph and a working control bus, end to end, with no
audio yet.
- Monorepo + TS + Vite + Electron + Vitest; lint/format; CI that builds + tests.
- `control-bus`: the `(group,key)→number` store, main-authoritative; IPC mirror (renderer↔main);
  `useControl()` React hook; a `SharedArrayBuffer` mirror stub (cross-origin isolation headers set so
  `SAB` + WASM threads work — `10` §5). Keep Mixxx's group/key names (`03` §1).
- `apps/internal-dj/main`: a CoreServices-equivalent that constructs services in dependency order
  (`03` §3), even if most are stubs.
- A trivial UI: two buttons bound to `[Channel1],play` / `[Channel2],play` proving round-trip
  renderer→main→renderer and the batched hi-rate channel.
- **DoD:** toggling a control in the UI updates the main-process store and echoes back; SAB reads work
  in a worklet stub; tests cover the store + IPC.

### M1 — Single deck plays (audio first light)
**Goal:** load a file, see its waveform, hear it play through the AudioWorklet engine.
- `codec`: extract Loukai's ffmpeg-wasm worker into the package; decode a file to a Float32 `AudioBuffer`
  (`decodeAudioData` for common formats; ffmpeg-wasm worker for the rest). Frames as the time unit
  (`05` §8).
- `audio-engine`: minimal `EngineMixer` worklet — one deck → pregain `GainNode` → output. Transport:
  play/pause, set position. `playbackRate` varispeed only (no keylock yet).
- `waveform`: peak precompute (max-abs, `OfflineAudioContext` or WGSL) → overview + scrolling render on
  a `<canvas>` (WebGPU primary). Play-position marker driven by the batched hi-rate path.
- Deck UI component (React) bound via `useControl`.
- **DoD:** drag in an MP3/FLAC → waveform renders → play/pause/seek works → position marker tracks audio.

### M2 — Keylock & the scaler (de-risk the hard part early)
**Goal:** prove independent tempo/pitch with clean seeks — the one genuine engineering risk (`10` §4b).
- `dsp-worklets`: extract Loukai's `soundtouch-worklet` as the first keylock engine. Add the
  rate/tempo/pitch split (`KeyControl` semantics, `04` §4). Implement the **start-pad / start-delay
  priming** so cue jumps don't glitch — the make-or-break detail.
- Linear scaler path for scratch/reverse (ramp-through-zero) and a small FIFO to slice variable
  stretcher output into 128-frame quanta (`04` §0).
- Begin the RubberBand-WASM build (`10` §2a, class (c)) as the "finer" engine; SoundTouch ships first.
- **DoD:** a track plays at ±20% tempo with keylock on (pitch held); cueing/seeking mid-stretch
  produces no audible click; tempo slider + keylock toggle wired to controls.

### M3 — Two decks + mixer (the MVP moment)
**Goal:** a usable 2-deck mixer. This is the "real DJ app" milestone.
- Scale the engine to 2–4 decks (`PlayerManager`-equivalent factory, `03` §4).
- Per-channel: gain/trim, **3-band EQ** (`BiquadFilterNode`, with full-kill), volume fader, PFL/cue
  (headphone bus via a split of one device for now — `10` §4a), channel VU.
- **Crossfader** (curve modes) + master/booth/headphone gain + balance.
- QuickEffect/filter knob (one Filter effect) per deck.
- Manual beatmatch workflow (rate slider + temp pitch-bend + waveform drag).
- **DoD:** load two tracks, beatmatch by ear, EQ + crossfade between them, cue in headphones. Shippable
  as an alpha.

### M4 — EngineControl stack (cues, loops, the DJ verbs)
**Goal:** the per-deck feature set DJs expect.
- Port the `EngineControl` pattern (`04` §5): a per-deck ordered list ticked each quantum over the
  shared bus, with a central seek queue + `nextTrigger` loop wrapping inside the scaler worklet.
- Hotcues (up to 36) + main cue + cue modes; intro/outro markers.
- Beatloops (1/32…512), loop in/out, halve/double, roll, reloop; quantize.
- Slip mode, beatjump, reverse/censor.
- **DoD:** set/recall hotcues, drop beatloops on-grid, roll, and reloop — all quantized — on both decks.

### M5 — Analysis & sync
**Goal:** beatgrids, keys, and automatic beatmatching.
- `analysis`: Node `worker_threads`, one per core; essentia.js (WASM) for beat/BPM/key, libebur128-WASM
  for loudness (`05` §6). Silence/intro-outro in light JS (`05` §6). Versioned blob storage so we skip
  re-analysis (`05` §8).
- Beatgrid model (`Beats`, frames) + key + ReplayGain on the track; waveform 4-band color from analysis.
- Sync engine (`04` §6): internal clock + leader/follower + half/double + proportional beat-distance
  correction.
- **Smart Fader** (`09`): build on the sync engine right after it lands (crossfader→leader-BPM lerp,
  half/double pinned off). Carry over the DDJ-FLX4 button mapping in M7.
- **DoD:** analyze a track (beatgrid + key + gain), SYNC two decks, engage Smart Fader and hear the
  tempo blend across the crossfader.

### M6 — Library
**Goal:** a real library, not a file picker.
- `db`: port `res/schema.xml` (SQLite via `better-sqlite3`, main process) + migrations runner; repos
  (tracks/cues/crates/playlists/analysis); `GlobalTrackCache` (`Map` + `WeakRef`) (`05` §1).
- Track table (virtualized grid + `BaseSqlTableModel`-equivalent); search parser (`QueryNode` →
  parameterized SQL, `05` §3); sidebar features (Tracks/Crates/Playlists/Browse/History/Analyze).
- Folder scan + background analysis queue; metadata via `music-metadata`.
- Auto DJ (the 5 transition modes, `02` §8); one importer (Rekordbox or Serato) as a proof.
- **DoD:** scan a folder, browse/search/sort, make crates/playlists, load to decks, run Auto DJ.

### M7 — Controllers (the strategic reuse win)
**Goal:** a real DDJ-FLX4 (and others) drives the app via reused Mixxx mappings.
- `controller-host`: **Web MIDI** + WebHID; the `engine`/`midi`/`console` global API backed by the
  control bus (`06` §2). Run mapping scripts in a sandbox (`node:vm`/worker).
- `mixxx-mappings`: vendor `res/controllers/` as a git subtree (track upstream); parse `.midi.xml`;
  keep `midi-components-0.0.js` + `common-controller-scripts.js` byte-for-byte (`10` §6).
- MIDI-learn wizard; LED feedback via output handlers.
- Smart Fader button mapping (`09`).
- **DoD:** a stock Mixxx DDJ-FLX4 mapping runs nearly unchanged; jog/scratch, EQ, cues, and Smart Fader
  work from hardware.

### M8 — Effects
**Goal:** the effects framework + a useful effect set.
- Effects as Web Audio node subgraphs + AudioWorklet effects; JSON manifests; metaknob link math
  (pure JS, `06` §3). Effect units routable to channels; per-deck QuickEffect.
- Ship a subset first: Filter, Echo, Reverb, Flanger, Bitcrusher, Distortion, the EQs; expand toward
  the 24 (`02` §9). Novel DSP we lack → WASM/WGSL (`10` §2a).
- **DoD:** load effects into a unit, route to a deck, sweep the superknob, save/load a chain preset.

### M9 — Recording, broadcasting, stem decks, polish
**Goal:** the pro features + the differentiator + ship-readiness.
- Recording: AudioWorklet → SAB ring → Worker → ffmpeg-wasm (the sidechain, `04` §7); WAV first, then
  MP3/FLAC/Ogg; split + cue sheet (`02` §10).
- Broadcasting: Icecast/Shoutcast from the same sidechain worker (`02` §11).
- **Stem decks** (`stem-gpu`): integrate Loukai's Demucs/WebGPU separation → on-the-fly
  acapella/instrumental + per-stem volume/FX (`10` §7) — the headline differentiator.
- Sampler decks, preview deck, mic/aux; theming/skins; settings UI; accessibility.
- **DoD:** record a mix to file, broadcast a stream, split a track into stem decks live.

## 4. Risk register (and when we touch each)

| Risk | Severity | Mitigation | First addressed |
|------|----------|-----------|-----------------|
| Keylock glitch-free seeks | **High** | SoundTouch worklet (proven) + RubberBand-WASM; replicate start-pad priming | **M2 (early on purpose)** |
| Audio output latency | Med | `latencyHint:'interactive'`, shallow graph; native addon escape hatch | M3 |
| Multi-device headphone cueing | Med | Split one device for MVP; native addon only if pro DVS needed | M3 |
| Beat-detection parity vs qm-dsp | Med | essentia.js first; compile qm-dsp→WASM for Mixxx-import parity | M5 |
| SAB / WASM-threads cross-origin isolation | Low | Electron-controlled headers (we already do this in Loukai) | M0 |
| Mapping-format compatibility drift | Low | Vendor `res/controllers/` as subtree; keep the global API stable | M7 |
| WebGPU device absent on a machine | Low | Hard requirement (`10` §0a) + actionable startup error | M1 |
| Monorepo extraction overhead | Low | Extract packages as they stabilize, not all up front | ongoing |

## 5. Cross-cutting engineering rules (apply from M0)

1. **Frames are the time unit** everywhere; `seconds = frame / sampleRate` (`05` §8).
2. **Float32 `[-1,1]`, stereo** internally (matches Web Audio).
3. **No heavy lifting in JS** — DSP/codec/ML in WASM (worklet/worker) or WebGPU (`10`).
4. **Everything binds to the control bus** by `[group],key`; keep Mixxx's names (`03` §1).
5. **Ramp every gain change; crossfade every seam** (loop wrap, scaler switch, fx enable) — or clicks
   (`04` §3).
6. **Versioned serialized blobs** (beats/keys/waveform) with `*_version` so we skip re-analysis (`05` §8).
7. **Real-time path: no allocation, no locks, no IPC.** Worklet talks to workers via SAB rings only
   (`04` §7).
8. **Test the pure logic** (sync math, search parser, metaknob links, MIDI `computeValue`, frame math)
   — it ports verbatim from Mixxx and is unit-testable without audio (port Mixxx's tests where useful,
   e.g. `smartfadercontroltest.cpp` → `09`).

## 6. Reuse leverage checklist (don't rebuild — see `07` §6, `10`)
- **From Loukai → shared packages:** SoundTouch worklet, phase-vocoder/pitch worklets, ffmpeg-wasm
  worker, WebGPU ONNX runner + Demucs ensemble, asset proxy/cache, butterchurn.
- **From Mixxx (verbatim/near-verbatim):** `res/schema.xml`, `res/controllers/*` +
  `midi-components-0.0.js`, the `.proto` files, search grammar, key-harmonic + BPM half/double logic,
  metaknob link math, sync proportional controller, MIDI `computeValue` transforms, our
  `smartfadercontrol` + its tests.
- **Build ourselves (WASM/WGSL, `10` §2a):** RubberBand, qm-dsp, libebur128, libxwax (only when DVS),
  exact-parity EQ/biquads, waveform reduction shader, GLSL→WGSL waveform/spinny.

## 7. Suggested first actions (M0, concrete)
1. Initialize the monorepo (workspaces + TS + Vite + Electron + Vitest); set cross-origin-isolation
   headers in the Electron `BrowserWindow` / dev server.
2. Create `packages/control-bus`: the store, the `[group],key` constant module (port Mixxx's names),
   the IPC mirror, the `useControl` hook, the SAB layout — with unit tests.
3. Stand up `apps/internal-dj` main-process CoreServices skeleton + a 2-button renderer proving the
   round trip (the M0 DoD).
4. In parallel, start the `git subtree` of Mixxx `res/controllers/` into `packages/mixxx-mappings` and
   a tracking script, so the mapping reuse is wired from the start.
