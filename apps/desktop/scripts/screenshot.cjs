/**
 * Offscreen screenshot harness — renders the built app to a PNG with no display.
 * Run: node_modules/electron/dist/electron --no-sandbox --disable-gpu \
 *        --in-process-gpu --use-gl=swiftshader --ozone-platform=headless \
 *        apps/desktop/scripts/screenshot.cjs [out.png] [width] [height]
 *
 * Loads the app via the same app:// protocol main.ts uses (so COOP/COEP +
 * SharedArrayBuffer work), waits for React to render, captures the page.
 */

const { app, BrowserWindow, protocol, net } = require('electron');
const { pathToFileURL } = require('node:url');
const { join, normalize } = require('node:path');
const fs = require('node:fs');

// Electron passes all flags too; take only the non-flag args AFTER this script.
const scriptIdx = process.argv.findIndex((a) => a.endsWith('screenshot.cjs'));
const userArgs = process.argv.slice(scriptIdx + 1).filter((a) => !a.startsWith('-'));
const OUT = userArgs[0] || '/tmp/dj-app.png';
const W = parseInt(userArgs[1] || '1600', 10);
const H = parseInt(userArgs[2] || '1000', 10);

const RENDERER_DIR = join(__dirname, '../dist-renderer');
const SCHEME = 'app';
const HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

function handle(request) {
  const url = new URL(request.url);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  const filePath = normalize(join(RENDERER_DIR, pathname));
  if (!filePath.startsWith(normalize(RENDERER_DIR))) return new Response('forbidden', { status: 403 });
  return net
    .fetch(pathToFileURL(filePath).toString())
    .then((res) => {
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(HEADERS)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    })
    .catch(() => new Response('not found', { status: 404 }));
}

app.commandLine.appendSwitch('enable-unsafe-webgpu');

app.whenReady().then(async () => {
  protocol.handle(SCHEME, handle);
  const win = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    webPreferences: {
      offscreen: true,
      preload: join(__dirname, '../dist-main/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on('console-message', (_e, _l, m) => console.log('[r]', m));
  await win.loadURL(`${SCHEME}://app/index.html?demo`);
  // Give React + fonts time to settle.
  await new Promise((r) => setTimeout(r, 2500));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(OUT, img.toPNG());
  console.log('SHOT', OUT, JSON.stringify(img.getSize()));
  app.quit();
}).catch((e) => {
  console.log('SHOT_ERR', e && e.message);
  app.quit();
});
