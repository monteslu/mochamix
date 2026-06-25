import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Resolve workspace packages to source (no pre-build step needed; Vite bundles).
const pkg = (name: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './', // relative paths so file:// loading works in Electron
  // Stamp the build time so the running window visibly proves it's the latest
  // build (shown in the titlebar). Kills "is this even the new code?" ambiguity.
  define: {
    __BUILD_TIME__: JSON.stringify(
      new Date().toISOString().slice(11, 19) + ' ' + new Date().toISOString().slice(5, 10),
    ),
  },
  plugins: [react()],
  resolve: {
    alias: {
      // More-specific subpaths first.
      '@dj/analysis/worker': fileURLToPath(
        new URL('../../packages/analysis/src/analysis.worker.ts', import.meta.url),
      ),
      '@dj/control-bus': pkg('control-bus'),
      '@dj/audio-engine': pkg('audio-engine'),
      '@dj/codec': pkg('codec'),
      '@dj/waveform': pkg('waveform'),
      '@dj/analysis': pkg('analysis'),
      '@dj/dsp-wasm': pkg('dsp-wasm'),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist-renderer', import.meta.url)),
    emptyOutDir: true,
    target: 'esnext', // Electron's Chromium is current; we can use the latest
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./src/renderer/index.html', import.meta.url)),
        verify: fileURLToPath(new URL('./src/renderer/verify.html', import.meta.url)),
      },
    },
  },
  worker: {
    format: 'es',
  },
});
