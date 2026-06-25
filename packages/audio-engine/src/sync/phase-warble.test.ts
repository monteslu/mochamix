import { describe, it, expect } from 'vitest';
import { ControlBus, standardControls, deck as deckGroup, DeckKeys } from '@dj/control-bus';
import { SyncController } from './sync-controller.js';
import { makeGrid, beatDistance } from './beatgrid.js';

const SR = 48000;

// The "mixing sounds like shit" case: BPMs are CLOSE but not identical (real
// detected BPMs: 128.00 vs 127.80). The synced follower must (a) hold phase tightly
// and (b) NOT constantly wobble its pitch — once locked, the rate correction should
// settle near the steady tempo ratio, not oscillate by big amounts every tick.
describe('SyncController: mismatched-BPM phase lock without pitch warble', () => {
  it('locks phase tightly and the rate stops wobbling once converged', () => {
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
    const leaderBpm = 128.0;
    const followerBpm = 127.8; // close but not equal
    bus.set(g1, DeckKeys.fileBpm, leaderBpm); bus.set(g1, DeckKeys.firstBeatFrame, 0); bus.set(g1, DeckKeys.play, 1);
    bus.set(g2, DeckKeys.fileBpm, followerBpm); bus.set(g2, DeckKeys.firstBeatFrame, 0); bus.set(g2, DeckKeys.play, 1);
    pos[0] = 50000;
    pos[1] = 50000;
    bus.set(g2, DeckKeys.syncEnabled, 1);

    const lg = makeGrid(leaderBpm, 0, SR)!;
    const fg = makeGrid(followerBpm, 0, SR)!;
    const dtFrames = SR * 0.016;

    // run long enough to converge, then measure the LAST stretch
    const rates: number[] = [];
    let maxErrLate = 0;
    for (let t = 0; t < 600; t++) {
      pos[0] += dtFrames * 1.0;
      pos[1] += dtFrames * rate[1]!;
      ctl.tick();
      if (t > 400) {
        rates.push(rate[1]!);
        const e = Math.abs(beatDistance(fg, pos[1]!) - beatDistance(lg, pos[0]!));
        maxErrLate = Math.max(maxErrLate, Math.min(e, 1 - e));
      }
    }

    // (a) phase stays tightly locked
    expect(maxErrLate).toBeLessThan(0.01);

    // (b) the rate has CONVERGED — once locked it shouldn't swing wildly each tick
    // (that swing is the audible pitch warble). Measure peak-to-peak of the late
    // rates; it must be small relative to the base tempo ratio.
    const lo = Math.min(...rates), hi = Math.max(...rates);
    const expectedRatio = leaderBpm / followerBpm; // ~1.00156
    expect(hi - lo).toBeLessThan(0.002); // <0.2% pitch swing once locked
    // and it sits near the true tempo ratio
    expect((lo + hi) / 2).toBeCloseTo(expectedRatio, 2);
  });
});
