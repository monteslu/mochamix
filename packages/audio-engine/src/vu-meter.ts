/**
 * VuMeter — per-channel level metering (Mixxx EngineVuMeter analog,
 * 04-audio-engine.md §7). Mean-of-abs with fast-attack / slow-decay smoothing and
 * a peak-hold clip flag. Publishing is RATE-LIMITED by the caller (~30Hz) so it
 * doesn't flood the SAB/UI; this just accumulates and smooths.
 *
 * Pure (no SAB) → unit-testable. One instance per metered channel.
 */

const ATTACK = 0.85; // toward the new (louder) value fast
const DECAY = 0.12; // fall slowly

export class VuMeter {
  private level = 0;
  private peakHold = 0;
  private clip = false;

  /** Feed a block of samples (one channel). Accumulates into the smoothed level. */
  process(samples: Float32Array, numFrames: number): void {
    let sum = 0;
    let blockPeak = 0;
    for (let i = 0; i < numFrames; i++) {
      const a = Math.abs(samples[i]!);
      sum += a;
      if (a > blockPeak) {
        blockPeak = a;
      }
    }
    const mean = numFrames > 0 ? sum / numFrames : 0;
    // Asymmetric smoothing.
    const coeff = mean > this.level ? ATTACK : DECAY;
    this.level += (mean - this.level) * coeff;
    if (blockPeak > this.peakHold) {
      this.peakHold = blockPeak;
    }
    if (blockPeak >= 1.0) {
      this.clip = true;
    }
  }

  /** Current smoothed level (0..1+). */
  getLevel(): number {
    return this.level;
  }

  /** Peak since last reset. */
  getPeak(): number {
    return this.peakHold;
  }

  /** Whether a clip occurred since last reset. */
  isClipped(): boolean {
    return this.clip;
  }

  /** Reset the peak-hold + clip flag (call after publishing/peak-hold timeout). */
  resetPeak(): void {
    this.peakHold = 0;
    this.clip = false;
  }
}
