/**
 * EffectUnitControl — bus-wires one effect UNIT ([EffectRack1_EffectUnitN]) + its effect
 * SLOTS to an EffectUnit audio node, so the FX controls 60+ Mixxx mappings drive become
 * live: super1 (the unit metaknob), mix (wet/dry), enabled, and per-slot enabled/meta/
 * parameter1-3 + effect selection. Per-deck routing (group_[ChannelN]_enable) is handled
 * by the engine (it owns the audio graph); this class owns the parameter/state plumbing.
 *
 * The metaknob → linked-params fan-out lives in EffectUnit/metaknob; here we just forward
 * the bus values. Pure bus + EffectUnit (no Web Audio graph surgery) → unit-testable.
 */

import {
  effectUnit,
  effectSlot,
  EffectUnitKeys,
  EffectKeys,
  EFFECT_SLOTS_PER_UNIT,
  type ControlBus,
} from '@dj/control-bus';
import type { EffectUnit } from './effect-unit.js';

/** Selectable effects per slot (effect_selector cycles these). Must be registered IDs
 * in builtin-effects. (`flanger` isn't built in yet → distortion stands in for now.) */
const EFFECT_CATALOG = ['filter', 'echo', 'reverb', 'distortion', 'bitcrusher'];

export interface EffectUnitControlDeps {
  bus: ControlBus;
  /** 1-based unit number. */
  unit: number;
  /** The audio EffectUnit this drives. */
  fx: EffectUnit;
}

export class EffectUnitControl {
  private readonly offs: Array<() => void> = [];
  private readonly slotEffect: number[] = []; // current catalog index per slot

  constructor(private readonly deps: EffectUnitControlDeps) {
    const { bus, fx, unit } = deps;
    const ug = effectUnit(unit);

    // Unit metaknob + wet/dry. super1 IS the big FX knob on controllers.
    fx.setMeta(bus.get(ug, EffectUnitKeys.super1));
    fx.setMix(bus.get(ug, EffectUnitKeys.mix));
    this.offs.push(bus.connect(ug, EffectUnitKeys.super1, (v) => fx.setMeta(v)));
    this.offs.push(bus.connect(ug, EffectUnitKeys.mix, (v) => fx.setMix(v)));

    // Per-slot: enabled, manual params, effect selection.
    for (let s = 1; s <= EFFECT_SLOTS_PER_UNIT; s++) {
      const sg = effectSlot(unit, s);
      const slotIdx = s - 1;
      this.slotEffect[slotIdx] = 0;

      // Load the default effect for an enabled slot.
      if (bus.get(sg, EffectKeys.enabled) > 0.5) {
        fx.loadEffect(slotIdx, EFFECT_CATALOG[0]!);
      }
      this.offs.push(
        bus.connect(sg, EffectKeys.enabled, (v) => {
          fx.loadEffect(slotIdx, v > 0.5 ? EFFECT_CATALOG[this.slotEffect[slotIdx]!]! : null);
        }),
      );
      // Manual parameter values (used when not metaknob-linked).
      this.offs.push(bus.connect(sg, EffectKeys.param1, (v) => fx.setManualParamByIndex(slotIdx, 0, v)));
      this.offs.push(bus.connect(sg, EffectKeys.param2, (v) => fx.setManualParamByIndex(slotIdx, 1, v)));
      this.offs.push(bus.connect(sg, EffectKeys.param3, (v) => fx.setManualParamByIndex(slotIdx, 2, v)));
      // effect_selector: cycle the loaded effect (pulse, signed). next_effect = +1.
      this.offs.push(
        bus.connect(sg, EffectKeys.effectSelector, (v) => {
          if (v !== 0) {
            this.cycleEffect(slotIdx, v > 0 || v > 64 ? 1 : -1);
            bus.set(sg, EffectKeys.effectSelector, 0);
          }
        }),
      );
      this.offs.push(
        bus.connect(sg, EffectKeys.nextEffect, (v) => {
          if (v > 0.5) {
            this.cycleEffect(slotIdx, 1);
            bus.set(sg, EffectKeys.nextEffect, 0);
          }
        }),
      );
    }
  }

  private cycleEffect(slotIdx: number, dir: number): void {
    const n = EFFECT_CATALOG.length;
    this.slotEffect[slotIdx] = (this.slotEffect[slotIdx]! + dir + n) % n;
    const sg = effectSlot(this.deps.unit, slotIdx + 1);
    if (this.deps.bus.get(sg, EffectKeys.enabled) > 0.5) {
      this.deps.fx.loadEffect(slotIdx, EFFECT_CATALOG[this.slotEffect[slotIdx]!]!);
    }
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
  }
}
