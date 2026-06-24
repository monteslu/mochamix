# 03 — Mixxx Architecture (Big Picture)

How the whole system hangs together. Read this before the subsystem deep-dives. Source root:
`../mixxx-src/src` (~314k lines C++, Qt-based).

## 1. The spine: the `ControlObject` bus

The single most important architectural idea. A **`ControlObject`** (`src/control/controlobject.h`)
is a **named, thread-safe, atomic `double`** addressed by a **`ConfigKey` = `(group, item)`** pair:

```
[Channel1],play          [Channel1],volume       [Channel1],rate
[Master],crossfader      [Master],gain           [App],num_decks
[EffectRack1_EffectUnit1],super1                 [Sampler1],play
```

**Every subsystem communicates only through this bus, never by calling a deck/mixer method:**

```
        skin widgets ─┐                            ┌─ MIDI/HID controllers + JS scripts
        keyboard ─────┤   ControlObject bus        ├─ controller LED feedback
        QML proxies ──┤  (atomic doubles, by key)  ┤
                      └────────────┬───────────────┘
                                   │ (atomic reads; never blocks)
                          real-time audio engine
```

Properties that make this work:
- **Atomic doubles** → the real-time audio thread reads control values without locks; GUI/controller
  writes never block audio.
- **Pub/sub** → a `ControlProxy` (per-thread view) emits `valueChanged`, so widgets and controller
  scripts react to changes (e.g. an LED follows `[Channel1],play`).
- **Decoupling** → the UI doesn't know about the engine and vice-versa. A play button just writes
  `[Channel1],play = 1`; the engine's `EngineBuffer` reads it.
- **Flags:** `bPersist` (save/restore on exit), `bIgnoreNops` (don't emit on no-op set), `bTrack`
  (stats).

**For internal-dj this becomes a central reactive key/value store** keyed by `"[group],item"` strings,
owned by the main process (the engine reads it), mirrored to the renderer over IPC and to the audio
worklet via `SharedArrayBuffer` atomics. Get this contract right (and keep Mixxx's group/key names)
and you inherit the skin, controller, and effect conventions, plus the existing controller-mapping
ecosystem. See `07`.

### Group naming conventions (keep these)
| Group | Meaning |
|-------|---------|
| `[Channel1]`…`[Channel4]` | Decks |
| `[Sampler1]`…`[Sampler64]` | Samplers |
| `[PreviewDeck1]` | Preview deck |
| `[Microphone]`, `[Microphone2]`… | Mic inputs |
| `[Auxiliary1]`… | Aux line-ins |
| `[Master]` / `[Main]` | Master section, crossfader |
| `[EffectRack1_EffectUnitN]` | Effect unit N |
| `[EffectRack1_EffectUnitN_EffectM]` | Effect slot M in unit N |
| `[QuickEffectRack1_[ChannelN]]` | Per-deck QuickEffect |
| `[EqualizerRack1_[ChannelN]_Effect1]` | Per-deck EQ |
| `[App]` | App-wide (num_decks, num_samplers…) |
| `[Library]`, `[Playlist]`, `[AutoDJ]` | Library actions |

## 2. Threading model

| Thread | Role | Notes |
|--------|------|-------|
| **Main** (GUI) | Qt event loop, widget painting, library models, preferences | Where almost all heap allocation happens |
| **Engine** (real-time) | The PortAudio callback → `EngineMixer::process()`; all DSP/mixing/effects | Lock-free, atomic ControlObjects only, no allocation |
| **CachingReader workers** (high pri) | Per-deck disk decode + read-ahead | One per deck; lock-free FIFOs to the engine |
| **Controller** (high pri) | MIDI/HID poll + controller-script JS | 1 ms poll (5 ms Linux) |
| **EngineSideChain** (high pri) | Recording + broadcasting (encode + network I/O) | Lock-free ring from the engine |
| **Library scanner / analysis** (low pri) | Filesystem scan, BPM/key/waveform analysis | One analyzer thread per CPU core for batch |
| **DB** | one SQLite connection per thread via a pool | |

Cross-thread comms = Qt queued signals/slots + lock-free atomic ControlObjects (for anything the
real-time engine touches) + lock-free FIFOs (for bulk sample data to/from workers).

**The golden rule:** the real-time audio thread never allocates, never locks, never does I/O. Heavy
or unpredictable-latency work (decode, encode, network, file) is pushed to a worker behind a
lock-free queue. This rule shapes every "two-thread split" you'll see (effects, sidechain,
reader). It translates directly to **AudioWorklet ↔ SharedArrayBuffer ring ↔ Worker** in Electron.

## 3. Subsystem dependency graph & boot order

From `src/coreservices.cpp` (`CoreServices::initialize`). `CoreServices` owns nearly everything as
`std::shared_ptr`; construction order encodes the real dependency edges:

```
1.  SettingsManager (config), logging, fonts, translations, keyboard   ← needed first (scale/locale/paths)
2.  Database: DbConnectionPool + schema upgrade (mixxxdb.sqlite, v39)
3.  ChannelHandleFactory            (mints handles for all groups)
4.  EffectsManager                  ← engine needs it
5.  EngineMixer("[Master]", effectsManager, ...)   ← the audio engine
6.  SoundManager(engine)            ← owns the PortAudio real-time thread; registers Main/Booth/Head/Bus/Record outputs
7.  RecordingManager, BroadcastManager, VinylControlManager  (build-flag-guarded)
8.  PlayerManager(soundManager, effectsManager, engine)      ← deck/sampler factory
9.    creates: 4 mics, 4 aux, 2 decks (default), 4 samplers, 1 preview deck
10. EffectsManager.setup()          ← after decks exist, so chains attach
11. TrackCollectionManager (→ GlobalTrackCache), then Library (DB + collection + players + recording)
12. PlayerManager.bindToLibrary()   ← wires track-load signals; creates TrackAnalysisScheduler
13. ControllerManager               ← devices opened LAST (after skin ControlObjects exist)
14. loadSamplers(), SkinControls, load command-line files
```

`main.cpp` flow: build `CoreServices` (fast init) → construct `MixxxMainWindow` (shows a splash
immediately) → `CoreServices::initialize()` (the slow graph above) → `mainWindow.initialize()` (load
skin, **open sound devices = audio starts**) → open controllers → `show()` + `exec()`.

Teardown (`finalize()`) is strict reverse order: SoundManager (stop the callback first) → controllers
→ vinyl → players → library → recording → broadcast → engine → effects → DB, each with a leak
assertion.

**For internal-dj:** the main process replicates this service graph and order as Node singletons. The
order is load-bearing (PlayerManager needs engine+sound+effects; Library needs DB+collection+players).

## 4. The deck object stack (what "a deck" actually is)

A single deck is a stack of objects across the GUI/engine boundary:

```
Deck  =  BaseTrackPlayerImpl        (GUI/QObject: owns [ChannelN] ControlObjects, track-load logic)
           └─ EngineDeck            (an EngineChannel: pregain, pre/post-fader FX hooks, VU)
                └─ EngineBuffer      (the playback engine: produces samples per callback)
                     ├─ CachingReader (+ background reader thread)  ← decoded audio chunks
                     ├─ EngineBufferScale (linear / RubberBand / SoundTouch)  ← time-stretch/keylock
                     ├─ ReadAheadManager  ← loop/reverse/fractional-position logic
                     └─ QList<EngineControl>  ← stackable per-deck features (see 04 §3)
                          [Quantize, Looping, Vinyl, Rate, Bpm, Sync, Key, Clock, Cue]
```

`PlayerManager` (`src/mixer/playermanager.cpp`) is the factory. `getPlayer("[Channel1]")` resolves a
group → `ChannelHandle` → `BaseTrackPlayer*`. Samplers and preview decks are the same stack with
fewer controls.

## 5. The four layers you'll reimplement

1. **The control bus** (`03` §1) — the reactive store. Build this first.
2. **The audio engine** (`04`) — mixer loop, decks, scalers, controls, sync, sidechain.
3. **The data layer** (`05`) — SQLite schema, track model, decoding, analysis, waveforms.
4. **The presentation + input layer** (`06`) — skins (→ HTML/CSS components), controllers (→ Node
   MIDI/HID + the JS `engine` API), effects (→ Web Audio nodes/worklets).

Each is its own document. `07` is the synthesis: the recommended Electron architecture and build
plan. `08` is the file map into `../mixxx-src/src`.
