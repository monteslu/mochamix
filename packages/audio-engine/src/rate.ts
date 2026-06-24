/**
 * Rate / speed calculation — the M1 slice of Mixxx's RateControl::calculateSpeed
 * (04-audio-engine.md §5). Folds the rate-slider inputs into a single speed
 * scalar. Grows later to include jog/scratch/vinyl/sync/reverse.
 *
 * Pure functions so they unit-test and can run in the worklet.
 */

/**
 * Compute the tempo ratio from the rate slider.
 *   rate      ∈ [-1, 1]   (the slider position)
 *   rateRange ∈ (0, 1]    (e.g. 0.10 == ±10%)
 *   rateDir   ∈ {+1, -1}  (which slider direction speeds up)
 * Result: 1.0 == original tempo. e.g. rate=1, range=0.10, dir=+1 → 1.10.
 */
export function rateRatioFromSlider(rate: number, rateRange: number, rateDir: number): number {
  return 1 + rate * rateRange * rateDir;
}

/**
 * The final playback speed. For M1 this is just the slider ratio (varispeed:
 * speed changes pitch). Keylock in M2 will split this into independent tempo and
 * pitch ratios fed to the time-stretch scaler; the linear path keeps using this
 * combined speed for scratch/reverse.
 */
export function calculateSpeed(rate: number, rateRange: number, rateDir: number): number {
  return rateRatioFromSlider(rate, rateRange, rateDir);
}
