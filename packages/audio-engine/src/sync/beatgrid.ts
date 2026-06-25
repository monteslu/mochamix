/**
 * Beat-grid math (pure, testable). A grid is defined by the first-beat frame +
 * frames-per-beat (derived from BPM × sampleRate). Used for phase-lock on sync,
 * quantize (snapping cue/loop/play drops to the grid), and publishing each deck's
 * live beat distance. No audio, no bus — just numbers.
 */

export interface Grid {
  firstBeatFrame: number;
  framesPerBeat: number;
}

export function framesPerBeat(bpm: number, sampleRate: number): number {
  return bpm > 0 ? (60 / bpm) * sampleRate : 0;
}

/** Build a grid from bpm + first beat. Returns null if bpm invalid. */
export function makeGrid(bpm: number, firstBeatFrame: number, sampleRate: number): Grid | null {
  const fpb = framesPerBeat(bpm, sampleRate);
  if (fpb <= 0) return null;
  return { firstBeatFrame: Math.max(0, firstBeatFrame), framesPerBeat: fpb };
}

/** Beat index (can be fractional) at a frame. */
export function beatIndexAt(grid: Grid, frame: number): number {
  return (frame - grid.firstBeatFrame) / grid.framesPerBeat;
}

/** Frame of an (integer or fractional) beat index. */
export function frameOfBeat(grid: Grid, beat: number): number {
  return grid.firstBeatFrame + beat * grid.framesPerBeat;
}

/**
 * Beat distance 0..1: fractional position between the previous beat (0) and the
 * next beat (→1). This is the phase used to match two decks.
 */
export function beatDistance(grid: Grid, frame: number): number {
  const idx = beatIndexAt(grid, frame);
  const frac = idx - Math.floor(idx);
  return ((frac % 1) + 1) % 1;
}

/** Nearest beat frame to `frame` (for quantize). */
export function nearestBeatFrame(grid: Grid, frame: number): number {
  const idx = Math.round(beatIndexAt(grid, frame));
  return frameOfBeat(grid, idx);
}

/**
 * Phase-align: given a follower at `followerFrame` on its grid, return the frame
 * the follower should seek to so its beat phase matches the leader's `targetPhase`
 * (0..1), moving the SMALLEST distance (≤ half a beat either way). Keeps the
 * follower near where it already is — we shift by at most ±½ beat, never jump bars.
 */
export function alignedFrame(
  followerGrid: Grid,
  followerFrame: number,
  targetPhase: number,
): number {
  const fpb = followerGrid.framesPerBeat;
  const curPhase = beatDistance(followerGrid, followerFrame);
  let delta = targetPhase - curPhase; // in beats (fraction)
  // shortest direction
  if (delta > 0.5) delta -= 1;
  else if (delta < -0.5) delta += 1;
  return followerFrame + delta * fpb;
}
