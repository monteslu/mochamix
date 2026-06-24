/**
 * Bundle the Electron main process + preload with esbuild. Workspace TS packages
 * (e.g. @internal-dj/db) get bundled in; native/Electron modules stay external
 * (loaded at runtime by Node/Electron).
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Modules that must NOT be bundled (native addons + electron + node builtins).
const external = ['electron', 'better-sqlite3', 'music-metadata'];

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  external,
  sourcemap: true,
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: [`${root}/src/main/main.ts`],
  outfile: `${root}/dist-main/main.js`,
  banner: {
    // ESM needs require() for some CJS interop (better-sqlite3); shim it.
    js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
  },
});

// Preload must be CommonJS (Electron preload context).
await build({
  ...common,
  format: 'cjs',
  entryPoints: [`${root}/src/main/preload.cts`, `${root}/src/main/preload-verify.cts`],
  outdir: `${root}/dist-main`,
  outExtension: { '.js': '.cjs' },
  banner: {},
});

console.log('main + preload bundled.');
