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
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// main.js lives at dist-main/main/main.js → renderer is two levels up.
const RENDERER_DIR = join(__dirname, '../../dist-renderer');
const isDev = process.argv.includes('--dev');

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
    // eslint-disable-next-line no-console
    console.log(`[renderer] ${message}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    // eslint-disable-next-line no-console
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
  return { name: path.split(/[\\/]/).pop() ?? 'track', data: arrayBuffer };
});

// IPC: read a dropped file path's bytes.
ipcMain.handle('track:read', async (_e, path: string) => {
  const buf = await readFile(path);
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { name: path.split(/[\\/]/).pop() ?? 'track', data: arrayBuffer };
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
