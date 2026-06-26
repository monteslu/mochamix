/**
 * Shared IPC type contracts between main and renderer (the only types both sides
 * import). Keeping them here avoids the renderer typecheck pulling in the CJS
 * preload file.
 */

export interface LoadedFile {
  name: string;
  data: ArrayBuffer;
  /** Absolute path (when known), so cover art can be read. */
  path?: string;
  /** True when `data` is a generated NI-Stems .stem.mp4 (4 separable stems). */
  isStem?: boolean;
}

/** A library track row (mirrors @dj/db TrackRow; kept local to avoid a
 * renderer dependency on the main-only db package). */
export interface LibTrack {
  id: number;
  location: string;
  filename: string;
  artist: string | null;
  title: string | null;
  album: string | null;
  genre: string | null;
  year: string | null;
  duration: number | null;
  bitrate: number | null;
  bpm: number;
  firstBeatFrame: number;
  key: string | null;
  rating: number;
  timesPlayed: number;
  filetype: string | null;
  /** Path to the generated .stem.mp4, or null. Non-null = stems ready. */
  stemPath: string | null;
  /** Epoch ms stems were generated; 0 = none. */
  stemsGeneratedAt: number;
}

export interface LibQuery {
  search?: string;
  sortColumn?: string;
  sortDesc?: boolean;
  limit?: number;
  offset?: number;
}

export interface ScanSummary {
  scanned: number;
  added: number;
}
export interface ScanProgress {
  scanned: number;
  added: number;
  current: string;
}

export interface DjApi {
  /** Open a file dialog and return the chosen track's bytes (or null). */
  openTrack: () => Promise<LoadedFile | null>;
  /** Read a dropped file path's bytes. */
  readTrack: (path: string) => Promise<LoadedFile>;

  // library
  libraryQuery: (q: LibQuery) => Promise<LibTrack[]>;
  libraryCount: (search?: string) => Promise<number>;
  libraryScan: () => Promise<ScanSummary | null>;
  onScanProgress: (cb: (p: ScanProgress) => void) => () => void;
  readTrackById: (id: number) => Promise<LoadedFile | null>;
  librarySetAnalysis: (
    id: number,
    a: { bpm?: number; firstBeatFrame?: number; key?: string; waveform?: Uint8Array; analyzedAt?: number },
  ) => Promise<void>;
  /** Cached overview peaks (Uint8 per bucket) for a track, or null. */
  libraryWaveform: (id: number) => Promise<Uint8Array | null>;
  /** Track ids not yet analyzed (for the background queue). */
  libraryUnanalyzed: (limit?: number) => Promise<number[]>;
  libraryIncrementPlay: (id: number) => Promise<void>;

  /** Save a recording (WAV bytes) to disk; returns the path or null if canceled. */
  saveRecording: (wav: ArrayBuffer) => Promise<string | null>;

  /** Read embedded cover art for a file path; returns bytes + mime, or null. */
  trackCover: (path: string) => Promise<{ data: ArrayBuffer; mime: string } | null>;
}
