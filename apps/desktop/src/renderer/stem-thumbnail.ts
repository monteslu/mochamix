/**
 * Per-stem overview waveforms for the colored library thumbnail. Given a .stem.mp4's
 * bytes, decode the 4 stems, compute an OVERVIEW peak array each, normalize by a
 * shared max (like the deck/Mixxx), and pack to one blob for the DB. Computed once
 * (on stem generation, or lazily the first time a stem row needs a thumbnail) and
 * cached — RowWaveform just unpacks + draws it colored.
 */

import { decodeArrayBuffer } from '@dj/codec';
import { computePeaks, packStemWaveforms, OVERVIEW_BUCKETS } from '@dj/waveform';
import { extractAllTracks } from '@dj/stem-mp4';

/**
 * Compute + pack the 4-stem overview waveforms from a .stem.mp4. Returns null if the
 * file isn't a valid 5-track STEMS file.
 */
export async function computeStemWaveforms(
  ctx: AudioContext,
  stemMp4: ArrayBuffer,
): Promise<Uint8Array | null> {
  const tracks = extractAllTracks(new Uint8Array(stemMp4));
  // STEMS-4 layout: [mixdown, drums, bass, other, vocals].
  if (tracks.length < 5) return null;
  const stemBytes = tracks.slice(1, 5);

  const overviews: Uint8Array[] = [];
  for (const b of stemBytes) {
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    const dec = await decodeArrayBuffer(ctx, ab, 'stem.m4a');
    const all = new Float32Array(dec.sampleBuffer);
    const ch: Float32Array[] = [];
    for (let c = 0; c < dec.channels; c++) ch.push(all.subarray(c * dec.frames, (c + 1) * dec.frames));
    overviews.push(computePeaks(ch, dec.frames, OVERVIEW_BUCKETS).peaks);
  }

  // Shared-max normalization across all 4 stems (Mixxx-style single m_maxValue): the
  // loudest stem fills the lane, quieter stems stay proportionally shorter.
  let sharedMax = 1;
  for (const p of overviews) for (let i = 0; i < p.length; i++) if (p[i]! > sharedMax) sharedMax = p[i]!;
  const scale = 255 / sharedMax;

  return packStemWaveforms({ peaks: overviews, scale });
}
