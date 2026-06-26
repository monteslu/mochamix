/**
 * The `engine` global API — the Mixxx ControllerScriptInterfaceLegacy analog
 * (06-ui-controllers-effects.md §2.4). Backed by the control bus. If we implement
 * this faithfully, stock Mixxx mapping scripts (and midi-components-0.0.js) run
 * unchanged — the whole reuse strategy (10 §6) hinges on this object.
 *
 * Timers use the host's setInterval/setTimeout. Scratch uses an alpha-beta filter
 * matching Mixxx's behavior closely enough for jog-wheel scratching.
 */

import { ControlBus, type Group, type Key } from '@dj/control-bus';

export type EngineCallback = (value: number, group: Group, key: Key) => void;

/** A connection handle returned by makeConnection (Mixxx ScriptConnection). */
export interface ScriptConnection {
  disconnect(): boolean;
  trigger(): void;
}

export interface EngineApiOptions {
  bus: ControlBus;
  /** Read a mapping <setting> value by name. */
  getSetting?: (name: string) => number | string | undefined;
  /** Logger for engine.log. */
  log?: (msg: string) => void;
}

export class EngineApi {
  private readonly bus: ControlBus;
  private readonly getSettingFn?: (name: string) => number | string | undefined;
  private readonly logFn: (msg: string) => void;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private nextTimerId = 1;
  /** Per-deck scratch state. */
  private readonly scratch = new Map<number, ScratchState>();

  constructor(opts: EngineApiOptions) {
    this.bus = opts.bus;
    this.getSettingFn = opts.getSetting;
    this.logFn = opts.log ?? ((m) => console.log('[controller]', m));
  }

  // --- Control values -------------------------------------------------------

  getValue(group: Group, key: Key): number {
    return this.bus.has(group, key) ? this.bus.get(group, key) : 0;
  }

  setValue(group: Group, key: Key, value: number): void {
    if (this.bus.has(group, key)) {
      this.bus.set(group, key, value);
    }
  }

  getParameter(group: Group, key: Key): number {
    return this.bus.has(group, key) ? this.bus.getParameter(group, key) : 0;
  }

  setParameter(group: Group, key: Key, value: number): void {
    if (this.bus.has(group, key)) {
      this.bus.setParameter(group, key, value);
    }
  }

  getParameterForValue(group: Group, key: Key, value: number): number {
    const reg = this.bus.registration(group, key);
    if (!reg) {
      return 0;
    }
    const span = reg.max - reg.min;
    return span === 0 ? 0 : (value - reg.min) / span;
  }

  getDefaultValue(group: Group, key: Key): number {
    return this.bus.registration(group, key)?.default ?? 0;
  }

  getDefaultParameter(group: Group, key: Key): number {
    const reg = this.bus.registration(group, key);
    if (!reg) {
      return 0;
    }
    const span = reg.max - reg.min;
    return span === 0 ? 0 : (reg.default - reg.min) / span;
  }

  reset(group: Group, key: Key): void {
    if (this.bus.has(group, key)) {
      this.bus.reset(group, key);
    }
  }

  getSetting(name: string): number | string | undefined {
    return this.getSettingFn?.(name);
  }

  // --- Connections ----------------------------------------------------------

  makeConnection(group: Group, key: Key, callback: EngineCallback): ScriptConnection {
    // Tolerate an invalid control OR a non-function callback (some component code paths
    // pass an undefined handler) — return a no-op handle rather than crashing the whole
    // mapping load, matching Mixxx's leniency.
    if (!this.bus.has(group, key) || typeof callback !== 'function') {
      return { disconnect: () => false, trigger: () => {} };
    }
    const off = this.bus.connect(group, key, (value) => callback(value, group, key));
    let connected = true;
    return {
      disconnect: () => {
        if (connected) {
          off();
          connected = false;
          return true;
        }
        return false;
      },
      trigger: () => callback(this.bus.get(group, key), group, key),
    };
  }

  /** Unbuffered connection is the same here (no double-buffering of CO values). */
  makeUnbufferedConnection(group: Group, key: Key, callback: EngineCallback): ScriptConnection {
    return this.makeConnection(group, key, callback);
  }

  /** Legacy connectControl. Returns a connection (Mixxx returns boolean/connection). */
  connectControl(group: Group, key: Key, callback: EngineCallback): ScriptConnection {
    return this.makeConnection(group, key, callback);
  }

  /** Force a control's connected callbacks to fire with its current value. */
  trigger(group: Group, key: Key): void {
    if (this.bus.has(group, key)) {
      this.bus.trigger(group, key);
    }
  }

  // --- Timers ---------------------------------------------------------------

  beginTimer(intervalMs: number, callback: () => void, oneShot = false): number {
    const ms = Math.max(20, intervalMs); // Mixxx enforces a 20ms minimum
    const id = this.nextTimerId++;
    if (oneShot) {
      const t = setTimeout(() => {
        this.timers.delete(id);
        callback();
      }, ms);
      this.timers.set(id, t);
    } else {
      const t = setInterval(callback, ms);
      this.timers.set(id, t);
    }
    return id;
  }

  stopTimer(id: number): void {
    const t = this.timers.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      clearInterval(t);
      this.timers.delete(id);
    }
  }

  /** Stop all timers (on mapping shutdown). */
  stopAllTimers(): void {
    for (const t of this.timers.values()) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers.clear();
  }

  // --- Scratch (alpha-beta filter) ------------------------------------------

  scratchEnable(
    deck: number,
    intervalsPerRev: number,
    rpm: number,
    alpha: number,
    beta: number,
    _ramp = true,
  ): void {
    this.scratch.set(deck, new ScratchState(intervalsPerRev, rpm, alpha, beta));
    // engage scratch mode: deck plays at scratch2 (signed) under the wheel
    this.setValue(`[Channel${deck}]`, 'scratch2_enable', 1);
  }

  scratchTick(deck: number, interval: number): void {
    const s = this.scratch.get(deck);
    if (!s) {
      return;
    }
    s.tick(interval);
    // Drive the deck at the scratch filter velocity (SIGNED — negative = reverse).
    this.setValue(`[Channel${deck}]`, 'scratch2', s.velocity);
  }

  scratchDisable(deck: number, _ramp = true): void {
    this.scratch.delete(deck);
    this.setValue(`[Channel${deck}]`, 'scratch2', 0);
    this.setValue(`[Channel${deck}]`, 'scratch2_enable', 0);
  }

  isScratching(deck: number): boolean {
    return this.scratch.has(deck);
  }

  // --- Soft takeover (no-op-ish for now; tracked so mappings don't error) ----

  softTakeover(_group: Group, _key: Key, _set: boolean): void {
    /* TODO: implement value-jump prevention; harmless no-op for now */
  }
  softTakeoverIgnoreNextValue(_group: Group, _key: Key): void {
    /* no-op */
  }

  // --- Logging --------------------------------------------------------------

  log(msg: string): void {
    this.logFn(msg);
  }
}

/** Minimal alpha-beta scratch filter (Mixxx PositionScratchController-ish). */
class ScratchState {
  velocity = 0;
  private position = 0;
  constructor(
    private readonly intervalsPerRev: number,
    private readonly rpm: number,
    private readonly alpha: number,
    private readonly beta: number,
  ) {}

  tick(interval: number): void {
    // Target position increment from the jog interval.
    this.position += interval / this.intervalsPerRev;
    // Predict, then correct toward the measured movement (alpha-beta).
    const target = (this.rpm / 60) * (interval / this.intervalsPerRev);
    const error = target - this.velocity;
    this.velocity += this.alpha * error;
    this.velocity += this.beta * error;
  }
}
