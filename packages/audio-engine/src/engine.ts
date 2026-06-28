/**
 * Engine — the renderer-side audio engine controller (the main-thread half of
 * Mixxx's EngineMixer + PlayerManager, 03-architecture.md §4, 04-audio-engine.md
 * §1). It:
 *   - creates the AudioContext + loads the engine worklet
 *   - hands the worklet the control SAB + per-deck control indices
 *   - builds a Web Audio channel strip per deck (EQ/volume/crossfader)
 *   - subscribes to the control bus and pushes values onto AudioParams (UI side)
 *     and lets the worklet read the rest from the SAB (engine side)
 *   - loads decoded tracks into shared sample buffers for the worklet
 *
 * The control bus is the single source of truth; this class is glue between it,
 * the worklet, and the Web Audio graph.
 */

import {
  ControlBus,
  deck as deckGroup,
  DeckKeys,
  MASTER,
  MasterKeys,
  type RegisteredControl,
} from '@dj/control-bus';
import { createDeckGraph, eqKnobToDb, type DeckGraphNodes } from './deck-graph.js';
import { createMixBuses, type BusNodes } from './mix-buses.js';
import { AudioOutputRouter, type OutputDevice } from './audio-output.js';
import type { BusType } from './mix-buses.js';
import { crossfaderGainForChannel, orientationFromValue } from './crossfader.js';
import type { DeckControlIndices, EngineMessage, WorkletMessage } from './protocol.js';
import type { DecodedTrack } from './decoded-track.js';
import { CueControl } from './controls/cue-control.js';
import { LoopControl } from './controls/loop-control.js';
import { SmartFader } from './sync/smart-fader.js';
import { SyncController } from './sync/sync-controller.js';
import { makeGrid, nearestBeatFrame } from './sync/beatgrid.js';
import { EffectUnit } from './effects/effect-unit.js';

export interface EngineOptions {
  bus: ControlBus;
  numDecks: number;
  /** URL of the bundled engine worklet module (built by the app's bundler). */
  workletUrl: string | URL;
}

const RAMP = 0.012; // 12ms param ramp — matches Mixxx's anti-zipper gain ramping

function requireIndex(reg: RegisteredControl | undefined, what: string): number {
  if (!reg) {
    throw new Error(`Engine: control ${what} not registered (define standardControls first)`);
  }
  return reg.index;
}

export class Engine {
  private readonly bus: ControlBus;
  private readonly numDecks: number;
  private readonly workletUrl: string | URL;

  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private buses: BusNodes | null = null;
  private busesDispose: (() => void) | null = null;
  private router: AudioOutputRouter | null = null;
  private deckGraphs: DeckGraphNodes[] = [];
  private disconnects: Array<() => void> = [];
  private cueControls: CueControl[] = [];
  private loopControls: LoopControl[] = [];
  private smartFader: SmartFader | null = null;
  private syncController: SyncController | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private quickEffects: EffectUnit[] = [];

  constructor(opts: EngineOptions) {
    this.bus = opts.bus;
    this.numDecks = opts.numDecks;
    this.workletUrl = opts.workletUrl;
  }

  get audioContext(): AudioContext | null {
    return this.ctx;
  }

  /** Boot the audio graph. Must be called from a user gesture (autoplay policy). */
  async start(): Promise<void> {
    if (this.ctx) {
      return;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;

    await ctx.audioWorklet.addModule(this.workletUrl);

    // The engine node has one output per deck (each is stereo).
    const node = new AudioWorkletNode(ctx, 'dj-engine', {
      numberOfInputs: 0,
      numberOfOutputs: this.numDecks,
      outputChannelCount: new Array(this.numDecks).fill(2),
    });
    this.node = node;
    node.port.onmessage = (e: MessageEvent<WorkletMessage>) => this.onWorkletMessage(e.data);

    // Output buses (master / booth / headphone-PFL), following Mixxx's model:
    // one engine clock produces labeled bus outputs; the routing layer (the app)
    // sends each bus to a chosen device. By default master → ctx.destination.
    const { nodes: buses, dispose: busesDispose } = createMixBuses(ctx, this.bus);
    this.buses = buses;
    this.busesDispose = busesDispose;
    // The router owns all bus→device routing (master defaults to ctx.destination).
    this.router = new AudioOutputRouter(ctx, buses);
    void this.router.setDevice('master', 'default');

    // Build each deck strip: output (post-xfader) → masterIn, pflOutput → pflIn.
    const deckIndices: DeckControlIndices[] = [];
    for (let d = 0; d < this.numDecks; d++) {
      const g = createDeckGraph(ctx);
      node.connect(g.input, d, 0);
      g.output.connect(buses.masterIn);
      g.pflOutput.connect(buses.pflIn);
      this.deckGraphs.push(g);
      deckIndices.push(this.deckIndexMap(d));
      this.wireDeckParams(d, g);
      this.installDeckControls(d, ctx.sampleRate);
      this.installQuickEffect(d, ctx, deckGroup(d + 1));
    }

    // Publish the real AudioContext sample rate so the waveform grid math uses it
    // (not a hardcoded 48000) — wrong SR drifts the beat grid out of alignment.
    this.bus.set(MASTER, MasterKeys.sampleRate, ctx.sampleRate);

    // Beat sync: phase-lock on SYNC + publish beat distances. Created before the
    // Smart Fader so the latter can reuse its phase-align on activate.
    this.syncController = new SyncController({
      bus: this.bus,
      numDecks: this.numDecks,
      sampleRate: ctx.sampleRate,
      setRateRatio: (deckIndex, ratio) => this.setRateRatioOverride(deckIndex, ratio),
      positionFrames: (d) => this.positionFrames(d),
      trackFrames: (d) => this.bus.get(deckGroup(d + 1), DeckKeys.trackSamples),
      seekFrames: (d, frame) => this.seekFrames(d, frame),
    });

    // Smart Fader (our fork feature, 09): crossfader drives a tempo blend. On
    // activate it beat-aligns the right deck to the left via the SyncController.
    this.smartFader = new SmartFader({
      bus: this.bus,
      setRateRatio: (deckIndex, ratio) => this.setRateRatioOverride(deckIndex, ratio),
      // Ask the WORKLET to phase-snap deck 2 onto deck 1 (sample-accurate), the
      // same engine-side snap the SYNC button uses — NOT the old renderer seek.
      alignDecks: () => this.bus.set(deckGroup(2), DeckKeys.syncRequest, 1),
    });
    // Periodic phase hold + beat-distance publish (~60 Hz). Skipped while Smart
    // Fader is active (it owns the rate then).
    this.syncTimer = setInterval(() => {
      if (this.smartFader?.isActive()) return;
      this.syncController?.tick();
    }, 16);

    // Initialize the worklet with the control SAB + index maps.
    const sab = this.bus.sab;
    if (!sab) {
      throw new Error('Engine requires the ControlBus to have a SAB mirror enabled');
    }
    const init: EngineMessage = {
      type: 'init',
      controlBuffer: sab.buffer,
      controlCapacity: sab.capacity,
      numDecks: this.numDecks,
      deckIndices,
      sampleRate: ctx.sampleRate,
    };
    node.port.postMessage(init);

    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
  }

  /** Resolve the SAB index map the worklet needs for deck `d` (0-based). */
  private deckIndexMap(d: number): DeckControlIndices {
    const g = deckGroup(d + 1);
    const r = (key: string) => requireIndex(this.bus.registration(g, key), `${g},${key}`);
    return {
      play: r(DeckKeys.play),
      playPosition: r(DeckKeys.playPosition),
      // grid + sync so the worklet can phase-snap with its OWN exact position
      // (Mixxx does the snap in the realtime engine, not from a stale UI read).
      fileBpm: r(DeckKeys.fileBpm),
      firstBeatFrame: r(DeckKeys.firstBeatFrame),
      syncEnabled: r(DeckKeys.syncEnabled),
      syncRequest: r(DeckKeys.syncRequest),
      rate: r(DeckKeys.rate),
      rateRange: r(DeckKeys.rateRange),
      rateDirection: r(DeckKeys.rateDirection),
      rateRatio: r(DeckKeys.rateRatio),
      rateRatioOverride: r(DeckKeys.rateRatioOverride),
      scratching: r(DeckKeys.scratching),
      scratchRate: r(DeckKeys.scratchRate),
      quantize: r(DeckKeys.quantize),
      platterReleaseMode: r(DeckKeys.platterReleaseMode),
      keylock: r(DeckKeys.keylock),
      pregain: r(DeckKeys.pregain),
      volume: r(DeckKeys.volume),
      trackLoaded: r(DeckKeys.trackLoaded),
      trackSamples: r(DeckKeys.trackSamples),
      duration: r(DeckKeys.duration),
      vuMeter: r(DeckKeys.vuMeter),
      peakIndicator: r(DeckKeys.peakIndicator),
      stemGain0: r(DeckKeys.stemGain0),
      stemGain1: r(DeckKeys.stemGain1),
      stemGain2: r(DeckKeys.stemGain2),
      stemGain3: r(DeckKeys.stemGain3),
      pitch: r(DeckKeys.pitch),
      stemPitch0: r(DeckKeys.stemPitch0),
      stemPitch1: r(DeckKeys.stemPitch1),
      stemPitch2: r(DeckKeys.stemPitch2),
      stemPitch3: r(DeckKeys.stemPitch3),
      formantPreserve: r(DeckKeys.formantPreserve),
    };
  }

  /** Subscribe to a deck's UI-side controls and push them onto AudioParams. */
  private wireDeckParams(d: number, g: DeckGraphNodes): void {
    const grp = deckGroup(d + 1);
    const setParam = (param: AudioParam, value: number) => {
      const t = this.ctx!.currentTime;
      param.setTargetAtTime(value, t, RAMP / 3);
    };

    // volume
    setParam(g.volume.gain, this.bus.get(grp, DeckKeys.volume));
    this.disconnects.push(
      this.bus.connect(grp, DeckKeys.volume, (v) => setParam(g.volume.gain, v)),
    );

    // EQ bands (knob 0..1..4 → dB)
    const eqBands: Array<[string, BiquadFilterNode]> = [
      [DeckKeys.eqLow, g.eqLow],
      [DeckKeys.eqMid, g.eqMid],
      [DeckKeys.eqHigh, g.eqHigh],
    ];
    for (const [key, filter] of eqBands) {
      filter.gain.value = eqKnobToDb(this.bus.get(grp, key));
      this.disconnects.push(
        this.bus.connect(grp, key, (v) => setParam(filter.gain, eqKnobToDb(v))),
      );
    }

    // crossfader: recompute this deck's contribution gain whenever crossfader,
    // curve, reverse, or this deck's orientation changes.
    const recomputeXfader = () => {
      const orientation = orientationFromValue(this.bus.get(grp, DeckKeys.orientation));
      const gain = crossfaderGainForChannel(
        orientation,
        this.bus.get(MASTER, MasterKeys.crossfader),
        this.bus.get(MASTER, MasterKeys.crossfaderCurve),
        this.bus.get(MASTER, MasterKeys.crossfaderReverse) > 0.5,
      );
      setParam(g.crossfader.gain, gain);
    };
    recomputeXfader();
    for (const [grp2, key] of [
      [MASTER, MasterKeys.crossfader],
      [MASTER, MasterKeys.crossfaderCurve],
      [MASTER, MasterKeys.crossfaderReverse],
      [grp, DeckKeys.orientation],
    ] as const) {
      this.disconnects.push(this.bus.connect(grp2, key, recomputeXfader));
    }

    // PFL gate: 0/1 from the deck's pfl (cue) control → headphone bus.
    const setPfl = (v: number) => setParam(g.pflGate.gain, v > 0.5 ? 1 : 0);
    setPfl(this.bus.get(grp, DeckKeys.pfl));
    this.disconnects.push(this.bus.connect(grp, DeckKeys.pfl, setPfl));
  }

  /** The output bus nodes, for the multi-device routing layer. Null until started. */
  getBuses(): BusNodes | null {
    return this.buses;
  }

  /** List available output devices (for the routing UI). */
  async listOutputDevices(): Promise<OutputDevice[]> {
    return AudioOutputRouter.listOutputs();
  }

  /** Route a bus (master/booth/headphone) to a device id ('default' = ctx device). */
  async setOutputDevice(bus: BusType, deviceId: string): Promise<void> {
    await this.router?.setDevice(bus, deviceId);
  }

  /** The device currently assigned to a bus. */
  getOutputDevice(bus: BusType): string {
    return this.router?.getDevice(bus) ?? 'default';
  }

  /** Current play position of a deck in source frames (from the bus). */
  private positionFrames(d: number): number {
    const g = deckGroup(d + 1);
    return this.bus.get(g, DeckKeys.playPosition) * this.bus.get(g, DeckKeys.trackSamples);
  }

  /**
   * Snap a frame to the deck's beat grid when quantize is on for that deck.
   * Returns the frame unchanged if quantize is off or there's no valid grid.
   */
  private quantizeFrame(d: number, frame: number): number {
    const g = deckGroup(d + 1);
    if (this.bus.get(g, DeckKeys.quantize) <= 0.5) {
      return frame;
    }
    const bpm = this.bus.get(g, DeckKeys.fileBpm);
    const fbf = this.bus.get(g, DeckKeys.firstBeatFrame);
    const grid = makeGrid(bpm, fbf >= 0 ? fbf : 0, this.audioContext?.sampleRate ?? 48000);
    return grid ? nearestBeatFrame(grid, frame) : frame;
  }

  /** Seek a deck to an absolute source frame (and reflect it on the bus). */
  private seekFrames(d: number, frame: number): void {
    if (!this.node) {
      return;
    }
    this.node.port.postMessage({ type: 'seek', deck: d, frame } satisfies EngineMessage);
    const g = deckGroup(d + 1);
    const frames = this.bus.get(g, DeckKeys.trackSamples);
    if (frames > 0) {
      this.bus.set(g, DeckKeys.playPosition, frame / frames);
    }
  }

  /**
   * Set a deck's direct rate-ratio override (used by sync / smart fader to reach
   * ratios beyond the slider range). A ratio of exactly 1.0 releases the override
   * back to slider control.
   */
  private setRateRatioOverride(deckIndex: number, ratio: number): void {
    const g = deckGroup(deckIndex + 1);
    this.bus.set(g, DeckKeys.rateRatioOverride, ratio === 1 ? 0 : ratio);
  }

  /**
   * Install the per-deck QuickEffect (default Filter). The unit sits between the
   * EQ and the volume fader; when enabled it's spliced into the graph and the
   * super knob drives its metaknob (the Filter trick: one knob = LPF↔HPF).
   */
  private installQuickEffect(d: number, ctx: AudioContext, g: string): void {
    const graph = this.deckGraphs[d]!;
    const unit = new EffectUnit(ctx);
    unit.loadEffect(0, 'filter');
    unit.setMix(1); // QuickEffect is fully wet (it's an insert)
    this.quickEffects[d] = unit;

    const setEnabled = (on: boolean) => {
      try {
        graph.quickFxIn.disconnect();
      } catch {
        /* not connected */
      }
      if (on) {
        graph.quickFxIn.connect(unit.input);
        unit.output.connect(graph.volume);
      } else {
        graph.quickFxIn.connect(graph.volume); // bypass
      }
    };

    // Initial state from the (persisted) controls.
    unit.setMeta(this.bus.get(g, DeckKeys.quickEffectSuper));
    setEnabled(this.bus.get(g, DeckKeys.quickEffectEnabled) > 0.5);

    this.disconnects.push(
      this.bus.connect(g, DeckKeys.quickEffectSuper, (v) => unit.setMeta(v)),
      this.bus.connect(g, DeckKeys.quickEffectEnabled, (v) => setEnabled(v > 0.5)),
    );
  }

  /** Install the per-deck EngineControl stack (cue + loop). */
  private installDeckControls(d: number, sampleRate: number): void {
    const g = deckGroup(d + 1);
    const node = this.node!;
    const cue = new CueControl({
      bus: this.bus,
      group: g,
      positionFrames: () => this.positionFrames(d),
      seekFrames: (frame) => this.seekFrames(d, frame),
      stop: () => this.bus.set(g, DeckKeys.play, 0),
      play: () => this.bus.set(g, DeckKeys.play, 1),
      isPlaying: () => this.bus.get(g, DeckKeys.play) > 0.5,
      isScratching: () => this.bus.get(g, DeckKeys.scratching) > 0.5,
      quantize: (frame) => this.quantizeFrame(d, frame),
    });
    const loop = new LoopControl({
      bus: this.bus,
      group: g,
      sampleRate,
      positionFrames: () => this.positionFrames(d),
      trackFrames: () => this.bus.get(g, DeckKeys.trackSamples),
      applyLoop: (start, end, enabled) =>
        node.port.postMessage({
          type: 'setLoop',
          deck: d,
          start,
          end,
          enabled,
        } satisfies EngineMessage),
      enableLoop: (enabled) =>
        node.port.postMessage({ type: 'loopEnable', deck: d, enabled } satisfies EngineMessage),
      quantize: (frame) => this.quantizeFrame(d, frame),
    });
    this.cueControls.push(cue);
    this.loopControls.push(loop);
  }

  /** Load a decoded track into a deck (ships sample data to the worklet via SAB). */
  loadTrack(d: number, track: DecodedTrack): void {
    if (!this.node) {
      throw new Error('Engine not started');
    }
    const msg: EngineMessage = {
      type: 'loadTrack',
      deck: d,
      sampleBuffer: track.sampleBuffer,
      channels: track.channels,
      frames: track.frames,
      trackSampleRate: track.sampleRate,
    };
    this.node.port.postMessage(msg);
    // Reflect file-derived controls on the bus (UI reads these).
    const g = deckGroup(d + 1);
    this.bus.set(g, DeckKeys.duration, track.frames / track.sampleRate);
    this.bus.set(g, DeckKeys.trackSamples, track.frames);
    this.bus.set(g, DeckKeys.trackLoaded, 1);
    // Default the cue point to the track start so CUE always has a target (CDJ
    // behavior). A user CUE-set while stopped overrides it.
    this.bus.set(g, DeckKeys.cuePoint, 0);
    this.bus.set(g, DeckKeys.playPosition, 0);
    if (track.bpm) {
      this.bus.set(g, DeckKeys.fileBpm, track.bpm);
    }
  }

  /**
   * Load 4 stems onto a deck as a stem deck (independently mixable for mashups).
   * `stems` are the decoded drums/bass/other/vocals in NI-Stems order; `meta` carries
   * the original track's bpm/grid (the stems share it).
   */
  loadStems(d: number, stems: DecodedTrack[], meta?: { bpm?: number }): void {
    if (!this.node) {
      throw new Error('Engine not started');
    }
    if (stems.length === 0) return;
    const first = stems[0]!;
    const msg: EngineMessage = {
      type: 'loadStems',
      deck: d,
      stems: stems.map((s) => ({
        sampleBuffer: s.sampleBuffer,
        channels: s.channels,
        frames: s.frames,
      })),
      trackSampleRate: first.sampleRate,
    };
    this.node.port.postMessage(msg);
    const g = deckGroup(d + 1);
    this.bus.set(g, DeckKeys.duration, first.frames / first.sampleRate);
    this.bus.set(g, DeckKeys.trackSamples, first.frames);
    this.bus.set(g, DeckKeys.trackLoaded, 1);
    this.bus.set(g, DeckKeys.hasStems, 1);
    this.bus.set(g, DeckKeys.cuePoint, 0);
    this.bus.set(g, DeckKeys.playPosition, 0);
    // reset stem gains to full on load
    this.bus.set(g, DeckKeys.stemGain0, 1);
    this.bus.set(g, DeckKeys.stemGain1, 1);
    this.bus.set(g, DeckKeys.stemGain2, 1);
    this.bus.set(g, DeckKeys.stemGain3, 1);
    if (meta?.bpm) this.bus.set(g, DeckKeys.fileBpm, meta.bpm);
  }

  /** Eject a deck. */
  eject(d: number): void {
    this.node?.port.postMessage({ type: 'eject', deck: d } satisfies EngineMessage);
    const g = deckGroup(d + 1);
    this.bus.set(g, DeckKeys.play, 0);
    this.bus.set(g, DeckKeys.trackLoaded, 0);
    this.bus.set(g, DeckKeys.hasStems, 0);
  }

  /** Seek a deck to a 0..1 fraction. */
  seekFraction(d: number, fraction: number): void {
    if (!this.node) {
      return;
    }
    const frames = this.bus.get(deckGroup(d + 1), DeckKeys.trackSamples);
    this.node.port.postMessage({
      type: 'seek',
      deck: d,
      frame: fraction * frames,
    } satisfies EngineMessage);
  }

  private onWorkletMessage(msg: WorkletMessage): void {
    if (msg.type === 'trackEnded') {
      // The worklet already set play=0 in the SAB; reflect it on the bus so the UI updates.
      this.bus.set(deckGroup(msg.deck + 1), DeckKeys.play, 0);
    }
  }

  async dispose(): Promise<void> {
    for (const off of this.disconnects) {
      off();
    }
    for (const c of this.cueControls) {
      c.dispose();
    }
    for (const l of this.loopControls) {
      l.dispose();
    }
    this.smartFader?.dispose();
    this.smartFader = null;
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.syncController?.dispose();
    this.syncController = null;
    for (const fx of this.quickEffects) {
      fx.dispose();
    }
    this.quickEffects = [];
    this.cueControls = [];
    this.loopControls = [];
    this.disconnects = [];
    this.deckGraphs = [];
    this.router?.dispose();
    this.router = null;
    this.busesDispose?.();
    this.busesDispose = null;
    this.buses = null;
    this.node?.port.close();
    this.node = null;
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
    }
  }
}
