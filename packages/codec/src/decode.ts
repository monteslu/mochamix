/**
 * Audio decoding (05-library-and-data.md §4).
 *
 * M1 path: `AudioContext.decodeAudioData()` handles the common formats every
 * browser supports (MP3, WAV, FLAC, AAC/M4A, Ogg, Opus on most builds). The
 * decoded planar Float32 is packed into a SharedArrayBuffer for the worklet.
 *
 * The ffmpeg-wasm worker path (lifted from Loukai's aacWorker pattern) covers
 * formats the browser can't, and is the encode path for recording. It's a
 * deferred extension point here — see `decodeWithFfmpeg` below.
 */

import { packPlanarToSab, type DecodedTrack } from '@dj/audio-engine';

/**
 * Decode an encoded audio file (as an ArrayBuffer) into a SAB-backed
 * DecodedTrack using the platform decoder.
 *
 * `ctx` is any BaseAudioContext (a short-lived OfflineAudioContext is fine and
 * keeps decode off the live graph). `decodeAudioData` resamples to the context's
 * sample rate; for true source-rate decoding use an OfflineAudioContext created
 * at the desired rate, or the ffmpeg path.
 */
export async function decodeArrayBuffer(
  ctx: BaseAudioContext,
  data: ArrayBuffer,
  name?: string,
): Promise<DecodedTrack> {
  // decodeAudioData may detach the input buffer; callers pass a transferable copy
  // if they need to keep it.
  const audioBuffer = await ctx.decodeAudioData(data);
  return fromAudioBuffer(audioBuffer, name);
}

/** Convert a decoded AudioBuffer into a SAB-backed DecodedTrack. */
export function fromAudioBuffer(audioBuffer: AudioBuffer, name?: string): DecodedTrack {
  const channels = audioBuffer.numberOfChannels;
  const frames = audioBuffer.length;
  const channelData: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    channelData.push(audioBuffer.getChannelData(c));
  }
  const sampleBuffer = packPlanarToSab(channelData, frames);
  return {
    sampleBuffer,
    channels,
    frames,
    sampleRate: audioBuffer.sampleRate,
    name,
  };
}

/** Mono planar samples for ANALYSIS, in a plain (transferable) ArrayBuffer. */
export interface AnalysisAudio {
  /** Mono Float32 samples in a regular ArrayBuffer (transferable to a worker). */
  mono: ArrayBuffer;
  frames: number;
  sampleRate: number;
}

/**
 * Decode a file for ANALYSIS (not playback). Two memory wins over decodeArrayBuffer:
 *  - Downmixes to MONO (analysis only needs the mix) → half the data.
 *  - Returns a plain ArrayBuffer, NOT a SharedArrayBuffer → it can be TRANSFERRED to
 *    the analysis worker, so the main thread frees it immediately (SABs linger until
 *    BOTH sides GC, which under heavy concurrency exhausts the renderer heap).
 * Uses a short-lived OfflineAudioContext so the decoded AudioBuffer is GC'd with it,
 * not retained by the live engine context.
 */
export async function decodeForAnalysis(data: ArrayBuffer): Promise<AnalysisAudio> {
  // A throwaway context just to decode. The rate doesn't matter for tempo/key (qm uses
  // the reported sampleRate); 44100 is the analysis convention.
  const Offline =
    (globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!Offline) throw new Error('OfflineAudioContext unavailable');
  const ctx = new Offline(1, 1, 44100);
  const audioBuffer = await ctx.decodeAudioData(data);
  const frames = audioBuffer.length;
  const ch = audioBuffer.numberOfChannels;
  const left = audioBuffer.getChannelData(0);
  const right = ch > 1 ? audioBuffer.getChannelData(1) : left;
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) mono[i] = 0.5 * (left[i]! + right[i]!);
  return { mono: mono.buffer, frames, sampleRate: audioBuffer.sampleRate };
}

/**
 * Build AnalysisAudio (mono, transferable) from an already-decoded track. Used by the
 * deck-load path, which has a DecodedTrack in hand and wants to analyze it without
 * re-decoding. Copies the mono mix into a fresh ArrayBuffer (the SAB stays with the
 * deck for playback; the copy is transferred to the worker).
 */
export function analysisFromDecoded(track: DecodedTrack): AnalysisAudio {
  const all = new Float32Array(track.sampleBuffer);
  const frames = track.frames;
  const left = all.subarray(0, frames);
  const right = track.channels > 1 ? all.subarray(frames, frames * 2) : left;
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) mono[i] = 0.5 * (left[i]! + right[i]!);
  return { mono: mono.buffer, frames, sampleRate: track.sampleRate };
}

/**
 * Deferred: decode via ffmpeg-wasm in a Worker for formats the platform can't
 * handle (and as the basis for the encode/record path). Mirrors Loukai's
 * `aacWorker.js` (RPC over a module worker, ffmpeg-core.wasm). Wire this when an
 * unsupported format actually shows up.
 */
export async function decodeWithFfmpeg(_data: ArrayBuffer): Promise<DecodedTrack> {
  throw new Error(
    'decodeWithFfmpeg: not yet wired — lift the ffmpeg-wasm worker from ../loukai (aacWorker). ' +
      'See 05-library-and-data.md §4 and 10-electron-feasibility.md §1.',
  );
}

/** File extensions the platform decoder is expected to handle directly. */
export const PLATFORM_DECODABLE = new Set([
  'mp3',
  'wav',
  'wave',
  'flac',
  'm4a',
  'mp4',
  'aac',
  'ogg',
  'oga',
  'opus',
  'aiff',
  'aif',
  'webm',
]);

/** Heuristic: can the platform decoder probably handle this filename? */
export function isPlatformDecodable(filename: string): boolean {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) {
    return false;
  }
  return PLATFORM_DECODABLE.has(filename.slice(dot + 1).toLowerCase());
}
