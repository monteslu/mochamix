/**
 * Shared IPC type contracts between main and renderer (the only types both sides
 * import). Keeping them here avoids the renderer typecheck pulling in the CJS
 * preload file.
 */

export interface LoadedFile {
  name: string;
  data: ArrayBuffer;
}

export interface DjApi {
  /** Open a file dialog and return the chosen track's bytes (or null). */
  openTrack: () => Promise<LoadedFile | null>;
  /** Read a dropped file path's bytes. */
  readTrack: (path: string) => Promise<LoadedFile>;
}
