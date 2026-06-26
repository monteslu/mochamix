/**
 * WebGPU asset resolver (Node-only). The in-browser stem generator loads its libs
 * (onnxruntime-web, demucs-web, ffmpeg-core) and ONNX models same-origin from
 * /webgpu-assets/* and /webgpu-models/*. This module downloads each asset once into
 * a cache dir and returns the local file path; the dev server (vite) and Electron
 * (app:// protocol) both stream from here. Ported from loukai webgpuAssets.
 *
 * IMPORTANT: import this ONLY from main/Node (it uses node:fs/https). The renderer
 * never imports it — it just fetches the served URLs.
 */

import { existsSync, mkdirSync, statSync, renameSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import https from 'node:https';

const ORT_VER = '1.27.0';
const DEMUCS_VER = '1.0.2';
const FFMPEG_CORE_VER = '0.12.10';
const CDN = 'https://cdn.jsdelivr.net/npm';
const HF = 'https://huggingface.co';

/** Library assets served at /webgpu-assets/<key>. */
const ASSETS: Record<string, string> = {
  'ort.webgpu.bundle.min.mjs': `${CDN}/onnxruntime-web@${ORT_VER}/dist/ort.webgpu.bundle.min.mjs`,
  'ort.bundle.min.mjs': `${CDN}/onnxruntime-web@${ORT_VER}/dist/ort.bundle.min.mjs`,
  'ort-wasm-simd-threaded.asyncify.wasm': `${CDN}/onnxruntime-web@${ORT_VER}/dist/ort-wasm-simd-threaded.asyncify.wasm`,
  'ort-wasm-simd-threaded.asyncify.mjs': `${CDN}/onnxruntime-web@${ORT_VER}/dist/ort-wasm-simd-threaded.asyncify.mjs`,
  'ort-wasm-simd-threaded.jsep.wasm': `${CDN}/onnxruntime-web@${ORT_VER}/dist/ort-wasm-simd-threaded.jsep.wasm`,
  'ort-wasm-simd-threaded.jsep.mjs': `${CDN}/onnxruntime-web@${ORT_VER}/dist/ort-wasm-simd-threaded.jsep.mjs`,
  'demucs/index.js': `${CDN}/demucs-web@${DEMUCS_VER}/src/index.js`,
  'demucs/processor.js': `${CDN}/demucs-web@${DEMUCS_VER}/src/processor.js`,
  'demucs/fft.js': `${CDN}/demucs-web@${DEMUCS_VER}/src/fft.js`,
  'demucs/constants.js': `${CDN}/demucs-web@${DEMUCS_VER}/src/constants.js`,
  'ffmpeg-core.js': `${CDN}/@ffmpeg/core@${FFMPEG_CORE_VER}/dist/esm/ffmpeg-core.js`,
  'ffmpeg-core.wasm': `${CDN}/@ffmpeg/core@${FFMPEG_CORE_VER}/dist/esm/ffmpeg-core.wasm`,
};

/** The fast single htdemucs model (served at /webgpu-models/htdemucs.onnx). */
const HTDEMUCS_URL = `${HF}/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx`;

const MIME: Record<string, string> = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.onnx': 'application/octet-stream',
};

export function mimeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf('.'));
  return MIME[ext] ?? 'application/octet-stream';
}

function cacheDir(): string {
  const plat = platform();
  if (plat === 'darwin') return join(homedir(), 'Library', 'Application Support', 'dj-app', 'webgpu');
  if (plat === 'win32') return join(homedir(), 'AppData', 'Local', 'dj-app', 'webgpu');
  return join(homedir(), '.cache', 'dj-app', 'webgpu');
}

function download(url: string, destPath: string, redirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    mkdirSync(dirname(destPath), { recursive: true });
    const req = https.get(url, (res) => {
      const code = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        if (redirects <= 0) return reject(new Error('too many redirects'));
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        download(next, destPath, redirects - 1).then(resolve, reject);
        return;
      }
      if (code !== 200) {
        res.resume();
        reject(new Error(`HTTP ${code} for ${url}`));
        return;
      }
      const tmp = `${destPath}.part`;
      const out = createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => {
        out.close(() => {
          try {
            renameSync(tmp, destPath);
            resolve();
          } catch (e) {
            reject(e as Error);
          }
        });
      });
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}

/**
 * Resolve a /webgpu-assets/<key> request to a local cached file path (downloading
 * once). Returns null for unknown keys.
 */
export async function resolveAsset(key: string): Promise<string | null> {
  if (key.includes('..') || !Object.prototype.hasOwnProperty.call(ASSETS, key)) return null;
  const dest = join(cacheDir(), 'assets', key);
  if (existsSync(dest) && statSync(dest).size > 0) return dest;
  await download(ASSETS[key]!, dest);
  return dest;
}

/**
 * Resolve a /webgpu-models/<rel> request to a local cached file path. htdemucs.onnx
 * maps to the demucs ONNX; anything else proxies HuggingFace (model trees).
 */
export async function resolveModel(rel: string): Promise<string | null> {
  if (!rel || rel.includes('..')) return null;
  const dest = join(cacheDir(), 'models', rel);
  if (existsSync(dest) && statSync(dest).size > 0) return dest;
  const upstream = rel === 'htdemucs.onnx' ? HTDEMUCS_URL : `${HF}/${rel}`;
  if (!upstream.startsWith('https://huggingface.co/')) return null;
  await download(upstream, dest);
  return dest;
}

/** True for any path this resolver serves (so callers can route on it). */
export function isWebGpuPath(pathname: string): boolean {
  return pathname.startsWith('/webgpu-assets/') || pathname.startsWith('/webgpu-models/');
}

/** Resolve any /webgpu-assets|models/* pathname to {file, mime} or null. */
export async function resolveWebGpuPath(
  pathname: string,
): Promise<{ file: string; mime: string } | null> {
  if (pathname.startsWith('/webgpu-assets/')) {
    const key = decodeURIComponent(pathname.slice('/webgpu-assets/'.length));
    const file = await resolveAsset(key);
    return file ? { file, mime: mimeFor(key) } : null;
  }
  if (pathname.startsWith('/webgpu-models/')) {
    const rel = decodeURIComponent(pathname.slice('/webgpu-models/'.length));
    const file = await resolveModel(rel);
    return file ? { file, mime: mimeFor(rel) } : null;
  }
  return null;
}
