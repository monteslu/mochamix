/**
 * ControllerService — the renderer-side Web MIDI host. Requests MIDI access,
 * lets a mapping (parsed from .midi.xml) drive the control bus via the EngineApi,
 * and runs the mapping's JS in a sandboxed scope with the Mixxx `engine`/`midi`/
 * `console` globals (so stock Mixxx mapping scripts run nearly unchanged).
 *
 * This is the renderer half of M7. The mapping XML + JS are loaded as strings
 * (bundled or fetched); we execute the JS in a Function scope that closes over
 * the engine/midi globals — the same contract Mixxx's QJSEngine provides.
 */

import {
  EngineApi,
  MidiRouter,
  parseMidiMapping,
  runMappingScript,
  type MidiMapping,
} from '@dj/controller-host';
import type { ControlBus } from '@dj/control-bus';
import { GENERIC_MIDI_XML, GENERIC_MIDI_JS } from './mappings/generic-midi.js';

export interface LoadedMapping {
  name: string;
  router: MidiRouter;
  mapping: MidiMapping;
}

export class ControllerService {
  private readonly engine: EngineApi;
  private access: MIDIAccess | null = null;
  /** True once the user manually picked a mapping (auto-connect then stays out of the way). */
  private userLoaded = false;
  /** Guards the one-time statechange hook for auto-connect. */
  private autoHooked = false;
  private current: {
    router: MidiRouter;
    input: MIDIInput | null;
    output: MIDIOutput | null;
    onmidi: (e: MIDIMessageEvent) => void;
  } | null = null;

  constructor(private readonly bus: ControlBus) {
    this.engine = new EngineApi({ bus, log: (m) => console.log('[mapping]', m) });
  }

  /** Request Web MIDI access. Returns the available input device names. */
  async init(): Promise<{ inputs: string[]; outputs: string[] }> {
    if (!navigator.requestMIDIAccess) {
      console.warn('[midi] Web MIDI not available (navigator.requestMIDIAccess missing)');
      throw new Error('Web MIDI not available');
    }
    if (!this.access) {
      console.log('[midi] requesting Web MIDI access…');
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      console.log('[midi] access granted');
      // Hot-plug: log + re-report when a device connects/disconnects.
      this.access.onstatechange = (e) => {
        const port = e.port;
        if (port) {
          console.log(
            `[midi] statechange: ${port.type} "${port.name}" → ${port.state}/${port.connection}`,
          );
        }
        this.logDevices();
      };
    }
    const inputs = [...this.access.inputs.values()].map((i) => i.name ?? 'unknown');
    const outputs = [...this.access.outputs.values()].map((o) => o.name ?? 'unknown');
    console.log(
      `[midi] ${inputs.length} input(s): ${inputs.join(', ') || '(none)'} | ${outputs.length} output(s): ${outputs.join(', ') || '(none)'}`,
    );
    return { inputs, outputs };
  }

  private logDevices(): void {
    if (!this.access) return;
    const ins = [...this.access.inputs.values()].map((i) => `"${i.name}" [${i.state}]`);
    const outs = [...this.access.outputs.values()].map((o) => `"${o.name}" [${o.state}]`);
    console.log(`[midi] devices now — inputs: ${ins.join(', ') || '(none)'} · outputs: ${outs.join(', ') || '(none)'}`);
  }

  /**
   * Auto-start MIDI on app open: request access, and if a controller is present, load
   * the built-in Generic MIDI mapping onto the first input so it's listening
   * immediately — no need to open settings. Also re-runs on hot-plug (statechange) so
   * plugging a controller in AFTER launch just works. A manual loadMapping() takes
   * precedence (we don't auto-override the user's chosen mapping).
   */
  async autoConnect(): Promise<void> {
    try {
      await this.init();
    } catch {
      return; // Web MIDI unavailable
    }
    // Re-attempt auto-connect whenever devices change (covers plug-in-after-launch).
    if (this.access && !this.autoHooked) {
      this.autoHooked = true;
      const access = this.access;
      const prev = access.onstatechange;
      access.onstatechange = (e) => {
        if (typeof prev === 'function') prev.call(access, e);
        if (!this.userLoaded) this.attachGenericToFirstInput();
      };
    }
    if (!this.userLoaded) this.attachGenericToFirstInput();
  }

  private attachGenericToFirstInput(): void {
    if (!this.access) return;
    const first = [...this.access.inputs.values()].find((i) => i.state === 'connected');
    if (!first) {
      console.log('[midi] no controller connected yet — will auto-connect when one is plugged in');
      return;
    }
    // Already attached to this device? don't reload.
    if (this.current && this.current.input && this.current.input.name === first.name) return;
    console.log(`[midi] auto-connecting Generic MIDI mapping to "${first.name}"`);
    this.loadMapping(
      GENERIC_MIDI_XML,
      GENERIC_MIDI_JS,
      first.name ?? undefined,
      first.name ?? undefined,
      false, // auto, not a manual user choice
    );
  }

  /**
   * Load a mapping: parse the XML, run the JS to collect its function prefixes,
   * bind a MidiRouter, and attach to the named input/output device.
   */
  loadMapping(
    xml: string,
    js: string,
    inputName?: string,
    outputName?: string,
    manual = true,
  ): LoadedMapping {
    if (manual) this.userLoaded = true;
    const mapping = parseMidiMapping(xml);

    // Find the device's output for LED feedback.
    const output = outputName ? this.findOutput(outputName) : this.findOutput(mapping.name);
    const send = (status: number, d1: number, d2: number) => {
      output?.send([status, d1, d2]);
    };

    // The `midi` global the scripts use for output.
    const midi = {
      sendShortMsg: (status: number, d1: number, d2: number) => send(status, d1, d2),
      sendSysexMsg: () => {
        /* sysex disabled */
      },
    };

    // Run the mapping JS in a scope with the Mixxx globals (shared, tested
    // runtime). The script defines an object named by its functionPrefix.
    const { functions, prefixObjects } = runMappingScript(js, mapping, this.engine, midi, console);

    const router = new MidiRouter({
      bus: this.bus,
      engine: this.engine,
      mapping,
      scripts: functions,
      send,
    });

    // Attach to the input device.
    const input = inputName ? this.findInput(inputName) : this.findInput(mapping.name);
    let msgCount = 0;
    const onmidi = (e: MIDIMessageEvent) => {
      const d = e.data;
      if (d && d.length >= 3) {
        // Log the first few messages so the user can confirm events ARE arriving,
        // then go quiet (one line per 500 after) to avoid flooding the console.
        if (msgCount < 8 || msgCount % 500 === 0) {
          console.log(
            `[midi] in #${msgCount}: status=0x${d[0]!.toString(16)} d1=${d[1]} d2=${d[2]}`,
          );
        }
        msgCount++;
        router.handleMessage(d[0]!, d[1]!, d[2]!);
      }
    };
    if (input) {
      input.addEventListener('midimessage', onmidi as EventListener);
      console.log(`[midi] mapping "${mapping.name}" attached to input "${input.name}" — listening`);
    } else {
      console.warn(
        `[midi] mapping "${mapping.name}" loaded but NO matching input device found` +
          (inputName ? ` for "${inputName}"` : ` for mapping name "${mapping.name}"`),
      );
    }

    // Call each prefix's init().
    for (const sf of mapping.scriptFiles) {
      prefixObjects[sf.functionPrefix]?.init?.(mapping.name, false);
    }

    this.disposeCurrent();
    this.current = { router, input, output, onmidi };
    return { name: mapping.name, router, mapping };
  }


  private findInput(name: string): MIDIInput | null {
    if (!this.access) return null;
    for (const i of this.access.inputs.values()) {
      if (i.name && (i.name === name || i.name.includes(name) || name.includes(i.name))) {
        return i;
      }
    }
    return null;
  }

  private findOutput(name: string): MIDIOutput | null {
    if (!this.access) return null;
    for (const o of this.access.outputs.values()) {
      if (o.name && (o.name === name || o.name.includes(name) || name.includes(o.name))) {
        return o;
      }
    }
    return null;
  }

  private disposeCurrent(): void {
    if (this.current) {
      this.current.input?.removeEventListener(
        'midimessage',
        this.current.onmidi as EventListener,
      );
      this.current.router.dispose();
      this.current = null;
    }
  }

  dispose(): void {
    this.disposeCurrent();
  }
}
