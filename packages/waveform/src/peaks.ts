/**
 * Waveform peak computation (05-library-and-data.md §7).
 *
 * Mixxx stores per-band 8-bit PEAK (max-of-abs, NOT RMS) buckets at two
 * resolutions (a detailed ~441/s view and a fixed ~3840-sample overview). M1
 * computes a single-band (all-frequency) peak set; the 4-band Bessel split lands
 * with the analysis package (it needs the same filters as the EQ).
 *
 * Values are stored as Uint8 (0..255) — tiny, and all the precision a display
 * needs. Pure functions; the heavy version (offline filtering for 4 bands) moves
 * to a worker/WGSL later, but max-abs bucketing is cheap enough to keep here.
 */

export interface PeakData {
  /** Number of buckets (visual samples). */
  length: number;
  /** Per-bucket max-abs amplitude, 0..255. */
  peaks: Uint8Array;
  /** Per-bucket LOW-band peak, 0..255 (interleaved with peaks for coloring). */
  low?: Uint8Array;
  /** Per-bucket MID-band peak, 0..255. */
  mid?: Uint8Array;
  /** Per-bucket HIGH-band peak, 0..255. */
  high?: Uint8Array;
  /** Source frames per bucket (the reduction ratio). */
  framesPerBucket: number;
  /** Total source frames this was computed from. */
  frames: number;
}

/** Default overview budget (matches Mixxx's ~3840 summary samples). */
export const OVERVIEW_BUCKETS = 1920;

/**
 * Pack amp + 3 band peaks into one interleaved RGBA blob (4 bytes/bucket: amp,
 * low, mid, high) for compact DB storage. Unpack restores the four Uint8 arrays.
 */
export function packPeaks(p: PeakData): Uint8Array {
  const n = p.length;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = p.peaks[i]!;
    out[i * 4 + 1] = p.low ? p.low[i]! : p.peaks[i]!;
    out[i * 4 + 2] = p.mid ? p.mid[i]! : p.peaks[i]!;
    out[i * 4 + 3] = p.high ? p.high[i]! : p.peaks[i]!;
  }
  return out;
}

export function unpackPeaks(blob: Uint8Array): {
  peaks: Uint8Array;
  low: Uint8Array;
  mid: Uint8Array;
  high: Uint8Array;
} {
  const n = (blob.length / 4) | 0;
  const peaks = new Uint8Array(n);
  const low = new Uint8Array(n);
  const mid = new Uint8Array(n);
  const high = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    peaks[i] = blob[i * 4]!;
    low[i] = blob[i * 4 + 1]!;
    mid[i] = blob[i * 4 + 2]!;
    high[i] = blob[i * 4 + 3]!;
  }
  return { peaks, low, mid, high };
}

/** One stem's overview peaks (0..255 per bucket) for the colored thumbnail. */
export interface StemOverview {
  /** NI-Stems order: 0=drums, 1=bass, 2=other, 3=vocals. */
  peaks: Uint8Array[];
  /** Shared-max normalization (≈255/loudest-stem-max) applied to all stems. */
  scale: number;
}

/**
 * Pack 4 stem overview peak arrays (all same length) + the shared scale into one
 * blob: [int32 bucketCount][int32 scale×256][4 × bucketCount uint8 peaks].
 */
export function packStemWaveforms(s: StemOverview): Uint8Array {
  const n = s.peaks[0]?.length ?? 0;
  const header = new ArrayBuffer(8);
  const dv = new DataView(header);
  dv.setInt32(0, n, true);
  dv.setInt32(4, Math.round(s.scale * 256), true); // scale as Q8 fixed-point
  const out = new Uint8Array(8 + n * 4);
  out.set(new Uint8Array(header), 0);
  for (let k = 0; k < 4; k++) out.set(s.peaks[k] ?? new Uint8Array(n), 8 + k * n);
  return out;
}

export function unpackStemWaveforms(blob: Uint8Array): StemOverview | null {
  if (blob.length < 8) return null;
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const n = dv.getInt32(0, true);
  const scale = dv.getInt32(4, true) / 256;
  if (n <= 0 || blob.length < 8 + n * 4) return null;
  const peaks: Uint8Array[] = [];
  for (let k = 0; k < 4; k++) peaks.push(blob.subarray(8 + k * n, 8 + (k + 1) * n));
  return { peaks, scale };
}

/**
 * Compute max-abs peak buckets from planar channel data. Mixes channels (max of
 * channel abs) per frame, then takes the max over each bucket window.
 *
 * @param channelData planar Float32 channels
 * @param frames      number of frames
 * @param buckets     desired bucket count (output resolution)
 */
export function computePeaks(
  channelData: Float32Array[],
  frames: number,
  buckets: number,
): PeakData {
  const numBuckets = Math.max(1, Math.min(buckets, frames));
  const out = new Uint8Array(numBuckets);
  const framesPerBucket = frames / numBuckets;
  const channels = channelData.length;

  for (let b = 0; b < numBuckets; b++) {
    const start = Math.floor(b * framesPerBucket);
    const end = b === numBuckets - 1 ? frames : Math.floor((b + 1) * framesPerBucket);
    let peak = 0;
    for (let i = start; i < end; i++) {
      for (let c = 0; c < channels; c++) {
        const s = channelData[c]![i]!;
        const a = s < 0 ? -s : s;
        if (a > peak) {
          peak = a;
        }
      }
    }
    // Clamp to [0,1] then quantize to 0..255.
    out[b] = Math.min(255, Math.round(peak * 255));
  }

  return { length: numBuckets, peaks: out, framesPerBucket, frames };
}

/**
 * 3-band peak buckets (low/mid/high) for frequency-colored waveforms (the
 * Mixxx/rekordbox/Serato look: bass=red, mids=green, highs=blue). Splits the mono
 * mix into bands with cheap one-pole filters, then max-abs buckets each band.
 * Returns a PeakData whose `peaks` is the overall amplitude and `low/mid/high`
 * are the per-band peaks. Runs in the analysis worker (it iterates every sample).
 *
 * Bands (one-pole crossovers, approximate): low < ~250Hz, high > ~2.5kHz, mid in
 * between. Good enough for coloring; not a mastering EQ.
 */
export function computeBandPeaks(
  channelData: Float32Array[],
  frames: number,
  buckets: number,
  sampleRate = 44100,
): PeakData {
  const numBuckets = Math.max(1, Math.min(buckets, frames));
  const framesPerBucket = frames / numBuckets;
  const channels = channelData.length;
  const all = new Uint8Array(numBuckets);
  const low = new Uint8Array(numBuckets);
  const mid = new Uint8Array(numBuckets);
  const high = new Uint8Array(numBuckets);

  // one-pole coefficients for the two crossover corners
  const aLow = Math.exp((-2 * Math.PI * 250) / sampleRate); // LP @250Hz
  const aHigh = Math.exp((-2 * Math.PI * 2500) / sampleRate); // LP @2.5kHz (for HP via diff)
  let lpLow = 0; // running low-pass (low band)
  let lpHigh = 0; // running low-pass @2.5k (everything below highs)

  let b = 0;
  let bucketEnd = Math.floor(framesPerBucket);
  let pAll = 0, pLow = 0, pMid = 0, pHigh = 0;

  for (let i = 0; i < frames; i++) {
    // mono mix
    let s = 0;
    for (let c = 0; c < channels; c++) s += channelData[c]![i]!;
    s /= channels;

    lpLow = aLow * lpLow + (1 - aLow) * s;
    lpHigh = aHigh * lpHigh + (1 - aHigh) * s;
    const lowB = lpLow;
    const highB = s - lpHigh; // above 2.5k
    const midB = lpHigh - lpLow; // 250..2.5k

    const aA = s < 0 ? -s : s;
    const aL = lowB < 0 ? -lowB : lowB;
    const aM = midB < 0 ? -midB : midB;
    const aH = highB < 0 ? -highB : highB;
    if (aA > pAll) pAll = aA;
    if (aL > pLow) pLow = aL;
    if (aM > pMid) pMid = aM;
    if (aH > pHigh) pHigh = aH;

    if (i >= bucketEnd && b < numBuckets) {
      all[b] = Math.min(255, Math.round(pAll * 255));
      low[b] = Math.min(255, Math.round(pLow * 255));
      mid[b] = Math.min(255, Math.round(pMid * 2 * 255)); // mids read quieter; lift
      high[b] = Math.min(255, Math.round(pHigh * 3 * 255)); // highs quieter still
      b++;
      bucketEnd = Math.floor((b + 1) * framesPerBucket);
      pAll = pLow = pMid = pHigh = 0;
    }
  }
  // flush last bucket
  if (b < numBuckets) {
    all[b] = Math.min(255, Math.round(pAll * 255));
    low[b] = Math.min(255, Math.round(pLow * 255));
    mid[b] = Math.min(255, Math.round(pMid * 2 * 255));
    high[b] = Math.min(255, Math.round(pHigh * 3 * 255));
  }

  return { length: numBuckets, peaks: all, low, mid, high, framesPerBucket, frames };
}

/**
 * Compute both resolutions in one pass-ish: a detailed view at `detailBuckets`
 * (used for the zoomed scrolling waveform) and an overview at OVERVIEW_BUCKETS.
 * For M1 we just compute each independently; the detailed view is derived from
 * the source so it's accurate, and the overview is a coarse reduction.
 */
export function computePeakSet(
  channelData: Float32Array[],
  frames: number,
  detailBuckets: number,
  sampleRate = 44100,
): { detail: PeakData; overview: PeakData } {
  // 3-band peaks for frequency-colored waveforms (Mixxx/rekordbox look).
  return {
    detail: computeBandPeaks(channelData, frames, detailBuckets, sampleRate),
    overview: computeBandPeaks(channelData, frames, OVERVIEW_BUCKETS, sampleRate),
  };
}

/**
 * How many detail buckets to compute for a target visual density. Mixxx's
 * detailed view is ~441 visual samples/sec; we expose it as a function of
 * duration so callers don't hardcode it.
 */
export function detailBucketsForDuration(durationSeconds: number, perSecond = 441): number {
  return Math.max(1, Math.round(durationSeconds * perSecond));
}
