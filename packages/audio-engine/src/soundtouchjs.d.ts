/**
 * Ambient types for soundtouchjs (ships no .d.ts). Only the surface we use:
 * the SoundTouch class + its FifoSampleBuffer input/output buffers.
 */
declare module 'soundtouchjs' {
  export class FifoSampleBuffer {
    readonly frameCount: number;
    readonly vector: Float32Array;
    putSamples(samples: Float32Array, position?: number, numFrames?: number): void;
    receive(numFrames?: number): number;
    extract(target: Float32Array, position?: number, numFrames?: number): number;
    clear(): void;
  }

  export class SoundTouch {
    tempo: number;
    pitch: number;
    rate: number;
    readonly inputBuffer: FifoSampleBuffer;
    readonly outputBuffer: FifoSampleBuffer;
    process(): void;
    clear(): void;
  }

  export class SimpleFilter {
    constructor(source: unknown, pipe: SoundTouch, callback?: () => void);
    sourcePosition: number;
    extract(target: Float32Array, numFrames?: number): number;
    clear(): void;
  }
}
