/**
 * SyncEngine — beat sync (Mixxx EngineSync analog, 04-audio-engine.md §6). Pure
 * math over the deck tempos/positions; no audio. Runs main-thread, reading each
 * deck's file_bpm + play position from the bus and writing the rate control to
 * keep synced decks beat-locked.
 *
 * Model: each deck is a Syncable {fileBpm, beatDistance, playing, syncMode}. One
 * leader; followers get their rate set so their effective BPM matches the leader,
 * with a small proportional correction to slide beat distance into phase. Half/
 * double handled so a 140 deck locks to a 70 leader.
 *
 * This intentionally drives the EXISTING rate control (the same `rate` slider the
 * worklet already reads) rather than adding a new rate authority — sync just
 * computes the slider value for followers.
 */

import { Beats } from '@dj/analysis';

export type SyncMode = 'none' | 'follower' | 'leader';

export interface DeckSyncState {
  fileBpm: number;
  /** Beat distance 0..1 (0 = on a beat). */
  beatDistance: number;
  playing: boolean;
  syncMode: SyncMode;
}

export interface SyncDeck {
  /** Read the deck's current sync state. */
  read(): DeckSyncState;
  /**
   * Set the deck's rate ratio (1.0 == file tempo). The engine maps this onto the
   * `rate` slider given the deck's rateRange.
   */
  setRateRatio(ratio: number): void;
  setSyncMode(mode: SyncMode): void;
}

/** Max per-update rate nudge a follower applies chasing phase (Mixxx caps ±0.05). */
const MAX_PHASE_ADJUST = 0.05;
const PHASE_GAIN = 0.5;

export class SyncEngine {
  private decks: SyncDeck[] = [];

  setDecks(decks: SyncDeck[]): void {
    this.decks = decks;
  }

  /**
   * Pick the leader: an explicit leader wins; else the single playing synced deck
   * with a valid BPM; else none.
   */
  private pickLeader(): number {
    let explicit = -1;
    const playingSynced: number[] = [];
    for (let i = 0; i < this.decks.length; i++) {
      const s = this.decks[i]!.read();
      if (s.syncMode === 'leader') {
        explicit = i;
      }
      if (s.syncMode !== 'none' && s.playing && s.fileBpm > 0) {
        playingSynced.push(i);
      }
    }
    if (explicit >= 0) {
      return explicit;
    }
    return playingSynced.length > 0 ? playingSynced[0]! : -1;
  }

  /**
   * The half/double multiplier so `followerBpm * factor` lands closest to the
   * leader BPM (e.g. 140 vs 70 → factor 0.5).
   */
  private halfDoubleFactor(followerBpm: number, leaderBpm: number): number {
    const candidates = [1, 0.5, 2];
    let best = 1;
    let bestDist = Infinity;
    for (const f of candidates) {
      const d = Math.abs(followerBpm * f - leaderBpm);
      if (d < bestDist) {
        bestDist = d;
        best = f;
      }
    }
    return best;
  }

  /**
   * Run one sync update. Call this periodically (e.g. each animation frame or on
   * a timer); it reads fresh state and writes follower rates.
   */
  update(): void {
    const leaderIdx = this.pickLeader();
    if (leaderIdx < 0) {
      return;
    }
    const leader = this.decks[leaderIdx]!.read();
    if (leader.fileBpm <= 0) {
      return;
    }
    // The leader's effective (played) BPM == fileBpm × its own rate ratio. For
    // M5 the leader plays at its rate; we read its effective BPM via fileBpm and
    // assume the leader's rate is user-driven. Followers match the leader's
    // *effective* tempo. We approximate effective leader BPM as fileBpm (rate 1)
    // unless a future hook provides the live ratio.
    const leaderBpm = leader.fileBpm;

    for (let i = 0; i < this.decks.length; i++) {
      if (i === leaderIdx) {
        continue;
      }
      const deck = this.decks[i]!;
      const s = deck.read();
      if (s.syncMode !== 'follower' || s.fileBpm <= 0) {
        continue;
      }

      const factor = this.halfDoubleFactor(s.fileBpm, leaderBpm);
      // Base ratio to match tempo: leaderBpm / (fileBpm × factor) gives the rate
      // ratio that makes follower's effective BPM == leaderBpm.
      const baseRatio = leaderBpm / (s.fileBpm * factor);

      // Phase correction: nudge toward the leader's beat distance.
      const error = shortestBeatError(s.beatDistance, leader.beatDistance);
      const adjust = clamp(-error * PHASE_GAIN, -MAX_PHASE_ADJUST, MAX_PHASE_ADJUST);

      deck.setRateRatio(baseRatio * (1 + adjust));
    }
  }
}

/** Signed shortest difference between two beat distances (wraps at 1.0). */
export function shortestBeatError(from: number, to: number): number {
  let d = to - from;
  if (d > 0.5) {
    d -= 1;
  } else if (d < -0.5) {
    d += 1;
  }
  return d;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Beat distance of a deck at a given frame, given its grid. */
export function beatDistanceAt(beats: Beats, frame: number): number {
  return beats.beatDistance(frame);
}
