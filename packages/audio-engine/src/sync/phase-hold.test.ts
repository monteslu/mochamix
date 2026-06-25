import { describe, it, expect } from 'vitest';
import { ControlBus, standardControls, deck as deckGroup, DeckKeys } from '@dj/control-bus';
import { SyncController } from './sync-controller.js';
import { makeGrid, beatDistance } from './beatgrid.js';

const SR = 48000;

// Prove that after SYNC, two PLAYING decks stay beat-locked (not just at the
// instant of pressing sync) — the audio phase converges and holds.
describe('SyncController phase hold over time', () => {
  it('drives the follower phase toward the leader and keeps it locked', () => {
    const bus = new ControlBus();
    for (const c of standardControls(2)) bus.define(c);
    const pos = [0, 0];
    const rate = [1, 1];
    const total = SR * 300;
    const ctl = new SyncController({
      bus, numDecks: 2, sampleRate: SR,
      setRateRatio: (d, r) => { rate[d] = r === 0 ? 1 : r; },
      positionFrames: (d) => pos[d]!,
      trackFrames: () => total,
      seekFrames: (d, f) => { pos[d] = f; },
    });
    const g1 = deckGroup(1), g2 = deckGroup(2);
    // both 120bpm so factor=1; leader playing
    bus.set(g1, DeckKeys.fileBpm, 120); bus.set(g1, DeckKeys.firstBeatFrame, 0); bus.set(g1, DeckKeys.play, 1);
    bus.set(g2, DeckKeys.fileBpm, 120); bus.set(g2, DeckKeys.firstBeatFrame, 0); bus.set(g2, DeckKeys.play, 1);
    // start the follower OFF phase by a quarter beat
    const fpb = (60 / 120) * SR; // 24000
    pos[0] = 100000;            // leader
    pos[1] = 100000 + fpb * 0.25; // follower 0.25 beat ahead

    bus.set(g2, DeckKeys.syncEnabled, 1); // instant snap on enable

    const fg = makeGrid(120, 0, SR)!;
    const lg = makeGrid(120, 0, SR)!;
    // after the snap, phases should match
    const err = Math.abs(beatDistance(fg, pos[1]!) - beatDistance(lg, pos[0]!));
    expect(Math.min(err, 1 - err)).toBeCloseTo(0, 2);

    // now simulate playback: advance both per "tick", with the follower at its
    // corrected rate, and run the hold. Phase error must stay tiny.
    const dtFrames = SR * 0.016; // ~16ms per tick
    let maxErr = 0;
    for (let t = 0; t < 200; t++) {
      pos[0] += dtFrames * 1.0;       // leader at rate 1
      pos[1] += dtFrames * rate[1]!;  // follower at its synced rate
      ctl.tick();
      const e = Math.abs(beatDistance(fg, pos[1]!) - beatDistance(lg, pos[0]!));
      maxErr = Math.max(maxErr, Math.min(e, 1 - e));
    }
    // stays locked within a small fraction of a beat
    expect(maxErr).toBeLessThan(0.05);
  });
});
