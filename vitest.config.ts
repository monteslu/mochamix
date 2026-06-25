import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Resolve workspace packages to their TS source so vitest runs without a build
// step. Keep in sync with tsconfig.base.json "paths".
const pkg = (name: string, sub = 'src/index.ts') =>
  fileURLToPath(new URL(`./packages/${name}/${sub}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@dj/control-bus': pkg('control-bus'),
      '@dj/audio-engine': pkg('audio-engine'),
      '@dj/codec': pkg('codec'),
      '@dj/waveform': pkg('waveform'),
      '@dj/analysis': pkg('analysis'),
      '@dj/controller-host': pkg('controller-host'),
      '@dj/dsp-wasm': pkg('dsp-wasm'),
      '@dj/db': pkg('db'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    environment: 'node',
  },
});
