/**
 * EffectUnit — a chain of effects with wet/dry mix + a metaknob (Mixxx
 * EngineEffectChain analog, 06-ui-controllers-effects.md §3). Built from native
 * Web Audio nodes; all DSP in the browser's C++. The unit can be inserted into a
 * deck's signal path (input node → unit → output node).
 *
 *   input ─┬─→ dryGain ──────────────┐
 *          └─→ [fx1 → fx2 → fx3] → wetGain ─┴→ output
 *
 * The metaknob fans out to each effect's linked parameters (metaknob.ts). Wet/dry
 * is the Mix knob. All control here is sparse/event-driven JS = fine.
 */

import { metaknobToParam } from './metaknob.js';
import { denormalize, type EffectInstance, type LinkType } from './effect-types.js';
import { getEffect } from './builtin-effects.js';

const MAX_SLOTS = 3; // Mixxx shows 3 by default

interface Slot {
  instance: EffectInstance | null;
  /** Per-param link override (defaults from the manifest). */
  links: Map<string, LinkType>;
  /** Manual (un-metaknob) param values, 0..1. */
  manual: Map<string, number>;
}

export class EffectUnit {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly dryGain: GainNode;
  private readonly wetGain: GainNode;
  private readonly chainIn: GainNode;
  private readonly chainOut: GainNode;
  private readonly slots: Slot[] = [];
  private meta = 0;
  private mix = 0; // 0 = dry, 1 = wet

  constructor(private readonly ctx: BaseAudioContext) {
    this.input = new GainNode(ctx, { gain: 1 });
    this.output = new GainNode(ctx, { gain: 1 });
    this.dryGain = new GainNode(ctx, { gain: 1 });
    this.wetGain = new GainNode(ctx, { gain: 0 });
    this.chainIn = new GainNode(ctx, { gain: 1 });
    this.chainOut = new GainNode(ctx, { gain: 1 });

    // dry path
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);
    // wet path: input → chainIn → [effects] → chainOut → wetGain → output
    this.input.connect(this.chainIn);
    this.chainIn.connect(this.chainOut); // pass-through until effects loaded
    this.chainOut.connect(this.wetGain);
    this.wetGain.connect(this.output);

    for (let i = 0; i < MAX_SLOTS; i++) {
      this.slots.push({ instance: null, links: new Map(), manual: new Map() });
    }
  }

  /** Load an effect by id into a slot (0..2), or null to clear. Rewires the chain. */
  loadEffect(slot: number, effectId: string | null): void {
    const s = this.slots[slot];
    if (!s) {
      return;
    }
    s.instance?.dispose();
    s.instance = null;
    s.links.clear();
    s.manual.clear();
    if (effectId) {
      const reg = getEffect(effectId);
      if (reg) {
        s.instance = reg.create(this.ctx);
        for (const p of reg.manifest.params) {
          s.links.set(p.key, p.default !== undefined ? p.defaultLink : 'none');
          s.manual.set(p.key, normalizedFromManifest(p.default, p.min, p.max));
        }
      }
    }
    this.rewire();
    this.applyMeta();
  }

  /** Reconnect the effect chain in series between chainIn and chainOut. */
  private rewire(): void {
    try {
      this.chainIn.disconnect();
    } catch {
      /* not connected */
    }
    const active = this.slots.map((s) => s.instance).filter((x): x is EffectInstance => x !== null);
    if (active.length === 0) {
      this.chainIn.connect(this.chainOut);
      return;
    }
    let node: AudioNode = this.chainIn;
    for (const fx of active) {
      node.connect(fx.input);
      node = fx.output;
    }
    node.connect(this.chainOut);
  }

  /** Set the wet/dry mix (0..1). Uses equal-power-ish gains. */
  setMix(mix: number): void {
    this.mix = Math.max(0, Math.min(1, mix));
    const t = this.ctx.currentTime;
    // equal-power crossfade dry↔wet
    this.dryGain.gain.setTargetAtTime(Math.cos((this.mix * Math.PI) / 2), t, 0.01);
    this.wetGain.gain.setTargetAtTime(Math.sin((this.mix * Math.PI) / 2), t, 0.01);
  }

  /** Set the metaknob (0..1); fans out to linked params. */
  setMeta(meta: number): void {
    this.meta = Math.max(0, Math.min(1, meta));
    this.applyMeta();
  }

  /** Set a parameter's link type. */
  setLink(slot: number, key: string, link: LinkType): void {
    this.slots[slot]?.links.set(key, link);
    this.applyMeta();
  }

  /** Set a manual parameter value (0..1); used when not linked to the metaknob. */
  setManualParam(slot: number, key: string, normalized: number): void {
    const s = this.slots[slot];
    if (!s?.instance) {
      return;
    }
    s.manual.set(key, normalized);
    this.applyMeta();
  }

  /** Set a manual param by INDEX (parameter1/2/3 → the 1st/2nd/3rd manifest param). A
   * no-op if the slot has no effect or fewer params. Used by EffectUnitControl. */
  setManualParamByIndex(slot: number, index: number, normalized: number): void {
    const s = this.slots[slot];
    const key = s?.instance?.manifest.params[index]?.key;
    if (key !== undefined) this.setManualParam(slot, key, normalized);
  }

  /** Recompute every effect param from the metaknob + links + manual values. */
  private applyMeta(): void {
    for (const s of this.slots) {
      if (!s.instance) {
        continue;
      }
      for (const p of s.instance.manifest.params) {
        const link = s.links.get(p.key) ?? 'none';
        const linked = metaknobToParam(this.meta, link, p);
        const normalized = linked ?? s.manual.get(p.key) ?? 0;
        s.instance.setParam(p.key, denormalize(normalized, p));
      }
    }
  }

  dispose(): void {
    for (const s of this.slots) {
      s.instance?.dispose();
    }
    this.input.disconnect();
    this.output.disconnect();
    this.dryGain.disconnect();
    this.wetGain.disconnect();
    this.chainIn.disconnect();
    this.chainOut.disconnect();
  }
}

function normalizedFromManifest(value: number, min: number, max: number): number {
  const span = max - min;
  return span === 0 ? 0 : (value - min) / span;
}
