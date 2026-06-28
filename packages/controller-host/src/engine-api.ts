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

/**
 * Coerce a script-supplied value to a number. Mixxx ControlObjects are always doubles,
 * but midi-components writes BOOLEANS for toggle controls (e.g. PlayButton.inToggle →
 * inSetValue(!inGetValue()) → engine.setValue(group,"play",true)). Storing a raw boolean
 * on the bus breaks numeric consumers (deck audio reads `play > 0.5`) and the SAB. Mixxx
 * coerces implicitly; do the same: true→1, false→0, non-finite→0.
 */
function toNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

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
      this.bus.set(group, key, toNumber(value));
    }
  }

  getParameter(group: Group, key: Key): number {
    return this.bus.has(group, key) ? this.bus.getParameter(group, key) : 0;
  }

  setParameter(group: Group, key: Key, value: number): void {
    if (this.bus.has(group, key)) {
      this.bus.setParameter(group, key, toNumber(value));
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

  /** The active mapping's <settings> defaults (set per mapping load). */
  private mappingSettings: Record<string, string | number | boolean> = {};

  /** Install the current mapping's <settings> defaults for engine.getSetting. */
  setMappingSettings(settings: Record<string, string | number | boolean>): void {
    this.mappingSettings = settings ?? {};
  }

  getSetting(name: string): number | string | boolean | undefined {
    if (name in this.mappingSettings) return this.mappingSettings[name];
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
    // A timer callback that throws must NOT crash the host. Mixxx mapping LED-refresh
    // timers can throw transiently (e.g. setLED touching a component before it's
    // connected, or after the device went away). Mixxx's QJSEngine isolates these;
    // mirror that — log and swallow so one bad mapping can't take down MIDI for all.
    const safe = () => {
      try {
        callback();
      } catch (e) {
        this.logFn(`timer callback error (suppressed): ${(e as Error).message}`);
      }
    };
    if (oneShot) {
      const t = setTimeout(() => {
        this.timers.delete(id);
        safe();
      }, ms);
      this.timers.set(id, t);
    } else {
      const t = setInterval(safe, ms);
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

  // --- Soft takeover (real value-jump prevention) ---------------------------
  // When enabled for a control, a physical knob/fader is IGNORED until its value
  // "catches" (crosses) the control's current value — so moving a controller whose
  // position doesn't match the software doesn't make the value jump. Mixxx's behavior.

  /** Controls with soft-takeover enabled. Value = whether we're still waiting to catch. */
  private readonly softTakeoverState = new Map<string, { engaged: boolean; ignoreNext: boolean }>();

  softTakeover(group: Group, key: Key, set: boolean): void {
    const id = `${group}.${key}`;
    if (set) {
      if (!this.softTakeoverState.has(id)) this.softTakeoverState.set(id, { engaged: true, ignoreNext: false });
    } else {
      this.softTakeoverState.delete(id);
    }
  }

  softTakeoverIgnoreNextValue(group: Group, key: Key): void {
    const st = this.softTakeoverState.get(`${group}.${key}`);
    if (st) st.ignoreNext = true;
    else this.softTakeoverState.set(`${group}.${key}`, { engaged: true, ignoreNext: true });
  }

  /**
   * Should a soft-takeover control ACCEPT this incoming parameter (0..1)? Returns true
   * if soft-takeover isn't active for it, or if the value has caught the current value
   * (within a small threshold, or crossed it). Called by the router before applying a
   * direct-bound value. Updates the engaged state.
   */
  softTakeoverAllows(group: Group, key: Key, incomingParam: number): boolean {
    const id = `${group}.${key}`;
    const st = this.softTakeoverState.get(id);
    if (!st) return true; // not under soft-takeover → always apply
    if (st.ignoreNext) {
      st.ignoreNext = false;
      st.engaged = true;
      return false; // explicitly skip one value (e.g. after a programmatic change)
    }
    if (!st.engaged) return true; // already caught → pass through
    const current = this.getParameter(group, key); // 0..1
    const THRESH = 0.04; // ~5/127 — close enough to "catch"
    if (Math.abs(incomingParam - current) <= THRESH) {
      st.engaged = false; // caught — from now on values pass through
      return true;
    }
    return false; // still off — ignore to prevent the jump
  }

  // --- Motorized-platter / stop ramps (brake, spinback, soft start) ----------
  // These ramp a deck's rate over time (vinyl-stop / reverse-spin / start-up effects).
  // We approximate with the rate controls — enough for the mappings that call them not
  // to crash, and to give an audible ramp. Full sample-accurate ramps live in the
  // engine; this drives the existing rate/scratch controls.

  brake(deck: number, activate: boolean, _factor?: number, _rate?: number): void {
    // Engage/disengage a stop: scratch toward 0 rate. Uses the scratch path so it ramps.
    const group = `[Channel${deck}]`;
    if (activate) {
      this.scratchEnable(deck, 128, 33 + 1 / 3, 1 / 8, 1 / 8);
      this.scratchTick(deck, 0); // ramp to stop
    } else {
      this.scratchDisable(deck);
    }
    void group;
  }

  spinback(deck: number, activate: boolean, _factor?: number, rate = -10): void {
    if (activate) {
      this.scratchEnable(deck, 128, 33 + 1 / 3, 1 / 8, 1 / 8);
      this.scratchTick(deck, rate); // negative = reverse spin
    } else {
      this.scratchDisable(deck);
    }
  }

  softStart(deck: number, activate: boolean, _factor?: number): void {
    // Ramp from stop up to play rate.
    if (activate) {
      this.scratchEnable(deck, 128, 33 + 1 / 3, 1 / 8, 1 / 8);
      this.scratchTick(deck, 1);
      this.scratchDisable(deck);
    }
  }

  isBrakeActive(deck: number): boolean {
    return this.isScratching(deck);
  }
  isSoftStartActive(_deck: number): boolean {
    return false;
  }

  /** Multi-deck shared data (some mappings stash cross-deck state here). */
  private readonly sharedData: Record<string, unknown> = {};
  getSharedData(key: string): unknown {
    return this.sharedData[key];
  }
  setSharedData(key: string, value: unknown): void {
    this.sharedData[key] = value;
  }

  /** Alias some mappings use for connectControl. */
  connect(group: Group, key: Key, callback: EngineCallback): ScriptConnection {
    return this.makeConnection(group, key, callback);
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
