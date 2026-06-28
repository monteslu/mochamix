/**
 * Performance pad modes — the descriptor model behind PadGrid. Each mode describes a row of
 * pads as data: what each pad shows, the bus control(s) it reflects/drives, and what a
 * press / shift-press does. This is the one source of truth so adding a mode (or wiring a
 * controller's pad-mode button later) is a data change, not new UI.
 *
 * Modes here reuse controls we ALREADY have (stems / hotcue / beatloop / beatjump), so this
 * is mostly plumbing, not new engine work. Stems mode collapses the old StemRow into pads.
 */

import {
  deck as deckGroup,
  DeckKeys,
  hotcueActivateKey,
  hotcueClearKey,
  hotcueEnabledKey,
  hotcueSetKey,
  beatloopActivateKey,
  type ControlBus,
  type Group,
  type Key,
} from '@dj/control-bus';

/** A single pad's spec for the current mode + deck. */
export interface PadSpec {
  /** Short text on the pad. */
  label: string;
  /** Accent color (stem color etc.), or undefined for the mode's default. */
  color?: string;
  /** Hover tooltip — self-documenting pads (better than blank hardware). */
  title: string;
  /** Bus controls whose CHANGE should re-render this pad (for lit/dim state). */
  watch: Array<{ group: Group; key: Key }>;
  /** Is the pad "on/lit" right now? (read from the bus). */
  isActive: (bus: ControlBus) => boolean;
  /** Press action. */
  press: (bus: ControlBus) => void;
  /** Optional shift-press (e.g. clear hotcue, solo stem). */
  shift?: (bus: ControlBus) => void;
}

export interface PadMode {
  id: string;
  label: string; // mode-selector button text
  /** Pads for a deck. Length ≤ 8; fewer pads (stems = 4) render in the first slots. */
  pads: (deckIndex: number) => PadSpec[];
  /** When false, the mode is unavailable for this deck (e.g. Stems on a non-stem track). */
  available?: (bus: ControlBus, deckIndex: number) => boolean;
}

// Canonical stem order + colors (match StemRow + the waveform coloring so pad == wave == fader).
const STEMS = [
  { gain: DeckKeys.stemGain0, name: 'DRUMS', color: '#ff5d5d' },
  { gain: DeckKeys.stemGain1, name: 'BASS', color: '#ffd24d' },
  { gain: DeckKeys.stemGain2, name: 'OTHER', color: '#5dff9e' },
  { gain: DeckKeys.stemGain3, name: 'VOCAL', color: '#5db8ff' },
] as const;

const muted = (bus: ControlBus, g: Group, key: Key) => bus.get(g, key) <= 0.001;

/** Stems mode: 4 pads = the 4 stems. Press = mute/unmute toggle (lit = playing). Shift =
 *  solo (and shift again restores all). Plus 4 combo pads: acapella / instrumental /
 *  drums-only / no-drums — one-press multi-stem mixes (VirtualDJ-style). */
const stemsMode: PadMode = {
  id: 'stems',
  label: 'STEMS',
  available: (bus, d) => bus.get(deckGroup(d + 1), DeckKeys.hasStems) > 0.5,
  pads: (d) => {
    const g = deckGroup(d + 1);
    const allGains = STEMS.map((s) => s.gain);
    const setAll = (bus: ControlBus, on: boolean[]) =>
      allGains.forEach((k, j) => bus.set(g, k, on[j] ? 1 : 0));
    const isSolo = (bus: ControlBus, i: number) =>
      !muted(bus, g, allGains[i]!) && allGains.every((k, j) => (j === i ? !muted(bus, g, k) : muted(bus, g, k)));

    const stemPads: PadSpec[] = STEMS.map((s, i) => ({
      label: s.name,
      color: s.color,
      title: `Toggle ${s.name} mute (shift: solo)`,
      watch: allGains.map((k) => ({ group: g, key: k })),
      isActive: (bus) => !muted(bus, g, s.gain), // lit = playing
      press: (bus) => bus.set(g, s.gain, muted(bus, g, s.gain) ? 1 : 0),
      shift: (bus) => {
        if (isSolo(bus, i)) setAll(bus, [true, true, true, true]);
        else setAll(bus, STEMS.map((_, j) => j === i));
      },
    }));

    // combo pads (one-press stem mixes)
    const combos: Array<{ label: string; title: string; on: boolean[] }> = [
      { label: '🎤 ACAP', title: 'Acapella — vocals only', on: [false, false, false, true] },
      { label: '🎹 INST', title: 'Instrumental — no vocals', on: [true, true, true, false] },
      { label: '🥁 DRUMS', title: 'Drums only', on: [true, false, false, false] },
      { label: 'NO 🥁', title: 'Drumless — everything but drums', on: [false, true, true, true] },
    ];
    const comboPads: PadSpec[] = combos.map((c) => ({
      label: c.label,
      title: c.title,
      watch: allGains.map((k) => ({ group: g, key: k })),
      isActive: (bus) => allGains.every((k, j) => !muted(bus, g, k) === c.on[j]),
      press: (bus) => setAll(bus, c.on),
    }));

    return [...stemPads, ...comboPads];
  },
};

/** Hot Cue mode: 8 pads. Press empty = set, press set = jump, shift = clear. */
const hotcueMode: PadMode = {
  id: 'hotcue',
  label: 'CUES',
  pads: (d) => {
    const g = deckGroup(d + 1);
    return Array.from({ length: 8 }, (_, i): PadSpec => {
      const n = i + 1;
      return {
        label: String(n),
        title: `Hot cue ${n}: set / jump (shift: clear)`,
        watch: [{ group: g, key: hotcueEnabledKey(n) }],
        isActive: (bus) => bus.get(g, hotcueEnabledKey(n)) > 0.5,
        press: (bus) =>
          bus.get(g, hotcueEnabledKey(n)) > 0.5
            ? bus.set(g, hotcueActivateKey(n), 1)
            : bus.set(g, hotcueSetKey(n), 1),
        shift: (bus) => bus.set(g, hotcueClearKey(n), 1),
      };
    });
  },
};

/** Beat Loop mode: 8 pads = beat sizes; press toggles that beatloop (lit while looping). */
const BEATLOOP_SIZES = [0.25, 0.5, 1, 2, 4, 8, 16, 32] as const;
const beatloopMode: PadMode = {
  id: 'beatloop',
  label: 'LOOP',
  pads: (d) => {
    const g = deckGroup(d + 1);
    return BEATLOOP_SIZES.map((size): PadSpec => ({
      label: size < 1 ? `1/${1 / size}` : String(size),
      title: `${size}-beat loop`,
      watch: [
        { group: g, key: DeckKeys.loopEnabled },
        { group: g, key: DeckKeys.beatloopSize },
      ],
      isActive: (bus) =>
        bus.get(g, DeckKeys.loopEnabled) > 0.5 && bus.get(g, DeckKeys.beatloopSize) === size,
      press: (bus) => bus.set(g, beatloopActivateKey(size), 1),
    }));
  },
};

/** Beat Jump mode: 8 pads = back/forward by 1/2/4/8 beats (momentary). */
const BEATJUMP = [-8, -4, -2, -1, 1, 2, 4, 8] as const;
const beatjumpMode: PadMode = {
  id: 'beatjump',
  label: 'JUMP',
  pads: (d) => {
    const g = deckGroup(d + 1);
    return BEATJUMP.map((beats): PadSpec => ({
      label: `${beats > 0 ? '+' : ''}${beats}`,
      title: `Jump ${Math.abs(beats)} beat(s) ${beats > 0 ? 'forward' : 'back'}`,
      watch: [],
      isActive: () => false,
      press: (bus) => bus.set(g, DeckKeys.beatjump, beats),
    }));
  },
};

/** All pad modes, in selector order. */
export const PAD_MODES: PadMode[] = [hotcueMode, beatloopMode, beatjumpMode, stemsMode];
