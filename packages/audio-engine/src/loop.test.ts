import { describe, it, expect, vi } from 'vitest';
import { DeckPlayback, type DeckTrack } from './deck-playback.js';
import { CueControl } from './controls/cue-control.js';
import { LoopControl } from './controls/loop-control.js';
import {
  ControlBus,
  standardControls,
  deck,
  DeckKeys,
  hotcuePositionKey,
  hotcueSetKey,
  hotcueActivateKey,
  beatloopActivateKey,
} from '@dj/control-bus';

function ramp(frames: number): DeckTrack {
  const a = new Float32Array(frames);
  for (let i = 0; i < frames; i++) a[i] = i;
  return { channelData: [a, a.slice()], channels: 2, frames, sampleRate: 48000 };
}

describe('DeckPlayback loop wrap', () => {
  it('wraps the read position from loopEnd back to loopStart', () => {
    const d = new DeckPlayback(48000);
    d.loadTrack(ramp(1000));
    d.setLoop(100, 200, true);
    d.seekFrames(190);
    const out = [new Float32Array(64), new Float32Array(64)];
    // Play forward; after ~10 frames we cross 200 and must wrap near 100.
    d.process(out, 64, 1, true);
    const pos = d.getPositionFrames();
    expect(pos).toBeGreaterThanOrEqual(100);
    expect(pos).toBeLessThan(200); // stayed inside the loop
  });

  it('keeps playing (does not end) while looping near the track end', () => {
    const d = new DeckPlayback(48000);
    d.loadTrack(ramp(500));
    d.setLoop(400, 480, true);
    d.seekFrames(470);
    const out = [new Float32Array(256), new Float32Array(256)];
    const still = d.process(out, 256, 1, true);
    expect(still).toBe(true); // loop overrides end-of-track
    expect(d.getPositionFrames()).toBeLessThan(480);
  });

  it('disabling the loop lets playback continue past loopEnd', () => {
    const d = new DeckPlayback(48000);
    d.loadTrack(ramp(1000));
    d.setLoop(100, 200, true);
    d.seekFrames(195);
    d.setLoopEnabled(false);
    const out = [new Float32Array(64), new Float32Array(64)];
    d.process(out, 64, 1, true);
    expect(d.getPositionFrames()).toBeGreaterThan(200); // sailed past
  });

  it('ignores a degenerate loop (end <= start)', () => {
    const d = new DeckPlayback(48000);
    d.loadTrack(ramp(1000));
    d.setLoop(200, 200, true);
    expect(d.isLoopEnabled()).toBe(false);
  });
});

describe('CueControl', () => {
  function setup() {
    const bus = new ControlBus();
    bus.defineAll(standardControls(1));
    const g = deck(1);
    let position = 0;
    const seeks: number[] = [];
    const stops = vi.fn();
    const cue = new CueControl({
      bus,
      group: g,
      positionFrames: () => position,
      seekFrames: (f) => seeks.push(f),
      stop: stops,
    });
    return { bus, g, cue, seeks, stops, setPosition: (p: number) => (position = p) };
  }

  it('sets the main cue to the current position and recalls it', () => {
    const { bus, g, seeks, stops, setPosition } = setup();
    setPosition(5000);
    bus.set(g, DeckKeys.cueSet, 1);
    expect(bus.get(g, DeckKeys.cuePoint)).toBe(5000);
    bus.set(g, DeckKeys.cueGotoAndStop, 1);
    expect(stops).toHaveBeenCalled();
    expect(seeks).toContain(5000);
  });

  it('sets and activates a hotcue', () => {
    const { bus, g, seeks, setPosition } = setup();
    setPosition(12345);
    bus.set(g, hotcueSetKey(3), 1);
    expect(bus.get(g, hotcuePositionKey(3))).toBe(12345);
    setPosition(0);
    bus.set(g, hotcueActivateKey(3), 1);
    expect(seeks).toContain(12345);
  });

  it('does not seek to an unset hotcue', () => {
    const { bus, g, seeks } = setup();
    bus.set(g, hotcueActivateKey(7), 1);
    expect(seeks).toHaveLength(0);
  });
});

describe('LoopControl', () => {
  function setup(bpm = 120) {
    const bus = new ControlBus();
    bus.defineAll(standardControls(1));
    const g = deck(1);
    bus.set(g, DeckKeys.fileBpm, bpm);
    bus.set(g, DeckKeys.trackSamples, 48000 * 60);
    let position = 0;
    const applied: Array<{ start: number; end: number; enabled: boolean }> = [];
    const seeks: number[] = [];
    const loop = new LoopControl({
      bus,
      group: g,
      sampleRate: 48000,
      positionFrames: () => position,
      trackFrames: () => 48000 * 60,
      applyLoop: (start, end, enabled) => applied.push({ start, end, enabled }),
      enableLoop: () => {},
      seekFrames: (f) => {
        seeks.push(f);
        position = f;
      },
      stop: () => bus.set(g, DeckKeys.play, 0),
    });
    return { bus, g, loop, applied, seeks, setPosition: (p: number) => (position = p) };
  }

  it('loop in/out sets bounds and enables', () => {
    const { bus, g, applied, setPosition } = setup();
    setPosition(1000);
    bus.set(g, DeckKeys.loopIn, 1);
    setPosition(5000);
    bus.set(g, DeckKeys.loopOut, 1);
    expect(bus.get(g, DeckKeys.loopStartPosition)).toBe(1000);
    expect(bus.get(g, DeckKeys.loopEndPosition)).toBe(5000);
    expect(bus.get(g, DeckKeys.loopEnabled)).toBe(1);
    expect(applied.at(-1)).toEqual({ start: 1000, end: 5000, enabled: true });
  });

  it('beatloop sizes the loop by BPM (120bpm → 0.5s/beat → 24000 frames/beat)', () => {
    const { bus, g, applied, setPosition } = setup(120);
    setPosition(0);
    bus.set(g, beatloopActivateKey(4), 1); // 4 beats
    // 4 beats * 24000 = 96000 frames
    expect(bus.get(g, DeckKeys.loopEndPosition)).toBeCloseTo(96000, 0);
    expect(applied.at(-1)?.enabled).toBe(true);
  });

  it('halve/double resize the loop end', () => {
    const { bus, g, setPosition } = setup();
    setPosition(0);
    bus.set(g, DeckKeys.loopIn, 1);
    setPosition(4000);
    bus.set(g, DeckKeys.loopOut, 1); // loop 0..4000
    bus.set(g, DeckKeys.loopDouble, 1);
    expect(bus.get(g, DeckKeys.loopEndPosition)).toBe(8000);
    bus.set(g, DeckKeys.loopHalve, 1);
    expect(bus.get(g, DeckKeys.loopEndPosition)).toBe(4000);
  });

  it('reloop_toggle flips the enabled state', () => {
    const { bus, g, setPosition } = setup();
    setPosition(0);
    bus.set(g, DeckKeys.loopIn, 1);
    setPosition(2000);
    bus.set(g, DeckKeys.loopOut, 1); // enables
    expect(bus.get(g, DeckKeys.loopEnabled)).toBe(1);
    bus.set(g, DeckKeys.reloopToggle, 1);
    expect(bus.get(g, DeckKeys.loopEnabled)).toBe(0);
    bus.set(g, DeckKeys.reloopToggle, 1);
    expect(bus.get(g, DeckKeys.loopEnabled)).toBe(1);
  });

  it('reloop_exit is an alias of reloop_toggle', () => {
    const { bus, g, setPosition } = setup();
    setPosition(0);
    bus.set(g, DeckKeys.loopIn, 1);
    setPosition(2000);
    bus.set(g, DeckKeys.loopOut, 1);
    expect(bus.get(g, DeckKeys.loopEnabled)).toBe(1);
    bus.set(g, DeckKeys.reloopExit, 1); // toggles off
    expect(bus.get(g, DeckKeys.loopEnabled)).toBe(0);
  });

  it('reloop_andstop re-enters the loop, seeks to start, and stops', () => {
    const { bus, g, seeks, setPosition } = setup();
    setPosition(1000);
    bus.set(g, DeckKeys.loopIn, 1);
    setPosition(5000);
    bus.set(g, DeckKeys.loopOut, 1);
    bus.set(g, DeckKeys.play, 1);
    bus.set(g, DeckKeys.reloopAndStop, 1);
    expect(bus.get(g, DeckKeys.loopEnabled)).toBe(1);
    expect(seeks).toContain(1000); // back to loop start
    expect(bus.get(g, DeckKeys.play)).toBe(0); // stopped
  });

  it('beatloop_activate uses beatloop_size', () => {
    const { bus, g, setPosition } = setup(120); // 24000 frames/beat
    setPosition(0);
    bus.set(g, DeckKeys.beatloopSize, 8);
    bus.set(g, DeckKeys.beatloopActivate, 1);
    expect(bus.get(g, DeckKeys.loopEndPosition)).toBeCloseTo(8 * 24000, 0);
    expect(bus.get(g, DeckKeys.loopEnabled)).toBe(1);
  });

  it('beatjump_forward/backward seeks N beats without looping', () => {
    const { bus, g, seeks, setPosition } = setup(120); // 24000 frames/beat
    setPosition(100000);
    bus.set(g, DeckKeys.beatjumpSize, 4);
    bus.set(g, DeckKeys.beatjumpForward, 1);
    expect(seeks.at(-1)).toBeCloseTo(100000 + 4 * 24000, 0);
    expect(bus.get(g, DeckKeys.loopEnabled)).toBe(0); // no loop created
    bus.set(g, DeckKeys.beatjumpBackward, 1);
    expect(seeks.at(-1)).toBeCloseTo(100000 + 4 * 24000 - 4 * 24000, 0);
  });

  it('beatjump (signed value) jumps and self-resets', () => {
    const { bus, g, seeks, setPosition } = setup(120);
    setPosition(50000);
    bus.set(g, DeckKeys.beatjump, -2); // back 2 beats
    expect(seeks.at(-1)).toBeCloseTo(50000 - 2 * 24000, 0);
    expect(bus.get(g, DeckKeys.beatjump)).toBe(0);
  });
});
