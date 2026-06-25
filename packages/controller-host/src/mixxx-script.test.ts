/**
 * Proof-of-concept: a Mixxx-mapping-STYLE script (the kind midi-components-0.0.js
 * and hand-written mappings produce) talking ONLY to the `engine` global, run
 * against our EngineApi. If this works, the reuse strategy (10 §6) holds: real
 * Mixxx mappings run unchanged given the same `engine` contract.
 *
 * We don't vendor the real midi-components here (that's an app-level git subtree),
 * but we exercise the exact API surface those components use.
 */

import { describe, it, expect, vi } from 'vitest';
import { EngineApi } from './engine-api.js';
import { ControlBus, standardControls } from '@dj/control-bus';

function makeEngine() {
  const bus = new ControlBus();
  bus.defineAll(standardControls(2));
  return { bus, engine: new EngineApi({ bus }) };
}

describe('Mixxx-style mapping script against the engine global', () => {
  it('a PlayButton component toggles play and lights its LED via a connection', () => {
    const { engine } = makeEngine();
    const sentMidi: Array<[number, number, number]> = [];
    const midiSend = (status: number, b1: number, b2: number) =>
      sentMidi.push([status, b1, b2]);

    // --- The kind of code midi-components' PlayButton + a mapping writes ---
    const group = '[Channel1]';

    // output: LED follows [Channel1],play
    engine.makeConnection(group, 'play', (value) => {
      midiSend(0x90, 0x0b, value ? 0x7f : 0x00); // note-on, play pad, lit/unlit
    });

    // input handler (what an XML <control> script-binding calls):
    function onPlayPress(_channel: number, _control: number, value: number) {
      if (value > 0) {
        // toggle
        const cur = engine.getValue(group, 'play');
        engine.setValue(group, 'play', cur > 0 ? 0 : 1);
      }
    }

    // Simulate a hardware press → release.
    onPlayPress(0, 0x0b, 0x7f);
    expect(engine.getValue(group, 'play')).toBe(1);
    // LED connection should have fired lit
    expect(sentMidi.at(-1)).toEqual([0x90, 0x0b, 0x7f]);

    onPlayPress(0, 0x0b, 0x7f); // press again → toggle off
    expect(engine.getValue(group, 'play')).toBe(0);
    expect(sentMidi.at(-1)).toEqual([0x90, 0x0b, 0x00]);
  });

  it('a jog wheel scratches via engine.scratchEnable/Tick/Disable', () => {
    const { bus, engine } = makeEngine();
    const deck = 1;

    // touch the platter
    engine.scratchEnable(deck, 128, 33 + 1 / 3, 1 / 8, (1 / 8) / 32);
    expect(engine.isScratching(deck)).toBe(true);

    // a few jog ticks
    for (let i = 0; i < 5; i++) {
      engine.scratchTick(deck, 3);
    }
    expect(bus.get('[Channel1]', 'scratch2')).toBeGreaterThan(0);

    // release
    engine.scratchDisable(deck);
    expect(engine.isScratching(deck)).toBe(false);
  });

  it('an init() that connects N hotcue LEDs works', () => {
    const { engine } = makeEngine();
    const litPads = new Set<number>();

    // mapping init: connect 8 hotcue enabled states to pad LEDs
    const conns = [];
    for (let n = 1; n <= 8; n++) {
      conns.push(
        engine.makeConnection('[Channel1]', `hotcue_${n}_enabled`, (value) => {
          if (value) {
            litPads.add(n);
          } else {
            litPads.delete(n);
          }
        }),
      );
    }

    // user sets hotcue 3
    engine.setValue('[Channel1]', 'hotcue_3_enabled', 1);
    expect(litPads.has(3)).toBe(true);

    // shutdown: disconnect all
    conns.forEach((c) => c.disconnect());
    engine.setValue('[Channel1]', 'hotcue_5_enabled', 1);
    expect(litPads.has(5)).toBe(false); // no longer connected
  });

  it('uses engine.softTakeover without error (mappings call it freely)', () => {
    const { engine } = makeEngine();
    expect(() => {
      engine.softTakeover('[Channel1]', 'rate', true);
      engine.softTakeoverIgnoreNextValue('[Channel1]', 'rate');
    }).not.toThrow();
  });

  it('engine.log is callable', () => {
    const log = vi.fn();
    const bus = new ControlBus();
    bus.defineAll(standardControls(1));
    const engine = new EngineApi({ bus, log });
    engine.log('hello from a mapping');
    expect(log).toHaveBeenCalledWith('hello from a mapping');
  });
});
