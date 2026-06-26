/**
 * LibraryService — the main-process library: owns the LibraryDb and the folder
 * scanner. The renderer talks to it over IPC (see ipc handlers in main.ts).
 *
 * Scanning walks a directory, reads tags via music-metadata, and upserts tracks.
 * It runs in the main process (Node) because better-sqlite3 + fs live there.
 */

import { readdir, stat, access } from 'node:fs/promises';
import { join, extname, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
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

/** The NI-Stems file suffix. A `<base>.stem.mp4` is the generated stems for `<base>`. */
const STEM_SUFFIX = '.stem.mp4';

/** Is this path a generated stems artifact (not a standalone track)? */
function isStemFile(name: string): boolean {
  return name.toLowerCase().endsWith(STEM_SUFFIX);
}

/**
 * The original-track basename a stem file belongs to. `foo.stem.mp4` → `foo` (it
 * was generated from `foo.mp3`/`foo.wav`/etc, which keep their own basename).
 */
function stemBaseName(stemPath: string): string {
  return basename(stemPath).slice(0, -STEM_SUFFIX.length);
}

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
  /** Scan a single folder (add it as a watched root) and sync it. */
  async scanDirectory(
    root: string,
    onProgress?: (p: ScanProgress) => void,
  ): Promise<{ scanned: number; added: number }> {
    this.db.addDirectory(root);
    return this.syncRoots([root], onProgress, /* useHash */ false);
  }

  /**
   * Sync the WHOLE library: re-walk every watched root, add new tracks, re-mark found
   * tracks present, and sweep (flag deleted) anything gone from disk. Mixxx's model
   * (LibraryScanner): rescan known directories, verify, mark-unverified-as-deleted.
   */
  async syncLibrary(
    onProgress?: (p: ScanProgress) => void,
  ): Promise<{ scanned: number; added: number; removed: number }> {
    const roots = this.db.listDirectories();
    const r = await this.syncRoots(roots, onProgress, /* useHash */ true);
    await this.pruneMissingStems();
    return r;
  }

  /**
   * Core sync over a set of roots. `useHash` skips folders whose content hash is
   * unchanged since the last sync (Mixxx LibraryHashes) — fast rescans on big
   * libraries. Always does the verify-and-sweep so deletions are reflected.
   */
  private async syncRoots(
    roots: string[],
    onProgress: ((p: ScanProgress) => void) | undefined,
    useHash: boolean,
  ): Promise<{ scanned: number; added: number; removed: number }> {
    let scanned = 0;
    let added = 0;
    // Load existing paths ONCE (was an O(n²) per-file library scan before).
    const existing = this.db.allTrackPaths();
    // Every audio file we SEE this sync, per root, so we can sweep the rest.
    const seenByRoot = new Map<string, Set<string>>();
    const stemFiles: string[] = [];

    const walk = async (root: string, dir: string, seen: Set<string>): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      // Directory-content hash: names + sizes + mtimes of audio files here. If
      // unchanged since last sync we can skip re-parsing tags for this folder (but we
      // still record the files as "seen" so the sweep doesn't wrongly delete them).
      const sig: string[] = [];
      const audioHere: Array<{ full: string; name: string; size: number; mtime: number }> = [];
      const subdirs: string[] = [];
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          subdirs.push(full);
        } else if (entry.isFile() && isStemFile(entry.name)) {
          stemFiles.push(full);
        } else if (entry.isFile() && AUDIO_EXTS.has(extname(entry.name).toLowerCase())) {
          let size = 0;
          let mtime = 0;
          try {
            const st = await stat(full);
            size = st.size;
            mtime = Math.floor(st.mtimeMs);
          } catch {
            /* ignore */
          }
          audioHere.push({ full, name: entry.name, size, mtime });
          sig.push(`${entry.name}:${size}:${mtime}`);
          seen.add(full);
        }
      }

      const hash = createHash('sha1').update(sig.sort().join('|')).digest('hex');
      const unchanged = useHash && audioHere.length > 0 && this.db.getDirHash(dir) === hash;
      if (!unchanged) {
        for (const a of audioHere) {
          scanned++;
          const isNew = !existing.has(a.full);
          if (await this.addFile(a.full, isNew)) added++;
          if (isNew) existing.add(a.full);
          if (onProgress && scanned % 10 === 0) onProgress({ scanned, added, current: a.name });
        }
        this.db.setDirHash(dir, hash);
      } else {
        scanned += audioHere.length; // counted as seen, not re-parsed
      }

      for (const sub of subdirs) await walk(root, sub, seen);
    };

    for (const root of roots) {
      const seen = new Set<string>();
      seenByRoot.set(root, seen);
      await walk(root, root, seen);
    }

    // Re-mark everything we saw as present (in case a prior sync flagged it deleted),
    // then sweep: any track under a root we DIDN'T see is gone from disk.
    let removed = 0;
    for (const [root, seen] of seenByRoot) {
      for (const p of seen) this.db.markPresent(p);
      removed += this.db.sweepMissingUnder(root, seen);
    }

    for (const stemPath of stemFiles) this.linkStemFile(stemPath);
    onProgress?.({ scanned, added, current: 'done' });
    return { scanned, added, removed };
  }

  /**
   * Link a `<base>.stem.mp4` to the original track of the same basename in the same
   * directory (`<base>.mp3` / .wav / …). Sets the track's stem_path so playback
   * prefers the stems. No-op if the original isn't in the library.
   */
  private linkStemFile(stemPath: string): void {
    const dir = dirname(stemPath);
    const base = stemBaseName(stemPath).toLowerCase();
    const orig = this.db
      .queryTracks()
      .find(
        (t) =>
          dirname(t.location) === dir &&
          !isStemFile(t.location) &&
          basename(t.location, extname(t.location)).toLowerCase() === base,
      );
    if (orig) {
      this.db.setStems(orig.id, { stemPath });
    }
  }

  /** Find a sibling `<base>.stem.mp4` for an original track path, if it exists. */
  private async findSiblingStem(originalPath: string): Promise<string | null> {
    const candidate = join(
      dirname(originalPath),
      basename(originalPath, extname(originalPath)) + STEM_SUFFIX,
    );
    try {
      await access(candidate);
      return candidate;
    } catch {
      return null;
    }
  }

  /**
   * Add (or refresh) a single file. `wasNew` is supplied by the caller (it tracks the
   * existing-paths set, so we avoid an O(n) per-file library scan here). Returns true
   * if newly added.
   */
  private async addFile(path: string, wasNew = true): Promise<boolean> {
    try {
      const meta = await parseFile(path, { duration: true, skipCovers: true });
      const st = await stat(path);
      const common = meta.common;
      const fmt = meta.format;
      const trackId = this.db.upsertTrack({
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
      // If a <base>.stem.mp4 already sits next to this track, link it now so playback
      // prefers the stems (covers the "stems made on a prior run" case).
      const sibling = await this.findSiblingStem(path);
      if (sibling) {
        this.db.setStems(trackId, { stemPath: sibling });
      }
      return wasNew;
    } catch {
      // Unreadable/corrupt file — skip it.
      return false;
    }
  }

  /**
   * Drop stem links whose .stem.mp4 no longer exists on disk (the user deleted it).
   * Returns how many were cleared. Called on startup + after a scan so the library
   * never shows "stems" for a file that's gone.
   */
  async pruneMissingStems(): Promise<number> {
    let cleared = 0;
    for (const { id, stemPath } of this.db.tracksWithStems()) {
      try {
        await access(stemPath);
      } catch {
        this.db.clearStems(id);
        cleared++;
      }
    }
    return cleared;
  }

  setAnalysis(
    trackId: number,
    a: {
      bpm?: number;
      firstBeatFrame?: number;
      key?: string;
      waveform?: Uint8Array;
      downbeats?: Uint8Array;
      analyzedAt?: number;
    },
  ): void {
    this.db.setAnalysis(trackId, a);
  }

  getWaveform(trackId: number): Uint8Array | null {
    return this.db.getWaveform(trackId);
  }

  getDownbeats(trackId: number): Uint8Array | null {
    return this.db.getDownbeats(trackId);
  }

  unanalyzedTrackIds(limit?: number): number[] {
    return this.db.unanalyzedTrackIds(limit);
  }

  /** Mark all tracks unanalyzed so the queue re-analyzes the whole collection. */
  reanalyzeAll(): number {
    return this.db.resetAllAnalysis();
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
