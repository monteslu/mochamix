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
      bus.set(g, DeckKeys.play, 0);
    },
    play: () => bus.set(g, DeckKeys.play, 1),
    isPlaying: () => bus.get(g, DeckKeys.play) > 0.5,
    isScratching: () => bus.get(g, DeckKeys.scratching) > 0.5,
  });
  const setPos = (f: number) => {
    position = f;
  };
  return { bus, g, ctl, seeks, getPos: () => position, setPos, wasStopped: () => stopped };
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

  // cue_default — the combined CDJ cue button real controllers (DJ2GO2) send.
  describe('cue_default (CDJ behavior)', () => {
    it('press while playing → stop + seek to cue', () => {
      s.bus.set(s.g, DeckKeys.cuePoint, 1000);
      s.bus.set(s.g, DeckKeys.play, 1);
      s.bus.set(s.g, DeckKeys.cueDefault, 1);
      expect(s.wasStopped()).toBe(true);
      expect(s.seeks).toContain(1000);
    });

    it('press while paused away from cue → sets a new cue here', () => {
      s.bus.set(s.g, DeckKeys.cuePoint, 1000); // cue elsewhere
      s.bus.set(s.g, DeckKeys.play, 0);
      s.setPos(50000); // we're at 50000, not the cue
      s.bus.set(s.g, DeckKeys.cueDefault, 1);
      expect(s.bus.get(s.g, DeckKeys.cuePoint)).toBe(50000); // cue moved here
    });

    it('press while paused AT the cue → previews (plays); release → stop + back to cue', () => {
      s.bus.set(s.g, DeckKeys.cuePoint, 50000);
      s.setPos(50000); // sitting exactly on the cue
      s.bus.set(s.g, DeckKeys.play, 0);
      // press → play preview
      s.bus.set(s.g, DeckKeys.cueDefault, 1);
      expect(s.bus.get(s.g, DeckKeys.play)).toBe(1);
      s.setPos(60000); // playback advanced
      // release → stop + jump back to cue
      s.bus.set(s.g, DeckKeys.cueDefault, 0);
      expect(s.bus.get(s.g, DeckKeys.play)).toBe(0);
      expect(s.seeks).toContain(50000);
    });

    it('press with no cue set (cue_point < 0) → sets the cue here', () => {
      s.bus.set(s.g, DeckKeys.cuePoint, -1);
      s.setPos(42000);
      s.bus.set(s.g, DeckKeys.cueDefault, 1);
      expect(s.bus.get(s.g, DeckKeys.cuePoint)).toBe(42000);
    });
  });

  describe('transport + cue variants', () => {
    it('cue_gotoandplay seeks to cue and plays', () => {
      s.bus.set(s.g, DeckKeys.cuePoint, 8000);
      s.bus.set(s.g, DeckKeys.cueGotoAndPlay, 1);
      expect(s.seeks).toContain(8000);
      expect(s.bus.get(s.g, DeckKeys.play)).toBe(1);
    });

    it('start_stop goes to track start and stops', () => {
      s.bus.set(s.g, DeckKeys.play, 1);
      s.setPos(50000);
      s.bus.set(s.g, DeckKeys.startStop, 1);
      expect(s.seeks).toContain(0);
      expect(s.bus.get(s.g, DeckKeys.play)).toBe(0);
    });

    it('start_play goes to start and plays', () => {
      s.setPos(50000);
      s.bus.set(s.g, DeckKeys.startPlay, 1);
      expect(s.seeks).toContain(0);
      expect(s.bus.get(s.g, DeckKeys.play)).toBe(1);
    });

    it('play_stutter restarts from the cue and plays', () => {
      s.bus.set(s.g, DeckKeys.cuePoint, 3000);
      s.setPos(50000);
      s.bus.set(s.g, DeckKeys.playStutter, 1);
      expect(s.seeks).toContain(3000);
      expect(s.bus.get(s.g, DeckKeys.play)).toBe(1);
    });

    it('cue_preview plays from cue while held; release stops + returns', () => {
      s.bus.set(s.g, DeckKeys.cuePoint, 7000);
      s.bus.set(s.g, DeckKeys.cuePreview, 1); // hold
      expect(s.seeks).toContain(7000);
      expect(s.bus.get(s.g, DeckKeys.play)).toBe(1);
      s.bus.set(s.g, DeckKeys.cuePreview, 0); // release
      expect(s.bus.get(s.g, DeckKeys.play)).toBe(0);
    });
  });
});
