/**
 * Headless pipeline verification — runs the REAL load→decode→peaks→analyze path
 * in an offscreen Electron renderer (no audio device needed: OfflineAudioContext
 * decodes without a gesture). Proves the engine works on real audio bytes, not
 * demo data. Loads a tiny verify page that exercises the actual packages.
 *
 * Run: electron ... apps/desktop/scripts/verify-pipeline.cjs <wavPath>
 */

const { app, BrowserWindow, protocol, net, ipcMain } = require('electron');
const { pathToFileURL } = require('node:url');
const { join, normalize } = require('node:path');
const fs = require('node:fs');

const WAV = process.argv.find((a) => a.endsWith('.wav')) || '/tmp/test-track.wav';
const RENDERER_DIR = join(__dirname, '../dist-renderer');
const SCHEME = 'app';
const HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

function handle(request) {
  const url = new URL(request.url);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === '') pathname = '/verify.html';
  const filePath = normalize(join(RENDERER_DIR, pathname));
  if (!filePath.startsWith(normalize(RENDERER_DIR))) return new Response('forbidden', { status: 403 });
  return net.fetch(pathToFileURL(filePath).toString())
    .then((res) => {
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(HEADERS)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    })
    .catch(() => new Response('not found', { status: 404 }));
}

ipcMain.handle('verify:wav', () => {
  const buf = fs.readFileSync(WAV);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

let done = false;
ipcMain.handle('verify:result', (_e, r) => {
  console.log('PIPELINE_RESULT', JSON.stringify(r));
  done = true;
  app.quit();
});

// Main-process DB smoke test: prove the pure-WASM SQLite (node-sqlite3-wasm via
// the bundled @dj/db) opens + queries inside the real Electron main
// process, with no native addon / electron-rebuild.
function dbSmokeTest() {
  try {
    // the bundled main.js inlines @dj/db; require node-sqlite3-wasm the
    // same way main does (external module resolved from node_modules).
    const { Database } = require('node-sqlite3-wasm');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)');
    db.prepare('INSERT INTO t(name) VALUES (@n)').run({ '@n': 'kerala' });
    const row = db.prepare('SELECT name FROM t WHERE id=?').get([1]);
    db.close();
    console.log('DB_RESULT', JSON.stringify({ ok: row && row.name === 'kerala', row }));
  } catch (e) {
    console.log('DB_RESULT', JSON.stringify({ ok: false, error: String(e) }));
  }
}

app.whenReady().then(async () => {
  dbSmokeTest();
  protocol.handle(SCHEME, handle);
  const win = new BrowserWindow({
    width: 200, height: 200, show: false,
    webPreferences: {
      offscreen: true,
      preload: join(__dirname, '../dist-main/preload-verify.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on('console-message', (_e, _l, m) => console.log('[r]', m));
  await win.loadURL(`${SCHEME}://app/verify.html`);
  setTimeout(() => { if (!done) { console.log('PIPELINE_TIMEOUT'); app.quit(); } }, 30000);
});
