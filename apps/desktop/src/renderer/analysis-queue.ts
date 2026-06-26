/**
 * Background analysis queue — analyzes tracks the library hasn't processed yet,
 * one at a time, off the critical path. Runs on app load (existing unanalyzed
 * songs) and after a scan (newly-added songs). For each track it decodes →
 * computes overview peaks → detects BPM/key/beatgrid → persists everything to the
 * DB, so later loads are instant and the library can show a mini-waveform.
 *
 * Exposes a small subscribable status store so the UI can show a per-track
 * "analyzing" indicator + the progressively-completed set.
 */

import { decodeForAnalysis } from '@dj/codec';
import { packPeaks } from '@dj/waveform';
import type { Engine } from '@dj/audio-engine';
import type { AnalysisService } from './analysis-service.js';

export interface AnalysisStatus {
  /** Track ids currently being analyzed (several at once with the worker pool). */
  current: Set<number>;
  /** How many tracks remain (queued + in-flight). */
  remaining: number;
  /** Track ids analyzed since this session started (so rows can refresh). */
  done: Set<number>;
}

type Listener = () => void;

export class AnalysisQueue {
  private queue: number[] = [];
  private running = false;
  private inFlight = new Set<number>();
  private status: AnalysisStatus = { current: new Set(), remaining: 0, done: new Set() };
  private readonly listeners = new Set<Listener>();
  private stopped = false;
  // Per-run counters so we can SEE whether analysis actually did work.
  private okCount = 0;
  private failCount = 0;

  constructor(
    private readonly engine: Engine,
    private readonly analysis: AnalysisService,
  ) {}

  getStatus(): AnalysisStatus {
    return this.status;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(): void {
    // new object so React's useSyncExternalStore sees a change
    this.status = {
      current: new Set(this.inFlight),
      remaining: this.queue.length + this.inFlight.size,
      done: new Set(this.status.done),
    };
    for (const l of this.listeners) l();
  }

  /** Enqueue track ids (dedup) and start processing if idle. Returns how many were added. */
  enqueue(ids: number[]): number {
    const known = new Set(this.queue);
    let added = 0;
    for (const id of ids) {
      if (!known.has(id) && !this.inFlight.has(id) && !this.status.done.has(id)) {
        this.queue.push(id);
        known.add(id);
        added++;
      }
    }
    this.emit();
    void this.run();
    return added;
  }

  /** Pull the not-yet-analyzed set from the DB and queue it (on load / after scan). */
  async enqueueUnanalyzed(): Promise<void> {
    try {
      const ids = await window.dj.libraryUnanalyzed(1000);
      if (ids.length) this.enqueue(ids);
    } catch {
      /* DB not ready / no library yet */
    }
  }

  /**
   * Re-analyze the ENTIRE collection: mark every track unanalyzed in the DB, clear the
   * in-session done set (so already-analyzed tracks re-run), then queue them all in
   * pages. Used after the analyzer changed (e.g. the qm-dsp swap). Returns the count.
   */
  async reanalyzeAll(): Promise<number> {
    let count: number;
    try {
      count = await window.dj.libraryReanalyzeAll();
    } catch {
      return 0; // DB not ready
    }
    console.log(`[analyze] reanalyzeAll: DB reset analyzed_at=0 on ${count} tracks`);
    this.status.done.clear();
    // Pull the (now all-unanalyzed) set and queue it. enqueue() dedups against what's
    // already queued/in-flight (e.g. the startup kick may have grabbed some already),
    // so we count both what WE add and what's already pending — the real backlog.
    let added = 0;
    for (;;) {
      const ids = await window.dj.libraryUnanalyzed(1000);
      if (ids.length === 0) break;
      added += this.enqueue(ids);
      if (ids.length < 1000) break;
    }
    const pending = this.queue.length + this.inFlight.size;
    console.log(
      `[analyze] reanalyzeAll: ${added} newly queued (${pending} total pending incl. already-running)`,
    );
    if (pending === 0 && count > 0) {
      console.warn('[analyze] reset tracks but nothing pending — libraryUnanalyzed returned nothing?');
    }
    return count;
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.okCount = 0;
    this.failCount = 0;
    const startedAt = Date.now();
    const total = this.queue.length;
    // Keep up to `concurrency` analyses in flight (the worker pool size), refilling
    // as each completes — so a library scan saturates the POOL but not all cores
    // (the pool itself reserves cores for the UI + audio threads).
    const concurrency = this.analysis.poolSize;
    console.log(`[analyze] starting: ${total} tracks queued, pool size ${concurrency}`);
    try {
      const launch = (): Promise<void> | null => {
        if (this.stopped || this.queue.length === 0) return null;
        const id = this.queue.shift()!;
        this.inFlight.add(id);
        this.emit();
        return this.analyzeOne(id)
          .then(() => {
            this.okCount++;
          })
          .catch((e) => {
            // Surface the reason instead of silently marking done — this is how the
            // "ran in seconds, nothing happened" failure stays visible.
            this.failCount++;
            console.warn(`[analyze] track ${id} FAILED:`, e instanceof Error ? e.message : e);
          })
          .finally(() => {
            this.inFlight.delete(id);
            this.status.done.add(id);
            this.emit();
          });
      };

      // Prime up to `concurrency` workers, then as each finishes, launch the next.
      const runners: Promise<void>[] = [];
      const pump = async (): Promise<void> => {
        for (;;) {
          const p = launch();
          if (!p) return;
          await p; // wait for THIS slot's job, then immediately grab the next id
        }
      };
      for (let i = 0; i < concurrency; i++) runners.push(pump());
      await Promise.all(runners);
    } finally {
      this.running = false;
      this.emit();
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(
        `[analyze] DONE: ${this.okCount} ok, ${this.failCount} failed of ${total} in ${secs}s` +
          (this.failCount > 0 ? ' — check the FAILED lines above' : ''),
      );
    }
  }

  private async analyzeOne(id: number): Promise<void> {
    // preferOriginal: analyze the original song file, NOT the .stem.mp4 (smaller +
    // decodes reliably; analysis only needs the mixdown, which the original IS).
    const file = await window.dj.readTrackById(id, /* preferOriginal */ true);
    if (!file) {
      throw new Error(`track ${id}: no file bytes (readTrackById returned null)`);
    }
    // Decode to MONO in a throwaway OfflineAudioContext → a plain (transferable)
    // ArrayBuffer. No SharedArrayBuffer, no live-context retention: the buffer is
    // transferred to the worker and freed on the main thread immediately, so hundreds
    // of tracks don't pile up and exhaust the renderer heap.
    const audio = await decodeForAnalysis(file.data);

    // Everything heavy (peaks + beat + key) happens IN THE WORKER, off the main thread.
    const r = await this.analysis.analyze(audio, /* computePeaks */ true);

    // pack amp + band peaks into one blob so the library row can color it
    const waveform =
      r.overviewPeaks &&
      packPeaks({
        length: r.overviewPeaks.length,
        peaks: r.overviewPeaks,
        low: r.overviewLow,
        mid: r.overviewMid,
        high: r.overviewHigh,
        framesPerBucket: 1,
        frames: r.overviewPeaks.length,
      });

    // Pack downbeat frames (Int32) into a byte blob for the DB → real measures.
    const downbeats =
      r.downbeatFrames && r.downbeatFrames.length > 0
        ? new Uint8Array(r.downbeatFrames.buffer, r.downbeatFrames.byteOffset, r.downbeatFrames.byteLength)
        : undefined;

    await window.dj.librarySetAnalysis(id, {
      bpm: r.bpm,
      firstBeatFrame: r.firstBeatFrame,
      key: r.camelot,
      waveform: waveform ?? undefined,
      downbeats,
      analyzedAt: Date.now(),
    });
    console.log(
      `[analyze] track ${id}: ${r.bpm.toFixed(1)} bpm, key ${r.camelot || '?'}, ` +
        `${r.downbeatFrames?.length ?? 0} downbeats — persisted`,
    );
  }

  dispose(): void {
    this.stopped = true;
    this.queue = [];
    this.listeners.clear();
  }
}
