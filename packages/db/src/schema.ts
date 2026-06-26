/**
 * Database schema + migrations (Mixxx schema.xml analog, 05-library-and-data.md
 * §1). Versioned, ordered migrations keyed by PRAGMA user_version — same idea as
 * Mixxx's revision log + min_compatible. Streamlined to the tables we need now;
 * grows by appending migrations (never edit an applied one).
 *
 * Table layout mirrors Mixxx so a future importer/exporter can interop:
 *   track_locations  — physical file identity (one row per path)
 *   library          — track metadata + analysis state (FK location → track_locations)
 *   cues             — cue points (hotcues, main cue, loops) typed by `type`
 *   crates/crate_tracks       — unordered tag collections
 *   playlists/playlist_tracks — ordered lists (hidden flag: 0 normal, 1 autodj, 2 history)
 *   directories      — watched roots
 */

import type { SqliteDb } from './sqlite.js';

export interface Migration {
  version: number;
  description: string;
  up: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'initial schema',
    up: `
      CREATE TABLE track_locations (
        id INTEGER PRIMARY KEY,
        location TEXT UNIQUE NOT NULL,
        filename TEXT,
        directory TEXT,
        filesize INTEGER,
        fs_deleted INTEGER DEFAULT 0
      );

      CREATE TABLE library (
        id INTEGER PRIMARY KEY,
        location INTEGER UNIQUE REFERENCES track_locations(id),
        artist TEXT, title TEXT, album TEXT, album_artist TEXT,
        genre TEXT, composer TEXT, grouping TEXT, comment TEXT,
        year TEXT, tracknumber TEXT,
        duration REAL, bitrate INTEGER, samplerate INTEGER, channels INTEGER,
        filetype TEXT,
        bpm REAL DEFAULT 0,
        bpm_locked INTEGER DEFAULT 0,
        first_beat_frame REAL DEFAULT -1,
        key TEXT,
        key_id INTEGER DEFAULT 0,
        replaygain REAL DEFAULT 0,
        replaygain_peak REAL DEFAULT -1,
        cuepoint REAL DEFAULT -1,
        rating INTEGER DEFAULT 0,
        color INTEGER,
        datetime_added TEXT DEFAULT (datetime('now')),
        played INTEGER DEFAULT 0,
        timesplayed INTEGER DEFAULT 0,
        last_played_at TEXT,
        mixxx_deleted INTEGER DEFAULT 0
      );
      CREATE INDEX idx_library_artist ON library(artist);
      CREATE INDEX idx_library_title ON library(title);
      CREATE INDEX idx_library_bpm ON library(bpm);

      CREATE TABLE cues (
        id INTEGER PRIMARY KEY,
        track_id INTEGER NOT NULL REFERENCES library(id) ON DELETE CASCADE,
        type INTEGER NOT NULL,
        position REAL DEFAULT -1,
        length REAL DEFAULT 0,
        hotcue INTEGER DEFAULT -1,
        label TEXT,
        color INTEGER
      );
      CREATE INDEX idx_cues_track ON cues(track_id);

      CREATE TABLE crates (
        id INTEGER PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        count INTEGER DEFAULT 0,
        autodj_source INTEGER DEFAULT 0
      );
      CREATE TABLE crate_tracks (
        crate_id INTEGER NOT NULL REFERENCES crates(id) ON DELETE CASCADE,
        track_id INTEGER NOT NULL REFERENCES library(id) ON DELETE CASCADE,
        UNIQUE(crate_id, track_id)
      );

      CREATE TABLE playlists (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        position INTEGER,
        hidden INTEGER DEFAULT 0,
        date_created TEXT DEFAULT (datetime('now')),
        date_modified TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE playlist_tracks (
        id INTEGER PRIMARY KEY,
        playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        track_id INTEGER NOT NULL REFERENCES library(id) ON DELETE CASCADE,
        position INTEGER
      );
      CREATE INDEX idx_pltracks_pl ON playlist_tracks(playlist_id);

      CREATE TABLE directories (
        directory TEXT PRIMARY KEY
      );
    `,
  },
  {
    version: 2,
    description: 'cached waveform overview + analysis timestamp',
    up: `
      -- compressed overview peaks (Uint8 per bucket), so the library can show a
      -- mini-waveform and decks can skip recompute. NULL = not analyzed yet.
      ALTER TABLE library ADD COLUMN waveform BLOB;
      ALTER TABLE library ADD COLUMN waveform_buckets INTEGER DEFAULT 0;
      ALTER TABLE library ADD COLUMN analyzed_at INTEGER DEFAULT 0;
    `,
  },
  {
    version: 3,
    description: 'generated stems (.stem.mp4)',
    up: `
      -- Path to the generated NI-Stems .stem.mp4 for this track (Demucs/WebGPU). When
      -- set, the track is preferred from this file (4 independently-controllable stems
      -- for live mashups) over the original. The original file is kept, not deleted.
      -- NULL/0 = no stems yet.
      ALTER TABLE library ADD COLUMN stem_path TEXT;
      ALTER TABLE library ADD COLUMN stems_generated_at INTEGER DEFAULT 0;
    `,
  },
  {
    version: 4,
    description: 'downbeat positions (real measures from qm-dsp DownBeat)',
    up: `
      -- Bar-start beat positions (downbeats) as a packed Int32 blob of source frames.
      -- From Mixxx's DownBeat analyzer, so the waveform draws REAL measure markers
      -- instead of assuming every 4th beat. NULL = no downbeats detected.
      ALTER TABLE library ADD COLUMN downbeats BLOB;
    `,
  },
  {
    version: 5,
    description: 'per-stem overview waveforms (colored stem thumbnails)',
    up: `
      -- Packed per-stem OVERVIEW peaks (drums/bass/other/vocals) so the library
      -- thumbnail can render the colored 4-stem wave (not just the mixdown). Format:
      -- [int32 bucketCount][int32 sharedScaleQ8][4 × bucketCount uint8 stem peaks].
      -- NULL = not computed (no stems, or not yet backfilled).
      ALTER TABLE library ADD COLUMN stem_waveforms BLOB;
    `,
  },
];

export const REQUIRED_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/**
 * Apply pending migrations to bring the DB up to REQUIRED_VERSION. Uses
 * PRAGMA user_version as the stored schema version (Mixxx's settings('version')
 * equivalent). Idempotent.
 */
export function migrate(db: SqliteDb): void {
  // node-sqlite3-wasm's WASM VFS doesn't truly support WAL (it silently falls back
  // to rollback-journal anyway), so ask for what we actually get. WAL also adds
  // -wal/-shm sidecars that complicate the lock story.
  db.pragma('journal_mode = DELETE');
  db.pragma('foreign_keys = ON');
  const current = db.pragma('user_version', { simple: true }) as number;
  const pending = MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  for (const m of pending) {
    const tx = db.transaction(() => {
      db.exec(m.up);
      db.pragma(`user_version = ${m.version}`);
    });
    tx();
  }
}
