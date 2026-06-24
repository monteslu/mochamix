/**
 * DeckGraph — the renderer-side Web Audio node graph for one deck's channel
 * strip (the mixer portion of 04-audio-engine.md §3). The worklet produces the
 * deck's raw samples on one output; this graph applies EQ → volume → crossfader
 * gain, then sums into the master. Gains use AudioParam ramps so there's no
 * zipper noise (Mixxx ramps manually; Web Audio gives it to us).
 *
 * The control bus drives the param values; the renderer subscribes to control
 * changes and pushes them onto the AudioParams here.
 */

export interface DeckGraphNodes {
  /** Trim/pregain is applied in the worklet; this strip starts at EQ. */
  eqLow: BiquadFilterNode;
  eqMid: BiquadFilterNode;
  eqHigh: BiquadFilterNode;
  volume: GainNode;
  /** Crossfader contribution gain (driven by crossfader position + orientation). */
  crossfader: GainNode;
  /** QuickEffect insertion point (between EQ and volume). */
  quickFxIn: GainNode;
  /**
   * PFL gate: post-volume, pre-crossfader tap into the headphone bus. 0/1 driven
   * by the deck's `pfl` (cue) control — you monitor a deck regardless of the
   * crossfader position. Connect this to the headphone bus's pflIn.
   */
  pflGate: GainNode;
  /** The node to connect the worklet output into. */
  input: AudioNode;
  /** The node that feeds the master sum (post-crossfader). */
  output: AudioNode;
  /** The node that feeds the PFL/headphone bus (post-pflGate). */
  pflOutput: AudioNode;
}

/**
 * Build a deck channel strip. EQ is a 3-band shelving/peaking approximation using
 * BiquadFilterNodes (M3 will refine toward Mixxx's Bessel/Linkwitz-Riley via a
 * WASM/WGSL filter for exact parity — 10-electron-feasibility.md §2a). For M1 the
 * EQ nodes are present but flat (gain 0 dB) so the chain is in place.
 */
export function createDeckGraph(ctx: BaseAudioContext): DeckGraphNodes {
  const eqLow = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 246, gain: 0 });
  const eqMid = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 1000, Q: 0.7, gain: 0 });
  const eqHigh = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 2500, gain: 0 });
  const volume = new GainNode(ctx, { gain: 1 });
  const crossfader = new GainNode(ctx, { gain: 1 });
  // QuickEffect insertion point: a pass-through gain between EQ and volume. An
  // EffectUnit is spliced in here (eqHigh → quickFxIn → [unit] → volume).
  const quickFxIn = new GainNode(ctx, { gain: 1 });
  // PFL tap: post-volume, pre-crossfader. 0 until the deck's pfl/cue is on.
  const pflGate = new GainNode(ctx, { gain: 0 });

  // Chain: input → eqLow → eqMid → eqHigh → quickFxIn → volume → crossfader → output
  eqLow.connect(eqMid);
  eqMid.connect(eqHigh);
  eqHigh.connect(quickFxIn);
  quickFxIn.connect(volume); // default: no effect (direct)
  volume.connect(crossfader);
  volume.connect(pflGate); // parallel cue tap, independent of the crossfader

  return {
    eqLow,
    eqMid,
    eqHigh,
    volume,
    crossfader,
    quickFxIn,
    pflGate,
    input: eqLow,
    output: crossfader,
    pflOutput: pflGate,
  };
}

/**
 * Map an EQ knob value (0..1..4, where 1 == unity) to a dB gain for a shelf/peak
 * filter. Mixxx's EQ knobs go to full-kill at 0 and boost above unity. We use a
 * simple curve: unity (1.0) → 0 dB; 0 → -26 dB (near-kill); 4 → +12 dB.
 */
export function eqKnobToDb(value: number): number {
  if (value <= 1) {
    // 0 → -26 dB, 1 → 0 dB
    return (value - 1) * 26;
  }
  // 1 → 0 dB, 4 → +12 dB
  return ((value - 1) / 3) * 12;
}
