/**
 * @internal-dj/dsp-wasm — WASM+SIMD DSP modules replacing per-sample JS hot paths.
 */

export {
  WasmResampler,
  type PullParams,
  type PullOutcome,
} from './resampler.js';
export {
  WasmBeatDetector,
  type BeatResult,
  type BeatDetectOptions,
} from './beatdetect.js';
