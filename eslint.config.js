// Flat ESLint config for the monorepo. TS-aware, light-touch.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-*/**',
      '**/out/**',
      '**/node_modules/**',
      'vendor/**',
      '**/*.tsbuildinfo',
      // Generated WASM base64 blobs — not source, don't lint.
      '**/src/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
  {
    // Node build scripts (.mjs) — Node globals, allow console.
    files: ['**/*.mjs', '**/scripts/**'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    // Electron preload is CommonJS (.cts) — require() is expected there.
    files: ['**/*.cts'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Worklet/worker globals
    files: ['**/*.worklet.ts', '**/*.worker.ts'],
    languageOptions: {
      globals: {
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly',
        sampleRate: 'readonly',
        currentFrame: 'readonly',
        currentTime: 'readonly',
      },
    },
  },
);
