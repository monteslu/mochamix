/**
 * WasmResampler — the WASM+SIMD deck sample reader (replaces the per-sample JS
 * loop in deck-playback.ts; see the DEBT LEDGER). Instantiated SYNCHRONOUSLY from
 * embedded base64 bytes so it works inside an AudioWorklet (no fetch there).
 *
 * Owns scratch buffers in the WASM heap for the source window + output. The
 * caller (DeckPlayback) keeps the play position; pull() takes it in and returns
 * the new position + frames produced.
 */

import { resamplerWasmBase64 } from './generated/resampler-wasm.js';

interface ResamplerExports {
  memory: WebAssembly.Memory;
  malloc(bytes: number): number;
  free(ptr: number): void;
  resampler_pull(
    srcL: number,
    srcR: number,
    srcFrames: number,
    outL: number,
    outR: number,
    numFrames: number,
    position: number,
    ratio: number,
    loopEnabled: number,
    loopStart: number,
    loopEnd: number,
    seamFade: number,
  ): void;
  resampler_last_position(): number;
  resampler_last_produced(): number;
  _initialize?: () => void;
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  // atob is a global in browsers, workers, worklets AND Node ≥16 — no Buffer
  // (which is Node-only and crashes the renderer). Pure typed-array decode.
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/** The play-state + loop-state a pull needs. */
export interface PullParams {
  position: number;
  ratio: number;
  loopEnabled: boolean;
  loopStart: number;
  loopEnd: number;
  seamFade: number;
}

export interface PullOutcome {
  newPosition: number;
  produced: number;
}

const SEAM_FADE_DEFAULT = 64;

export class WasmResampler {
  private readonly ex: ResamplerExports;
  // Source pointers (re-(de)allocated when the track changes / grows).
  private srcLPtr = 0;
  private srcRPtr = 0;
  private srcCapacity = 0;
  // Output pointers (re-allocated when the block size grows).
  private outLPtr = 0;
  private outRPtr = 0;
  private outCapacity = 0;

  constructor() {
    const bytes = base64ToBytes(resamplerWasmBase64);
    const module = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(module, {});
    this.ex = instance.exports as unknown as ResamplerExports;
    this.ex._initialize?.();
  }

  private heapF32(): Float32Array {
    return new Float32Array(this.ex.memory.buffer);
  }

  /**
   * Upload a track's planar stereo source into the WASM heap. Call once per track
   * load. (Mono should be duplicated to both channels by the caller.)
   */
  setSource(left: Float32Array, right: Float32Array, frames: number): void {
    if (frames > this.srcCapacity) {
      if (this.srcLPtr) {
        this.ex.free(this.srcLPtr);
        this.ex.free(this.srcRPtr);
      }
      this.srcLPtr = this.ex.malloc(frames * 4);
      this.srcRPtr = this.ex.malloc(frames * 4);
      this.srcCapacity = frames;
    }
    const heap = this.heapF32();
    heap.set(left.subarray(0, frames), this.srcLPtr / 4);
    heap.set(right.subarray(0, frames), this.srcRPtr / 4);
    this.srcFrames = frames;
  }

  private srcFrames = 0;

  private ensureOut(numFrames: number): void {
    if (numFrames > this.outCapacity) {
      if (this.outLPtr) {
        this.ex.free(this.outLPtr);
        this.ex.free(this.outRPtr);
      }
      this.outLPtr = this.ex.malloc(numFrames * 4);
      this.outRPtr = this.ex.malloc(numFrames * 4);
      this.outCapacity = numFrames;
    }
  }

  /**
   * Produce `numFrames` into outL/outR (planar, caller-owned). Returns the new
   * position + frames produced.
   */
  pull(outL: Float32Array, outR: Float32Array, numFrames: number, p: PullParams): PullOutcome {
    if (this.srcFrames === 0) {
      outL.fill(0, 0, numFrames);
      outR.fill(0, 0, numFrames);
      return { newPosition: p.position, produced: 0 };
    }
    this.ensureOut(numFrames);
    this.ex.resampler_pull(
      this.srcLPtr,
      this.srcRPtr,
      this.srcFrames,
      this.outLPtr,
      this.outRPtr,
      numFrames,
      p.position,
      p.ratio,
      p.loopEnabled ? 1 : 0,
      p.loopStart,
      p.loopEnd,
      p.seamFade || SEAM_FADE_DEFAULT,
    );
    const heap = this.heapF32();
    const produced = this.ex.resampler_last_produced();
    // Copy out (heap may have moved if memory grew — re-read each call).
    outL.set(heap.subarray(this.outLPtr / 4, this.outLPtr / 4 + numFrames), 0);
    outR.set(heap.subarray(this.outRPtr / 4, this.outRPtr / 4 + numFrames), 0);
    if (produced < numFrames) {
      outL.fill(0, produced, numFrames);
      outR.fill(0, produced, numFrames);
    }
    return { newPosition: this.ex.resampler_last_position(), produced };
  }

  clearSource(): void {
    this.srcFrames = 0;
  }
}
