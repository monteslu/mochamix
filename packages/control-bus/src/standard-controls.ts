/**
 * Standard control definitions, registered at boot. Defines the Mixxx-compatible
 * control surface for N decks plus the master section and app controls. Ranges
 * follow Mixxx (02-functional-spec.md) so normalized parameters map correctly for
 * controllers and knobs.
 */

import {
  AppKeys,
  APP,
  deck,
  DeckKeys,
  MASTER,
  MasterKeys,
  MAX_HOTCUES,
  BEATLOOP_SIZES,
  hotcuePositionKey,
  hotcueActivateKey,
  hotcueSetKey,
  hotcueClearKey,
  hotcueEnabledKey,
  hotcueColorKey,
  beatloopToggleKey,
  beatloopActivateKey,
} from './keys.js';
import type { ControlDef, Group } from './types.js';

/** Build the per-deck control definitions for deck group `g`. */
function deckControls(g: string): ControlDef[] {
  return [
    // transport (buttons: 0/1)
    { group: g, key: DeckKeys.play, default: 0, description: 'Play/pause' },
    { group: g, key: DeckKeys.playIndicator, default: 0 },
    { group: g, key: DeckKeys.cueDefault, default: 0, description: 'Cue (mode-dependent)' },
    { group: g, key: DeckKeys.cueGoto, default: 0 },
    { group: g, key: DeckKeys.start, default: 0 },
    { group: g, key: DeckKeys.stop, default: 0 },

    // position / state (published by the engine)
    { group: g, key: DeckKeys.playPosition, default: 0, description: 'Play position 0..1' },
    { group: g, key: DeckKeys.trackLoaded, default: 0 },
    { group: g, key: DeckKeys.trackSamples, default: 0 },
    { group: g, key: DeckKeys.trackSampleRate, default: 0 },
    { group: g, key: DeckKeys.duration, default: 0, description: 'Duration (s)' },

    // tempo / rate
    { group: g, key: DeckKeys.rate, default: 0, min: -1, max: 1, description: 'Rate slider -1..1' },
    { group: g, key: DeckKeys.rateRange, default: 0.1, description: 'Rate range, e.g. 0.10 == ±10%' },
    { group: g, key: DeckKeys.rateDirection, default: 1 },
    { group: g, key: DeckKeys.rateRatio, default: 1, description: 'Effective rate ratio' },
    { group: g, key: DeckKeys.rateRatioOverride, default: 0, description: 'Sync/SmartFader ratio override; 0=off' },
    { group: g, key: DeckKeys.bpm, default: 0, description: 'Effective BPM' },
    { group: g, key: DeckKeys.fileBpm, default: 0, description: 'Analyzed/original BPM' },
    { group: g, key: DeckKeys.firstBeatFrame, default: -1, description: 'Grid phase (first beat frame)' },
    { group: g, key: DeckKeys.keylock, default: 0, persist: true, description: 'Keylock on/off' },

    // mixer
    { group: g, key: DeckKeys.volume, default: 1, description: 'Channel volume 0..1' },
    { group: g, key: DeckKeys.pregain, default: 1, min: 0, max: 4, description: 'Gain/trim' },
    { group: g, key: DeckKeys.mute, default: 0 },
    { group: g, key: DeckKeys.pfl, default: 0, description: 'Headphone cue' },
    { group: g, key: DeckKeys.orientation, default: 1, min: 0, max: 2, description: '0=L 1=C 2=R' },
    { group: g, key: DeckKeys.eqLow, default: 1, min: 0, max: 4, description: 'EQ low' },
    { group: g, key: DeckKeys.eqMid, default: 1, min: 0, max: 4, description: 'EQ mid' },
    { group: g, key: DeckKeys.eqHigh, default: 1, min: 0, max: 4, description: 'EQ high' },
    { group: g, key: DeckKeys.eqLowKill, default: 0 },
    { group: g, key: DeckKeys.eqMidKill, default: 0 },
    { group: g, key: DeckKeys.eqHighKill, default: 0 },

    // metering (published by the engine)
    { group: g, key: DeckKeys.vuMeter, default: 0 },
    { group: g, key: DeckKeys.vuMeterL, default: 0 },
    { group: g, key: DeckKeys.vuMeterR, default: 0 },
    { group: g, key: DeckKeys.peakIndicator, default: 0 },

    // QuickEffect (default Filter): super knob 0..1 (0.5 = neutral), enable toggle.
    { group: g, key: DeckKeys.quickEffectSuper, default: 0.5, persist: true },
    { group: g, key: DeckKeys.quickEffectEnabled, default: 0, persist: true },

    // main cue (persisted with the track later; in-memory for now)
    { group: g, key: DeckKeys.cuePoint, default: -1 },
    { group: g, key: DeckKeys.cueSet, default: 0 },
    { group: g, key: DeckKeys.cueGotoAndStop, default: 0 },

    // loops
    { group: g, key: DeckKeys.loopStartPosition, default: -1 },
    { group: g, key: DeckKeys.loopEndPosition, default: -1 },
    { group: g, key: DeckKeys.loopEnabled, default: 0 },
    { group: g, key: DeckKeys.loopIn, default: 0 },
    { group: g, key: DeckKeys.loopOut, default: 0 },
    { group: g, key: DeckKeys.reloopToggle, default: 0 },
    { group: g, key: DeckKeys.loopHalve, default: 0 },
    { group: g, key: DeckKeys.loopDouble, default: 0 },
    { group: g, key: DeckKeys.loopExit, default: 0 },

    ...hotcueControls(g),
    ...beatloopControls(g),
  ];
}

/** Hotcue controls for all MAX_HOTCUES slots. */
function hotcueControls(g: Group): ControlDef[] {
  const defs: ControlDef[] = [];
  for (let n = 1; n <= MAX_HOTCUES; n++) {
    defs.push(
      { group: g, key: hotcuePositionKey(n), default: -1 },
      { group: g, key: hotcueActivateKey(n), default: 0 },
      { group: g, key: hotcueSetKey(n), default: 0 },
      { group: g, key: hotcueClearKey(n), default: 0 },
      { group: g, key: hotcueEnabledKey(n), default: 0 },
      { group: g, key: hotcueColorKey(n), default: 0 },
    );
  }
  return defs;
}

/** Beatloop toggle/activate controls for each size. */
function beatloopControls(g: Group): ControlDef[] {
  const defs: ControlDef[] = [];
  for (const size of BEATLOOP_SIZES) {
    defs.push(
      { group: g, key: beatloopToggleKey(size), default: 0 },
      { group: g, key: beatloopActivateKey(size), default: 0 },
    );
  }
  return defs;
}

/** Master section controls. */
function masterControls(): ControlDef[] {
  const m = MASTER;
  return [
    { group: m, key: MasterKeys.crossfader, default: 0, min: -1, max: 1, persist: true },
    { group: m, key: MasterKeys.crossfaderCurve, default: 0.6, persist: true },
    { group: m, key: MasterKeys.crossfaderReverse, default: 0, persist: true },
    { group: m, key: MasterKeys.gain, default: 1, min: 0, max: 5 },
    { group: m, key: MasterKeys.boothGain, default: 1, min: 0, max: 5 },
    { group: m, key: MasterKeys.headGain, default: 1, min: 0, max: 5 },
    { group: m, key: MasterKeys.headMix, default: -1, min: -1, max: 1 },
    { group: m, key: MasterKeys.headSplit, default: 0, persist: true },
    { group: m, key: MasterKeys.balance, default: 0, min: -1, max: 1 },
    { group: m, key: MasterKeys.vuMeterL, default: 0 },
    { group: m, key: MasterKeys.vuMeterR, default: 0 },
    { group: m, key: MasterKeys.peakIndicatorL, default: 0 },
    { group: m, key: MasterKeys.peakIndicatorR, default: 0 },

    // smart fader (09-smart-fader.md)
    { group: m, key: MasterKeys.smartFaderEnabled, default: 0, persist: true },
    { group: m, key: MasterKeys.smartFaderActive, default: 0 },
    { group: m, key: MasterKeys.smartFaderLeftBpm, default: 0 },
    { group: m, key: MasterKeys.smartFaderRightBpm, default: 0 },
    { group: m, key: MasterKeys.smartFaderTargetBpm, default: 0 },
  ];
}

/** App-wide controls. */
function appControls(numDecks: number): ControlDef[] {
  return [
    { group: APP, key: AppKeys.numDecks, default: numDecks },
    { group: APP, key: AppKeys.numSamplers, default: 0 },
    { group: APP, key: AppKeys.numPreviewDecks, default: 0 },
    { group: APP, key: AppKeys.numMicrophones, default: 0 },
    { group: APP, key: AppKeys.numAuxiliaries, default: 0 },
  ];
}

/**
 * The full standard control surface for `numDecks` decks. Pass to
 * `bus.defineAll(...)` at boot.
 */
export function standardControls(numDecks: number): ControlDef[] {
  const defs: ControlDef[] = [...appControls(numDecks), ...masterControls()];
  for (let i = 1; i <= numDecks; i++) {
    defs.push(...deckControls(deck(i)));
  }
  return defs;
}
