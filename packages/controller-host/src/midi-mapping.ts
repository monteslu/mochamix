/**
 * Mixxx `.midi.xml` mapping parser (06-ui-controllers-effects.md §2.3). Parses a
 * controller mapping into a structured form: input controls (status/midino →
 * group/key or a script function) + output bindings (LED feedback) + the script
 * files to load. This is what lets stock Mixxx mappings drive this app.
 *
 * We parse the `<controller>` block: `<scriptfiles>`, `<controls>`, `<outputs>`.
 */

import { XMLParser } from 'fast-xml-parser';

export interface MidiInputControl {
  group: string;
  key: string;
  status: number;
  midino: number;
  options: MidiInputOptions;
  /** True when key is a JS function name (script-binding). */
  isScript: boolean;
}

export interface MidiInputOptions {
  invert?: boolean;
  diff?: boolean;
  rot64?: boolean;
  spread64?: boolean;
  button?: boolean;
  switchMode?: boolean;
  fourteenBit?: boolean;
  script?: boolean;
}

export interface MidiOutputControl {
  group: string;
  key: string;
  status: number;
  midino: number;
  on: number;
  off: number;
  min: number;
  max: number;
}

export interface ScriptFile {
  filename: string;
  functionPrefix: string;
}

export interface MidiMapping {
  name: string;
  author?: string;
  scriptFiles: ScriptFile[];
  controls: MidiInputControl[];
  outputs: MidiOutputControl[];
}

function parseNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (s.startsWith('0x') || s.startsWith('0X')) return parseInt(s, 16);
  return parseInt(s, 10) || 0;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** Parse `<options>` children into flags. */
function parseOptions(opts: Record<string, unknown> | undefined): MidiInputOptions {
  const o: MidiInputOptions = {};
  if (!opts) return o;
  // fast-xml-parser turns empty self-closing tags into empty strings/objects.
  const has = (k: string) => k in opts;
  if (has('invert')) o.invert = true;
  if (has('diff')) o.diff = true;
  if (has('rot64') || has('rot64inv') || has('rot64fast')) o.rot64 = true;
  if (has('spread64')) o.spread64 = true;
  if (has('button')) o.button = true;
  if (has('switch')) o.switchMode = true;
  if (has('fourteen-bit-msb') || has('fourteen-bit-lsb')) o.fourteenBit = true;
  if (has('script-binding') || has('Script-Binding')) o.script = true;
  return o;
}

/**
 * Parse a Mixxx `.midi.xml` string into a MidiMapping. Tolerant of the variety
 * in real mappings (single vs array children, hex vs decimal, case).
 */
export function parseMidiMapping(xml: string): MidiMapping {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: true,
  });
  const doc = parser.parse(xml);
  const preset = doc.MixxxControllerPreset ?? doc.MixxxMIDIPreset ?? {};
  const info = preset.info ?? {};
  const controller = preset.controller ?? {};

  const scriptFiles: ScriptFile[] = asArray(controller.scriptfiles?.file).map((f: any) => ({
    filename: f['@_filename'] ?? '',
    functionPrefix: f['@_functionprefix'] ?? '',
  }));

  const controls: MidiInputControl[] = asArray(controller.controls?.control).map((c: any) => {
    const options = parseOptions(c.options);
    return {
      group: String(c.group ?? ''),
      key: String(c.key ?? ''),
      status: parseNumber(c.status),
      midino: parseNumber(c.midino),
      options,
      isScript: !!options.script,
    };
  });

  const outputs: MidiOutputControl[] = asArray(controller.outputs?.output).map((o: any) => ({
    group: String(o.group ?? ''),
    key: String(o.key ?? ''),
    status: parseNumber(o.status),
    midino: parseNumber(o.midino),
    on: o.on !== undefined ? parseNumber(o.on) : 0x7f,
    off: o.off !== undefined ? parseNumber(o.off) : 0x00,
    min: o.minimum !== undefined ? Number(o.minimum) : 0,
    max: o.maximum !== undefined ? Number(o.maximum) : 1,
  }));

  return {
    name: String(info['@_name'] ?? info.name ?? 'Unnamed'),
    author: info['@_author'] ?? info.author,
    scriptFiles,
    controls,
    outputs,
  };
}

/** A key for the status+midino pair (for input dispatch lookup). */
export function midiKey(status: number, midino: number): number {
  return (status << 8) | midino;
}
