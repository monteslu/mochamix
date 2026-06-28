import { describe, it, expect, beforeEach } from 'vitest';
import { ControlBus, standardControls, deck, DeckKeys, hotcueEnabledKey, hotcueSetKey } from '@dj/control-bus';
import { PAD_MODES } from './pad-modes.js';

// Performance pad modes (descriptor model). Verifies press actions drive the right bus
// controls + lit state reflects them — the logic behind the on-screen + controller pads.

function setup() {
  const bus = new ControlBus();
  for (const c of standardControls(2)) bus.define(c);
  const mode = (id: string) => PAD_MODES.find((m) => m.id === id)!;
  return { bus, mode, g: deck(1) };
}

describe('pad modes', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('stems mode is available only when the deck has stems', () => {
    const stems = s.mode('stems');
    expect(stems.available!(s.bus, 0)).toBe(false);
    s.bus.set(s.g, DeckKeys.hasStems, 1);
    expect(stems.available!(s.bus, 0)).toBe(true);
  });

  it('stems pad: press toggles mute, lit = playing', () => {
    s.bus.set(s.g, DeckKeys.hasStems, 1);
    s.bus.set(s.g, DeckKeys.stemGain0, 1); // drums playing
    const pads = s.mode('stems').pads(0);
    const drums = pads[0]!;
    expect(drums.isActive(s.bus)).toBe(true); // lit
    drums.press(s.bus); // mute
    expect(s.bus.get(s.g, DeckKeys.stemGain0)).toBe(0);
    expect(drums.isActive(s.bus)).toBe(false); // dim
    drums.press(s.bus); // unmute
    expect(s.bus.get(s.g, DeckKeys.stemGain0)).toBe(1);
  });

  it('stems shift = solo (others muted), shift again restores all', () => {
    s.bus.set(s.g, DeckKeys.hasStems, 1);
    [DeckKeys.stemGain0, DeckKeys.stemGain1, DeckKeys.stemGain2, DeckKeys.stemGain3].forEach((k) =>
      s.bus.set(s.g, k, 1),
    );
    const vocal = s.mode('stems').pads(0)[3]!; // VOCAL
    vocal.shift!(s.bus); // solo vocals
    expect(s.bus.get(s.g, DeckKeys.stemGain3)).toBe(1);
    expect(s.bus.get(s.g, DeckKeys.stemGain0)).toBe(0);
    vocal.shift!(s.bus); // restore all
    expect(s.bus.get(s.g, DeckKeys.stemGain0)).toBe(1);
  });

  it('stems combo pad: acapella = vocals only', () => {
    s.bus.set(s.g, DeckKeys.hasStems, 1);
    const acapella = s.mode('stems').pads(0)[4]!; // first combo pad
    acapella.press(s.bus);
    expect(s.bus.get(s.g, DeckKeys.stemGain3)).toBe(1); // vocals on
    expect(s.bus.get(s.g, DeckKeys.stemGain0)).toBe(0); // drums off
    expect(acapella.isActive(s.bus)).toBe(true); // combo lit when its mix is active
  });

  it('hotcue pad: press when empty sets the cue; lit reflects enabled', () => {
    const cue1 = s.mode('hotcue').pads(0)[0]!;
    expect(cue1.isActive(s.bus)).toBe(false);
    cue1.press(s.bus); // not enabled → set
    expect(s.bus.get(s.g, hotcueSetKey(1))).toBe(1);
    s.bus.set(s.g, hotcueEnabledKey(1), 1);
    expect(cue1.isActive(s.bus)).toBe(true);
  });

  it('beatjump pads jump signed beats', () => {
    const pads = s.mode('beatjump').pads(0);
    pads[0]!.press(s.bus); // -8
    expect(s.bus.get(s.g, DeckKeys.beatjump)).toBe(-8);
    pads.at(-1)!.press(s.bus); // +8
    expect(s.bus.get(s.g, DeckKeys.beatjump)).toBe(8);
  });
});
