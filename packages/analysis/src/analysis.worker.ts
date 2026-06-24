/**
 * Analysis Worker entry. Runs beat detection off the main thread. The sample data
 * arrives as a SharedArrayBuffer (no copy). Built as a module worker by the app's
 * bundler. (05-library-and-data.md §6)
 */

/// <reference lib="webworker" />

import { WasmBeatDetector } from '@internal-dj/dsp-wasm';
import type { AnalyzeRequest, AnalyzeResponse } from './worker-protocol.js';

declare const self: DedicatedWorkerGlobalScope;

// One detector instance per worker (the WASM module is reused across tracks).
const detector = new WasmBeatDetector();

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
  const res: AnalyzeResponse = {
    type: 'analyzed',
    id: msg.id,
    bpm: r.bpm,
    firstBeatFrame: r.firstBeatFrame,
    confidence: r.confidence,
  };
  self.postMessage(res);
};
