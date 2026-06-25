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
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { LibraryService } from './library-service.js';
import type { QueryOptions } from '@internal-dj/db';

const __dirname = dirname(fileURLToPath(import.meta.url));
// main.js (esbuild-bundled) lives at dist-main/main.js → renderer is one up.
const RENDERER_DIR = join(__dirname, '../dist-renderer');
const isDev = process.argv.includes('--dev');

// Set a clean app name BEFORE any getPath('userData') call. The package name is
// "@internal-dj/desktop", whose "/" produces a nested userData path
// (.config/@internal-dj/desktop) — fragile for file creation. Use a flat name.
app.setName('dj-app');

// On Linux/Wayland some drivers crash-loop in Chromium's native-GPU-buffer
// (GBM/pixmap) 2D raster path — "eglCreateImage failed", "OzoneImageBacking ...
// GPU process exited unexpectedly" — which pegs the frame rate to ~30fps with
// huge spikes (measured: our own waveform draw is <1ms; the rest is the GPU
// process restarting). This is a COMPOSITOR-RASTER issue, NOT our WebGL/WebGPU
// rendering — disabling the native GPU memory-buffer path stops the crash while
// keeping GPU acceleration + WebGPU. Opt out with DJ_NATIVE_GPU=1.
if (process.platform === 'linux' && process.env.DJ_NATIVE_GPU !== '1') {
  app.commandLine.appendSwitch('disable-features', 'UseGpuMemoryBufferVideoFrames');
  app.commandLine.appendSwitch('disable-gpu-memory-buffer-compositor-resources');
  app.commandLine.appendSwitch('disable-gpu-memory-buffer-video-frames');
}

// NOTE: the Wayland-vs-X11 display backend is selected via the
// ELECTRON_OZONE_PLATFORM_HINT=auto env var set by scripts/run-electron.mjs —
// it must be set BEFORE Electron's early init (app.commandLine switches are read
// too late and the X11 path crashes first).


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
    title: 'internal-dj',
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

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools();
  } else {
    void win.loadURL(`${SCHEME}://app/index.html`);
    if (isDev) {
      win.webContents.openDevTools();
    }
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
ipcMain.handle('library:unanalyzed', (_e, limit?: number) => getLibrary().unanalyzedTrackIds(limit));
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
  const buf = await readFile(track.location);
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { name: track.filename, data: arrayBuffer, path: track.location };
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
  return summary;
});

app.whenReady().then(() => {
  // We require WebGPU (no fallback — 10 §0a). Enable unsafe in case a platform gates it.
  app.commandLine.appendSwitch('enable-unsafe-webgpu');

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
