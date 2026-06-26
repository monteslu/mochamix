import { describe, it, expect } from 'vitest';
import {
  keyToCamelot,
  camelotToKey,
  shortestStepsToCompatibleKey,
  areKeysCompatible,
  transposeKey,
  keyIsMajor,
} from './camelot.js';

// Key index reference (Mixxx ChromaticKey): 1=C major .. 12=B major, 13=C minor .. 24=B minor.
const C_MAJ = 1;
const A_MIN = 22; // relative minor of C major → Camelot 8A
const G_MAJ = 8; // 9B
const A_MAJ = 10; // 11B
const E_MIN = 17; // 9A (relative minor of G major)

describe('camelot mapping', () => {
  it('maps known keys to their Camelot codes', () => {
    expect(keyToCamelot(C_MAJ)).toBe('8B'); // C major = 8B
    expect(keyToCamelot(A_MIN)).toBe('8A'); // A minor = 8A
    expect(keyToCamelot(G_MAJ)).toBe('9B'); // G major = 9B
    expect(keyToCamelot(E_MIN)).toBe('9A'); // E minor = 9A
  });

  it('round-trips Camelot string ↔ key index', () => {
    for (let k = 1; k <= 24; k++) {
      expect(camelotToKey(keyToCamelot(k))).toBe(k);
    }
  });

  it('parses lower-case + spaced Camelot', () => {
    expect(camelotToKey('8a')).toBe(A_MIN);
    expect(camelotToKey(' 8 B ')).toBe(C_MAJ);
    expect(camelotToKey('garbage')).toBe(0);
  });
});

describe('harmonic compatibility', () => {
  it('same key + relative major/minor + adjacent are compatible', () => {
    expect(areKeysCompatible(C_MAJ, C_MAJ)).toBe(true);
    expect(areKeysCompatible(C_MAJ, A_MIN)).toBe(true); // relative (8B ↔ 8A)
    expect(areKeysCompatible(C_MAJ, G_MAJ)).toBe(true); // adjacent (8B ↔ 9B)
  });

  it('distant keys are not compatible', () => {
    // C major (8B) vs A major (11B): 3 ring steps apart → not compatible
    expect(areKeysCompatible(C_MAJ, A_MAJ)).toBe(false);
  });
});

describe('shortestStepsToCompatibleKey', () => {
  it('is 0 when already compatible', () => {
    expect(shortestStepsToCompatibleKey(C_MAJ, C_MAJ)).toBe(0);
    expect(shortestStepsToCompatibleKey(C_MAJ, A_MIN)).toBe(0); // relative → 0 shift
    expect(shortestStepsToCompatibleKey(C_MAJ, G_MAJ)).toBe(0); // adjacent → 0 shift
  });

  it('never exceeds ±5 semitones (no chipmunk)', () => {
    for (let a = 1; a <= 24; a++) {
      for (let b = 1; b <= 24; b++) {
        const s = shortestStepsToCompatibleKey(a, b);
        expect(Math.abs(s)).toBeLessThanOrEqual(5);
      }
    }
  });

  it('the resulting shifted key IS compatible with the target', () => {
    for (let a = 1; a <= 24; a++) {
      for (let b = 1; b <= 24; b++) {
        const s = shortestStepsToCompatibleKey(a, b);
        const shifted = transposeKey(a, s);
        // mode is preserved by the shift
        expect(keyIsMajor(shifted)).toBe(keyIsMajor(a));
        expect(areKeysCompatible(shifted, b)).toBe(true);
      }
    }
  });

  it('returns 0 for unknown keys', () => {
    expect(shortestStepsToCompatibleKey(0, C_MAJ)).toBe(0);
    expect(shortestStepsToCompatibleKey(C_MAJ, 0)).toBe(0);
  });
});
