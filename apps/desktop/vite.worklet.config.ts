import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Dedicated build for the AudioWorklet module. AudioWorklets run in their own
// global scope and must be a single self-contained module loaded by URL via
// audioWorklet.addModule(). Vite's `new URL(...)` asset handling does NOT bundle
// a .ts worklet (it copies raw TS), so we build it separately into a stable
// filename the renderer references at runtime. (This is the Loukai pattern.)

const pkg = (name: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Order matters: the more specific subpath alias must come first.
      '@internal-dj/audio-engine/worklet': fileURLToPath(
        new URL('../../packages/audio-engine/src/engine.worklet.ts', import.meta.url),
      ),
      '@internal-dj/control-bus': pkg('control-bus'),
      '@internal-dj/audio-engine': pkg('audio-engine'),
    },
  },
  build: {
    // Emit alongside the renderer build so file:// loading finds it.
    outDir: fileURLToPath(new URL('./dist-renderer/worklets', import.meta.url)),
    emptyOutDir: true,
    target: 'esnext',
    lib: {
      entry: fileURLToPath(new URL('./src/renderer/engine-worklet-entry.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'engine.worklet.js',
    },
    rollupOptions: {
      // The worklet is fully self-contained — no externals.
      output: { inlineDynamicImports: true },
    },
  },
});
