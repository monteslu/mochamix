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

  libraryQuery: (q) => electron.ipcRenderer.invoke('library:query', q),
  libraryCount: (search) => electron.ipcRenderer.invoke('library:count', search),
  libraryScan: () => electron.ipcRenderer.invoke('library:scan'),
  onScanProgress: (cb) => {
    const listener = (_e: unknown, p: unknown) => cb(p as never);
    electron.ipcRenderer.on('library:scanProgress', listener);
    return () => electron.ipcRenderer.removeListener('library:scanProgress', listener);
  },
  readTrackById: (id) => electron.ipcRenderer.invoke('library:readTrackById', id),
  librarySetAnalysis: (id, a) => electron.ipcRenderer.invoke('library:setAnalysis', id, a),
  libraryWaveform: (id) => electron.ipcRenderer.invoke('library:waveform', id),
  libraryDownbeats: (id) => electron.ipcRenderer.invoke('library:downbeats', id),
  libraryStemWaveforms: (id) => electron.ipcRenderer.invoke('library:stemWaveforms', id),
  librarySetStemWaveforms: (id, blob) => electron.ipcRenderer.invoke('library:setStemWaveforms', id, blob),
  libraryStemsNeedingWaveforms: (limit) =>
    electron.ipcRenderer.invoke('library:stemsNeedingWaveforms', limit),
  libraryUnanalyzed: (limit) => electron.ipcRenderer.invoke('library:unanalyzed', limit),
  libraryReanalyzeAll: () => electron.ipcRenderer.invoke('library:reanalyzeAll'),
  libraryStemless: (limit) => electron.ipcRenderer.invoke('library:stemless', limit),
  libraryIncrementPlay: (id) => electron.ipcRenderer.invoke('library:incrementPlay', id),
  saveStems: (id, data) => electron.ipcRenderer.invoke('stems:save', id, data),
  saveRecording: (wav) => electron.ipcRenderer.invoke('recording:save', wav),
  trackCover: (path) => electron.ipcRenderer.invoke('track:cover', path),
};

electron.contextBridge.exposeInMainWorld('dj', api);
