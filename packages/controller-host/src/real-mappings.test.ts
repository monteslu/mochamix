/**
 * Smoke test: real Mixxx mappings load + run in our runtime. This is the proof that
 * "fully support Mixxx controller definitions" works — we load the ACTUAL bundled XML +
 * JS (lodash → midi-components → device script) with the `script` global and confirm
 * the mapping's functions resolve and init() runs without throwing.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlBus, standardControls } from '@dj/control-bus';
import { parseMidiMapping } from './midi-mapping.js';
import { runMappingScript } from './script-runtime.js';
import { MidiRouter } from './midi-router.js';
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
    const { mapping, resolveHandler } = loadMapping('Pioneer-DDJ-SB2.midi.xml');
    expect(mapping.name).toBeTruthy();
    // At least one of the mapping's <key> controls must resolve to a handler.
    const someScript = mapping.controls.find((c) => c.isScript);
    expect(someScript).toBeTruthy();
    expect(typeof resolveHandler(someScript!.key)).toBe('function');
  });

  it('loads a Components-based mapping (Hercules Inpulse 300) if present', () => {
    const f = 'Hercules DJControl Inpulse 300.midi.xml';
    if (!existsSync(join(DIR, f))) return;
    const { mapping, resolveHandler } = loadMapping(f);
    const someScript = mapping.controls.find((c) => c.isScript);
    expect(typeof resolveHandler(someScript!.key)).toBe('function');
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
    const { mapping, prefixObjects } = loadMapping(f);
    expect(mapping.name).toBe('Numark DJ2GO2 Touch');
    // The device script's prefix object must exist and have run init() without throwing.
    expect(prefixObjects['DJ2GO2Touch']).toBeTruthy();
  });

  // THE field bug: the controller did nothing because handlers for components created in
  // init() (playButton, cueButton, faders, hotcueButtons[n]) couldn't be resolved — they
  // were looked up at LOAD time, before init() built them, so they were undefined and the
  // router never dispatched them. Only top-level browseEncoder ever fired. These tests
  // prove the LAZY resolver finds an init()-built handler AND that it's bound to its
  // component (this.onKnobEvent / this.* work).
  it('DJ2GO2: resolves a handler on a component built in init() (play button)', () => {
    const f = 'Numark_DJ2GO2_Touch.midi.xml';
    if (!existsSync(join(DIR, f))) return;
    const { mapping, resolveHandler } = loadMapping(f);
    // playButton.input is created inside the Deck constructor (called from init()).
    expect(mapping.controls.some((c) => c.key === 'DJ2GO2Touch.leftDeck.playButton.input')).toBe(
      true,
    );
    // Eager resolution would have returned undefined here (the old bug). Lazy works.
    expect(typeof resolveHandler('DJ2GO2Touch.leftDeck.playButton.input')).toBe('function');
    // And a hotcue button addressed by ARRAY INDEX resolves too (path parser handles [n]).
    expect(typeof resolveHandler('DJ2GO2Touch.leftDeck.hotcueButtons[1].input')).toBe('function');
  });

  it('DJ2GO2: browse-knob handler is bound to its component (this.onKnobEvent works)', () => {
    const f = 'Numark_DJ2GO2_Touch.midi.xml';
    if (!existsSync(join(DIR, f))) return;
    const xml = read(f);
    const mapping = parseMidiMapping(xml);
    const js = mapping.scriptFiles
      .map((sf) => sf.filename)
      .filter(Boolean)
      .map((fn) => `// ${fn}\n${read(fn)}`)
      .join('\n;\n');
    const bus = realBus();
    bus.define({ group: '[Playlist]', key: 'SelectTrackKnob', default: 0 });
    const engine = new EngineApi({ bus, log: () => {} });
    const setValue = vi.spyOn(engine, 'setValue');
    const midi = { sendShortMsg: () => {}, sendSysexMsg: () => {} };
    const { resolveHandler, prefixObjects } = runMappingScript(
      js,
      mapping,
      engine,
      midi,
      console,
      buildScriptGlobal(engine),
    );
    // init() builds the decks; the lazy resolver must see post-init objects.
    prefixObjects['DJ2GO2Touch']?.init?.('DJ2GO2 Touch', false);
    engine.stopAllTimers();

    const browse = resolveHandler('DJ2GO2Touch.browseEncoder.input');
    expect(typeof browse).toBe('function');
    // status 0xBF, value 0x01 → rotateValue +1 → onKnobEvent → [Playlist] SelectTrackKnob
    expect(() => browse!(0x0f, 0x00, 0x01, 0xbf, '[Playlist]')).not.toThrow();
    expect(setValue).toHaveBeenCalledWith('[Playlist]', 'SelectTrackKnob', 1);
  });

  // FULL chain, no hardware: a real play-button MIDI message routed through MidiRouter
  // must flip [Channel1] play on the bus — resolve(lazy) → component.input → engine →
  // bus. This is the end-to-end proof the controller actually drives a deck. The play
  // button is note 0x90/0x00 in the DJ2GO2 XML (the very first message in the field log).
  it('DJ2GO2: pressing play routes through MidiRouter and flips [Channel1] play', () => {
    const f = 'Numark_DJ2GO2_Touch.midi.xml';
    if (!existsSync(join(DIR, f))) return;
    const xml = read(f);
    const mapping = parseMidiMapping(xml);
    const js = mapping.scriptFiles
      .map((sf) => sf.filename)
      .filter(Boolean)
      .map((fn) => `// ${fn}\n${read(fn)}`)
      .join('\n;\n');
    const bus = realBus();
    const engine = new EngineApi({ bus, log: () => {} });
    const midi = { sendShortMsg: () => {}, sendSysexMsg: () => {} };
    const { resolveHandler, prefixObjects } = runMappingScript(
      js,
      mapping,
      engine,
      midi,
      console,
      buildScriptGlobal(engine),
    );
    prefixObjects['DJ2GO2Touch']?.init?.('DJ2GO2 Touch', false); // builds the decks
    engine.stopAllTimers();

    const router = new MidiRouter({ bus, engine, mapping, scripts: {}, resolveScript: resolveHandler, send: () => {} });

    expect(bus.get('[Channel1]', 'play')).toBe(0);
    // Note-on for the left-deck play button: status 0x90, note 0x00, velocity 127.
    // PlayButton is a toggle; midi-components writes a boolean via inSetValue, which the
    // engine coerces to a NUMBER (Mixxx ControlObjects are doubles; audio reads play>0.5).
    router.handleMessage(0x90, 0x00, 127);
    expect(bus.get('[Channel1]', 'play')).toBe(1); // it PLAYS (numeric, not boolean)
    router.handleMessage(0x90, 0x00, 127); // toggle button → press again
    expect(bus.get('[Channel1]', 'play')).toBe(0); // it STOPS
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
