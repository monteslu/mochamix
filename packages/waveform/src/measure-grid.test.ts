import { describe, it, expect } from 'vitest';

/**
 * Locks the measure-marker math used in render-canvas2d's downbeat pass: measures are
 * EVERY 4 beats, on the grid, with the bar PHASE taken from the analyzer's first downbeat.
 * Regression: drawing/snapping each raw downbeat independently produced 3- or 5-beat
 * "measures" (adjacent markers rounding to non-4-apart beats). This verifies uniform
 * 4-beat spacing on the grid regardless of where the analyzer's downbeats fell.
 */

/** Mirror of the render formula: beat indices (from firstBeatFrame) of the measure marks
 *  visible in [leftBeat, rightBeat], given the analyzer downbeat frames. */
function measureBeatIndices(
  downbeatFrames: number[],
  firstBeatFrame: number,
  framesPerBeat: number,
  leftBeat: number,
  rightBeat: number,
): number[] {
  const first = firstBeatFrame;
  const fpb = framesPerBeat;
  const phase = ((Math.round((downbeatFrames[0]! - first) / fpb) % 4) + 4) % 4;
  const out: number[] = [];
  let n = phase + Math.ceil((leftBeat - phase) / 4) * 4;
  for (; n <= rightBeat; n += 4) out.push(n);
  return out;
}

describe('measure marker grid', () => {
  const fpb = 24000; // 120bpm @ 48k

  it('measures are exactly 4 beats apart (no 3- or 5-beat bars)', () => {
    // analyzer downbeats drifted off-grid + irregular spacing (the bug input)
    const downbeats = [200, 24300, 47900, 96050]; // ~ every 4 beats but noisy/off-grid
    const marks = measureBeatIndices(downbeats, 0, fpb, 0, 40);
    for (let i = 1; i < marks.length; i++) {
      expect(marks[i]! - marks[i - 1]!).toBe(4); // strictly 4 beats
    }
  });

  it('all measure marks are whole beats on the grid', () => {
    const marks = measureBeatIndices([5000], 1000, fpb, 0, 32);
    for (const n of marks) expect(Number.isInteger(n)).toBe(true);
  });

  it('respects the bar phase (which beat is the "1")', () => {
    // first downbeat at beat 2 → measures land on 2, 6, 10, ...
    const downbeats = [2 * fpb];
    const marks = measureBeatIndices(downbeats, 0, fpb, 0, 12);
    expect(marks).toEqual([2, 6, 10]);
  });

  it('phase 0 → measures on 0,4,8,...', () => {
    const marks = measureBeatIndices([0], 0, fpb, 0, 12);
    expect(marks).toEqual([0, 4, 8, 12]);
  });
});
