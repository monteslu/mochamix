/**
 * Group naming + control key constants, ported from Mixxx so we inherit its
 * controller-mapping ecosystem verbatim (see 03-architecture.md §1 and
 * 06-ui-controllers-effects.md §2). KEEP THESE NAMES EXACT — a stock Mixxx
 * mapping addresses `[Channel1],play`, `[Master],crossfader`, etc.
 *
 * This is not the full Mixxx control surface (that's hundreds of keys); it's the
 * subset we wire as we build, grown milestone by milestone.
 */

import type { Group } from './types.js';

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

// ---------------------------------------------------------------------------
// Per-deck control keys (Mixxx names). Grown as milestones add features.
// ---------------------------------------------------------------------------

export const DeckKeys = {
  // transport
  play: 'play',
  playIndicator: 'play_indicator',
  cueDefault: 'cue_default',
  cueGoto: 'cue_goto',
  start: 'start',
  startPlay: 'start_play',
  stop: 'stop',

  // position / state (read-mostly, published from the engine)
  playPosition: 'playposition', // 0..1 fraction of track
  trackLoaded: 'track_loaded',
  trackSamples: 'track_samples',
  trackSampleRate: 'track_samplerate',
  duration: 'duration', // seconds

  // tempo / rate
  rate: 'rate', // -1..1, scaled by rateRange/direction → speed
  rateRange: 'rateRange', // e.g. 0.10 == ±10%
  rateDirection: 'rate_dir', // +1 or -1
  rateRatio: 'rate_ratio', // effective rate ratio (1.0 == original)
  bpm: 'bpm', // effective BPM at current rate
  fileBpm: 'file_bpm', // analyzed/original BPM (used by sync + smart fader)
  keylock: 'keylock',

  // mixer (per channel)
  volume: 'volume', // 0..1
  pregain: 'pregain', // gain/trim, 0..1..4
  mute: 'mute',
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
} as const;

export type DeckKey = (typeof DeckKeys)[keyof typeof DeckKeys];

// ---------------------------------------------------------------------------
// Master / crossfader control keys (Mixxx names).
// ---------------------------------------------------------------------------

export const MasterKeys = {
  crossfader: 'crossfader', // -1..1
  crossfaderCurve: 'xFaderCurve',
  crossfaderReverse: 'xFaderReverse',
  gain: 'gain', // main gain, 0..1..5
  boothGain: 'booth_gain',
  headGain: 'headGain',
  headMix: 'headMix', // -1 (main) .. 1 (pfl)
  headSplit: 'headSplit',
  balance: 'balance',
  vuMeterL: 'vu_meter_left',
  vuMeterR: 'vu_meter_right',
  peakIndicatorL: 'peak_indicator_left',
  peakIndicatorR: 'peak_indicator_right',

  // smart fader (our fork feature — see 09-smart-fader.md). Lives under [Master].
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
