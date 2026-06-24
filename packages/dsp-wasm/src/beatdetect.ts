/**
 * WasmBeatDetector — onset envelope + autocorrelation BPM/phase detection in
 * WASM+SIMD (replaces the JS loops in analysis/beat-detector.ts). Runs in the
 * analysis Worker (not real-time, but still JS heavy lifting we converted).
 *
 * The C kernel grows memory for a full track's source, so the module imports
 * emscripten_notify_memory_growth — we provide it. Heap views are re-read after
 * any call that may grow memory.
 */

import { beatdetectWasmBase64 } from './generated/beatdetect-wasm.js';

interface BeatDetectExports {
  memory: WebAssembly.Memory;
  bd_malloc(bytes: number): number;
  bd_free(ptr: number): void;
  beatdetect_run(
    srcL: number,
    srcR: number,
    frames: number,
    sampleRate: number,
    minBpm: number,
    maxBpm: number,
    envRate: number,
    scratch: number,
    scratchLen: number,
  ): void;
  beatdetect_bpm(): number;
  beatdetect_first_beat_frame(): number;
  beatdetect_confidence(): number;
  _initialize?: () => void;
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const nb = Buffer.from(b64, 'base64');
  const out = new Uint8Array(new ArrayBuffer(nb.length));
  out.set(nb);
  return out;
}

export interface BeatResult {
  bpm: number;
  firstBeatFrame: number;
  confidence: number;
}

export interface BeatDetectOptions {
  minBpm?: number;
  maxBpm?: number;
  envRate?: number;
}

const DEFAULTS = { minBpm: 70, maxBpm: 180, envRate: 100 };

export class WasmBeatDetector {
  private readonly ex: BeatDetectExports;

  constructor() {
    const bytes = base64ToBytes(beatdetectWasmBase64);
    const module = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(module, {
      env: {
        // Required by ALLOW_MEMORY_GROWTH. We re-read heap views per call, so a
        // no-op is fine.
        emscripten_notify_memory_growth: () => {},
      },
    });
    this.ex = instance.exports as unknown as BeatDetectExports;
    this.ex._initialize?.();
  }

  /**
   * Detect tempo + phase from planar channels. Allocates source + scratch in the
   * WASM heap, runs the kernel, frees, returns the result.
   */
  detect(
    channels: Float32Array[],
    frames: number,
    sampleRate: number,
    options: BeatDetectOptions = {},
  ): BeatResult {
    const { minBpm, maxBpm, envRate } = { ...DEFAULTS, ...options };
    const ex = this.ex;
    const left = channels[0]!;
    const right = channels.length > 1 ? channels[1]! : left;

    const srcLPtr = ex.bd_malloc(frames * 4);
    const srcRPtr = ex.bd_malloc(frames * 4);
    const hop = Math.max(1, Math.floor(sampleRate / envRate));
    const scratchLen = Math.floor(frames / hop) + 2;
    const scratchPtr = ex.bd_malloc(scratchLen * 4);

    // Write source (heap allocated above; the malloc calls already grew it).
    const heap = new Float32Array(ex.memory.buffer);
    heap.set(left.subarray(0, frames), srcLPtr / 4);
    heap.set(right.subarray(0, frames), srcRPtr / 4);

    ex.beatdetect_run(
      srcLPtr,
      srcRPtr,
      frames,
      sampleRate,
      minBpm,
      maxBpm,
      envRate,
      scratchPtr,
      scratchLen,
    );

    const result: BeatResult = {
      bpm: ex.beatdetect_bpm(),
      firstBeatFrame: ex.beatdetect_first_beat_frame(),
      confidence: ex.beatdetect_confidence(),
    };

    ex.bd_free(srcLPtr);
    ex.bd_free(srcRPtr);
    ex.bd_free(scratchPtr);
    return result;
  }
}
