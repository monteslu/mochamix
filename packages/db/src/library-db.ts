/**
 * LibraryDb — the library database (Mixxx TrackCollection analog,
 * 05-library-and-data.md §1.3). Owns the SQLite connection + the repository
 * methods. Main-process only. Backed by pure-WASM SQLite (node-sqlite3-wasm via
 * the SqliteDb adapter): no native addon, no electron-rebuild, no toolchain.
 */

import { SqliteDb } from './sqlite.js';
import { migrate } from './schema.js';
import { parseSearch } from './search.js';
import { CueType, type CueRow, type TrackInput, type TrackRow } from './types.js';

export interface QueryOptions {
  search?: string;
  sortColumn?: string;
  sortDesc?: boolean;
  limit?: number;
  offset?: number;
}

const SORTABLE = new Set([
  'artist',
  'title',
  'album',
  'genre',
  'year',
  'duration',
  'bpm',
  'rating',
  'dateAdded',
  'timesPlayed',
]);

const SORT_COLUMN_SQL: Record<string, string> = {
  dateAdded: 'datetime_added',
  timesPlayed: 'timesplayed',
};

export class LibraryDb {
  private readonly db: SqliteDb;

  constructor(path: string) {
    this.db = new SqliteDb(path);
    migrate(this.db);
  }

  close(): void {
    this.db.close();
  }

  /** Raw handle (for advanced callers / tests). */
  get raw(): SqliteDb {
    return this.db;
  }

  // --- Tracks ---------------------------------------------------------------

  /**
   * Insert a track (location + metadata), or return the existing id if the
   * location is already known. Returns the track id.
   */
  upsertTrack(input: TrackInput): number {
    const insertLoc = this.db.prepare(
      `INSERT INTO track_locations (location, filename, directory, filesize)
       VALUES (@location, @filename, @directory, @filesize)
       ON CONFLICT(location) DO UPDATE SET filename=excluded.filename
       RETURNING id`,
    );
    const existing = this.db
      .prepare(`SELECT l.id FROM library l JOIN track_locations t ON l.location = t.id WHERE t.location = ?`)
      .get(input.location) as { id: number } | undefined;
    if (existing) {
      return existing.id;
    }
    const tx = this.db.transaction((inp: TrackInput) => {
      const loc = insertLoc.get({
        location: inp.location,
        filename: inp.filename ?? inp.location.split(/[\\/]/).pop() ?? '',
        directory: inp.directory ?? '',
        filesize: inp.filesize ?? 0,
      }) as { id: number };
      const info = this.db
        .prepare(
          `INSERT INTO library
           (location, artist, title, album, album_artist, genre, composer, comment,
            year, tracknumber, duration, bitrate, samplerate, channels, filetype)
           VALUES
           (@location, @artist, @title, @album, @albumArtist, @genre, @composer, @comment,
            @year, @trackNumber, @duration, @bitrate, @samplerate, @channels, @filetype)`,
        )
        .run({
          location: loc.id,
          artist: inp.artist ?? null,
          title: inp.title ?? null,
          album: inp.album ?? null,
          albumArtist: inp.albumArtist ?? null,
          genre: inp.genre ?? null,
          composer: inp.composer ?? null,
          comment: inp.comment ?? null,
          year: inp.year ?? null,
          trackNumber: inp.trackNumber ?? null,
          duration: inp.duration ?? null,
          bitrate: inp.bitrate ?? null,
          samplerate: inp.samplerate ?? null,
          channels: inp.channels ?? null,
          filetype: inp.filetype ?? null,
        });
      return Number(info.lastInsertRowid);
    });
    return tx(input);
  }

  /** Update analysis results on a track. */
  setAnalysis(
    trackId: number,
    a: {
      bpm?: number;
      firstBeatFrame?: number;
      key?: string;
      /** Overview peaks (one Uint8 per bucket) to cache for the mini-waveform. */
      waveform?: Uint8Array;
      analyzedAt?: number;
    },
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id: trackId };
    if (a.bpm !== undefined) {
      sets.push('bpm = @bpm');
      params.bpm = a.bpm;
    }
    if (a.firstBeatFrame !== undefined) {
      sets.push('first_beat_frame = @fbf');
      params.fbf = a.firstBeatFrame;
    }
    if (a.key !== undefined) {
      sets.push('key = @key');
      params.key = a.key;
    }
    if (a.waveform !== undefined) {
      sets.push('waveform = @wf', 'waveform_buckets = @wfb');
      params.wf = a.waveform;
      params.wfb = a.waveform.length;
    }
    if (a.analyzedAt !== undefined) {
      sets.push('analyzed_at = @at');
      params.at = a.analyzedAt;
    }
    if (sets.length === 0) {
      return;
    }
    this.db.prepare(`UPDATE library SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  /** Record a generated .stem.mp4 for a track (path + timestamp). */
  setStems(trackId: number, s: { stemPath: string; generatedAt?: number }): void {
    this.db
      .prepare('UPDATE library SET stem_path = @p, stems_generated_at = @at WHERE id = @id')
      .run({ id: trackId, p: s.stemPath, at: s.generatedAt ?? Date.now() });
  }

  /** Clear a track's stems link (e.g. the .stem.mp4 was deleted off disk). */
  clearStems(trackId: number): void {
    this.db
      .prepare('UPDATE library SET stem_path = NULL, stems_generated_at = 0 WHERE id = @id')
      .run({ id: trackId });
  }

  /** All (id, stem_path) rows that have a stems link, for staleness checks. */
  tracksWithStems(): Array<{ id: number; stemPath: string }> {
    return (
      this.db
        .prepare(
          `SELECT l.id, l.stem_path AS stemPath FROM library l
           WHERE l.stem_path IS NOT NULL AND l.stem_path != ''`,
        )
        .all() as Array<{ id: number; stemPath: string }>
    );
  }

  /** The generated stem file path for a track, or null if none. */
  getStemPath(trackId: number): string | null {
    const row = this.db
      .prepare('SELECT stem_path FROM library WHERE id = ?')
      .get(trackId) as { stem_path: string | null } | undefined;
    return row?.stem_path ?? null;
  }

  /** Track ids that have NO generated stems yet (for a stem-generation queue). */
  stemlessTrackIds(limit = 500): number[] {
    return (
      this.db
        .prepare(
          `SELECT l.id FROM library l JOIN track_locations t ON l.location = t.id
           WHERE l.mixxx_deleted = 0 AND t.fs_deleted = 0
             AND COALESCE(l.stems_generated_at, 0) = 0
           LIMIT ?`,
        )
        .all(limit) as Array<{ id: number }>
    ).map((r) => r.id);
  }

  /** Cached overview peaks for a track (one Uint8 per bucket), or null. */
  getWaveform(trackId: number): Uint8Array | null {
    const row = this.db
      .prepare('SELECT waveform FROM library WHERE id = ?')
      .get(trackId) as { waveform: Uint8Array | null } | undefined;
    const wf = row?.waveform ?? null;
    return wf && wf.length > 0 ? new Uint8Array(wf) : null;
  }

  /** Track ids that have NOT been analyzed yet (for the background queue). */
  unanalyzedTrackIds(limit = 500): number[] {
    return (
      this.db
        .prepare(
          `SELECT l.id FROM library l JOIN track_locations t ON l.location = t.id
           WHERE l.mixxx_deleted = 0 AND t.fs_deleted = 0 AND COALESCE(l.analyzed_at, 0) = 0
           LIMIT ?`,
        )
        .all(limit) as Array<{ id: number }>
    ).map((r) => r.id);
  }

  /** Query tracks with search/sort/paging. */
  queryTracks(opts: QueryOptions = {}): TrackRow[] {
    const search = parseSearch(opts.search ?? '');
    let sql = `
      SELECT l.id, t.location, t.filename,
             l.artist, l.title, l.album, l.genre, l.year,
             l.duration, l.bitrate, l.samplerate,
             l.bpm, l.first_beat_frame AS firstBeatFrame,
             l.key, l.rating, l.color, l.datetime_added AS dateAdded,
             l.timesplayed AS timesPlayed, l.filetype,
             l.stem_path AS stemPath, l.stems_generated_at AS stemsGeneratedAt
      FROM library l JOIN track_locations t ON l.location = t.id
      WHERE l.mixxx_deleted = 0 AND t.fs_deleted = 0 AND (${search.where})`;
    const params: unknown[] = [...search.params];

    const sortCol = opts.sortColumn && SORTABLE.has(opts.sortColumn) ? opts.sortColumn : 'artist';
    const sqlCol = SORT_COLUMN_SQL[sortCol] ?? sortCol;
    sql += ` ORDER BY ${sqlCol} ${opts.sortDesc ? 'DESC' : 'ASC'}`;
    if (opts.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
      if (opts.offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(opts.offset);
      }
    }
    return this.db.prepare(sql).all(...params) as unknown as TrackRow[];
  }

  getTrack(id: number): TrackRow | undefined {
    return this.queryTracks().find((t) => t.id === id);
  }

  countTracks(search?: string): number {
    const frag = parseSearch(search ?? '');
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM library l JOIN track_locations t ON l.location = t.id
         WHERE l.mixxx_deleted = 0 AND t.fs_deleted = 0 AND (${frag.where})`,
      )
      .get(...frag.params) as { n: number };
    return row.n;
  }

  incrementPlayCount(id: number): void {
    this.db
      .prepare(
        `UPDATE library SET timesplayed = timesplayed + 1, played = 1,
         last_played_at = datetime('now') WHERE id = ?`,
      )
      .run(id);
  }

  // --- Cues -----------------------------------------------------------------

  setCues(trackId: number, cues: Array<Omit<CueRow, 'id' | 'trackId'>>): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM cues WHERE track_id = ?').run(trackId);
      const ins = this.db.prepare(
        `INSERT INTO cues (track_id, type, position, length, hotcue, label, color)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const c of cues) {
        ins.run(trackId, c.type, c.position, c.length, c.hotcue, c.label, c.color);
      }
    });
    tx();
  }

  getCues(trackId: number): CueRow[] {
    return this.db
      .prepare(
        `SELECT id, track_id AS trackId, type, position, length, hotcue, label, color
         FROM cues WHERE track_id = ?`,
      )
      .all(trackId) as unknown as CueRow[];
  }

  // --- Crates ---------------------------------------------------------------

  createCrate(name: string): number {
    const info = this.db.prepare('INSERT INTO crates (name) VALUES (?)').run(name);
    return Number(info.lastInsertRowid);
  }

  listCrates(): Array<{ id: number; name: string; count: number }> {
    return this.db
      .prepare(
        `SELECT c.id, c.name, COUNT(ct.track_id) AS count
         FROM crates c LEFT JOIN crate_tracks ct ON ct.crate_id = c.id
         GROUP BY c.id ORDER BY c.name`,
      )
      .all() as Array<{ id: number; name: string; count: number }>;
  }

  addToCrate(crateId: number, trackId: number): void {
    this.db
      .prepare('INSERT OR IGNORE INTO crate_tracks (crate_id, track_id) VALUES (?, ?)')
      .run(crateId, trackId);
  }

  crateTracks(crateId: number): TrackRow[] {
    const ids = this.db
      .prepare('SELECT track_id FROM crate_tracks WHERE crate_id = ?')
      .all(crateId) as Array<{ track_id: number }>;
    const set = new Set(ids.map((r) => r.track_id));
    return this.queryTracks().filter((t) => set.has(t.id));
  }

  // --- Playlists ------------------------------------------------------------

  createPlaylist(name: string, hidden = 0): number {
    const info = this.db
      .prepare('INSERT INTO playlists (name, hidden) VALUES (?, ?)')
      .run(name, hidden);
    return Number(info.lastInsertRowid);
  }

  listPlaylists(): Array<{ id: number; name: string; hidden: number }> {
    return this.db
      .prepare('SELECT id, name, hidden FROM playlists WHERE hidden = 0 ORDER BY name')
      .all() as Array<{ id: number; name: string; hidden: number }>;
  }

  addToPlaylist(playlistId: number, trackId: number): void {
    const pos = this.db
      .prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM playlist_tracks WHERE playlist_id = ?')
      .get(playlistId) as { p: number };
    this.db
      .prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)')
      .run(playlistId, trackId, pos.p);
  }

  // --- Directories ----------------------------------------------------------

  addDirectory(dir: string): void {
    this.db.prepare('INSERT OR IGNORE INTO directories (directory) VALUES (?)').run(dir);
  }

  listDirectories(): string[] {
    return (this.db.prepare('SELECT directory FROM directories').all() as Array<{ directory: string }>).map(
      (r) => r.directory,
    );
  }
}

export { CueType };
