/**
 * Group naming + control key constants, ported from Mixxx so we inherit its
 * controller-mapping ecosystem verbatim (see 03-architecture.md 1 and
 * 06-ui-controllers-effects.md 2). KEEP THESE NAMES EXACT  a stock Mixxx
 * mapping addresses `[Channel1],play`, `[Master],crossfader`, etc.
 *
 * This is not the full Mixxx control surface (that's hundreds of keys); it's the
 * subset we wire as we build, grown milestone by milestone.
 */

import type { Group, Key } from './types.js';

// ---------------------------------------------------------------------------
// Group constructors (Mixxx conventions)
// ---------------------------------------------------------------------------

/** Deck group: `[Channel1]`..`[ChannelN]`. 1-based, matching Mixxx. */
export function deck(n: number): Group {
  return `[Channel${n}]`;
}

/** Sampler group: `[Sampler1]`.. */
export function sampler(n: number): Group {
  return `[Sampler${n}]`;
}

/** Preview deck group: `[PreviewDeck1]`.. */
export function previewDeck(n: number): Group {
  return `[PreviewDeck${n}]`;
}

/**
 * Microphone group. Mixxx quirk: the first mic is `[Microphone]` (no number),
 * subsequent ones are `[Microphone2]`, `[Microphone3]`, ...
 */
export function microphone(n: number): Group {
  return n <= 1 ? '[Microphone]' : `[Microphone${n}]`;
}

/** Auxiliary line-in group: `[Auxiliary1]`.. */
export function auxiliary(n: number): Group {
  return `[Auxiliary${n}]`;
}

/** Effect unit group: `[EffectRack1_EffectUnit1]`.. */
export function effectUnit(n: number): Group {
  return `[EffectRack1_EffectUnit${n}]`;
}

/** Effect slot group within a unit: `[EffectRack1_EffectUnit1_Effect1]`.. */
export function effectSlot(unit: number, slot: number): Group {
  return `[EffectRack1_EffectUnit${unit}_Effect${slot}]`;
}

/** Number of effect units + slots per unit (Mixxx defaults). */
export const NUM_EFFECT_UNITS = 4;
export const EFFECT_SLOTS_PER_UNIT = 3;

/** Controls on an effect-UNIT group ([EffectRack1_EffectUnitN]). */
export const EffectUnitKeys = {
  super1: 'super1', // the unit metaknob (0..1) — the main FX knob controllers turn
  mix: 'mix', // wet/dry (0..1)
  enabled: 'group_enabled', // unit on/off (synthetic; mappings often use mix)
  nextChain: 'next_chain',
  // per-channel routing: assign deck N through this unit. Built as group_[ChannelN]_enable.
} as const;

/** The "route deck `deckGroup` through this unit" control on a unit group. */
export function effectGroupEnableKey(deckGroup: Group): Key {
  return `group_${deckGroup}_enable`;
}

/** Controls on an effect-SLOT group ([EffectRack1_EffectUnitN_EffectM]). */
export const EffectKeys = {
  enabled: 'enabled', // this effect on/off
  meta: 'meta', // this effect's metaknob
  param1: 'parameter1',
  param2: 'parameter2',
  param3: 'parameter3',
  buttonParam1: 'button_parameter1',
  buttonParam2: 'button_parameter2',
  buttonParam3: 'button_parameter3',
  nextEffect: 'next_effect',
  effectSelector: 'effect_selector',
} as const;

/** Per-deck QuickEffect group: `[QuickEffectRack1_[Channel1]]`. */
export function quickEffect(deckGroup: Group): Group {
  return `[QuickEffectRack1_${deckGroup}]`;
}

/** Per-deck EQ group: `[EqualizerRack1_[Channel1]_Effect1]`. */
export function eqEffect(deckGroup: Group): Group {
  return `[EqualizerRack1_${deckGroup}_Effect1]`;
}

// ---------------------------------------------------------------------------
// Well-known singleton groups
// ---------------------------------------------------------------------------

/** Master / main output section + crossfader. Mixxx accepts `[Master]` (legacy) and `[Main]`. */
export const MASTER: Group = '[Master]';
/** App-wide controls (num_decks, num_samplers, ...). */
export const APP: Group = '[App]';
/** Mixxx library/browse group. Controllers navigate + load tracks via these. */
export const LIBRARY: Group = '[Library]';
/** Mixxx playlist/sidebar group (older mappings use [Playlist].SelectTrackKnob etc). */
export const PLAYLIST: Group = '[Playlist]';

/**
 * Library/browse controls (Mixxx-compatible). The Select/Load/Move pulse controls are
 * momentary: set to 1 (or a signed delta for the knob) to act, then self-reset.
 * selectedIndex is the persisted highlight position the UI mirrors.
 */
export const LibraryKeys = {
  selectedIndex: 'selected_index', // current highlighted row (our addition; UI mirrors it)
  moveVertical: 'MoveVertical', // N rows (knob)
  moveUp: 'MoveUp',
  moveDown: 'MoveDown',
  selectTrackKnob: 'SelectTrackKnob', // N rows in the track list
  selectNextTrack: 'SelectNextTrack',
  selectPrevTrack: 'SelectPrevTrack',
  selectNextPlaylist: 'SelectNextPlaylist',
  selectPrevPlaylist: 'SelectPrevPlaylist',
  loadSelectedTrack: 'LoadSelectedTrack', //  first stopped deck (Mixxx: focused deck)
  loadSelectedTrackAndPlay: 'LoadSelectedTrackAndPlay',
  loadSelectedIntoFirstStopped: 'LoadSelectedIntoFirstStopped',
  goToItem: 'GoToItem',
} as const;

// ---------------------------------------------------------------------------
// Per-deck control keys (Mixxx names). Grown as milestones add features.
// ---------------------------------------------------------------------------

export const DeckKeys = {
  // transport
  play: 'play',
  playIndicator: 'play_indicator',
  cueDefault: 'cue_default',
  cueGoto: 'cue_goto',
  cueGotoAndPlay: 'cue_gotoandplay', // seek to cue + play
  cuePreview: 'cue_preview', // play-from-cue while held (preview)
  start: 'start',
  startPlay: 'start_play', // go to track start + play
  startStop: 'start_stop', // go to track start + stop
  playStutter: 'play_stutter', // restart from cue and play (stutter)
  reverseRoll: 'reverseroll', // reverse (censor) while held; resume on release
  stop: 'stop',

  // position / state (read-mostly, published from the engine)
  playPosition: 'playposition', // 0..1 fraction of track
  trackLoaded: 'track_loaded',
  trackSamples: 'track_samples',
  trackSampleRate: 'track_samplerate',
  duration: 'duration', // seconds

  // tempo / rate
  rate: 'rate', // -1..1, scaled by rateRange/direction  speed
  rateRange: 'rateRange', // e.g. 0.10 == 10%
  rateDirection: 'rate_dir', // +1 or -1
  rateRatio: 'rate_ratio', // effective rate ratio (1.0 == original)
  // Temporary pitch-bend (nudge) added to the effective speed while a button is held.
  // Mixxx rate_temp_up/down (coarse) + _small (fine); RateControl drives rateTemp.
  rateTemp: 'rate_temp', // signed delta added to speed (engine-internal aggregate)
  rateTempUp: 'rate_temp_up',
  rateTempDown: 'rate_temp_down',
  rateTempUpSmall: 'rate_temp_up_small',
  rateTempDownSmall: 'rate_temp_down_small',
  // Direct rate-ratio override used by sync / smart fader (which need ratios
  // beyond the slider's range). 0 = inactive (use the slider); >0 = force ratio.
  rateRatioOverride: 'rate_ratio_override',
  // Scratch: when scratching=1 the deck plays at scratchRate (which CAN be
  // negative for reverse) regardless of play state  vinyl under the hand.
  scratching: 'scratch2_enable',
  scratchRate: 'scratch2',
  bpm: 'bpm', // effective BPM at current rate
  fileBpm: 'file_bpm', // analyzed/original BPM (used by sync + smart fader)
  firstBeatFrame: 'beat_first_frame', // grid phase: frame of the first beat (-1 = unknown)
  keylock: 'keylock',

  // slip mode (Mixxx slip_enabled): playback continues underneath loops/scratch; on
  // disable, snap to where the song would be.
  slipEnabled: 'slip_enabled',

  // beat sync (Mixxx-compatible names)
  beatsync: 'beatsync', // pulse: one-shot match tempo + phase to the other deck (no latch)
  syncEnabled: 'sync_enabled', // 1 = this deck follows the sync leader
  syncLeader: 'sync_leader', // 1 = this deck is the explicit sync leader
  syncRequest: 'sync_request', // pulse: set 1 to ask the worklet to phase-snap NOW; worklet clears it

  beatDistance: 'beat_distance', // 0..1, live distance to the previous beat (published by engine)
  quantize: 'quantize', // 1 = snap cue/loop/play drops to the nearest beat
  // Platter-release behavior: 0 = stay where the hand left it, 1 = quantize to this
  // deck's own nearest beat (default, preserves manual measure alignment), 2 = re-sync
  // phase to the leader deck.
  platterReleaseMode: 'platter_release_mode',

  // mixer (per channel)
  volume: 'volume', // 0..1
  pregain: 'pregain', // gain/trim, 0..1..4
  mute: 'mute',
  // stem decks (NI-Stems .stem.mp4): 1 = this deck is playing 4 separable stems.
  hasStems: 'has_stems',
  // per-stem gain (0=muted..1=full), order: 0 drums, 1 bass, 2 other, 3 vocals.
  stemGain0: 'stem_gain_0',
  stemGain1: 'stem_gain_1',
  stemGain2: 'stem_gain_2',
  stemGain3: 'stem_gain_3',
  // Key shift in SEMITONES (Mixxx 'pitch'): transpose the deck's pitch independent of
  // tempo (via the keylock time-stretcher). 0 = original key.
  pitch: 'pitch',
  // Per-stem key shift in semitones (so you can transpose only the vocal, not drums).
  stemPitch0: 'stem_pitch_0',
  stemPitch1: 'stem_pitch_1',
  stemPitch2: 'stem_pitch_2',
  stemPitch3: 'stem_pitch_3',
  // Formant preservation for pitch shift (1 = keep voices/instruments natural, not
  // chipmunked). Applies to the deck + stem shifts.
  formantPreserve: 'formant_preserve',
  // Detected musical key as a numeric index 1..24 (Mixxx ChromaticKey: 1-12 major
  // C..B, 13-24 minor C..B), 0 = unknown. For Camelot harmonic-match math.
  fileKeyNum: 'file_key_num',
  pfl: 'pfl', // headphone cue
  orientation: 'orientation', // 0=left,1=center,2=right
  eqLow: 'filterLow', // legacy EQ aliases Mixxx exposes for the per-deck EQ
  eqMid: 'filterMid',
  eqHigh: 'filterHigh',
  eqLowKill: 'filterLowKill',
  eqMidKill: 'filterMidKill',
  eqHighKill: 'filterHighKill',

  // metering
  vuMeter: 'vu_meter',
  vuMeterL: 'vu_meter_left',
  vuMeterR: 'vu_meter_right',
  peakIndicator: 'peak_indicator',

  // QuickEffect (per-deck single-knob effect, default Filter). The super knob is
  // exposed as the Mixxx-compatible quickEffectSuperKnob name via the QuickEffect
  // rack group, but we also surface a deck-local convenience here.
  quickEffectSuper: 'quickeffect_super1',
  quickEffectEnabled: 'quickeffect_enabled',

  // main cue (Mixxx names)
  cuePoint: 'cue_point', // frames; -1 = unset
  cueSet: 'cue_set',
  cueGotoAndStop: 'cue_gotoandstop',

  // loops (Mixxx names). Positions in frames; -1 = unset.
  loopStartPosition: 'loop_start_position',
  loopEndPosition: 'loop_end_position',
  loopEnabled: 'loop_enabled',
  loopIn: 'loop_in',
  loopOut: 'loop_out',
  reloopToggle: 'reloop_toggle',
  loopHalve: 'loop_halve',
  loopDouble: 'loop_double',
  loopExit: 'loop_exit',
  reloopExit: 'reloop_exit', // Mixxx alias of reloop_toggle (enter/exit)
  reloopAndStop: 'reloop_andstop', // re-enter the loop and stop
  // beatloop (size-driven): activate a loop of beatloop_size beats; roll = while-held.
  beatloop: 'beatloop',
  beatloopSize: 'beatloop_size',
  beatloopActivate: 'beatloop_activate',
  beatlooprollActivate: 'beatlooproll_activate',
  // beatjump: jump N beats (beatjump_size) without looping.
  beatjump: 'beatjump',
  beatjumpSize: 'beatjump_size',
  beatjumpForward: 'beatjump_forward',
  beatjumpBackward: 'beatjump_backward',
  // beatloop_X_toggle controls are generated per-size (see beatloopKey).
} as const;

export type DeckKey = (typeof DeckKeys)[keyof typeof DeckKeys];

/** Max hotcues per deck (Mixxx supports 36). */
export const MAX_HOTCUES = 36;

/** Beatloop sizes Mixxx exposes (beats). */
export const BEATLOOP_SIZES = [
  0.03125, 0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512,
] as const;

/** Hotcue control keys (Mixxx `hotcue_N_*`, 1-based N). */
export function hotcuePositionKey(n: number): Key {
  return `hotcue_${n}_position`; // frames; -1 = unset
}
export function hotcueActivateKey(n: number): Key {
  return `hotcue_${n}_activate`;
}
export function hotcueSetKey(n: number): Key {
  return `hotcue_${n}_set`;
}
export function hotcueClearKey(n: number): Key {
  return `hotcue_${n}_clear`;
}
export function hotcueEnabledKey(n: number): Key {
  return `hotcue_${n}_enabled`; // 1 if set
}
export function hotcueColorKey(n: number): Key {
  return `hotcue_${n}_color`;
}

/** Beatloop toggle key for a given size (Mixxx `beatloop_X_toggle`). */
export function beatloopToggleKey(size: number): Key {
  return `beatloop_${size}_toggle`;
}
export function beatloopActivateKey(size: number): Key {
  return `beatloop_${size}_activate`;
}

// ---------------------------------------------------------------------------
// Master / crossfader control keys (Mixxx names).
// ---------------------------------------------------------------------------

export const MasterKeys = {
  sampleRate: 'samplerate', // the AudioContext sample rate (set by the engine)
  // Waveform zoom level: an INDEX into a fixed set of frames-per-pixel presets
  // (0 = most zoomed in). Global so both decks share a scale and synced waves line
  // up. The lane maps the index to frames/px.
  waveformZoom: 'waveform_zoom',
  crossfader: 'crossfader', // -1..1
  crossfaderCurve: 'xFaderCurve',
  crossfaderReverse: 'xFaderReverse',
  gain: 'gain', // main gain, 0..1..5
  boothGain: 'booth_gain',
  headGain: 'headGain',
  headMix: 'headMix', // -1 (main) .. 1 (pfl)
  headVolume: 'headVolume', // Mixxx alias of headGain (controllers use both names)
  headSplit: 'headSplit',
  balance: 'balance',
  vuMeterL: 'vu_meter_left',
  vuMeterR: 'vu_meter_right',
  peakIndicatorL: 'peak_indicator_left',
  peakIndicatorR: 'peak_indicator_right',

  // smart fader (our fork feature  see 09-smart-fader.md). Lives under [Master].
  smartFaderEnabled: 'smart_fader_enabled',
  smartFaderActive: 'smart_fader_active',
  smartFaderLeftBpm: 'smart_fader_left_bpm',
  smartFaderRightBpm: 'smart_fader_right_bpm',
  smartFaderTargetBpm: 'smart_fader_target_bpm',
} as const;

export type MasterKey = (typeof MasterKeys)[keyof typeof MasterKeys];

// ---------------------------------------------------------------------------
// App-wide control keys.
// ---------------------------------------------------------------------------

export const AppKeys = {
  numDecks: 'num_decks',
  numSamplers: 'num_samplers',
  numPreviewDecks: 'num_preview_decks',
  numMicrophones: 'num_microphones',
  numAuxiliaries: 'num_auxiliaries',
} as const;
