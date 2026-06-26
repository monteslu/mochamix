/**
 * LibrarySettings — the "Library" preferences tab (Mixxx's Library page): the list of
 * watched Music Directories (add/remove), a rescan-on-startup toggle, and a manual
 * "Sync now". Sync re-walks all known folders, adds new tracks, and sweeps deleted
 * ones (Mixxx LibraryScanner model). No live filesystem watcher — rescan-based.
 */

import { useCallback, useEffect, useState } from 'react';
import { useDj } from '../dj-context.js';

const RESCAN_KEY = 'rescanOnStartup';

export function LibrarySettings(): React.JSX.Element {
  const { analysisQueue, stemThumbnails } = useDj();
  const [dirs, setDirs] = useState<string[]>([]);
  const [rescanOnStartup, setRescanOnStartup] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const refreshDirs = useCallback(async () => {
    setDirs(await window.dj.libraryDirectories());
  }, []);

  useEffect(() => {
    void refreshDirs();
    // Default ON (null/unset = on); only an explicit '0' is off.
    void window.dj.settingsGet(RESCAN_KEY).then((v) => setRescanOnStartup(v !== '0'));
  }, [refreshDirs]);

  // Live scan progress while a sync/add runs.
  useEffect(() => {
    return window.dj.onScanProgress((p) => {
      setStatus(
        p.current === 'done'
          ? `done — ${p.scanned} scanned, ${p.added} added`
          : `scanning… ${p.scanned} files, ${p.added} added`,
      );
    });
  }, []);

  const onAdd = useCallback(async () => {
    setStatus('choosing folder…');
    const r = await window.dj.libraryAddDirectory();
    await refreshDirs();
    if (r) {
      setStatus(`added ${r.added} new tracks`);
      void analysisQueue.enqueueUnanalyzed();
      void stemThumbnails.run();
    } else {
      setStatus(null);
    }
  }, [refreshDirs, analysisQueue, stemThumbnails]);

  const onRemove = useCallback(
    async (dir: string) => {
      if (!window.confirm(`Stop watching "${dir}"?\nIts tracks are removed on the next sync.`)) return;
      await window.dj.libraryRemoveDirectory(dir);
      await refreshDirs();
    },
    [refreshDirs],
  );

  const onSync = useCallback(async () => {
    setStatus('syncing…');
    const r = await window.dj.librarySync();
    setStatus(`sync done — ${r.added} added, ${r.removed ?? 0} removed (${r.scanned} scanned)`);
    void analysisQueue.enqueueUnanalyzed();
    void stemThumbnails.run();
  }, [analysisQueue, stemThumbnails]);

  const toggleRescan = useCallback((on: boolean) => {
    setRescanOnStartup(on);
    void window.dj.settingsSet(RESCAN_KEY, on ? '1' : '0');
  }, []);

  return (
    <div className="prefs-panel">
      <h3>Music Directories</h3>
      <p className="prefs-note" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>
        Folders the app watches for tracks. Sync rescans them, adds new songs, and removes
        ones deleted from disk.
      </p>

      <ul className="prefs-dirs">
        {dirs.length === 0 && <li className="prefs-dir-empty">No folders yet — add one below.</li>}
        {dirs.map((d) => (
          <li key={d} className="prefs-dir">
            <span className="prefs-dir-path" title={d}>
              {d}
            </span>
            <button className="tiny" onClick={() => void onRemove(d)}>
              remove
            </button>
          </li>
        ))}
      </ul>

      <div className="prefs-dir-actions">
        <button onClick={() => void onAdd()}>+ add folder</button>
        <button onClick={() => void onSync()} disabled={dirs.length === 0}>
          ↻ sync now
        </button>
        {status && <span className="bus-hint">{status}</span>}
      </div>

      <label className="prefs-row" style={{ marginTop: 18 }}>
        <input
          type="checkbox"
          checked={rescanOnStartup}
          onChange={(e) => toggleRescan(e.target.checked)}
        />
        <span>
          Rescan directories on start-up
          <small>Sync the library automatically each time the app launches (like Mixxx).</small>
        </span>
      </label>
    </div>
  );
}
