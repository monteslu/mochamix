/**
 * Standard control definitions, registered at boot. Defines the Mixxx-compatible
 * control surface for N decks plus the master section and app controls. Ranges
 * follow Mixxx (02-functional-spec.md) so normalized parameters map correctly for
 * controllers and knobs.
 */

import {
  AppKeys,
  APP,
  LIBRARY,
  PLAYLIST,
  LibraryKeys,
  effectUnit,
  effectSlot,
  effectGroupEnableKey,
  EffectUnitKeys,
  EffectKeys,
  NUM_EFFECT_UNITS,
  EFFECT_SLOTS_PER_UNIT,
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
    { group: g, key: DeckKeys.startPlay, default: 0 },
    { group: g, key: DeckKeys.stop, default: 0 },
    { group: g, key: DeckKeys.cueGotoAndPlay, default: 0 },
    { group: g, key: DeckKeys.cuePreview, default: 0 },
    { group: g, key: DeckKeys.startStop, default: 0 },
    { group: g, key: DeckKeys.playStutter, default: 0 },
    { group: g, key: DeckKeys.reverse, default: 0 },
    { group: g, key: DeckKeys.reverseRoll, default: 0 },
    // per-deck library load (mappings drive these on [ChannelN] = "load into deck N")
    { group: g, key: LibraryKeys.loadSelectedTrack, default: 0 },
    { group: g, key: LibraryKeys.loadSelectedTrackAndPlay, default: 0 },
    { group: g, key: LibraryKeys.loadSelectedIntoFirstStopped, default: 0 },

    // position / state (published by the engine)
    { group: g, key: DeckKeys.playPosition, default: 0, description: 'Play position 0..1' },
    { group: g, key: DeckKeys.trackLoaded, default: 0 },
    { group: g, key: DeckKeys.trackSamples, default: 0 },
    { group: g, key: DeckKeys.trackSampleRate, default: 0 },
    { group: g, key: DeckKeys.duration, default: 0, description: 'Duration (s)' },

    // tempo / rate
    { group: g, key: DeckKeys.rate, default: 0, min: -1, max: 1, description: 'Rate slider -1..1' },
    { group: g, key: DeckKeys.rateRange, default: 0.1, description: 'Rate range, e.g. 0.10 == ±10%' },
    // -1 = Mixxx default ("down increases speed"): rate -1 = faster, +1 = slower.
    // Controller mappings (Pot invert:true) are tuned for this; keep it to match them.
    { group: g, key: DeckKeys.rateDirection, default: -1 },
    { group: g, key: DeckKeys.rateRatio, default: 1, description: 'Effective rate ratio' },
    { group: g, key: DeckKeys.rateRatioOverride, default: 0, description: 'Sync/SmartFader ratio override; 0=off' },
    { group: g, key: DeckKeys.bpm, default: 0, description: 'Effective BPM' },
    // tempo nudge (pitch-bend) — held buttons add a temp delta to the speed
    { group: g, key: DeckKeys.rateTemp, default: 0, description: 'Temp pitch-bend added to speed' },
    { group: g, key: DeckKeys.rateTempUp, default: 0 },
    { group: g, key: DeckKeys.rateTempDown, default: 0 },
    { group: g, key: DeckKeys.rateTempUpSmall, default: 0 },
    { group: g, key: DeckKeys.rateTempDownSmall, default: 0 },
    { group: g, key: DeckKeys.fileBpm, default: 0, description: 'Analyzed/original BPM' },
    { group: g, key: DeckKeys.firstBeatFrame, default: -1, description: 'Grid phase (first beat frame)' },
    { group: g, key: DeckKeys.bpmLock, default: 0, description: 'BPM/grid locked' },
    { group: g, key: DeckKeys.beatsSetDouble, default: 0, description: 'Pulse: BPM x2' },
    { group: g, key: DeckKeys.beatsSetHalve, default: 0, description: 'Pulse: BPM /2' },
    { group: g, key: DeckKeys.scratching, default: 0, description: 'Scratch active' },
    { group: g, key: DeckKeys.scratchRate, default: 0, min: -20, max: 20, description: 'Scratch rate (neg=reverse)' },
    { group: g, key: DeckKeys.keylock, default: 0, persist: true, description: 'Keylock on/off' },
    { group: g, key: DeckKeys.slipEnabled, default: 0, description: 'Slip mode on/off' },
    { group: g, key: DeckKeys.beatsync, default: 0, description: 'Pulse: one-shot match tempo + phase' },
    { group: g, key: DeckKeys.syncEnabled, default: 0, description: 'Beat sync follower on/off' },
    { group: g, key: DeckKeys.syncLeader, default: 0, description: 'Explicit sync leader' },
    { group: g, key: DeckKeys.syncRequest, default: 0, description: 'Pulse: request a worklet phase-snap now' },
    { group: g, key: DeckKeys.beatDistance, default: 0, description: 'Live beat distance 0..1' },
    { group: g, key: DeckKeys.quantize, default: 1, persist: true, description: 'Quantize to beat grid' },
    {
      group: g,
      key: DeckKeys.platterReleaseMode,
      default: 1,
      persist: true,
      description: 'Platter release: 0=stay, 1=quantize own beat, 2=resync leader',
    },

    // mixer
    { group: g, key: DeckKeys.volume, default: 1, description: 'Channel volume 0..1' },
    { group: g, key: DeckKeys.pregain, default: 1, min: 0, max: 4, description: 'Gain/trim' },
    { group: g, key: DeckKeys.mute, default: 0 },
    { group: g, key: DeckKeys.hasStems, default: 0, description: 'Deck is playing 4 stems' },
    { group: g, key: DeckKeys.stemGain0, default: 1, min: 0, max: 1, description: 'Stem 0 (drums) gain' },
    { group: g, key: DeckKeys.stemGain1, default: 1, min: 0, max: 1, description: 'Stem 1 (bass) gain' },
    { group: g, key: DeckKeys.stemGain2, default: 1, min: 0, max: 1, description: 'Stem 2 (other) gain' },
    { group: g, key: DeckKeys.stemGain3, default: 1, min: 0, max: 1, description: 'Stem 3 (vocals) gain' },
    // Key shift: ±12 semitones, default 0 (original key). persist? no — per-load.
    { group: g, key: DeckKeys.pitch, default: 0, min: -12, max: 12, description: 'Key shift (semitones)' },
    { group: g, key: DeckKeys.stemPitch0, default: 0, min: -12, max: 12, description: 'Stem 0 (drums) key shift' },
    { group: g, key: DeckKeys.stemPitch1, default: 0, min: -12, max: 12, description: 'Stem 1 (bass) key shift' },
    { group: g, key: DeckKeys.stemPitch2, default: 0, min: -12, max: 12, description: 'Stem 2 (other) key shift' },
    { group: g, key: DeckKeys.stemPitch3, default: 0, min: -12, max: 12, description: 'Stem 3 (vocals) key shift' },
    {
      group: g,
      key: DeckKeys.formantPreserve,
      default: 1,
      persist: true,
      description: 'Preserve formants on pitch shift (natural voices)',
    },
    { group: g, key: DeckKeys.fileKeyNum, default: 0, min: 0, max: 24, description: 'Detected key index 1..24' },
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
    { group: g, key: DeckKeys.reloopExit, default: 0 },
    { group: g, key: DeckKeys.reloopAndStop, default: 0 },
    { group: g, key: DeckKeys.loopHalve, default: 0 },
    { group: g, key: DeckKeys.loopDouble, default: 0 },
    { group: g, key: DeckKeys.loopExit, default: 0 },
    // size-driven beatloop + beatlooproll
    { group: g, key: DeckKeys.beatloop, default: 0 },
    { group: g, key: DeckKeys.beatloopSize, default: 4, description: 'Beats for beatloop_activate' },
    { group: g, key: DeckKeys.beatloopActivate, default: 0 },
    { group: g, key: DeckKeys.beatlooprollActivate, default: 0 },
    // beatjump (jump N beats, no loop)
    { group: g, key: DeckKeys.beatjump, default: 0 },
    { group: g, key: DeckKeys.beatjumpSize, default: 4, description: 'Beats for beatjump fwd/back' },
    { group: g, key: DeckKeys.beatjumpForward, default: 0 },
    { group: g, key: DeckKeys.beatjumpBackward, default: 0 },
    // loop move + scale
    { group: g, key: DeckKeys.loopMove, default: 0 },
    { group: g, key: DeckKeys.loopMoveForward, default: 0 },
    { group: g, key: DeckKeys.loopMoveBackward, default: 0 },
    { group: g, key: DeckKeys.loopScale, default: 0 },
    // permanent pitch step + beatgrid BPM nudge
    { group: g, key: DeckKeys.ratePermUp, default: 0 },
    { group: g, key: DeckKeys.ratePermDown, default: 0 },
    { group: g, key: DeckKeys.ratePermUpSmall, default: 0 },
    { group: g, key: DeckKeys.ratePermDownSmall, default: 0 },
    { group: g, key: DeckKeys.beatsAdjustFaster, default: 0 },
    { group: g, key: DeckKeys.beatsAdjustSlower, default: 0 },

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
    { group: m, key: MasterKeys.sampleRate, default: 48000, min: 8000, max: 192000 },
    { group: m, key: MasterKeys.waveformZoom, default: 2, min: 0, max: 4, persist: true, description: 'Waveform zoom preset index' },
    { group: m, key: MasterKeys.crossfader, default: 0, min: -1, max: 1, persist: true },
    { group: m, key: MasterKeys.crossfaderCurve, default: 0.6, persist: true },
    { group: m, key: MasterKeys.crossfaderReverse, default: 0, persist: true },
    { group: m, key: MasterKeys.gain, default: 1, min: 0, max: 5 },
    { group: m, key: MasterKeys.boothGain, default: 1, min: 0, max: 5 },
    { group: m, key: MasterKeys.headGain, default: 1, min: 0, max: 5 },
    { group: m, key: MasterKeys.headVolume, default: 1, min: 0, max: 5 },
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

/** Effect rack: N units, each with super1/mix/enabled + per-deck routing, and M effect
 * slots each with enabled/meta/parameter1-3. The controls 60+ mappings drive. */
function effectRackControls(numDecks: number): ControlDef[] {
  const defs: ControlDef[] = [];
  for (let u = 1; u <= NUM_EFFECT_UNITS; u++) {
    const ug = effectUnit(u);
    defs.push(
      { group: ug, key: EffectUnitKeys.super1, default: 0, description: 'Unit metaknob' },
      { group: ug, key: EffectUnitKeys.mix, default: 0, description: 'Unit wet/dry' },
      { group: ug, key: EffectUnitKeys.enabled, default: 0 },
      { group: ug, key: EffectUnitKeys.nextChain, default: 0 },
    );
    // per-deck routing: route deck d through unit u
    for (let d = 1; d <= numDecks; d++) {
      defs.push({ group: ug, key: effectGroupEnableKey(deck(d)), default: 0 });
    }
    for (let s = 1; s <= EFFECT_SLOTS_PER_UNIT; s++) {
      const sg = effectSlot(u, s);
      defs.push(
        { group: sg, key: EffectKeys.enabled, default: s === 1 ? 1 : 0 },
        { group: sg, key: EffectKeys.meta, default: 0 },
        { group: sg, key: EffectKeys.param1, default: 0.5 },
        { group: sg, key: EffectKeys.param2, default: 0.5 },
        { group: sg, key: EffectKeys.param3, default: 0.5 },
        { group: sg, key: EffectKeys.buttonParam1, default: 0 },
        { group: sg, key: EffectKeys.buttonParam2, default: 0 },
        { group: sg, key: EffectKeys.buttonParam3, default: 0 },
        { group: sg, key: EffectKeys.nextEffect, default: 0 },
        { group: sg, key: EffectKeys.effectSelector, default: 0 },
      );
    }
  }
  return defs;
}

/** Library/browse controls — same set under [Library] and [Playlist] (old mappings use
 * [Playlist] for the track-list nav). selectedIndex persists the highlight. */
function libraryControls(): ControlDef[] {
  const defs: ControlDef[] = [];
  for (const g of [LIBRARY, PLAYLIST]) {
    defs.push(
      { group: g, key: LibraryKeys.selectedIndex, default: 0, description: 'Highlighted row' },
      { group: g, key: LibraryKeys.moveVertical, default: 0 },
      { group: g, key: LibraryKeys.moveUp, default: 0 },
      { group: g, key: LibraryKeys.moveDown, default: 0 },
      { group: g, key: LibraryKeys.selectTrackKnob, default: 0 },
      { group: g, key: LibraryKeys.selectNextTrack, default: 0 },
      { group: g, key: LibraryKeys.selectPrevTrack, default: 0 },
      { group: g, key: LibraryKeys.selectNextPlaylist, default: 0 },
      { group: g, key: LibraryKeys.selectPrevPlaylist, default: 0 },
      { group: g, key: LibraryKeys.loadSelectedTrack, default: 0 },
      { group: g, key: LibraryKeys.loadSelectedTrackAndPlay, default: 0 },
      { group: g, key: LibraryKeys.loadSelectedIntoFirstStopped, default: 0 },
      { group: g, key: LibraryKeys.goToItem, default: 0 },
    );
  }
  return defs;
}

/**
 * The full standard control surface for `numDecks` decks. Pass to
 * `bus.defineAll(...)` at boot.
 */
export function standardControls(numDecks: number): ControlDef[] {
  const defs: ControlDef[] = [
    ...appControls(numDecks),
    ...masterControls(),
    ...libraryControls(),
    ...effectRackControls(numDecks),
  ];
  for (let i = 1; i <= numDecks; i++) {
    defs.push(...deckControls(deck(i)));
  }
  return defs;
}
