import { describe, it, expect } from 'vitest';
import {
  makeGrid,
  framesPerBeat,
  beatDistance,
  nearestBeatFrame,
  alignedFrame,
  beatIndexAt,
} from './beatgrid.js';

const SR = 48000;

describe('beatgrid', () => {
  it('framesPerBeat: 120 BPM @48k = 24000', () => {
    expect(framesPerBeat(120, SR)).toBe(24000);
    expect(framesPerBeat(0, SR)).toBe(0);
  });

  it('beatDistance is 0 exactly on a beat', () => {
    const g = makeGrid(120, 0, SR)!;
    expect(beatDistance(g, 0)).toBeCloseTo(0);
    expect(beatDistance(g, 24000)).toBeCloseTo(0);
    expect(beatDistance(g, 48000)).toBeCloseTo(0);
  });

  it('beatDistance is 0.5 halfway between beats', () => {
    const g = makeGrid(120, 0, SR)!;
    expect(beatDistance(g, 12000)).toBeCloseTo(0.5);
    expect(beatDistance(g, 36000)).toBeCloseTo(0.5);
  });

  it('respects firstBeatFrame phase offset', () => {
    const g = makeGrid(120, 1000, SR)!;
    expect(beatDistance(g, 1000)).toBeCloseTo(0);
    expect(beatDistance(g, 1000 + 12000)).toBeCloseTo(0.5);
  });

  it('nearestBeatFrame snaps to the closest beat', () => {
    const g = makeGrid(120, 0, SR)!;
    expect(nearestBeatFrame(g, 1000)).toBe(0); // closer to beat 0
    expect(nearestBeatFrame(g, 13000)).toBe(24000); // closer to beat 1
    expect(nearestBeatFrame(g, 24000)).toBe(24000);
  });

  it('alignedFrame moves follower to match leader phase, shortest path', () => {
    const g = makeGrid(120, 0, SR)!;
    // follower at phase 0.1, target leader phase 0.0 → should move back 0.1 beat
    const f = 0.1 * 24000; // frame at phase 0.1
    const aligned = alignedFrame(g, f, 0.0);
    expect(beatDistance(g, aligned)).toBeCloseTo(0, 5);
    // and it moved the short way (backwards), staying within the same beat region
    expect(Math.abs(aligned - f)).toBeLessThanOrEqual(0.5 * 24000 + 1);
  });

  it('alignedFrame wraps the short way across the beat boundary', () => {
    const g = makeGrid(120, 0, SR)!;
    // follower at phase 0.9, target 0.0 → shortest is FORWARD 0.1, not back 0.9
    const f = 0.9 * 24000;
    const aligned = alignedFrame(g, f, 0.0);
    expect(beatDistance(g, aligned)).toBeCloseTo(0, 5);
    expect(aligned).toBeGreaterThan(f); // moved forward
    expect(aligned - f).toBeCloseTo(0.1 * 24000, 1);
  });

  it('two decks at different BPM align to the same phase', () => {
    const leader = makeGrid(128, 5000, SR)!;
    const follower = makeGrid(120, 9000, SR)!;
    const leaderFrame = 100000;
    const targetPhase = beatDistance(leader, leaderFrame);
    const followerFrame = 80000;
    const aligned = alignedFrame(follower, followerFrame, targetPhase);
    expect(beatDistance(follower, aligned)).toBeCloseTo(targetPhase, 5);
  });

  it('beatIndexAt is monotonic and integer on beats', () => {
    const g = makeGrid(100, 500, SR)!;
    expect(beatIndexAt(g, 500)).toBeCloseTo(0);
    expect(beatIndexAt(g, 500 + framesPerBeat(100, SR))).toBeCloseTo(1);
  });
});
