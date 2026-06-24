/**
 * @internal-dj/waveform — peak precompute + canvas rendering.
 */

export {
  computePeaks,
  computePeakSet,
  detailBucketsForDuration,
  OVERVIEW_BUCKETS,
  type PeakData,
} from './peaks.js';
export {
  drawOverview,
  drawScrolling,
  DEFAULT_COLORS,
  type WaveformColors,
  type Marker,
  type LoopRegion,
  type Overlay,
  type ScrollOverlay,
} from './render-canvas2d.js';
