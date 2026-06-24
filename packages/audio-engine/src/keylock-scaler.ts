/**
 * KeylockScaler — independent tempo/pitch time-stretch via SoundTouch (the Mixxx
 * "SoundTouch (faster)" keylock engine, 04-audio-engine.md §4). Implements the
 * Scaler contract so DeckPlayback can swap it in when keylock is on.
 *
 * SoundTouch works in INTERLEAVED stereo and buffers internally (it needs a chunk
 * of input before it can emit aligned output). We:
 *   - pull planar source via the SourcePull callback, interleave into SoundTouch's
 *     inputBuffer
 *   - run process(), drain the outputBuffer into our planar outputs
 *   - keep pulling/processing until we've filled the requested frame count
 *
 * Priming (the make-or-break seek detail — see SEEK PRIMING below): after reset()
 * SoundTouch's output is latent. We pre-feed it so the first post-seek block is
 * already musically aligned and click-free, rather than emitting the startup
 * transient. RubberBand will replace this with its getPreferredStartPad/
 * getStartDelay dance; the principle is identical.
 */

import { SoundTouch } from 'soundtouchjs';
import type { Scaler, SourcePull } from './scaler.js';

/** Frames of source to pre-feed after a reset so output is aligned (priming). */
const PRIME_FRAMES = 4096;
/** Frames pulled from source per top-up when the input buffer runs low. */
const PULL_CHUNK = 2048;

export class KeylockScaler implements Scaler {
  readonly channels = 2; // SoundTouch path is stereo; mono is fanned out upstream

  private readonly st = new SoundTouch();
  private tempo = 1;
  private pitch = 1;
  /** Scratch interleaved buffer for pulling source. */
  private readonly pullInterleaved = new Float32Array(PULL_CHUNK * 2);
  /** Scratch planar buffers for the source pull. */
  private readonly pullPlanar: [Float32Array, Float32Array] = [
    new Float32Array(PULL_CHUNK),
    new Float32Array(PULL_CHUNK),
  ];
  /** Scratch interleaved buffer for draining SoundTouch output. */
  private drain = new Float32Array(256 * 2);
  private sourceExhausted = false;
  private primed = false;

  constructor() {
    this.st.tempo = 1;
    this.st.pitch = 1;
  }

  setRatios(tempo: number, pitch: number): void {
    if (tempo !== this.tempo) {
      this.tempo = tempo;
      this.st.tempo = tempo;
    }
    if (pitch !== this.pitch) {
      this.pitch = pitch;
      this.st.pitch = pitch;
    }
  }

  reset(): void {
    this.st.clear();
    this.sourceExhausted = false;
    this.primed = false;
  }

  /** Pull up to `frames` source frames and push them (interleaved) into SoundTouch. */
  private feed(pull: SourcePull, frames: number): number {
    const want = Math.min(frames, PULL_CHUNK);
    const got = pull(this.pullPlanar, want);
    if (got <= 0) {
      this.sourceExhausted = true;
      return 0;
    }
    // interleave got frames
    const il = this.pullInterleaved;
    const l = this.pullPlanar[0];
    const r = this.pullPlanar[1];
    for (let i = 0; i < got; i++) {
      il[i * 2] = l[i]!;
      il[i * 2 + 1] = r[i]!;
    }
    this.st.inputBuffer.putSamples(il, 0, got);
    this.st.process();
    return got;
  }

  /**
   * SEEK PRIMING. After a reset/seek, pre-feed enough source that SoundTouch's
   * internal latency is absorbed and its outputBuffer holds aligned samples
   * before the caller reads. Without this, the first block after every cue jump
   * contains the stretcher's startup transient → an audible click. This is the
   * single most important detail in M2.
   */
  private prime(pull: SourcePull): void {
    let fed = 0;
    while (fed < PRIME_FRAMES && !this.sourceExhausted) {
      const got = this.feed(pull, PRIME_FRAMES - fed);
      if (got === 0) {
        break;
      }
      fed += got;
    }
    this.primed = true;
  }

  process(outputs: Float32Array[], numFrames: number, pull: SourcePull): boolean {
    if (!this.primed) {
      this.prime(pull);
    }

    const out0 = outputs[0]!;
    const out1 = outputs[1] ?? outputs[0]!;
    if (this.drain.length < numFrames * 2) {
      this.drain = new Float32Array(numFrames * 2);
    }

    let produced = 0;
    let guard = 0;
    while (produced < numFrames) {
      const avail = this.st.outputBuffer.frameCount;
      if (avail > 0) {
        const take = Math.min(avail, numFrames - produced);
        // Drain `take` frames from SoundTouch's outputBuffer (interleaved).
        this.st.outputBuffer.extract(this.drain, 0, take);
        this.st.outputBuffer.receive(take);
        for (let i = 0; i < take; i++) {
          out0[produced + i] = this.drain[i * 2]!;
          out1[produced + i] = this.drain[i * 2 + 1]!;
        }
        produced += take;
        continue;
      }
      // Output drained: feed more source.
      if (this.sourceExhausted) {
        break;
      }
      this.feed(pull, PULL_CHUNK);
      // Safety: avoid an infinite loop if SoundTouch can't produce (e.g. extreme
      // ratios). Bail after a bounded number of feed attempts.
      if (++guard > 64) {
        break;
      }
    }

    // Zero any unfilled tail.
    for (let i = produced; i < numFrames; i++) {
      out0[i] = 0;
      out1[i] = 0;
    }

    return produced > 0 || !this.sourceExhausted;
  }
}
