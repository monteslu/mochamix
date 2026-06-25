import { describe, it, expect, vi } from 'vitest';
import { parseMidiMapping, runMappingScript, EngineApi, midiKey } from '@dj/controller-host';
import { ControlBus, standardControls } from '@dj/control-bus';
import { GENERIC_MIDI_XML, GENERIC_MIDI_JS } from './generic-midi.js';

// The built-in Generic MIDI mapping must parse with the real Mixxx parser and its
// jog script must drive scratch through the engine global — proving a controller
// plugged in + this mapping loaded will actually scratch.

function setup() {
  const bus = new ControlBus();
  bus.defineAll(standardControls(2));
  const engine = new EngineApi({ bus });
  const mapping = parseMidiMapping(GENERIC_MIDI_XML);
  const midi = { sendShortMsg: vi.fn(), sendSysexMsg: vi.fn() };
  const { functions } = runMappingScript(GENERIC_MIDI_JS, mapping, engine, midi, console);
  return { bus, engine, mapping, functions };
}

describe('Generic MIDI built-in mapping', () => {
  it('parses controls (play/cue/volume/EQ/crossfader/jog)', () => {
    const m = parseMidiMapping(GENERIC_MIDI_XML);
    expect(m.controls.length).toBeGreaterThanOrEqual(15);
    // a direct control: deck1 play on note 0x90/0x0B
    const play = m.controls.find((c) => c.group === '[Channel1]' && c.key === 'play');
    expect(play).toBeTruthy();
    expect(play!.status).toBe(0x90);
    expect(play!.midino).toBe(0x0b);
    // a script-binding control: the jog wheel
    const jog = m.controls.find((c) => c.isScript);
    expect(jog).toBeTruthy();
  });

  it('exposes a dispatchable key for direct controls', () => {
    const m = parseMidiMapping(GENERIC_MIDI_XML);
    const vol = m.controls.find((c) => c.key === 'volume' && c.group === '[Channel1]')!;
    expect(midiKey(vol.status, vol.midino)).toBe((0xb0 << 8) | 0x07);
  });

  it('the jog script scratches via engine.scratch* (forward + reverse)', () => {
    const { engine, functions } = setup();
    const jog1 = functions['Generic.jog1'] ?? functions['jog1'];
    expect(typeof jog1).toBe('function');

    // forward jog ticks
    jog1!(0, 0x0a, 0x03); // +3
    expect(engine.isScratching(1)).toBe(true);
    jog1!(0, 0x0a, 0x05); // +5
    // reverse jog (value > 0x40 → negative)
    jog1!(0, 0x0a, 0x7d); // -3
    // a zero tick releases
    jog1!(0, 0x0a, 0x00);
    expect(engine.isScratching(1)).toBe(false);
  });
});
