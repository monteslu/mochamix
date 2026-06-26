/**
 * Message protocol for the analysis Worker. The sample data is passed as a
 * SharedArrayBuffer (planar Float32) so no copy is needed — the same buffer the
 * deck already holds (05-library-and-data.md §6).
 */

export interface AnalyzeRequest {
  type: 'analyze';
  /** Correlation id so the caller can match the response. */
  id: number;
  /** MONO Float32 samples in a plain ArrayBuffer, TRANSFERRED to the worker (so the
   *  main thread frees it immediately — no lingering SharedArrayBuffers). */
  mono: ArrayBuffer;
  frames: number;
  sampleRate: number;
  /** If set, also compute the waveform peak set in the worker (off main thread). */
  computePeaks?: boolean;
  /** Detail bucket count for the peak set (overview count is fixed). */
  detailBuckets?: number;
}

export interface AnalyzeResponse {
  type: 'analyzed';
  id: number;
  bpm: number;
  firstBeatFrame: number;
  confidence: number;
  /** Musical key, e.g. "Am" (or '' if not detected). */
  key: string;
  /** Camelot code, e.g. "8A". */
  camelot: string;
  /** Numeric key index 1..24 (0 = none) for Camelot harmonic-match math. */
  keyNum?: number;
  /** Bar-start beats (downbeats), in source frames — real measures from DownBeat. */
  downbeatFrames?: Int32Array;
  /** Overview peaks (Uint8 per bucket), if computePeaks was requested. */
  overviewPeaks?: Uint8Array;
  /** Overview band peaks (low/mid/high) for frequency coloring. */
  overviewLow?: Uint8Array;
  overviewMid?: Uint8Array;
  overviewHigh?: Uint8Array;
  /** Detail peaks, if computePeaks was requested. */
  detailPeaks?: Uint8Array;
  detailFramesPerBucket?: number;
}
