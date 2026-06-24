import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Resolve workspace packages to source (no pre-build step needed; Vite bundles).
const pkg = (name: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './', // relative paths so file:// loading works in Electron
  plugins: [react()],
  resolve: {
    alias: {
      '@internal-dj/control-bus': pkg('control-bus'),
      '@internal-dj/audio-engine': pkg('audio-engine'),
      '@internal-dj/codec': pkg('codec'),
      '@internal-dj/waveform': pkg('waveform'),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist-renderer', import.meta.url)),
    emptyOutDir: true,
    target: 'esnext', // Electron's Chromium is current; we can use the latest
  },
  worker: {
    format: 'es',
  },
});
