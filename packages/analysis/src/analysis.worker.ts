/**
 * Analysis Worker entry. Runs beat detection off the main thread. The sample data
 * arrives as a SharedArrayBuffer (no copy). Built as a module worker by the app's
 * bundler. (05-library-and-data.md §6)
 */

/// <reference lib="webworker" />

import { WasmBeatDetector, WasmPeaks } from '@dj/dsp-wasm';
import { detailBucketsForDuration, OVERVIEW_BUCKETS } from '@dj/waveform';
import { detectKey } from './key-detector.js';
import type { AnalyzeRequest, AnalyzeResponse } from './worker-protocol.js';

declare const self: DedicatedWorkerGlobalScope;

// One instance per worker (the WASM modules are reused across tracks).
const detector = new WasmBeatDetector();
const peaksWasm = new WasmPeaks();

self.onmessage = (e: MessageEvent<AnalyzeRequest>) => {
  const msg = e.data;
  if (msg.type !== 'analyze') {
    return;
  }
  const all = new Float32Array(msg.sampleBuffer);
  const channels: Float32Array[] = [];
  for (let c = 0; c < msg.channels; c++) {
    channels.push(all.subarray(c * msg.frames, (c + 1) * msg.frames));
  }
  const r = detector.detect(channels, msg.frames, msg.sampleRate);
  const k = detectKey(channels, msg.frames, msg.sampleRate);
  const res: AnalyzeResponse = {
    type: 'analyzed',
    id: msg.id,
    bpm: r.bpm,
    firstBeatFrame: r.firstBeatFrame,
    confidence: r.confidence,
    key: k.name,
    camelot: k.camelot,
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
