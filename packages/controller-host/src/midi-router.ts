/**
 * MidiRouter — dispatches incoming MIDI messages to controls or script functions
 * (Mixxx MidiController::processInputMapping analog, 06 §2.5). Holds a parsed
 * mapping + the engine API + the loaded script context, and routes:
 *   - direct bindings → computeMidiParameter → engine.setParameter
 *   - script bindings → call the mapping's JS function (channel, control, value,
 *     status, group)
 * Also drives output (LED) bindings: subscribes each output's source control and
 * sends MIDI when it changes.
 */

import type { EngineApi } from './engine-api.js';
import { computeMidiParameter, isRelative } from './midi-options.js';
import {
  midiKey,
  type MidiInputControl,
  type MidiMapping,
  type MidiOutputControl,
} from './midi-mapping.js';
import type { ControlBus } from '@dj/control-bus';

/**
 * A loaded script's callable surface: function-name → fn. Mixxx input handlers
 * receive (channel, control, value, status, group) — the trailing `group` is a
 * string, so args are number|string.
 */
export type ScriptFunctions = Record<string, (...args: Array<number | string>) => void>;

/** Sends a 3-byte MIDI message to the device. */
export type MidiSend = (status: number, data1: number, data2: number) => void;

export interface MidiRouterDeps {
  bus: ControlBus;
  engine: EngineApi;
  mapping: MidiMapping;
  /**
   * Eagerly-resolved script functions (back-compat / simple mappings like Generic MIDI
   * whose handlers exist at load). Component-based mappings should use `resolveScript`.
   */
  scripts: ScriptFunctions;
  /**
   * Lazily resolve a control's `<key>` to its handler at dispatch time. REQUIRED for
   * component-based mappings: their handlers (playButton.input, faders, hotcueButtons[n])
   * are created in init(), which runs after the script loads — so they can't be
   * snapshotted up front. Falls back to `scripts` when not provided.
   */
  resolveScript?: (key: string) => ((...args: Array<number | string>) => void) | undefined;
  send: MidiSend;
}

export class MidiRouter {
  private readonly inByKey = new Map<number, MidiInputControl>();
  private readonly outConnections: Array<() => void> = [];
  /** Per 14-bit control (group.key): the last MSB/LSB byte, combined on each message. */
  private readonly fourteenBit = new Map<string, { msb: number; lsb: number }>();

  constructor(private readonly deps: MidiRouterDeps) {
    for (const c of deps.mapping.controls) {
      this.inByKey.set(midiKey(c.status, c.midino), c);
      // Auto-engage soft-takeover for controls that declare the <soft-takeover/> option
      // (Mixxx does this from the mapping, not just from script calls).
      if (c.options.softTakeover && !c.isScript) {
        this.deps.engine.softTakeover(c.group, c.key, true);
      }
    }
    this.connectOutputs();
  }

  /** Handle an incoming 3-byte MIDI message. */
  handleMessage(status: number, data1: number, data2: number): void {
    const control = this.inByKey.get(midiKey(status, data1));
    if (!control) {
      return;
    }
    const channel = status & 0x0f;

    if (control.isScript) {
      // Resolve lazily (post-init) so handlers on components built in init() bind; fall
      // back to the eager map for simple mappings. Mixxx signature: (channel, control,
      // value, status, group).
      const fn = this.deps.resolveScript
        ? this.deps.resolveScript(control.key)
        : this.deps.scripts[control.key];
      if (typeof fn === 'function') {
        (fn as (...a: unknown[]) => void)(channel, data1, data2, status, control.group);
      }
      return;
    }

    // Direct binding: transform the value and write the control parameter.
    const { bus, engine } = this.deps;
    if (!bus.has(control.group, control.key)) {
      return;
    }

    // 14-bit (hi-res) controls: two messages (MSB + LSB) share group+key. Combine the
    // latest of each into a 14-bit value (0..16383 → 0..1) for jog wheels / pitch faders.
    const o = control.options;
    if (o.fourteenBitMsb || o.fourteenBitLsb) {
      const id = `${control.group}.${control.key}`;
      const st = this.fourteenBit.get(id) ?? { msb: 0, lsb: 0 };
      if (o.fourteenBitMsb) st.msb = data2;
      else st.lsb = data2;
      this.fourteenBit.set(id, st);
      const combined = ((st.msb << 7) | st.lsb) / 16383; // 0..1
      const param = o.invert ? 1 - combined : combined;
      if (engine.softTakeoverAllows(control.group, control.key, param)) {
        engine.setParameter(control.group, control.key, param);
      }
      return;
    }

    const prevParam = engine.getParameter(control.group, control.key);
    const newParam = computeMidiParameter(data2, prevParam, control.options);
    // Soft-takeover: if active for this control, ignore the value until the physical
    // pot catches the current value — prevents the jump when positions don't match.
    if (!engine.softTakeoverAllows(control.group, control.key, newParam)) {
      return;
    }
    // For relative encoders we already folded prev in; setParameter clamps.
    engine.setParameter(control.group, control.key, newParam);
    void isRelative;
  }

  /** Subscribe output bindings so LEDs follow control values. */
  private connectOutputs(): void {
    for (const out of this.deps.mapping.outputs) {
      if (!this.deps.bus.has(out.group, out.key)) {
        continue;
      }
      const off = this.deps.bus.connect(out.group, out.key, (value) => {
        this.sendOutput(out, value);
      });
      this.outConnections.push(off);
      // Send the initial state.
      this.sendOutput(out, this.deps.bus.get(out.group, out.key));
    }
  }

  private sendOutput(out: MidiOutputControl, value: number): void {
    const lit = value >= out.min && value <= out.max && value > 0;
    this.deps.send(out.status, out.midino, lit ? out.on : out.off);
  }

  dispose(): void {
    for (const off of this.outConnections) {
      off();
    }
    this.outConnections.length = 0;
  }
}
