import { describe, it, expect } from 'vitest';
import {
  computePeaks,
  computePeakSet,
  detailBucketsForDuration,
  OVERVIEW_BUCKETS,
  packStemWaveforms,
  unpackStemWaveforms,
} from './peaks.js';

describe('stem waveform pack/unpack', () => {
  it('round-trips 4 stem overview arrays + scale', () => {
    const peaks = [
      new Uint8Array([0, 64, 128, 255]),
      new Uint8Array([255, 128, 64, 0]),
      new Uint8Array([10, 20, 30, 40]),
      new Uint8Array([200, 150, 100, 50]),
    ];
    const blob = packStemWaveforms({ peaks, scale: 1.5 });
    const out = unpackStemWaveforms(blob);
    expect(out).not.toBeNull();
    expect(out!.peaks.length).toBe(4);
    for (let k = 0; k < 4; k++) expect([...out!.peaks[k]!]).toEqual([...peaks[k]!]);
    expect(out!.scale).toBeCloseTo(1.5, 2);
  });

  it('returns null on a too-short blob', () => {
    expect(unpackStemWaveforms(new Uint8Array(3))).toBeNull();
  });
});

describe('computePeaks', () => {
  it('reduces to max-abs buckets quantized to 0..255', () => {
    // 8 frames, mono; full-scale at frame 3 and -full-scale at frame 6
    const ch = new Float32Array([0, 0.25, 0.5, 1, 0.5, 0.25, -1, 0]);
    const peaks = computePeaks([ch], 8, 4); // 2 frames/bucket
    expect(peaks.length).toBe(4);
    // bucket0: max(|0|,|0.25|)=0.25 → 64; b1: max(0.5,1)=1 →255; b2: max(0.5,0.25)→128; b3: max(1,0)=1→255
    expect([...peaks.peaks]).toEqual([64, 255, 128, 255]);
    expect(peaks.framesPerBucket).toBe(2);
  });

  it('takes the max across channels', () => {
    const l = new Float32Array([0.1, 0.1]);
    const r = new Float32Array([0.9, 0.0]);
    const peaks = computePeaks([l, r], 2, 1);
    // Compute from the Float32-stored value (0.9 isn't exact in f32) to avoid an
    // off-by-one between the JS double 0.9 and its f32 representation.
    expect(peaks.peaks[0]).toBe(Math.round(r[0]! * 255));
  });

  it('never produces more buckets than frames', () => {
    const ch = new Float32Array([1, 1, 1]);
    const peaks = computePeaks([ch], 3, 1000);
    expect(peaks.length).toBe(3);
  });

  it('clamps over-unity samples to 255', () => {
    const ch = new Float32Array([2, -2]);
    const peaks = computePeaks([ch], 2, 1);
    expect(peaks.peaks[0]).toBe(255);
  });
});

describe('computePeakSet', () => {
  it('produces a detail + overview pair', () => {
    const ch = new Float32Array(10000).map((_, i) => Math.sin(i / 10));
    const { detail, overview } = computePeakSet([ch], 10000, 2000);
    expect(detail.length).toBe(2000);
    expect(overview.length).toBe(OVERVIEW_BUCKETS);
  });
});

describe('detailBucketsForDuration', () => {
  it('scales with duration at ~441/s', () => {
    expect(detailBucketsForDuration(10)).toBe(4410);
    expect(detailBucketsForDuration(0)).toBe(1); // min 1
  });
});

import { computeBandPeaks } from './peaks.js';

describe('computeBandPeaks (frequency split for coloring)', () => {
  const SR = 44100;
  function tone(hz: number, secs: number): Float32Array {
    const n = Math.floor(secs * SR);
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = Math.sin((2 * Math.PI * hz * i) / SR) * 0.8;
    return a;
  }
  function avg(arr: Uint8Array): number {
    let s = 0;
    for (const v of arr) s += v;
    return s / arr.length;
  }

  it('a bass tone lights the LOW band most', () => {
    const a = tone(60, 1); // 60 Hz
    const p = computeBandPeaks([a, a], a.length, 200, SR);
    expect(avg(p.low!)).toBeGreaterThan(avg(p.mid!));
    expect(avg(p.low!)).toBeGreaterThan(avg(p.high!));
  });

  it('a treble tone lights the HIGH band most', () => {
    const a = tone(8000, 1); // 8 kHz
    const p = computeBandPeaks([a, a], a.length, 200, SR);
    expect(avg(p.high!)).toBeGreaterThan(avg(p.low!));
  });

  it('produces low/mid/high arrays the right length', () => {
    const a = tone(440, 0.5);
    const p = computeBandPeaks([a, a], a.length, 128, SR);
    expect(p.low!.length).toBe(p.length);
    expect(p.mid!.length).toBe(p.length);
    expect(p.high!.length).toBe(p.length);
  });
});
