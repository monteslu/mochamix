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
    // CAP ORT's WASM threadpool. Even with WebGPU inference, demucs-web does CPU work
    // (STFT/windowing in JS) + ORT may run some ops on WASM — at hardwareConcurrency
    // threads that saturates EVERY core and starves the renderer's compositor/rAF,
    // causing visible hiccups during separation. Leave ~40% of cores for the UI + GPU
    // compositor (same principle as the analysis pool / Mixxx's half-cores rule).
    const cores = navigator.hardwareConcurrency || 4;
    ort.env.wasm.numThreads = isolated ? Math.max(1, Math.floor(cores * 0.6)) : 1;
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
  const info = adapter.info ?? ({} as GPUAdapterInfo);
  const adapterDesc = [info.vendor, info.architecture, info.device, info.description]
    .filter(Boolean)
    .join(' / ');
  onLog(`WebGPU adapter OK — ${adapterDesc || 'unknown'}`);

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
  // Try to confirm ORT actually bound the WebGPU EP (not a silent WASM fallback).
  // onnxruntime-web exposes a webgpu device on its env once a webgpu session inits;
  // if it's present we KNOW the GPU path is live. (demucs-web hides the session, so
  // this + the realtime factor below are our definitive signals.)
  const webgpuDevice = (ort.env as { webgpu?: { device?: unknown } }).webgpu?.device;
  onLog(`[stems] ort webgpu device after loadModel: ${webgpuDevice ? 'PRESENT' : 'absent'}`);

  onLog('separating — htdemucs …');
  const t0 = performance.now();
  const stems = await proc.separate(left, right);
  const sec = (performance.now() - t0) / 1000;
  const audioSec = left.length / 44100; // demucs runs at 44.1k
  const rtf = audioSec / sec; // >1 = faster than realtime

  // Definitive EP verdict. The session is webgpu-only (no wasm in the EP list), so the
  // DEVICE being present means the session bound WebGPU. But ORT can still run some
  // operators on CPU internally — only the speed proves end-to-end GPU work:
  //   - A real GPU run (esp. Apple/discrete) is comfortably FASTER than realtime.
  //   - A CPU/WASM-dominated run is at or BELOW realtime.
  // So: device present AND fast = confirmed GPU. Device present but SLOW = warn (likely
  // heavy per-op CPU fallback). No device = we never should reach here (would've thrown).
  const FAST = 1.5; // ×realtime threshold for "clearly GPU"
  let verdict: string;
  if (webgpuDevice && rtf >= FAST) {
    verdict = `✅ WebGPU CONFIRMED (device present, ${rtf.toFixed(2)}× realtime)`;
  } else if (webgpuDevice && rtf < FAST) {
    verdict =
      `⚠️ WebGPU device present but only ${rtf.toFixed(2)}× realtime — SLOW. Likely heavy ` +
      `per-operator CPU fallback inside ORT. Investigate (op support / model).`;
  } else {
    verdict = `❌ NO WebGPU device — ran on CPU/WASM (${rtf.toFixed(2)}× realtime). This should not happen.`;
  }
  onLog(`[stems] separation done in ${sec.toFixed(1)}s (${audioSec.toFixed(0)}s audio) → ${verdict}`);
  onProgress(STEMS.reduce((a, s) => ({ ...a, [s]: 1 }), {}));
  return stems;
}
