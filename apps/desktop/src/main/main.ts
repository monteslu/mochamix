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
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, join, normalize, basename, extname } from 'node:path';
import { LibraryService } from './library-service.js';
import type { QueryOptions } from '@dj/db';
import { isWebGpuPath, resolveWebGpuPath } from '@dj/stems/asset-server';

const __dirname = dirname(fileURLToPath(import.meta.url));
// main.js (esbuild-bundled) lives at dist-main/main.js → renderer is one up.
const RENDERER_DIR = join(__dirname, '../dist-renderer');
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

// Unthrottle the frame rate. Chromium caps rAF to ~30fps on this Wayland/4K
// display (verified: a blank headed browser page runs at 30fps; these two flags
// take it to 58-60). Both switches are present in the Electron binary; they pass
// through unchanged. DJ_VSYNC=1 restores the default cap.
if (process.env.DJ_VSYNC !== '1') {
  app.commandLine.appendSwitch('disable-frame-rate-limit');
  app.commandLine.appendSwitch('disable-gpu-vsync');
}


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
    },
  });

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
ipcMain.handle('library:readTrackById', async (_e, id: number) => {
  const track = getLibrary().query({}).find((t) => t.id === id);
  if (!track) {
    return null;
  }
  // Prefer the generated .stem.mp4 when present: it carries 4 independently-
  // controllable stems for live mashups. Fall back to the original file. The
  // original is never deleted, just ignored in favor of the stems.
  let source = track.location;
  let isStem = false;
  if (track.stemPath) {
    try {
      await access(track.stemPath);
      source = track.stemPath;
      isStem = true;
    } catch {
      // The .stem.mp4 was deleted off disk — clear the stale link so the row stops
      // showing "stems" and future loads use the original.
      getLibrary().db.clearStems(track.id);
      source = track.location;
    }
  }
  const buf = await readFile(source);
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { name: track.filename, data: arrayBuffer, path: source, isStem };
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
