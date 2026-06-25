/**
 * Browser build/dev config — runs the renderer as a standalone web app (no
 * Electron) for Playwright e2e + the future web-DJ target. Same workspace aliases
 * as the Electron build, plus the COOP/COEP headers SharedArrayBuffer needs.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

// cross-origin isolation (required for SharedArrayBuffer)
const coopCoep = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  define: {
    __BUILD_TIME__: JSON.stringify(
      new Date().toISOString().slice(11, 19) + ' ' + new Date().toISOString().slice(5, 10),
    ),
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@internal-dj/analysis/worker': fileURLToPath(
        new URL('../../packages/analysis/src/analysis.worker.ts', import.meta.url),
      ),
      '@internal-dj/control-bus': pkg('control-bus'),
      '@internal-dj/audio-engine': pkg('audio-engine'),
      '@internal-dj/codec': pkg('codec'),
      '@internal-dj/waveform': pkg('waveform'),
      '@internal-dj/analysis': pkg('analysis'),
      '@internal-dj/dsp-wasm': pkg('dsp-wasm'),
    },
  },
  server: {
    headers: coopCoep,
    port: 5174,
  },
  preview: {
    headers: coopCoep,
    port: 5174,
  },
  build: {
    outDir: fileURLToPath(new URL('./dist-browser', import.meta.url)),
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      input: { browser: fileURLToPath(new URL('./src/renderer/browser.html', import.meta.url)) },
    },
  },
  worker: { format: 'es' },
});
