/**
 * AnalysisService — runs beat/key/peaks analysis off the main thread via a POOL of
 * Web Workers, so importing/scanning a big library analyzes several tracks at once.
 *
 * Pool sizing is deliberately conservative: it must NEVER use all cores, or the
 * main/UI thread (waveform render + bus readback) and the audio path get starved and
 * the app janks. We reserve cores for the UI + audio + a margin (RESERVED_CORES) and
 * hard-cap the pool. Each track's sample data is a SharedArrayBuffer (no copy).
 *
 * The public API (analyze) is unchanged — the queue keeps calling it; the service
 * routes each request to an idle worker and queues overflow internally.
 */

import type { AnalyzeRequest, AnalyzeResponse } from '@dj/analysis';
import type { AnalysisAudio } from '@dj/codec';

export interface BeatGridResult {
  bpm: number;
  firstBeatFrame: number;
  confidence: number;
  key: string;
  camelot: string;
  /** Bar-start beats (downbeats), in source frames — real measures from DownBeat. */
  downbeatFrames?: Int32Array;
  /** Overview peaks, when peaks were requested (computed in the worker). */
  overviewPeaks?: Uint8Array;
  overviewLow?: Uint8Array;
  overviewMid?: Uint8Array;
  overviewHigh?: Uint8Array;
  detailPeaks?: Uint8Array;
  detailFramesPerBucket?: number;
}

/**
 * Fraction of cores the analysis pool may use. The remaining cores stay free for the
 * UI/render thread + the audio worklet + everything else, so analysis NEVER crushes
 * the UI no matter the core count. 24 cores → 14 workers, 8 → 4, 4 → 2, 2 → 1.
 *
 * Mixxx does the SAME: its background analysis (player active) uses idealThreadCount()
 * / 2 — half the cores — precisely so it doesn't starve the live UI/audio
 * (playermanager.cpp). It only goes full-cores for explicit batch analysis with
 * nothing playing; we can't, since our "batch" shares the one renderer process with
 * the UI, so we cap at ~60% always. Slightly above Mixxx's /2, same intent.
 */
const POOL_CORE_FRACTION = 0.5;
/**
 * Absolute ceiling. Analysis is partly MEMORY-bound: each in-flight track holds a mono
 * buffer (transferred to its worker, so the main thread is freed) + that worker's WASM
 * heap. The transfer + mono downmix keep per-track cost low, but cap concurrency so a
 * burst of long tracks can't spike the renderer. 8 is safe even on many-core machines.
 */
const MAX_POOL = 8;

/** Safe pool size: ~60% of cores, at least 1, capped at MAX_POOL. */
export function analysisPoolSize(): number {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(MAX_POOL, Math.floor(cores * POOL_CORE_FRACTION)));
}

interface PoolWorker {
  worker: Worker;
  busy: boolean;
}

interface Job {
  req: AnalyzeRequest;
  resolve: (r: BeatGridResult) => void;
}

function toResult(msg: Extract<AnalyzeResponse, { type: 'analyzed' }>): BeatGridResult {
  return {
    bpm: msg.bpm,
    firstBeatFrame: msg.firstBeatFrame,
    confidence: msg.confidence,
    key: msg.key,
    camelot: msg.camelot,
    downbeatFrames: msg.downbeatFrames,
    overviewPeaks: msg.overviewPeaks,
    overviewLow: msg.overviewLow,
    overviewMid: msg.overviewMid,
    overviewHigh: msg.overviewHigh,
    detailPeaks: msg.detailPeaks,
    detailFramesPerBucket: msg.detailFramesPerBucket,
  };
}

export class AnalysisService {
  private readonly pool: PoolWorker[] = [];
  private nextId = 1;
  /** id → { resolver, the worker running it } so we route the reply correctly. */
  private readonly pending = new Map<number, { resolve: (r: BeatGridResult) => void; w: PoolWorker }>();
  /** Jobs waiting for a free worker. */
  private readonly waiting: Job[] = [];

  constructor(size = analysisPoolSize()) {
    for (let i = 0; i < size; i++) {
      // Regular Web Workers DO bundle via this Vite pattern (unlike AudioWorklets).
      const worker = new Worker(new URL('./analysis-worker-entry.ts', import.meta.url), {
        type: 'module',
      });
      const pw: PoolWorker = { worker, busy: false };
      worker.onmessage = (e: MessageEvent<AnalyzeResponse>) => {
        const msg = e.data;
        if (msg.type !== 'analyzed') return;
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          entry.resolve(toResult(msg));
        }
        pw.busy = false;
        this.drain(); // a worker freed up — start the next queued job
      };
      this.pool.push(pw);
    }
  }

  /** Number of workers in the pool. */
  get poolSize(): number {
    return this.pool.length;
  }

  private drain(): void {
    while (this.waiting.length) {
      const free = this.pool.find((w) => !w.busy);
      if (!free) return; // all busy; wait for an onmessage to free one
      const job = this.waiting.shift()!;
      free.busy = true;
      this.pending.set(job.req.id, { resolve: job.resolve, w: free });
      // Transfer the mono buffer so the main thread frees it (no copy, no lingering).
      free.worker.postMessage(job.req, [job.req.mono]);
    }
  }

  /**
   * Analyze decoded MONO audio in the pool. The `mono` ArrayBuffer is TRANSFERRED to
   * the worker, so the main thread releases it immediately (no lingering buffers that
   * exhaust the heap under heavy concurrency). Pass `computePeaks` to also build the
   * waveform peaks off the main thread. Resolves when that track's worker reports back.
   */
  analyze(audio: AnalysisAudio, computePeaks = false): Promise<BeatGridResult> {
    const id = this.nextId++;
    const req: AnalyzeRequest = {
      type: 'analyze',
      id,
      mono: audio.mono,
      frames: audio.frames,
      sampleRate: audio.sampleRate,
      computePeaks,
    };
    return new Promise<BeatGridResult>((resolve) => {
      this.waiting.push({ req, resolve });
      this.drain();
    });
  }

  dispose(): void {
    for (const pw of this.pool) pw.worker.terminate();
    this.pool.length = 0;
    this.pending.clear();
    this.waiting.length = 0;
  }
}
