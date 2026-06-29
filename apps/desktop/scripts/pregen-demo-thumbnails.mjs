/**
 * Pre-generate stem-waveform thumbnails for the bundled web-demo songs, so the demo
 * library renders its colored mini-waves INSTANTLY with no in-browser decode (decoding the
 * 4 stem files on first paint caused a long pause). For each demo .stem.mp4 we decode its 4
 * stems (drums/bass/other/vocals) to PCM via ffmpeg, compute the same overview peaks the
 * app's computeStemWaveforms() produces, and write a <track>.peaks file next to it. Run via:
 *   node apps/desktop/scripts/pregen-demo-thumbnails.mjs
 * The byte layout matches packStemWaveforms (so browser-dj can serve it as-is).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Import the BUILT module directly (the package index is TS source with .js import paths
// that only resolve from dist; this avoids needing a TS loader for a one-off script).
import { computePeaks, packStemWaveforms, OVERVIEW_BUCKETS } from '../../../packages/waveform/dist/peaks.js';

const DEMO_DIR = fileURLToPath(new URL('../src/renderer/public/demo-songs/', import.meta.url));
const manifest = JSON.parse(readFileSync(`${DEMO_DIR}manifest.json`, 'utf8'));

// STEMS-4 layout in the .stem.mp4: track 0 = mixdown, 1..4 = drums/bass/other/vocals.
// (We want the 4 separable stems, so map audio streams 1..4.)
const STEM_STREAMS = [1, 2, 3, 4];

/** Decode one audio stream of the file to interleaved-stereo Float32, return per-channel. */
function decodeStem(file, stream) {
  const raw = execFileSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', `0:a:${stream}`, '-f', 'f32le', '-ac', '2', '-ar', '48000', '-'],
    { maxBuffer: 1 << 30 },
  );
  const inter = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2);
  const frames = inter.length >> 1; // stereo
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    L[i] = inter[i * 2];
    R[i] = inter[i * 2 + 1];
  }
  return { ch: [L, R], frames };
}

for (const t of manifest.tracks) {
  const file = `${DEMO_DIR}${t.stemFile}`;
  process.stdout.write(`pregen ${t.artist} - ${t.title} ... `);
  const overviews = [];
  for (const s of STEM_STREAMS) {
    const { ch, frames } = decodeStem(file, s);
    overviews.push(computePeaks(ch, frames, OVERVIEW_BUCKETS).peaks);
  }
  // Shared-max normalization across all 4 stems (matches computeStemWaveforms): the loudest
  // stem fills the lane, quieter stems stay proportionally shorter.
  let sharedMax = 1;
  for (const p of overviews) for (let i = 0; i < p.length; i++) if (p[i] > sharedMax) sharedMax = p[i];
  const blob = packStemWaveforms({ peaks: overviews, scale: 255 / sharedMax });
  const out = `${DEMO_DIR}${t.stemFile.replace(/\.stem\.mp4$/, '')}.peaks`;
  writeFileSync(out, blob);
  console.log(`${blob.length} bytes -> ${out.split('/').pop()}`);
}
console.log('done.');
