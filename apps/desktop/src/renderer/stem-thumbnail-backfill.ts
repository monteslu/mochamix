/**
 * StemThumbnailBackfill — computes the per-stem overview waveforms for stem tracks
 * that don't have them cached yet, in the BACKGROUND (one at a time, gently), so the
 * colored library thumbnails are ready before you scroll to them rather than being
 * computed on first paint. Low priority: it only runs when explicitly kicked (app
 * load / after a scan / after stem generation), one decode at a time with a yield
 * between, so it never fights the UI or the analysis pool.
 */

import { computeStemWaveforms } from './stem-thumbnail.js';
import type { Engine } from '@dj/audio-engine';

export class StemThumbnailBackfill {
  private running = false;
  private stopped = false;
  /** ids that failed this session — skip so a bad file can't loop the query forever. */
  private readonly failed = new Set<number>();

  constructor(private readonly engine: Engine) {}

  /** Compute + cache any missing stem thumbnails. Safe to call repeatedly. */
  async run(): Promise<void> {
    if (this.running || this.stopped) return;
    const ctx = this.engine.audioContext;
    if (!ctx) return; // engine not started yet — a later kick will retry
    this.running = true;
    try {
      for (;;) {
        if (this.stopped) break;
        let ids: number[] = [];
        try {
          ids = await window.dj.libraryStemsNeedingWaveforms(200);
        } catch {
          break; // DB not ready
        }
        const todo = ids.filter((id) => !this.failed.has(id));
        if (todo.length === 0) break; // nothing left we haven't already failed on
        for (const id of todo) {
          if (this.stopped) break;
          try {
            const file = await window.dj.readTrackById(id);
            if (file?.isStem) {
              const blob = await computeStemWaveforms(ctx, file.data);
              if (blob) await window.dj.librarySetStemWaveforms(id, blob);
              else this.failed.add(id); // not a valid 5-track stem file
            } else {
              this.failed.add(id);
            }
          } catch (e) {
            this.failed.add(id); // skip on subsequent passes so we don't loop
            console.warn(`[stem-thumb] backfill failed for ${id}`, e);
          }
          // yield so the decode work never blocks the UI/audio for long
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    } finally {
      this.running = false;
    }
  }

  dispose(): void {
    this.stopped = true;
  }
}
