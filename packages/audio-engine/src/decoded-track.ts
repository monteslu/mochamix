/**
 * DecodedTrack — decoded audio ready to load into a deck. Sample data lives in a
 * SharedArrayBuffer as planar Float32 (channel after channel) so the worklet can
 * index it directly with no copy (04-audio-engine.md §4). The codec package
 * produces these; the engine consumes them.
 */
export interface DecodedTrack {
  /** Planar Float32 sample data: [ch0 frames..., ch1 frames...]. */
  sampleBuffer: SharedArrayBuffer;
  channels: number;
  frames: number;
  sampleRate: number;
  /** Optional analyzed BPM (set later by the analysis package). */
  bpm?: number;
  /** Source path/name, for display. */
  name?: string;
}

/**
 * Pack per-channel Float32 arrays (e.g. from AudioBuffer.getChannelData) into a
 * single planar SharedArrayBuffer suitable for a DecodedTrack.
 */
export function packPlanarToSab(channels: Float32Array[], frames: number): SharedArrayBuffer {
  const numCh = channels.length;
  const sab = new SharedArrayBuffer(numCh * frames * Float32Array.BYTES_PER_ELEMENT);
  const view = new Float32Array(sab);
  for (let c = 0; c < numCh; c++) {
    view.set(channels[c]!.subarray(0, frames), c * frames);
  }
  return sab;
}
