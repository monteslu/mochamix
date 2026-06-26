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

import { wrapSab, sabRead, sabWrite, type SabLayout } from '@dj/control-bus';
import { DeckPlayback } from './deck-playback.js';
import { calculateSpeed } from './rate.js';
import { VuMeter } from './vu-meter.js';
import { makeGrid, computeSnapTarget } from './sync/beatgrid.js';
import type {
  DeckControlIndices,
  EngineMessage,
  LoadTrackMessage,
} from './protocol.js';

// AudioWorkletProcessor globals (provided by the audio worklet global scope).
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
// AudioWorkletGlobalScope provides the engine sample rate.
declare const sampleRate: number;

interface DeckSlot {
  playback: DeckPlayback;
  indices: DeckControlIndices;
  vu: VuMeter;
  /** Last volume-fader value, captured for the VU publish. */
  lastVolume: number;
  /** How often to publish play position back to the bus (in blocks). */
  positionPublishCounter: number;
  /** Previous syncEnabled, to detect the 0→1 edge that triggers the phase snap. */
  lastSyncEnabled: boolean;
  /** Previous play / scratching, to re-snap on resume and scratch-release. */
  lastPlay: boolean;
  lastScratching: boolean;
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
          lastSyncEnabled: false,
          lastPlay: false,
          lastScratching: false,
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

  /**
   * Phase-snap a follower onto the leader's exact beat, IN THE WORKLET, using each
   * deck's sample-accurate position (not a stale UI read). Runs on the syncEnabled
   * 0→1 edge. This is the Mixxx architecture: the snap happens in the realtime
   * engine, so it actually lands precisely. (Mixxx: getNearestPositionInPhase →
   * seekExact, ported in alignedFrame.)
   */
  private phaseSnap(control: SabLayout): void {
    for (let d = 0; d < this.decks.length; d++) {
      const slot = this.decks[d]!;
      const idx = slot.indices;

      // "Synced" = this deck is under sync/smart-fade tempo control (either sets a
      // rate override). Only such a deck phase-tracks the leader.
      const synced =
        (idx.syncEnabled !== undefined && sabRead(control, idx.syncEnabled) > 0.5) ||
        (idx.rateRatioOverride !== undefined && sabRead(control, idx.rateRatioOverride) > 0);

      const playing = sabRead(control, idx.play) > 0.5;
      const scratching = idx.scratching !== undefined && sabRead(control, idx.scratching) > 0.5;

      // Re-snap on the RIGHT moments (not at load): the deck starts/resumes playing,
      // or a scratch ends — plus an explicit syncRequest pulse. NOT every buffer.
      let trigger = false;
      if (synced) {
        if (playing && !slot.lastPlay) trigger = true; // play / resume
        if (!scratching && slot.lastScratching) trigger = true; // scratch released
      }
      if (idx.syncRequest !== undefined && sabRead(control, idx.syncRequest) > 0.5) {
        trigger = true;
        sabWrite(control, idx.syncRequest, 0); // consume the pulse
      }
      slot.lastPlay = playing;
      slot.lastScratching = scratching;
      if (idx.syncEnabled !== undefined) slot.lastSyncEnabled = sabRead(control, idx.syncEnabled) > 0.5;
      if (!trigger) continue;

      // find a leader: another deck with a bpm that is actually PLAYING — snapping to
      // a paused leader gives a garbage phase (the bug: aligned to pos 0 pre-grid).
      let leader = -1;
      for (let o = 0; o < this.decks.length; o++) {
        if (o === d) continue;
        const oi = this.decks[o]!.indices;
        if (oi.fileBpm === undefined || sabRead(control, oi.fileBpm) <= 0) continue;
        if (sabRead(control, oi.play) > 0.5) { leader = o; break; }
      }
      if (leader < 0) continue; // no playing leader → nothing meaningful to align to

      const li = this.decks[leader]!.indices;
      const leaderBpm = sabRead(control, li.fileBpm!);
      const followerBpm = idx.fileBpm !== undefined ? sabRead(control, idx.fileBpm) : 0;
      if (leaderBpm <= 0 || followerBpm <= 0) continue;

      const lg = makeGrid(leaderBpm, li.firstBeatFrame !== undefined ? Math.max(0, sabRead(control, li.firstBeatFrame)) : 0, sampleRate);
      const fg = makeGrid(followerBpm, idx.firstBeatFrame !== undefined ? Math.max(0, sabRead(control, idx.firstBeatFrame)) : 0, sampleRate);
      if (!lg || !fg) continue;

      // EXACT positions straight from the playback (sample-accurate, not the bus)
      const leaderPos = this.decks[leader]!.playback.getPositionFrames();
      const followerPos = slot.playback.getPositionFrames();
      const target = computeSnapTarget(lg, leaderPos, fg, followerPos);
      slot.playback.seekFrames(target);
      sabWrite(control, idx.playPosition, slot.playback.getPositionFraction());
    }
  }

  override process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const control = this.control;
    if (!control) {
      return true;
    }
    this.phaseSnap(control);

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
      const scratching = idx.scratching !== undefined && sabRead(control, idx.scratching) > 0.5;
      const scratchRate = idx.scratchRate !== undefined ? sabRead(control, idx.scratchRate) : 0;

      // Scratch OVERRIDES everything: signed speed (negative = reverse), and it
      // sounds even when the deck is "stopped" (vinyl moves under the hand).
      // Keylock is forced off while scratching (pitch follows the hand).
      slot.playback.setKeylock(keylock && !scratching);
      let speed: number;
      let processPlaying: boolean;
      if (scratching) {
        speed = scratchRate;
        processPlaying = true;
      } else {
        // Sync / smart fader can force a rate ratio beyond the slider's range.
        speed = ratioOverride > 0 ? ratioOverride : calculateSpeed(rate, rateRange, rateDir);
        processPlaying = playing;
      }

      const stillPlaying = slot.playback.process(out, numFrames, speed, processPlaying);

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

registerProcessor('dj-engine', EngineProcessor);
