import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Dedicated build for the AudioWorklet modules. AudioWorklets run in their own
// global scope and must each be a single self-contained module loaded by URL via
// audioWorklet.addModule(). Vite's `new URL(...)` asset handling does NOT bundle
// a .ts worklet (it copies raw TS), so we build them separately into stable
// filenames the renderer references at runtime. (This is the Loukai pattern.)
//
// We build MULTIPLE worklet entries (engine + recorder); each must be fully
// self-contained, so inlineDynamicImports per entry — done via separate outputs.

const pkg = (name: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Order matters: the more specific subpath aliases must come first.
      '@dj/audio-engine/worklet': r('../../packages/audio-engine/src/engine.worklet.ts'),
      '@dj/codec/recorder-worklet': r('../../packages/codec/src/recorder.worklet.ts'),
      '@dj/control-bus': pkg('control-bus'),
      '@dj/audio-engine': pkg('audio-engine'),
      '@dj/codec': pkg('codec'),
    },
  },
  build: {
    outDir: r('./dist-renderer/worklets'),
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      input: {
        'engine.worklet': r('./src/renderer/engine-worklet-entry.ts'),
        'recorder.worklet': r('./src/renderer/recorder-worklet-entry.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        // Each worklet must be standalone; inlining keeps them single-file.
        inlineDynamicImports: false,
        manualChunks: undefined,
      },
      // Avoid sharing chunks between the two worklets (each self-contained).
      preserveEntrySignatures: 'strict',
    },
  },
});
