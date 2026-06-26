/**
 * @dj/waveform — peak precompute + GPU (WebGL) waveform rendering, with
 * a Canvas2D fallback for the small static cases (library thumbnails) and overview.
 */

export {
  computePeaks,
  computeBandPeaks,
  computePeakSet,
  packPeaks,
  unpackPeaks,
  packStemWaveforms,
  unpackStemWaveforms,
  detailBucketsForDuration,
  OVERVIEW_BUCKETS,
  type PeakData,
  type StemOverview,
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
  type StemBand,
} from './render-canvas2d.js';
// GPU scrolling-waveform renderer (the live, per-frame path).
export { WaveformGL, type ScrollGLParams } from './render-webgl.js';
