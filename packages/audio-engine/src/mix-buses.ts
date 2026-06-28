/**
 * MixBuses — the master / booth / headphone(PFL) output buses (Mixxx
 * EngineMixer bus model, 04-audio-engine.md §3: m_main / m_booth / m_head).
 * Following Mixxx's proven lead: ONE engine clock produces several labeled bus
 * outputs; a routing layer (audio-output.ts) then sends each bus to a chosen
 * device. The engine does not know about devices.
 *
 * Each deck strip feeds TWO points:
 *   - the crossfader (→ master), as today
 *   - the PFL bus (pre-fader tap), gated by the deck's `pfl` control
 *
 * Buses (Web Audio GainNodes, all native — no JS DSP):
 *   master  = sum of deck crossfader outputs        → master gain
 *   booth   = same master signal                    → booth gain (independent)
 *   head    = headphone monitor = mix(master, PFL) per headMix + headphone gain
 */

import { MASTER, MasterKeys, type ControlBus } from '@dj/control-bus';

export type BusType = 'master' | 'booth' | 'headphone';

export interface BusNodes {
  /** Decks connect their post-crossfader signal here (the main mix sum). */
  masterIn: GainNode;
  /** Decks connect their pre-fader PFL tap here (gated by pfl). */
  pflIn: GainNode;
  /** Final per-bus output nodes — what the routing layer connects to a device. */
  master: GainNode;
  booth: GainNode;
  headphone: GainNode;
}

const RAMP = 0.012;

/**
 * Headphone-mix gains: equal-power crossfade between the main mix and the PFL/cue
 * mix. `mix` ∈ [-1, 1] (Mixxx headMix): -1 = full main, +1 = full PFL. Pure +
 * testable.
 */
export function headMixGains(mix: number): { main: number; pfl: number } {
  const t = (Math.max(-1, Math.min(1, mix)) + 1) / 2; // 0 = main, 1 = pfl
  return { main: Math.cos((t * Math.PI) / 2), pfl: Math.sin((t * Math.PI) / 2) };
}

/**
 * Build the bus graph for a context. Returns the bus output nodes + the input
 * nodes decks connect to. Subscribes to the master/booth/head gain + headMix
 * controls and drives them.
 */
export function createMixBuses(ctx: BaseAudioContext, bus: ControlBus): {
  nodes: BusNodes;
  dispose: () => void;
} {
  const masterIn = new GainNode(ctx, { gain: 1 });
  const pflIn = new GainNode(ctx, { gain: 1 });

  // Master bus.
  const master = new GainNode(ctx, { gain: bus.get(MASTER, MasterKeys.gain) });
  masterIn.connect(master);

  // Booth bus: the master mix at an independent gain.
  const booth = new GainNode(ctx, { gain: bus.get(MASTER, MasterKeys.boothGain) });
  masterIn.connect(booth);

  // Headphone bus: headMix crossfades master vs PFL, then the headphone gain.
  // headMix ∈ [-1, 1]: -1 = full main, +1 = full PFL (Mixxx convention).
  const headMasterGain = new GainNode(ctx, { gain: 0 });
  const headPflGain = new GainNode(ctx, { gain: 1 });
  const headphone = new GainNode(ctx, { gain: bus.get(MASTER, MasterKeys.headGain) });
  masterIn.connect(headMasterGain).connect(headphone);
  pflIn.connect(headPflGain).connect(headphone);

  const now = () => ctx.currentTime;
  const setHeadMix = (mix: number) => {
    const { main, pfl } = headMixGains(mix);
    headMasterGain.gain.setTargetAtTime(main, now(), RAMP / 3);
    headPflGain.gain.setTargetAtTime(pfl, now(), RAMP / 3);
  };
  setHeadMix(bus.get(MASTER, MasterKeys.headMix));

  const offs = [
    bus.connect(MASTER, MasterKeys.gain, (v) =>
      master.gain.setTargetAtTime(v, now(), RAMP / 3),
    ),
    bus.connect(MASTER, MasterKeys.boothGain, (v) =>
      booth.gain.setTargetAtTime(v, now(), RAMP / 3),
    ),
    bus.connect(MASTER, MasterKeys.headGain, (v) =>
      headphone.gain.setTargetAtTime(v, now(), RAMP / 3),
    ),
    // headVolume is Mixxx's alias for headGain — drive the same headphone gain.
    bus.connect(MASTER, MasterKeys.headVolume, (v) =>
      headphone.gain.setTargetAtTime(v, now(), RAMP / 3),
    ),
    bus.connect(MASTER, MasterKeys.headMix, setHeadMix),
  ];

  return {
    nodes: { masterIn, pflIn, master, booth, headphone },
    dispose: () => {
      for (const off of offs) off();
      for (const n of [masterIn, pflIn, master, booth, headphone, headMasterGain, headPflGain]) {
        n.disconnect();
      }
    },
  };
}
