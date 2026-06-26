import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LibraryDb } from './library-db.js';
import { SqliteDb } from './sqlite.js';
import { parseSearch } from './search.js';
import { CueType } from './types.js';

describe('SqliteDb stale-lock recovery', () => {
  it('opens past an orphaned .lock directory left by a crashed run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'djlock-'));
    const dbPath = join(dir, 'library.db');
    // simulate a crash: node-sqlite3-wasm's lock dir left behind
    mkdirSync(`${dbPath}.lock`, { recursive: true });
    expect(existsSync(`${dbPath}.lock`)).toBe(true);

    // before the fix this threw "database is locked"; now it cleans + opens
    const db = new SqliteDb(dbPath);
    db.exec('CREATE TABLE t(id INTEGER)');
    db.prepare('INSERT INTO t(id) VALUES (?)').run(7);
    expect(db.prepare('SELECT id FROM t').get()).toEqual({ id: 7 });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('parseSearch', () => {
  it('empty query matches all', () => {
    expect(parseSearch('').where).toBe('1');
  });

  it('bare term searches across text fields', () => {
    const f = parseSearch('truise');
    expect(f.where).toContain('artist LIKE ?');
    expect(f.where).toContain('OR');
    expect(f.params).toEqual(['%truise%', '%truise%', '%truise%', '%truise%']);
  });

  it('field:value with alias', () => {
    const f = parseSearch('a:daft');
    expect(f.where).toBe('(artist LIKE ?)');
    expect(f.params).toEqual(['%daft%']);
  });

  it('quoted phrase keeps spaces', () => {
    const f = parseSearch('artist:"com truise"');
    expect(f.params).toEqual(['%com truise%']);
  });

  it('numeric comparison', () => {
    expect(parseSearch('bpm:>120').where).toContain('bpm > ?');
    expect(parseSearch('year:<2010').params).toEqual([2010]);
  });

  it('numeric range', () => {
    const f = parseSearch('bpm:120-130');
    expect(f.where).toContain('BETWEEN');
    expect(f.params).toEqual([120, 130]);
  });

  it('bpm exact gets a tolerance window', () => {
    const f = parseSearch('bpm:128');
    expect(f.params).toEqual([127.5, 128.5]);
  });

  it('negation', () => {
    const f = parseSearch('-genre:house');
    expect(f.where).toContain('NOT LIKE');
  });

  it('multiple terms are AND-ed', () => {
    const f = parseSearch('a:daft bpm:>120');
    expect(f.where).toContain(' AND ');
  });
});

describe('LibraryDb', () => {
  let db: LibraryDb;

  beforeEach(() => {
    db = new LibraryDb(':memory:');
  });

  function addTrack(over: Partial<Parameters<LibraryDb['upsertTrack']>[0]> = {}) {
    return db.upsertTrack({
      location: '/music/' + (over.title ?? 'x') + '.mp3',
      artist: 'Artist',
      title: 'Title',
      album: 'Album',
      genre: 'House',
      duration: 240,
      bpm: 0,
      ...over,
    } as never);
  }

  it('inserts and queries a track', () => {
    const id = addTrack({ title: 'Song A', artist: 'Daft Punk' });
    const rows = db.queryTracks();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.artist).toBe('Daft Punk');
  });

  it('tracks start with no stems; setStems records the path', () => {
    const id = addTrack({ title: 'Stemless', location: '/music/stemless.mp3' });
    expect(db.queryTracks()[0]!.stemPath).toBeNull();
    expect(db.queryTracks()[0]!.stemsGeneratedAt).toBe(0);
    expect(db.stemlessTrackIds()).toContain(id);
    expect(db.getStemPath(id)).toBeNull();

    db.setStems(id, { stemPath: '/music/stemless.stem.mp4', generatedAt: 1234 });
    const row = db.queryTracks()[0]!;
    expect(row.stemPath).toBe('/music/stemless.stem.mp4');
    expect(row.stemsGeneratedAt).toBe(1234);
    expect(db.getStemPath(id)).toBe('/music/stemless.stem.mp4');
    expect(db.stemlessTrackIds()).not.toContain(id); // now has stems
  });

  it('clearStems drops a stale link (e.g. the .stem.mp4 was deleted)', () => {
    const id = addTrack({ title: 'Gone', location: '/music/gone.mp3' });
    db.setStems(id, { stemPath: '/music/gone.stem.mp4' });
    expect(db.tracksWithStems().map((t) => t.id)).toContain(id);

    db.clearStems(id);
    expect(db.getStemPath(id)).toBeNull();
    expect(db.queryTracks().find((t) => t.id === id)!.stemsGeneratedAt).toBe(0);
    expect(db.tracksWithStems()).toHaveLength(0);
    expect(db.stemlessTrackIds()).toContain(id); // available to regenerate
  });

  it('upsert is idempotent by location', () => {
    const a = addTrack({ title: 'Same', location: '/music/same.mp3' });
    const b = addTrack({ title: 'Same', location: '/music/same.mp3' });
    expect(a).toBe(b);
    expect(db.countTracks()).toBe(1);
  });

  it('searches by field', () => {
    addTrack({ title: 'Around', artist: 'Daft Punk', location: '/m/1.mp3' });
    addTrack({ title: 'Strobe', artist: 'Deadmau5', location: '/m/2.mp3' });
    const rows = db.queryTracks({ search: 'a:daft' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Around');
  });

  it('sorts and pages', () => {
    addTrack({ title: 'B', artist: 'Bbb', location: '/m/b.mp3' });
    addTrack({ title: 'A', artist: 'Aaa', location: '/m/a.mp3' });
    addTrack({ title: 'C', artist: 'Ccc', location: '/m/c.mp3' });
    const asc = db.queryTracks({ sortColumn: 'artist' });
    expect(asc.map((t) => t.artist)).toEqual(['Aaa', 'Bbb', 'Ccc']);
    const paged = db.queryTracks({ sortColumn: 'artist', limit: 1, offset: 1 });
    expect(paged[0]!.artist).toBe('Bbb');
  });

  it('stores analysis results', () => {
    const id = addTrack({ location: '/m/an.mp3' });
    db.setAnalysis(id, { bpm: 128.5, firstBeatFrame: 1024, key: 'Am' });
    const rows = db.queryTracks();
    expect(rows[0]!.bpm).toBe(128.5);
    expect(rows[0]!.firstBeatFrame).toBe(1024);
    expect(rows[0]!.key).toBe('Am');
  });

  it('caches + reads back the waveform overview and tracks analyzed state', () => {
    const id = addTrack({ location: '/m/wf.mp3' });
    // not analyzed yet → shows up in the unanalyzed queue, no waveform
    expect(db.unanalyzedTrackIds()).toContain(id);
    expect(db.getWaveform(id)).toBeNull();

    const peaks = new Uint8Array([0, 64, 128, 255, 200, 100, 50, 10]);
    db.setAnalysis(id, { bpm: 124, waveform: peaks, analyzedAt: 1700000000 });

    const back = db.getWaveform(id);
    expect(back).not.toBeNull();
    expect([...back!]).toEqual([...peaks]);
    // now analyzed → no longer in the queue
    expect(db.unanalyzedTrackIds()).not.toContain(id);
  });

  it('stores and reads cues', () => {
    const id = addTrack({ location: '/m/cue.mp3' });
    db.setCues(id, [
      { type: CueType.HotCue, position: 1000, length: 0, hotcue: 1, label: 'drop', color: 0xff0000 },
      { type: CueType.MainCue, position: 0, length: 0, hotcue: -1, label: null, color: null },
    ]);
    const cues = db.getCues(id);
    expect(cues).toHaveLength(2);
    expect(cues.find((c) => c.hotcue === 1)?.label).toBe('drop');
  });

  it('manages crates', () => {
    const t1 = addTrack({ location: '/m/c1.mp3', title: 'T1' });
    const t2 = addTrack({ location: '/m/c2.mp3', title: 'T2' });
    const crate = db.createCrate('Favorites');
    db.addToCrate(crate, t1);
    db.addToCrate(crate, t2);
    db.addToCrate(crate, t1); // dup ignored
    expect(db.listCrates()[0]!.count).toBe(2);
    expect(db.crateTracks(crate)).toHaveLength(2);
  });

  it('manages playlists with ordering', () => {
    const t1 = addTrack({ location: '/m/p1.mp3' });
    const t2 = addTrack({ location: '/m/p2.mp3' });
    const pl = db.createPlaylist('Set 1');
    db.addToPlaylist(pl, t1);
    db.addToPlaylist(pl, t2);
    expect(db.listPlaylists()).toHaveLength(1);
  });

  it('increments play count', () => {
    const id = addTrack({ location: '/m/play.mp3' });
    db.incrementPlayCount(id);
    db.incrementPlayCount(id);
    expect(db.queryTracks()[0]!.timesPlayed).toBe(2);
  });

  it('tracks directories', () => {
    db.addDirectory('/music');
    db.addDirectory('/music'); // dup ignored
    db.addDirectory('/more');
    expect(db.listDirectories().sort()).toEqual(['/more', '/music']);
  });

  it('removeDirectory drops a watched root', () => {
    db.addDirectory('/a');
    db.addDirectory('/b');
    db.removeDirectory('/a');
    expect(db.listDirectories()).toEqual(['/b']);
  });

  it('stores + reads a directory content hash', () => {
    db.addDirectory('/music');
    expect(db.getDirHash('/music')).toBeNull();
    db.setDirHash('/music', 'abc123');
    expect(db.getDirHash('/music')).toBe('abc123');
  });

  it('app settings round-trip', () => {
    expect(db.getSetting('rescanOnStartup')).toBeNull();
    db.setSetting('rescanOnStartup', '1');
    expect(db.getSetting('rescanOnStartup')).toBe('1');
    db.setSetting('rescanOnStartup', '0'); // upsert
    expect(db.getSetting('rescanOnStartup')).toBe('0');
  });

  it('sweepMissingUnder flags tracks not seen, keeps the rest', () => {
    addTrack({ title: 'keep', location: '/music/keep.mp3' });
    addTrack({ title: 'gone', location: '/music/gone.mp3' });
    addTrack({ title: 'other', location: '/elsewhere/other.mp3' });
    const keep = new Set(['/music/keep.mp3']);
    const swept = db.sweepMissingUnder('/music', keep);
    expect(swept).toBe(1); // only /music/gone.mp3
    const paths = db.allTrackPaths();
    expect(paths.has('/music/keep.mp3')).toBe(true);
    expect(paths.has('/music/gone.mp3')).toBe(false); // swept (fs_deleted)
    expect(paths.has('/elsewhere/other.mp3')).toBe(true); // outside the root, untouched
  });

  it('markPresent un-sweeps a track', () => {
    addTrack({ title: 'back', location: '/music/back.mp3' });
    db.sweepMissingUnder('/music', new Set());
    expect(db.allTrackPaths().has('/music/back.mp3')).toBe(false);
    db.markPresent('/music/back.mp3');
    expect(db.allTrackPaths().has('/music/back.mp3')).toBe(true);
  });
});
