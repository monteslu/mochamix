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
  fourteenBitMsb?: boolean;
  fourteenBitLsb?: boolean;
  softTakeover?: boolean;
  selectKnob?: boolean;
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
  /** Mapping <settings> defaults (variable → default value), read via engine.getSetting. */
  settings: Record<string, string | number | boolean>;
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
  // fast-xml-parser turns empty self-closing tags into empty strings/objects. Match
  // option names CASE-INSENSITIVELY — Mixxx mappings use mixed case (<Script-binding/>,
  // <Spread64/>, <Soft-takeover/>, <Button/>, etc.) and a case-sensitive check drops them.
  const keys = new Set(Object.keys(opts).map((k) => k.toLowerCase()));
  const has = (k: string) => keys.has(k.toLowerCase());
  if (has('invert')) o.invert = true;
  if (has('diff')) o.diff = true;
  if (has('rot64') || has('rot64inv') || has('rot64fast')) o.rot64 = true;
  if (has('spread64')) o.spread64 = true;
  if (has('button')) o.button = true;
  if (has('switch')) o.switchMode = true;
  if (has('soft-takeover')) o.softTakeover = true;
  if (has('selectknob')) o.selectKnob = true;
  if (has('fourteen-bit-msb')) o.fourteenBit = o.fourteenBitMsb = true;
  if (has('fourteen-bit-lsb')) o.fourteenBit = o.fourteenBitLsb = true;
  if (has('script-binding')) o.script = true;
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
    settings: parseSettings(preset.settings),
  };
}

/**
 * Parse the <settings> block into { variable: defaultValue }. Mixxx mapping prefs:
 *   <option variable="x" type="enum"><value default="true">a</value><value>b</value></option>
 *   <option variable="y" type="boolean" default="true"/>
 *   <option variable="z" type="integer" default="3"/>
 * Scripts read these via engine.getSetting(variable); without the defaults they'd branch
 * on undefined. (The user can't yet change them — that's the settings UI, later.)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseSettings(settings: any): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!settings) return out;
  // <option> can be nested under <group> or directly; gather all of them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const options: any[] = [
    ...asArray(settings.option),
    ...asArray(settings.group).flatMap((g: any) => asArray(g.option)),
  ];
  for (const opt of options) {
    const variable = opt['@_variable'];
    if (!variable) continue;
    const type = String(opt['@_type'] ?? '').toLowerCase();
    if (opt['@_default'] !== undefined) {
      const d = opt['@_default'];
      if (type === 'boolean') out[variable] = d === 'true' || d === '1';
      else if (type === 'integer' || type === 'real') out[variable] = Number(d);
      else out[variable] = String(d);
    } else if (opt.value !== undefined) {
      // enum: the <value default="true"> wins, else the first value.
      const values = asArray(opt.value);
      const def = values.find((v: any) => v['@_default'] === 'true') ?? values[0];
      if (def !== undefined) out[variable] = typeof def === 'object' ? (def['#text'] ?? '') : String(def);
    }
  }
  return out;
}

/** A key for the status+midino pair (for input dispatch lookup). */
export function midiKey(status: number, midino: number): number {
  return (status << 8) | midino;
}

/** Escape XML text/attribute content. */
function xmlEsc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function hex(n: number): string {
  return '0x' + n.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Serialize a MidiMapping back to a Mixxx-format .midi.xml string. Used by the in-app
 * editor (clone + customize) so user mappings stay in the standard portable format.
 * Round-trips the structure we parse: info, scriptfiles, controls, outputs.
 */
export function serializeMapping(m: MidiMapping): string {
  const optionTag = (o: MidiInputOptions): string => {
    const tags: string[] = [];
    if (o.script) tags.push('<script-binding/>');
    if (o.invert) tags.push('<invert/>');
    if (o.diff) tags.push('<diff/>');
    if (o.rot64) tags.push('<rot64/>');
    if (o.spread64) tags.push('<spread64/>');
    if (o.button) tags.push('<button/>');
    if (o.switchMode) tags.push('<switch/>');
    if (o.softTakeover) tags.push('<soft-takeover/>');
    if (o.selectKnob) tags.push('<selectknob/>');
    if (o.fourteenBitMsb) tags.push('<fourteen-bit-msb/>');
    if (o.fourteenBitLsb) tags.push('<fourteen-bit-lsb/>');
    return tags.length ? `<options>${tags.join('')}</options>` : '<options/>';
  };
  const controls = m.controls
    .map(
      (c) =>
        `      <control>\n` +
        `        <group>${xmlEsc(c.group)}</group>\n` +
        `        <key>${xmlEsc(c.key)}</key>\n` +
        `        <status>${hex(c.status)}</status>\n` +
        `        <midino>${hex(c.midino)}</midino>\n` +
        `        ${optionTag(c.options)}\n` +
        `      </control>`,
    )
    .join('\n');
  const outputs = m.outputs
    .map(
      (o) =>
        `      <output>\n` +
        `        <group>${xmlEsc(o.group)}</group>\n` +
        `        <key>${xmlEsc(o.key)}</key>\n` +
        `        <status>${hex(o.status)}</status>\n` +
        `        <midino>${hex(o.midino)}</midino>\n` +
        `        <on>${hex(o.on)}</on>\n` +
        `        <off>${hex(o.off)}</off>\n` +
        `        <minimum>${o.min}</minimum>\n` +
        `      </output>`,
    )
    .join('\n');
  const files = m.scriptFiles
    .map((f) =>
      f.functionPrefix
        ? `      <file functionprefix="${xmlEsc(f.functionPrefix)}" filename="${xmlEsc(f.filename)}"/>`
        : `      <file filename="${xmlEsc(f.filename)}"/>`,
    )
    .join('\n');
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<MixxxControllerPreset mixxxVersion="" schemaVersion="1">\n` +
    `  <info>\n    <name>${xmlEsc(m.name)}</name>\n    <author>${xmlEsc(m.author ?? '')}</author>\n  </info>\n` +
    `  <controller id="${xmlEsc(m.name)}">\n` +
    `    <scriptfiles>\n${files}\n    </scriptfiles>\n` +
    `    <controls>\n${controls}\n    </controls>\n` +
    `    <outputs>\n${outputs}\n    </outputs>\n` +
    `  </controller>\n` +
    `</MixxxControllerPreset>\n`
  );
}
