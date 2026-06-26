import { describe, it, expect } from 'vitest';
import { DeckPlayback } from './deck-playback.js';

// Stem-deck mixing: a deck loaded with 4 stems plays SUM(stem_i × gain_i) at the
// same position. This is the live-mashup engine — muting a stem (gain 0) removes it.

const ENGINE_SR = 48000;

/** A stem that is a constant DC level (easy to reason about when summed). */
function dcStem(level: number, seconds = 1, sr = ENGINE_SR) {
  const frames = Math.floor(seconds * sr);
  const ch = new Float32Array(frames).fill(level);
  return { channelData: [ch, ch], channels: 2, frames, sampleRate: sr };
}

function firstSample(pb: DeckPlayback): number {
  const out = [new Float32Array(128), new Float32Array(128)];
  pb.process(out, 128, 1, true);
  return out[0]![0]!;
}

describe('stem deck mixing', () => {
  it('sums all 4 stems at full gain', () => {
    const pb = new DeckPlayback(ENGINE_SR);
    // levels chosen small so the sum stays in range
    pb.loadStems([dcStem(0.1), dcStem(0.2), dcStem(0.05), dcStem(0.15)]);
    expect(pb.hasStems()).toBe(true);
    // sum = 0.1 + 0.2 + 0.05 + 0.15 = 0.5
    expect(firstSample(pb)).toBeCloseTo(0.5, 3);
  });

  it('muting a stem (gain 0) removes its contribution', () => {
    const pb = new DeckPlayback(ENGINE_SR);
    pb.loadStems([dcStem(0.1), dcStem(0.2), dcStem(0.05), dcStem(0.15)]);
    pb.setStemGain(3, 0); // mute "vocals" (0.15)
    expect(firstSample(pb)).toBeCloseTo(0.35, 3); // 0.5 - 0.15
  });

  it('soloing a stem (others 0) isolates it — the mashup move', () => {
    const pb = new DeckPlayback(ENGINE_SR);
    pb.loadStems([dcStem(0.1), dcStem(0.2), dcStem(0.05), dcStem(0.15)]);
    pb.setStemGain(0, 0);
    pb.setStemGain(1, 0);
    pb.setStemGain(2, 0);
    // only vocals (0.15) left
    expect(firstSample(pb)).toBeCloseTo(0.15, 3);
  });

  it('partial gain scales a stem', () => {
    const pb = new DeckPlayback(ENGINE_SR);
    pb.loadStems([dcStem(0.4), dcStem(0), dcStem(0), dcStem(0)]);
    pb.setStemGain(0, 0.5);
    expect(firstSample(pb)).toBeCloseTo(0.2, 3); // 0.4 × 0.5
  });

  it('all stems advance the shared position together', () => {
    const pb = new DeckPlayback(ENGINE_SR);
    pb.loadStems([dcStem(0.1), dcStem(0.1), dcStem(0.1), dcStem(0.1)]);
    const start = pb.getPositionFraction();
    const out = [new Float32Array(128), new Float32Array(128)];
    for (let b = 0; b < 5; b++) pb.process(out, 128, 1, true);
    expect(pb.getPositionFraction()).toBeGreaterThan(start);
  });
});
