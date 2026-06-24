/**
 * @internal-dj/audio-engine — the real-time audio engine (renderer-side API).
 *
 * The worklet itself is at ./engine.worklet.ts and is loaded by URL via the app's
 * bundler (it must run in the AudioWorkletGlobalScope, not imported here).
 */

export { Engine, type EngineOptions } from './engine.js';
export { DeckPlayback, type DeckTrack } from './deck-playback.js';
export { KeylockScaler } from './keylock-scaler.js';
export type { Scaler, SourcePull } from './scaler.js';
export { CueControl } from './controls/cue-control.js';
export { LoopControl } from './controls/loop-control.js';
export {
  SyncEngine,
  shortestBeatError,
  type SyncMode,
  type SyncDeck,
  type DeckSyncState,
} from './sync/sync-engine.js';
export { SmartFader, type SmartFaderDeps } from './sync/smart-fader.js';
export { sliderFromRateRatio } from './rate.js';
export { calculateSpeed, rateRatioFromSlider } from './rate.js';
export { VuMeter } from './vu-meter.js';
export {
  getXfadeGains,
  crossfaderGainForChannel,
  orientationFromValue,
  type Orientation,
} from './crossfader.js';
export { createDeckGraph, eqKnobToDb, type DeckGraphNodes } from './deck-graph.js';
export { type DecodedTrack, packPlanarToSab } from './decoded-track.js';
export type {
  DeckControlIndices,
  EngineMessage,
  EngineInitMessage,
  LoadTrackMessage,
  WorkletMessage,
} from './protocol.js';
