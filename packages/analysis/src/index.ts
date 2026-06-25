/**
 * @dj/analysis — beat/BPM detection + beatgrid model.
 */

export { Beats } from './beats.js';
export {
  detectBeats,
  detectBeatGrid,
  type BeatDetectorOptions,
  type BeatResult,
} from './beat-detector.js';
export { detectKey, type KeyResult } from './key-detector.js';
export type { AnalyzeRequest, AnalyzeResponse } from './worker-protocol.js';
