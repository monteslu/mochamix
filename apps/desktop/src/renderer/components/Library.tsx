/**
 * Library — the track browser. Queries the main-process library over IPC, shows
 * a sortable/searchable table, and loads a track to a deck on double-click (or
 * via the deck buttons). Scan adds a folder.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { LibTrack } from '../../shared/ipc.js';
import type { StemStatus } from '../stem-queue.js';
import { useDj, useControlValue, NUM_DECKS } from '../dj-context.js';
import { deck as deckGroup, DeckKeys, LIBRARY, LibraryKeys } from '@dj/control-bus';
import { camelotToKey, areKeysCompatible } from '@dj/analysis';
import { loadTrackToDeck } from '../track-loader.js';
import { LibraryControl } from '../library-control.js';
import { useColumns, type ColumnId } from '../library-columns.js';
import { getDeckTrack } from '../deck-state.js';
import { RowWaveform } from './RowWaveform.js';

// Resizable columns, in table order. `sort` is the SortCol they sort by (null = no sort).
const COLUMNS: { id: ColumnId; label: string; sort: SortCol | null }[] = [
  { id: 'artist', label: 'ARTIST', sort: 'artist' },
  { id: 'title', label: 'TITLE', sort: 'title' },
  { id: 'album', label: 'ALBUM', sort: 'album' },
  { id: 'genre', label: 'GENRE', sort: 'genre' },
  { id: 'bpm', label: 'BPM', sort: 'bpm' },
  { id: 'key', label: 'KEY', sort: null },
  { id: 'time', label: 'TIME', sort: 'duration' },
  { id: 'stems', label: 'STEMS', sort: 'stems' },
];

type SortCol = 'artist' | 'title' | 'album' | 'bpm' | 'duration' | 'genre' | 'stems';

// Demo rows for visual development (?demo) — no DB/IPC needed.
const DEMO_TRACKS: LibTrack[] = (
  [
    ['Com Truise', 'Flightwave', 'In Decay', 'Synthwave', 128, 372, '8A'],
    ['Bonobo', 'Kerala', 'Migration', 'Electronic', 122, 314, '5A'],
    ['Tycho', 'Awake', 'Awake', 'Ambient', 115, 320, '11B'],
    ['Jon Hopkins', 'Emerald Rush', 'Singularity', 'Techno', 126, 365, '4A'],
    ['Four Tet', 'Two Thousand and Seventeen', 'New Energy', 'Electronic', 110, 248, '7A'],
    ['Rival Consoles', 'Recovery', 'Persona', 'Electronic', 120, 386, '2A'],
    ['Floating Points', 'Last Bloom', 'Crush', 'Electronic', 130, 290, '9B'],
    ['Boards of Canada', 'Roygbiv', 'Music Has the Right…', 'IDM', 95, 154, '6A'],
    ['Aphex Twin', 'Xtal', 'Selected Ambient Works', 'IDM', 124, 293, '12A'],
    ['Daft Punk', 'Veridis Quo', 'Discovery', 'House', 112, 345, '1B'],
    ['Caribou', 'Odessa', 'Swim', 'Electronic', 118, 358, '10A'],
    ['Moderat', 'A New Error', 'Moderat', 'Electronic', 100, 437, '3A'],
  ] as const
).map((t, i) => ({
  id: i + 1,
  location: `/music/${t[1]}.flac`,
  filename: `${t[1]}.flac`,
  artist: t[0],
  title: t[1],
  album: t[2],
  genre: t[3],
  year: '2017',
  duration: t[5],
  bitrate: 1000,
  bpm: t[4],
  firstBeatFrame: 0,
  key: t[6],
  rating: 0,
  timesPlayed: 0,
  filetype: 'flac',
  stemPath: null,
  stemsGeneratedAt: 0,
}));

export function Library(): React.JSX.Element {
  const { engine, bus, analysis, analysisQueue, stemQueue, stemThumbnails, started, start } = useDj();
  const analysisStatus = useSyncExternalStore(
    (cb) => analysisQueue.subscribe(cb),
    () => analysisQueue.getStatus(),
  );
  const stemStatus = useSyncExternalStore(
    (cb) => stemQueue.subscribe(cb),
    () => stemQueue.getStatus(),
  );
  // Loaded decks' detected keys → highlight library tracks that mix in key with them.
  const deckKey0 = useControlValue(deckGroup(1), DeckKeys.fileKeyNum);
  const deckKey1 = useControlValue(deckGroup(2), DeckKeys.fileKeyNum);
  const loadedKeys = [deckKey0, deckKey1].filter((k) => k > 0);
  const keyCompatible = (camelot: string | null): boolean => {
    if (!camelot || loadedKeys.length === 0) return false;
    const k = camelotToKey(camelot);
    return k > 0 && loadedKeys.some((dk) => areKeysCompatible(k, dk));
  };

  const [tracks, setTracks] = useState<LibTrack[]>([]);
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState<SortCol>('artist');
  const [sortDesc, setSortDesc] = useState(false);
  const [scanning, setScanning] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const { widths, onResizeStart, reset: resetColumns, didJustResize } = useColumns();

  const [dbError, setDbError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (new URLSearchParams(location.search).has('demo')) {
      setTracks(DEMO_TRACKS);
      return;
    }
    if (!window.dj?.libraryQuery) {
      setDbError('Library bridge unavailable (wrong entry / IPC not ready).');
      return;
    }
    try {
      const rows = await window.dj.libraryQuery({
        search,
        sortColumn: sortCol,
        sortDesc,
        limit: 500,
      });
      setTracks(rows);
      setDbError(null);
    } catch (err) {
      // Most likely the native better-sqlite3 module needs an electron-rebuild.
      setDbError(
        'Library database unavailable. If you just installed, run: npx electron-rebuild',
      );
      console.error('library query failed:', err);
    }
  }, [search, sortCol, sortDesc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // When stem generation finishes, patch the affected rows IN PLACE rather than
  // re-querying the whole list. A full refresh re-sorts + replaces the array, which
  // makes the list jump (scroll + selection shift) every time a stem decode lands.
  // The "✓ stems" badge reads stemStatus.done directly, so the row updates live; we
  // only stamp stemsGeneratedAt so the badge survives a later natural refresh. Row
  // identity (keyed by id) and order stay stable, so nothing jumps.
  useEffect(() => {
    if (stemStatus.done.size === 0) return;
    setTracks((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        if (stemStatus.done.has(t.id) && !t.stemsGeneratedAt && !t.stemPath) {
          changed = true;
          return { ...t, stemsGeneratedAt: Date.now() };
        }
        return t;
      });
      return changed ? next : prev; // keep the same array if nothing changed (no re-render)
    });
  }, [stemStatus.done]);

  useEffect(() => {
    // Guard: if the IPC bridge is missing (e.g. served the wrong entry), don't
    // throw — a crash here takes down the whole tree and kills every button.
    if (!window.dj?.onScanProgress) return;
    return window.dj.onScanProgress((p) => {
      setScanning(p.current === 'done' ? null : `scanning… ${p.scanned} files, ${p.added} added`);
    });
  }, []);

  const onScan = useCallback(async () => {
    setScanning('choosing folder…');
    const summary = await window.dj.libraryScan();
    setScanning(null);
    if (summary) {
      await refresh();
      // newly-added songs are unanalyzed → background-analyze them
      void analysisQueue.enqueueUnanalyzed();
      // a scan may have found existing .stem.mp4 files → backfill their thumbnails
      void stemThumbnails.run();
    }
  }, [refresh, analysisQueue, stemThumbnails]);

  const onSync = useCallback(async () => {
    setScanning('syncing…');
    await window.dj.librarySync(); // adds new, sweeps deleted (progress shown via setScanning)
    setScanning(null);
    await refresh();
    void analysisQueue.enqueueUnanalyzed();
    void stemThumbnails.run();
  }, [refresh, analysisQueue, stemThumbnails]);

  const onReanalyze = useCallback(async () => {
    const ok = window.confirm(
      'Re-analyze the ENTIRE collection? This rebuilds BPM, key, beats, downbeats and ' +
        'waveforms for every track (with the current analyzer) in the background.',
    );
    if (!ok) return;
    // Analysis decodes audio → it NEEDS the AudioContext started, else every track
    // fails instantly ("ran in seconds, nothing happened"). Start it first.
    if (!started) {
      try {
        await start();
      } catch {
        window.alert('Could not start audio — press ▶ start audio, then try again.');
        return;
      }
    }
    const n = await analysisQueue.reanalyzeAll();
    setScanning(null);
    if (n > 0) await refresh();
  }, [analysisQueue, refresh, started, start]);

  // Edit a track's BPM (Mixxx Adjust BPM): persist to the library row, lock it so
  // re-analysis won't undo it, and patch the row IN PLACE (no full refresh → no jump).
  // If the track is loaded on a deck, push the new BPM live too.
  const updateRowBpm = useCallback(
    async (id: number, bpm: number) => {
      if (!(bpm > 0) || !Number.isFinite(bpm)) return;
      const clamped = Math.max(1, Math.min(500, bpm));
      await window.dj?.librarySetAnalysis?.(id, { bpm: clamped, bpmLocked: 1 });
      setTracks((prev) => prev.map((t) => (t.id === id ? { ...t, bpm: clamped } : t)));
      // live update any deck currently playing this library track
      for (let d = 0; d < NUM_DECKS; d++) {
        if (getDeckTrack(d).libraryId === id) bus.set(deckGroup(d + 1), DeckKeys.fileBpm, clamped);
      }
    },
    [bus],
  );

  // Double-click target: first STOPPED deck (Mixxx behavior), else deck 1. Avoids
  // clobbering a deck that's currently playing out.
  const firstStoppedDeck = useCallback((): number => {
    for (let d = 0; d < NUM_DECKS; d++) {
      if (bus.get(deckGroup(d + 1), DeckKeys.play) < 0.5) return d;
    }
    return 0;
  }, [bus]);

  const loadToDeck = useCallback(
    async (track: LibTrack, deckIndex: number) => {
      if (!started) {
        await start();
      }
      // Show the spinner immediately (covers the IPC byte-read too), and time the read —
      // for a big lossless file this can be a large slice of the multi-second load.
      bus.set(deckGroup(deckIndex + 1), DeckKeys.loading, 1);
      const tRead = performance.now();
      const file = await window.dj.readTrackById(track.id);
      console.log(
        `[load] deck ${deckIndex + 1} read bytes in ${(performance.now() - tRead).toFixed(0)}ms`,
      );
      if (!file) {
        bus.set(deckGroup(deckIndex + 1), DeckKeys.loading, 0);
        return;
      }
      await loadTrackToDeck({ engine, bus, analysis }, deckIndex, {
        file,
        meta: {
          title: track.title,
          artist: track.artist,
          album: track.album,
          key: track.key,
          bpm: track.bpm,
          firstBeatFrame: track.firstBeatFrame, // stored grid phase → correct beat align
        },
        coverPath: track.location,
        libraryId: track.id,
      });
    },
    [engine, bus, analysis, started, start],
  );

  // --- Controller library navigation + loading ([Library]/[Playlist] controls) ---
  // A controller navigates + loads tracks via bus controls. LibraryControl owns the
  // selection index and reacts to them; we mirror it into the UI highlight (`selected`)
  // and feed it the CURRENT displayed list + load fn via refs (so the singleton control
  // always sees fresh data without re-subscribing).
  const tracksRef = useRef<LibTrack[]>(tracks);
  tracksRef.current = tracks;
  const loadToDeckRef = useRef(loadToDeck);
  loadToDeckRef.current = loadToDeck;
  const firstStoppedRef = useRef(firstStoppedDeck);
  firstStoppedRef.current = firstStoppedDeck;

  useEffect(() => {
    const ctl = new LibraryControl({
      bus,
      numDecks: NUM_DECKS,
      trackCount: () => tracksRef.current.length,
      firstStoppedDeck: () => firstStoppedRef.current(),
      loadIndexToDeck: (i, deckIndex, play) => {
        const t = tracksRef.current[i];
        if (!t) return;
        setSelected(t.id);
        void loadToDeckRef.current(t, deckIndex).then(() => {
          if (play) bus.set(deckGroup(deckIndex + 1), DeckKeys.play, 1);
        });
      },
    });
    return () => ctl.dispose();
  }, [bus]);

  // Mirror the bus selection index → the highlighted row id, so a controller's
  // SelectTrackKnob/MoveVertical moves the visible highlight (and scrolls it into view).
  const selIndex = useControlValue(LIBRARY, LibraryKeys.selectedIndex);
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>());
  // Only scrollIntoView when the SELECTION actually moves (controller knob), never when
  // `tracks` changes for another reason. The in-place stem-done patch makes a NEW tracks
  // array, which used to re-fire this effect and jump the list when stems finished.
  const lastScrolledIndex = useRef<number | null>(null);
  useEffect(() => {
    const t = tracks[Math.max(0, Math.min(tracks.length - 1, Math.round(selIndex)))];
    if (!t) return;
    setSelected(t.id);
    if (lastScrolledIndex.current !== selIndex) {
      lastScrolledIndex.current = selIndex;
      rowRefs.current.get(t.id)?.scrollIntoView({ block: 'nearest' });
    }
  }, [selIndex, tracks]);

  // Generate stems (WebGPU Demucs) for a track. Needs the AudioContext running for
  // decode; enqueue is one-at-a-time (GPU-heavy). The row shows live progress.
  const generateStems = useCallback(
    async (track: LibTrack) => {
      if (!started) {
        await start();
      }
      stemQueue.enqueue(track.id);
    },
    [stemQueue, started, start],
  );

  const toggleSort = (col: SortCol) => {
    if (col === sortCol) {
      setSortDesc((d) => !d);
    } else {
      setSortCol(col);
      // stems: default to DESC so tracks WITH stems come first (then name); others ASC.
      setSortDesc(col === 'stems');
    }
  };

  return (
    <section className="library" aria-label="Library">
      <div className="library-toolbar">
        <input
          type="search"
          placeholder="search  (try  a:daft  bpm:120-130 )"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="library-search"
        />
        <button onClick={onScan} disabled={!!scanning}>
          {scanning ? scanning : '+ add folder'}
        </button>
        <button
          onClick={onSync}
          disabled={!!scanning}
          title="Rescan all watched folders: add new songs, remove deleted ones"
        >
          ↻ sync
        </button>
        <button
          onClick={onReanalyze}
          disabled={!!scanning || analysisStatus.remaining > 0}
          title="Rebuild BPM/key/beats/downbeats/waveforms for the whole collection"
        >
          ↻ re-analyze all
        </button>
        <span className="library-count">{tracks.length} tracks</span>
        {analysisStatus.remaining > 0 && (
          <span className="library-analyzing" title="Analyzing tracks in the background">
            <span className="spin" /> analyzing {analysisStatus.remaining} left
          </span>
        )}
        {stemStatus.remaining > 0 && (
          <span className="library-stemming" title="Generating stems in the background">
            <span className="spin" /> stems processing {stemStatus.remaining} left
          </span>
        )}
        {dbError && <span className="library-error">{dbError}</span>}
      </div>

      <div className="library-table-wrap">
        <table className="library-table">
          <colgroup>
            <col className="col-wave" />
            {COLUMNS.map((c) => (
              <col key={c.id} style={{ width: `${widths[c.id]}px` }} />
            ))}
            <col className="col-load" />
          </colgroup>
          <thead>
            <tr>
              <th className="th-wave">WAVE</th>
              {COLUMNS.map((c) => (
                <th
                  key={c.id}
                  onClick={c.sort ? () => { if (!didJustResize()) toggleSort(c.sort!); } : undefined}
                  className={c.sort && sortCol === c.sort ? 'sorted' : ''}
                  title={c.id === 'stems' ? 'Sort tracks with stems first, then by name' : undefined}
                >
                  {c.label}
                  {c.sort && sortCol === c.sort ? (sortDesc ? ' ▼' : ' ▲') : ''}
                  {/* drag the right edge to resize; double-click to reset all widths */}
                  <span
                    className="col-resize"
                    onPointerDown={(e) => onResizeStart(c.id, e)}
                    onClick={(e) => e.stopPropagation()} // don't trigger sort
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      resetColumns();
                    }}
                    title="Drag to resize · double-click to reset"
                  />
                </th>
              ))}
              <th>LOAD</th>
            </tr>
          </thead>
          <tbody>
            {tracks.map((t, i) => (
              <tr
                key={t.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(t.id, el);
                  else rowRefs.current.delete(t.id);
                }}
                className={selected === t.id ? 'selected' : ''}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-dj-track-id', String(t.id));
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() => {
                  setSelected(t.id);
                  // Keep the controller's selection index in sync with mouse clicks.
                  bus.set(LIBRARY, LibraryKeys.selectedIndex, i);
                }}
                onDoubleClick={() => void loadToDeck(t, firstStoppedDeck())}
                title="Double-click → first stopped deck · drag onto a deck · or use the deck buttons →"
              >
                <td className="td-wave">
                  <RowWaveform
                    trackId={t.id}
                    analyzing={analysisStatus.current.has(t.id)}
                    done={analysisStatus.done.has(t.id)}
                    hasStems={!!t.stemPath}
                  />
                </td>
                <td>{t.artist}</td>
                <td>{t.title}</td>
                <td>{t.album}</td>
                <td>{t.genre}</td>
                <BpmCell bpm={t.bpm} onSet={(v) => void updateRowBpm(t.id, v)} />

                <td className={`lib-key${keyCompatible(t.key) ? ' key-compatible' : ''}`}>
                  {t.key ?? ''}
                </td>
                <td className="num">{fmtDur(t.duration)}</td>
                <td className="stem-cell">
                  <StemCell track={t} status={stemStatus} onGenerate={generateStems} />
                </td>
                <td className="load-cells">
                  {Array.from({ length: NUM_DECKS }, (_, d) => (
                    <button
                      key={d}
                      className="tiny"
                      onClick={(e) => {
                        e.stopPropagation();
                        void loadToDeck(t, d);
                      }}
                      title={`Load to deck ${d + 1}`}
                    >
                      {d + 1}
                    </button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function fmtDur(s: number | null): string {
  if (!s) return '';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

/**
 * Editable BPM cell (Mixxx Adjust BPM). Double-click to type an exact value; hover shows
 * ½ / ×2 buttons to fix octave errors. Every edit persists + locks the BPM via onSet.
 */
function BpmCell({ bpm, onSet }: { bpm: number; onSet: (v: number) => void }): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  if (editing) {
    const commit = () => {
      const v = parseFloat(text);
      if (v > 0) onSet(v);
      setEditing(false);
    };
    return (
      <td className="num bpm-cell">
        <input
          className="bpm-input"
          autoFocus
          defaultValue={bpm > 0 ? bpm.toFixed(1) : ''}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') setEditing(false);
          }}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      </td>
    );
  }
  return (
    <td
      className="num bpm-cell"
      onDoubleClick={(e) => {
        e.stopPropagation();
        setText('');
        setEditing(true);
      }}
      title="Double-click to edit BPM"
    >
      <span className="bpm-val">{bpm > 0 ? bpm.toFixed(0) : ''}</span>
      <span className="bpm-oct">
        <button
          className="micro"
          title="Halve BPM"
          onClick={(e) => {
            e.stopPropagation();
            if (bpm > 0) onSet(bpm / 2);
          }}
        >
          /2
        </button>
        <button
          className="micro"
          title="Double BPM"
          onClick={(e) => {
            e.stopPropagation();
            if (bpm > 0) onSet(bpm * 2);
          }}
        >
          x2
        </button>
      </span>
    </td>
  );
}

/**
 * Per-row stems control: a "Generate" button → live progress bar while generating
 * (where the button was) → a "✓ stems" badge when done. The headline feature:
 * generate 4 separable stems on the GPU for live mashups.
 */
function StemCell({
  track,
  status,
  onGenerate,
}: {
  track: LibTrack;
  status: StemStatus;
  onGenerate: (t: LibTrack) => void;
}): React.JSX.Element {
  const hasStems = !!track.stemPath || track.stemsGeneratedAt > 0 || status.done.has(track.id);
  const generating = status.current === track.id;
  // queued = THIS track is waiting in the queue (not just "something is queued").
  const queued = status.queued.has(track.id);

  if (generating) {
    const pct = Math.round(status.progress * 100);
    return (
      <div className="stem-progress" title={`${status.phase ?? ''} ${pct}%`}>
        <div className="stem-progress-bar" style={{ width: `${pct}%` }} />
        <span className="stem-progress-label">{pct}%</span>
      </div>
    );
  }
  if (hasStems) {
    return (
      <span className="stem-done" title="Stems generated (4 separable stems)">
        ✓ stems
      </span>
    );
  }
  if (status.failed.has(track.id)) {
    return (
      <button
        className="tiny stem-btn stem-retry"
        onClick={(e) => {
          e.stopPropagation();
          onGenerate(track);
        }}
        title="Stem generation failed — click to retry"
      >
        ↻ retry
      </button>
    );
  }
  return (
    <button
      className="tiny stem-btn"
      disabled={queued}
      onClick={(e) => {
        e.stopPropagation();
        onGenerate(track);
      }}
      title="Generate 4 stems (drums/bass/other/vocals) on the GPU"
    >
      {queued ? 'queued' : 'gen stems'}
    </button>
  );
}
