import { describe, it, expect, vi } from 'vitest';
import { ControlBus } from './bus.js';
import { controlId, parseControlId } from './types.js';
import { deck, DeckKeys, MASTER, MasterKeys } from './keys.js';
import { standardControls } from './standard-controls.js';
import { wrapSab, sabRead } from './sab.js';

describe('ControlId', () => {
  it('round-trips group/key, splitting on the first comma', () => {
    expect(controlId('[Channel1]', 'play')).toBe('[Channel1],play');
    expect(parseControlId('[Channel1],play')).toEqual({ group: '[Channel1]', key: 'play' });
    // a key containing a comma stays intact (split on FIRST comma only)
    expect(parseControlId('[X],a,b' as never)).toEqual({ group: '[X]', key: 'a,b' });
  });

  it('throws on a malformed id', () => {
    expect(() => parseControlId('noComma' as never)).toThrow();
  });
});

describe('ControlBus get/set', () => {
  it('defines, reads the default, and sets values', () => {
    const bus = new ControlBus();
    bus.define({ group: '[Channel1]', key: 'play', default: 0 });
    expect(bus.get('[Channel1]', 'play')).toBe(0);
    bus.set('[Channel1]', 'play', 1);
    expect(bus.get('[Channel1]', 'play')).toBe(1);
  });

  it('throws on unknown controls', () => {
    const bus = new ControlBus();
    expect(() => bus.get('[Nope]', 'x')).toThrow(/unknown control/);
    expect(() => bus.set('[Nope]', 'x', 1)).toThrow(/unknown control/);
  });

  it('does not emit on a no-op set (bIgnoreNops)', () => {
    const bus = new ControlBus();
    bus.define({ group: '[Channel1]', key: 'volume', default: 1 });
    const listener = vi.fn();
    bus.connect('[Channel1]', 'volume', listener);
    bus.set('[Channel1]', 'volume', 1); // same as default → no emit
    expect(listener).not.toHaveBeenCalled();
    bus.set('[Channel1]', 'volume', 0.5);
    expect(listener).toHaveBeenCalledExactlyOnceWith(0.5, '[Channel1],volume');
  });

  it('define() is idempotent and keeps the first registration', () => {
    const bus = new ControlBus();
    const a = bus.define({ group: '[Channel1]', key: 'play', default: 0 });
    bus.set('[Channel1]', 'play', 1);
    const b = bus.define({ group: '[Channel1]', key: 'play', default: 0 });
    expect(b).toBe(a);
    expect(bus.get('[Channel1]', 'play')).toBe(1); // not reset by re-define
  });
});

describe('ControlBus parameter mapping', () => {
  it('maps normalized 0..1 onto [min,max] and back', () => {
    const bus = new ControlBus();
    bus.define({ group: MASTER, key: 'gain', default: 1, min: 0, max: 5 });
    bus.setParameter(MASTER, 'gain', 0.5);
    expect(bus.get(MASTER, 'gain')).toBeCloseTo(2.5);
    expect(bus.getParameter(MASTER, 'gain')).toBeCloseTo(0.5);
  });

  it('clamps parameter to 0..1', () => {
    const bus = new ControlBus();
    bus.define({ group: MASTER, key: 'crossfader', default: 0, min: -1, max: 1 });
    bus.setParameter(MASTER, 'crossfader', 2);
    expect(bus.get(MASTER, 'crossfader')).toBe(1);
    bus.setParameter(MASTER, 'crossfader', -2);
    expect(bus.get(MASTER, 'crossfader')).toBe(-1);
  });
});

describe('ControlBus pub/sub', () => {
  it('connect/disconnect and trigger', () => {
    const bus = new ControlBus();
    bus.define({ group: '[Channel1]', key: 'play', default: 0 });
    const listener = vi.fn();
    const off = bus.connect('[Channel1]', 'play', listener);
    bus.set('[Channel1]', 'play', 1);
    expect(listener).toHaveBeenCalledTimes(1);
    bus.trigger('[Channel1]', 'play'); // force-fire current value
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    bus.set('[Channel1]', 'play', 0);
    expect(listener).toHaveBeenCalledTimes(2); // no more after disconnect
  });
});

describe('ControlBus persistence', () => {
  it('restores persisted values and calls onPersist on change', () => {
    const saved: Record<string, number> = {};
    const bus = new ControlBus({
      persistedValues: { '[Channel1],keylock': 1 },
      onPersist: (id, v) => {
        saved[id] = v;
      },
    });
    bus.define({ group: '[Channel1]', key: 'keylock', default: 0, persist: true });
    expect(bus.get('[Channel1]', 'keylock')).toBe(1); // restored, not default
    bus.set('[Channel1]', 'keylock', 0);
    expect(saved['[Channel1],keylock']).toBe(0);
  });

  it('does not persist non-persist controls', () => {
    const saved: Record<string, number> = {};
    const bus = new ControlBus({ onPersist: (id, v) => (saved[id] = v) });
    bus.define({ group: '[Channel1]', key: 'play', default: 0 });
    bus.set('[Channel1]', 'play', 1);
    expect(saved).toEqual({});
  });
});

describe('ControlBus SAB mirror', () => {
  it('writes values into the SAB by control index, readable via a separate view', () => {
    const bus = new ControlBus({ sab: { capacity: 64 } });
    const reg = bus.define({ group: '[Channel1]', key: 'volume', default: 1 });
    // A consumer (e.g. worklet) wraps the same buffer.
    const view = wrapSab(bus.sab!.buffer, bus.sab!.capacity);
    expect(sabRead(view, reg.index)).toBe(1);
    bus.set('[Channel1]', 'volume', 0.25);
    expect(sabRead(view, reg.index)).toBe(0.25);
  });

  it('throws when exceeding SAB capacity', () => {
    const bus = new ControlBus({ sab: { capacity: 1 } });
    bus.define({ group: '[A]', key: 'x', default: 0 });
    expect(() => bus.define({ group: '[A]', key: 'y', default: 0 })).toThrow(/capacity/);
  });
});

describe('standardControls', () => {
  it('defines a consistent surface for N decks', () => {
    const bus = new ControlBus({ sab: { capacity: 1024 } });
    bus.defineAll(standardControls(4));
    // sanity: deck + master controls exist with expected defaults
    expect(bus.get(deck(1), DeckKeys.volume)).toBe(1);
    expect(bus.get(deck(4), DeckKeys.keylock)).toBe(0);
    expect(bus.get(MASTER, MasterKeys.crossfader)).toBe(0);
    expect(bus.get(MASTER, MasterKeys.smartFaderEnabled)).toBe(0);
    // every registered control got a unique, dense index
    const indices = bus.registry().map((r) => r.index);
    expect(new Set(indices).size).toBe(indices.length);
    expect(Math.max(...indices)).toBe(indices.length - 1);
  });
});
