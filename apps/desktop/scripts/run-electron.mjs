/**
 * Launch Electron with the right display backend. On a Linux Wayland session,
 * Electron's default X11 ozone path crashes early ("Missing X server or $DISPLAY")
 * — BEFORE app.commandLine switches are read — so the fix must be an env var the
 * binary reads at startup: ELECTRON_OZONE_PLATFORM_HINT=auto (Electron then picks
 * Wayland or X11 correctly). Cross-platform; passes through all extra args.
 *
 * Usage: node scripts/run-electron.mjs [electron args...]
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron'); // resolves to the binary path string

const env = { ...process.env };
if (process.platform === 'linux' && !env.ELECTRON_OZONE_PLATFORM_HINT) {
  // Native Wayland by default: WebGPU compute (the stem-separation backend) works
  // on native Wayland here (verified: requestAdapter → amd/rdna-3 device OK), and
  // X11 ozone is fragile (fails outright when XWayland isn't reachable). The 2D-
  // compositor GPU-rasterization crash is handled in main.ts WITHOUT disabling
  // the GPU, so WebGPU stays available. DJ_OZONE=x11 forces XWayland if ever
  // needed (e.g. a driver where Wayland WebGPU regresses).
  env.ELECTRON_OZONE_PLATFORM_HINT = process.env.DJ_OZONE === 'x11' ? 'x11' : 'auto';
}

const args = ['.', ...process.argv.slice(2)];
const res = spawnSync(electron, args, { stdio: 'inherit', env });
process.exit(res.status ?? 1);
