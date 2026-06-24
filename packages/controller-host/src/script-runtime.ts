/**
 * Mapping script runtime — runs a Mixxx mapping's JS in a scope with the
 * `engine`/`midi`/`console` globals and resolves its callable functions. This is
 * the genuinely novel/risky piece of the controller host (running untrusted Mixxx
 * mapping code), extracted from the renderer ControllerService so it's pure and
 * unit-testable (no Web MIDI dependency).
 *
 * Mixxx mappings define an object named by their `functionprefix` (e.g.
 * `var PioneerDDJFLX4 = {}; PioneerDDJFLX4.playPress = function(...){...}`) and
 * reference its methods by dotted name in the XML `<key>`. We execute the JS in a
 * Function scope closing over the globals, then resolve those dotted names.
 *
 * SECURITY NOTE: `new Function` runs the mapping with full scope access. Mixxx
 * mappings are community code from res/controllers; for untrusted mappings, run
 * this inside a worker/realm. The globals we inject (engine/midi/console) are the
 * only intended surface.
 */

import type { EngineApi } from './engine-api.js';
import type { MidiMapping } from './midi-mapping.js';
import type { ScriptFunctions } from './midi-router.js';

export interface MidiGlobal {
  sendShortMsg(status: number, d1: number, d2: number): void;
  sendSysexMsg(data: number[], length?: number): void;
}

export interface RunMappingResult {
  /** Resolved input-handler functions, keyed by their dotted control name. */
  functions: ScriptFunctions;
  /** The functionprefix objects (for init()/shutdown()). */
  prefixObjects: Record<string, { init?: (name: string, debug: boolean) => void; shutdown?: () => void }>;
}

/**
 * Execute mapping JS and resolve the functions the mapping's controls reference.
 * `globalScope` is an object the script's `var Prefix = {}` declarations attach
 * to (we use a fresh object as the `this`/globalThis-like surface).
 */
export function runMappingScript(
  js: string,
  mapping: MidiMapping,
  engine: EngineApi,
  midi: MidiGlobal,
  logger: Console = console,
): RunMappingResult {
  // A surface the script's top-level `var X = ...` / `X = ...` attach to. We run
  // the script with `this` = scope and also pass it as a parameter the script
  // body can see via a `with`-free convention: most mappings do `var Prefix={}`,
  // which in non-strict Function scope becomes a local — so we capture by
  // returning `this` after assigning known prefixes onto it.
  const scope: Record<string, unknown> = {};

  // Build a preamble that, after the script runs, copies each functionprefix
  // local into the scope object so we can read them back out.
  const prefixes = mapping.scriptFiles.map((f) => f.functionPrefix).filter(Boolean);
  const exporter = prefixes
    .map((p) => `try { this[${JSON.stringify(p)}] = ${p}; } catch (e) {}`)
    .join('\n');

  const factory = new Function(
    'engine',
    'midi',
    'console',
    `${js}\n;${exporter}\n; return this;`,
  );
  const result = factory.call(scope, engine, midi, logger) as Record<string, unknown>;

  const resolveFn = (path: string): ((...a: Array<number | string>) => void) | undefined => {
    const parts = path.split('.');
    let obj: unknown = result;
    for (const p of parts) {
      if (obj && typeof obj === 'object' && p in (obj as Record<string, unknown>)) {
        obj = (obj as Record<string, unknown>)[p];
      } else {
        return undefined;
      }
    }
    return typeof obj === 'function' ? (obj as (...a: Array<number | string>) => void) : undefined;
  };

  const functions: ScriptFunctions = {};
  for (const c of mapping.controls) {
    if (c.isScript) {
      const fn = resolveFn(c.key);
      if (fn) {
        functions[c.key] = fn;
      }
    }
  }

  const prefixObjects: RunMappingResult['prefixObjects'] = {};
  for (const p of prefixes) {
    const obj = result[p];
    if (obj && typeof obj === 'object') {
      prefixObjects[p] = obj as { init?: (n: string, d: boolean) => void; shutdown?: () => void };
    }
  }

  return { functions, prefixObjects };
}
