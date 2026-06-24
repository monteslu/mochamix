import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Resolve workspace packages to their TS source so vitest runs without a build
// step. Keep in sync with tsconfig.base.json "paths".
const pkg = (name: string, sub = 'src/index.ts') =>
  fileURLToPath(new URL(`./packages/${name}/${sub}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@internal-dj/control-bus': pkg('control-bus'),
      '@internal-dj/audio-engine': pkg('audio-engine'),
      '@internal-dj/codec': pkg('codec'),
      '@internal-dj/waveform': pkg('waveform'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    environment: 'node',
  },
});
