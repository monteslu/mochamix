/**
 * LibraryService — the main-process library: owns the LibraryDb and the folder
 * scanner. The renderer talks to it over IPC (see ipc handlers in main.ts).
 *
 * Scanning walks a directory, reads tags via music-metadata, and upserts tracks.
 * It runs in the main process (Node) because better-sqlite3 + fs live there.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, extname, basename, dirname } from 'node:path';
import { parseFile } from 'music-metadata';
import { LibraryDb, type TrackRow, type QueryOptions } from '@dj/db';

const AUDIO_EXTS = new Set([
  '.mp3',
  '.flac',
  '.wav',
  '.aiff',
  '.aif',
  '.m4a',
  '.mp4',
  '.aac',
  '.ogg',
  '.oga',
  '.opus',
]);

export interface ScanProgress {
  scanned: number;
  added: number;
  current: string;
}

export class LibraryService {
  readonly db: LibraryDb;

  constructor(dbPath: string) {
    this.db = new LibraryDb(dbPath);
  }

  query(opts: QueryOptions): TrackRow[] {
    return this.db.queryTracks(opts);
  }

  count(search?: string): number {
    return this.db.countTracks(search);
  }

  listCrates() {
    return this.db.listCrates();
  }

  crateTracks(id: number) {
    return this.db.crateTracks(id);
  }

  /**
   * Recursively scan a directory, adding audio files to the library. Calls
   * onProgress periodically. Returns the count added.
   */
  async scanDirectory(
    root: string,
    onProgress?: (p: ScanProgress) => void,
  ): Promise<{ scanned: number; added: number }> {
    this.db.addDirectory(root);
    let scanned = 0;
    let added = 0;

    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && AUDIO_EXTS.has(extname(entry.name).toLowerCase())) {
          scanned++;
          const ok = await this.addFile(full);
          if (ok) {
            added++;
          }
          if (onProgress && scanned % 10 === 0) {
            onProgress({ scanned, added, current: entry.name });
          }
        }
      }
    };

    await walk(root);
    onProgress?.({ scanned, added, current: 'done' });
    return { scanned, added };
  }

  /** Add (or refresh) a single file. Returns true if newly added. */
  private async addFile(path: string): Promise<boolean> {
    try {
      const existing = this.db
        .queryTracks()
        .some((t) => t.location === path);
      const meta = await parseFile(path, { duration: true, skipCovers: true });
      const st = await stat(path);
      const common = meta.common;
      const fmt = meta.format;
      this.db.upsertTrack({
        location: path,
        filename: basename(path),
        directory: dirname(path),
        filesize: st.size,
        artist: common.artist ?? null,
        title: common.title ?? basename(path, extname(path)),
        album: common.album ?? null,
        albumArtist: common.albumartist ?? null,
        genre: common.genre?.[0] ?? null,
        comment: common.comment?.[0]?.text ?? null,
        year: common.year ? String(common.year) : null,
        trackNumber: common.track?.no ? String(common.track.no) : null,
        duration: fmt.duration ?? null,
        bitrate: fmt.bitrate ? Math.round(fmt.bitrate / 1000) : null,
        samplerate: fmt.sampleRate ?? null,
        channels: fmt.numberOfChannels ?? null,
        filetype: extname(path).slice(1).toLowerCase(),
      });
      return !existing;
    } catch {
      // Unreadable/corrupt file — skip it.
      return false;
    }
  }

  setAnalysis(
    trackId: number,
    a: { bpm?: number; firstBeatFrame?: number; key?: string; waveform?: Uint8Array; analyzedAt?: number },
  ): void {
    this.db.setAnalysis(trackId, a);
  }

  getWaveform(trackId: number): Uint8Array | null {
    return this.db.getWaveform(trackId);
  }

  unanalyzedTrackIds(limit?: number): number[] {
    return this.db.unanalyzedTrackIds(limit);
  }

  /** Extract the embedded cover image for a file path. Returns {data, mime} or null. */
  async getCover(path: string): Promise<{ data: ArrayBuffer; mime: string } | null> {
    try {
      const meta = await parseFile(path, { skipCovers: false });
      const pic = meta.common.picture?.[0];
      if (!pic) return null;
      const u8 = pic.data;
      const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      return { data: ab as ArrayBuffer, mime: pic.format || 'image/jpeg' };
    } catch {
      return null;
    }
  }

  incrementPlayCount(id: number): void {
    this.db.incrementPlayCount(id);
  }

  close(): void {
    this.db.close();
  }
}
