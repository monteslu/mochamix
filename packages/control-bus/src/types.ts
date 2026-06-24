/**
 * Core types for the control bus.
 *
 * The bus is Mixxx's ControlObject model (see internal-dj/03-architecture.md §1):
 * a named, thread-safe, atomic `number` addressed by a (group, key) pair, e.g.
 * `[Channel1],play` or `[Master],crossfader`. Every subsystem — UI, controllers,
 * keyboard, the audio engine — communicates ONLY through this bus.
 */

/** A control group, e.g. `[Channel1]`, `[Master]`, `[EffectRack1_EffectUnit1]`. */
export type Group = string;

/** A control key within a group, e.g. `play`, `volume`, `crossfader`. */
export type Key = string;

/**
 * The canonical string id for a control: `"[group],key"`.
 * This matches Mixxx's `ConfigKey` comma-separated form and is the wire/storage
 * identity used in IPC and persistence.
 */
export type ControlId = `${Group},${Key}`;

/** Build a ControlId from a group and key. */
export function controlId(group: Group, key: Key): ControlId {
  return `${group},${key}`;
}

/** Split a ControlId back into its group and key. The first comma separates them. */
export function parseControlId(id: ControlId): { group: Group; key: Key } {
  const comma = id.indexOf(',');
  if (comma < 0) {
    throw new Error(`Invalid ControlId (no comma): ${id}`);
  }
  return { group: id.slice(0, comma), key: id.slice(comma + 1) };
}

/**
 * Definition of a control, registered once at boot. Mirrors the flags on
 * Mixxx's `ControlObject` constructor.
 */
export interface ControlDef {
  group: Group;
  key: Key;
  /** Default value; also the initial value if not persisted/restored. */
  default: number;
  /**
   * Persist the value across restarts (Mixxx `bPersist`). Persisted controls are
   * saved on change and restored at boot.
   */
  persist?: boolean;
  /**
   * Minimum / maximum for normalized parameter <-> value mapping (Mixxx's
   * potmeter range). If omitted, parameter == value (treated as already 0..1).
   */
  min?: number;
  max?: number;
  /** Human description, for tooling / the controls inspector. */
  description?: string;
}

/** A resolved control with its assigned stable index (for the SAB mirror). */
export interface RegisteredControl extends Required<Omit<ControlDef, 'description'>> {
  id: ControlId;
  index: number;
  description: string;
}

/** Listener for value changes. Receives the new value and the control id. */
export type ChangeListener = (value: number, id: ControlId) => void;

/** Unsubscribe handle returned by `connect()`. */
export type Disconnect = () => void;
