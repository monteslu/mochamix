/**
 * Per-deck loaded-track state shared across components (waveform band, decks,
 * platters): the computed waveform peaks, track metadata, and cover art. This is
 * non-control-bus UI state (objects, not numbers), so it lives in a small
 * subscribable store rather than the SAB control bus.
 */

import { useSyncExternalStore } from 'react';
import type { PeakData } from '@dj/waveform';

export interface DeckTrackState {
  peaks: { detail: PeakData; overview: PeakData } | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  /** Musical key (e.g. "8A" Camelot / "Am"), or null. */
  key: string | null;
  /** Object URL of the cover art image, or null. */
  coverUrl: string | null;
}

const empty: DeckTrackState = {
  peaks: null,
  title: null,
  artist: null,
  album: null,
  key: null,
  coverUrl: null,
};

const state: DeckTrackState[] = [empty, empty, empty, empty];
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function setDeckTrack(deckIndex: number, patch: Partial<DeckTrackState>): void {
  state[deckIndex] = { ...(state[deckIndex] ?? empty), ...patch };
  emit();
}

export function getDeckTrack(deckIndex: number): DeckTrackState {
  return state[deckIndex] ?? empty;
}

export function clearDeckTrack(deckIndex: number): void {
  state[deckIndex] = empty;
  emit();
}

/** React hook: subscribe to a deck's track state. */
export function useDeckTrack(deckIndex: number): DeckTrackState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => getDeckTrack(deckIndex),
  );
}
