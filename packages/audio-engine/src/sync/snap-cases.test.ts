import { describe, it, expect } from 'vitest';
import { makeGrid, beatDistance, alignedFrame } from './beatgrid.js';

const SR = 48000;

// Mixxx's getNearestPositionInPhase handles pressing SYNC at any point in the beat
// (late = near next beat, early = near prev beat). After the snap, the follower's
// beat fraction must EXACTLY equal the leader's, jumping at most ~1 beat — no matter
// where in its own beat the follower was.
describe('snap lands on the leader beat from any push timing', () => {
  const fg = makeGrid(120, 0, SR)!;
  const fpb = fg.framesPerBeat;

  for (const leaderPhase of [0.0, 0.1, 0.25, 0.49, 0.5, 0.51, 0.75, 0.9, 0.99]) {
    for (const followerStartPhase of [0.02, 0.3, 0.48, 0.52, 0.7, 0.97]) {
      it(`leader@${leaderPhase} follower@${followerStartPhase} → on leader's beat`, () => {
        const followerFrame = fpb * 10 + followerStartPhase * fpb;
        const target = alignedFrame(fg, followerFrame, leaderPhase);
        // follower's beat fraction now equals the leader's
        const err = Math.abs(beatDistance(fg, target) - leaderPhase);
        expect(Math.min(err, 1 - err)).toBeLessThan(0.001);
        // moved no more than ~1 beat (a clean snap, not a wild jump)
        expect(Math.abs(target - followerFrame)).toBeLessThanOrEqual(fpb * 1.0 + 1);
      });
    }
  }
});
