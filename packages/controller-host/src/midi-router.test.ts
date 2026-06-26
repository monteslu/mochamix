import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlBus, standardControls } from '@dj/control-bus';
import { MidiRouter } from './midi-router.js';
import { EngineApi } from './engine-api.js';
import { parseMidiMapping, type MidiMapping } from './midi-mapping.js';

function setup(controls: MidiMapping['controls']) {
  const bus = new ControlBus();
  for (const c of standardControls(2)) bus.define(c);
  const engine = new EngineApi({ bus, log: () => {} });
  const mapping: MidiMapping = { name: 'test', author: '', scriptFiles: [], controls, outputs: [], settings: {} };
  const router = new MidiRouter({ bus, engine, mapping, scripts: {}, send: () => {} });
  return { bus, engine, router };
}

describe('MidiRouter 14-bit (hi-res) controls', () => {
  it('combines MSB + LSB into a 14-bit value', () => {
    // Two controls, same group+key, MSB at 0xB1/0x08, LSB at 0xB1/0x28 — like a pitch fader.
    const { bus, router } = setup([
      { group: '[Channel1]', key: 'rate', status: 0xb1, midino: 0x08, isScript: false, options: { fourteenBitMsb: true, fourteenBit: true } },
      { group: '[Channel1]', key: 'rate', status: 0xb1, midino: 0x28, isScript: false, options: { fourteenBitLsb: true, fourteenBit: true } },
    ]);
    // MSB=64, LSB=0 → (64<<7)|0 = 8192 / 16383 ≈ 0.5 → setParameter maps to control range.
    router.handleMessage(0xb1, 0x08, 64); // MSB
    router.handleMessage(0xb1, 0x28, 0); // LSB
    const p = bus.getParameter('[Channel1]', 'rate');
    expect(p).toBeCloseTo(0.5, 2);

    // Now full-scale: MSB=127, LSB=127 → 16383/16383 = 1.0
    router.handleMessage(0xb1, 0x08, 127);
    router.handleMessage(0xb1, 0x28, 127);
    expect(bus.getParameter('[Channel1]', 'rate')).toBeCloseTo(1, 3);
  });

  it('gives finer resolution than 7-bit (LSB changes the value)', () => {
    const { bus, router } = setup([
      { group: '[Channel1]', key: 'rate', status: 0xb1, midino: 0x08, isScript: false, options: { fourteenBitMsb: true, fourteenBit: true } },
      { group: '[Channel1]', key: 'rate', status: 0xb1, midino: 0x28, isScript: false, options: { fourteenBitLsb: true, fourteenBit: true } },
    ]);
    router.handleMessage(0xb1, 0x08, 64);
    router.handleMessage(0xb1, 0x28, 0);
    const coarse = bus.getParameter('[Channel1]', 'rate');
    router.handleMessage(0xb1, 0x28, 64); // bump just the LSB
    const finer = bus.getParameter('[Channel1]', 'rate');
    expect(finer).not.toBe(coarse); // 14-bit resolves the LSB change; 7-bit couldn't
    expect(finer).toBeGreaterThan(coarse);
  });
});

describe('MidiRouter soft-takeover from the <soft-takeover/> option', () => {
  it('ignores the pot until it catches the control value', () => {
    const { bus, engine, router } = setup([
      { group: '[Channel1]', key: 'volume', status: 0xb1, midino: 0x07, isScript: false, options: { softTakeover: true } },
    ]);
    // Control currently at ~1.0 (volume default). A pot far from it should be IGNORED.
    engine.setParameter('[Channel1]', 'volume', 1.0);
    router.handleMessage(0xb1, 0x07, 0); // pot at 0 — far from 1.0 → ignored
    expect(bus.getParameter('[Channel1]', 'volume')).toBeCloseTo(1.0, 2);
    // Sweep the pot up to ~1.0 (127) — now it catches and takes over.
    router.handleMessage(0xb1, 0x07, 127);
    expect(bus.getParameter('[Channel1]', 'volume')).toBeCloseTo(1.0, 2);
    // After catching, a lower value now applies (takeover engaged).
    router.handleMessage(0xb1, 0x07, 0);
    expect(bus.getParameter('[Channel1]', 'volume')).toBeCloseTo(0, 2);
  });
});

describe('mapping <settings> parsing', () => {
  it('parses option defaults (enum + boolean) into mapping.settings', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../apps/desktop/resources/controllers');
    const file = join(dir, 'Numark-Mixtrack-3.midi.xml');
    let xml: string;
    try {
      xml = readFileSync(file, 'utf8');
    } catch {
      return; // skip if resources absent
    }
    const m = parseMidiMapping(xml);
    // The mapping declares a libraryMode enum (default "focus") + boolean options.
    expect(Object.keys(m.settings).length).toBeGreaterThan(0);
    expect(m.settings.libraryMode).toBe('focus');
  });
});
