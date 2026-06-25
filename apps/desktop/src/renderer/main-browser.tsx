/**
 * Browser entry point — runs the full renderer in a plain browser (no Electron),
 * for Playwright e2e + as the base for a future web-DJ build. Installs the
 * in-memory DjApi on window.dj BEFORE the App's modules run, then mounts the App
 * exactly as the Electron entry does. The ?demo seeding still applies.
 */

import { createRoot } from 'react-dom/client';
import { makeBrowserDj } from './browser-dj.js';

// Install the IPC stub first so anything reading window.dj at import time is safe.
window.dj = makeBrowserDj();

// Dynamic import so window.dj is set before App's module graph evaluates.
const { App } = await import('./App.js');
await import('./styles.css');

const root = document.getElementById('root');
if (!root) throw new Error('no #root element');

if (!('gpu' in navigator)) {
  console.warn('[dj-app web] WebGPU unavailable in this browser');
}

// NOTE: no StrictMode here — its double-mount disposes+recreates the WebGL lane
// controllers, and the GL context's deleted program/texture state doesn't survive
// that cleanly (the canvas keeps one context). Electron's entry has the same risk.
createRoot(root).render(<App />);
