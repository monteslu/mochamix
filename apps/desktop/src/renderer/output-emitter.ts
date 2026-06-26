/**
 * OutputEmitter — the renderer service that EMITS the output bus when enabled. dj-app
 * renders no visuals; this just gathers data and pushes it over a transport so a display
 * (another tab/window/machine) can visualize.
 *
 * OFF BY DEFAULT — nothing is created until start(). When on:
 *  - taps the MASTER bus with an AnalyserNode and pushes time-domain bytes each frame,
 *  - publishes per-deck metadata (track/position/bpm/key/beat phase), throttled,
 *  - relays control directives (which visualization a display should play).
 *
 * The transport is pluggable (BroadcastChannel today; WebSocket/RTC later) so a remote
 * machine at an IP can be a display with no change here.
 */

import {
  OutputProducer,
  IpcTransport,
  type DeckMeta,
  type ControlTarget,
  type VizDirective,
  type OutFrame,
} from '@dj/output-bus';
import { deck as deckGroup, DeckKeys, MASTER, MasterKeys, type ControlBus } from '@dj/control-bus';
import type { Engine } from '@dj/audio-engine';
import { getDeckTrack } from './deck-state.js';
import { onFrame } from './frame-loop.js';

const META_HZ = 8; // metadata updates per second (positions move smoothly enough)
const FFT_SIZE = 1024; // master-bus time-domain block size sent to displays

export class OutputEmitter {
  private producer: OutputProducer | null = null;
  private analyser: AnalyserNode | null = null;
  private samples: Uint8Array<ArrayBuffer> | null = null;
  private unsub: (() => void) | null = null;
  private lastMeta = 0;
  private running = false;

  constructor(
    private readonly engine: Engine,
    private readonly bus: ControlBus,
    private readonly numDecks: number,
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  /** Begin emitting (idempotent). Creates the transport + master-bus tap. */
  start(): void {
    if (this.running) return;
    const buses = this.engine.getBuses();
    const ctx = this.engine.audioContext;
    if (!buses || !ctx) {
      console.warn('[output] cannot start — audio engine not running');
      return;
    }
    // Tap the MASTER bus (post-mix) with an analyser. Connecting an analyser does not
    // alter the signal (it has no output connected), so the master audio is untouched.
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.samples = new Uint8Array(this.analyser.fftSize);
    buses.master.connect(this.analyser);

    // IPC transport: frames go to the main process, which relays them to all open
    // display windows (a different renderer process — BroadcastChannel can't reach it).
    this.producer = new OutputProducer(
      new IpcTransport({ send: (f: OutFrame) => window.dj.displaySend(f) }),
    );
    this.running = true;
    this.unsub = onFrame((now) => this.tick(now));
    console.log('[output] emitting to display windows over IPC');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.unsub?.();
    this.unsub = null;
    if (this.analyser) {
      try {
        this.engine.getBuses()?.master.disconnect(this.analyser);
      } catch {
        /* already disconnected */
      }
      this.analyser = null;
    }
    this.producer?.close();
    this.producer = null;
    console.log('[output] stopped emitting');
  }

  /** Direct a display / group / all to a visualization (the app is the conductor). */
  control(target: ControlTarget, directive: VizDirective): void {
    this.producer?.control(target, directive);
  }

  private tick(now: number): void {
    const a = this.analyser;
    const s = this.samples;
    const p = this.producer;
    if (!a || !s || !p) return;
    // AUDIO: time-domain bytes every frame (lossy newest-wins downstream).
    a.getByteTimeDomainData(s);
    p.pushAudio(s, a.context.sampleRate);
    // META: throttled to META_HZ.
    if (now - this.lastMeta >= 1000 / META_HZ) {
      this.lastMeta = now;
      p.publishMeta(this.collectMeta(), this.masterDeck(), now);
    }
  }

  private collectMeta(): DeckMeta[] {
    const out: DeckMeta[] = [];
    for (let d = 0; d < this.numDecks; d++) {
      const g = deckGroup(d + 1);
      const sr = this.bus.get(MASTER, MasterKeys.sampleRate) || 48000;
      const frames = this.bus.get(g, DeckKeys.trackSamples);
      const pos = this.bus.get(g, DeckKeys.playPosition); // 0..1
      const bpm = this.bus.get(g, DeckKeys.fileBpm);
      const st = getDeckTrack(d);
      const loaded = this.bus.get(g, DeckKeys.trackLoaded) > 0.5;
      out.push({
        loaded,
        playing: this.bus.get(g, DeckKeys.play) > 0.5,
        title: st.title ?? undefined,
        artist: st.artist ?? undefined,
        durationSec: frames > 0 ? frames / sr : undefined,
        positionSec: frames > 0 ? (pos * frames) / sr : undefined,
        bpm: bpm > 0 ? bpm : undefined,
        key: st.key ?? undefined,
        beatPhase: this.bus.get(g, DeckKeys.beatDistance) || undefined,
      });
    }
    return out;
  }

  /** Best guess at the audible master deck: the playing deck with the highest volume. */
  private masterDeck(): number | undefined {
    let best = -1;
    let bestVol = -1;
    for (let d = 0; d < this.numDecks; d++) {
      const g = deckGroup(d + 1);
      if (this.bus.get(g, DeckKeys.play) <= 0.5) continue;
      const vol = this.bus.get(g, DeckKeys.volume);
      if (vol > bestVol) {
        bestVol = vol;
        best = d;
      }
    }
    return best >= 0 ? best : undefined;
  }

  dispose(): void {
    this.stop();
  }
}
