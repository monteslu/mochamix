/** Preload for the pipeline-verify page (verify-pipeline.cjs). */
import electron = require('electron');

electron.contextBridge.exposeInMainWorld('verify', {
  getWav: () => electron.ipcRenderer.invoke('verify:wav'),
  report: (r: unknown) => electron.ipcRenderer.invoke('verify:result', r),
});
