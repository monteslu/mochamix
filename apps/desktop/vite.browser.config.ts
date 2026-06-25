/**
 * Browser build/dev config — runs the renderer as a standalone web app (no
 * Electron) for Playwright e2e + the future web-DJ target. Same workspace aliases
 * as the Electron build, plus the COOP/COEP headers SharedArrayBuffer needs.
 */

import { defineConfig, build as viteBuild, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

// Build the AudioWorklet bundle (the engine needs it; Vite can't bundle a .ts
// worklet on the fly). Run on dev-server start AND on worklet-source change, so
// `dev:web` is fully hands-off — no separate build:worklet step ever needed.
function buildWorklets(): Plugin {
  const cfg = fileURLToPath(new URL('./vite.worklet.config.ts', import.meta.url));
  const run = () => viteBuild({ configFile: cfg, logLevel: 'warn' }).catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[worklet build] failed:', e);
  });
  return {
    name: 'build-worklets',
    async buildStart() {
      await run();
    },
    configureServer(server) {
      // rebuild when any worklet/audio-engine/codec source changes
      const watched = /(\.worklet\.ts$|audio-engine\/src|codec\/src)/;
      server.watcher.on('change', (file) => {
        if (watched.test(file)) void run().then(() => server.ws.send({ type: 'full-reload' }));
      });
    },
  };
}

// Land on browser.html at "/" — index.html is the ELECTRON entry (no window.dj),
// so serving it in the browser crashes the Library. Redirect so any URL works.
function defaultToBrowserHtml(): Plugin {
  return {
    name: 'default-browser-html',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/' || req.url === '/index.html') {
          res.writeHead(302, { Location: '/browser.html?demo&gl' });
          res.end();
          return;
        }
        next();
      });
    },
  };
}

// Serve the pre-built AudioWorklets (dist-renderer/worklets, made by
// vite.worklet.config.ts) at /worklets/* so the full audio engine — and thus the
// real SYNC snap — works in the browser dev/e2e build too.
function serveWorklets(): Plugin {
  return {
    name: 'serve-worklets',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/worklets/')) return next();
        try {
          const file = fileURLToPath(new URL('.' + req.url, new URL('./dist-renderer/', import.meta.url)));
          const body = await readFile(file);
          res.setHeader('Content-Type', 'text/javascript');
          res.end(body);
        } catch {
          next();
        }
      });
    },
  };
}

// Serve real MP3s from ~/Music/mp3 at /mp3/<name> so the web build + e2e can test
// with actual tracks (decode, BPM/key analysis, scrolling waveforms), not just
// synthetic tones. Opt-in: only active when DJ_MUSIC_DIR is set (defaults to
// ~/Music/mp3 if present). Dev-only; never shipped.
function serveMusic(): Plugin {
  const dir = process.env.DJ_MUSIC_DIR || `${process.env.HOME}/Music/mp3`;
  return {
    name: 'serve-music',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/mp3/')) return next();
        try {
          const name = decodeURIComponent(req.url.slice('/mp3/'.length));
          if (name.includes('..')) return next();
          const body = await readFile(`${dir}/${name}`);
          res.setHeader('Content-Type', 'audio/mpeg');
          res.end(body);
        } catch {
          res.statusCode = 404;
          res.end('not found');
        }
      });
    },
  };
}

const pkg = (name: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

// cross-origin isolation (required for SharedArrayBuffer)
const coopCoep = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  define: {
    __BUILD_TIME__: JSON.stringify(
      new Date().toISOString().slice(11, 19) + ' ' + new Date().toISOString().slice(5, 10),
    ),
  },
  plugins: [defaultToBrowserHtml(), buildWorklets(), react(), serveWorklets(), serveMusic()],
  resolve: {
    alias: {
      '@internal-dj/analysis/worker': fileURLToPath(
        new URL('../../packages/analysis/src/analysis.worker.ts', import.meta.url),
      ),
      '@internal-dj/control-bus': pkg('control-bus'),
      '@internal-dj/audio-engine': pkg('audio-engine'),
      '@internal-dj/codec': pkg('codec'),
      '@internal-dj/waveform': pkg('waveform'),
      '@internal-dj/analysis': pkg('analysis'),
      '@internal-dj/dsp-wasm': pkg('dsp-wasm'),
    },
  },
  server: {
    headers: coopCoep,
    port: 5174,
  },
  preview: {
    headers: coopCoep,
    port: 5174,
  },
  build: {
    outDir: fileURLToPath(new URL('./dist-browser', import.meta.url)),
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      input: { browser: fileURLToPath(new URL('./src/renderer/browser.html', import.meta.url)) },
    },
  },
  worker: { format: 'es' },
});
