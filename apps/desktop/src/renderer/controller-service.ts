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

// Words that appear in OS-assigned MIDI port names but carry no device identity, so
// they must not count toward a match (else "Numark DJ2GO2 Touch" vs "DJ2GO2 Touch
// MIDI 1" would only share the meaningless "touch"/"midi"). Pure numbers (port
// indices like the "1" in "… MIDI 1") are dropped too.
const NOISE_TOKENS = new Set(['midi', 'port', 'in', 'out', 'input', 'output', 'device', 'usb']);

/** Significant identity tokens of a device/mapping name (lowercased, alnum, de-noised). */
export function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !NOISE_TOKENS.has(t) && !/^\d+$/.test(t));
}

/**
 * A virtual/loopback port (ALSA "Midi Through", IAC, "Network", etc.) — never a real
 * controller, so auto-connect must skip it. (Users can still pick one manually.)
 */
export function isVirtualPort(name: string | null | undefined): boolean {
  if (!name) return false;
  return /\b(midi through|through port|iac|loopmidi|network|virtual)\b/i.test(name);
}

/**
 * Match a MIDI port to a requested name. Exact (case-insensitive) wins; otherwise the
 * port matches if it shares a significant identity token with the requested name — so a
 * mapping named "Numark DJ2GO2 Touch" binds to the OS device "DJ2GO2 Touch MIDI 1"
 * (shared token "dj2go2"), which plain substring matching missed. Prefers the candidate
 * with the most shared tokens.
 */
export function matchPort<T extends { name: string | null }>(ports: T[], name: string): T | null {
  const want = name.toLowerCase();
  const exact = ports.find((p) => p.name && p.name.toLowerCase() === want);
  if (exact) return exact;
  const wantTokens = new Set(nameTokens(name));
  if (wantTokens.size === 0) return null;
  let best: T | null = null;
  let bestScore = 0;
  for (const p of ports) {
    if (!p.name) continue;
    const score = nameTokens(p.name).filter((t) => wantTokens.has(t)).length;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

export class ControllerService {
  private readonly engine: EngineApi;
  private access: MIDIAccess | null = null;
  /** True once the user manually picked a mapping (auto-connect then stays out of the way). */
  private userLoaded = false;
  /** Guards the one-time statechange hook for auto-connect. */
  private autoHooked = false;
  /** Cached Mixxx `script` helper global (common-controller-scripts.js), built once. */
  private scriptGlobalCache: unknown = null;
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
    // Restore the user's saved mapping first, so their controller setup survives a
    // restart instead of falling back to Generic. Only if there's no saved choice do
    // we auto-connect Generic to a connected controller.
    await this.restoreSavedMapping();
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

  /**
   * On launch, reload the controller mapping the user last chose (persisted in
   * userData). Marks userLoaded so auto-connect won't override it. No-op if nothing
   * was saved, the dj bridge is absent (browser mode), or the load fails.
   */
  private async restoreSavedMapping(): Promise<void> {
    if (this.userLoaded) return;
    let saved: { mapping: string; device: string | null } | null;
    try {
      saved = (await window.dj?.controllerConfigGet?.()) ?? null;
    } catch {
      return;
    }
    if (!saved?.mapping) return;
    try {
      if (saved.mapping === 'generic') {
        this.loadMapping(
          GENERIC_MIDI_XML,
          GENERIC_MIDI_JS,
          saved.device ?? undefined,
          saved.device ?? undefined,
          true, // restore counts as the user's choice → don't auto-override
        );
        console.log(`[midi] restored saved mapping "Generic MIDI"${saved.device ? ` on ${saved.device}` : ''}`);
      } else {
        const res = await this.loadMixxxMapping(saved.mapping, true, saved.device ?? undefined);
        if (res) {
          console.log(`[midi] restored saved mapping "${res.name}"${saved.device ? ` on ${saved.device}` : ''}`);
        } else {
          console.warn(`[midi] saved mapping "${saved.mapping}" could not be restored`);
          this.userLoaded = false; // let auto-connect try instead
        }
      }
    } catch (e) {
      console.warn('[midi] failed to restore saved mapping', e);
      this.userLoaded = false;
    }
  }

  private attachGenericToFirstInput(): void {
    if (!this.access) return;
    // Prefer a REAL controller. ALSA exposes "Midi Through Port-0" (a virtual loopback)
    // which is usually first in the list — auto-connecting to it does nothing useful.
    // Skip virtual/through ports; only fall back to one if nothing else is connected.
    const connected = [...this.access.inputs.values()].filter((i) => i.state === 'connected');
    const first = connected.find((i) => !isVirtualPort(i.name)) ?? connected[0];
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
    scriptGlobal?: unknown,
  ): LoadedMapping {
    if (manual) this.userLoaded = true;
    const mapping = parseMidiMapping(xml);
    // Make the mapping's <settings> defaults available to engine.getSetting before the
    // script runs (scripts branch on these at init).
    this.engine.setMappingSettings(mapping.settings);

    // Find the device's output for LED feedback.
    const output = outputName ? this.findOutput(outputName) : this.findOutput(mapping.name);
    const send = (status: number, d1: number, d2: number) => {
      output?.send([status, d1, d2]);
    };

    // The `midi` global the scripts use for output (incl. sysex for device init/LEDs).
    const sysexOut = outputName ? this.findOutput(outputName) : output;
    const midi = {
      sendShortMsg: (status: number, d1: number, d2: number) => send(status, d1, d2),
      sendSysexMsg: (data: number[]) => {
        try {
          sysexOut?.send(data);
        } catch {
          /* device may reject malformed sysex; ignore */
        }
      },
    };

    // Run the mapping JS (already concatenated: lodash → midi-components → device
    // script) in a scope with the Mixxx globals. `scriptGlobal` is the common-
    // controller-scripts.js `script` helper object (or {} for the simple generic map).
    const { functions, prefixObjects } = runMappingScript(
      js,
      mapping,
      this.engine,
      midi,
      console,
      scriptGlobal,
    );

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

  /**
   * Load one of the BUNDLED Mixxx mappings by its .midi.xml filename. Reads the XML,
   * resolves its <file> list (lodash.mixxx.js → midi-components-0.0.js → device script,
   * in order), concatenates them, builds the `script` helper global from
   * common-controller-scripts.js, and runs them all in one scope — exactly the global
   * environment a Mixxx mapping expects. Their mappings ARE JavaScript, so they run
   * nearly verbatim once the globals are right. `manual` marks a user choice.
   */
  async loadMixxxMapping(
    xmlFilename: string,
    manual = true,
    deviceName?: string,
  ): Promise<LoadedMapping | null> {
    const xml = await window.dj.controllersReadFile(xmlFilename);
    if (!xml) {
      console.warn(`[midi] mapping file not found: ${xmlFilename}`);
      return null;
    }
    // Parse just to discover the <file> list (full parse happens in loadMapping too).
    const mapping = parseMidiMapping(xml);
    const fileNames = mapping.scriptFiles.map((f) => f.filename).filter(Boolean);

    // Read + concatenate every referenced script file IN ORDER (helpers first). Missing
    // files are skipped with a warning (some mappings reference files we don't ship).
    const parts: string[] = [];
    for (const fn of fileNames) {
      const content = await window.dj.controllersReadFile(fn);
      if (content) parts.push(`// ==== ${fn} ====\n${content}`);
      else console.warn(`[midi] referenced script not found: ${fn}`);
    }
    const js = parts.join('\n;\n');

    const scriptGlobal = await this.buildScriptGlobal();
    console.log(
      `[midi] loading Mixxx mapping "${mapping.name}" (${fileNames.length} script file(s))`,
    );
    // Bind to the user's explicitly-picked device when given; else fall back to
    // matching the mapping name against connected devices (token match).
    return this.loadMapping(xml, js, deviceName, deviceName, manual, scriptGlobal);
  }

  /**
   * Build the Mixxx `script` global by running common-controller-scripts.js (it defines
   * `var script = {}; script.foo = …`). Cached — it's the same for every mapping.
   */
  private async buildScriptGlobal(): Promise<unknown> {
    if (this.scriptGlobalCache) return this.scriptGlobalCache;
    const src = await window.dj.controllersReadFile('common-controller-scripts.js');
    if (!src) {
      console.warn('[midi] common-controller-scripts.js not found — `script` helpers unavailable');
      this.scriptGlobalCache = {};
      return this.scriptGlobalCache;
    }
    try {
      // Run it in a scope with engine/console; recover the `script` object via `this`.
      const factory = new Function(
        'engine',
        'console',
        `${src}\n; try { this.script = script; } catch(e){} ; return this;`,
      );
      const out = factory.call({}, this.engine, console) as { script?: unknown };
      this.scriptGlobalCache = out.script ?? {};
    } catch (e) {
      console.warn('[midi] failed to build `script` global', e);
      this.scriptGlobalCache = {};
    }
    return this.scriptGlobalCache;
  }


  private findInput(name: string): MIDIInput | null {
    return matchPort([...(this.access?.inputs.values() ?? [])], name);
  }

  private findOutput(name: string): MIDIOutput | null {
    return matchPort([...(this.access?.outputs.values() ?? [])], name);
  }

  private disposeCurrent(): void {
    if (this.current) {
      this.current.input?.removeEventListener(
        'midimessage',
        this.current.onmidi as EventListener,
      );
      this.current.router.dispose();
      // Stop the old mapping's LED-refresh / one-shot timers. router.dispose() only
      // releases control→LED connections; engine timers started in init() would
      // otherwise keep firing against the stale (possibly disconnected) device after a
      // mapping switch. The next mapping re-creates its own timers in its init().
      this.engine.stopAllTimers();
      this.current = null;
    }
  }

  dispose(): void {
    this.disposeCurrent();
  }
}
