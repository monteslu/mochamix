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
 * The phase snap as ONE pure function: given both decks' grids + exact positions,
 * return the follower's target frame so its beat lands on the leader's. Used by the
 * worklet (with sample-accurate positions) AND the tests. Returns the follower's
 * position unchanged if a grid is missing.
 */
export function computeSnapTarget(
  leaderGrid: Grid | null,
  leaderFrame: number,
  followerGrid: Grid | null,
  followerFrame: number,
): number {
  if (!leaderGrid || !followerGrid) return followerFrame;
  let target = alignedFrame(followerGrid, followerFrame, beatDistance(leaderGrid, leaderFrame));
  // The grid is periodic, so any beat ± N beats is an equally valid phase match.
  // If the nearest match landed BEFORE the track start (common when a deck sits at
  // frame 0, before its firstBeatFrame), step forward whole beats until it's ≥ 0 —
  // never seek to a negative/invalid position (that's what made the deck "shake").
  const fpb = followerGrid.framesPerBeat;
  while (target < 0) target += fpb;
  return target;
}

/**
 * Phase-align: seek the follower so its beat fraction matches the leader's
 * `targetPhase` (0..1). PORTED FROM MIXXX (bpmcontrol.cpp getNearestPositionInPhase):
 * anchor to a concrete beat boundary chosen by whether THIS and the OTHER deck are
 * each in the first/second half of their beat (handles pressing sync late/early),
 * then add targetPhase × beatLength. This is the snap: a hard jump onto the leader's
 * exact beat, moving ≤ ~1 beat.
 */
export function alignedFrame(
  followerGrid: Grid,
  followerFrame: number,
  targetPhase: number,
): number {
  const fpb = followerGrid.framesPerBeat;
  const idx = beatIndexAt(followerGrid, followerFrame);
  const prevBeat = frameOfBeat(followerGrid, Math.floor(idx));
  const nextBeat = frameOfBeat(followerGrid, Math.floor(idx) + 1);

  // Mixxx: which half of the beat is each deck in?
  const thisNearNextBeat = nextBeat - followerFrame <= followerFrame - prevBeat;
  const otherNearNextBeat = targetPhase >= 0.5;

  let anchor: number;
  if (thisNearNextBeat === otherNearNextBeat) {
    anchor = prevBeat;
  } else if (thisNearNextBeat && !otherNearNextBeat) {
    anchor = nextBeat; // pushed sync late
  } else {
    anchor = frameOfBeat(followerGrid, Math.floor(idx) - 1); // pushed sync early
  }
  return anchor + targetPhase * fpb;
}
