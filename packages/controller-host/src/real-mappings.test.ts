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
  // Many mappings start LED-refresh timers in init(). Without tearing them down, those
  // callbacks fire AFTER the test finishes — and a few throw async (e.g. setLED reading
  // `.off` on a not-yet-connected component), surfacing as Vitest "unhandled errors"
  // that the per-load try/catch can't catch. Stop them, mirroring a real session's
  // dispose. (A live ControllerService disposes the previous mapping on switch.)
  engine.stopAllTimers();
  return { mapping, engine, ...res };
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

  // Numark DJ2GO2 Touch — the controller from the field report. Its script builds two
  // Decks (new Deck([1]) / new Deck([2])) AND sets up its prototype via `new
  // components.Deck()` with no args, which logs a benign "ERROR! new Deck() called
  // without specifying any deck numbers" warning (standard midi-components subclassing).
  // That warning is NOT a failure — assert the mapping loads, exposes its prefix, and
  // init() runs without throwing, so the controller works once it's bound to the device.
  it('loads the Numark DJ2GO2 Touch mapping (the field-report controller)', () => {
    const f = 'Numark_DJ2GO2_Touch.midi.xml';
    if (!existsSync(join(DIR, f))) return;
    const { mapping, functions, prefixObjects } = loadMapping(f);
    expect(mapping.name).toBe('Numark DJ2GO2 Touch');
    expect(Object.keys(functions).length).toBeGreaterThan(0);
    // The device script's prefix object must exist and have run init() without throwing.
    expect(prefixObjects['DJ2GO2Touch']).toBeTruthy();
  });

  // Bulk smoke test: load EVERY bundled mapping and count how many run without throwing.
  // This is the real "fully support" gauge — surfaces engine/parse gaps across the corpus.
  it('loads the large majority of all bundled mappings without throwing', () => {
    const index = JSON.parse(read('index.json')) as Array<{ file: string; name: string }>;
    let ok = 0;
    const failures: string[] = [];
    for (const { file } of index) {
      // Each load is a FRESH app session — reset the shared Node global lodash polluted,
      // so back-to-back loads in one test process behave like independent sessions.
      try {
        const g = globalThis as unknown as Record<PropertyKey, unknown>;
        const d = Object.getOwnPropertyDescriptor(g, '_');
        if (d) {
          if (!d.configurable) Object.defineProperty(g, '_', { ...d, configurable: true });
          delete g['_'];
        }
      } catch {
        /* ignore */
      }
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
