/**
 * Pipeline verification entry — runs the REAL load→decode→peaks→analyze path on
 * real WAV bytes (no demo data, no audio device — OfflineAudioContext decodes
 * headlessly). Reports the result back to the main process. Built as a separate
 * Vite entry (verify.html).
 */

import { fromAudioBuffer } from '@internal-dj/codec';
import { computePeakSet, detailBucketsForDuration } from '@internal-dj/waveform';
import { detectKey } from '@internal-dj/analysis';
import { WasmBeatDetector } from '@internal-dj/dsp-wasm';

declare global {
  interface Window {
    verify: {
      getWav: () => Promise<ArrayBuffer>;
      report: (r: unknown) => Promise<void>;
    };
  }
}

async function run(): Promise<void> {
  const result: Record<string, unknown> = { steps: [] };
  const steps = result.steps as string[];
  try {
    // 1. read real WAV bytes
    const wav = await window.verify.getWav();
    steps.push(`got wav bytes: ${wav.byteLength}`);

    // 2. decode via OfflineAudioContext (real decode path, no gesture needed)
    const octx = new OfflineAudioContext(2, 1, 44100);
    const audioBuffer = await octx.decodeAudioData(wav);
    steps.push(`decoded: ${audioBuffer.numberOfChannels}ch ${audioBuffer.length}frames @${audioBuffer.sampleRate}`);

    // 3. pack to planar SAB DecodedTrack
    const track = fromAudioBuffer(audioBuffer, 'test-track.wav');
    steps.push(`packed SAB: ${track.frames} frames, ${track.channels}ch`);

    // 4. compute waveform peaks
    const all = new Float32Array(track.sampleBuffer);
    const channels: Float32Array[] = [];
    for (let c = 0; c < track.channels; c++) {
      channels.push(all.subarray(c * track.frames, (c + 1) * track.frames));
    }
    const dur = track.frames / track.sampleRate;
    const peaks = computePeakSet(channels, track.frames, detailBucketsForDuration(dur));
    const nonZero = [...peaks.overview.peaks].some((p) => p > 0);
    steps.push(`peaks: detail=${peaks.detail.length} overview=${peaks.overview.length} nonZero=${nonZero}`);

    // 5. WASM beat detection
    const det = new WasmBeatDetector();
    const beat = det.detect(channels, track.frames, track.sampleRate);
    steps.push(`BPM: ${beat.bpm} firstBeat=${beat.firstBeatFrame} conf=${beat.confidence.toFixed(2)}`);

    // 6. key detection
    const key = detectKey(channels, track.frames, track.sampleRate);
    steps.push(`key: ${key.name} (${key.camelot})`);

    result.ok = true;
    result.bpm = beat.bpm;
    result.key = key.camelot;
    result.peaksNonZero = nonZero;
  } catch (e) {
    result.ok = false;
    result.error = String(e);
  }
  await window.verify.report(result);
}

void run();
