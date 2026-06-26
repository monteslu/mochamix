/**
 * Stem-generation queue — the user clicks "Generate Stems" on a library row, this
 * decodes the track → runs WebGPU Demucs separation + AAC encode + .stem.mp4 mux
 * (@dj/stems, all in the renderer) → hands the bytes to main to write next to the
 * original and link it. One job at a time (separation is GPU-heavy). Exposes a
 * subscribable store so the row can show live progress where the button was.
 *
 * This is the headline differentiator: Mixxx only PLAYS pre-split stems; we GENERATE
 * them, which makes live mashups (vocals of A over instrumental of B) possible.
 */

import { decodeArrayBuffer } from '@dj/codec';
import { generateStemsInWorker } from '@dj/stems/generate-client';
import type { GenerateProgress } from '@dj/stems';
import type { Engine } from '@dj/audio-engine';

export interface StemStatus {
  /** Track id currently generating, or null when idle. */
  current: number | null;
  /** 0..1 progress of the current job. */
  progress: number;
  /** Short phase label for the current job. */
  phase: GenerateProgress['phase'] | null;
  /** How many jobs remain (including current). */
  remaining: number;
  /** Track ids whose stems completed this session (rows refresh to "stems ✓"). */
  done: Set<number>;
  /** Track ids that failed (so the row can show an error + allow retry). */
  failed: Set<number>;
}

type Listener = () => void;

export class StemQueue {
  private queue: number[] = [];
  private running = false;
  private stopped = false;
  private status: StemStatus = {
    current: null,
    progress: 0,
    phase: null,
    remaining: 0,
    done: new Set(),
    failed: new Set(),
  };
  private readonly listeners = new Set<Listener>();

  constructor(private readonly engine: Engine) {}

  getStatus(): StemStatus {
    return this.status;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(): void {
    this.status = {
      ...this.status,
      done: new Set(this.status.done),
      failed: new Set(this.status.failed),
    };
    for (const l of this.listeners) l();
  }

  /** Queue a track for stem generation (dedup) and start if idle. */
  enqueue(id: number): void {
    if (
      id === this.status.current ||
      this.queue.includes(id) ||
      this.status.done.has(id)
    ) {
      return;
    }
    this.status.failed.delete(id); // re-queuing a failed one clears the error
    this.queue.push(id);
    this.status.remaining = this.queue.length + (this.status.current != null ? 1 : 0);
    this.emit();
    void this.run();
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.stopped) {
        const id = this.queue.shift()!;
        this.status.current = id;
        this.status.progress = 0;
        this.status.phase = 'separating';
        this.status.remaining = this.queue.length + 1;
        this.emit();
        try {
          await this.generateOne(id);
          this.status.done.add(id);
        } catch (e) {
          console.error('[stems] generation failed for track', id, e);
          this.status.failed.add(id);
        }
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      this.status.current = null;
      this.status.progress = 0;
      this.status.phase = null;
      this.status.remaining = 0;
      this.running = false;
      this.emit();
    }
  }

  private async generateOne(id: number): Promise<void> {
    const t0 = performance.now();
    console.log(`[stems] generating for track ${id} …`);
    const file = await window.dj.readTrackById(id);
    if (!file) throw new Error('track bytes unavailable');
    if (file.isStem) return; // already stems
    const ctx = this.engine.audioContext;
    if (!ctx) throw new Error('audio engine not started');

    const decoded = await decodeArrayBuffer(ctx, file.data, file.name);
    // decodeArrayBuffer gives planar Float32 in a shared buffer; pull L/R.
    const all = new Float32Array(decoded.sampleBuffer);
    const frames = decoded.frames;
    const left = all.subarray(0, frames);
    const right = decoded.channels > 1 ? all.subarray(frames, frames * 2) : left;
    console.log(
      `[stems] decoded "${file.name}" ${(frames / decoded.sampleRate).toFixed(1)}s @ ${decoded.sampleRate}Hz → separating in worker (off main thread)`,
    );

    // Run the WHOLE pipeline in a Worker so the main-thread waveform rAF keeps
    // ticking while WebGPU Demucs runs.
    let lastLogged = -1;
    const bytes = await generateStemsInWorker(
      Float32Array.from(left),
      Float32Array.from(right),
      decoded.sampleRate,
      {
        title: file.name,
        onProgress: (p: GenerateProgress) => {
          this.status.progress = p.progress;
          this.status.phase = p.phase;
          this.emit();
          if (p.log) console.log(`[stems] ${p.log}`);
          // log every ~10% so the console shows steady progress
          const pct = Math.floor(p.progress * 10);
          if (pct !== lastLogged) {
            lastLogged = pct;
            console.log(`[stems] ${p.phase} ${Math.round(p.progress * 100)}%`);
          }
        },
      },
    );

    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const path = await window.dj.saveStems(id, ab as ArrayBuffer);
    console.log(
      `[stems] done track ${id} in ${((performance.now() - t0) / 1000).toFixed(1)}s → ${path}`,
    );
  }

  dispose(): void {
    this.stopped = true;
    this.queue = [];
    this.listeners.clear();
  }
}
