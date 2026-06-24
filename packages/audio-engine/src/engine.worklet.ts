/**
 * The engine AudioWorkletProcessor — the real-time heart (the Mixxx
 * EngineMixer/EngineBuffer analog, 04-audio-engine.md §1-2). Runs on the audio
 * render thread, 128 frames per `process()` call.
 *
 * Responsibilities (M1):
 *  - hold one DeckPlayback per deck
 *  - each block, read each deck's control values from the control SAB (atomic,
 *    lock-free — the JS analog of Mixxx atomic-double ControlObjects)
 *  - produce each deck's audio into its own worklet output
 *  - publish each deck's play position back into the control SAB
 *
 * Per-channel gain/EQ/volume/crossfader live in the renderer Web Audio graph
 * (GainNode/BiquadFilterNode), so this worklet has ONE output per deck. The
 * mixer-side summing/EQ moves in here in later milestones if we need
 * sample-accurate effects, but native nodes are cheaper and glitch-free for now.
 *
 * RULE: no allocation in process(). All buffers/state are set up at construction
 * or on the (rare) message path.
 */

/// <reference lib="webworker" />

import { wrapSab, sabRead, sabWrite, type SabLayout } from '@internal-dj/control-bus';
import { DeckPlayback } from './deck-playback.js';
import { calculateSpeed } from './rate.js';
import { VuMeter } from './vu-meter.js';
import type {
  DeckControlIndices,
  EngineMessage,
  LoadTrackMessage,
} from './protocol.js';

// AudioWorkletProcessor globals (provided by the audio worklet global scope).
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare function registerProcessor(
  name: string,
  ctor: new (options?: unknown) => AudioWorkletProcessor,
): void;

interface DeckSlot {
  playback: DeckPlayback;
  indices: DeckControlIndices;
  vu: VuMeter;
  /** Last volume-fader value, captured for the VU publish. */
  lastVolume: number;
  /** How often to publish play position back to the bus (in blocks). */
  positionPublishCounter: number;
}

const POSITION_PUBLISH_EVERY = 4; // ~every 4 blocks (~11ms @48k/128) → smooth UI, low churn
// VU publish cadence: ~30Hz. At 48k/128 a block is ~2.67ms, so ~11 blocks ≈ 30Hz.
const VU_PUBLISH_EVERY = 11;

class EngineProcessor extends AudioWorkletProcessor {
  private control: SabLayout | null = null;
  private decks: DeckSlot[] = [];
  private vuCounter = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<EngineMessage>) => this.onMessage(e.data);
    this.port.postMessage({ type: 'ready' });
  }

  private onMessage(msg: EngineMessage): void {
    switch (msg.type) {
      case 'init': {
        this.control = wrapSab(msg.controlBuffer, msg.controlCapacity);
        this.decks = msg.deckIndices.map((indices) => ({
          playback: new DeckPlayback(msg.sampleRate),
          indices,
          vu: new VuMeter(),
          lastVolume: 1,
          positionPublishCounter: 0,
        }));
        this.vuCounter = 0;
        break;
      }
      case 'loadTrack': {
        this.loadTrack(msg);
        break;
      }
      case 'eject': {
        this.decks[msg.deck]?.playback.eject();
        break;
      }
      case 'seek': {
        this.decks[msg.deck]?.playback.seekFrames(msg.frame);
        break;
      }
      case 'setLoop': {
        this.decks[msg.deck]?.playback.setLoop(msg.start, msg.end, msg.enabled);
        break;
      }
      case 'loopEnable': {
        this.decks[msg.deck]?.playback.setLoopEnabled(msg.enabled);
        break;
      }
    }
  }

  private loadTrack(msg: LoadTrackMessage): void {
    const slot = this.decks[msg.deck];
    if (!slot) {
      return;
    }
    // Wrap the shared sample buffer as planar Float32 channels (no copy).
    const all = new Float32Array(msg.sampleBuffer);
    const channelData: Float32Array[] = [];
    for (let c = 0; c < msg.channels; c++) {
      channelData.push(all.subarray(c * msg.frames, (c + 1) * msg.frames));
    }
    slot.playback.loadTrack({
      channelData,
      channels: msg.channels,
      frames: msg.frames,
      sampleRate: msg.trackSampleRate,
    });
    // Publish loaded state + track length immediately.
    if (this.control) {
      sabWrite(this.control, slot.indices.trackLoaded, 1);
      sabWrite(this.control, slot.indices.trackSamples, msg.frames);
      sabWrite(this.control, slot.indices.duration, msg.frames / msg.trackSampleRate);
      sabWrite(this.control, slot.indices.playPosition, 0);
    }
  }

  override process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const control = this.control;
    if (!control) {
      return true;
    }

    for (let d = 0; d < this.decks.length; d++) {
      const slot = this.decks[d]!;
      const out = outputs[d];
      if (!out || out.length === 0) {
        continue;
      }
      const numFrames = out[0]!.length;
      const idx = slot.indices;

      const playing = sabRead(control, idx.play) > 0.5;
      const rate = sabRead(control, idx.rate);
      const rateRange = sabRead(control, idx.rateRange);
      const rateDir = sabRead(control, idx.rateDirection) >= 0 ? 1 : -1;
      const pregain = sabRead(control, idx.pregain);
      const keylock = sabRead(control, idx.keylock) > 0.5;
      const ratioOverride = sabRead(control, idx.rateRatioOverride);

      slot.playback.setKeylock(keylock);
      // Sync / smart fader can force a rate ratio beyond the slider's range.
      const speed = ratioOverride > 0 ? ratioOverride : calculateSpeed(rate, rateRange, rateDir);

      const stillPlaying = slot.playback.process(out, numFrames, speed, playing);

      // Apply pregain inline (cheap; the renderer applies EQ/volume/xfader after).
      if (pregain !== 1) {
        for (let c = 0; c < out.length; c++) {
          const ch = out[c]!;
          for (let i = 0; i < numFrames; i++) {
            ch[i]! *= pregain;
          }
        }
      }

      // Meter the (post-pregain) deck signal. Measure channel 0 (cheap; stereo
      // VU split can come later). Applies the volume fader's contribution so the
      // meter reflects what's sent to the mix.
      const volume = sabRead(control, idx.volume);
      slot.vu.process(out[0]!, numFrames);

      // Publish effective rate ratio + position (rate-limited).
      sabWrite(control, idx.rateRatio, speed);
      if (++slot.positionPublishCounter >= POSITION_PUBLISH_EVERY) {
        slot.positionPublishCounter = 0;
        sabWrite(control, idx.playPosition, slot.playback.getPositionFraction());
      }

      // Auto-stop at end of track.
      if (playing && !stillPlaying && slot.playback.hasTrack()) {
        sabWrite(control, idx.play, 0);
        this.port.postMessage({ type: 'trackEnded', deck: d });
      }

      // Stash volume for the VU publish below (avoids a second sabRead).
      slot.lastVolume = volume;
    }

    // Publish VU meters at ~30Hz (one cadence for all decks).
    if (++this.vuCounter >= VU_PUBLISH_EVERY) {
      this.vuCounter = 0;
      for (const slot of this.decks) {
        const scaled = Math.min(1, slot.vu.getLevel() * (slot.lastVolume ?? 1));
        sabWrite(control, slot.indices.vuMeter, scaled);
        sabWrite(control, slot.indices.peakIndicator, slot.vu.isClipped() ? 1 : 0);
        slot.vu.resetPeak();
      }
    }

    return true;
  }
}

registerProcessor('internal-dj-engine', EngineProcessor);
