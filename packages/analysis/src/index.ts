/**
 * @dj/analysis — beatgrid model + the analysis worker protocol. The actual
 * beat/key/downbeat detection is Mixxx's Queen Mary DSP, in @dj/dsp-wasm
 * (WasmQmAnalysis), run from the analysis worker.
 */

export { Beats } from './beats.js';
export type { AnalyzeRequest, AnalyzeResponse } from './worker-protocol.js';
export {
  type KeyNum,
  isValidKey,
  keyIsMajor,
  keyToCamelot,
  camelotToKey,
  shortestStepsToKey,
  shortestStepsToCompatibleKey,
  transposeKey,
  areKeysCompatible,
} from './camelot.js';
