import { describe, it, expect, beforeEach } from 'vitest';
import { ControlBus, standardControls, deck as deckGroup, DeckKeys } from '@dj/control-bus';
import { BpmControl } from './bpm-control.js';
import { setDeckTrack } from './deck-state.js';

// Mixxx-style BPM editing: Double/Halve fix octave errors, setBpm sets exact, bpm_lock
// freezes it, and every edit persists to the library row + updates the live deck.

function setup() {
  const bus = new ControlBus();
  for (const c of standardControls(2)) bus.define(c);
  const persisted: Array<{ id: number; bpm: number; locked: boolean }> = [];
  const ctl = new BpmControl({
    bus,
    numDecks: 2,
    persist: (id, bpm, locked) => persisted.push({ id, bpm, locked }),
  });
  const g = deckGroup(1);
  bus.set(g, DeckKeys.fileBpm, 88);
  setDeckTrack(0, { libraryId: 42 });
  return { bus, ctl, persisted, g, bpm: () => bus.get(g, DeckKeys.fileBpm) };
}

describe('BpmControl', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('beats_set_double doubles the deck BPM and persists', () => {
    s.bus.set(s.g, DeckKeys.beatsSetDouble, 1);
    expect(s.bpm()).toBe(176);
    expect(s.persisted.at(-1)).toMatchObject({ id: 42, bpm: 176 });
    expect(s.bus.get(s.g, DeckKeys.beatsSetDouble)).toBe(0); // pulse reset
  });

  it('beats_set_halve halves the deck BPM', () => {
    s.bus.set(s.g, DeckKeys.fileBpm, 176);
    s.bus.set(s.g, DeckKeys.beatsSetHalve, 1);
    expect(s.bpm()).toBe(88);
  });

  it('setBpm sets an exact value (clamped) and persists', () => {
    s.ctl.setBpm(0, 124.5);
    expect(s.bpm()).toBe(124.5);
    expect(s.persisted.at(-1)).toMatchObject({ id: 42, bpm: 124.5 });
    s.ctl.setBpm(0, 9999); // clamps to 500
    expect(s.bpm()).toBe(500);
  });

  it('bpm_lock persists the locked flag', () => {
    s.bus.set(s.g, DeckKeys.bpmLock, 1);
    expect(s.persisted.at(-1)).toMatchObject({ id: 42, locked: true });
  });

  it('edits include the current lock state', () => {
    s.bus.set(s.g, DeckKeys.bpmLock, 1);
    s.persisted.length = 0;
    s.bus.set(s.g, DeckKeys.beatsSetDouble, 1);
    expect(s.persisted.at(-1)).toMatchObject({ bpm: 176, locked: true });
  });

  it('does not persist when no library track is loaded on the deck', () => {
    setDeckTrack(0, { libraryId: null });
    s.persisted.length = 0;
    s.bus.set(s.g, DeckKeys.beatsSetDouble, 1);
    expect(s.bpm()).toBe(176); // live deck still updates
    expect(s.persisted).toHaveLength(0); // but nothing to persist to
  });
});
