# internal-dj — Technical Research Notes

This directory holds deep technical research on **Mixxx** (the open-source DJ application) as the
reference design for **internal-dj**, a similar DJ app we are building with **Electron**.

Research sources:
- The Mixxx website: <https://mixxx.org/>
- The Mixxx 2.6 user manual: <https://manual.mixxx.org/2.6/en/>
- The Mixxx 2.6 source tree (cloned to `../mixxx-src`, ~314k lines of C++, schema v39).

All facts here were taken from the live site/manual and verified against the actual source. Where a
manual page returned 404, the value was confirmed from the source code (the canonical truth).

## Document index

| File | What's in it |
|------|--------------|
| [`01-overview-and-features.md`](01-overview-and-features.md) | What Mixxx is, the complete advertised feature list, formats, hardware/controller support, versions, the planned QML/3.0 rewrite. The product spec we are cloning. |
| [`02-functional-spec.md`](02-functional-spec.md) | Exhaustive UX/functional detail from the manual: decks, mixer, beatmatching/sync, looping, hotcues, tempo/keylock, library, Auto DJ, effects, recording, broadcasting, vinyl control, sampler. Exact control names and numeric ranges. |
| [`03-architecture.md`](03-architecture.md) | The big-picture architecture: the `ControlObject` bus (the spine), the threading model, the subsystem dependency graph, the boot sequence. |
| [`04-audio-engine.md`](04-audio-engine.md) | The real-time audio engine in depth: the mixer process loop, signal chain, `EngineBuffer`/scalers (keylock), `EngineControl` pattern, sync engine, sidechain (record/broadcast), VU meters. |
| [`05-library-and-data.md`](05-library-and-data.md) | The SQLite schema, DAO pattern, `Track` model, beatgrids/cues/keys, audio decoding, encoders, analyzers, waveform generation/storage, the library UI model and search parser. |
| [`06-ui-controllers-effects.md`](06-ui-controllers-effects.md) | The skin/widget system (XML→widget, connections, templating), the QML direction, the controller system (MIDI/HID + JS scripting, `engine` API, Components library), the effects framework. |
| [`07-electron-port-plan.md`](07-electron-port-plan.md) | The synthesis: how each Mixxx subsystem maps to an Electron/Web Audio/Node/SQLite stack, the recommended architecture for internal-dj, the hard parts, and a phased build plan. |
| [`08-source-map.md`](08-source-map.md) | A directory-by-directory map of the Mixxx `src/` tree so you can find the reference code for any feature. |
| [`09-smart-fader.md`](09-smart-fader.md) | **Our fork feature** (`../mixxx-monteslu`, branch `smart-fader`): a Pioneer/AlphaTheta/VirtualDJ-style "Smart Fader" (crossfader drives a tempo blend between both decks). Upstream hasn't taken it; we want it in internal-dj. What it does, our exact implementation, and how to port it. |
| [`10-electron-feasibility.md`](10-electron-feasibility.md) | **Why this is doable in Electron.** The stack: AudioWorklet + WASM (SIMD/threads) + WebGPU/WebGL + Web MIDI, under a strict "zero heavy processing in JS" rule. Grounded in the hard parts we already ship in `../loukai` (SoundTouch worklet = keylock, Demucs stem-separation on WebGPU, ffmpeg-wasm encode worker). Plus reusing Mixxx controller mappings via Web MIDI. |
| [`11-development-plan.md`](11-development-plan.md) | **The actionable plan.** Locked decisions (TS throughout, monorepo with shared packages, playable-2-deck-MVP-first), repo/package layout, the critical path, milestones M0–M9 each with a definition of done, a risk register, engineering rules, and concrete first actions. |

## TL;DR for internal-dj

Mixxx's architecture has one organizing idea worth copying wholesale: a **named control bus**
(`ControlObject`, addressed by `[group],key` strings like `[Channel1],play`). Every subsystem (UI,
controllers, keyboard, the audio engine) communicates only through this bus of thread-safe atomic
doubles. Nothing calls a deck method directly. Replicate this as a reactive key/value store and the
UI, controller, and effects conventions all fall into place, and you inherit Mixxx's controller
mapping ecosystem nearly for free.

The other load-bearing patterns:
- **`EngineControl` stack** — per-deck features (loop, cue, rate, sync, key, quantize) are independent
  objects ticked once per audio buffer over a shared blackboard. Add a feature = add a class.
- **Two-thread split** for anything heavy (effects, recording, broadcasting, disk decode): the
  real-time audio path stays allocation- and lock-free; everything else runs on workers behind
  lock-free FIFOs. In Electron this is AudioWorklet ↔ SharedArrayBuffer ring ↔ Worker.
- **Frames are the universal time unit** (not seconds/ms). `seconds = frame / sampleRate`. Samples
  are float32 in `[-1, 1]` everywhere, which matches Web Audio natively.
- **Versioned serialized blobs** (beats/keys/waveform) with a `*_version` string so analysis is
  skipped when a current cached result exists.
