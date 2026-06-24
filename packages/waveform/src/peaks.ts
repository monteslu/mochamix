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
  /** Source frames per bucket (the reduction ratio). */
  framesPerBucket: number;
  /** Total source frames this was computed from. */
  frames: number;
}

/** Default overview budget (matches Mixxx's ~3840 summary samples). */
export const OVERVIEW_BUCKETS = 1920;

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
 * Compute both resolutions in one pass-ish: a detailed view at `detailBuckets`
 * (used for the zoomed scrolling waveform) and an overview at OVERVIEW_BUCKETS.
 * For M1 we just compute each independently; the detailed view is derived from
 * the source so it's accurate, and the overview is a coarse reduction.
 */
export function computePeakSet(
  channelData: Float32Array[],
  frames: number,
  detailBuckets: number,
): { detail: PeakData; overview: PeakData } {
  return {
    detail: computePeaks(channelData, frames, detailBuckets),
    overview: computePeaks(channelData, frames, OVERVIEW_BUCKETS),
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
