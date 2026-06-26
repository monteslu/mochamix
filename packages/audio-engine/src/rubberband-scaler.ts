/**
 * RubberBandScaler — independent tempo/pitch time-stretch via the Rubber Band Library
 * (breakfastquay/rubberband), compiled to WASM (GPL-2.0). Replaces the pure-JS
 * SoundTouch keylock engine: ALL the per-sample DSP now runs in WASM (no JS sample
 * loops), and it adds REAL formant preservation (RubberBandOptionFormantPreserved) so
 * shifted voices stay natural instead of chipmunking.
 *
 * Implements the Scaler contract: pull planar source via SourcePull, push it into
 * RubberBand's real-time engine (rubberband_process), pull stretched output back
 * (rubberband_retrieve). RubberBand has inherent latency — we pre-feed on reset so the
 * first post-seek block is musically aligned, like the SoundTouch path did.
 *
 * The emscripten glue is loaded once (module-level), instantiated synchronously from
 * the embedded wasm so it works inside the AudioWorklet (no fetch there). Until it's
 * ready the scaler reports not-flowing; the deck falls back to the linear path, so a
 * freshly-created scaler never glitches.
 */

import { rubberbandWasmBase64 } from './generated/rubberband-wasm.js';
import { base64ToBytes } from './base64.js';
import type { Scaler, SourcePull } from './scaler.js';
// Static import (NOT dynamic) — AudioWorklets don't support dynamic import(); the glue
// must be bundled in. It's an async emscripten factory; we await it at construction.
// @ts-expect-error — vendored emscripten glue has no types; it's a default-export factory.
import rubberbandFactory from '../vendor/rubberband/rubberband.js';

// Rubber Band C option flags (rubberband-c.h).
const OPTION_PROCESS_REALTIME = 0x00000001;
const OPTION_FORMANT_PRESERVED = 0x01000000;
const OPTION_FORMANT_SHIFTED = 0x00000000;
const OPTION_PITCH_HIGH_CONSISTENCY = 0x04000000; // smooth when pitch varies
// Engine: R2 (Faster) has HALF the latency of R3 (Finer) — 1024 vs 2048 frames
// (~23ms vs ~46ms). For LIVE DJ use, responsiveness beats the small quality edge, and
// R2 + formant preservation already sounds far better than the old JS SoundTouch.
const OPTION_ENGINE_FASTER = 0x00000000;

/**
 * Emscripten module exports we use. RubberBand's C API is exposed `_`-prefixed; malloc/
 * free + HEAP views come from emscripten. All operate on a state pointer (rubberband_new).
 */
interface GlueModule {
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  HEAPF32: Float32Array;
  HEAPU32: Uint32Array;
  _rubberband_new(sr: number, channels: number, options: number, timeRatio: number, pitchScale: number): number;
  _rubberband_delete(state: number): void;
  _rubberband_reset(state: number): void;
  _rubberband_set_time_ratio(state: number, ratio: number): void;
  _rubberband_set_pitch_scale(state: number, scale: number): void;
  _rubberband_set_formant_option(state: number, options: number): void;
  _rubberband_process(state: number, input: number, samples: number, final: number): void;
  _rubberband_available(state: number): number;
  _rubberband_retrieve(state: number, output: number, samples: number): number;
  _rubberband_get_samples_required(state: number): number;
  _rubberband_get_latency(state: number): number;
}

// Load the emscripten module once. It's async (returns a Promise), so the first scaler
// triggers the load and scalers are inert until it resolves (~instant: embedded bytes).
let gluePromise: Promise<GlueModule> | null = null;

async function loadGlue(): Promise<GlueModule> {
  if (gluePromise) return gluePromise;
  gluePromise = (async () => {
    const factory = rubberbandFactory as (arg: Record<string, unknown>) => Promise<GlueModule>;
    const wasmBytes = base64ToBytes(rubberbandWasmBase64);
    const mod = await factory({
      wasmBinary: wasmBytes,
      // Synchronous instantiation from the pre-supplied module (works in the worklet,
      // where async streaming fetch is unavailable). new WebAssembly.Instance is sync.
      instantiateWasm(
        info: WebAssembly.Imports,
        receive: (inst: WebAssembly.Instance, module: WebAssembly.Module) => void,
      ): WebAssembly.Exports {
        const module = new WebAssembly.Module(wasmBytes);
        const instance = new WebAssembly.Instance(module, info);
        receive(instance, module);
        return instance.exports;
      },
    });
    return mod;
  })();
  return gluePromise;
}

const SR = 44100; // RubberBand sample rate (analysis/playback convention)
const MAX_BLOCK = 1024; // max frames per process call (our blocks are ≤128, +priming)

export class RubberBandScaler implements Scaler {
  readonly channels = 2;

  private mod: GlueModule | null = null;
  private state = 0;
  private tempo = 1;
  private pitch = 1;
  private formant = true;
  private primed = false;
  private sourceExhausted = false;

  // WASM scratch buffers (interleaved-by-channel-pointer arrays for RB's planar API).
  private inPtrL = 0;
  private inPtrR = 0;
  private outPtrL = 0;
  private outPtrR = 0;
  private chanArrPtr = 0; // float** for the 2 channel pointers
  // JS-side planar scratch for the SourcePull (filled by the resampler, copied to WASM).
  private pullL = new Float32Array(MAX_BLOCK);
  private pullR = new Float32Array(MAX_BLOCK);

  constructor() {
    void this.init();
  }

  private async init(): Promise<void> {
    const mod = await loadGlue();
    this.mod = mod;
    const opts =
      OPTION_PROCESS_REALTIME |
      OPTION_ENGINE_FASTER |
      OPTION_PITCH_HIGH_CONSISTENCY |
      (this.formant ? OPTION_FORMANT_PRESERVED : OPTION_FORMANT_SHIFTED);
    this.state = mod._rubberband_new(SR, 2, opts, 1, 1);
    this.inPtrL = mod._malloc(MAX_BLOCK * 4);
    this.inPtrR = mod._malloc(MAX_BLOCK * 4);
    this.outPtrL = mod._malloc(MAX_BLOCK * 4);
    this.outPtrR = mod._malloc(MAX_BLOCK * 4);
    this.chanArrPtr = mod._malloc(2 * 4);
  }

  setRatios(tempo: number, pitch: number): void {
    if (!this.mod || !this.state) return;
    if (tempo !== this.tempo) {
      this.tempo = tempo;
      // time ratio is the INVERSE of playback speed (slower playback = longer output).
      this.mod._rubberband_set_time_ratio(this.state, 1 / tempo);
    }
    if (pitch !== this.pitch) {
      this.pitch = pitch;
      this.mod._rubberband_set_pitch_scale(this.state, pitch);
    }
  }

  setFormantPreserved(on: boolean): void {
    if (on === this.formant) return;
    this.formant = on;
    if (this.mod && this.state) {
      this.mod._rubberband_set_formant_option(this.state, on ? OPTION_FORMANT_PRESERVED : OPTION_FORMANT_SHIFTED);
    }
  }

  reset(): void {
    if (this.mod && this.state) this.mod._rubberband_reset(this.state);
    this.primed = false;
    this.sourceExhausted = false;
  }

  /** Pull `frames` planar source and push into RubberBand (interleaved-by-pointer). */
  private feed(pull: SourcePull, frames: number): number {
    const mod = this.mod!;
    const n = Math.min(frames, MAX_BLOCK);
    const got = pull([this.pullL, this.pullR], n);
    if (got <= 0) return 0;
    const heap = mod.HEAPF32;
    heap.set(this.pullL.subarray(0, got), this.inPtrL >> 2);
    heap.set(this.pullR.subarray(0, got), this.inPtrR >> 2);
    const u32 = mod.HEAPU32;
    u32[this.chanArrPtr >> 2] = this.inPtrL;
    u32[(this.chanArrPtr >> 2) + 1] = this.inPtrR;
    mod._rubberband_process(this.state, this.chanArrPtr, got, 0);
    if (got < n) this.sourceExhausted = true;
    return got;
  }

  /** Retrieve up to `frames` stretched frames into the planar outputs at `offset`. */
  private retrieve(outputs: Float32Array[], offset: number, frames: number): number {
    const mod = this.mod!;
    const avail = mod._rubberband_available(this.state);
    if (avail <= 0) return 0;
    const want = Math.min(frames, avail, MAX_BLOCK);
    const u32 = mod.HEAPU32;
    u32[this.chanArrPtr >> 2] = this.outPtrL;
    u32[(this.chanArrPtr >> 2) + 1] = this.outPtrR;
    const got = mod._rubberband_retrieve(this.state, this.chanArrPtr, want);
    if (got <= 0) return 0;
    const heap = mod.HEAPF32;
    const outL = outputs[0]!;
    const outR = outputs[1] ?? outputs[0]!;
    outL.set(heap.subarray(this.outPtrL >> 2, (this.outPtrL >> 2) + got), offset);
    outR.set(heap.subarray(this.outPtrR >> 2, (this.outPtrR >> 2) + got), offset);
    return got;
  }

  process(outputs: Float32Array[], numFrames: number, pull: SourcePull): boolean {
    // Not ready yet (wasm still loading) → report not flowing; deck uses the linear path.
    if (!this.mod || !this.state) return false;
    const mod = this.mod;

    // Prime: feed enough source to cover RubberBand's latency so the first output block
    // is aligned (mirrors the SoundTouch priming).
    if (!this.primed) {
      let guard = 0;
      while (mod._rubberband_available(this.state) < numFrames && !this.sourceExhausted && guard < 64) {
        const need = mod._rubberband_get_samples_required(this.state) || 256;
        if (this.feed(pull, need) === 0) break;
        guard++;
      }
      this.primed = true;
    }

    let produced = 0;
    let guard = 0;
    while (produced < numFrames && guard < 128) {
      // Pull whatever's ready.
      const got = this.retrieve(outputs, produced, numFrames - produced);
      produced += got;
      if (produced >= numFrames) break;
      if (this.sourceExhausted && mod._rubberband_available(this.state) <= 0) break;
      // Need more — feed source.
      if (got === 0) {
        const need = mod._rubberband_get_samples_required(this.state) || 256;
        if (this.feed(pull, need) === 0 && this.sourceExhausted) break;
      }
      guard++;
    }

    // Zero any tail we couldn't fill (end of track).
    if (produced < numFrames) {
      for (const ch of outputs) ch.fill(0, produced, numFrames);
    }
    return produced > 0 || !this.sourceExhausted;
  }
}
