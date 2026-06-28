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
  hint: string; // mode-selector tooltip
  /** Pads for a deck. Length ≤ 8; fewer pads (stems = 4) render in the first slots. */
  pads: (deckIndex: number) => PadSpec[];
  /** When false, the mode is unavailable for this deck (e.g. Stems on a non-stem track). */
  available?: (bus: ControlBus, deckIndex: number) => boolean;
}

// Canonical stem order + colors (match StemRow + the waveform coloring so pad == wave ==
// fader) + an icon per stem (stems are the primary identity → icon + name on the pad).
const STEMS = [
  { gain: DeckKeys.stemGain0, name: 'DRUMS', icon: '🥁', color: '#ff5d5d' },
  { gain: DeckKeys.stemGain1, name: 'BASS', icon: '🎸', color: '#ffd24d' },
  { gain: DeckKeys.stemGain2, name: 'OTHER', icon: '🎹', color: '#5dff9e' },
  { gain: DeckKeys.stemGain3, name: 'VOCAL', icon: '🎤', color: '#5db8ff' },
] as const;

const muted = (bus: ControlBus, g: Group, key: Key) => bus.get(g, key) <= 0.001;

/** Stems mode: 4 pads = the 4 stems. Press = mute/unmute toggle (lit = playing). Shift =
 *  solo (and shift again restores all). Plus 4 combo pads: acapella / instrumental /
 *  drums-only / no-drums — one-press multi-stem mixes (VirtualDJ-style). */
const stemsMode: PadMode = {
  id: 'stems',
  label: 'STEMS',
  hint: 'Stems — mute/solo drums/bass/other/vocals + acapella/instrumental combos (needs a stems track)',
  available: (bus, d) => bus.get(deckGroup(d + 1), DeckKeys.hasStems) > 0.5,
  pads: (d) => {
    const g = deckGroup(d + 1);
    const allGains = STEMS.map((s) => s.gain);
    const setAll = (bus: ControlBus, on: boolean[]) =>
      allGains.forEach((k, j) => bus.set(g, k, on[j] ? 1 : 0));
    const isSolo = (bus: ControlBus, i: number) =>
      !muted(bus, g, allGains[i]!) && allGains.every((k, j) => (j === i ? !muted(bus, g, k) : muted(bus, g, k)));

    const stemPads: PadSpec[] = STEMS.map((s, i) => ({
      label: `${s.icon} ${s.name}`, // icon + name — stems are the primary identity
      color: s.color,
      title: `${s.name} stem — click to mute/unmute, shift-click to solo (mutes the others)`,
      watch: allGains.map((k) => ({ group: g, key: k })),
      isActive: (bus) => !muted(bus, g, s.gain), // lit = playing
      press: (bus) => bus.set(g, s.gain, muted(bus, g, s.gain) ? 1 : 0),
      shift: (bus) => {
        if (isSolo(bus, i)) setAll(bus, [true, true, true, true]);
        else setAll(bus, STEMS.map((_, j) => j === i));
      },
    }));

    // combo pads (one-press stem mixes). 4x2 pads have room for full words.
    const combos: Array<{ label: string; title: string; on: boolean[] }> = [
      { label: '🎤 ACAPELLA', title: 'Acapella — vocals only (mutes drums, bass, other)', on: [false, false, false, true] },
      { label: '🎹 INSTRUMENTAL', title: 'Instrumental — everything but vocals', on: [true, true, true, false] },
      { label: '🥁 DRUMS ONLY', title: 'Drums only (mutes bass, other, vocals)', on: [true, false, false, false] },
      { label: '🚫🥁 DRUMLESS', title: 'Drumless — everything but drums', on: [false, true, true, true] },
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
  hint: 'Hot Cues — set / jump to 8 cue points (shift-click a pad to clear)',
  pads: (d) => {
    const g = deckGroup(d + 1);
    return Array.from({ length: 8 }, (_, i): PadSpec => {
      const n = i + 1;
      return {
        label: String(n),
        title: `Hot cue ${n} — click an empty pad to SET a cue here; click a set pad to JUMP to it; shift-click to CLEAR`,
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
  hint: 'Beat Loops — one-press loops from 1/4 to 32 beats',
  pads: (d) => {
    const g = deckGroup(d + 1);
    return BEATLOOP_SIZES.map((size): PadSpec => ({
      label: size < 1 ? `1/${1 / size}` : String(size),
      title: `${size < 1 ? `1/${1 / size}` : size}-beat loop — click to set + enable; lights while looping at this size`,
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

/** Beat Jump mode: back/forward PAIRS next to each other (rekordbox style), ordered so the
 *  most-useful jumps come FIRST — a 4-pad controller (which only reaches pads 1-4) then gets
 *  ◀4 4▶ ◀8 8▶ (both directions, the common sizes); an 8-pad unit also gets the small ◀1 1▶
 *  ◀2 2▶. In the 4-col grid that lays out as:
 *    row1: ◀4  4▶  ◀8  8▶
 *    row2: ◀1  1▶  ◀2  2▶  */
const BEATJUMP_ORDER = [4, 8, 1, 2] as const; // size order: most-useful first
const beatjumpMode: PadMode = {
  id: 'beatjump',
  label: 'JUMP',
  hint: 'Beat Jump — skip back/forward by N beats while playing (pads paired ◀ N / N ▶; biggest/most-useful first for 4-pad controllers)',
  pads: (d) => {
    const g = deckGroup(d + 1);
    const pad = (beats: number): PadSpec => ({
      label: beats < 0 ? `◀ ${-beats}` : `${beats} ▶`,
      title: `Beat jump — skip ${Math.abs(beats)} beat${Math.abs(beats) === 1 ? '' : 's'} ${beats > 0 ? 'forward ▶' : '◀ back'} (keeps playing, no loop)`,
      watch: [],
      isActive: () => false,
      press: (bus) => bus.set(g, DeckKeys.beatjump, beats),
    });
    // back/forward pair per size, most-useful sizes first → 4-pad units get the best subset.
    return BEATJUMP_ORDER.flatMap((s) => [pad(-s), pad(s)]);
  },
};

/** All pad modes, in selector order. */
export const PAD_MODES: PadMode[] = [hotcueMode, beatloopMode, beatjumpMode, stemsMode];
