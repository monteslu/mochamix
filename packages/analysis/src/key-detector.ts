/**
 * Musical key detection — a chromagram + Krumhansl-Schmuckler key-profile
 * correlation (the standard approach, same family as Mixxx's key analyzers).
 * Builds a 12-bin pitch-class energy histogram via a Goertzel filter bank across
 * octaves, then correlates against the 24 major/minor key profiles; the best
 * match is the key. Returns Camelot + musical notation for harmonic mixing.
 *
 * Self-contained JS (no external WASM). Not bit-identical to libKeyFinder/qm-dsp
 * but produces a sensible key for harmonic-mixing display + search. Runs in the
 * analysis Worker alongside beat detection.
 */

const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Camelot wheel: index = pitch class (0=C..11=B). [major, minor] codes.
const CAMELOT_MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const CAMELOT_MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];

// Krumhansl-Schmuckler major/minor profiles.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export interface KeyResult {
  /** 0..11 pitch class of the tonic. */
  pitchClass: number;
  major: boolean;
  /** e.g. "Am", "C", "F#m". */
  name: string;
  /** Camelot code, e.g. "8A". */
  camelot: string;
  /** Correlation strength (confidence proxy). */
  confidence: number;
}

/** Frequency of a pitch class in a given octave (A4=440). */
function pitchFreq(pc: number, octave: number): number {
  // MIDI note for pitch class pc in octave (C-1 = MIDI 0). C4 = MIDI 60.
  const midi = (octave + 1) * 12 + pc;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Goertzel power of a frequency over a sample block. */
function goertzel(samples: Float32Array, start: number, len: number, freq: number, sr: number): number {
  const k = (freq / sr) * len;
  const w = (2 * Math.PI * k) / len;
  const cosw = Math.cos(w);
  const coeff = 2 * cosw;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  const end = Math.min(start + len, samples.length);
  for (let i = start; i < end; i++) {
    s0 = samples[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/** Build a 12-bin chromagram by summing Goertzel power across octaves + blocks. */
function chromagram(mono: Float32Array, sampleRate: number): number[] {
  const chroma = new Array<number>(12).fill(0);
  const blockLen = 8192;
  const hop = blockLen * 2;
  // Octaves 2..6 cover the musically-relevant range.
  for (let block = 0; block + blockLen < mono.length; block += hop) {
    for (let pc = 0; pc < 12; pc++) {
      let energy = 0;
      for (let oct = 2; oct <= 6; oct++) {
        energy += goertzel(mono, block, blockLen, pitchFreq(pc, oct), sampleRate);
      }
      chroma[pc]! += energy;
    }
  }
  // normalize
  const max = Math.max(...chroma, 1e-9);
  for (let i = 0; i < 12; i++) chroma[i]! /= max;
  return chroma;
}

/** Pearson correlation of a rotated profile against the chroma. */
function correlate(chroma: number[], profile: number[], rotation: number): number {
  let sumCP = 0;
  let sumC = 0;
  let sumP = 0;
  let sumC2 = 0;
  let sumP2 = 0;
  for (let i = 0; i < 12; i++) {
    const c = chroma[i]!;
    const p = profile[(i - rotation + 12) % 12]!;
    sumCP += c * p;
    sumC += c;
    sumP += p;
    sumC2 += c * c;
    sumP2 += p * p;
  }
  const n = 12;
  const num = n * sumCP - sumC * sumP;
  const den = Math.sqrt((n * sumC2 - sumC * sumC) * (n * sumP2 - sumP * sumP));
  return den === 0 ? 0 : num / den;
}

export function detectKey(channels: Float32Array[], frames: number, sampleRate: number): KeyResult {
  // mono downmix
  const n = channels.length;
  let mono: Float32Array;
  if (n === 1) {
    mono = channels[0]!.subarray(0, frames);
  } else {
    mono = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let s = 0;
      for (let c = 0; c < n; c++) s += channels[c]![i]!;
      mono[i] = s / n;
    }
  }

  const chroma = chromagram(mono, sampleRate);

  let best = { pc: 0, major: true, corr: -2 };
  for (let pc = 0; pc < 12; pc++) {
    const cMaj = correlate(chroma, MAJOR_PROFILE, pc);
    if (cMaj > best.corr) best = { pc, major: true, corr: cMaj };
    const cMin = correlate(chroma, MINOR_PROFILE, pc);
    if (cMin > best.corr) best = { pc, major: false, corr: cMin };
  }

  const name = PITCH_NAMES[best.pc]! + (best.major ? '' : 'm');
  const camelot = best.major ? CAMELOT_MAJOR[best.pc]! : CAMELOT_MINOR[best.pc]!;
  return {
    pitchClass: best.pc,
    major: best.major,
    name,
    camelot,
    confidence: Math.max(0, best.corr),
  };
}
