import { describe, it, expect } from 'vitest';
import { KeylockScaler } from './keylock-scaler.js';
import { DeckPlayback, type DeckTrack } from './deck-playback.js';
import type { SourcePull } from './scaler.js';

/** A sine source pull that never runs out (for steady-state tests). */
function sinePull(freq = 440, sr = 48000): SourcePull {
  let phase = 0;
  return (channels, n) => {
    for (let i = 0; i < n; i++) {
      const s = Math.sin(phase);
      phase += (2 * Math.PI * freq) / sr;
      for (const ch of channels) {
        ch[i] = s;
      }
    }
    return n;
  };
}

/** A finite pull of `total` frames, then exhaustion. */
function finitePull(total: number): { pull: SourcePull; consumed: () => number } {
  let pos = 0;
  const pull: SourcePull = (channels, n) => {
    const got = Math.min(n, total - pos);
    for (let i = 0; i < got; i++) {
      for (const ch of channels) {
        ch[i] = 0.5;
      }
    }
    pos += got;
    return got;
  };
  return { pull, consumed: () => pos };
}

function isFiniteBuffer(a: Float32Array): boolean {
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]!)) {
      return false;
    }
  }
  return true;
}

describe('KeylockScaler', () => {
  it('fills exactly the requested frames with finite samples', () => {
    const s = new KeylockScaler();
    s.setRatios(1, 1);
    const out = [new Float32Array(128), new Float32Array(128)];
    s.process(out, 128, sinePull());
    expect(out[0]!.length).toBe(128);
    expect(isFiniteBuffer(out[0]!)).toBe(true);
    expect(isFiniteBuffer(out[1]!)).toBe(true);
  });

  it('at tempo 1 and pitch 1, output is non-silent for a non-silent source', () => {
    const s = new KeylockScaler();
    s.setRatios(1, 1);
    const out = [new Float32Array(512), new Float32Array(512)];
    // pump a few blocks so the primed output flows
    for (let k = 0; k < 4; k++) {
      s.process(out, 512, sinePull());
    }
    const energy = out[0]!.reduce((sum, v) => sum + Math.abs(v), 0);
    expect(energy).toBeGreaterThan(0);
  });

  it('slower tempo consumes source more slowly than faster tempo', () => {
    // Same number of output frames; slower tempo should pull fewer source frames.
    const slow = new KeylockScaler();
    slow.setRatios(0.5, 1);
    const slowSrc = finitePull(1_000_000);
    const out = [new Float32Array(4096), new Float32Array(4096)];
    for (let k = 0; k < 8; k++) {
      slow.process(out, 4096, slowSrc.pull);
    }

    const fast = new KeylockScaler();
    fast.setRatios(2, 1);
    const fastSrc = finitePull(1_000_000);
    for (let k = 0; k < 8; k++) {
      fast.process(out, 4096, fastSrc.pull);
    }

    // For the same output, tempo 2 must consume more source than tempo 0.5.
    expect(fastSrc.consumed()).toBeGreaterThan(slowSrc.consumed());
  });

  it('reset re-primes without throwing and still produces finite output (seek safety)', () => {
    const s = new KeylockScaler();
    s.setRatios(1, 1);
    const out = [new Float32Array(256), new Float32Array(256)];
    for (let k = 0; k < 4; k++) {
      s.process(out, 256, sinePull());
    }
    // simulate a seek
    s.reset();
    expect(() => s.process(out, 256, sinePull())).not.toThrow();
    expect(isFiniteBuffer(out[0]!)).toBe(true);
  });

  it('drains to silence after the source is exhausted', () => {
    const s = new KeylockScaler();
    s.setRatios(1, 1);
    const { pull } = finitePull(2000);
    const out = [new Float32Array(1024), new Float32Array(1024)];
    // Pull well past the source length.
    let flowing = true;
    for (let k = 0; k < 20 && flowing; k++) {
      flowing = s.process(out, 1024, pull);
    }
    expect(flowing).toBe(false);
  });
});

describe('DeckPlayback with keylock', () => {
  function ramp(frames: number): DeckTrack {
    const a = new Float32Array(frames);
    for (let i = 0; i < frames; i++) a[i] = Math.sin(i / 20);
    return { channelData: [a, a.slice()], channels: 2, frames, sampleRate: 48000 };
  }

  it('toggling keylock does not throw and keeps producing finite output', () => {
    const d = new DeckPlayback(48000);
    d.loadTrack(ramp(200000));
    const out = [new Float32Array(512), new Float32Array(512)];

    d.setKeylock(false);
    d.process(out, 512, 1.05, true);
    expect(isFiniteBuffer(out[0]!)).toBe(true);

    d.setKeylock(true);
    for (let k = 0; k < 4; k++) {
      d.process(out, 512, 1.05, true);
    }
    expect(isFiniteBuffer(out[0]!)).toBe(true);
  });

  it('keylock advances the source position (track plays through)', () => {
    const d = new DeckPlayback(48000);
    d.loadTrack(ramp(500000));
    d.setKeylock(true);
    const out = [new Float32Array(2048), new Float32Array(2048)];
    const before = d.getPositionFrames();
    for (let k = 0; k < 10; k++) {
      d.process(out, 2048, 1, true);
    }
    expect(d.getPositionFrames()).toBeGreaterThan(before);
  });

  it('scratch/extreme speeds fall back to the linear path (no keylock)', () => {
    const d = new DeckPlayback(48000);
    d.loadTrack(ramp(100000));
    d.setKeylock(true);
    const out = [new Float32Array(128), new Float32Array(128)];
    // speed 0.05 (< 0.1) must use the linear path; just assert it runs + finite.
    expect(() => d.process(out, 128, 0.05, true)).not.toThrow();
    expect(isFiniteBuffer(out[0]!)).toBe(true);
  });
});
