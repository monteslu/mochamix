/**
 * Assemble a self-contained, publishable `mochamix` package into apps/desktop/publish/.
 * The workspace package.json can't be published as-is: its @dj/* deps are unpublished
 * workspace links (a standalone `npm i mochamix` would try to fetch them from npm and fail).
 * Since the build INLINES every @dj/* package into dist-main + dist-renderer, the published
 * package needs none of them — only the true runtime externals.
 *
 * This produces publish/ with: a clean package.json (name=mochamix, bin, runtime deps only),
 * the built dist-main / dist-renderer, resources/, the bin launcher, and README/LICENSE.
 * CI runs `npm run build` then this, then `npm publish ./publish`.
 *
 * Usage: node scripts/make-publish-package.mjs [version]
 */

import {
  cpSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Recursively delete files matching a predicate (used to strip sourcemaps + type decls
 *  from the publish output — useless to `npx mochamix` end-users + leak the original source). */
function pruneFiles(dir, match) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) pruneFiles(p, match);
    else if (match(entry)) unlinkSync(p);
  }
}

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(desktop, '..', '..');
const out = join(desktop, 'publish');
// Default version; CI overrides with the git tag, e.g. `node make-publish-package.mjs 0.2.0`.
const version = process.argv[2] || '0.1.0';

// Ensure the build ran.
for (const d of ['dist-main', 'dist-renderer', 'resources']) {
  if (!existsSync(join(desktop, d))) {
    console.error(`make-publish-package: missing ${d}/ — run \`npm run build\` first.`);
    process.exit(1);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Copy the built app + the things it loads at runtime.
for (const d of ['dist-main', 'dist-renderer', 'resources', 'bin']) {
  cpSync(join(desktop, d), join(out, d), { recursive: true });
}
// Strip sourcemaps + emitted type declarations from the shipped build — they bloat the
// package, are useless to end-users running the app, and the .map files embed the full
// original source (sourcesContent). The source lives on GitHub for contributors.
pruneFiles(out, (f) => f.endsWith('.map') || f.endsWith('.d.ts') || f.endsWith('.d.cts'));
for (const f of ['README.md', 'LICENSE']) {
  if (existsSync(join(repoRoot, f))) cpSync(join(repoRoot, f), join(out, f));
}
// NOTE: the README's hero screenshot is intentionally NOT shipped in the tarball — it's a
// repo-only asset (renders on GitHub) and would bloat the install for no runtime value, per
// convention. The <img> link still resolves on GitHub via the repo's raw URL.

// Read the workspace manifest to pull the REAL runtime deps (the externals the bundle
// leaves unbundled). @dj/* and build/dev deps are intentionally dropped.
const ws = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
const RUNTIME_DEPS = ['electron', 'node-sqlite3-wasm', 'music-metadata'];
const dependencies = {};
for (const name of RUNTIME_DEPS) {
  const v = ws.dependencies?.[name] ?? ws.devDependencies?.[name];
  if (!v) {
    console.error(`make-publish-package: runtime dep "${name}" not found in apps/desktop/package.json`);
    process.exit(1);
  }
  dependencies[name] = v;
}

const pkg = {
  // npm package name: 'mochamix' is blocked as too similar to the old 'mocha-mix' package, so
  // the PACKAGE is published as 'mochamixdj' (unscoped, clean `npx mochamixdj`). The project,
  // repo, brand, and domain all stay MochaMix — this is only the npm install identifier. The
  // installed COMMAND stays `mochamix` (the bin name) so the app itself reads clean.
  name: 'mochamixdj',
  version,
  description: 'MochaMix — an open-source, stem-native DJ application. Run it: npx mochamixdj.',
  type: 'module',
  bin: { mochamix: 'bin/mochamix.mjs' },
  main: 'dist-main/main.js',
  files: ['dist-main', 'dist-renderer', 'resources', 'bin', 'README.md', 'LICENSE'],
  keywords: ['dj', 'stems', 'web', 'party', 'music'],
  engines: { node: '>=22' },
  dependencies,
  author: 'Luis Montes',
  homepage: 'https://github.com/monteslu/mochamix',
  repository: { type: 'git', url: 'git+https://github.com/monteslu/mochamix.git' },
  bugs: { url: 'https://github.com/monteslu/mochamix/issues' },
  license: 'MIT',
};
writeFileSync(join(out, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

console.log(`Wrote self-contained package → ${out} (mochamixdj@${version})`);
console.log('Publish with: npm publish ' + out);
