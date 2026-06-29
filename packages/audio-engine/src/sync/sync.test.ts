import { describe, it, expect } from 'vitest';
import { SmartFader } from './smart-fader.js';
import { SyncEngine, shortestBeatError, type SyncDeck } from './sync-engine.js';
import {
  ControlBus,
  standardControls,
  MASTER,
  MasterKeys,
  deck,
  DeckKeys,
} from '@dj/control-bus';

describe('shortestBeatError', () => {
  it('wraps around 1.0', () => {
    expect(shortestBeatError(0.1, 0.2)).toBeCloseTo(0.1);
    expect(shortestBeatError(0.9, 0.1)).toBeCloseTo(0.2); // forward across the wrap
    expect(shortestBeatError(0.1, 0.9)).toBeCloseTo(-0.2); // backward
  });
});

describe('SmartFader', () => {
  function setup(leftBpm = 120, rightBpm = 128, enabledAtCtor = false) {
    const bus = new ControlBus();
    bus.defineAll(standardControls(2));
    bus.set(deck(1), DeckKeys.fileBpm, leftBpm);
    bus.set(deck(2), DeckKeys.fileBpm, rightBpm);
    if (enabledAtCtor) bus.set(MASTER, MasterKeys.smartFaderEnabled, 1);
    const ratios: Record<number, number> = { 0: 1, 1: 1 };
    let aligns = 0;
    const sf = new SmartFader({
      bus,
      setRateRatio: (d, r) => {
        ratios[d] = r;
      },
      alignDecks: () => {
        aligns++;
      },
    });
    return { bus, sf, ratios, aligns: () => aligns };
  }

  it('toggling smart fader ON beat-aligns the decks', () => {
    const { bus, aligns } = setup(120, 128);
    expect(aligns()).toBe(0);
    bus.set(MASTER, MasterKeys.smartFaderEnabled, 1);
    expect(aligns()).toBe(1); // activate() snaps once
  });

  it('forces keylock ON both decks while active, restores prior state on deactivate', () => {
    const { bus } = setup(120, 128);
    // user had keylock off on deck 1, on on deck 2
    bus.set(deck(1), DeckKeys.keylock, 0);
    bus.set(deck(2), DeckKeys.keylock, 1);
    bus.set(MASTER, MasterKeys.smartFaderEnabled, 1); // activate
    // Smart Fader changes tempo, so keylock must be on for BOTH (else chipmunk).
    expect(bus.get(deck(1), DeckKeys.keylock)).toBe(1);
    expect(bus.get(deck(2), DeckKeys.keylock)).toBe(1);
    bus.set(MASTER, MasterKeys.smartFaderEnabled, 0); // deactivate
    expect(bus.get(deck(1), DeckKeys.keylock)).toBe(0); // restored to prior (off)
    expect(bus.get(deck(2), DeckKeys.keylock)).toBe(1); // restored to prior (on)
  });

  it('a RESTORED enabled=1 at construction does NOT align (no playing deck yet)', () => {
    // Regression: a persisted smartFaderEnabled=1 must reflect state but not fire the
    // beat-snap at engine start (it would be eaten + latch active, killing the real snap).
    const { sf, aligns } = setup(120, 128, /* enabledAtCtor */ true);
    expect(sf.isActive()).toBe(true); // state restored
    expect(aligns()).toBe(0); // but NOT aligned prematurely
  });

  it('is inactive until enabled', () => {
    const { bus, sf } = setup();
    expect(sf.isActive()).toBe(false);
    bus.set(MASTER, MasterKeys.smartFaderEnabled, 1);
    expect(sf.isActive()).toBe(true);
    expect(bus.get(MASTER, MasterKeys.smartFaderActive)).toBe(1);
  });

  it('hard-left crossfader plays both decks at the LEFT bpm', () => {
    const { bus, ratios } = setup(120, 128);
    bus.set(MASTER, MasterKeys.smartFaderEnabled, 1);
    bus.set(MASTER, MasterKeys.crossfader, -1); // full left
    // target = 120; left ratio = 120/120 = 1, right ratio = 120/128
    expect(ratios[0]).toBeCloseTo(1, 5);
    expect(ratios[1]).toBeCloseTo(120 / 128, 5);
    expect(bus.get(MASTER, MasterKeys.smartFaderTargetBpm)).toBeCloseTo(120);
  });

  it('hard-right crossfader plays both decks at the RIGHT bpm', () => {
    const { bus, ratios } = setup(120, 128);
    bus.set(MASTER, MasterKeys.smartFaderEnabled, 1);
    bus.set(MASTER, MasterKeys.crossfader, 1); // full right
    expect(ratios[0]).toBeCloseTo(128 / 120, 5);
    expect(ratios[1]).toBeCloseTo(1, 5);
    expect(bus.get(MASTER, MasterKeys.smartFaderTargetBpm)).toBeCloseTo(128);
  });

  it('center crossfader plays both at the average bpm', () => {
    const { bus, ratios } = setup(120, 128);
    bus.set(MASTER, MasterKeys.smartFaderEnabled, 1);
    bus.set(MASTER, MasterKeys.crossfader, 0);
    const avg = 124;
    expect(bus.get(MASTER, MasterKeys.smartFaderTargetBpm)).toBeCloseTo(avg);
    expect(ratios[0]).toBeCloseTo(avg / 120, 5);
    expect(ratios[1]).toBeCloseTo(avg / 128, 5);
  });

  it('blends across very different tempos (90 vs 140) with no half/double jump', () => {
    const { bus } = setup(90, 140);
    bus.set(MASTER, MasterKeys.smartFaderEnabled, 1);
    bus.set(MASTER, MasterKeys.crossfader, 0);
    // strictly between → 115, NOT 90 vs 70 (no octave snapping)
    expect(bus.get(MASTER, MasterKeys.smartFaderTargetBpm)).toBeCloseTo(115);
  });

  it('deactivates and resets ratios to 1 when disabled', () => {
    const { bus, sf, ratios } = setup();
    bus.set(MASTER, MasterKeys.smartFaderEnabled, 1);
    bus.set(MASTER, MasterKeys.crossfader, 1);
    bus.set(MASTER, MasterKeys.smartFaderEnabled, 0);
    expect(sf.isActive()).toBe(false);
    expect(ratios[0]).toBe(1);
    expect(ratios[1]).toBe(1);
    expect(bus.get(MASTER, MasterKeys.smartFaderActive)).toBe(0);
  });

  it('does not activate if a deck has no BPM', () => {
    const { bus, sf } = setup(120, 0);
    bus.set(MASTER, MasterKeys.smartFaderEnabled, 1);
    expect(sf.isActive()).toBe(false);
  });
});

describe('SyncEngine', () => {
  function fakeDeck(state: {
    fileBpm: number;
    beatDistance?: number;
    playing?: boolean;
    syncMode?: 'none' | 'follower' | 'leader';
  }): { deck: SyncDeck; ratio: () => number } {
    let ratio = 1;
    const s = {
      fileBpm: state.fileBpm,
      beatDistance: state.beatDistance ?? 0,
      playing: state.playing ?? true,
      syncMode: state.syncMode ?? ('none' as const),
    };
    return {
      deck: {
        read: () => s,
        setRateRatio: (r) => (ratio = r),
        setSyncMode: (m) => (s.syncMode = m),
      },
      ratio: () => ratio,
    };
  }

  it('a follower matches the leader tempo', () => {
    const leader = fakeDeck({ fileBpm: 120, syncMode: 'leader' });
    const follower = fakeDeck({ fileBpm: 100, syncMode: 'follower' });
    const sync = new SyncEngine();
    sync.setDecks([leader.deck, follower.deck]);
    sync.update();
    // follower ratio ≈ 120/100 = 1.2 (× tiny phase adjust)
    expect(follower.ratio()).toBeCloseTo(1.2, 1);
  });

  it('half/double: a 140 follower locks to a 70 leader via factor 2', () => {
    const leader = fakeDeck({ fileBpm: 70, syncMode: 'leader' });
    const follower = fakeDeck({ fileBpm: 140, syncMode: 'follower' });
    const sync = new SyncEngine();
    sync.setDecks([leader.deck, follower.deck]);
    sync.update();
    // factor 0.5 → baseRatio = 70/(140*0.5) = 1.0
    expect(follower.ratio()).toBeCloseTo(1.0, 1);
  });

  it('does nothing without a leader', () => {
    const a = fakeDeck({ fileBpm: 120, syncMode: 'none' });
    const sync = new SyncEngine();
    sync.setDecks([a.deck]);
    sync.update();
    expect(a.ratio()).toBe(1);
  });
});
