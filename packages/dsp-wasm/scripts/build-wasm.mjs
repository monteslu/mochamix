/**
 * Build the WASM DSP modules from csrc/ and emit them as base64-embedded .ts so
 * they can be instantiated SYNCHRONOUSLY inside an AudioWorklet (no fetch/import
 * available there). Requires emcc on PATH (source emsdk_env.sh first).
 *
 * Run: npm run build:wasm  (from packages/dsp-wasm)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const csrc = join(root, 'csrc');
const wasmDir = join(root, 'wasm');
const genDir = join(root, 'src', 'generated');
mkdirSync(wasmDir, { recursive: true });
mkdirSync(genDir, { recursive: true });

const modules = [
  {
    name: 'resampler',
    src: 'resampler.c',
    exports: ['_resampler_pull', '_resampler_last_position', '_resampler_last_produced', '_malloc', '_free'],
  },
  {
    name: 'beatdetect',
    src: 'beatdetect.c',
    exports: [
      '_beatdetect_run',
      '_beatdetect_bpm',
      '_beatdetect_first_beat_frame',
      '_beatdetect_confidence',
      '_bd_malloc',
      '_bd_free',
    ],
    // A full track's stereo float source can be large; allow the heap to grow.
    growMemory: true,
  },
];

for (const m of modules) {
  const out = join(wasmDir, `${m.name}-standalone.wasm`);
  console.log(`compiling ${m.src} → ${m.name}-standalone.wasm (SIMD, O3)`);
  execFileSync(
    'emcc',
    [
      join(csrc, m.src),
      '-O3',
      '-msimd128',
      '--no-entry',
      '-s', 'STANDALONE_WASM=1',
      '-s', `EXPORTED_FUNCTIONS=${JSON.stringify(m.exports)}`,
      '-s', `ALLOW_MEMORY_GROWTH=${m.growMemory ? 1 : 0}`,
      '-s', 'INITIAL_MEMORY=33554432',
      ...(m.growMemory ? ['-s', 'MAXIMUM_MEMORY=536870912'] : []),
      '-o', out,
    ],
    { stdio: 'inherit' },
  );

  const bytes = readFileSync(out);
  const b64 = bytes.toString('base64');
  const ts = `/* AUTO-GENERATED from csrc/${m.src} by scripts/build-wasm.mjs. Do not edit. */
/* eslint-disable */
export const ${m.name}WasmBase64 = '${b64}';
`;
  const dest = join(genDir, `${m.name}-wasm.ts`);
  writeFileSync(dest, ts);
  console.log(`wrote ${dest} (${b64.length} b64 chars, ${bytes.length} wasm bytes)`);
}

console.log('done.');
