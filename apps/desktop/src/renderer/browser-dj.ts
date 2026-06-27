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
    stemPath: null, stemsGeneratedAt: 0,
  };
}
// The first two map to real MP3s served at /mp3/<file> (vite.browser serveMusic),
// so the web build + e2e exercise actual decode/analysis/scrolling waveforms. The
// rest are synthetic. mp3File!=null marks the real ones.
const DEMO_TRACKS: Array<LibTrack & { mp3File?: string }> = [
  { ...track(1, 'The Who', "I Can't Explain", '', 'Rock', 0, '', 125), mp3File: "The Who - I Can't Explain.mp3" },
  { ...track(2, 'Bill Withers', "Ain't No Sunshine", '', 'Soul', 0, '', 125), mp3File: 'Bill Withers - Ain\'t No Sunshine.mp3' },
  track(3, 'Tycho', 'Awake', 'Awake', 'Ambient', 115, '11B', 320),
  track(4, 'Jon Hopkins', 'Emerald Rush', 'Singularity', 'Techno', 126, '4A', 365),
];

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

export function makeBrowserDj(): DjApi {
  const lib = new Map(DEMO_TRACKS.map((t) => [t.id, t]));

  // Real MP3 (served at /mp3/<file>) when the track has one, else a synth tone.
  const fileFor = async (t: LibTrack & { mp3File?: string }): Promise<LoadedFile> => {
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
    openTrack: async () => fileFor(DEMO_TRACKS[0]!),
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
    libraryStemWaveforms: async () => null,
    librarySetStemWaveforms: async () => {},
    libraryStemsNeedingWaveforms: async () => [],
    libraryUnanalyzed: async () => [],
    libraryReanalyzeAll: async () => 0,
    libraryStemless: async () => [],
    libraryIncrementPlay: async () => {},
    saveStems: async () => null,
    saveRecording: async () => null,
    trackCover: async () => null,
  };
}
