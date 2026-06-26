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
  /** Stored library metadata (key/bpm/title/…) so the deck shows it without re-analyzing. */
  meta?: {
    title?: string;
    artist?: string;
    album?: string;
    key?: string;
    bpm?: number;
  };
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
  /** Tracks flagged deleted by the sweep (sync only; undefined for a plain add). */
  removed?: number;
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
  /** Sync the whole library: rescan all known folders, add new, sweep deleted. */
  librarySync: () => Promise<ScanSummary>;
  /** The watched music folders (roots). */
  libraryDirectories: () => Promise<string[]>;
  /** Pick + add a music folder, scan it. Returns the scan summary (or null if canceled). */
  libraryAddDirectory: () => Promise<ScanSummary | null>;
  /** Stop watching a folder (its tracks are swept on the next sync). */
  libraryRemoveDirectory: (dir: string) => Promise<void>;
  onScanProgress: (cb: (p: ScanProgress) => void) => () => void;
  /** App settings (key/value) — e.g. 'rescanOnStartup'. */
  settingsGet: (key: string) => Promise<string | null>;
  settingsSet: (key: string, value: string) => Promise<void>;
  /** The bundled Mixxx controller mappings (picker index). */
  controllersList: () => Promise<Array<{ file: string; name: string; author: string }>>;
  /** Read one bundled controller file's text (mapping .xml or referenced .js), or null. */
  controllersReadFile: (filename: string) => Promise<string | null>;
  /** Load a track's bytes. preferOriginal=true returns the original song file even if
   *  stems exist (for analysis — smaller + decodes reliably; stems are for playback). */
  readTrackById: (id: number, preferOriginal?: boolean) => Promise<LoadedFile | null>;
  librarySetAnalysis: (
    id: number,
    a: {
      bpm?: number;
      firstBeatFrame?: number;
      key?: string;
      waveform?: Uint8Array;
      downbeats?: Uint8Array;
      analyzedAt?: number;
    },
  ) => Promise<void>;
  /** Cached overview peaks (Uint8 per bucket) for a track, or null. */
  libraryWaveform: (id: number) => Promise<Uint8Array | null>;
  /** Packed Int32 downbeat frames (real measures) for a track, or null. */
  libraryDownbeats: (id: number) => Promise<Uint8Array | null>;
  /** Packed per-stem overview waveforms (colored thumbnail), or null if not computed. */
  libraryStemWaveforms: (id: number) => Promise<Uint8Array | null>;
  /** Persist the packed per-stem overview waveforms for a track. */
  librarySetStemWaveforms: (id: number, blob: Uint8Array) => Promise<void>;
  /** Stem-track ids with no cached per-stem overview yet (for the thumbnail backfill). */
  libraryStemsNeedingWaveforms: (limit?: number) => Promise<number[]>;
  /** Track ids not yet analyzed (for the background queue). */
  libraryUnanalyzed: (limit?: number) => Promise<number[]>;
  /** Mark every track unanalyzed so the queue re-analyzes the whole collection. Returns the count reset. */
  libraryReanalyzeAll: () => Promise<number>;
  /** Track ids with no generated stems yet (for the stem-generation queue). */
  libraryStemless: (limit?: number) => Promise<number[]>;
  libraryIncrementPlay: (id: number) => Promise<void>;
  /** Save generated .stem.mp4 bytes next to the track + link it. Returns the path. */
  saveStems: (id: number, data: ArrayBuffer) => Promise<string | null>;

  /** Save a recording (WAV bytes) to disk; returns the path or null if canceled. */
  saveRecording: (wav: ArrayBuffer) => Promise<string | null>;

  /** Read embedded cover art for a file path; returns bytes + mime, or null. */
  trackCover: (path: string) => Promise<{ data: ArrayBuffer; mime: string } | null>;
}
