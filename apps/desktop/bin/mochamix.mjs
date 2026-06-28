#!/usr/bin/env node
/**
 * `npx mochamix-app` / `mochamix` launcher. Resolves the Electron binary that ships as a
 * dependency of this package and runs the bundled app (dist-main/main.js) against it.
 *
 * This is the published entry point. The app is fully bundled at publish time:
 * dist-main/main.js has the @dj/* workspace packages inlined; the renderer is in
 * dist-renderer; only electron + node-sqlite3-wasm + music-metadata load at runtime.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let electronPath;
try {
  electronPath = require('electron'); // 'electron' module exports the binary path string
} catch {
  console.error(
    'MochaMix: the Electron runtime is missing. Reinstall the package ' +
      '(npm i -g mochamix-app) or run `npx mochamix-app@latest`.',
  );
  process.exit(1);
}

const env = { ...process.env };
const userArgs = process.argv.slice(2);
const extraArgs = [];

if (process.platform === 'linux') {
  // Let Electron auto-pick the ozone backend (Wayland/X11) — see run-electron.mjs.
  if (!env.ELECTRON_OZONE_PLATFORM_HINT) env.ELECTRON_OZONE_PLATFORM_HINT = 'auto';

  // When Electron is installed via npm/npx (not as root), its SUID sandbox helper
  // (chrome-sandbox) isn't owned by root with mode 4755, so Electron FATALs:
  //   "The SUID sandbox helper binary was found, but is not configured correctly."
  // Fixing that needs sudo (bad UX for `npx`), so we run with --no-sandbox by default —
  // the standard approach for npm-distributed Electron apps. A user can opt back into the
  // sandbox by passing --sandbox (and chmod'ing chrome-sandbox to root:4755 themselves).
  const sandboxRequested = userArgs.includes('--sandbox');
  const noSandboxGiven = userArgs.includes('--no-sandbox');
  if (!sandboxRequested && !noSandboxGiven) extraArgs.push('--no-sandbox');
}

// Launch Electron on the bundled app dir (package root), passing through any extra args.
const args = [pkgRoot, ...extraArgs, ...userArgs];
const child = spawn(electronPath, args, { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error('MochaMix: failed to launch Electron:', err.message);
  process.exit(1);
});
