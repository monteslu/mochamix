/**
 * DeckPlayback — the per-deck sample producer (Mixxx EngineBuffer +
 * EngineBufferScale analog, 04-audio-engine.md §4). Two scaler paths:
 *
 *   - LINEAR (keylock off): varispeed. One linear-interpolation read does
 *     resampling + tempo together, so pitch follows speed (like vinyl). Can ramp
 *     through zero → also the path for scratch/reverse.
 *   - KEYLOCK (keylock on): the source is resampled to the engine rate at
 *     ORIGINAL pitch (baseRate only), then a KeylockScaler (SoundTouch) applies
 *     the user tempo independently, holding pitch constant.
 *
 * DeckPlayback owns the fractional source read position in both paths (the
 * KeylockScaler pulls through `pullResampled`, which advances it), so seeking and
 * position reporting work identically regardless of scaler.
 *
 * Pure (no Web Audio / no SAB) → unit-tested sample-accurately.
 */

import type { Scaler, SourcePull } from './scaler.js';
import { KeylockScaler } from './keylock-scaler.js';
import { WasmResampler } from '@dj/dsp-wasm';

export interface DeckTrack {
  /** Planar Float32 channel data. channelData[c][frame]. */
  channelData: Float32Array[];
  channels: number;
  frames: number;
  sampleRate: number;
}

export class DeckPlayback {
  private track: DeckTrack | null = null;
  /** Fractional play position, in source frames. */
  private position = 0;
  /** Resampling ratio = trackSampleRate / engineSampleRate. */
  private baseRate = 1;

  private keylock = false;
  private keylockScaler: Scaler | null = null;
  /** The keylock scaler's own source read cursor, decoupled from the authoritative
   *  `position` (which advances at the exact commanded rate). Kept in sync on seek. */
  private scalerCursor = 0;

  /** The WASM+SIMD resampler — the real-time read path (replaces the JS loop). */
  private readonly wasm = new WasmResampler();

  // ── stem decks (the live-mashup differentiator) ──────────────────────────
  // When a .stem.mp4 is loaded, the deck plays the SUM of 4 stems, each through its
  // own resampler at the SAME position, with a per-stem gain (0 = muted). This lets
  // a DJ isolate vocals on one deck over another deck's instrumental. Empty = normal
  // single-source playback (the `wasm` resampler above).
  private stemResamplers: WasmResampler[] = [];
  private stemGains: number[] = [];
  /** Scratch stereo buffers for summing stems (allocated on stem load, not in process). */
  private stemScratchL: Float32Array | null = null;
  private stemScratchR: Float32Array | null = null;

  // Loop state (in source frames). When enabled and playing forward, the read
  // position wraps from loopEnd back to loopStart with a short seam crossfade.
  private loopEnabled = false;
  private loopStart = 0;
  private loopEnd = 0;
  /** Crossfade length (source frames) applied across a loop seam to avoid clicks. */
  private static readonly SEAM_FADE = 64;

  constructor(private engineSampleRate: number) {}

  loadTrack(track: DeckTrack): void {
    this.track = track;
    this.position = 0;
    this.scalerCursor = 0;
    this.baseRate = track.sampleRate / this.engineSampleRate;
    // Upload planar stereo into the WASM heap (mono → duplicate to both channels).
    const left = track.channelData[0]!;
    const right = track.channels > 1 ? track.channelData[1]! : left;
    this.wasm.setSource(left, right, track.frames);
    this.keylockScaler?.reset();
  }

  /**
   * Load N stems (each a stereo DeckTrack at the same sample rate/length) as a stem
   * deck. The deck then plays SUM(stem_i × gain_i). Stems must share the source
   * frame count + sample rate (they're separations of one track). Gains default to 1.
   */
  loadStems(stems: DeckTrack[]): void {
    if (stems.length === 0) {
      return;
    }
    const first = stems[0]!;
    // Drive shared playback state off the first stem (they're frame-aligned).
    this.track = first;
    this.position = 0;
    this.scalerCursor = 0;
    this.baseRate = first.sampleRate / this.engineSampleRate;
    this.keylockScaler?.reset();

    this.stemResamplers = stems.map((s) => {
      const r = new WasmResampler();
      const l = s.channelData[0]!;
      const rr = s.channels > 1 ? s.channelData[1]! : l;
      r.setSource(l, rr, s.frames);
      return r;
    });
    this.stemGains = stems.map(() => 1);
    this.stemScratchL = null; // sized lazily in process (numFrames-dependent)
    this.stemScratchR = null;
    // The primary `wasm` resampler is unused in stem mode; clear it.
    this.wasm.clearSource();
  }

  /** Set a stem's gain (0..1+). Index matches the load order (drums,bass,other,vocals). */
  setStemGain(index: number, gain: number): void {
    if (index >= 0 && index < this.stemGains.length) {
      this.stemGains[index] = gain;
    }
  }

  hasStems(): boolean {
    return this.stemResamplers.length > 0;
  }

  eject(): void {
    this.track = null;
    this.position = 0;
    this.scalerCursor = 0;
    this.wasm.clearSource();
    this.stemResamplers = [];
    this.stemGains = [];
    this.stemScratchL = null;
    this.stemScratchR = null;
    this.keylockScaler?.reset();
  }

  hasTrack(): boolean {
    return this.track !== null;
  }

  get frames(): number {
    return this.track?.frames ?? 0;
  }

  getPositionFrames(): number {
    return this.position;
  }

  getPositionFraction(): number {
    if (!this.track || this.track.frames === 0) {
      return 0;
    }
    return this.position / this.track.frames;
  }

  seekFrames(frame: number): void {
    if (!this.track) {
      return;
    }
    this.position = Math.max(0, Math.min(frame, this.track.frames));
    this.scalerCursor = this.position; // scaler reads from the new spot after a jump
    // A seek invalidates the keylock scaler's buffered/primed state.
    this.keylockScaler?.reset();
  }

  seekFraction(fraction: number): void {
    if (!this.track) {
      return;
    }
    this.seekFrames(fraction * this.track.frames);
  }

  /** Enable/disable keylock. Toggling resets the scaler to re-prime cleanly. */
  setKeylock(on: boolean): void {
    if (on === this.keylock) {
      return;
    }
    this.keylock = on;
    if (on && !this.keylockScaler) {
      this.keylockScaler = new KeylockScaler();
    }
    this.keylockScaler?.reset();
  }

  isKeylock(): boolean {
    return this.keylock;
  }

  /** Set the loop region (frames) and whether it's active. */
  setLoop(start: number, end: number, enabled: boolean): void {
    this.loopStart = Math.max(0, start);
    this.loopEnd = Math.max(this.loopStart, end);
    this.loopEnabled = enabled && this.loopEnd > this.loopStart;
  }

  setLoopEnabled(enabled: boolean): void {
    this.loopEnabled = enabled && this.loopEnd > this.loopStart;
  }

  isLoopEnabled(): boolean {
    return this.loopEnabled;
  }

  getLoop(): { start: number; end: number; enabled: boolean } {
    return { start: this.loopStart, end: this.loopEnd, enabled: this.loopEnabled };
  }

  /**
   * Linear-interpolation read of `numFrames` from the source into planar
   * `outputs`, advancing the play position by `resampleRatio` source frames per
   * output frame. Returns frames actually produced (fewer at end-of-track). This
   * is both the varispeed path and the source-pull for the keylock scaler.
   */
  private pullResampled(
    outputs: Float32Array[],
    numFrames: number,
    resampleRatio: number,
  ): number {
    if (!this.track) {
      return 0;
    }
    // Delegate to the WASM+SIMD resampler (the real-time read path). It handles
    // interpolation + loop wrap + seam crossfade in C; we just hand it state.
    const outL = outputs[0]!;
    const outR = outputs[1] ?? outputs[0]!;
    const res = this.wasm.pull(outL, outR, numFrames, {
      position: this.position,
      ratio: resampleRatio,
      loopEnabled: this.loopEnabled,
      loopStart: this.loopStart,
      loopEnd: this.loopEnd,
      seamFade: DeckPlayback.SEAM_FADE,
    });
    this.position = res.newPosition;
    // Fan a mono-as-stereo output to any further channels (rare; ≤2 here).
    for (let c = 2; c < outputs.length; c++) {
      outputs[c]!.set(outL.subarray(0, numFrames));
    }
    return res.produced;
  }

  /**
   * Produce `numFrames` of output into planar `outputs`, playing at `speed` (the
   * tempo scalar from RateControl; sign = direction). When stopped writes
   * silence. Returns true while still playing.
   */
  process(
    outputs: Float32Array[],
    numFrames: number,
    speed: number,
    playing: boolean,
  ): boolean {
    const track = this.track;
    const outChannels = outputs.length;

    if (!track || !playing || speed === 0) {
      for (let c = 0; c < outChannels; c++) {
        outputs[c]!.fill(0, 0, numFrames);
      }
      return track !== null && this.position < track.frames;
    }

    // Stem deck: sum the 4 stems (each through its own resampler, same position +
    // speed) with per-stem gain. The mashup engine. (Keylock for stems is a future
    // refinement; stems use the linear varispeed path, which is correct for mixing.)
    if (this.stemResamplers.length > 0) {
      return this.processStems(outputs, numFrames, speed, track);
    }

    // Keylock requires a forward, non-scratch speed; otherwise fall back to the
    // linear path (which alone can ramp through zero / go reverse — Mixxx does the
    // same: scratching/reverse always use the linear scaler).
    const useKeylock =
      this.keylock && this.keylockScaler !== null && speed > 0.1 && speed < 1.9;

    if (useKeylock) {
      const scaler = this.keylockScaler!;
      scaler.setRatios(speed, 1); // tempo = speed, pitch held
      // The scaler reads source through its OWN cursor (scalerCursor) so its internal
      // buffering/latency stays self-consistent and glitch-free. The pull advances
      // that cursor, NOT the authoritative playback position.
      const pull: SourcePull = (chans, n) => {
        const saved = this.position;
        this.position = this.scalerCursor;
        const produced = this.pullResampled(chans, n, this.baseRate);
        this.scalerCursor = this.position;
        this.position = saved;
        return produced;
      };
      const flowing = scaler.process(outputs, numFrames, pull);
      // CRITICAL for beat sync (Mixxx enginebufferscalest.cpp: readFramesProcessed +=
      // effectiveRate * frames): advance the authoritative position by the EXACT
      // commanded amount (speed × numFrames), NOT by the scaler's chunky/buffered
      // source consumption. SoundTouch pulls source in blocks with internal latency,
      // so a consumption-based position drifts ~2% off the true rate and jitters by a
      // pull-block — which made two keylocked decks drift out of beat lock. The exact
      // advance keeps position truthful for grid/sync/waveform/cue/loop.
      let next = this.position + speed * numFrames;
      // Wrap the authoritative position inside an active loop (the scaler's cursor
      // wraps independently via pullResampled's loop handling).
      if (this.loopEnabled && this.loopEnd > this.loopStart && next >= this.loopEnd) {
        const len = this.loopEnd - this.loopStart;
        next = this.loopStart + ((next - this.loopStart) % len);
      }
      this.position = Math.min(track.frames, next);
      // An active loop never "ends" at the track tail.
      return flowing && (this.loopEnabled || this.position < track.frames);
    }

    // Linear varispeed path.
    const produced = this.pullResampled(outputs, numFrames, this.baseRate * speed);
    // Zero the tail if we ran off the end.
    for (let c = 0; c < outChannels; c++) {
      outputs[c]!.fill(0, produced, numFrames);
    }
    return produced === numFrames && (this.loopEnabled || this.position < track.frames);
  }

  /**
   * Stem-deck mix: pull each stem from the SAME start position + ratio (they're
   * frame-aligned), sum with per-stem gain into the stereo output, then advance the
   * shared position once. Linear varispeed (sync/scratch/loops all work via the
   * shared position). This is what makes live mashups possible — mute a deck's
   * vocals, solo another's, etc.
   */
  private processStems(
    outputs: Float32Array[],
    numFrames: number,
    speed: number,
    track: DeckTrack,
  ): boolean {
    const outL = outputs[0]!;
    const outR = outputs[1] ?? outputs[0]!;
    outL.fill(0, 0, numFrames);
    outR.fill(0, 0, numFrames);

    // Lazily (re)size the scratch buffers — never allocate in the steady state.
    if (!this.stemScratchL || this.stemScratchL.length < numFrames) {
      this.stemScratchL = new Float32Array(numFrames);
      this.stemScratchR = new Float32Array(numFrames);
    }
    const sL = this.stemScratchL;
    const sR = this.stemScratchR!;

    const ratio = this.baseRate * speed;
    const startPos = this.position;
    let produced = 0;
    let endPos = startPos;

    for (let i = 0; i < this.stemResamplers.length; i++) {
      const gain = this.stemGains[i] ?? 0;
      const res = this.stemResamplers[i]!.pull(sL, sR, numFrames, {
        position: startPos, // every stem reads from the same spot
        ratio,
        loopEnabled: this.loopEnabled,
        loopStart: this.loopStart,
        loopEnd: this.loopEnd,
        seamFade: DeckPlayback.SEAM_FADE,
      });
      produced = res.produced; // identical across stems (same source length/ratio)
      endPos = res.newPosition;
      if (gain === 0) continue; // muted stem contributes nothing
      for (let f = 0; f < produced; f++) {
        outL[f]! += sL[f]! * gain;
        outR[f]! += sR[f]! * gain;
      }
    }
    this.position = endPos;
    return produced === numFrames && (this.loopEnabled || this.position < track.frames);
  }
}
