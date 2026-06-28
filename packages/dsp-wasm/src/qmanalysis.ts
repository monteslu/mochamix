/**
 * WasmQmAnalysis — Mixxx's actual analysis (Queen Mary DSP) in WASM: key
 * (GetKeyMode), beat tracking (DetectionFunction + TempoTrackV2), and downbeats
 * (DownBeat). Replaces our hand-rolled JS key + C autocorrelation beat detectors.
 *
 * Runs in the analysis Worker. One qm_analyze pass yields bpm, firstBeatFrame, a full
 * list of beat positions (not a constant grid), downbeat positions (real measures),
 * and the musical key. Heap views are re-read after any growth.
 */

import { qmanalysisWasmBase64 } from './generated/qmanalysis-wasm.js';
import { base64ToBytes } from './base64.js';

interface QmExports {
  memory: WebAssembly.Memory;
  qm_malloc(bytes: number): number;
  qm_free(ptr: number): void;
  qm_analyze(mono: number, frames: number, sampleRate: number): void;
  qm_bpm(): number;
  qm_first_beat_frame(): number;
  qm_confidence(): number;
  qm_key(): number;
  qm_beat_count(): number;
  qm_beat_frame(i: number): number;
  qm_downbeat_count(): number;
  qm_downbeat_frame(i: number): number;
  _initialize?: () => void;
}

export interface QmResult {
  bpm: number;
  firstBeatFrame: number;
  confidence: number;
  /** Musical key, e.g. "C", "Am", or '' if none. */
  key: string;
  /** Camelot wheel code, e.g. "8B", or '' if none. */
  camelot: string;
  /** Numeric key index 1..24 (Mixxx ChromaticKey: 1-12 major C..B, 13-24 minor), 0=none.
   *  The clean representation for Camelot harmonic-match math. */
  keyNum: number;
  /** Every detected beat, in source frames (real positions, not a constant grid). */
  beatFrames: Int32Array;
  /** Bar-start beats (downbeats), in source frames. Empty if undetected. */
  downbeatFrames: Int32Array;
}

/* qm key index 1..24 → musical name. Order matches Mixxx ChromaticKey (keys.proto):
 * 1-12 major C..B, 13-24 minor C..B. */
const KEY_NAMES = [
  '', // 0 = invalid
  'C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B', // major 1-12
  'Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm', // minor 13-24
];
/* Camelot wheel, same 1..24 ordering. Major = "B" side, minor = "A" side. */
const CAMELOT = [
  '', // 0
  '8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B', // major
  '5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A', // minor
];

export class WasmQmAnalysis {
  private readonly ex: QmExports;

  constructor() {
    const bytes = base64ToBytes(qmanalysisWasmBase64);
    const module = new WebAssembly.Module(bytes);
    const noop = () => 0;
    const instance = new WebAssembly.Instance(module, {
      env: { emscripten_notify_memory_growth: () => {} },
      // qm-dsp pulls in a little stdio (unreachable on our path) → stub WASI.
      wasi_snapshot_preview1: {
        proc_exit: () => {},
        fd_close: noop,
        fd_write: noop,
        fd_seek: noop,
        fd_read: noop,
        environ_get: noop,
        environ_sizes_get: noop,
      },
    });
    this.ex = instance.exports as unknown as QmExports;
    this.ex._initialize?.();
  }

  private f32(): Float32Array {
    return new Float32Array(this.ex.memory.buffer);
  }

  /** Analyze a track: key + beats + downbeats in one WASM pass. */
  analyze(channelData: Float32Array[], frames: number, sampleRate = 44100): QmResult {
    const ex = this.ex;
    const left = channelData[0]!;
    const right = channelData.length > 1 ? channelData[1]! : left;
    // qm only uses the MONO mix → downmix here and pass ONE buffer (halves the WASM
    // memory vs two full-track channels; a long track was overflowing the heap cap).
    const monoPtr = ex.qm_malloc(frames * 4);
    if (monoPtr === 0) {
      // Heap couldn't grow enough for this track — fail cleanly instead of letting the
      // C code write out of bounds (which crashes the whole worker with a WASM trap).
      throw new Error(`qm: out of memory for ${frames} frames (track too long)`);
    }
    const heap = this.f32();
    const base = monoPtr / 4;
    for (let i = 0; i < frames; i++) heap[base + i] = 0.5 * (left[i]! + right[i]!);

    ex.qm_analyze(monoPtr, frames, sampleRate);

    const nBeats = ex.qm_beat_count();
    const beatFrames = new Int32Array(nBeats);
    for (let i = 0; i < nBeats; i++) beatFrames[i] = ex.qm_beat_frame(i);
    const nDown = ex.qm_downbeat_count();
    const downbeatFrames = new Int32Array(nDown);
    for (let i = 0; i < nDown; i++) downbeatFrames[i] = ex.qm_downbeat_frame(i);

    const k = ex.qm_key();
    ex.qm_free(monoPtr);

    return {
      bpm: ex.qm_bpm(),
      firstBeatFrame: ex.qm_first_beat_frame(),
      confidence: ex.qm_confidence(),
      key: KEY_NAMES[k] ?? '',
      camelot: CAMELOT[k] ?? '',
      keyNum: k >= 1 && k <= 24 ? k : 0,
      beatFrames,
      downbeatFrames,
    };
  }
}
