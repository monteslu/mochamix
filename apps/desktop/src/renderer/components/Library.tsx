/**
 * Library — the track browser. Queries the main-process library over IPC, shows
 * a sortable/searchable table, and loads a track to a deck on double-click (or
 * via the deck buttons). Scan adds a folder.
 */

import { useCallback, useEffect, useState } from 'react';
import type { LibTrack } from '../../shared/ipc.js';
import { useDj, NUM_DECKS } from '../dj-context.js';
import { decodeArrayBuffer } from '@internal-dj/codec';
import { computePeakSet, detailBucketsForDuration } from '@internal-dj/waveform';
import { deck as deckGroup, DeckKeys } from '@internal-dj/control-bus';
import { setDeckTrack } from '../deck-state.js';

type SortCol = 'artist' | 'title' | 'album' | 'bpm' | 'duration' | 'genre';

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
}));

export function Library(): React.JSX.Element {
  const { engine, bus, analysis, started, start } = useDj();
  const [tracks, setTracks] = useState<LibTrack[]>([]);
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState<SortCol>('artist');
  const [sortDesc, setSortDesc] = useState(false);
  const [scanning, setScanning] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const [dbError, setDbError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (new URLSearchParams(location.search).has('demo')) {
      setTracks(DEMO_TRACKS);
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

  useEffect(() => {
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
    }
  }, [refresh]);

  const loadToDeck = useCallback(
    async (track: LibTrack, deckIndex: number) => {
      if (!started) {
        await start();
      }
      const file = await window.dj.readTrackById(track.id);
      if (!file) {
        return;
      }
      const ctx = engine.audioContext!;
      const decoded = await decodeArrayBuffer(ctx, file.data, file.name);
      // peaks
      const all = new Float32Array(decoded.sampleBuffer);
      const channelData: Float32Array[] = [];
      for (let c = 0; c < decoded.channels; c++) {
        channelData.push(all.subarray(c * decoded.frames, (c + 1) * decoded.frames));
      }
      const dur = decoded.frames / decoded.sampleRate;
      const peaks = computePeakSet(channelData, decoded.frames, detailBucketsForDuration(dur));

      window.dispatchEvent(
        new CustomEvent('deck-track-loaded', {
          detail: {
            deckIndex,
            peaks,
            track: {
              title: track.title,
              artist: track.artist,
              album: track.album,
              key: track.key,
              filename: track.filename,
            },
          },
        }),
      );

      engine.loadTrack(deckIndex, decoded);
      const g = deckGroup(deckIndex + 1);
      if (track.bpm > 0) {
        bus.set(g, DeckKeys.fileBpm, track.bpm);
      }
      void window.dj.libraryIncrementPlay(track.id);

      // cover art
      void window.dj.trackCover(track.location).then((cover) => {
        if (cover) {
          const url = URL.createObjectURL(new Blob([cover.data], { type: cover.mime }));
          setDeckTrack(deckIndex, { coverUrl: url });
        }
      });

      // analyze if BPM/key missing
      if (track.bpm <= 0 || !track.key) {
        void analysis.analyze(decoded).then((r) => {
          if (r.bpm > 0) {
            bus.set(g, DeckKeys.fileBpm, r.bpm);
            bus.set(g, DeckKeys.firstBeatFrame, r.firstBeatFrame);
          }
          if (r.camelot) setDeckTrack(deckIndex, { key: r.camelot });
          void window.dj.librarySetAnalysis(track.id, { bpm: r.bpm, firstBeatFrame: r.firstBeatFrame });
        });
      }
    },
    [engine, bus, analysis, started, start],
  );

  const toggleSort = (col: SortCol) => {
    if (col === sortCol) {
      setSortDesc((d) => !d);
    } else {
      setSortCol(col);
      setSortDesc(false);
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
        <span className="library-count">{tracks.length} tracks</span>
        {dbError && <span className="library-error">{dbError}</span>}
      </div>

      <div className="library-table-wrap">
        <table className="library-table">
          <thead>
            <tr>
              {(['artist', 'title', 'album', 'genre', 'bpm'] as SortCol[]).map((c) => (
                <th key={c} onClick={() => toggleSort(c)} className={sortCol === c ? 'sorted' : ''}>
                  {c.toUpperCase()}
                  {sortCol === c ? (sortDesc ? ' ▼' : ' ▲') : ''}
                </th>
              ))}
              <th>KEY</th>
              <th
                onClick={() => toggleSort('duration')}
                className={sortCol === 'duration' ? 'sorted' : ''}
              >
                TIME{sortCol === 'duration' ? (sortDesc ? ' ▼' : ' ▲') : ''}
              </th>
              <th>LOAD</th>
            </tr>
          </thead>
          <tbody>
            {tracks.map((t) => (
              <tr
                key={t.id}
                className={selected === t.id ? 'selected' : ''}
                onClick={() => setSelected(t.id)}
                onDoubleClick={() => void loadToDeck(t, 0)}
              >
                <td>{t.artist}</td>
                <td>{t.title}</td>
                <td>{t.album}</td>
                <td>{t.genre}</td>
                <td className="num">{t.bpm > 0 ? t.bpm.toFixed(0) : ''}</td>
                <td className="lib-key">{t.key ?? ''}</td>
                <td className="num">{fmtDur(t.duration)}</td>
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
