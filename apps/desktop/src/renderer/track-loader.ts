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

import { decodeArrayBuffer } from '@dj/codec';
import { computePeakSet, detailBucketsForDuration, packPeaks } from '@dj/waveform';
import { deck as deckGroup, DeckKeys, type ControlBus } from '@dj/control-bus';
import type { Engine } from '@dj/audio-engine';
import { extractAllTracks } from '@dj/stem-mp4';
import type { AnalysisService } from './analysis-service.js';
import { setDeckTrack } from './deck-state.js';

export interface TrackLoaderDeps {
  engine: Engine;
  bus: ControlBus;
  analysis: AnalysisService;
}

/** Where the audio bytes come from + the metadata we already know. */
export interface LoadSource {
  /** Raw file bytes + name (decode input). isStem = a NI-Stems .stem.mp4. */
  file: { name: string; data: ArrayBuffer; path?: string; isStem?: boolean };
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

  // Stem deck: a .stem.mp4 holds the mixdown + 4 separable stems. Decode the 4 stems
  // and load them as a stem deck (independent per-stem gain → live mashups).
  if (src.file.isStem) {
    const loaded = await loadStemFile(deps, deckIndex, src);
    if (loaded) return;
    // If stem extraction failed, fall through to play it as a normal mixed track.
  }

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
    stemPeaks: null, // a normal track clears any prior stem-deck coloring
    stemScales: null,
    downbeatFrames: null, // cleared; loaded from DB below if analyzed
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
    // Load cached downbeats (real measures from DownBeat) if analyzed.
    void window.dj.libraryDownbeats(src.libraryId).then((blob) => {
      if (blob && blob.length >= 4) {
        const u = new Uint8Array(blob);
        setDeckTrack(deckIndex, {
          downbeatFrames: new Int32Array(u.buffer, u.byteOffset, u.byteLength >> 2),
        });
      }
    });
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

/**
 * Load a .stem.mp4 as a stem deck: extract its 4 stem tracks (drums/bass/other/
 * vocals — track 0 is the mixdown, skipped), decode each, and hand them to the
 * engine for independent per-stem mixing. Peaks/waveform come from the mixdown
 * (track 0). Returns true on success, false to fall back to normal playback.
 */
async function loadStemFile(
  deps: TrackLoaderDeps,
  deckIndex: number,
  src: LoadSource,
): Promise<boolean> {
  const { engine, bus, analysis } = deps;
  const ctx = engine.audioContext;
  if (!ctx) return false;
  try {
    const tracks = extractAllTracks(new Uint8Array(src.file.data));
    // STEMS-4 layout: [mixdown, drums, bass, other, vocals]. Need all 5.
    if (tracks.length < 5) return false;
    const mixdown = tracks[0]!;
    const stemBytes = tracks.slice(1, 5);

    // Decode the 4 stems (each a standalone AAC m4a) to planar Float32.
    const stems = await Promise.all(
      stemBytes.map((b) => {
        const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
        return decodeArrayBuffer(ctx, ab, 'stem.m4a');
      }),
    );

    // Waveform peaks from the mixdown (what the DJ sees on the lane).
    const mixAb = mixdown.buffer.slice(
      mixdown.byteOffset,
      mixdown.byteOffset + mixdown.byteLength,
    ) as ArrayBuffer;
    const mixDecoded = await decodeArrayBuffer(ctx, mixAb, 'mixdown.m4a');
    const all = new Float32Array(mixDecoded.sampleBuffer);
    const ch: Float32Array[] = [];
    for (let c = 0; c < mixDecoded.channels; c++) {
      ch.push(all.subarray(c * mixDecoded.frames, (c + 1) * mixDecoded.frames));
    }
    const dur = mixDecoded.frames / mixDecoded.sampleRate;
    const detailBuckets = detailBucketsForDuration(dur);
    const peaks = computePeakSet(ch, mixDecoded.frames, detailBuckets, mixDecoded.sampleRate);

    // Per-stem detail peaks so the waveform colors each stem (the mashup view).
    const stemPeaks = stems.map((s) => {
      const sAll = new Float32Array(s.sampleBuffer);
      const sCh: Float32Array[] = [];
      for (let c = 0; c < s.channels; c++) sCh.push(sAll.subarray(c * s.frames, (c + 1) * s.frames));
      return computePeakSet(sCh, s.frames, detailBuckets, s.sampleRate).detail;
    });
    // Normalize all stems by ONE shared max (the loudest stem), like Mixxx
    // (waveformrendererstem: height / m_maxValue with a single m_maxValue). The
    // loudest stem fills the lane; quieter stems stay proportionally shorter, so the
    // wave is honest about the real mix (drums dwarf a near-silent vocal, as they do
    // in the audio). Same scale for every stem.
    let sharedMax = 1;
    for (const p of stemPeaks) {
      for (let i = 0; i < p.peaks.length; i++) if (p.peaks[i]! > sharedMax) sharedMax = p.peaks[i]!;
    }
    const sharedScale = 255 / sharedMax;
    const stemScales = stemPeaks.map(() => sharedScale);

    const m = src.meta ?? {};
    setDeckTrack(deckIndex, {
      peaks,
      stemPeaks,
      stemScales,
      title: m.title ?? src.file.name.replace(/\.[^.]+$/, ''),
      artist: m.artist ?? null,
      album: m.album ?? null,
      key: m.key ?? null,
      coverUrl: null,
    });

    engine.loadStems(deckIndex, stems, { bpm: m.bpm });
    const g = deckGroup(deckIndex + 1);
    if (m.bpm && m.bpm > 0) bus.set(g, DeckKeys.fileBpm, m.bpm);

    // Background analysis of the mixdown for bpm/grid if unknown (so sync works).
    if (!m.bpm || m.bpm <= 0) {
      void analysis.analyze(mixDecoded).then((r) => {
        if (r.bpm > 0) {
          bus.set(g, DeckKeys.fileBpm, r.bpm);
          bus.set(g, DeckKeys.firstBeatFrame, r.firstBeatFrame);
        }
      });
    }
    return true;
  } catch (e) {
    console.error('[stems] failed to load stem file, falling back to mixed playback', e);
    return false;
  }
}
