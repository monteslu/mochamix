/**
 * SyncController — wires beat sync to the control bus + engine (the runtime
 * counterpart to the pure SyncEngine math). Responsibilities:
 *
 *  1. Publish each deck's live beat distance every tick (from grid + position).
 *  2. On SYNC enable: pick a leader, match the follower's tempo (half/double), and
 *     INSTANTLY phase-snap the follower so its beats land on the leader's grid
 *     (seek), then hold phase with continuous rate nudges.
 *  3. On SYNC disable: release the follower's rate override.
 *
 * Runs main-thread as a bus subscriber + periodic tick(). Two+ decks. It drives
 * the same rateRatioOverride the SmartFader uses (one rate authority).
 */

import {
  deck as deckGroup,
  DeckKeys,
  type ControlBus,
} from '@internal-dj/control-bus';
import { makeGrid, beatDistance, alignedFrame, type Grid } from './beatgrid.js';

export interface SyncDeps {
  bus: ControlBus;
  numDecks: number;
  sampleRate: number;
  /** Set a deck's (0-based) rate ratio (1.0 == file tempo); 0 clears the override. */
  setRateRatio: (deckIndex: number, ratio: number) => void;
  /** Current play position in frames for a deck. */
  positionFrames: (deckIndex: number) => number;
  /** Total frames of the loaded track for a deck. */
  trackFrames: (deckIndex: number) => number;
  /** Seek a deck to an absolute frame (for the instant phase snap). */
  seekFrames: (deckIndex: number, frame: number) => void;
}

const MAX_PHASE_ADJUST = 0.04;
const PHASE_GAIN = 0.5;

export class SyncController {
  private readonly offs: Array<() => void> = [];

  constructor(private readonly deps: SyncDeps) {
    const { bus, numDecks } = deps;
    for (let d = 0; d < numDecks; d++) {
      const g = deckGroup(d + 1);
      // toggling sync on a deck re-snaps immediately
      this.offs.push(bus.connect(g, DeckKeys.syncEnabled, () => this.onSyncToggle(d)));
      this.offs.push(bus.connect(g, DeckKeys.syncLeader, () => this.onSyncToggle(d)));
    }
  }

  private grid(deckIndex: number): Grid | null {
    const g = deckGroup(deckIndex + 1);
    const bpm = this.deps.bus.get(g, DeckKeys.fileBpm);
    const fbf = this.deps.bus.get(g, DeckKeys.firstBeatFrame);
    return makeGrid(bpm, fbf >= 0 ? fbf : 0, this.deps.sampleRate);
  }

  private isFollower(deckIndex: number): boolean {
    return this.deps.bus.get(deckGroup(deckIndex + 1), DeckKeys.syncEnabled) > 0.5;
  }

  /** Leader = explicit syncLeader, else the first synced+playing deck with a BPM. */
  private pickLeader(): number {
    const { bus, numDecks } = this.deps;
    let firstPlaying = -1;
    for (let d = 0; d < numDecks; d++) {
      const g = deckGroup(d + 1);
      if (bus.get(g, DeckKeys.syncLeader) > 0.5) return d;
      if (
        firstPlaying < 0 &&
        bus.get(g, DeckKeys.play) > 0.5 &&
        bus.get(g, DeckKeys.fileBpm) > 0
      ) {
        firstPlaying = d;
      }
    }
    return firstPlaying;
  }

  private halfDoubleFactor(followerBpm: number, leaderBpm: number): number {
    let best = 1;
    let bestDist = Infinity;
    for (const f of [1, 0.5, 2]) {
      const dist = Math.abs(followerBpm * f - leaderBpm);
      if (dist < bestDist) {
        bestDist = dist;
        best = f;
      }
    }
    return best;
  }

  /** When SYNC toggles on a deck: match tempo + instantly phase-snap. */
  private onSyncToggle(deckIndex: number): void {
    if (!this.isFollower(deckIndex)) {
      this.deps.setRateRatio(deckIndex, 0); // release override
      return;
    }
    const leaderIdx = this.pickLeader();
    if (leaderIdx < 0 || leaderIdx === deckIndex) return;

    const fg = this.grid(deckIndex);
    const lg = this.grid(leaderIdx);
    if (!fg || !lg) return;

    const leaderBpm = this.deps.bus.get(deckGroup(leaderIdx + 1), DeckKeys.fileBpm);
    const followerBpm = this.deps.bus.get(deckGroup(deckIndex + 1), DeckKeys.fileBpm);
    const factor = this.halfDoubleFactor(followerBpm, leaderBpm);
    this.deps.setRateRatio(deckIndex, leaderBpm / (followerBpm * factor));

    // instant phase snap: align follower beat to leader beat
    const leaderPhase = beatDistance(lg, this.deps.positionFrames(leaderIdx));
    const followerFrame = this.deps.positionFrames(deckIndex);
    const target = alignedFrame(fg, followerFrame, leaderPhase);
    const total = this.deps.trackFrames(deckIndex);
    if (total > 0) {
      this.deps.seekFrames(deckIndex, Math.max(0, Math.min(total - 1, target)));
    }
  }

  /**
   * Instantly phase-align `followerIdx` to `leaderIdx` (seek the follower so its
   * beat lands on the leader's). Used by Smart Fader on activate. Returns true if
   * it could align (both grids valid).
   */
  phaseAlign(followerIdx: number, leaderIdx: number): boolean {
    const fg = this.grid(followerIdx);
    const lg = this.grid(leaderIdx);
    if (!fg || !lg) return false;
    const leaderPhase = beatDistance(lg, this.deps.positionFrames(leaderIdx));
    const followerFrame = this.deps.positionFrames(followerIdx);
    const target = alignedFrame(fg, followerFrame, leaderPhase);
    const total = this.deps.trackFrames(followerIdx);
    if (total <= 0) return false;
    this.deps.seekFrames(followerIdx, Math.max(0, Math.min(total - 1, target)));
    return true;
  }

  /** Periodic update: publish beat distances + hold follower phase. */
  tick(): void {
    const { bus, numDecks } = this.deps;
    // publish beat distance for all decks
    for (let d = 0; d < numDecks; d++) {
      const g = this.grid(d);
      if (g) {
        bus.set(deckGroup(d + 1), DeckKeys.beatDistance, beatDistance(g, this.deps.positionFrames(d)));
      }
    }

    const leaderIdx = this.pickLeader();
    if (leaderIdx < 0) return;
    const lg = this.grid(leaderIdx);
    if (!lg) return;
    const leaderBpm = bus.get(deckGroup(leaderIdx + 1), DeckKeys.fileBpm);
    const leaderPhase = beatDistance(lg, this.deps.positionFrames(leaderIdx));

    for (let d = 0; d < numDecks; d++) {
      if (d === leaderIdx || !this.isFollower(d)) continue;
      const followerBpm = bus.get(deckGroup(d + 1), DeckKeys.fileBpm);
      if (followerBpm <= 0) continue;
      const factor = this.halfDoubleFactor(followerBpm, leaderBpm);
      const baseRatio = leaderBpm / (followerBpm * factor);

      const fg = this.grid(d);
      if (!fg) {
        this.deps.setRateRatio(d, baseRatio);
        continue;
      }
      // proportional phase hold
      const fphase = beatDistance(fg, this.deps.positionFrames(d));
      let err = leaderPhase - fphase;
      if (err > 0.5) err -= 1;
      else if (err < -0.5) err += 1;
      const adjust = clamp(err * PHASE_GAIN, -MAX_PHASE_ADJUST, MAX_PHASE_ADJUST);
      this.deps.setRateRatio(d, baseRatio * (1 + adjust));
    }
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
