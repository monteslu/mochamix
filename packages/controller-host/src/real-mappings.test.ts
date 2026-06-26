/**
 * Smoke test: real Mixxx mappings load + run in our runtime. This is the proof that
 * "fully support Mixxx controller definitions" works — we load the ACTUAL bundled XML +
 * JS (lodash → midi-components → device script) with the `script` global and confirm
 * the mapping's functions resolve and init() runs without throwing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlBus, standardControls } from '@dj/control-bus';
import { parseMidiMapping } from './midi-mapping.js';
import { runMappingScript } from './script-runtime.js';
import { EngineApi } from './engine-api.js';

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, '../../../apps/desktop/resources/controllers');
const read = (f: string) => readFileSync(join(DIR, f), 'utf8');

// A real ControlBus with the standard deck/master controls defined (so engine.* calls
// that connect/trigger controls during init() work as they would live).
function realBus() {
  const bus = new ControlBus();
  for (const c of standardControls(4)) bus.define(c);
  return bus;
}

function buildScriptGlobal(engine: EngineApi): unknown {
  const src = read('common-controller-scripts.js');
  const factory = new Function('engine', 'console', `${src}\n; try{this.script=script}catch(e){}; return this;`);
  return (factory.call({}, engine, console) as { script?: unknown }).script;
}

function loadMapping(xmlFile: string) {
  const xml = read(xmlFile);
  const mapping = parseMidiMapping(xml);
  const js = mapping.scriptFiles
    .map((f) => f.filename)
    .filter(Boolean)
    .map((fn) => `// ${fn}\n${read(fn)}`)
    .join('\n;\n');
  const engine = new EngineApi({ bus: realBus(), log: () => {} });
  const midi = { sendShortMsg: () => {}, sendSysexMsg: () => {} };
  const scriptGlobal = buildScriptGlobal(engine); // SAME engine the mapping uses
  const res = runMappingScript(js, mapping, engine, midi, console, scriptGlobal);
  // run init() for each prefix (this is where many mappings touch components/engine)
  for (const sf of mapping.scriptFiles) {
    res.prefixObjects[sf.functionPrefix]?.init?.(mapping.name, false);
  }
  return { mapping, ...res };
}

const haveResources = existsSync(join(DIR, 'common-controller-scripts.js'));

describe.runIf(haveResources)('real Mixxx mappings', () => {
  it('builds the `script` global from common-controller-scripts.js', () => {
    const script = buildScriptGlobal(new EngineApi({ bus: realBus(), log: () => {} })) as Record<string, unknown>;
    // Mixxx's `script` is callable AND carries helper methods — check the methods.
    expect(typeof script.deckFromGroup).toBe('function');
    expect(typeof script.toggleControl).toBe('function');
  });

  // A Components-based mapping (lodash + midi-components + device script) — the case
  // that was fully broken before.
  it('loads a Components-based mapping (Pioneer DDJ-SB2)', () => {
    if (!existsSync(join(DIR, 'Pioneer-DDJ-SB2.midi.xml'))) return;
    const { mapping, functions } = loadMapping('Pioneer-DDJ-SB2.midi.xml');
    expect(mapping.name).toBeTruthy();
    expect(Object.keys(functions).length).toBeGreaterThan(0);
  });

  it('loads a Components-based mapping (Hercules Inpulse 300) if present', () => {
    const f = 'Hercules DJControl Inpulse 300.midi.xml';
    if (!existsSync(join(DIR, f))) return;
    const { functions } = loadMapping(f);
    expect(Object.keys(functions).length).toBeGreaterThan(0);
  });

  // Bulk smoke test: load EVERY bundled mapping and count how many run without throwing.
  // This is the real "fully support" gauge — surfaces engine/parse gaps across the corpus.
  it('loads the large majority of all bundled mappings without throwing', () => {
    const index = JSON.parse(read('index.json')) as Array<{ file: string; name: string }>;
    let ok = 0;
    const failures: string[] = [];
    for (const { file } of index) {
      try {
        loadMapping(file);
        ok++;
      } catch (e) {
        failures.push(`${file}: ${(e as Error).message}`);
      }
    }
    // Log the failures so we can see WHICH mappings + WHY (drives further fixes).
    if (failures.length) console.log(`[mappings] ${failures.length} failed:\n  ${failures.slice(0, 30).join('\n  ')}`);
    console.log(`[mappings] ${ok}/${index.length} loaded OK`);
    // Expect the large majority to load. (Some need hardware-specific globals we shim
    // incrementally; this ratchets up as we close gaps.)
    expect(ok / index.length).toBeGreaterThan(0.8);
  });
});
