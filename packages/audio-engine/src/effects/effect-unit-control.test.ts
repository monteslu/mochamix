import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ControlBus,
  standardControls,
  effectUnit,
  effectSlot,
  EffectUnitKeys,
  EffectKeys,
} from '@dj/control-bus';
import { EffectUnitControl } from './effect-unit-control.js';

// Effect unit bus wiring: super1 (the big FX knob) → metaknob, mix → wet/dry, per-slot
// enabled/param/effect-select → the EffectUnit. 60+ mappings drive these; without this
// the FX section of every controller is dead. Uses a fake EffectUnit (no Web Audio).

function fakeFx() {
  return {
    setMeta: vi.fn(),
    setMix: vi.fn(),
    loadEffect: vi.fn(),
    setManualParamByIndex: vi.fn(),
  };
}

function setup() {
  const bus = new ControlBus();
  for (const c of standardControls(2)) bus.define(c);
  const fx = fakeFx();
  const ctl = new EffectUnitControl({ bus, unit: 1, fx: fx as never });
  return { bus, fx, ctl, ug: effectUnit(1), sg: (s: number) => effectSlot(1, s) };
}

describe('EffectUnitControl', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('super1 drives the unit metaknob', () => {
    s.bus.set(s.ug, EffectUnitKeys.super1, 0.7);
    expect(s.fx.setMeta).toHaveBeenLastCalledWith(0.7);
  });

  it('mix drives wet/dry', () => {
    s.bus.set(s.ug, EffectUnitKeys.mix, 0.5);
    expect(s.fx.setMix).toHaveBeenLastCalledWith(0.5);
  });

  it('enabling a slot loads its effect; disabling unloads it', () => {
    s.fx.loadEffect.mockClear();
    s.bus.set(s.sg(2), EffectKeys.enabled, 1);
    expect(s.fx.loadEffect).toHaveBeenLastCalledWith(1, expect.any(String)); // slot index 1
    s.bus.set(s.sg(2), EffectKeys.enabled, 0);
    expect(s.fx.loadEffect).toHaveBeenLastCalledWith(1, null);
  });

  it('parameter1/2/3 set manual params by index', () => {
    s.bus.set(s.sg(1), EffectKeys.param1, 0.25);
    expect(s.fx.setManualParamByIndex).toHaveBeenLastCalledWith(0, 0, 0.25);
    s.bus.set(s.sg(1), EffectKeys.param3, 0.9);
    expect(s.fx.setManualParamByIndex).toHaveBeenLastCalledWith(0, 2, 0.9);
  });

  it('effect_selector cycles the loaded effect on an enabled slot (and self-resets)', () => {
    s.bus.set(s.sg(1), EffectKeys.enabled, 1); // slot 1 enabled (loads catalog[0])
    s.fx.loadEffect.mockClear();
    s.bus.set(s.sg(1), EffectKeys.effectSelector, 1); // next effect
    expect(s.fx.loadEffect).toHaveBeenCalledWith(0, expect.any(String));
    expect(s.bus.get(s.sg(1), EffectKeys.effectSelector)).toBe(0); // pulse reset
  });

  it('dispose stops reacting', () => {
    s.ctl.dispose();
    s.fx.setMeta.mockClear();
    s.bus.set(s.ug, EffectUnitKeys.super1, 0.3);
    expect(s.fx.setMeta).not.toHaveBeenCalled();
  });
});
