/**
 * RecordingService — renderer-side recording: taps the engine's master bus with
 * the codec Recorder (the sidechain worklet → SAB ring → WAV), and saves the
 * result to disk via IPC. Lives in the app (not the engine) to avoid a codec↔
 * engine circular dependency.
 */

import { Recorder, type RecordingResult } from '@dj/codec';
import type { Engine } from '@dj/audio-engine';

export class RecordingService {
  private recorder: Recorder | null = null;
  private recording = false;

  constructor(private readonly engine: Engine) {}

  isRecording(): boolean {
    return this.recording;
  }

  /** Start recording the master bus. Lazily creates + wires the recorder. */
  async start(): Promise<void> {
    if (this.recording) {
      return;
    }
    const ctx = this.engine.audioContext;
    const buses = this.engine.getBuses();
    if (!ctx || !buses) {
      throw new Error('engine not started');
    }
    if (!this.recorder) {
      const workletUrl = new URL('./worklets/recorder.worklet.js', document.baseURI);
      this.recorder = new Recorder(ctx, { workletUrl, bitDepth: 16 });
      const node = await this.recorder.init();
      // Tap the master bus: master → recorder (pass-through). The recorder's
      // output is a dead-end sink (not connected onward) — it only captures.
      buses.master.connect(node);
    }
    this.recorder.start();
    this.recording = true;
  }

  /** Stop recording and return the WAV result. */
  stop(): RecordingResult {
    if (!this.recorder || !this.recording) {
      throw new Error('not recording');
    }
    const result = this.recorder.stop();
    this.recording = false;
    return result;
  }

  /** Stop + save to disk via IPC. Returns the saved path (or null if canceled). */
  async stopAndSave(): Promise<string | null> {
    const result = this.stop();
    const path = await window.dj.saveRecording(result.wav);
    return path;
  }

  dispose(): void {
    this.recorder?.dispose();
    this.recorder = null;
    this.recording = false;
  }
}
