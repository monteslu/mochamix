/**
 * Analysis Worker entry. Runs beat/key/downbeat/peaks analysis off the main thread.
 * The sample data arrives as a SharedArrayBuffer (no copy). Built as a module worker
 * by the app's bundler. One of N pooled workers (see analysis-service.ts).
 * (05-library-and-data.md §6)
 *
 * Why WASM (not WebGPU compute) for analysis — evaluated and decided against GPU:
 *  - Peaks: the Mixxx Bessel-4 IIR band split is a SERIAL recurrence (sample N depends
 *    on N-1). GPU compute parallelizes across independent elements, which a recurrence
 *    isn't — only 3-way (per-band) parallelism, and the per-track GPU round-trip would
 *    eat it. WASM's ~1.5× is near the algorithm's ceiling.
 *  - Key/beat: a WGSL port would mean abandoning Mixxx's exact qm-dsp C++ (GetKeyMode/
 *    TempoTrackV2/DownBeat), losing the "accurate as Mixxx by construction" property we
 *    just established. The WORKER POOL already parallelizes these across cores for
 *    library scans (the real throughput win), and the GPU is already contended by stem
 *    generation (Demucs). Net: GPU compute not worth the correctness trade.
 */

/// <reference lib="webworker" />

import { WasmQmAnalysis, WasmPeaks } from '@dj/dsp-wasm';
import { detailBucketsForDuration, OVERVIEW_BUCKETS } from '@dj/waveform';
import type { AnalyzeRequest, AnalyzeResponse } from './worker-protocol.js';

declare const self: DedicatedWorkerGlobalScope;

// One instance per worker (the WASM modules are reused across tracks). qm = Mixxx's
// actual Queen Mary DSP: key (GetKeyMode) + beat (TempoTrackV2) + downbeats (DownBeat)
// + BPM (BeatUtils::calculateBpm), all in one pass.
const qm = new WasmQmAnalysis();
const peaksWasm = new WasmPeaks();

self.onmessage = (e: MessageEvent<AnalyzeRequest>) => {
  const msg = e.data;
  if (msg.type !== 'analyze') {
    return;
  }
  // The mono buffer was TRANSFERRED in (main thread no longer references it).
  const mono = new Float32Array(msg.mono, 0, msg.frames);
  const channels: Float32Array[] = [mono];
  const r = qm.analyze(channels, msg.frames, msg.sampleRate);
  const res: AnalyzeResponse = {
    type: 'analyzed',
    id: msg.id,
    bpm: r.bpm,
    firstBeatFrame: r.firstBeatFrame,
    confidence: r.confidence,
    key: r.key,
    camelot: r.camelot,
    downbeatFrames: r.downbeatFrames,
  };

  // Compute the waveform peaks here too (off the main thread) when asked, so the
  // background analysis path does ALL its heavy work in the worker — no main-
  // thread sample loops that would hiccup live audio.
  if (msg.computePeaks) {
    const buckets = msg.detailBuckets ?? detailBucketsForDuration(msg.frames / msg.sampleRate);
    // WASM+SIMD band peaks (Mixxx Bessel-4), detail + overview in ONE pass.
    const peaks = peaksWasm.compute(channels, msg.frames, buckets, OVERVIEW_BUCKETS, msg.sampleRate);
    res.overviewPeaks = peaks.overview.peaks;
    res.overviewLow = peaks.overview.low;
    res.overviewMid = peaks.overview.mid;
    res.overviewHigh = peaks.overview.high;
    res.detailPeaks = peaks.detail.peaks;
    res.detailFramesPerBucket = peaks.detail.framesPerBucket;
  }

  self.postMessage(res);
};
