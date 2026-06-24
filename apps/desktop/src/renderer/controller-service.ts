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
} from '@internal-dj/controller-host';
import type { ControlBus } from '@internal-dj/control-bus';

export interface LoadedMapping {
  name: string;
  router: MidiRouter;
  mapping: MidiMapping;
}

export class ControllerService {
  private readonly engine: EngineApi;
  private access: MIDIAccess | null = null;
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
      throw new Error('Web MIDI not available');
    }
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    return {
      inputs: [...this.access.inputs.values()].map((i) => i.name ?? 'unknown'),
      outputs: [...this.access.outputs.values()].map((o) => o.name ?? 'unknown'),
    };
  }

  /**
   * Load a mapping: parse the XML, run the JS to collect its function prefixes,
   * bind a MidiRouter, and attach to the named input/output device.
   */
  loadMapping(xml: string, js: string, inputName?: string, outputName?: string): LoadedMapping {
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
    const onmidi = (e: MIDIMessageEvent) => {
      const d = e.data;
      if (d && d.length >= 3) {
        router.handleMessage(d[0]!, d[1]!, d[2]!);
      }
    };
    if (input) {
      input.addEventListener('midimessage', onmidi as EventListener);
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
