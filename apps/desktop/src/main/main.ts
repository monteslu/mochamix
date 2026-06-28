/**
 * Electron main process — the CoreServices-equivalent (03-architecture.md §3).
 *
 * M1 scope is deliberately thin: serve the renderer from a custom `app://`
 * protocol with COOP/COEP headers baked in (so the renderer is cross-origin
 * isolated and SharedArrayBuffer + WASM threads work — 10-electron-feasibility.md
 * §5), create the window, and provide a file-open dialog. The control bus lives in
 * the RENDERER for M1; making it main-authoritative with an IPC mirror is a later
 * milestone.
 *
 * Why a custom protocol instead of loadFile(): COOP/COEP injected via
 * onHeadersReceived do NOT reliably reach the top-level file:// document, so
 * `crossOriginIsolated` stays false and SharedArrayBuffer is undefined. Serving
 * from a registered streaming protocol lets us set the headers on the document
 * response itself, which is the bulletproof approach for packaged apps.
 */

import { app, BrowserWindow, ipcMain, dialog, protocol, net } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir, access, readdir, rm } from 'node:fs/promises';
import { dirname, join, normalize, basename, extname } from 'node:path';
import { LibraryService } from './library-service.js';
import type { QueryOptions } from '@dj/db';
import { isWebGpuPath, resolveWebGpuPath } from '@dj/stems/asset-server';

const __dirname = dirname(fileURLToPath(import.meta.url));
// main.js (esbuild-bundled) lives at dist-main/main.js → renderer is one up.
const RENDERER_DIR = join(__dirname, '../dist-renderer');
// Bundled Mixxx controller mappings (their actual GPL res/controllers tree). In dev the
// source lives at apps/desktop/resources/controllers; packaged, electron-builder copies
// it under resources/. Resolve to whichever exists.
const CONTROLLERS_DIR = join(__dirname, '../resources/controllers');
const isDev = process.argv.includes('--dev');

// Log versions on startup so a pasted console dump unambiguously shows WHICH
// Electron/Chromium actually ran (stale binaries vs the upgraded one are otherwise
// indistinguishable in the logs).
console.log(
  `[dj-app] electron ${process.versions.electron} | chromium ${process.versions.chrome} | node ${process.versions.node}`,
);

// Set a clean app name BEFORE any getPath('userData') call. The package name is
// "@dj/desktop", whose "/" produces a nested userData path
// (.config/@dj/desktop) — fragile for file creation. Use a flat name.
app.setName('dj-app');

// WebGPU enablement. MUST be set here (module load, before app ready) — switches
// applied inside whenReady() are read too late. Stem separation (Demucs) + future
// ML run on WebGPU compute, so this is load-bearing, not optional:
//   enable-unsafe-webgpu : makes navigator.gpu appear in Electron on Linux
//   enable-features=Vulkan : provides the Dawn backend — without it WebGPU is
//        absent or "super slow" (per loukai's verified config). Linux→Vulkan,
//        macOS→Metal, Windows→D3D12 under the hood.
// SPEED over experimental WebGPU. On Linux, enabling Vulkan is what forces
// Chromium's native-Wayland present path into a slow ~30fps fallback ("wayland is
// not compatible with Vulkan"). WebGPU on Linux is still experimental, so we do
// NOT enable Vulkan by default — that keeps the fast GL present path on Wayland
// and the waveform WebGL renderer flies. Stems (Demucs) run on WASM for now, like
// loukai does on Wayland. Opt into WebGPU/Vulkan later with DJ_WEBGPU=1 (accepts
// the frame-rate hit), e.g. for GPU stem separation on a beefy machine.
if (process.env.DJ_WEBGPU === '1') {
  app.commandLine.appendSwitch('enable-unsafe-webgpu');
  app.commandLine.appendSwitch('enable-features', 'Vulkan');
}

// Frame pacing. By DEFAULT we leave Chromium's normal vsync in place: rAF fires once
// per display refresh (60/120Hz), which is smooth, tear-free, and renders exactly the
// frames that get shown — no waste. (Our render loop is a single shared rAF; audio is
// on the AudioWorklet's real-time thread, independent of frame rate.)
//
// DJ_UNCAP=1 disables the frame-rate limit + GPU vsync. This is ONLY needed as a
// workaround for a specific Wayland/4K Linux setup where Chromium otherwise pegs rAF
// at 30fps. It causes tearing + renders thousands of discarded fps (wasted power), so
// it is opt-in, not the default.
if (process.env.DJ_UNCAP === '1') {
  app.commandLine.appendSwitch('disable-frame-rate-limit');
  app.commandLine.appendSwitch('disable-gpu-vsync');
}

// This is OUR app, not an untrusted web page, so the browser autoplay-gesture
// requirement (which forces a "start audio" click before AudioContext can run) does
// NOT apply. Disable it so the engine auto-starts on load — no start-audio button.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');


const SCHEME = 'app';
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

// Register the custom scheme as privileged BEFORE app ready: secure context,
// supports fetch, streaming, and is treated like https for isolation purposes.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

/** Map an app:// request to a file under the renderer dir and stream it back. */
function handleAppProtocol(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // app://app/index.html → RENDERER_DIR/index.html
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === '') {
    pathname = '/index.html';
  }
  // WebGPU stem-generation libs + ONNX models: download-once-cache, served
  // same-origin (so the renderer's dynamic import()s + fetch()s resolve under COEP).
  if (isWebGpuPath(pathname)) {
    return resolveWebGpuPath(pathname)
      .then((hit) => {
        if (!hit) return new Response('unknown asset', { status: 404 });
        return net.fetch(pathToFileURL(hit.file).toString()).then((res) => {
          const headers = new Headers(res.headers);
          for (const [k, v] of Object.entries(ISOLATION_HEADERS)) headers.set(k, v);
          headers.set('Content-Type', hit.mime);
          headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
          headers.set('Cache-Control', 'public, max-age=31536000, immutable');
          return new Response(res.body, { status: res.status, headers });
        });
      })
      .catch((e) => new Response(`asset error: ${String(e)}`, { status: 502 }));
  }
  // Prevent path traversal.
  const filePath = normalize(join(RENDERER_DIR, pathname));
  if (!filePath.startsWith(normalize(RENDERER_DIR))) {
    return Promise.resolve(new Response('forbidden', { status: 403 }));
  }
  return net
    .fetch(pathToFileURL(filePath).toString())
    .then((res) => {
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(ISOLATION_HEADERS)) {
        headers.set(k, v);
      }
      // Never let Electron's HTTP cache serve a stale renderer after a rebuild —
      // index.html keeps a constant name but points at freshly-hashed assets, so a
      // cached index.html would load the OLD bundle (looks like "no changes").
      headers.set('Cache-Control', 'no-store, must-revalidate');
      return new Response(res.body, { status: res.status, headers });
    })
    .catch(() => new Response('not found', { status: 404 }));
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0e1014',
    title: 'dj-app',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // A DJ app is driven by a hardware controller, not the screen — it must keep
      // rendering at full rate even when the window loses focus (you're looking at the
      // decks, touching the controller). Electron throttles rAF on unfocused/occluded
      // windows by default → the 30fps / laggy fader animation. Turn it off.
      backgroundThrottling: false,
    },
  });

  // Grant Web MIDI. Without these handlers Electron silently hands the renderer an
  // EMPTY device list (navigator.requestMIDIAccess resolves but enumerates nothing),
  // which looks like "no controller" even when one is plugged in. We approve midi +
  // midiSysex (DJ controllers need sysex for LED/display init). setPermissionCheckHandler
  // is the SYNCHRONOUS check requestMIDIAccess uses; the request handler covers the
  // async prompt path. (Our own app, local content — safe to grant.)
  const ses = win.webContents.session;
  // Our own local app content → grant the permissions it needs (notably midi/midiSysex).
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));
  ses.setPermissionCheckHandler(() => true);

  win.webContents.on('console-message', (_e, _level, message) => {
    console.log(`[renderer] ${message}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[renderer] process gone: ${details.reason}`);
  });

  const load = () => {
    if (isDev && process.env.VITE_DEV_SERVER_URL) {
      void win.loadURL(process.env.VITE_DEV_SERVER_URL);
      win.webContents.openDevTools();
    } else {
      void win.loadURL(`${SCHEME}://app/index.html`);
      if (isDev) win.webContents.openDevTools();
    }
  };

  // In dev, purge any cached renderer first so a rebuild ALWAYS shows — the #1
  // "my changes aren't showing" cause. Cheap; only runs with --dev.
  if (isDev) {
    void win.webContents.session.clearCache().finally(load);
  } else {
    load();
  }

  return win;
}

// IPC: open a file dialog and return the picked file's bytes + name.
ipcMain.handle('dialog:openTrack', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Load track',
    properties: ['openFile'],
    filters: [
      {
        name: 'Audio',
        extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'aiff', 'aif'],
      },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  const path = result.filePaths[0]!;
  const buf = await readFile(path);
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { name: path.split(/[\\/]/).pop() ?? 'track', data: arrayBuffer, path };
});

// IPC: read a dropped file path's bytes.
ipcMain.handle('track:read', async (_e, path: string) => {
  const buf = await readFile(path);
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { name: path.split(/[\\/]/).pop() ?? 'track', data: arrayBuffer };
});

// --- Library service + IPC -------------------------------------------------

let library: LibraryService | null = null;
function getLibrary(): LibraryService {
  if (library) {
    return library;
  }
  const dbPath = join(app.getPath('userData'), 'library.db');
  try {
    library = new LibraryService(dbPath);
    // Self-heal: drop stem links whose .stem.mp4 was deleted off disk while the app
    // was closed, so a row never shows "stems" for a file that's gone.
    void library.pruneMissingStems().then((n) => {
      if (n > 0) console.log(`[library] pruned ${n} missing stem file(s)`);
    });
  } catch (err) {
    // The on-disk DB couldn't be opened (corruption / stale lock the cleanup
    // missed / permissions). Rather than fail every IPC call, fall back to an
    // in-memory library so the app stays usable; the user just won't have a
    // persisted library this session. Surface it once.
    console.error(`Library DB at ${dbPath} failed to open; using in-memory fallback:`, err);
    library = new LibraryService(':memory:');
  }
  return library;
}

ipcMain.handle('library:query', (_e, opts: QueryOptions) => getLibrary().query(opts));
ipcMain.handle('library:count', (_e, search?: string) => getLibrary().count(search));

// ── Visual display windows (the output-bus consumer side) ────────────────────
// dj-app emits data; a popup display window renders the visuals. The main process
// relays frames from the producer (main renderer) to every open display window.
const displayWindows = new Set<BrowserWindow>();
ipcMain.handle('display:open', () => {
  const disp = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: '#000000',
    title: 'dj-app visualizer',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // visuals must keep rendering when unfocused
    },
  });
  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    void disp.loadURL(new URL('display.html', process.env.VITE_DEV_SERVER_URL).href);
  } else {
    void disp.loadURL(`${SCHEME}://app/display.html`);
  }
  displayWindows.add(disp);
  disp.on('closed', () => displayWindows.delete(disp));
  return true;
});
// Producer (main renderer) → relay each frame to all display windows. Audio frames are
// high-rate; this is a thin forward (no processing). The transferable Uint8Array is
// structured-cloned over IPC.
ipcMain.on('display:frame', (_e, frame: unknown) => {
  for (const w of displayWindows) {
    if (!w.isDestroyed()) w.webContents.send('display:frame', frame);
  }
});
// ── Controller mappings (bundled Mixxx res/controllers) ──────────────────────
// list = the picker index (name/author/file); readFile = a single mapping file's text
// (xml or js), used to load a mapping + its referenced <file> scripts.
ipcMain.handle('controllers:list', async () => {
  try {
    const idx = await readFile(join(CONTROLLERS_DIR, 'index.json'), 'utf8');
    return JSON.parse(idx) as Array<{ file: string; name: string; author: string }>;
  } catch {
    return [];
  }
});
ipcMain.handle('controllers:readFile', async (_e, filename: string) => {
  // Guard against path traversal — only files directly inside the controllers dir.
  const safe = basename(filename);
  if (safe !== filename) return null;
  try {
    return await readFile(join(CONTROLLERS_DIR, safe), 'utf8');
  } catch {
    // Fall back to USER controllers (clones/edits live in userData) so user mappings
    // and their <file> scripts also resolve through the same read path.
    try {
      return await readFile(join(userControllersDir(), safe), 'utf8');
    } catch {
      return null;
    }
  }
});

// ── USER controller mappings (cloned/edited copies, in userData/controllers) ──
function userControllersDir(): string {
  return join(app.getPath('userData'), 'controllers');
}
ipcMain.handle('userControllers:list', async () => {
  try {
    const dir = userControllersDir();
    const files = (await readdir(dir)).filter((f) => f.endsWith('.midi.xml'));
    const out: Array<{ file: string; name: string }> = [];
    for (const file of files) {
      const xml = await readFile(join(dir, file), 'utf8');
      const name = (/<name>([^<]+)<\/name>/i.exec(xml)?.[1] ?? file.replace(/\.midi\.xml$/, '')).trim();
      out.push({ file, name });
    }
    return out;
  } catch {
    return [];
  }
});
ipcMain.handle('userControllers:read', async (_e, filename: string) => {
  const safe = basename(filename);
  if (safe !== filename) return null;
  try {
    return await readFile(join(userControllersDir(), safe), 'utf8');
  } catch {
    return null;
  }
});
ipcMain.handle('userControllers:save', async (_e, filename: string, content: string) => {
  const safe = basename(filename);
  if (safe !== filename || (!safe.endsWith('.midi.xml') && !safe.endsWith('.js'))) return false;
  const dir = userControllersDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, safe), content, 'utf8');
  return true;
});
ipcMain.handle('userControllers:delete', async (_e, filename: string) => {
  const safe = basename(filename);
  if (safe !== filename) return false;
  try {
    await rm(join(userControllersDir(), safe), { force: true });
    return true;
  } catch {
    return false;
  }
});

// Persist the user's chosen controller mapping + device so it auto-loads next launch
// (instead of falling back to Generic auto-connect). Stored as a small JSON in userData.
function controllerConfigPath(): string {
  return join(app.getPath('userData'), 'controller-config.json');
}
ipcMain.handle('controllerConfig:get', async () => {
  try {
    return JSON.parse(await readFile(controllerConfigPath(), 'utf8')) as {
      mapping: string;
      device: string | null;
    };
  } catch {
    return null; // nothing saved yet (or unreadable) → caller falls back to auto-connect
  }
});
ipcMain.handle(
  'controllerConfig:set',
  async (_e, config: { mapping: string; device: string | null } | null) => {
    try {
      if (config === null) {
        await rm(controllerConfigPath(), { force: true });
      } else {
        await writeFile(controllerConfigPath(), JSON.stringify(config), 'utf8');
      }
      return true;
    } catch {
      return false;
    }
  },
);

ipcMain.handle('library:crates', () => getLibrary().listCrates());
ipcMain.handle('library:crateTracks', (_e, id: number) => getLibrary().crateTracks(id));
ipcMain.handle(
  'library:setAnalysis',
  (
    _e,
    id: number,
    a: { bpm?: number; firstBeatFrame?: number; key?: string; waveform?: Uint8Array; analyzedAt?: number },
  ) => getLibrary().setAnalysis(id, a),
);
ipcMain.handle('library:waveform', (_e, id: number) => getLibrary().getWaveform(id));
ipcMain.handle('library:downbeats', (_e, id: number) => getLibrary().getDownbeats(id));
ipcMain.handle('library:stemWaveforms', (_e, id: number) => getLibrary().db.getStemWaveforms(id));
ipcMain.handle('library:setStemWaveforms', (_e, id: number, blob: Uint8Array) =>
  getLibrary().db.setStemWaveforms(id, blob),
);
ipcMain.handle('library:stemsNeedingWaveforms', (_e, limit?: number) =>
  getLibrary().db.stemsNeedingWaveforms(limit),
);
ipcMain.handle('library:unanalyzed', (_e, limit?: number) => getLibrary().unanalyzedTrackIds(limit));
ipcMain.handle('library:reanalyzeAll', () => getLibrary().reanalyzeAll());
ipcMain.handle('library:stemless', (_e, limit?: number) => getLibrary().db.stemlessTrackIds(limit));
// Save generated stems (a .stem.mp4 the renderer produced via WebGPU) next to the
// original track, and link it so playback prefers the 4 separable stems. Returns the
// written path. The original file is never touched.
ipcMain.handle('stems:save', async (_e, id: number, data: ArrayBuffer) => {
  const track = getLibrary().query({}).find((t) => t.id === id);
  if (!track) return null;
  const base = basename(track.location, extname(track.location));
  const stemPath = join(dirname(track.location), `${base}.stem.mp4`);
  await writeFile(stemPath, new Uint8Array(data));
  getLibrary().db.setStems(id, { stemPath });
  return stemPath;
});
ipcMain.handle('library:incrementPlay', (_e, id: number) => getLibrary().incrementPlayCount(id));
ipcMain.handle('track:cover', (_e, path: string) => getLibrary().getCover(path));

// IPC: save a recording (WAV ArrayBuffer) to disk. Defaults to a Recordings
// folder with a timestamped name; offers a Save dialog.
ipcMain.handle('recording:save', async (_e, wav: ArrayBuffer) => {
  const recDir = join(app.getPath('music'), 'dj-app Recordings');
  await mkdir(recDir, { recursive: true }).catch(() => {});
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const defaultPath = join(recDir, `mix-${stamp}.wav`);
  const result = await dialog.showSaveDialog({
    title: 'Save recording',
    defaultPath,
    filters: [{ name: 'WAV audio', extensions: ['wav'] }],
  });
  if (result.canceled || !result.filePath) {
    return null;
  }
  await writeFile(result.filePath, Buffer.from(wav));
  return result.filePath;
});
ipcMain.handle('library:readTrackById', async (_e, id: number, preferOriginal?: boolean) => {
  const track = getLibrary().query({}).find((t) => t.id === id);
  if (!track) {
    return null;
  }
  const exists = async (p: string | null | undefined): Promise<boolean> => {
    if (!p) return false;
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  };
  const hasStem = await exists(track.stemPath);
  const hasOriginal = await exists(track.location);
  // Drop a stale stem link so the row stops showing "stems" if the file's gone.
  if (track.stemPath && !hasStem) getLibrary().db.clearStems(track.id);

  // Source selection:
  //  - PLAYBACK (default): prefer the .stem.mp4 (4 separable stems for mashups), else
  //    the original.
  //  - ANALYSIS (preferOriginal): prefer the ORIGINAL (smaller, decodes reliably; the
  //    5-track .stem.mp4 is bigger and some don't decode cleanly). BUT if the user has
  //    removed the original and kept only the .stem.mp4, fall back to the stem — its
  //    first track is the mixdown, which is exactly what analysis wants.
  let source: string;
  let isStem: boolean;
  if (preferOriginal) {
    if (hasOriginal) {
      source = track.location;
      isStem = false;
    } else if (hasStem) {
      source = track.stemPath!;
      isStem = true; // analyzing the .stem.mp4's mixdown (original is gone)
    } else {
      return null; // nothing on disk
    }
  } else {
    if (hasStem) {
      source = track.stemPath!;
      isStem = true;
    } else if (hasOriginal) {
      source = track.location;
      isStem = false;
    } else {
      return null;
    }
  }

  const buf = await readFile(source);
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  // Include the stored analysis (key/bpm/artist/etc) so the deck shows them immediately
  // on load without a metadata round-trip or a needless re-analysis.
  return {
    name: track.filename,
    data: arrayBuffer,
    path: source,
    isStem,
    meta: {
      title: track.title ?? undefined,
      artist: track.artist ?? undefined,
      album: track.album ?? undefined,
      key: track.key ?? undefined,
      bpm: track.bpm ?? undefined,
    },
  };
});

// IPC: pick a folder + scan it, streaming progress back to the renderer.
ipcMain.handle('library:scan', async (e) => {
  const result = await dialog.showOpenDialog({
    title: 'Add music folder',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  const root = result.filePaths[0]!;
  const summary = await getLibrary().scanDirectory(root, (p) => {
    e.sender.send('library:scanProgress', p);
  });
  // also drop any stem links whose file disappeared since last time
  await getLibrary().pruneMissingStems();
  return summary;
});

// IPC: sync the WHOLE library — re-walk every known root, add new, sweep deleted
// (Mixxx LibraryScanner model). No dialog; uses the stored directories.
ipcMain.handle('library:sync', async (e) => {
  return getLibrary().syncLibrary((p) => {
    e.sender.send('library:scanProgress', p);
  });
});
ipcMain.handle('library:directories', () => getLibrary().db.listDirectories());
ipcMain.handle('library:addDirectory', async (e) => {
  const result = await dialog.showOpenDialog({
    title: 'Add music folder',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const root = result.filePaths[0]!;
  const summary = await getLibrary().scanDirectory(root, (p) => {
    e.sender.send('library:scanProgress', p);
  });
  await getLibrary().pruneMissingStems();
  return summary;
});
ipcMain.handle('library:removeDirectory', (_e, dir: string) => {
  getLibrary().db.removeDirectory(dir);
});
ipcMain.handle('settings:get', (_e, key: string) => getLibrary().db.getSetting(key));
ipcMain.handle('settings:set', (_e, key: string, value: string) =>
  getLibrary().db.setSetting(key, value),
);

app.whenReady().then(() => {
  // (WebGPU switches are set at module load above — too late if done here.)
  protocol.handle(SCHEME, handleAppProtocol);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Closing the window quits the app — ON EVERY PLATFORM, including macOS. The usual Mac
// "stay resident in the dock" behavior is deliberately disabled (it's a DJ app, not a
// menu-bar utility — when you close it, it should fully exit and free the audio device).
app.on('window-all-closed', () => {
  app.quit();
});
