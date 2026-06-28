/**
 * BpmControl — Mixxx-equivalent BPM editing for loaded decks. The QM beat tracker (like
 * every tracker) sometimes locks onto 2x or 1/2 the true tempo; Mixxx's answer is not to
 * guess, but to give the user Double/Halve BPM + a manual set + a BPM lock. This wires the
 * same:
 *
 *   beats_set_double / beats_set_halve  → rescale the deck's BPM by 2 / 0.5
 *   setBpm(deck, bpm)                   → set an exact BPM (library numeric edit)
 *   bpm_lock                            → freeze it so re-analysis won't overwrite
 *
 * Each edit updates the LIVE deck (file_bpm on the bus, so sync/tempo/waveform follow) and
 * PERSISTS to the track's library row (bpm + bpm_locked) so it survives reload. Scaling by
 * an octave keeps first_beat_frame valid (the grid phase is unchanged), so no re-analysis
 * is needed — exactly Mixxx's beats_set_double/halve behavior.
 */

import { deck as deckGroup, DeckKeys, type ControlBus } from '@dj/control-bus';
import { getDeckTrack } from './deck-state.js';

export interface BpmControlDeps {
  bus: ControlBus;
  numDecks: number;
  /** Persist a BPM (and optional lock) to the library row. No-op if id is null. */
  persist: (libraryId: number, bpm: number, locked: boolean) => void;
}

export class BpmControl {
  private readonly offs: Array<() => void> = [];

  constructor(private readonly deps: BpmControlDeps) {
    for (let d = 0; d < deps.numDecks; d++) {
      const g = deckGroup(d + 1);
      this.pulse(g, DeckKeys.beatsSetDouble, () => this.scale(d, 2));
      this.pulse(g, DeckKeys.beatsSetHalve, () => this.scale(d, 0.5));
      // bpm_lock is a latch the user toggles; persist it when it changes.
      this.offs.push(
        deps.bus.connect(g, DeckKeys.bpmLock, (v) => this.persistDeck(d, v > 0.5)),
      );
    }
  }

  /** Multiply the deck's BPM by `factor` (2 = double, 0.5 = halve) and persist. */
  scale(deckIndex: number, factor: number): void {
    const g = deckGroup(deckIndex + 1);
    const cur = this.deps.bus.get(g, DeckKeys.fileBpm);
    if (cur > 0) this.setBpm(deckIndex, cur * factor);
  }

  /** Set the deck's BPM to an exact value (clamped sane) and persist. */
  setBpm(deckIndex: number, bpm: number): void {
    if (!(bpm > 0) || !Number.isFinite(bpm)) return;
    const clamped = Math.max(1, Math.min(500, bpm));
    const g = deckGroup(deckIndex + 1);
    this.deps.bus.set(g, DeckKeys.fileBpm, clamped);
    this.persistDeck(deckIndex, this.deps.bus.get(g, DeckKeys.bpmLock) > 0.5);
  }

  private persistDeck(deckIndex: number, locked: boolean): void {
    const g = deckGroup(deckIndex + 1);
    const id = getDeckTrack(deckIndex).libraryId;
    if (id == null) return; // not a library track (raw drop) — nothing to persist to
    this.deps.persist(id, this.deps.bus.get(g, DeckKeys.fileBpm), locked);
  }

  /** Momentary control: fire on a nonzero value, then reset to 0 so it re-triggers. */
  private pulse(g: string, key: string, fn: () => void): void {
    this.offs.push(
      this.deps.bus.connect(g, key, (v) => {
        if (v > 0.5) {
          fn();
          this.deps.bus.set(g, key, 0);
        }
      }),
    );
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
  }
}
