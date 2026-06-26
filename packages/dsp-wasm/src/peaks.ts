/**
 * WasmPeaks — waveform band-peak analysis in WASM+SIMD. A faithful port of Mixxx's
 * AnalyzerWaveform (Bessel-4 band split via FIDLIB at 600/4000 Hz + per-stride
 * max-abs peaks), computing the DETAIL and OVERVIEW reductions in a SINGLE pass.
 * Replaces the old pure-JS computeBandPeaks — there is no JS fallback.
 *
 * Runs in the analysis Worker. Heap views are re-read after any call that may grow
 * memory (a full track's float source is large).
 */

import { peaksWasmBase64 } from './generated/peaks-wasm.js';
import { base64ToBytes } from './base64.js';

interface PeaksExports {
  memory: WebAssembly.Memory;
  peaks_malloc(bytes: number): number;
  peaks_free(ptr: number): void;
  peaks_run(
    srcL: number,
    srcR: number,
    frames: number,
    sampleRate: number,
    detailBuckets: number,
    dAll: number,
    dLow: number,
    dMid: number,
    dHigh: number,
    ovBuckets: number,
    oAll: number,
    oLow: number,
    oMid: number,
    oHigh: number,
  ): void;
  _initialize?: () => void;
}

export interface BandPeaks {
  length: number;
  peaks: Uint8Array;
  low: Uint8Array;
  mid: Uint8Array;
  high: Uint8Array;
  framesPerBucket: number;
  frames: number;
}

export interface PeakSet {
  detail: BandPeaks;
  overview: BandPeaks;
}

export class WasmPeaks {
  private readonly ex: PeaksExports;

  constructor() {
    const bytes = base64ToBytes(peaksWasmBase64);
    const module = new WebAssembly.Module(bytes);
    // FIDLIB pulls in printf/FILE (fid_list_filters etc.) which we never call, but
    // its presence makes emscripten import a few WASI syscalls. Stub them — they're
    // unreachable on the peaks_run path.
    const noop = () => 0;
    const instance = new WebAssembly.Instance(module, {
      env: { emscripten_notify_memory_growth: () => {} },
      wasi_snapshot_preview1: {
        fd_write: noop,
        fd_close: noop,
        fd_seek: noop,
        fd_read: noop,
        proc_exit: () => {},
        environ_get: noop,
        environ_sizes_get: noop,
      },
    });
    this.ex = instance.exports as unknown as PeaksExports;
    this.ex._initialize?.();
  }

  private f32(): Float32Array {
    return new Float32Array(this.ex.memory.buffer);
  }
  private u8(): Uint8Array {
    return new Uint8Array(this.ex.memory.buffer);
  }

  /**
   * Compute detail + overview band peaks in one WASM pass.
   * @param channelData planar Float32 channels
   * @param frames source length
   * @param detailBuckets detail-resolution bucket count
   * @param overviewBuckets overview bucket count
   * @param sampleRate Hz
   */
  compute(
    channelData: Float32Array[],
    frames: number,
    detailBuckets: number,
    overviewBuckets: number,
    sampleRate = 44100,
  ): PeakSet {
    const db = Math.max(1, Math.min(detailBuckets, frames));
    const ob = Math.max(1, Math.min(overviewBuckets, frames));
    const ex = this.ex;

    // source channels
    const left = channelData[0]!;
    const right = channelData.length > 1 ? channelData[1]! : left;
    const srcL = ex.peaks_malloc(frames * 4);
    const srcR = ex.peaks_malloc(frames * 4);
    // 4 detail + 4 overview output bands
    const dAll = ex.peaks_malloc(db);
    const dLow = ex.peaks_malloc(db);
    const dMid = ex.peaks_malloc(db);
    const dHigh = ex.peaks_malloc(db);
    const oAll = ex.peaks_malloc(ob);
    const oLow = ex.peaks_malloc(ob);
    const oMid = ex.peaks_malloc(ob);
    const oHigh = ex.peaks_malloc(ob);

    // copy source in (re-read heap; malloc may have grown memory)
    const f = this.f32();
    f.set(left.subarray(0, frames), srcL / 4);
    f.set(right.subarray(0, frames), srcR / 4);

    ex.peaks_run(srcL, srcR, frames, sampleRate, db, dAll, dLow, dMid, dHigh, ob, oAll, oLow, oMid, oHigh);

    // read outputs back (copy out of the heap)
    const u = this.u8();
    const take = (ptr: number, n: number) => u.slice(ptr, ptr + n);
    const detail: BandPeaks = {
      length: db,
      peaks: take(dAll, db),
      low: take(dLow, db),
      mid: take(dMid, db),
      high: take(dHigh, db),
      framesPerBucket: frames / db,
      frames,
    };
    const overview: BandPeaks = {
      length: ob,
      peaks: take(oAll, ob),
      low: take(oLow, ob),
      mid: take(oMid, ob),
      high: take(oHigh, ob),
      framesPerBucket: frames / ob,
      frames,
    };

    for (const p of [srcL, srcR, dAll, dLow, dMid, dHigh, oAll, oLow, oMid, oHigh]) ex.peaks_free(p);
    return { detail, overview };
  }
}
