import { describe, it, expect } from 'vitest';
import { DeckPlayback, type DeckTrack } from './deck-playback.js';
import { calculateSpeed, rateRatioFromSlider } from './rate.js';
import { getXfadeGains, crossfaderGainForChannel, orientationFromValue } from './crossfader.js';
import { packPlanarToSab } from './decoded-track.js';

function ramp(frames: number, ch = 1): DeckTrack {
  // A track whose sample value == frame index, so interpolation is easy to verify.
  const channelData: Float32Array[] = [];
  for (let c = 0; c < ch; c++) {
    const a = new Float32Array(frames);
    for (let i = 0; i < frames; i++) a[i] = i;
    channelData.push(a);
  }
  return { channelData, channels: ch, frames, sampleRate: 48000 };
}

describe('rate', () => {
  it('maps slider to tempo ratio', () => {
    expect(rateRatioFromSlider(0, 0.1, 1)).toBe(1);
    expect(rateRatioFromSlider(1, 0.1, 1)).toBeCloseTo(1.1);
    expect(rateRatioFromSlider(-1, 0.1, 1)).toBeCloseTo(0.9);
    expect(rateRatioFromSlider(1, 0.1, -1)).toBeCloseTo(0.9); // reversed direction
  });

  it('calculateSpeed is the slider ratio for M1', () => {
    expect(calculateSpeed(0.5, 0.08, 1)).toBeCloseTo(1.04);
  });
});

describe('DeckPlayback', () => {
  it('produces silence with no track', () => {
    const d = new DeckPlayback(48000);
    const out = [new Float32Array(8)];
    d.process(out, 8, 1, true);
    expect([...out[0]!]).toEqual(new Array(8).fill(0));
  });

  it('plays at unity rate, advancing one frame per output frame', () => {
    const d = new DeckPlayback(48000);
    d.loadTrack(ramp(16));
    const out = [new Float32Array(8)];
    d.process(out, 8, 1, true);
    // value == frame index at unity rate (track SR == engine SR)
    expect([...out[0]!]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(d.getPositionFrames()).toBe(8);
  });

  it('half speed interpolates between frames', () => {
    const d = new DeckPlayback(48000);
    d.loadTrack(ramp(16));
    const out = [new Float32Array(8)];
    d.process(out, 8, 0.5, true);
    // positions 0,0.5,1,1.5,... → values 0,0.5,1,1.5,...
    expect([...out[0]!]).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
    expect(d.getPositionFrames()).toBeCloseTo(4);
  });

  it('respects track vs engine sample-rate ratio (baseRate)', () => {
    const d = new DeckPlayback(48000);
    // track at 24000 → baseRate 0.5 → advances 0.5 source frames per output frame
    d.loadTrack({ ...ramp(16), sampleRate: 24000 });
    const out = [new Float32Array(8)];
    d.process(out, 8, 1, true);
    expect([...out[0]!]).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
  });

  it('stops and returns false at end of track', () => {
    const d = new DeckPlayback(48000);
    d.loadTrack(ramp(4));
    const out = [new Float32Array(8)];
    const stillPlaying = d.process(out, 8, 1, true);
    expect(stillPlaying).toBe(false);
    // first 4 are the ramp, rest silence
    expect([...out[0]!].slice(0, 4)).toEqual([0, 1, 2, 3]);
    expect([...out[0]!].slice(4)).toEqual([0, 0, 0, 0]);
  });

  it('seeks by fraction and frames', () => {
    const d = new DeckPlayback(48000);
    d.loadTrack(ramp(100));
    d.seekFraction(0.5);
    expect(d.getPositionFrames()).toBe(50);
    d.seekFrames(10);
    expect(d.getPositionFrames()).toBe(10);
    d.seekFrames(1000); // clamps
    expect(d.getPositionFrames()).toBe(100);
  });

  it('fans a mono track out to stereo outputs', () => {
    const d = new DeckPlayback(48000);
    d.loadTrack(ramp(16, 1)); // mono
    const out = [new Float32Array(4), new Float32Array(4)];
    d.process(out, 4, 1, true);
    expect([...out[0]!]).toEqual([0, 1, 2, 3]);
    expect([...out[1]!]).toEqual([0, 1, 2, 3]); // same as left
  });

  it('outputs silence and holds position when not playing', () => {
    const d = new DeckPlayback(48000);
    d.loadTrack(ramp(16));
    d.seekFrames(5);
    const out = [new Float32Array(4)];
    d.process(out, 4, 1, false);
    expect([...out[0]!]).toEqual([0, 0, 0, 0]);
    expect(d.getPositionFrames()).toBe(5); // unchanged
  });
});

describe('crossfader', () => {
  it('orientation mapping', () => {
    expect(orientationFromValue(0)).toBe('left');
    expect(orientationFromValue(1)).toBe('center');
    expect(orientationFromValue(2)).toBe('right');
  });

  it('center crossfader gives near-equal gains; ends cut the opposite side', () => {
    const mid = getXfadeGains(0, 0.6, false);
    expect(mid.left).toBeCloseTo(mid.right, 5);
    const fullRight = getXfadeGains(1, 0.6, false);
    expect(fullRight.left).toBeCloseTo(0, 5);
    expect(fullRight.right).toBeCloseTo(1, 5);
  });

  it('center-oriented channels ignore the crossfader', () => {
    expect(crossfaderGainForChannel('center', 1, 0.6, false)).toBe(1);
    expect(crossfaderGainForChannel('center', -1, 0.6, false)).toBe(1);
  });

  it('reverse swaps the sides', () => {
    const normal = getXfadeGains(1, 0.6, false);
    const reversed = getXfadeGains(1, 0.6, true);
    expect(reversed.left).toBeCloseTo(normal.right, 5);
    expect(reversed.right).toBeCloseTo(normal.left, 5);
  });
});

describe('packPlanarToSab', () => {
  it('packs channels contiguously', () => {
    const sab = packPlanarToSab([new Float32Array([1, 2]), new Float32Array([3, 4])], 2);
    expect([...new Float32Array(sab)]).toEqual([1, 2, 3, 4]);
  });
});
