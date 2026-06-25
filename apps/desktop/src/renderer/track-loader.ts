/**
 * Shared track-load pipeline. Both the Deck (drop / file-picker) and the Library
 * (load-to-deck) used to duplicate this whole decode → peaks → engine → analysis
 * flow inline, which also forced a `window` CustomEvent to shuttle peaks between
 * them. This is the single source of truth: decode the audio, compute the
 * waveform peaks, push the track into the engine, write metadata to the shared
 * deck-state store, fetch cover art, and (if needed) analyze + persist.
 *
 * Pure logic, no React.
 */

import { decodeArrayBuffer } from '@internal-dj/codec';
import { computePeakSet, detailBucketsForDuration, packPeaks } from '@internal-dj/waveform';
import { deck as deckGroup, DeckKeys, type ControlBus } from '@internal-dj/control-bus';
import type { Engine } from '@internal-dj/audio-engine';
import type { AnalysisService } from './analysis-service.js';
import { setDeckTrack } from './deck-state.js';

export interface TrackLoaderDeps {
  engine: Engine;
  bus: ControlBus;
  analysis: AnalysisService;
}

/** Where the audio bytes come from + the metadata we already know. */
export interface LoadSource {
  /** Raw file bytes + name (decode input). */
  file: { name: string; data: ArrayBuffer; path?: string };
  /** Known metadata (from the library DB), if any. */
  meta?: {
    title?: string | null;
    artist?: string | null;
    album?: string | null;
    key?: string | null;
    bpm?: number;
  };
  /** Filesystem path for cover-art extraction (file.path or library location). */
  coverPath?: string;
  /** Library track id, for persisting analysis + incrementing play count. */
  libraryId?: number;
}

/**
 * Run the full load pipeline for a deck. Returns once the track is in the engine
 * + metadata/peaks are on the deck store; cover art + analysis continue in the
 * background.
 */
export async function loadTrackToDeck(
  deps: TrackLoaderDeps,
  deckIndex: number,
  src: LoadSource,
): Promise<void> {
  const { engine, bus, analysis } = deps;
  const ctx = engine.audioContext;
  if (!ctx) return; // engine not started

  const decoded = await decodeArrayBuffer(ctx, src.file.data, src.file.name);

  // planar channels → peak set
  const all = new Float32Array(decoded.sampleBuffer);
  const channels: Float32Array[] = [];
  for (let c = 0; c < decoded.channels; c++) {
    channels.push(all.subarray(c * decoded.frames, (c + 1) * decoded.frames));
  }
  const dur = decoded.frames / decoded.sampleRate;
  const peaks = computePeakSet(
    channels,
    decoded.frames,
    detailBucketsForDuration(dur),
    decoded.sampleRate,
  );

  const m = src.meta ?? {};
  const title = m.title ?? src.file.name.replace(/\.[^.]+$/, '');
  setDeckTrack(deckIndex, {
    peaks,
    title,
    artist: m.artist ?? null,
    album: m.album ?? null,
    key: m.key ?? null,
    coverUrl: null,
  });

  engine.loadTrack(deckIndex, decoded);
  const g = deckGroup(deckIndex + 1);
  if (m.bpm && m.bpm > 0) {
    bus.set(g, DeckKeys.fileBpm, m.bpm);
  }
  if (src.libraryId != null) {
    void window.dj.libraryIncrementPlay(src.libraryId);
  }

  // cover art (background)
  if (src.coverPath) {
    void window.dj.trackCover(src.coverPath).then((cover) => {
      if (cover) {
        const url = URL.createObjectURL(new Blob([cover.data], { type: cover.mime }));
        setDeckTrack(deckIndex, { coverUrl: url });
      }
    });
  }

  // analyze if BPM/key unknown; cache results (background)
  if (!m.bpm || m.bpm <= 0 || !m.key) {
    void analysis.analyze(decoded).then((r) => {
      if (r.bpm > 0) {
        bus.set(g, DeckKeys.fileBpm, r.bpm);
        bus.set(g, DeckKeys.firstBeatFrame, r.firstBeatFrame);
      }
      if (r.camelot) setDeckTrack(deckIndex, { key: r.camelot });
      if (src.libraryId != null) {
        void window.dj.librarySetAnalysis(src.libraryId, {
          bpm: r.bpm,
          firstBeatFrame: r.firstBeatFrame,
          key: r.camelot,
          waveform: packPeaks(peaks.overview),
          analyzedAt: Date.now(),
        });
      }
    });
  }
}
