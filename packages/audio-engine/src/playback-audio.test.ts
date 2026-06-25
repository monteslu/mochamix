import { describe, it, expect } from 'vitest';
import { DeckPlayback } from './deck-playback.js';

// Regression: "play spins the record but no sound / waveform doesn't move."
// Proves the playback engine itself (a) advances position and (b) emits NON-zero
// audio when given a real track + playing. If this passes but you still hear
// silence, the fault is downstream (routing / AudioContext), not the engine.

const ENGINE_SR = 48000;

function makeTrack(seconds: number, sr: number) {
  const frames = Math.floor(seconds * sr);
  const ch = new Float32Array(frames);
  for (let i = 0; i < frames; i++) ch[i] = Math.sin((2 * Math.PI * 440 * i) / sr) * 0.8; // A440
  return { channelData: [ch, ch], channels: 2, frames, sampleRate: sr };
}

describe('DeckPlayback produces audio + advances position', () => {
  it('emits non-zero output and advances when playing', () => {
    const pb = new DeckPlayback(ENGINE_SR);
    pb.loadTrack(makeTrack(2, 44100));
    expect(pb.hasTrack()).toBe(true);
    const startPos = pb.getPositionFraction();

    const out = [new Float32Array(128), new Float32Array(128)];
    // process a few blocks at normal speed, playing
    let peak = 0;
    for (let b = 0; b < 10; b++) {
      pb.process(out, 128, 1, true);
      for (let i = 0; i < 128; i++) peak = Math.max(peak, Math.abs(out[0]![i]!));
    }
    expect(peak).toBeGreaterThan(0.05); // real signal came out, not silence
    expect(pb.getPositionFraction()).toBeGreaterThan(startPos); // position advanced
  });

  it('outputs silence and does not advance when paused', () => {
    const pb = new DeckPlayback(ENGINE_SR);
    pb.loadTrack(makeTrack(2, 44100));
    const pos = pb.getPositionFraction();
    const out = [new Float32Array(128), new Float32Array(128)];
    pb.process(out, 128, 1, false); // not playing
    expect(Math.max(...out[0]!.map(Math.abs))).toBe(0);
    expect(pb.getPositionFraction()).toBe(pos);
  });

  it('advances faster at higher speed', () => {
    const a = new DeckPlayback(ENGINE_SR);
    const b = new DeckPlayback(ENGINE_SR);
    a.loadTrack(makeTrack(5, 44100));
    b.loadTrack(makeTrack(5, 44100));
    const out = [new Float32Array(128), new Float32Array(128)];
    for (let i = 0; i < 20; i++) {
      a.process(out, 128, 1, true);
      b.process(out, 128, 1.5, true);
    }
    expect(b.getPositionFraction()).toBeGreaterThan(a.getPositionFraction());
  });
});
