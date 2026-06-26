/**
 * Stem-generation worker. Runs the WHOLE generate pipeline (WebGPU Demucs separation
 * + WAV/AAC encode + .stem.mp4 mux) OFF the renderer main thread, so generating
 * stems never blocks the live waveform rAF loop while a song is playing.
 *
 * onnxruntime-web's WebGPU EP runs fine in a worker (its own GPU adapter); the AAC
 * sub-worker is spawned from here (nested workers are allowed). The main thread just
 * sends decoded stereo Float32 in and gets .stem.mp4 bytes + progress out, over rawr.
 *
 * Decode stays on the main thread (it needs an AudioContext, unavailable in workers).
 */

import rawr from 'rawr';
import { worker as workerTransport } from 'rawr/transports/worker';
import { generateStems, type GenerateProgress } from './index.js';

// rawr peer: the main thread calls peer.notifiers/methods; we emit progress via a
// notification so the bar updates live during the long separation.
const peer = rawr({
  transport: workerTransport(),
  methods: {
    /**
     * @param left/right transferred Float32 sample arrays (we rebuild typed views)
     */
    async generate(
      leftBuf: ArrayBuffer,
      rightBuf: ArrayBuffer,
      sampleRate: number,
      opts: { model?: 'htdemucs' | 'htdemucs_ft'; assetBase?: string; title?: string },
    ): Promise<ArrayBuffer> {
      const left = new Float32Array(leftBuf);
      const right = new Float32Array(rightBuf);
      const bytes = await generateStems(left, right, sampleRate, {
        model: opts.model,
        assetBase: opts.assetBase,
        metadata: opts.title ? { title: opts.title } : undefined,
        onProgress: (p: GenerateProgress) => {
          // fire-and-forget progress notification to the main thread
          peer.notifiers.progress?.(p);
        },
      });
      // return a fresh ArrayBuffer (structured-cloned back to the main thread)
      const out = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(out).set(bytes);
      return out;
    },
  },
});
