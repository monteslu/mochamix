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
if (process.platform === 'linux') {
  // Default to X11 ozone (XWayland) on Linux. Chromium's NATIVE-Wayland backend
  // is incompatible with the Vulkan/GPU path on many setups — the GPU process
  // crash-loops ("eglCreateImage failed / OzoneImageBacking ... GPU process
  // exited unexpectedly"), pegging the app to ~30fps and blanking GPU canvases.
  // Running under XWayland avoids the broken native-Wayland dmabuf import while
  // keeping full GPU acceleration + WebGL/WebGPU. This is the same fix loukai
  // uses (`--ozone-platform=x11`) for the identical crash. Set DJ_WAYLAND=1 to
  // force native Wayland instead (sharper rendering, but the GPU crash returns
  // on affected drivers).
  if (process.env.DJ_WAYLAND === '1') {
    env.ELECTRON_OZONE_PLATFORM_HINT = 'auto';
  } else {
    env.ELECTRON_OZONE_PLATFORM_HINT = 'x11';
    // X11 ozone needs a reachable display; XWayland runs at :0. Only default it
    // if nothing set DISPLAY, so a real X session is respected.
    if (!env.DISPLAY) env.DISPLAY = ':0';
  }
}

const args = ['.', ...process.argv.slice(2)];
const res = spawnSync(electron, args, { stdio: 'inherit', env });
process.exit(res.status ?? 1);
