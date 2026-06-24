import { describe, it, expect } from 'vitest';
import { detectKey } from './key-detector.js';

/** Synthesize a chord (set of pitch classes) as summed sines over `seconds`. */
function chord(pitchClasses: number[], seconds: number, sr: number): Float32Array {
  const frames = Math.floor(seconds * sr);
  const a = new Float32Array(frames);
  // play each pitch class in octaves 3-5
  const freqs: number[] = [];
  for (const pc of pitchClasses) {
    for (let oct = 3; oct <= 5; oct++) {
      const midi = (oct + 1) * 12 + pc;
      freqs.push(440 * Math.pow(2, (midi - 69) / 12));
    }
  }
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (const f of freqs) s += Math.sin((2 * Math.PI * f * i) / sr);
    a[i] = (s / freqs.length) * 0.8;
  }
  return a;
}

describe('detectKey', () => {
  const sr = 44100;

  it('returns a valid Camelot code + name', () => {
    const a = chord([0, 4, 7], 3, sr); // C major triad
    const k = detectKey([a, a], a.length, sr);
    expect(k.camelot).toMatch(/^\d{1,2}[AB]$/);
    expect(k.name.length).toBeGreaterThan(0);
    expect(k.pitchClass).toBeGreaterThanOrEqual(0);
    expect(k.pitchClass).toBeLessThan(12);
  });

  it('detects a C major chord as C major (or its relative)', () => {
    const a = chord([0, 4, 7], 3, sr); // C E G
    const k = detectKey([a, a], a.length, sr);
    // tonic should be C (0) major, or the relative A minor (9) — both are
    // harmonically the same Camelot-wheel neighbors.
    const ok = (k.pitchClass === 0 && k.major) || (k.pitchClass === 9 && !k.major);
    expect(ok).toBe(true);
  });

  it('detects an A minor chord in the A-minor / C-major family', () => {
    const a = chord([9, 0, 4], 3, sr); // A C E
    const k = detectKey([a, a], a.length, sr);
    const ok = (k.pitchClass === 9 && !k.major) || (k.pitchClass === 0 && k.major);
    expect(ok).toBe(true);
  });

  it('different chords give different keys', () => {
    const c = chord([0, 4, 7], 3, sr);
    const fs = chord([6, 10, 1], 3, sr); // F# major
    const kc = detectKey([c, c], c.length, sr);
    const kfs = detectKey([fs, fs], fs.length, sr);
    expect(kc.camelot).not.toBe(kfs.camelot);
  });

  it('confidence is in range', () => {
    const a = chord([0, 4, 7], 2, sr);
    const k = detectKey([a, a], a.length, sr);
    expect(k.confidence).toBeGreaterThanOrEqual(0);
    expect(k.confidence).toBeLessThanOrEqual(1);
  });
});
