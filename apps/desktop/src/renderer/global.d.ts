/** Ambient types for the preload-exposed API on window. */
import type { DjApi } from '../shared/ipc.js';

declare global {
  interface Window {
    dj: DjApi;
  }
  /** Build timestamp injected by Vite `define` (shown in the titlebar). */
  const __BUILD_TIME__: string;
}

export {};
