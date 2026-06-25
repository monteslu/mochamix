import { describe, it, expect, beforeEach } from 'vitest';
import { ControlBus, standardControls, deck as deckGroup, DeckKeys } from '@dj/control-bus';
import { CueControl } from './cue-control.js';

// Regression: "CUE buttons aren't doing anything." The button sets cue_set /
// cue_gotoandstop on the bus; CueControl must act on them. cue_gotoandstop did
// nothing when cue_point was -1 (unset) — fixed by defaulting cue_point to the
// track start on load (engine), so here we set it explicitly.

function setup() {
  const bus = new ControlBus();
  for (const c of standardControls(2)) bus.define(c);
  const g = deckGroup(1);
  let position = 50000;
  let stopped = false;
  const seeks: number[] = [];
  const ctl = new CueControl({
    bus,
    group: g,
    positionFrames: () => position,
    seekFrames: (f) => {
      seeks.push(f);
      position = f;
    },
    stop: () => {
      stopped = true;
    },
  });
  return { bus, g, ctl, seeks, getPos: () => position, wasStopped: () => stopped };
}

describe('CueControl', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('cue_set sets the cue point to the current position', () => {
    s.bus.set(s.g, DeckKeys.cueSet, 1);
    expect(s.bus.get(s.g, DeckKeys.cuePoint)).toBe(50000);
    // the trigger self-resets so it can fire again
    expect(s.bus.get(s.g, DeckKeys.cueSet)).toBe(0);
  });

  it('cue_gotoandstop seeks to the cue point + stops (the button that did nothing)', () => {
    s.bus.set(s.g, DeckKeys.cuePoint, 12345); // e.g. set on load / by the user
    s.bus.set(s.g, DeckKeys.cueGotoAndStop, 1);
    expect(s.seeks).toContain(12345);
    expect(s.wasStopped()).toBe(true);
    expect(s.getPos()).toBe(12345);
  });

  it('cue_gotoandstop with the default track-start cue (0) jumps to the start', () => {
    s.bus.set(s.g, DeckKeys.cuePoint, 0); // engine sets this on load
    s.bus.set(s.g, DeckKeys.cueGotoAndStop, 1);
    expect(s.seeks).toContain(0);
    expect(s.getPos()).toBe(0);
  });

  it('does nothing when there is genuinely no cue (cue_point < 0)', () => {
    s.bus.set(s.g, DeckKeys.cuePoint, -1);
    s.bus.set(s.g, DeckKeys.cueGotoAndStop, 1);
    expect(s.seeks).toHaveLength(0);
  });

  it('a second cue_set re-fires (trigger self-reset)', () => {
    s.bus.set(s.g, DeckKeys.cueSet, 1);
    // move + set again
    s.seeks.length = 0;
    s.bus.set(s.g, DeckKeys.cuePoint, -1); // pretend cleared
    s.bus.set(s.g, DeckKeys.cueSet, 1);
    expect(s.bus.get(s.g, DeckKeys.cuePoint)).toBe(50000);
  });
});
