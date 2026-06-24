/**
 * The message protocol between the main thread (renderer) and the engine
 * AudioWorklet. Heavy/real-time data (control values, samples) travels via
 * SharedArrayBuffer; this protocol carries setup and track-load events.
 *
 * Rule (04-audio-engine.md §7): the real-time path never allocates. Track
 * decoding happens off-thread; the decoded sample SAB is handed to the worklet
 * here, and the worklet just swaps a pointer.
 */

import type { SabLayout } from '@internal-dj/control-bus';

/** Per-deck control indices the worklet reads from the control SAB each block. */
export interface DeckControlIndices {
  play: number;
  playPosition: number;
  rate: number;
  rateRange: number;
  rateDirection: number;
  rateRatio: number;
  keylock: number;
  pregain: number;
  volume: number;
  trackLoaded: number;
  trackSamples: number;
  duration: number;
}

/** Static engine configuration sent once at init. */
export interface EngineInitMessage {
  type: 'init';
  /** The control-bus SAB buffer (worklet wraps it for atomic reads). */
  controlBuffer: SharedArrayBuffer;
  /** Capacity of the control SAB (control count). */
  controlCapacity: number;
  /** Number of decks. */
  numDecks: number;
  /** Per-deck control index maps, in deck order (deck 1 at [0]). */
  deckIndices: DeckControlIndices[];
  /** The engine sample rate (AudioContext.sampleRate). */
  sampleRate: number;
}

/**
 * A decoded track handed to a deck. The sample data lives in a SharedArrayBuffer
 * as planar Float32 (one channel after another). The worklet keeps the SAB and
 * indexes it directly — no copy, no per-block allocation.
 */
export interface LoadTrackMessage {
  type: 'loadTrack';
  deck: number; // 0-based
  /** Planar Float32 sample data: [ch0 frames..., ch1 frames...]. */
  sampleBuffer: SharedArrayBuffer;
  channels: number;
  frames: number;
  /** The track's own sample rate (may differ from the engine's). */
  trackSampleRate: number;
}

/** Eject the track from a deck. */
export interface EjectMessage {
  type: 'eject';
  deck: number;
}

/** Request a seek to an absolute frame (the central seek queue, M1 version). */
export interface SeekMessage {
  type: 'seek';
  deck: number;
  frame: number;
}

export type EngineMessage = EngineInitMessage | LoadTrackMessage | EjectMessage | SeekMessage;

/** Messages the worklet posts back to the main thread (rare; mostly diagnostics). */
export interface WorkletReadyMessage {
  type: 'ready';
}
export interface WorkletTrackEndedMessage {
  type: 'trackEnded';
  deck: number;
}
export type WorkletMessage = WorkletReadyMessage | WorkletTrackEndedMessage;

/** Re-export for worklet code that wraps the control SAB. */
export type { SabLayout };
