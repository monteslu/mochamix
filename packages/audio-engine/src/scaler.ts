/**
 * Time-stretch / pitch scaler interface — the Mixxx EngineBufferScale contract
 * (04-audio-engine.md §4). Two implementations:
 *   - LinearScaler (varispeed: speed changes pitch; can ramp through zero → used
 *     for scratch/reverse). This is DeckPlayback's built-in path.
 *   - KeylockScaler (independent tempo + pitch via SoundTouch/RubberBand WASM →
 *     used when keylock is on).
 *
 * The contract: a scaler is fed source samples on demand (it pulls via a
 * callback) and produces exactly the requested number of output frames per call.
 * tempo and pitch are independent ratios (1.0 == unchanged).
 *
 * This file defines the interface + the source-pull callback shape. Concrete
 * scalers live alongside.
 */

/**
 * Pulls up to `numFrames` of source audio into the given planar channel buffers
 * starting at the scaler's current read position, advancing it. Returns the
 * number of frames actually written (fewer at end-of-track). The scaler owns the
 * read position; this just delivers samples.
 */
export type SourcePull = (channels: Float32Array[], numFrames: number) => number;

export interface Scaler {
  /** Number of channels this scaler is configured for. */
  readonly channels: number;

  /**
   * Set the independent tempo and pitch ratios. tempo 1.0 == original speed,
   * pitch 1.0 == original pitch. For keylock, vary tempo while pitch stays 1.0.
   */
  setRatios(tempo: number, pitch: number): void;

  /**
   * Produce exactly `numFrames` of output into `outputs` (planar), pulling source
   * via `pull` as needed. Returns true while audio is flowing, false once the
   * source is exhausted and the internal buffers have drained.
   */
  process(outputs: Float32Array[], numFrames: number, pull: SourcePull): boolean;

  /**
   * Flush internal state (on seek/track change). After reset the scaler must be
   * re-primed before its output is musically aligned (see KeylockScaler priming).
   */
  reset(): void;
}
