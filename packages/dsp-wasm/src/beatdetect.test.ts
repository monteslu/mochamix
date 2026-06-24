import { describe, it, expect } from 'vitest';
import { WasmBeatDetector } from './beatdetect.js';

/** Synthetic click track at a known BPM (same generator as the JS detector test). */
function clickTrack(bpm: number, seconds: number, sr: number, firstBeatSec = 0): Float32Array {
  const frames = Math.floor(seconds * sr);
  const a = new Float32Array(frames);
  const framesPerBeat = (60 / bpm) * sr;
  const first = firstBeatSec * sr;
  for (let beat = 0; ; beat++) {
    const pos = Math.round(first + beat * framesPerBeat);
    if (pos >= frames) break;
    const clickLen = Math.round(0.005 * sr);
    for (let i = 0; i < clickLen && pos + i < frames; i++) {
      const env = 1 - i / clickLen;
      a[pos + i] = Math.sin((i / sr) * 2 * Math.PI * 2000) * env;
    }
  }
  return a;
}

describe('WasmBeatDetector', () => {
  it('detects 120 BPM from a click track', () => {
    const d = new WasmBeatDetector();
    const sr = 48000;
    const track = clickTrack(120, 12, sr);
    const r = d.detect([track, track], track.length, sr);
    expect(Math.abs(r.bpm - 120)).toBeLessThan(2.5);
  });

  it('detects 128 BPM', () => {
    const d = new WasmBeatDetector();
    const sr = 48000;
    const track = clickTrack(128, 12, sr);
    const r = d.detect([track, track], track.length, sr);
    expect(Math.abs(r.bpm - 128)).toBeLessThan(2.5);
  });

  it('detects 90 BPM', () => {
    const d = new WasmBeatDetector();
    const sr = 48000;
    const track = clickTrack(90, 12, sr);
    const r = d.detect([track, track], track.length, sr);
    expect(Math.abs(r.bpm - 90)).toBeLessThan(2.5);
  });

  it('finds a plausible first-beat phase', () => {
    const d = new WasmBeatDetector();
    const sr = 48000;
    const firstBeatSec = 0.25;
    const track = clickTrack(120, 12, sr, firstBeatSec);
    const r = d.detect([track, track], track.length, sr);
    const framesPerBeat = (60 / r.bpm) * sr;
    const trueFirst = firstBeatSec * sr;
    // detected first beat, modulo the beat period, should be near the true phase
    const phaseErr = Math.min(
      Math.abs(r.firstBeatFrame - trueFirst) % framesPerBeat,
      framesPerBeat - (Math.abs(r.firstBeatFrame - trueFirst) % framesPerBeat),
    );
    expect(phaseErr).toBeLessThan(0.04 * sr);
  });

  it('reuses one detector across multiple tracks', () => {
    const d = new WasmBeatDetector();
    const sr = 48000;
    for (const bpm of [120, 100, 140]) {
      const track = clickTrack(bpm, 10, sr);
      const r = d.detect([track, track], track.length, sr);
      expect(r.bpm).toBeGreaterThan(0);
    }
  });

  it('returns a confidence in [0,1]', () => {
    const d = new WasmBeatDetector();
    const sr = 48000;
    const track = clickTrack(120, 10, sr);
    const r = d.detect([track, track], track.length, sr);
    expect(r.confidence).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });
});
