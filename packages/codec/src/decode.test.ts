import { describe, it, expect } from 'vitest';
import { fromAudioBuffer, isPlatformDecodable } from './decode.js';

// Minimal AudioBuffer stand-in (vitest has no Web Audio). fromAudioBuffer only
// uses numberOfChannels/length/sampleRate/getChannelData, so we fake those.
function fakeAudioBuffer(channels: number[][], sampleRate: number): AudioBuffer {
  const data = channels.map((c) => Float32Array.from(c));
  return {
    numberOfChannels: channels.length,
    length: channels[0]!.length,
    sampleRate,
    duration: channels[0]!.length / sampleRate,
    getChannelData: (i: number) => data[i]!,
  } as unknown as AudioBuffer;
}

describe('fromAudioBuffer', () => {
  it('packs an AudioBuffer into a planar SAB DecodedTrack', () => {
    const ab = fakeAudioBuffer(
      [
        [0, 0.5, -0.5, 1],
        [1, 0.25, -0.25, -1],
      ],
      48000,
    );
    const track = fromAudioBuffer(ab, 'test.flac');
    expect(track.channels).toBe(2);
    expect(track.frames).toBe(4);
    expect(track.sampleRate).toBe(48000);
    expect(track.name).toBe('test.flac');
    expect(track.sampleBuffer).toBeInstanceOf(SharedArrayBuffer);
    const view = new Float32Array(track.sampleBuffer);
    // planar: ch0 then ch1
    expect([...view]).toEqual([0, 0.5, -0.5, 1, 1, 0.25, -0.25, -1]);
  });
});

describe('isPlatformDecodable', () => {
  it('recognizes common formats and rejects others', () => {
    expect(isPlatformDecodable('track.mp3')).toBe(true);
    expect(isPlatformDecodable('TRACK.FLAC')).toBe(true);
    expect(isPlatformDecodable('a.b.opus')).toBe(true);
    expect(isPlatformDecodable('weird.xm')).toBe(false);
    expect(isPlatformDecodable('noextension')).toBe(false);
  });
});
