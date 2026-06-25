/**
 * SmartFader — our fork's signature feature (09-smart-fader.md). As the crossfader
 * moves, both decks play at a tempo interpolated between the two tracks' BPMs, so
 * you can blend tracks of very different tempo with one fader motion. Ported from
 * our Mixxx fork's smartfadercontrol.cpp.
 *
 *   t          = (crossfader + 1) / 2            // -1..1 → 0..1
 *   targetBpm  = leftBpm*(1-t) + rightBpm*t
 *   deck rate  = targetBpm / deckFileBpm         // both decks play at targetBpm
 *
 * When enabled, this OWNS the rate of the two decks (it bypasses normal sync's
 * half/double so the leader BPM is strictly between the two file BPMs — no
 * surprise octave jumps mid-transition, the bug our fork's dc6aea69 fixed).
 *
 * Runs main-thread as a bus subscriber + periodic update, writing the deck rate
 * ratios. Two-deck feature (deck 1 = left, deck 2 = right), matching the fork.
 */

import {
  MASTER,
  MasterKeys,
  deck as deckGroup,
  DeckKeys,
  type ControlBus,
} from '@internal-dj/control-bus';

export interface SmartFaderDeps {
  bus: ControlBus;
  /** Set a deck's (0-based) rate ratio (1.0 == file tempo). */
  setRateRatio: (deckIndex: number, ratio: number) => void;
  /**
   * Phase-align the RIGHT deck's beats to the LEFT deck (instant seek) so the
   * blend starts beat-matched. No-op if grids/positions are unavailable. Optional
   * so existing callers/tests keep working.
   */
  alignDecks?: () => void;
}

const LEFT = 0;
const RIGHT = 1;

export class SmartFader {
  private readonly offs: Array<() => void> = [];
  private active = false;

  constructor(private readonly deps: SmartFaderDeps) {
    const { bus } = deps;
    // Recompute when the toggle, crossfader, or either file BPM changes.
    this.offs.push(bus.connect(MASTER, MasterKeys.smartFaderEnabled, () => this.evaluate()));
    this.offs.push(bus.connect(MASTER, MasterKeys.crossfader, () => this.tick()));
    this.offs.push(bus.connect(deckGroup(1), DeckKeys.fileBpm, () => this.evaluate()));
    this.offs.push(bus.connect(deckGroup(2), DeckKeys.fileBpm, () => this.evaluate()));
  }

  private leftBpm(): number {
    return this.deps.bus.get(deckGroup(1), DeckKeys.fileBpm);
  }
  private rightBpm(): number {
    return this.deps.bus.get(deckGroup(2), DeckKeys.fileBpm);
  }
  private enabled(): boolean {
    return this.deps.bus.get(MASTER, MasterKeys.smartFaderEnabled) > 0.5;
  }

  /** (De)activate based on the toggle + whether both decks have a BPM. */
  private evaluate(): void {
    const want = this.enabled() && this.leftBpm() > 0 && this.rightBpm() > 0;
    if (want && !this.active) {
      this.activate();
    } else if (!want && this.active) {
      this.deactivate();
    } else if (want) {
      this.tick();
    }
  }

  private activate(): void {
    this.active = true;
    const { bus } = this.deps;
    bus.set(MASTER, MasterKeys.smartFaderActive, 1);
    bus.set(MASTER, MasterKeys.smartFaderLeftBpm, this.leftBpm());
    bus.set(MASTER, MasterKeys.smartFaderRightBpm, this.rightBpm());
    // Beat-align the two decks so the blend starts phase-matched, then blend tempo.
    this.deps.alignDecks?.();
    this.tick();
  }

  private deactivate(): void {
    this.active = false;
    const { bus } = this.deps;
    bus.set(MASTER, MasterKeys.smartFaderActive, 0);
    bus.set(MASTER, MasterKeys.smartFaderTargetBpm, 0);
    // Reset both decks to their file tempo.
    this.deps.setRateRatio(LEFT, 1);
    this.deps.setRateRatio(RIGHT, 1);
  }

  /** Recompute the interpolated target BPM and set both deck rates. */
  private tick(): void {
    if (!this.active) {
      return;
    }
    const left = this.leftBpm();
    const right = this.rightBpm();
    if (left <= 0 || right <= 0) {
      this.deactivate();
      return;
    }
    const xfader = this.deps.bus.get(MASTER, MasterKeys.crossfader);
    const t = (xfader + 1) / 2;
    const targetBpm = left * (1 - t) + right * t;

    this.deps.bus.set(MASTER, MasterKeys.smartFaderTargetBpm, targetBpm);
    // Both decks play at targetBpm. No half/double — strictly between the two.
    this.deps.setRateRatio(LEFT, targetBpm / left);
    this.deps.setRateRatio(RIGHT, targetBpm / right);
  }

  /** Whether smart fader is currently driving the decks. */
  isActive(): boolean {
    return this.active;
  }

  dispose(): void {
    for (const off of this.offs) {
      off();
    }
    this.offs.length = 0;
  }
}
