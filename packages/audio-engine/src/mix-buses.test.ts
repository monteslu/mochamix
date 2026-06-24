import { describe, it, expect } from 'vitest';
import { headMixGains } from './mix-buses.js';

describe('headMixGains (headphone main↔PFL crossfade)', () => {
  it('full main (-1): all main, no pfl', () => {
    const g = headMixGains(-1);
    expect(g.main).toBeCloseTo(1, 5);
    expect(g.pfl).toBeCloseTo(0, 5);
  });

  it('full PFL (+1): all pfl, no main', () => {
    const g = headMixGains(1);
    expect(g.main).toBeCloseTo(0, 5);
    expect(g.pfl).toBeCloseTo(1, 5);
  });

  it('center (0): equal power (both ~0.707)', () => {
    const g = headMixGains(0);
    expect(g.main).toBeCloseTo(Math.SQRT1_2, 5);
    expect(g.pfl).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it('is equal-power: main^2 + pfl^2 == 1 across the range', () => {
    for (const mix of [-1, -0.5, 0, 0.3, 0.8, 1]) {
      const g = headMixGains(mix);
      expect(g.main * g.main + g.pfl * g.pfl).toBeCloseTo(1, 5);
    }
  });

  it('clamps out-of-range input', () => {
    expect(headMixGains(-2).main).toBeCloseTo(1, 5);
    expect(headMixGains(2).pfl).toBeCloseTo(1, 5);
  });
});
