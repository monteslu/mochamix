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
  /** The mapping's script functions (resolved by the host's sandbox). */
  scripts: ScriptFunctions;
  send: MidiSend;
}

export class MidiRouter {
  private readonly inByKey = new Map<number, MidiInputControl>();
  private readonly outConnections: Array<() => void> = [];

  constructor(private readonly deps: MidiRouterDeps) {
    for (const c of deps.mapping.controls) {
      this.inByKey.set(midiKey(c.status, c.midino), c);
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
      const fn = this.deps.scripts[control.key];
      if (typeof fn === 'function') {
        // Mixxx script handler signature: (channel, control, value, status, group)
        // We pass group as a trailing arg the function may ignore.
        (fn as (...a: unknown[]) => void)(channel, data1, data2, status, control.group);
      }
      return;
    }

    // Direct binding: transform the value and write the control parameter.
    const { bus, engine } = this.deps;
    if (!bus.has(control.group, control.key)) {
      return;
    }
    const prevParam = engine.getParameter(control.group, control.key);
    const newParam = computeMidiParameter(data2, prevParam, control.options);
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
