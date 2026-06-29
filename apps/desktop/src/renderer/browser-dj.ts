/**
 * Browser implementation of the DjApi (the surface normally provided by the
 * Electron preload over IPC). Lets the whole renderer run in a plain browser —
 * for Playwright e2e tests AND as the foundation for a future web-DJ build (the
 * renderer is already web-standard; only this file layer was Electron-only).
 *
 * It's a small in-memory library with synthetic tracks + a synthetic audio file
 * generator, so the UI has real data to render without any Node/filesystem.
 */

import type { DjApi, LibTrack, LibQuery, LoadedFile, ScanSummary, ScanProgress } from '../shared/ipc.js';

// A handful of fake library rows so the list + previews have something to show.
function track(
  id: number, artist: string, title: string, album: string, genre: string, bpm: number, key: string, durationSec: number,
): LibTrack {
  return {
    id, location: `mem://${id}`, filename: `${artist} - ${title}.wav`,
    artist, title, album, genre, year: '2024', duration: durationSec, bitrate: 320,
    bpm, firstBeatFrame: 0, key, rating: 0, timesPlayed: 0, filetype: 'wav',
    dateAdded: '2026-01-01 12:00:00',
    stemPath: null, stemsGeneratedAt: 0,
  };
}
// The first two map to real MP3s served at /mp3/<file> (vite.browser serveMusic),
// so the web build + e2e exercise actual decode/analysis/scrolling waveforms. The
// rest are synthetic. mp3File!=null marks the real ones. Used as the FALLBACK library
// when the demo manifest isn't present (e.g. Playwright e2e against the dev server).
const DEMO_TRACKS: Array<LibTrack & { mp3File?: string }> = [
  { ...track(1, 'The Who', "I Can't Explain", '', 'Rock', 0, '', 125), mp3File: "The Who - I Can't Explain.mp3" },
  { ...track(2, 'Bill Withers', "Ain't No Sunshine", '', 'Soul', 0, '', 125), mp3File: 'Bill Withers - Ain\'t No Sunshine.mp3' },
  track(3, 'Tycho', 'Awake', 'Awake', 'Ambient', 115, '11B', 320),
  track(4, 'Jon Hopkins', 'Emerald Rush', 'Singularity', 'Techno', 126, '4A', 365),
];

/** A bundled demo track (pre-processed .stem.mp4). `stemFile` points under /demo-songs/. */
interface DemoManifestTrack {
  id: number;
  artist: string;
  title: string;
  album: string;
  genre: string;
  bpm: number;
  key: string;
  duration: number;
  firstBeatFrame: number;
  stemFile: string;
}

/** Load the bundled demo library (public/demo-songs/manifest.json). Returns the LibTrack
 * rows + a map id→stem URL. Empty if the manifest isn't deployed (then we fall back to the
 * synth DEMO_TRACKS). */
export async function loadDemoLibrary(): Promise<{
  rows: LibTrack[];
  stemUrl: Map<number, string>;
  peaksUrl: Map<number, string>;
}> {
  const stemUrl = new Map<number, string>();
  const peaksUrl = new Map<number, string>();
  try {
    const res = await fetch('/demo-songs/manifest.json');
    if (!res.ok) return { rows: [], stemUrl, peaksUrl };
    const data = (await res.json()) as { tracks: DemoManifestTrack[] };
    const rows = data.tracks.map((t): LibTrack => {
      stemUrl.set(t.id, `/demo-songs/${t.stemFile}`);
      // pre-baked stem-waveform thumbnail (pregen-demo-thumbnails.mjs) → instant rows
      peaksUrl.set(t.id, `/demo-songs/${t.stemFile.replace(/\.stem\.mp4$/, '')}.peaks`);
      return {
        id: t.id,
        location: `/demo-songs/${t.stemFile}`,
        filename: t.stemFile,
        artist: t.artist,
        title: t.title,
        album: t.album,
        genre: t.genre,
        year: null,
        duration: t.duration,
        bitrate: null,
        bpm: t.bpm,
        firstBeatFrame: t.firstBeatFrame,
        key: t.key,
        rating: 0,
        timesPlayed: 0,
        filetype: 'stem.mp4',
        dateAdded: '2026-01-01 12:00:00',
        // pre-processed: stems already exist, so the row shows "✓ stems" and loads instantly
        stemPath: `/demo-songs/${t.stemFile}`,
        stemsGeneratedAt: 1,
      };
    });
    return { rows, stemUrl, peaksUrl };
  } catch {
    return { rows: [], stemUrl, peaksUrl };
  }
}

// Generate a musical-ish stereo PCM track (kick pattern + harmonic content) so
// decode → peaks → waveform produces a real, colorful render. 16-bit WAV bytes.
function synthWav(seconds: number, bpm: number, sampleRate = 48000): ArrayBuffer {
  const frames = Math.floor(seconds * sampleRate);
  const beatFrames = (60 / bpm) * sampleRate;
  const numCh = 2;
  const bytesPerSample = 2;
  const dataLen = frames * numCh * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);
  const wr = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); wr(8, 'WAVE');
  wr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, numCh, true); dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * numCh * bytesPerSample, true);
  dv.setUint16(32, numCh * bytesPerSample, true); dv.setUint16(34, 16, true);
  wr(36, 'data'); dv.setUint32(40, dataLen, true);

  let off = 44;
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const beatPhase = (i % beatFrames) / beatFrames;
    // kick: decaying sine burst at each beat
    const kick = Math.exp(-beatPhase * 18) * Math.sin(2 * Math.PI * 60 * t);
    // mid harmonic + hi sweep so the 3 frequency bands all have content
    const mid = 0.4 * Math.sin(2 * Math.PI * 330 * t) * (0.5 + 0.5 * Math.sin(t * 0.7));
    const hi = 0.25 * Math.sin(2 * Math.PI * 4000 * t) * Math.exp(-((i % (beatFrames / 4)) / (beatFrames / 4)) * 6);
    const s = Math.max(-1, Math.min(1, 0.8 * kick + mid + hi));
    const v = (s * 32767) | 0;
    dv.setInt16(off, v, true); off += 2; // L
    dv.setInt16(off, v, true); off += 2; // R
  }
  return buf;
}

/** Prompt for an audio file. Prefers the File System Access picker (Chromium); falls back to
 * a hidden <input type=file> (Safari/Firefox). Resolves null if cancelled. */
async function pickAudioFile(): Promise<File | null> {
  const w = window as unknown as {
    showOpenFilePicker?: (o: unknown) => Promise<Array<{ getFile: () => Promise<File> }>>;
  };
  if (w.showOpenFilePicker) {
    try {
      const [h] = await w.showOpenFilePicker({
        types: [{ description: 'Audio', accept: { 'audio/*': ['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.stem.mp4'] } }],
        multiple: false,
      });
      return h ? await h.getFile() : null;
    } catch {
      return null; // user cancelled
    }
  }
  return new Promise<File | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,.flac,.stem.mp4';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export function makeBrowserDj(demo?: {
  rows: LibTrack[];
  stemUrl: Map<number, string>;
  peaksUrl?: Map<number, string>;
}): DjApi {
  // Use the bundled pre-processed demo songs when present; otherwise the synth fallback.
  const useDemo = !!demo && demo.rows.length > 0;
  const seed: Array<LibTrack & { mp3File?: string }> = useDemo ? demo!.rows : DEMO_TRACKS;
  const lib = new Map(seed.map((t) => [t.id, t]));
  const stemUrl = demo?.stemUrl ?? new Map<number, string>();
  const peaksUrl = demo?.peaksUrl ?? new Map<number, string>();
  // user-uploaded files (web demo "open your own"), keyed by their synthetic id
  const uploads = new Map<number, LoadedFile>();
  let nextUploadId = 100000;

  // Resolve a track to its audio: a bundled .stem.mp4 (pre-separated, loads instantly), a
  // user upload, a real served MP3, or a synth tone (fallback).
  const fileFor = async (t: LibTrack & { mp3File?: string }): Promise<LoadedFile> => {
    if (uploads.has(t.id)) return uploads.get(t.id)!;
    const su = stemUrl.get(t.id);
    if (su) {
      const res = await fetch(su);
      return {
        name: t.filename,
        path: t.location,
        data: await res.arrayBuffer(),
        isStem: true,
        meta: { title: t.title ?? undefined, artist: t.artist ?? undefined, key: t.key ?? undefined, bpm: t.bpm, firstBeatFrame: t.firstBeatFrame },
      };
    }
    if (t.mp3File) {
      try {
        const res = await fetch(`/mp3/${encodeURIComponent(t.mp3File)}`);
        if (res.ok) return { name: t.mp3File, path: t.location, data: await res.arrayBuffer() };
      } catch {
        /* fall through to synth */
      }
    }
    return { name: t.filename, path: t.location, data: synthWav(Math.min(t.duration ?? 30, 30), t.bpm || 120) };
  };

  return {
    // Web demo: open your own audio via a file picker. Reads the file in-browser, adds a
    // library row, and returns it for loading. Uploaded files run live separation if the
    // user generates stems (with the perf warning).
    openTrack: async (): Promise<LoadedFile> => {
      const file = await pickAudioFile();
      if (!file) return fileFor(seed[0]!); // cancelled → no-op-ish (load the first demo)
      const data = await file.arrayBuffer();
      const id = nextUploadId++;
      const name = file.name.replace(/\.[^.]+$/, '');
      const loaded: LoadedFile = { name: file.name, path: `upload://${id}`, data };
      uploads.set(id, loaded);
      lib.set(id, {
        ...track(id, name, name, '', '', 0, '', 0),
        location: `upload://${id}`,
        filename: file.name,
      });
      return loaded;
    },
    readTrack: async (path: string) => {
      const t = [...lib.values()].find((x) => x.location === path) ?? DEMO_TRACKS[0]!;
      return fileFor(t as LibTrack & { mp3File?: string });
    },
    libraryQuery: async (q: LibQuery) => {
      const s = (q.search ?? '').toLowerCase();
      return [...lib.values()].filter(
        (t) => !s || `${t.artist} ${t.title} ${t.album} ${t.genre}`.toLowerCase().includes(s),
      );
    },
    libraryCount: async (search?: string) => {
      const s = (search ?? '').toLowerCase();
      return [...lib.values()].filter((t) => !s || `${t.artist} ${t.title}`.toLowerCase().includes(s)).length;
    },
    libraryScan: async (): Promise<ScanSummary> => ({ scanned: lib.size, added: 0 }),
    librarySync: async (): Promise<ScanSummary> => ({ scanned: lib.size, added: 0, removed: 0 }),
    libraryDirectories: async () => [],
    libraryAddDirectory: async () => null,
    libraryRemoveDirectory: async () => {},
    settingsGet: async () => null,
    settingsSet: async () => {},
    displayOpen: async () => false,
    displaySend: () => {},
    onDisplayFrame: () => () => {},
    // Web build: the stem worker fetches the model from the CDN itself; no pre-download step.
    ensureStemModel: async () => {},
    onStemModelProgress: () => () => {},
    controllersList: async () => [],
    controllersReadFile: async () => null,
    userControllersList: async () => [],
    userControllersRead: async () => null,
    userControllersSave: async () => false,
    userControllersDelete: async () => false,
    controllerConfigGet: async () => null,
    controllerConfigSet: async () => false,
    onScanProgress: (_cb: (p: ScanProgress) => void) => () => {},
    readTrackById: async (id: number) => {
      const t = lib.get(id);
      return t ? fileFor(t as LibTrack & { mp3File?: string }) : null;
    },
    librarySetAnalysis: async () => {},
    libraryWaveform: async () => null,
    libraryDownbeats: async () => null,
    // Serve the pre-baked stem thumbnail (pregen-demo-thumbnails.mjs) so the demo rows
    // render instantly — no in-browser decode of the 4 stem files on first paint.
    libraryStemWaveforms: async (id: number) => {
      const pu = peaksUrl.get(id);
      if (!pu) return null;
      try {
        const res = await fetch(pu);
        if (!res.ok) return null;
        return new Uint8Array(await res.arrayBuffer());
      } catch {
        return null;
      }
    },
    librarySetStemWaveforms: async () => {},
    libraryStemsNeedingWaveforms: async () => [],
    libraryUnanalyzed: async () => [],
    libraryReanalyzeAll: async () => 0,
    libraryStemless: async () => [],
    libraryIncrementPlay: async () => {},
    // playlists — the web demo uses a simpler in-session model (no SQLite); these are no-op
    // stubs for now so the shared DjApi type is satisfied.
    libraryPlaylists: async () => [],
    libraryPlaylistTracks: async () => [],
    libraryCreatePlaylist: async () => 0,
    libraryAddToPlaylist: async () => {},
    libraryRemoveFromPlaylist: async () => {},
    libraryRenamePlaylist: async () => {},
    libraryDeletePlaylist: async () => {},
    saveStems: async () => null,
    saveRecording: async () => null,
    trackCover: async () => null,
  };
}
