/**
 * Crossfader gain calculation — the Mixxx EngineXfader::getXfadeGains analog
 * (04-audio-engine.md §2 step 5). Maps the crossfader position + curve into
 * per-side gains, respecting each channel's orientation (left/center/right).
 *
 * position ∈ [-1, 1]  (-1 = full left deck, +1 = full right deck)
 * curve    ∈ ~[0.5, large]  (0.5..~0.7 = smooth constant-power mixing; larger =
 *           sharper "scratch" cut). We model it as a power applied to the
 *           normalized side gain.
 */

export type Orientation = 'left' | 'center' | 'right';

/** Map the Mixxx orientation control value (0/1/2) to a name. */
export function orientationFromValue(v: number): Orientation {
  return v <= 0 ? 'left' : v >= 2 ? 'right' : 'center';
}

/**
 * Constant-power-ish crossfader. Returns { left, right } gains in 0..1.
 * At center both are ~1 (full) for a smooth mix; toward an end the opposite side
 * falls to 0. `curve` sharpens the transition (higher = faster cut).
 */
export function getXfadeGains(
  position: number,
  curve: number,
  reverse: boolean,
): { left: number; right: number } {
  let pos = Math.max(-1, Math.min(1, position));
  if (reverse) {
    pos = -pos;
  }
  // Normalize to 0..1 (0 = full left, 1 = full right).
  const t = (pos + 1) / 2;
  const power = Math.max(0.5, curve) * 2; // curve 0.5 → power 1 (linear-ish); higher → sharper
  // Equal-power curve with adjustable sharpness.
  const right = Math.pow(Math.sin((t * Math.PI) / 2), power);
  const left = Math.pow(Math.cos((t * Math.PI) / 2), power);
  return { left, right };
}

/**
 * The crossfader gain to apply to a given channel based on its orientation.
 * Center channels are unaffected (always 1).
 */
export function crossfaderGainForChannel(
  orientation: Orientation,
  position: number,
  curve: number,
  reverse: boolean,
): number {
  if (orientation === 'center') {
    return 1;
  }
  const { left, right } = getXfadeGains(position, curve, reverse);
  return orientation === 'left' ? left : right;
}
