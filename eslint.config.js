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
    // Node build/harness scripts (.mjs/.cjs/scripts) — full Node globals.
    files: ['**/*.mjs', '**/*.cjs', '**/scripts/**'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        require: 'readonly',
        module: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
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
  {
    // WEB-ONLY code: shared packages + the renderer must stay web-standard so
    // they run in the browser/worker/worklet. Electron is for file access in the
    // MAIN process only; everything else should not depend on Node. Ban Node
    // globals + node: imports here (this is the rule that would have caught the
    // `Buffer is not defined` renderer crash). Main-process code is exempt below.
    files: ['packages/*/src/**/*.{ts,tsx}', 'apps/desktop/src/renderer/**/*.{ts,tsx}'],
    // packages/db is the SQLite file-access layer — main-process only by design,
    // so Node deps are expected there (Electron's job: file access). Tests run in
    // Node too. Everything else must stay web-standard.
    ignores: ['**/*.test.ts', '**/*.test.tsx', 'packages/db/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'Buffer', message: 'Node-only. Use atob/Uint8Array (web-standard) — runs in renderer/worker too.' },
        { name: 'process', message: 'Node-only. Keep Node deps in apps/desktop/src/main.' },
        { name: 'global', message: 'Node-only. Use globalThis.' },
        { name: '__dirname', message: 'Node-only. Not available in the renderer.' },
        { name: '__filename', message: 'Node-only. Not available in the renderer.' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'Node builtins are main-process only. Keep web packages/renderer web-standard.' },
            { group: ['fs', 'path', 'os', 'child_process', 'crypto', 'stream'], message: 'Node builtins are main-process only.' },
          ],
        },
      ],
    },
  },
);
