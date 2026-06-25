import { describe, it, expect, vi } from 'vitest';
import { EngineApi } from './engine-api.js';
import { computeMidiParameter, isRelative } from './midi-options.js';
import { ControlBus, standardControls, deck, DeckKeys, MASTER, MasterKeys } from '@internal-dj/control-bus';

function makeEngine() {
  const bus = new ControlBus();
  bus.defineAll(standardControls(2));
  const engine = new EngineApi({ bus });
  return { bus, engine };
}

describe('EngineApi — the Mixxx engine global', () => {
  it('getValue/setValue round-trip against the bus', () => {
    const { bus, engine } = makeEngine();
    engine.setValue('[Channel1]', 'play', 1);
    expect(engine.getValue('[Channel1]', 'play')).toBe(1);
    expect(bus.get('[Channel1]', 'play')).toBe(1);
  });

  it('getValue on an unknown control returns 0 (does not throw, like Mixxx)', () => {
    const { engine } = makeEngine();
    expect(engine.getValue('[Nope]', 'x')).toBe(0);
    expect(() => engine.setValue('[Nope]', 'x', 1)).not.toThrow();
  });

  it('getParameter/setParameter map onto [min,max]', () => {
    const { engine } = makeEngine();
    engine.setParameter(MASTER, MasterKeys.gain, 0.5); // gain range 0..5
    expect(engine.getValue(MASTER, MasterKeys.gain)).toBeCloseTo(2.5);
    expect(engine.getParameter(MASTER, MasterKeys.gain)).toBeCloseTo(0.5);
  });

  it('getDefaultValue / reset', () => {
    const { engine } = makeEngine();
    engine.setValue('[Channel1]', 'volume', 0.2);
    expect(engine.getDefaultValue('[Channel1]', 'volume')).toBe(1);
    engine.reset('[Channel1]', 'volume');
    expect(engine.getValue('[Channel1]', 'volume')).toBe(1);
  });

  it('makeConnection fires on change and disconnect stops it', () => {
    const { engine } = makeEngine();
    const cb = vi.fn();
    const conn = engine.makeConnection('[Channel1]', 'play', cb);
    engine.setValue('[Channel1]', 'play', 1);
    expect(cb).toHaveBeenCalledWith(1, '[Channel1]', 'play');
    expect(conn.disconnect()).toBe(true);
    engine.setValue('[Channel1]', 'play', 0);
    expect(cb).toHaveBeenCalledTimes(1);
    // double disconnect returns false
    expect(conn.disconnect()).toBe(false);
  });

  it('connection.trigger fires with the current value', () => {
    const { engine } = makeEngine();
    const cb = vi.fn();
    engine.setValue('[Channel1]', 'volume', 0.7);
    const conn = engine.makeConnection('[Channel1]', 'volume', cb);
    conn.trigger();
    expect(cb).toHaveBeenCalledWith(0.7, '[Channel1]', 'volume');
  });

  it('makeConnection on an invalid control returns a safe no-op handle', () => {
    const { engine } = makeEngine();
    const conn = engine.makeConnection('[Nope]', 'x', vi.fn());
    expect(conn.disconnect()).toBe(false);
    expect(() => conn.trigger()).not.toThrow();
  });

  it('timers fire and can be stopped (enforces 20ms min)', async () => {
    const { engine } = makeEngine();
    const cb = vi.fn();
    const id = engine.beginTimer(20, cb, true); // one-shot
    await new Promise((r) => setTimeout(r, 40));
    expect(cb).toHaveBeenCalledTimes(1);
    engine.stopTimer(id);
  });

  it('scratchEnable/isScratching/scratchDisable manage state + the scratch rate', () => {
    const { bus, engine } = makeEngine();
    expect(engine.isScratching(1)).toBe(false);
    engine.scratchEnable(1, 128, 33.33, 1 / 8, (1 / 8) / 32);
    expect(engine.isScratching(1)).toBe(true);
    expect(bus.get(deck(1), DeckKeys.scratching)).toBe(1);
    engine.scratchTick(1, 5);
    // forward ticks → positive scratch rate
    expect(bus.get(deck(1), DeckKeys.scratchRate)).toBeGreaterThan(0);
    engine.scratchDisable(1);
    expect(engine.isScratching(1)).toBe(false);
    expect(bus.get(deck(1), DeckKeys.scratching)).toBe(0);
    expect(bus.get(deck(1), DeckKeys.scratchRate)).toBe(0);
  });
});

describe('computeMidiParameter — MIDI value transforms', () => {
  it('absolute 0..127 → 0..1 parameter', () => {
    expect(computeMidiParameter(0, 0, {})).toBe(0);
    expect(computeMidiParameter(127, 0, {})).toBe(1);
    expect(computeMidiParameter(64, 0, {})).toBeCloseTo(0.504, 2);
  });

  it('invert flips absolute', () => {
    expect(computeMidiParameter(0, 0, { invert: true })).toBe(1);
    expect(computeMidiParameter(127, 0, { invert: true })).toBe(0);
  });

  it('button: nonzero → 1', () => {
    expect(computeMidiParameter(127, 0, { button: true })).toBe(1);
    expect(computeMidiParameter(0, 0, { button: true })).toBe(0);
  });

  it('diff relative: positive below 64, negative above, applied to prev', () => {
    // value 1 (small +), prev 0.5 → slightly up
    expect(computeMidiParameter(1, 0.5, { diff: true })).toBeGreaterThan(0.5);
    // value 127 (= -1 delta) → slightly down
    expect(computeMidiParameter(127, 0.5, { diff: true })).toBeLessThan(0.5);
  });

  it('rot64: around 64', () => {
    expect(computeMidiParameter(65, 0.5, { rot64: true })).toBeGreaterThan(0.5);
    expect(computeMidiParameter(63, 0.5, { rot64: true })).toBeLessThan(0.5);
  });

  it('isRelative classifies encoder modes', () => {
    expect(isRelative({ diff: true })).toBe(true);
    expect(isRelative({ rot64: true })).toBe(true);
    expect(isRelative({})).toBe(false);
    expect(isRelative({ button: true })).toBe(false);
  });
});
