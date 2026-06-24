import { describe, it, expect } from 'vitest';
import { VuMeter } from './vu-meter.js';

describe('VuMeter', () => {
  it('rises toward a loud signal and reports a non-zero level', () => {
    const vu = new VuMeter();
    const loud = new Float32Array(128).fill(0.8);
    for (let k = 0; k < 5; k++) {
      vu.process(loud, 128);
    }
    expect(vu.getLevel()).toBeGreaterThan(0.3);
  });

  it('decays slowly after the signal stops', () => {
    const vu = new VuMeter();
    const loud = new Float32Array(128).fill(0.9);
    for (let k = 0; k < 10; k++) vu.process(loud, 128);
    const peak = vu.getLevel();
    const silence = new Float32Array(128);
    vu.process(silence, 128);
    const afterOne = vu.getLevel();
    // one silent block shouldn't drop it to zero (slow decay)
    expect(afterOne).toBeLessThan(peak);
    expect(afterOne).toBeGreaterThan(peak * 0.5);
  });

  it('attack is faster than decay', () => {
    const quiet = new VuMeter();
    const loud = new VuMeter();
    const sig = new Float32Array(128).fill(0.5);
    quiet.process(sig, 128); // one block up from 0
    const attackDelta = quiet.getLevel();

    // prime loud to 0.5-ish then feed silence once
    for (let k = 0; k < 20; k++) loud.process(sig, 128);
    const before = loud.getLevel();
    loud.process(new Float32Array(128), 128);
    const decayDelta = before - loud.getLevel();

    expect(attackDelta).toBeGreaterThan(decayDelta);
  });

  it('flags clipping at >= 1.0 and clears on resetPeak', () => {
    const vu = new VuMeter();
    const clipping = new Float32Array(128).fill(1.2);
    vu.process(clipping, 128);
    expect(vu.isClipped()).toBe(true);
    vu.resetPeak();
    expect(vu.isClipped()).toBe(false);
    expect(vu.getPeak()).toBe(0);
  });

  it('tracks block peak', () => {
    const vu = new VuMeter();
    const sig = new Float32Array(128).fill(0.1);
    sig[64] = 0.7;
    vu.process(sig, 128);
    expect(vu.getPeak()).toBeCloseTo(0.7);
  });
});
