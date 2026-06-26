/**
 * Main-thread client for the stems worker. Spawns stems.worker (which runs the whole
 * WebGPU separation + encode + mux OFF the main thread), forwards progress, and
 * returns the .stem.mp4 bytes. This is what the renderer calls instead of importing
 * generateStems directly — so the heavy work never blocks the waveform rAF loop.
 *
 * Decode stays on the main thread (AudioContext); we pass the decoded Float32 L/R in.
 */

import rawr from 'rawr';
import { dom as domTransport } from 'rawr/transports/worker';
import type { GenerateProgress } from './index.js';

interface StemsWorkerPeer {
  methods: {
    generate: (
      left: ArrayBuffer,
      right: ArrayBuffer,
      sampleRate: number,
      opts: { model?: 'htdemucs' | 'htdemucs_ft'; assetBase?: string; title?: string },
    ) => Promise<ArrayBuffer>;
  };
  notifications: {
    onprogress: (cb: (p: GenerateProgress) => void) => void;
  };
}

export interface GenerateInWorkerOpts {
  model?: 'htdemucs' | 'htdemucs_ft';
  assetBase?: string;
  title?: string;
  onProgress?: (p: GenerateProgress) => void;
}

/**
 * Generate a .stem.mp4 from decoded stereo audio, with the heavy lifting in a Worker.
 * The audio buffers are TRANSFERRED (zero-copy) into the worker.
 */
export async function generateStemsInWorker(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  opts: GenerateInWorkerOpts = {},
): Promise<Uint8Array> {
  const worker = new Worker(new URL('./stems.worker.js', import.meta.url), { type: 'module' });
  const peer = rawr({ transport: domTransport(worker), timeout: 0 }) as unknown as StemsWorkerPeer;
  if (opts.onProgress) peer.notifications.onprogress(opts.onProgress);
  try {
    // Copy into fresh buffers we can transfer (the SAB-backed views can't be moved).
    const l = left.slice();
    const r = right.slice();
    const result = await peer.methods.generate(l.buffer, r.buffer, sampleRate, {
      model: opts.model,
      assetBase: opts.assetBase,
      title: opts.title,
    });
    return new Uint8Array(result);
  } finally {
    worker.terminate();
  }
}
