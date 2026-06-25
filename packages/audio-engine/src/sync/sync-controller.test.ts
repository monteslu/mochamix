import { describe, it, expect, beforeEach } from 'vitest';
import { ControlBus, standardControls, deck as deckGroup, DeckKeys } from '@dj/control-bus';
import { SyncController } from './sync-controller.js';
import { makeGrid, beatDistance } from './beatgrid.js';

const SR = 48000;

/** Build a 2-deck bus + a SyncController with controllable position/seek mocks. */
function setup() {
  const bus = new ControlBus();
  for (const c of standardControls(2)) bus.define(c);

  const pos = [0, 0]; // position frames per deck
  const total = [SR * 200, SR * 200];
  const rate = [0, 0]; // rateRatioOverride captured

  const ctl = new SyncController({
    bus,
    numDecks: 2,
    sampleRate: SR,
    setRateRatio: (d, r) => {
      rate[d] = r;
    },
    positionFrames: (d) => pos[d]!,
    trackFrames: (d) => total[d]!,
    seekFrames: (d, f) => {
      pos[d] = f;
    },
  });
  return { bus, ctl, pos, total, rate };
}

describe('SyncController', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('publishes beat distance on tick', () => {
    const g = deckGroup(1);
    s.bus.set(g, DeckKeys.fileBpm, 120);
    s.bus.set(g, DeckKeys.firstBeatFrame, 0);
    s.pos[0] = 12000; // half a beat at 120bpm/48k (fpb=24000)
    s.ctl.tick();
    expect(s.bus.get(g, DeckKeys.beatDistance)).toBeCloseTo(0.5, 3);
  });

  it('phase-snaps the follower to the leader on SYNC enable', () => {
    const g1 = deckGroup(1);
    const g2 = deckGroup(2);
    // leader (deck 1): 120bpm, on a beat (phase 0)
    s.bus.set(g1, DeckKeys.fileBpm, 120);
    s.bus.set(g1, DeckKeys.firstBeatFrame, 0);
    s.bus.set(g1, DeckKeys.play, 1);
    s.pos[0] = 48000; // exactly on beat 2 → phase 0
    // follower (deck 2): 120bpm but off-phase
    s.bus.set(g2, DeckKeys.fileBpm, 120);
    s.bus.set(g2, DeckKeys.firstBeatFrame, 0);
    s.pos[1] = 48000 + 6000; // phase 0.25

    s.bus.set(g2, DeckKeys.syncEnabled, 1); // triggers onSyncToggle

    // follower should have been seeked to phase 0 (matching leader)
    const fg = makeGrid(120, 0, SR)!;
    expect(beatDistance(fg, s.pos[1]!)).toBeCloseTo(0, 3);
  });

  it('matches tempo with half/double on SYNC (140 follows 70)', () => {
    const g1 = deckGroup(1);
    const g2 = deckGroup(2);
    s.bus.set(g1, DeckKeys.fileBpm, 70);
    s.bus.set(g1, DeckKeys.firstBeatFrame, 0);
    s.bus.set(g1, DeckKeys.play, 1);
    s.bus.set(g2, DeckKeys.fileBpm, 140);
    s.bus.set(g2, DeckKeys.firstBeatFrame, 0);
    s.bus.set(g2, DeckKeys.syncEnabled, 1);
    // 140 × factor(0.5) = 70 == leader; ratio = 70/(140×0.5) = 1.0
    expect(s.rate[1]).toBeCloseTo(1.0, 3);
  });

  it('syncs to a STOPPED deck (leader need not be playing) — the real bug', () => {
    const g1 = deckGroup(1);
    const g2 = deckGroup(2);
    // deck 1 loaded with a BPM but NOT playing
    s.bus.set(g1, DeckKeys.fileBpm, 128);
    s.bus.set(g1, DeckKeys.firstBeatFrame, 0);
    s.bus.set(g1, DeckKeys.play, 0); // stopped
    // deck 2 syncs to it
    s.bus.set(g2, DeckKeys.fileBpm, 120);
    s.bus.set(g2, DeckKeys.firstBeatFrame, 0);
    s.bus.set(g2, DeckKeys.syncEnabled, 1);
    // should still match tempo: 128/120
    expect(s.rate[1]).toBeCloseTo(128 / 120, 3);
  });

  it('releases the override when SYNC is disabled', () => {
    const g2 = deckGroup(2);
    s.bus.set(deckGroup(1), DeckKeys.fileBpm, 120);
    s.bus.set(deckGroup(1), DeckKeys.play, 1);
    s.bus.set(g2, DeckKeys.fileBpm, 124);
    s.bus.set(g2, DeckKeys.syncEnabled, 1);
    s.bus.set(g2, DeckKeys.syncEnabled, 0);
    expect(s.rate[1]).toBe(0); // 0 == released
  });

  it('phaseAlign aligns deck-1 to deck-0 (Smart Fader use)', () => {
    const g1 = deckGroup(1);
    const g2 = deckGroup(2);
    s.bus.set(g1, DeckKeys.fileBpm, 128);
    s.bus.set(g1, DeckKeys.firstBeatFrame, 1000);
    s.bus.set(g2, DeckKeys.fileBpm, 120);
    s.bus.set(g2, DeckKeys.firstBeatFrame, 3000);
    s.pos[0] = 90000;
    s.pos[1] = 70000;
    const lg = makeGrid(128, 1000, SR)!;
    const ok = s.ctl.phaseAlign(1, 0);
    expect(ok).toBe(true);
    const fg = makeGrid(120, 3000, SR)!;
    expect(beatDistance(fg, s.pos[1]!)).toBeCloseTo(beatDistance(lg, s.pos[0]!), 3);
  });
});
