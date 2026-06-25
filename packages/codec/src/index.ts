/**
 * @dj/codec — audio decode (and later encode).
 */

export {
  decodeArrayBuffer,
  fromAudioBuffer,
  decodeWithFfmpeg,
  isPlatformDecodable,
  PLATFORM_DECODABLE,
} from './decode.js';
export { encodeWav, interleave, concatFloat32, type WavBitDepth } from './wav.js';
export {
  allocateRing,
  wrapRing,
  ringWrite,
  ringRead,
  ringDropped,
  type SabRingViews,
} from './sab-ring.js';
export {
  Recorder,
  type RecorderOptions,
  type RecordingResult,
} from './recorder.js';
