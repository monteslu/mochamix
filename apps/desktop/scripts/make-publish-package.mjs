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

import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(desktop, '..', '..');
const out = join(desktop, 'publish');
const version = process.argv[2] || '0.0.1';

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
  name: 'mochamix',
  version,
  description: 'MochaMix — an open-source, stem-native DJ application. Run it: npx mochamix.',
  type: 'module',
  bin: { mochamix: 'bin/mochamix.mjs' },
  main: 'dist-main/main.js',
  files: ['dist-main', 'dist-renderer', 'resources', 'bin', 'README.md', 'LICENSE'],
  engines: { node: '>=22' },
  dependencies,
  homepage: 'https://github.com/monteslu/mochamix',
  repository: { type: 'git', url: 'git+https://github.com/monteslu/mochamix.git' },
  license: 'MIT',
};
writeFileSync(join(out, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

console.log(`Wrote self-contained package → ${out} (mochamix@${version})`);
console.log('Publish with: npm publish ' + out);
