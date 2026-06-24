/**
 * Preload — the contextIsolated bridge. Exposes a minimal, typed surface to the
 * renderer for loading track bytes from disk. This is a .cts (CommonJS) file
 * because Electron preload runs in a CJS context; we use require() accordingly.
 */

import electron = require('electron');
import type { DjApi } from '../shared/ipc.js';

const api: DjApi = {
  openTrack: () => electron.ipcRenderer.invoke('dialog:openTrack'),
  readTrack: (path: string) => electron.ipcRenderer.invoke('track:read', path),
};

electron.contextBridge.exposeInMainWorld('dj', api);
