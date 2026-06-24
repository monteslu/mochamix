/**
 * ControlBus — the authoritative control store (the spine).
 *
 * Mirrors Mixxx's ControlObject system (03-architecture.md §1). A flat registry
 * of named (group,key) controls, each a `number`, with:
 *   - get/set by ControlId or (group,key)
 *   - normalized parameter <-> value mapping (0..1 <-> [min,max])
 *   - pub/sub (`connect`) — the analog of Mixxx ControlProxy.valueChanged and the
 *     controller-script `engine.makeConnection`
 *   - a stable integer index per control for the SAB mirror
 *   - optional persistence (caller supplies load/save)
 *
 * One ControlBus instance is authoritative per process. In the renderer it is the
 * source of truth for UI-driven controls and mirrors engine-published controls;
 * the worklet reads the SAB. (IPC/SAB wiring lives in the app, not here, so this
 * package stays environment-agnostic and unit-testable.)
 */

import {
  controlId,
  parseControlId,
  type ChangeListener,
  type ControlDef,
  type ControlId,
  type Disconnect,
  type Group,
  type Key,
  type RegisteredControl,
} from './types.js';
import { allocateSab, sabWrite, type SabLayout } from './sab.js';

export interface ControlBusOptions {
  /**
   * If provided, the bus maintains a SAB mirror and writes every value into it.
   * `capacity` is the max number of controls. Pass an existing buffer to attach
   * to one created elsewhere (must match capacity).
   */
  sab?: { capacity: number; layout?: SabLayout };
  /** Called when a persisted control changes, so the host can save it. */
  onPersist?: (id: ControlId, value: number) => void;
  /** Initial persisted values to restore at registration time. */
  persistedValues?: Readonly<Record<string, number>>;
}

export class ControlBus {
  private readonly byId = new Map<ControlId, RegisteredControl>();
  private readonly byIndex: RegisteredControl[] = [];
  private readonly values: number[] = [];
  private readonly listeners = new Map<ControlId, Set<ChangeListener>>();
  private readonly persisted: Readonly<Record<string, number>>;
  private readonly onPersist?: (id: ControlId, value: number) => void;

  /** SAB mirror, if enabled. Exposed so the host can ship the buffer to the worklet. */
  readonly sab?: SabLayout;

  constructor(options: ControlBusOptions = {}) {
    this.persisted = options.persistedValues ?? {};
    this.onPersist = options.onPersist;
    if (options.sab) {
      this.sab = options.sab.layout ?? allocateSab(options.sab.capacity);
    }
  }

  /** Register a control. Assigns a stable index. Returns the registered control. */
  define(def: ControlDef): RegisteredControl {
    const id = controlId(def.group, def.key);
    const existing = this.byId.get(id);
    if (existing) {
      return existing;
    }
    const index = this.byIndex.length;
    if (this.sab && index >= this.sab.capacity) {
      throw new Error(
        `ControlBus SAB capacity (${this.sab.capacity}) exceeded registering ${id}`,
      );
    }
    const min = def.min ?? 0;
    const max = def.max ?? (def.min === undefined ? 1 : min + 1);
    const reg: RegisteredControl = {
      id,
      index,
      group: def.group,
      key: def.key,
      default: def.default,
      persist: def.persist ?? false,
      min,
      max,
      description: def.description ?? '',
    };
    // Restore a persisted value if present, else the default.
    const initial = reg.persist && id in this.persisted ? this.persisted[id]! : def.default;
    this.byId.set(id, reg);
    this.byIndex[index] = reg;
    this.values[index] = initial;
    if (this.sab) {
      sabWrite(this.sab, index, initial);
    }
    return reg;
  }

  /** Register many controls at once. */
  defineAll(defs: readonly ControlDef[]): void {
    for (const def of defs) {
      this.define(def);
    }
  }

  /** Whether a control is registered. */
  has(group: Group, key: Key): boolean {
    return this.byId.has(controlId(group, key));
  }

  private require(id: ControlId): RegisteredControl {
    const reg = this.byId.get(id);
    if (!reg) {
      throw new Error(`ControlBus: unknown control ${id} (define it first)`);
    }
    return reg;
  }

  /** Get a control's raw value. Throws if unknown. */
  get(group: Group, key: Key): number {
    const reg = this.require(controlId(group, key));
    return this.values[reg.index]!;
  }

  /** Get by ControlId. */
  getById(id: ControlId): number {
    const reg = this.require(id);
    return this.values[reg.index]!;
  }

  /**
   * Set a control's raw value. No-op if unchanged (Mixxx `bIgnoreNops`), to avoid
   * emitting on no-ops. Notifies listeners, updates the SAB, and persists.
   */
  set(group: Group, key: Key, value: number): void {
    this.setById(controlId(group, key), value);
  }

  setById(id: ControlId, value: number): void {
    const reg = this.require(id);
    if (this.values[reg.index] === value) {
      return;
    }
    this.values[reg.index] = value;
    if (this.sab) {
      sabWrite(this.sab, reg.index, value);
    }
    this.emit(reg.id, value);
    if (reg.persist && this.onPersist) {
      this.onPersist(reg.id, value);
    }
  }

  /**
   * Set the normalized parameter (0..1) form, mapped onto [min,max].
   * Mirrors Mixxx `setParameter`. Used by controllers/knobs.
   */
  setParameter(group: Group, key: Key, parameter: number): void {
    const reg = this.require(controlId(group, key));
    const clamped = parameter < 0 ? 0 : parameter > 1 ? 1 : parameter;
    const value = reg.min + clamped * (reg.max - reg.min);
    this.setById(reg.id, value);
  }

  /** Get the normalized parameter (0..1) form. Mirrors Mixxx `getParameter`. */
  getParameter(group: Group, key: Key): number {
    const reg = this.require(controlId(group, key));
    const span = reg.max - reg.min;
    if (span === 0) {
      return 0;
    }
    return (this.values[reg.index]! - reg.min) / span;
  }

  /** Reset a control to its default. */
  reset(group: Group, key: Key): void {
    const reg = this.require(controlId(group, key));
    this.setById(reg.id, reg.default);
  }

  /**
   * Subscribe to changes of a control. Returns an unsubscribe fn. This is the
   * analog of Mixxx `engine.makeConnection` / ControlProxy.valueChanged.
   */
  connect(group: Group, key: Key, listener: ChangeListener): Disconnect {
    const id = controlId(group, key);
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) {
        this.listeners.delete(id);
      }
    };
  }

  /** Force-fire a control's listeners with the current value (Mixxx `trigger`). */
  trigger(group: Group, key: Key): void {
    const reg = this.require(controlId(group, key));
    this.emit(reg.id, this.values[reg.index]!);
  }

  private emit(id: ControlId, value: number): void {
    const set = this.listeners.get(id);
    if (!set) {
      return;
    }
    for (const listener of set) {
      listener(value, id);
    }
  }

  /** Resolve a control's registration (for the index, range, etc.). */
  registration(group: Group, key: Key): RegisteredControl | undefined {
    return this.byId.get(controlId(group, key));
  }

  /** All registered controls, in index order. Useful for IPC snapshotting. */
  registry(): readonly RegisteredControl[] {
    return this.byIndex;
  }

  /** Snapshot of every control's current value, keyed by ControlId. */
  snapshot(): Record<ControlId, number> {
    const out = {} as Record<ControlId, number>;
    for (const reg of this.byIndex) {
      out[reg.id] = this.values[reg.index]!;
    }
    return out;
  }

  /** Helper: split a ControlId for callers that have only the id. */
  static parse = parseControlId;
}
