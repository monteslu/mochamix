/**
 * Harmonic-mixing / Camelot math, ported from Mixxx's KeyUtils (src/track/keyutils.cpp,
 * GPL). Works on the numeric key index 1..24 (Mixxx ChromaticKey order: 1-12 = major
 * C..B, 13-24 = minor C..B; 0 = unknown) that our qm-dsp analysis produces.
 *
 * The headline function is shortestStepsToCompatibleKey(): given THIS track's key and a
 * TARGET key, it returns the SMALLEST pitch shift (in semitones) that makes the two
 * harmonically compatible — i.e. the "match key" / smart-fade-for-keys operation. Mixxx's
 * insight (preserved here): match to the relative major/minor first (same notes, 0 shift)
 * and otherwise nudge by a perfect 4th/5th, never the full ±6, so it never chipmunks.
 */

/** 1-12 = major, 13-24 = minor. 0/invalid = not a key. */
export type KeyNum = number;

export function isValidKey(k: KeyNum): boolean {
  return Number.isInteger(k) && k >= 1 && k <= 24;
}

export function keyIsMajor(k: KeyNum): boolean {
  return k >= 1 && k <= 12;
}

/** Tonic pitch class 0..11 (C=0..B=11), ignoring major/minor. */
export function keyToTonic(k: KeyNum): number {
  return (k - 1) % 12;
}

/** Build a key index from a tonic (0..11) + mode. */
function fromTonic(tonic: number, major: boolean): KeyNum {
  const t = ((tonic % 12) + 12) % 12;
  return major ? t + 1 : t + 13;
}

/**
 * Camelot wheel NUMBER (1..12) by tonic pitch class (C=0..B=11). Standard mapping:
 * C major = 8B, A minor = 8A, going round the circle of fifths. This is the canonical
 * DJ Camelot numbering (Mixxx's "Lancelot" number).
 */
const TONIC_TO_CAMELOT = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]; // index = tonic 0..11
function camelotToTonic(cam: number): number {
  const idx = TONIC_TO_CAMELOT.indexOf(cam);
  return idx < 0 ? 0 : idx;
}

/**
 * Camelot ring position 1..12 for a key (the number you see, e.g. the "8" in 8B/8A).
 * A minor key shares the Camelot number of its RELATIVE MAJOR (3 semitones up), so e.g.
 * A minor and C major are both 8. So the ring number is keyed off the relative-major
 * tonic for minor keys, the tonic itself for major.
 */
export function keyToOpenKeyNumber(k: KeyNum): number {
  const tonic = keyIsMajor(k) ? keyToTonic(k) : (keyToTonic(k) + 3) % 12;
  return TONIC_TO_CAMELOT[tonic]!;
}
export function openKeyNumberToKey(camNumber: number, major: boolean): KeyNum {
  const relMajorTonic = camelotToTonic(camNumber);
  // For a minor key the actual tonic is 3 semitones BELOW its relative major.
  const tonic = major ? relMajorTonic : (relMajorTonic + 9) % 12;
  return fromTonic(tonic, major);
}

/** Camelot wheel code, e.g. "8A" (minor) / "8B" (major). */
export function keyToCamelot(k: KeyNum): string {
  if (!isValidKey(k)) return '';
  return `${keyToOpenKeyNumber(k)}${keyIsMajor(k) ? 'B' : 'A'}`;
}

/** Parse a Camelot code like "8A"/"8B" back to a key index 1..24, or 0 if unparseable. */
export function camelotToKey(camelot: string): KeyNum {
  const m = /^(\d{1,2})\s*([ABab])$/.exec(camelot.trim());
  if (!m) return 0;
  const cam = parseInt(m[1]!, 10);
  const major = m[2]!.toUpperCase() === 'B';
  if (cam < 1 || cam > 12) return 0;
  return openKeyNumberToKey(cam, major);
}

/** Signed shortest distance (-6..+6 semitones) from key to target_key (Mixxx). */
export function shortestStepsToKey(key: KeyNum, targetKey: KeyNum): number {
  if (!isValidKey(key) || !isValidKey(targetKey)) return 0;
  let steps = keyToTonic(targetKey) - keyToTonic(key);
  if (steps > 6) steps -= 12;
  else if (steps < -6) steps += 12;
  return steps;
}

/**
 * Smallest pitch shift (semitones) to make `key` harmonically compatible with
 * `targetKey`. Ported verbatim from Mixxx KeyUtils::shortestStepsToCompatibleKey.
 * Returns 0 if either key is unknown or they're already compatible.
 */
export function shortestStepsToCompatibleKey(key: KeyNum, targetKey: KeyNum): number {
  if (!isValidKey(key) || !isValidKey(targetKey) || key === targetKey) return 0;

  const major = keyIsMajor(key);
  const targetMajor = keyIsMajor(targetKey);

  // Mode mismatch → match to the relative (shares the same notes), so the shift stays
  // small instead of up to ±6 semitones (which would chipmunk).
  let tk = targetKey;
  if (major !== targetMajor) {
    const okNumber = keyToOpenKeyNumber(targetKey);
    tk = openKeyNumberToKey(okNumber, !targetMajor);
  }

  // Both keys are now the same mode. The compatible key is ±5 or 0 semitones away:
  //   0 (±12) tonic match · +5 perfect 4th (sub-dominant) · -5 perfect 5th (dominant)
  const shortestDistance = shortestStepsToKey(key, tk); // -6..+6
  if (shortestDistance < -2) return 5 + shortestDistance; // perfect 4th
  if (shortestDistance > 2) return -5 + shortestDistance; // perfect 5th
  return shortestDistance; // tonic match (-2..+2)
}

/** Transpose a key index by N semitones (preserving mode). */
export function transposeKey(k: KeyNum, semitones: number): KeyNum {
  if (!isValidKey(k)) return 0;
  return fromTonic(keyToTonic(k) + semitones, keyIsMajor(k));
}

/**
 * Are two keys harmonically compatible for mixing? Uses the standard Camelot rules:
 *  - SAME mode: same number or ±1 around the wheel (e.g. 8A↔8A, 8A↔7A/9A).
 *  - CROSS mode (relative): same number (8A↔8B), and the ±1 diagonals that Mixxx's
 *    key-match treats as compatible (a major mixes with the minor whose relative-major
 *    is adjacent — the energy-boost/drop moves). This matches the set that
 *    shortestStepsToCompatibleKey() targets, so a matched key always reads compatible.
 */
export function areKeysCompatible(a: KeyNum, b: KeyNum): boolean {
  if (!isValidKey(a) || !isValidKey(b)) return false;
  if (a === b) return true;
  const okA = keyToOpenKeyNumber(a);
  const okB = keyToOpenKeyNumber(b);
  const ringDist = Math.min((okA - okB + 12) % 12, (okB - okA + 12) % 12);
  const sameMode = keyIsMajor(a) === keyIsMajor(b);
  if (sameMode) return ringDist <= 1; // same or adjacent number, same mode
  return ringDist <= 1; // cross-mode: same number (relative) or ±1 diagonal
}
