# 04 — The Real-Time Audio Engine

The heart of any DJ app. How Mixxx turns track files + control values into the master output, in
real time. Files under `../mixxx-src/src/engine`, `src/soundio`, `src/audio`.

## 0. Fundamental types & constants

| Thing | Value | Source |
|-------|-------|--------|
| `CSAMPLE` | **`float`** (32-bit), normalized `[-1, 1]` | `util/types.h:27` (`using CSAMPLE = float`) |
| Engine output | always **stereo, interleaved** `[L0,R0,L1,R1,…]` | `engine/engine.h` |
| `bufferSize` | always **interleaved samples** (= frames × 2) | throughout |
| Max input channels | 8 (4 stereo pairs, for stems) | `audio/types.h` |
| `kMaxEngineFrames` | 8192 | `util/defs.h` |
| Default sample rate | **44100** (fallback 48000) | `soundmanagerconfig` |
| Device sample format | `paFloat32` (no conversion; CSAMPLE is float) | `sounddeviceportaudio.cpp` |
| Default buffer | latency idx 5 → ~1024 frames (~23 ms @ 44.1k) | `soundmanagerconfig` |

**Key for the port:** float32 + stereo matches Web Audio natively. The one mismatch: Mixxx is
**interleaved** internally; Web Audio `AudioWorklet` gives **planar** per-channel arrays of **128
frames** per quantum. Plan a small FIFO to slice variable engine output into exact 128-frame quanta.

## 1. The audio callback & pull chain

`SoundManager` owns the real-time PortAudio thread (named "Engine", `SCHED_FIFO` on Linux /
TimeCritical elsewhere). `EngineMixer` is a passive `AudioSource`. Per hardware callback:

```
PortAudio thread
 └ SoundDevicePortAudio::callbackProcessClkRef(framesPerBuffer, out, in)
     deinterleave device input → AudioDestinations
     SoundManager::onDeviceOutputCallback(frames)
       └ EngineMixer::process(frames * 2)        ← THE ENGINE, runs inline (no separate thread)
     composeOutputBuffer(out)                     ← clamp + interleave engine buffers → device
```

Output is shared by **direct pointer**: each `AudioOutput` is bound to `EngineMixer::buffer(output)`
(a span into an internal mix buffer); the device reads through that pointer after `process()` fills
it. No per-callback copy.

When multiple sound cards are open, exactly one ("clkref") drives the engine; others are slaved via
drift-corrected lock-free FIFOs. **Web Audio gives you one `AudioContext` clock for free** — so the
multi-device drift problem largely disappears, but so does multi-device output (one `AudioContext` =
one device; routing Main/Booth/Headphones to different cards needs multiple contexts → independent
clocks → the drift problem returns).

## 2. `EngineMixer::process()` — order of operations

(`engine/enginemixer.cpp`, the `process()` method.) One call:

1. Read enable flags + sample rate; `iFrames = bufferSize / 2`.
2. `m_pEngineEffectsManager->onCallbackStart()` — drain the effects message pipe (the one safe
   mutation point for the effect graph).
3. **`processChannels()`** — produce each deck's samples:
   - `EngineSync::onCallbackStart()` (publish clock BPM).
   - Classify each active channel into buses (crossfader L/C/R orientation, PFL/headphone, talkover/mic).
   - **Process the sync leader channel first** (so followers read a fresh beat distance).
   - For each active channel: `pChannel->process(buffer, bufferSize)`; gather effect features.
   - `EngineSync::onCallbackEnd()` (clock advances) + per-channel post-process.
4. **Headphone (PFL) mix** → `m_head` (+ headphone-bus effects).
5. **Talkover (mic) mix** → `m_talkover` (+ ducking computed).
6. **Crossfader gains** via `EngineXfader::getXfadeGains(...)`.
7. **Bus mixdown** for L/C/R: per-channel gain (volume × crossfader) + post-fader effects, summed
   into `m_outputBusBuffers[o]` (+ bus effects).
8. **Main mix** = sum the 3 buses into `m_main`.
9. Mic-monitor-mode branch orders main effects / ducking / booth copy / talkover / main gain / what
   feeds the sidechain.
10. **Main gain** (ramped), **balance**, **VU meter**.
11. Optional mono mixdown; output delays (latency alignment).
12. `m_pEngineSideChain->writeSamples(...)` (record/broadcast hand-off, non-blocking).
13. `m_pWorkerScheduler->runWorkers()` (wake reader workers).

## 3. The per-deck signal chain (where gain/EQ/FX/xfader apply)

The order is fixed and well-defined. For one deck:

```
EngineBuffer.process()            → raw scaled/time-stretched samples
 └ EnginePregain.process()        → pregain pot + ReplayGain + vinyl speed-gain
 └ EngineEffectsManager.processPreFaderInPlace()   → PRE-fader FX (the EQ rack + QuickEffect/filter)
 └ EngineVuMeter.process()        → per-deck VU
        ↓ (in the mixer, during bus mixdown)
   gain = volumeFader × crossfaderOrientationGain   (ramped old→new)
   EngineEffectsManager.processPostFaderInPlace()   → POST-fader FX (standard effect units)
   sum into the orientation bus
        ↓
   buses → main mix → main effects → main gain → balance → delay → output
```

Canonical chain: **decode/scale → pregain/ReplayGain → pre-fader FX (EQ/filter) → volume fader →
crossfader → post-fader FX → bus sum → main FX → main gain → balance → delay → out.** EQ is *not* a
hardcoded stage; it's a pre-fader effect rack.

**Gains are always ramped across the buffer** (`m_*GainOld` + `applyRampingGain`) to avoid zipper
noise; channels going inactive fade to zero. **In Web Audio, `AudioParam.linearRampToValueAtTime`
gives this for free.** The whole chain maps onto a per-deck Web Audio node graph: source/worklet →
`GainNode` (pregain) → EQ (`BiquadFilterNode`s or worklet) → `GainNode` (volume) → crossfader gains →
effect nodes → master `GainNode`.

### Buses
`m_main`, `m_booth`, `m_head` (PFL/headphones), `m_talkover` (mics), 3× `m_outputBusBuffers`
(crossfader L/C/R), `m_sidechainMix`. The PFL/headphone bus is how a DJ previews a deck (cue) without
it reaching the audience; `headMix` blends PFL vs main; `headSplit` puts PFL-mono left, main-mono
right.

## 4. `EngineBuffer` — how one deck produces samples

(`engine/enginebuffer.cpp`.) One per deck. `process(out, bufferSize)`:
1. `m_pReader->process()` — drain the caching reader's status FIFO.
2. `m_pause.tryLock()` (the only lock, for safe track swaps; outputs silence rather than blocking
   while loading) → `processTrackLocked`:
   - `processSyncRequests`, `processSlip`, `processSeek`.
   - Compute `speed` via `RateControl::calculateSpeed(...)`.
   - **Choose the scaler:** linear (varispeed) vs RubberBand/SoundTouch (keylock). Scratching, or
     `|speed| > 1.9`, or `|speed| < 0.1` force the linear scaler.
   - `framesRead = m_pScale->scaleBuffer(out, bufferSize)` — fills the buffer exactly; returns source
     frames consumed (may be fractional). Recover true play position via the read-ahead log.
   - Crossfade if the scaler changed (avoid clicks).
   - **Tick all `EngineControl`s** (see §5).
   - `hintReader(rate)` — controls declare prefetch regions.

### `EngineBufferScale` — time-stretch / pitch (the keylock problem)
Contract (`bufferscalers/enginebufferscale.h`): `scaleBuffer(out, size)` fills the output and returns
source frames consumed; `setScaleParameters(baseRate, *tempoRatio, *pitchRatio)`.

- **`EngineBufferScaleLinear`** — varispeed: one rate does resampling + tempo, so pitch follows speed
  (like vinyl). Only this scaler can **ramp through zero**, so it's used for scratching and reverse.
- **`EngineBufferScaleRubberBand`** — keylock: wraps the RubberBand library (`OptionProcessRealTime`).
  `setTimeRatio` controls tempo independently of `setPitchScale`. Works on **planar** buffers. Has
  internal latency: after `reset()` it must be primed (`getPreferredStartPad()` silent samples) and
  the leading `getStartDelay()` output frames dropped, or every seek mangles the first transient.
- **`EngineBufferScaleST`** — SoundTouch alternative.

**This is the hardest port.** Web Audio's `AudioBufferSourceNode.playbackRate` is varispeed (=linear
scaler). **There is no built-in keylock.** You must compile **RubberBand or SoundTouch to WASM** in a
custom `AudioWorkletProcessor` (its `process()` = `scaleBuffer()`), and replicate the start-pad /
start-delay priming dance or seeks glitch.

### `ReadAheadManager` — loops, reverse, fractional position
(`engine/readaheadmanager.cpp`.) Sits between scaler and reader. Handles: direction from `sign(rate)`;
**loop wrapping** (asks `LoopingControl::nextTrigger(reverse, pos, &target)` for the next boundary,
clamps the read to stop exactly there, jumps, and **linearly crossfades the seam** for a click-free
loop); a **read-ahead log** to recover the true fractional play position. **This logic ports verbatim
and belongs inside the time-stretch worklet** (it must run synchronously with sample production).

### `CachingReader` — chunked background decode
(`engine/cachingreader/`.) Decouples disk I/O from the RT read. Chunk = 8192 frames; ~80 chunks in a
pre-allocated LRU buffer; a background `CachingReaderWorker` thread decodes via `SoundSource`; two
lock-free FIFOs connect it to the RT thread. `read()` never blocks (cache miss → silence + async
request). **Mostly unnecessary in Web Audio:** `decodeAudioData()` returns a fully-decoded in-memory
`AudioBuffer`; index it directly. Keep something chunk-like only for very long tracks (stream-decode
via WebCodecs into a ring).

## 5. The `EngineControl` pattern (the reusable gem)

`EngineBuffer` owns an ordered `QList<EngineControl*>` and ticks each once per callback. Each per-deck
feature is an independent `EngineControl` subclass communicating only through shared ControlObjects.

Base interface (`engine/controls/enginecontrol.h`): `process(rate, currentPos, bufferSize)` (void),
`hintReader(...)`, `notifySeek(pos)`, `setFrameInfo(...)`, `trackLoaded(...)`. **Controls do not
return seek targets** — they call protected `seekAbs/seekExact/setLoop` helpers that enqueue a
`QueuedSeek` reconciled once per callback by `EngineBuffer::processSeek()` (single-writer rule → no
races). Loop wrapping is the exception (sample-accurate, in `nextTrigger`).

Fixed order (constructor): `QuantizeControl` → `LoopingControl` → `VinylControlControl` →
`RateControl` → `BpmControl` → `SyncControl` → `KeyControl` → `ClockControl` → `CueControl`.

- **RateControl** — folds every speed input (temp/perm pitch bend, wheel/jog/scratch, vinyl, search,
  reverse, sync) into one `speed` scalar via `calculateSpeed(...)`.
- **LoopingControl** — loop in/out, beatloops (sized via the beatgrid), reloop; `nextTrigger()`
  returns `(triggerFrame, targetFrame)` consumed by `ReadAheadManager`.
- **CueControl** — main cue + up to 36 hotcues + intro/outro; purely event-driven (no `process()`
  override); activating a cue = `seekAbs(position)` through the central queue.
- **BpmControl / SyncControl** — the sync brain (see §6).
- **KeyControl** — splits pitch vs tempo, key shift.
- **QuantizeControl** — computes prev/next/closest beat from the beatgrid.

**Port verbatim:** a per-deck `EngineBuffer` object with `controls = [quantize, looping, rate, bpm,
sync, key, clock, cue]`, each a class with `process/notifySeek/hintReader`; a per-deck reactive
key/value store as the only cross-control channel; one central seek queue applied per quantum then
broadcast via `notifySeek`; loop wrapping in the sample-pull path. Adding a feature = one class + push
to the array.

## 6. Sync engine (beatmatching)

`EngineSync` (`engine/sync/enginesync.cpp`) is a hub-and-spoke router (`SyncableListener`). It owns no
audio; BPM/beat-distance live in the Syncables (backed by ControlObjects). It just relays "the
leader's value changed" to followers.

- **Modes** (`syncable.h`): `None`, `Follower`, `LeaderSoft`, `LeaderExplicit`. Exactly one leader.
  `pickLeader()`: explicit wins; else the single audible playing deck; else current leader; legacy
  mode picks the internal clock when >1 deck plays.
- **`InternalClock`** — a free-running metronome Syncable. `beatLength = sampleRate*60/bpm` (samples
  per beat); **beat distance = `clockPosition / beatLength`** ∈ `[0,1)`. Each callback advances
  `clockPosition += frames`, wraps with `fmod`, publishes beat distance.
- **Per-callback order:** publish clock BPM → leader deck → follower decks → clock advances/broadcasts
  beat distance. Processing the leader first guarantees a fresh beat distance for followers.
- **Follower rate (tempo)** = `leaderInstBpm / localBpm × calcSyncAdjustment` — a capped proportional
  controller on beat-distance error (`adjust = 1 - 0.7*error`, per-step ±0.02, total ±0.05, hard
  catch-up ±0.05 above 0.2 error). Followers bend rate ≤5%, never hard-jump.
- **Follower phase (one-shot)** — on sync/seek, `getNearestPositionInPhase` aligns to the leader's
  beat distance.
- **Half/double** multiplier in `SyncControl` (`m_leaderBpmAdjustFactor ∈ {1, 0.5, 2}`, √2 threshold)
  so 70 BPM locks to a 140 BPM leader.

**Pure math over the audio clock — ports directly.** Model each participant as `{bpm, baseBpm,
beatDistance, localBpm, isPlaying, isAudible, quantize}`; keep one `leader` ref; tick the internal
clock per quantum; compute follower rate; implement half/double. No Web Audio specifics.

## 7. VU meters & sidechain (record / broadcast)

### VU meter (`engine/enginevumeter.cpp`)
Mean-of-abs per channel, log-scaled, asymmetric smoothing (fast attack, slow decay). **GUI updates
gated to ~30 Hz** (`kVuUpdateRate = 30`) with an epsilon dead-band (0.0001) so it doesn't flood the
GUI/MIDI. Clip indicator updated **every** callback (held 500 ms) — never miss a transient. In the
port: a rate-limited (~30 Hz) atomic/postMessage publish, not a per-block repaint.

### Sidechain (`engine/sidechain/enginesidechain.cpp`)
A `QThread` (high pri) + `AudioDestination`. Exists because MP3/OGG/AAC **encoding + disk + network
I/O have unpredictable latency** and must never run in the audio callback. Handoff = a lock-free
`FIFO<CSAMPLE>` (`SIDECHAIN_BUFFER_SIZE = 65536`). Producer (`writeSamples`, in the engine) is
non-blocking and **drops + counts on overrun** rather than blocking audio; wakes the worker at ~80%
full. Consumer drains and runs each `SideChainWorker` (`EngineRecord`, the broadcast/shoutcast
worker).

**Textbook AudioWorklet → SharedArrayBuffer ring → Worker:** worklet writes the master buffer to a
SPSC ring (drop+count on overflow, `Atomics.notify` at threshold); a Worker `Atomics.wait`s, drains,
and runs the encode (WASM ffmpeg) + network I/O off the audio thread.

## 8. Port summary: clean vs custom-work

**Clean translation:**
- float32/stereo/`[-1,1]` = Web Audio native.
- Per-deck signal chain = a Web Audio node graph; gain ramping free via `AudioParam`.
- `EngineControl` stack + shared blackboard + central seek queue + `nextTrigger` loop wrapping.
- Sync engine (math over the audio clock).
- Sidechain = AudioWorklet→SAB-ring→Worker; VU = rate-limited atomic publish.
- ReadAheadManager loop/reverse/crossfade logic (port into the worklet).

**Needs custom work:**
- **Keylock** — no built-in; custom worklet wrapping RubberBand/SoundTouch WASM + the priming dance.
- **Multi-device output** — one `AudioContext` = one device; multiple contexts reintroduce drift.
- **Render quantum fixed at 128 frames** — add a FIFO to slice variable stretcher output.
- Chunked decode mostly unnecessary (`decodeAudioData` gives full in-memory buffers).

### Key files
Mixer/callback: `engine/enginemixer.cpp`, `channelmixer.cpp`, `channels/enginedeck.cpp`,
`enginepregain.cpp`, `enginexfader.cpp`. I/O: `soundio/sounddeviceportaudio.cpp`,
`soundio/soundmanager.cpp`. Playback: `engine/enginebuffer.cpp`, `bufferscalers/*`,
`readaheadmanager.cpp`, `cachingreader/*`. Controls: `engine/controls/*`. Sync: `engine/sync/*`.
Sidechain/VU: `enginevumeter.cpp`, `sidechain/*`. Types: `util/types.h`, `audio/types.h`.
