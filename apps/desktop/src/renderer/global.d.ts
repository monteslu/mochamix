/** Ambient types for the preload-exposed API on window. */
import type { DjApi } from '../shared/ipc.js';

declare global {
  interface Window {
    dj: DjApi;
  }
}

export {};
