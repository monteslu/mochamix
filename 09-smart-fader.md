# 09 — Smart Fader (our fork feature; carry into internal-dj)

A feature we built in our Mixxx fork (`../mixxx-monteslu`, branch `smart-fader`,
`git@github.com:monteslu/mixxx.git`) that **upstream Mixxx has not accepted**. We want it in
internal-dj. This document captures what it does, why, exactly how our implementation works, and how
to port it to the Electron engine.

## 1. What "Smart Fader" is (the concept)

Smart Fader comes from the **Pioneer / AlphaTheta** controllers (DDJ-FLX2/FLX4) and **VirtualDJ**. The
idea: as you move the crossfader from one deck to the other, the software **automatically blends the
two tracks' tempo (and on the hardware, also volume + bass)** so a beginner can mix tracks of very
different BPM with a single fader motion, no manual beatmatching.

- **AlphaTheta/Pioneer Smart Fader:** "automatically optimizes control of the volume, BPM, and bass,
  so you can perform perfect mixes by simply sliding the crossfader" — mix across genres/tempos with
  one motion. ([AlphaTheta DDJ-FLX2](https://alphatheta.com/en/product/dj-controller/ddj-flx2/black/),
  [Digital DJ Tips review](https://www.digitaldjtips.com/reviews/alphatheta-ddj-flx2/))
- **VirtualDJ Smart Fader mode:** "the BPM of the non-playing deck is matched to the playing one, and
  when crossfading between the two decks, both decks have the same BPM, with both ending at the BPM of
  the other deck at the end of the transition." ([VirtualDJ DDJ-FLX4 controls](https://virtualdj.com/manuals/hardware/pioneer/ddjflx4/controls.html),
  [VirtualDJ Automix Smart-fader thread](https://virtualdj.com/forums/256851/General_Discussion/Automix_Smart-fader.html))

So the cross-vendor essence is: **crossfader position drives a tempo interpolation between the two
decks, both decks stay beat-locked to that interpolated tempo throughout the transition.** (The
hardware versions also auto-ride volume and bass-kill; our Mixxx implementation does the **tempo
blend** portion — see §6 for the volume/bass extensions we could add.)

## 2. What our fork's Smart Fader does (precise behavior)

When enabled (and both `[Channel1]` and `[Channel2]` have a valid `file_bpm`):

- The **InternalClock becomes the explicit sync leader**; both decks become **followers**.
- The leader BPM is **linearly interpolated by crossfader position**:
  ```
  t          = (crossfader + 1) / 2          // crossfader is -1..1  →  t is 0..1
  targetBpm  = leftFileBpm * (1 - t) + rightFileBpm * t
  ```
  Crossfader hard-left → both decks play at the left track's BPM; hard-right → both at the right
  track's BPM; centered → both at the average. The leader BPM is updated **every audio callback**.
- Sync's automatic **half/double BPM matching is suppressed** (each follower's
  `leaderBpmAdjustFactor` is pinned to `1.0`), so the deck rate is always exactly
  `leaderBpm / fileBpm`. This avoids a "surprise" octave jump (e.g. a 140 deck snapping to 70) mid
  transition. This was the subtle bug fixed in commit `dc6aea69` ("Fix smart fader half/double
  interaction with sync engine").
- Both decks get a **phase sync** request on activation so their beats stay aligned.
- On **disable**, the saved sync modes of both decks + the InternalClock are **restored**.

It is a two-deck feature (hardcoded `[Channel1]` / `[Channel2]`), matching the DDJ-FLX4's 2-channel
layout.

## 3. Our implementation (file-by-file)

Branch `smart-fader`, ~739 lines across 19 files. The core is a **new `EngineControl`-style object in
the sync engine**, plus small hooks.

| File | Change |
|------|--------|
| **`src/engine/sync/smartfadercontrol.{cpp,h}`** | **The feature.** `SmartFaderControl` class. New file (~270 lines). |
| `src/engine/enginemixer.{cpp,h}` | Owns a `unique_ptr<SmartFaderControl>`; calls `m_pSmartFaderControl->process()` once per callback inside `processChannels()`, right after `m_pEngineSync->onCallbackStart()`. |
| `src/engine/sync/enginesync.{cpp,h}` | Promoted `getSyncableForGroup()` from test-only to public; added `getInternalClock()`. |
| `src/engine/sync/syncable.h` | New pure-virtual `setLeaderBpmAdjustFactor(double)`. |
| `src/engine/sync/synccontrol.{cpp,h}` | Implements `setLeaderBpmAdjustFactor()` (sets the factor + `updateTargetBeatDistance()`). |
| `src/engine/sync/internalclock.h` | Implements `setLeaderBpmAdjustFactor()` as a no-op (the clock has no file BPM). |
| `src/preferences/dialog/dlgprefmixer*.{cpp,h,ui}` | "Enable Smart Fader (tempo blending)" checkbox in Mixer prefs. |
| `res/controllers/Pioneer-DDJ-FLX4.midi.xml` + `-script.js` | Maps the hardware **SMART FADER** button (status `0x96`, midino `0x01`) to toggle `[Master],smart_fader_enabled`, with an LED that tracks state. |
| `res/qml/CrossfaderRow.qml` | Minor QML skin presentation. |
| `res/controllers/mixxx-controls.d.ts` | TypeScript control declarations for the new controls. |
| `src/test/smartfadercontroltest.cpp` | 278 lines of unit tests. |

### The control objects it exposes
On activation the control reads `[ChannelN],file_bpm` and `[Master],crossfader`. It creates (note:
constructed with `group = [Master]`):

| ControlObject | Type | Meaning |
|---------------|------|---------|
| `[Master],smart_fader_enabled` | push button, **toggle**, **persisted** | User/controller on-off |
| `[Master],smart_fader_active` | read-only | 1 when actually engaged (both decks have BPM) |
| `[Master],smart_fader_left_bpm` | read-only | Left deck file BPM (for UI) |
| `[Master],smart_fader_right_bpm` | read-only | Right deck file BPM (for UI) |
| `[Master],smart_fader_target_bpm` | read-only | The current interpolated leader BPM (for UI) |

> Naming nuance to fix on port: the class is constructed with the mixer `group` (`[Master]`) so all
> its controls live under `[Master]`, but internally it hardcodes `[Channel1]`/`[Channel2]` as the
> decks. Keep the controls under `[Master]` (the controller mapping depends on that), but when we
> generalize to N decks make the deck pair configurable.

### Control flow (`SmartFaderControl::process()`, every callback)
```
if (!enabled):
    if (wasActive) deactivate()          // restore saved sync modes
    return
if (!wasActive):
    activate()                           // save sync modes; InternalClock=LeaderExplicit;
                                         //   both decks=Follower; pin adjustFactor=1.0; phase-sync
    if still not active: return          // (no tracks loaded yet — retry next callback)
read leftFileBpm, rightFileBpm           // bail/deactivate if either <= 0
re-publish per-deck BPM controls if changed > 0.5 (track change)
re-assert InternalClock=leader, both decks=followers, adjustFactor=1.0   // defend against track loads
t = (crossfader + 1) / 2
targetBpm = lerp(leftFileBpm, rightFileBpm, t)
setLeaderBpmDirect(targetBpm)            // InternalClock.updateLeaderBpm + EngineSync.notifyRateChanged
publish smart_fader_target_bpm
```

`setLeaderBpmDirect()` updates the InternalClock's beat length and **synchronously propagates** the
new BPM to all followers via `EngineSync::notifyRateChanged(internalClock, newBpm)` — so the rate
change lands the same callback, no lag.

## 4. Why upstream didn't take it (and why that's fine for us)

It reaches into the sync engine and adds a parallel "rate authority" that overrides sync's half/double
logic. Upstream Mixxx is conservative about the sync engine (it's load-bearing and heavily tested),
and a crossfader-drives-tempo behavior is opinionated. For **internal-dj** we own the engine, so we
can make Smart Fader a first-class, well-integrated feature instead of a bolt-on.

## 5. Porting Smart Fader to the internal-dj (Electron/Web Audio) engine

It maps cleanly onto the `EngineControl` + sync-engine model in `04`:

- **It is just another per-callback control** over the shared control bus (`03` §1). In our JS engine
  it's a small module ticked once per audio quantum (alongside the sync engine), reading
  `[Master],crossfader` + `[ChannelN],file_bpm` and writing the leader BPM.
- **Reuse the sync engine port (`04` §6).** Smart Fader = "force InternalClock to leader, both decks
  to follower, pin the half/double multiplier to 1, and set leader BPM = `lerp(leftBpm, rightBpm, t)`
  each tick." All of that is already JS-side bookkeeping in our sync port — Smart Fader just drives
  the leader BPM from the crossfader instead of from a deck.
- **Controls** become bus keys: `[Master],smart_fader_enabled` (persisted toggle),
  `[Master],smart_fader_active|left_bpm|right_bpm|target_bpm` (read-only, for the UI).
- **Keylock matters.** Interpolating BPM with keylock OFF will pitch-shift both decks across the
  transition (the prefs tooltip warns this). With our RubberBand-WASM keylock (`04` §4), enable
  keylock on both decks during Smart Fader so only tempo moves, not pitch. Consider auto-engaging
  keylock when Smart Fader activates.
- **Controller mapping** ports for free via the `engine`/`midi` contract (`06` §2): the DDJ-FLX4
  SMART FADER button → toggle `[Master],smart_fader_enabled`, LED follows state. Our `.midi.xml`
  carries over.
- **UI:** expose the toggle + a target-BPM readout; optionally render the interpolated BPM live on the
  crossfader (the `CrossfaderRow.qml` change is the seed for this).

### Minimal JS shape
```js
// ticked once per audio quantum, after the sync engine update
class SmartFader {
  constructor(store, sync) { this.store = store; this.sync = sync; this.active = false; }
  process() {
    const on = this.store.get("[Master],smart_fader_enabled");
    if (!on) { if (this.active) this.deactivate(); return; }
    const lBpm = this.store.get("[Channel1],file_bpm");
    const rBpm = this.store.get("[Channel2],file_bpm");
    if (lBpm <= 0 || rBpm <= 0) { if (this.active) this.deactivate(); return; }
    if (!this.active) this.activate();           // clock=leader, decks=followers, adjustFactor=1, phase-sync
    const t = (this.store.get("[Master],crossfader") + 1) / 2;
    const targetBpm = lBpm * (1 - t) + rBpm * t;
    this.sync.setLeaderBpm(targetBpm);           // updates internal clock + propagates to followers
    this.store.set("[Master],smart_fader_target_bpm", targetBpm);
  }
}
```

## 6. Possible extensions (toward full Pioneer/VirtualDJ parity)

Our version does the **tempo blend**. The hardware Smart Fader also rides **volume** and **bass**.
Easy adds in internal-dj since we own the mixer graph:
- **Volume curve:** shape the per-deck gain vs crossfader as an equal-power blend (the crossfader
  already does this; could add a Smart-Fader-specific curve).
- **Bass swap / bass-kill:** as the crossfader crosses center, fade the outgoing deck's low EQ down
  and the incoming deck's up (classic "bassline swap"), via the per-deck EQ controls. This is what
  AlphaTheta's "Smart CFX"/bass handling does and is a natural follow-on.
- **Auto-keylock on activate** (see §5).
- **Generalize beyond 2 decks** (make the deck pair configurable rather than hardcoded
  `[Channel1]`/`[Channel2]`).

## Sources
- AlphaTheta DDJ-FLX2 (Smart Fader / Smart CFX): <https://alphatheta.com/en/product/dj-controller/ddj-flx2/black/>
- Digital DJ Tips, DDJ-FLX2 review: <https://www.digitaldjtips.com/reviews/alphatheta-ddj-flx2/>
- VirtualDJ DDJ-FLX4 controls (Smart Fader mode): <https://virtualdj.com/manuals/hardware/pioneer/ddjflx4/controls.html>
- VirtualDJ Automix Smart-fader discussion: <https://virtualdj.com/forums/256851/General_Discussion/Automix_Smart-fader.html>
- Our fork: `git@github.com:monteslu/mixxx.git`, branch `smart-fader` (local `../mixxx-monteslu`).
