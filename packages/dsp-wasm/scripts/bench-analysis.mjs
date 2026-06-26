/**
 * Benchmark: WASM+SIMD analysis kernels vs the pure-JS they replace, on REAL music
 * from ~/Music/mp3. Decodes via ffmpeg → planar Float32, warms up each impl, then
 * times peaks (band waveform) and beat detection. Reports per-track + average speedup.
 *
 * Run: node scripts/bench-analysis.mjs [N]   (N = how many tracks, default 6)
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const MUSIC = join(homedir(), 'Music', 'mp3');
const N = parseInt(process.argv[2] || '6', 10);
const SR = 44100;

// Decode an mp3 to planar Float32 [L, R] at SR via ffmpeg (interleaved f32le → split).
function decode(path) {
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-i', path, '-ac', '2', '-ar', String(SR), '-f', 'f32le', 'pipe:1'],
    { maxBuffer: 1 << 30 },
  );
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${path}`);
  const inter = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength >> 2);
  const frames = inter.length >> 1;
  const l = new Float32Array(frames);
  const rr = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    l[i] = inter[i * 2];
    rr[i] = inter[i * 2 + 1];
  }
  return { left: l, right: rr, frames };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}
function time(fn, runs = 5) {
  const ts = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  return median(ts);
}

async function main() {
  // dynamic import the built TS via tsx-less route: import compiled dist if present,
  // else the source through Node's --experimental loader is unavailable here, so we
  // import the .ts via the workspace's vitest-style resolution is also unavailable.
  // Simplest: import the JS dist. Ensure `tsc --build` ran first.
  const dsp = await import(pathToFileURL(join(process.cwd(), 'dist', 'index.js')).href);
  const waveform = await import(
    pathToFileURL(join(process.cwd(), '..', 'waveform', 'dist', 'index.js')).href
  );
  const analysis = await import(
    pathToFileURL(join(process.cwd(), '..', 'analysis', 'dist', 'index.js')).href
  );
  // The JS beat detector isn't re-exported from the index (test-only); import direct.
  const beatJs = await import(
    pathToFileURL(join(process.cwd(), '..', 'analysis', 'dist', 'beat-detector.js')).href
  );

  const { WasmPeaks, WasmBeatDetector } = dsp;
  const jsComputePeakSet = waveform.computePeakSet;
  const jsDetailBuckets = waveform.detailBucketsForDuration;
  const jsDetectBeats = beatJs.detectBeats;
  const jsDetectKey = analysis.detectKey;

  const files = readdirSync(MUSIC)
    .filter((f) => f.toLowerCase().endsWith('.mp3'))
    .slice(0, N)
    .map((f) => join(MUSIC, f));

  const wasmPeaks = new WasmPeaks();
  const beat = new WasmBeatDetector();

  console.log(`\nBenchmarking ${files.length} tracks from ${MUSIC} (SR=${SR})\n`);

  const tot = { peaks: [], beat: [], key: [] };

  for (const path of files) {
    const { left, right, frames } = decode(path);
    const dur = frames / SR;
    const channels = [left, right];
    const detailBuckets = jsDetailBuckets(dur);
    const OVERVIEW = 1920;

    // ---- warm up (JIT + caches) ----
    for (let i = 0; i < 2; i++) {
      jsComputePeakSet(channels, frames, detailBuckets, SR);
      wasmPeaks.compute(channels, frames, detailBuckets, OVERVIEW, SR);
      jsDetectBeats?.(channels, frames, SR);
      beat.detect(channels, frames, SR);
      jsDetectKey?.(channels, frames, SR);
    }

    // ---- timed ----
    const jsPeaks = time(() => jsComputePeakSet(channels, frames, detailBuckets, SR));
    const wsPeaks = time(() => wasmPeaks.compute(channels, frames, detailBuckets, OVERVIEW, SR));

    const jsBeat = jsDetectBeats ? time(() => jsDetectBeats(channels, frames, SR)) : NaN;
    const wsBeat = time(() => beat.detect(channels, frames, SR));

    const jsKey = jsDetectKey ? time(() => jsDetectKey(channels, frames, SR)) : NaN;

    tot.peaks.push(jsPeaks / wsPeaks);
    if (!Number.isNaN(jsBeat)) tot.beat.push(jsBeat / wsBeat);
    if (!Number.isNaN(jsKey)) tot.key.push(jsKey);

    const name = path.split('/').pop().slice(0, 38).padEnd(38);
    console.log(
      `${name} ${dur.toFixed(0)}s | ` +
        `peaks JS ${jsPeaks.toFixed(1)}ms → WASM ${wsPeaks.toFixed(1)}ms (${(jsPeaks / wsPeaks).toFixed(1)}×) | ` +
        `beat JS ${Number.isNaN(jsBeat) ? '—' : jsBeat.toFixed(1) + 'ms'} → WASM ${wsBeat.toFixed(1)}ms` +
        (Number.isNaN(jsBeat) ? '' : ` (${(jsBeat / wsBeat).toFixed(1)}×)`) +
        ` | key JS ${Number.isNaN(jsKey) ? '—' : jsKey.toFixed(1) + 'ms (no WASM yet)'}`,
    );
  }

  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  console.log('\n=== AVERAGE SPEEDUP (WASM+SIMD vs JS) ===');
  console.log(`  peaks (band waveform): ${avg(tot.peaks).toFixed(1)}× faster`);
  console.log(`  beat detection:        ${avg(tot.beat).toFixed(1)}× faster`);
  console.log(
    `  key detection:         still pure JS (median ${median(tot.key).toFixed(0)}ms/track) — WASM port next`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
