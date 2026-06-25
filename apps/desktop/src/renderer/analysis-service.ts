/**
 * AnalysisService — runs beat detection off the main thread via a Web Worker.
 * Vite bundles the worker (via `new Worker(new URL(...))`). The sample data is a
 * SharedArrayBuffer so there's no copy.
 */

import type { AnalyzeRequest, AnalyzeResponse } from '@internal-dj/analysis';
import type { DecodedTrack } from '@internal-dj/audio-engine';

export interface BeatGridResult {
  bpm: number;
  firstBeatFrame: number;
  confidence: number;
  key: string;
  camelot: string;
  /** Overview peaks, when peaks were requested (computed in the worker). */
  overviewPeaks?: Uint8Array;
  overviewLow?: Uint8Array;
  overviewMid?: Uint8Array;
  overviewHigh?: Uint8Array;
  detailPeaks?: Uint8Array;
  detailFramesPerBucket?: number;
}

export class AnalysisService {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, (r: BeatGridResult) => void>();

  constructor() {
    // Regular Web Workers DO bundle via this Vite pattern (unlike AudioWorklets).
    this.worker = new Worker(new URL('./analysis-worker-entry.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e: MessageEvent<AnalyzeResponse>) => {
      const msg = e.data;
      if (msg.type === 'analyzed') {
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve({
            bpm: msg.bpm,
            firstBeatFrame: msg.firstBeatFrame,
            confidence: msg.confidence,
            key: msg.key,
            camelot: msg.camelot,
            overviewPeaks: msg.overviewPeaks,
            overviewLow: msg.overviewLow,
            overviewMid: msg.overviewMid,
            overviewHigh: msg.overviewHigh,
            detailPeaks: msg.detailPeaks,
            detailFramesPerBucket: msg.detailFramesPerBucket,
          });
        }
      }
    };
  }

  /**
   * Analyze a track in the worker. Pass `computePeaks` to also build the waveform
   * peaks off the main thread (used by the background queue so nothing heavy runs
   * on the main/audio path).
   */
  analyze(track: DecodedTrack, computePeaks = false): Promise<BeatGridResult> {
    const id = this.nextId++;
    const req: AnalyzeRequest = {
      type: 'analyze',
      id,
      sampleBuffer: track.sampleBuffer,
      channels: track.channels,
      frames: track.frames,
      sampleRate: track.sampleRate,
      computePeaks,
    };
    return new Promise<BeatGridResult>((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage(req);
    });
  }

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}
