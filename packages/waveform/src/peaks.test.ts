import { describe, it, expect } from 'vitest';
import {
  computePeaks,
  computePeakSet,
  detailBucketsForDuration,
  OVERVIEW_BUCKETS,
} from './peaks.js';

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
