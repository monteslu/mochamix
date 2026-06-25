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

import { decodeArrayBuffer } from '@dj/codec';
import { packPeaks } from '@dj/waveform';
import type { Engine } from '@dj/audio-engine';
import type { AnalysisService } from './analysis-service.js';

export interface AnalysisStatus {
  /** Track id currently being analyzed, or null when idle. */
  current: number | null;
  /** How many tracks remain in the queue (including current). */
  remaining: number;
  /** Track ids analyzed since this session started (so rows can refresh). */
  done: Set<number>;
}

type Listener = () => void;

export class AnalysisQueue {
  private queue: number[] = [];
  private running = false;
  private status: AnalysisStatus = { current: null, remaining: 0, done: new Set() };
  private readonly listeners = new Set<Listener>();
  private stopped = false;

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
    this.status = { ...this.status, done: new Set(this.status.done) };
    for (const l of this.listeners) l();
  }

  /** Enqueue track ids (dedup) and start processing if idle. */
  enqueue(ids: number[]): void {
    const known = new Set(this.queue);
    for (const id of ids) {
      if (!known.has(id) && id !== this.status.current && !this.status.done.has(id)) {
        this.queue.push(id);
      }
    }
    this.status.remaining = this.queue.length + (this.status.current != null ? 1 : 0);
    this.emit();
    void this.run();
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

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.stopped) {
        const id = this.queue.shift()!;
        this.status.current = id;
        this.status.remaining = this.queue.length + 1;
        this.emit();
        try {
          await this.analyzeOne(id);
          this.status.done.add(id);
        } catch {
          // mark analyzed-ish so we don't loop forever on a bad file
          this.status.done.add(id);
        }
        // yield so we never block the UI / audio thread
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      this.status.current = null;
      this.status.remaining = 0;
      this.running = false;
      this.emit();
    }
  }

  private async analyzeOne(id: number): Promise<void> {
    const file = await window.dj.readTrackById(id);
    if (!file) return;
    const ctx = this.engine.audioContext;
    if (!ctx) return; // engine not started yet; will retry next enqueue
    const decoded = await decodeArrayBuffer(ctx, file.data, file.name);

    // Everything heavy (peaks + beat + key) happens IN THE WORKER, off the main
    // thread, so background analysis never hiccups live audio.
    const r = await this.analysis.analyze(decoded, /* computePeaks */ true);

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

    await window.dj.librarySetAnalysis(id, {
      bpm: r.bpm,
      firstBeatFrame: r.firstBeatFrame,
      key: r.camelot,
      waveform: waveform ?? undefined,
      analyzedAt: Date.now(),
    });
  }

  dispose(): void {
    this.stopped = true;
    this.queue = [];
    this.listeners.clear();
  }
}
