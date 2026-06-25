import { describe, it, expect, vi } from 'vitest';
import { parseMidiMapping, midiKey } from './midi-mapping.js';
import { MidiRouter } from './midi-router.js';
import { EngineApi } from './engine-api.js';
import { ControlBus, standardControls, MASTER, MasterKeys } from '@dj/control-bus';

// A Mixxx-style mapping: a direct crossfader binding, a script play binding, and
// a play LED output. Mirrors the shape of real res/controllers/*.midi.xml.
const SAMPLE_XML = `<?xml version="1.0" encoding="utf-8"?>
<MixxxControllerPreset schemaVersion="1" mixxxVersion="2.6">
  <info name="Test Controller" author="us"/>
  <controller id="Test">
    <scriptfiles>
      <file filename="Test-script.js" functionprefix="TestController"/>
    </scriptfiles>
    <controls>
      <control>
        <group>[Master]</group>
        <key>crossfader</key>
        <status>0xB0</status>
        <midino>0x08</midino>
      </control>
      <control>
        <group>[Channel1]</group>
        <key>TestController.playPress</key>
        <status>0x90</status>
        <midino>0x0B</midino>
        <options><script-binding/></options>
      </control>
      <control>
        <group>[Channel1]</group>
        <key>volume</key>
        <status>0xB0</status>
        <midino>0x07</midino>
      </control>
    </controls>
    <outputs>
      <output>
        <group>[Channel1]</group>
        <key>play_indicator</key>
        <status>0x90</status>
        <midino>0x0B</midino>
        <on>0x7F</on>
        <off>0x00</off>
        <minimum>0.5</minimum>
      </output>
    </outputs>
  </controller>
</MixxxControllerPreset>`;

describe('parseMidiMapping', () => {
  it('parses info, scriptfiles, controls, outputs', () => {
    const m = parseMidiMapping(SAMPLE_XML);
    expect(m.name).toBe('Test Controller');
    expect(m.author).toBe('us');
    expect(m.scriptFiles).toEqual([
      { filename: 'Test-script.js', functionPrefix: 'TestController' },
    ]);
    expect(m.controls).toHaveLength(3);
    expect(m.outputs).toHaveLength(1);
  });

  it('parses hex status/midino and the script-binding flag', () => {
    const m = parseMidiMapping(SAMPLE_XML);
    const xf = m.controls.find((c) => c.key === 'crossfader')!;
    expect(xf.status).toBe(0xb0);
    expect(xf.midino).toBe(0x08);
    expect(xf.isScript).toBe(false);

    const play = m.controls.find((c) => c.key.includes('playPress'))!;
    expect(play.isScript).toBe(true);
    expect(play.options.script).toBe(true);
  });

  it('parses output on/off/min', () => {
    const m = parseMidiMapping(SAMPLE_XML);
    const out = m.outputs[0]!;
    expect(out.on).toBe(0x7f);
    expect(out.off).toBe(0x00);
    expect(out.min).toBe(0.5);
  });
});

describe('MidiRouter', () => {
  function setup() {
    const bus = new ControlBus();
    bus.defineAll(standardControls(2));
    const engine = new EngineApi({ bus });
    const mapping = parseMidiMapping(SAMPLE_XML);
    const sent: Array<[number, number, number]> = [];
    const scripts = {
      'TestController.playPress': vi.fn((..._args: Array<number | string>) => {
        const value = _args[2] as number;
        if (value > 0) {
          const cur = engine.getValue('[Channel1]', 'play');
          engine.setValue('[Channel1]', 'play', cur > 0 ? 0 : 1);
        }
      }),
    };
    const router = new MidiRouter({
      bus,
      engine,
      mapping,
      scripts,
      send: (s, d1, d2) => sent.push([s, d1, d2]),
    });
    return { bus, engine, router, scripts, sent };
  }

  it('routes a direct binding (crossfader CC) to the control parameter', () => {
    const { bus, router } = setup();
    // CC 0xB0 ctrl 0x08 value 127 → crossfader full right (param 1 → value 1)
    router.handleMessage(0xb0, 0x08, 127);
    expect(bus.get(MASTER, MasterKeys.crossfader)).toBeCloseTo(1);
    router.handleMessage(0xb0, 0x08, 0);
    expect(bus.get(MASTER, MasterKeys.crossfader)).toBeCloseTo(-1);
    router.handleMessage(0xb0, 0x08, 64);
    expect(bus.get(MASTER, MasterKeys.crossfader)).toBeCloseTo(0, 1);
  });

  it('routes a script binding to the mapping function', () => {
    const { bus, router, scripts } = setup();
    router.handleMessage(0x90, 0x0b, 127); // play pad pressed
    expect(scripts['TestController.playPress']).toHaveBeenCalled();
    expect(bus.get('[Channel1]', 'play')).toBe(1);
  });

  it('drives the play LED output when play_indicator changes', () => {
    const { bus, sent } = setup();
    sent.length = 0; // clear initial-state sends
    bus.set('[Channel1]', 'play_indicator', 1);
    expect(sent.at(-1)).toEqual([0x90, 0x0b, 0x7f]); // lit
    bus.set('[Channel1]', 'play_indicator', 0);
    expect(sent.at(-1)).toEqual([0x90, 0x0b, 0x00]); // off
  });

  it('ignores messages with no binding', () => {
    const { router } = setup();
    expect(() => router.handleMessage(0xb0, 0x7f, 100)).not.toThrow();
  });

  it('midiKey is unique per status+midino', () => {
    expect(midiKey(0xb0, 0x08)).not.toBe(midiKey(0x90, 0x08));
    expect(midiKey(0xb0, 0x08)).toBe(midiKey(0xb0, 0x08));
  });
});
