/**
 * WebGPU Demucs stem separation. Loads onnxruntime-web + demucs-web from the
 * same-origin /webgpu-assets/ server and runs htdemucs (single model, fast) — or
 * the htdemucs_ft 4-model ensemble when available — to split stereo audio into
 * 4 stems (drums, bass, other, vocals). WebGPU is REQUIRED (no CPU fallback; we
 * own the runtime — see 10-electron-feasibility §0a). Ported from loukai
 * createKaraoke separation + creatorLibs.
 *
 * Renderer-only.
 */

import type { StemName } from '@dj/stem-mp4';

/** One stem's stereo PCM. */
export interface StemChannels {
  left: Float32Array;
  right: Float32Array;
}
export type SeparatedStems = Record<StemName, StemChannels>;

export interface SeparateOpts {
  /** 'htdemucs' (single, fast) | 'htdemucs_ft' (4-model ensemble, best). */
  model?: 'htdemucs' | 'htdemucs_ft';
  /** Per-stem progress 0..1, keyed by stem name. */
  onProgress?: (p: Partial<Record<StemName, number>>) => void;
  onLog?: (msg: string) => void;
  /** Base path the WebGPU libs + models are served from. */
  assetBase?: string;
}

const STEMS: StemName[] = ['drums', 'bass', 'other', 'vocals'];

interface OrtModule {
  env: { wasm?: { wasmPaths?: string; numThreads?: number }; webgpu?: { powerPreference?: string } };
  InferenceSession: unknown;
  Tensor: unknown;
}
interface DemucsModule {
  DemucsProcessor: new (opts: unknown) => {
    loadModel(buf: ArrayBuffer): Promise<void>;
    separate(left: Float32Array, right: Float32Array): Promise<SeparatedStems>;
  };
}

let libsCache: { ort: OrtModule; demucs: DemucsModule } | null = null;

/** Has the browser a usable WebGPU adapter? */
export async function detectWebGpu(): Promise<boolean> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(o?: unknown): Promise<unknown> } })
      .gpu;
    if (!gpu) return false;
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    return Boolean(adapter);
  } catch {
    return false;
  }
}

async function loadLibs(base: string, onLog: (m: string) => void) {
  if (libsCache) return libsCache;
  onLog('loading WebGPU separation libs (same-origin) …');
  const [ort, demucs] = (await Promise.all([
    import(/* @vite-ignore */ `${base}/ort.webgpu.bundle.min.mjs`),
    import(/* @vite-ignore */ `${base}/demucs/index.js`),
  ])) as [OrtModule, DemucsModule];
  if (ort.env?.wasm) {
    ort.env.wasm.wasmPaths = `${base}/`;
    const isolated = (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
    ort.env.wasm.numThreads = isolated ? navigator.hardwareConcurrency || 4 : 1;
  }
  if (ort.env?.webgpu) ort.env.webgpu.powerPreference = 'high-performance';
  libsCache = { ort, demucs };
  return libsCache;
}

/**
 * Separate stereo audio into 4 stems on WebGPU. Throws if WebGPU is unavailable
 * (no fallback by design).
 */
export async function separateStems(
  left: Float32Array,
  right: Float32Array,
  opts: SeparateOpts = {},
): Promise<SeparatedStems> {
  const onLog = opts.onLog ?? (() => {});
  const onProgress = opts.onProgress ?? (() => {});
  const base = opts.assetBase ?? '/webgpu-assets';
  const modelBase = '/webgpu-models';

  // WebGPU is REQUIRED (no WASM/CPU fallback by design — a CPU run would also block
  // hard). Report the adapter so we can confirm we're truly on the GPU.
  const gpu = (navigator as unknown as { gpu?: GPU }).gpu;
  if (!gpu) {
    throw new Error('WebGPU unavailable — stem separation requires a WebGPU device.');
  }
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    throw new Error('WebGPU: no adapter — stem separation requires a working GPU.');
  }
  onLog(`WebGPU adapter OK${adapter.info?.vendor ? ` (${adapter.info.vendor})` : ''}`);

  const { ort, demucs } = await loadLibs(base, onLog);
  onLog(`onnxruntime-web loaded — wasm threads: ${ort.env?.wasm?.numThreads ?? '?'}`);

  // Single htdemucs model (fast). The ft ensemble is a future upgrade behind the
  // same interface; the single model is plenty for a first cut and one fetch.
  onLog('loading htdemucs model …');
  const modelBuf = await fetch(`${modelBase}/htdemucs.onnx`).then((r) => {
    if (!r.ok) throw new Error(`model fetch ${r.status}`);
    return r.arrayBuffer();
  });
  const proc = new demucs.DemucsProcessor({
    ort,
    // webgpu ONLY — if the EP can't run, fail loudly rather than silently dropping
    // to WASM (a CPU run on the main thread is exactly what causes the stutter).
    sessionOptions: { executionProviders: ['webgpu'] },
    onProgress: ({ progress }: { progress: number }) =>
      onProgress(STEMS.reduce((a, s) => ({ ...a, [s]: progress || 0 }), {})),
    onLog: (phase: string, m: string) => onLog(`[demucs:${phase}] ${m}`),
  });
  await proc.loadModel(modelBuf);
  onLog('separating on WebGPU — htdemucs …');
  const t0 = performance.now();
  const stems = await proc.separate(left, right);
  onLog(`separation done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  onProgress(STEMS.reduce((a, s) => ({ ...a, [s]: 1 }), {}));
  return stems;
}
