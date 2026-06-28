/**
 * RateControl — tempo nudge (pitch-bend), Mixxx's rate_temp_up/down (+ _small).
 *
 * Holding a nudge button temporarily speeds up / slows down the deck so you can pull a
 * drifting beat back into phase, then snaps back when released. We express the nudge as
 * `rate_temp`, a signed delta the worklet ADDS to the computed speed (so it bends on top
 * of the pitch fader and sync without disturbing either). Press → set rate_temp; release
 * → clear it. Multiple buttons held sum (up+down cancels), matching Mixxx.
 *
 * Coarse/fine steps mirror Mixxx's defaults (RateTempCoarse 4%, RateTempFine 1% of the
 * effective rate), expressed here directly in speed-ratio units.
 */

import { DeckKeys, deck as deckGroup, type ControlBus } from '@dj/control-bus';

const COARSE = 0.04; // +4% speed while held (Mixxx RateTempCoarse default)
const FINE = 0.01; // +1% (RateTempFine / _small)

export interface RateControlDeps {
  bus: ControlBus;
  numDecks: number;
}

export class RateControl {
  private readonly offs: Array<() => void> = [];
  // Per-deck active nudges so up+down (or coarse+fine) combine correctly.
  private readonly held: Array<{ up: number; down: number }> = [];

  constructor(private readonly deps: RateControlDeps) {
    const { bus, numDecks } = deps;
    for (let d = 0; d < numDecks; d++) {
      this.held[d] = { up: 0, down: 0 };
      const g = deckGroup(d + 1);
      this.bind(g, d, DeckKeys.rateTempUp, 'up', COARSE);
      this.bind(g, d, DeckKeys.rateTempDown, 'down', COARSE);
      this.bind(g, d, DeckKeys.rateTempUpSmall, 'up', FINE);
      this.bind(g, d, DeckKeys.rateTempDownSmall, 'down', FINE);
    }
  }

  /** A nudge button: while value>0 contribute +step to up/down; recompute rate_temp. */
  private bind(g: string, d: number, key: string, dir: 'up' | 'down', step: number): void {
    this.offs.push(
      this.deps.bus.connect(g, key, (v) => {
        // A button can repeat; track its contribution as present (step) or absent (0).
        this.held[d]![dir] = v > 0.5 ? Math.max(this.held[d]![dir], step) : 0;
        this.apply(g, d);
      }),
    );
  }

  private apply(g: string, d: number): void {
    const h = this.held[d]!;
    this.deps.bus.set(g, DeckKeys.rateTemp, h.up - h.down);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
  }
}
