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
  /** The `script` global (Mixxx common-controller-scripts.js helpers), if provided. */
  scriptGlobal?: unknown,
): RunMappingResult {
  // A surface the script's top-level `var X = ...` / `X = ...` attach to, AND the
  // `this`/global that helper libraries attach to: lodash sets `this._`, and
  // midi-components-0.0.js ends with `global.components = exports` (global === this).
  // So running ALL files (lodash → midi-components → device script) in this one scope
  // makes `_` and `components` available to the device script exactly as in Mixxx.
  // lodash.mixxx defines `_` on the global object via a NON-configurable getter
  // (root = freeGlobal || freeSelf || (function(){return this})()). When a 2nd lodash-
  // based mapping loads, redefining `_` throws "Cannot redefine property: _". We force
  // any `_` definition to be configurable (so it can be redefined) by patching
  // Object.defineProperty for the duration of the run, then restore it. This keeps each
  // mapping load independent without polluting/locking the host global.
  const realDefineProperty = Object.defineProperty;
  const patchedDefineProperty = function (
    obj: object,
    prop: PropertyKey,
    desc: PropertyDescriptor,
  ): object {
    if (prop === '_') desc = { ...desc, configurable: true };
    return realDefineProperty(obj, prop, desc);
  };
  // Best-effort: if the host global already has a locked `_`, try to relax it.
  try {
    const host = globalThis as unknown as Record<PropertyKey, unknown>;
    const d = Object.getOwnPropertyDescriptor(host, '_');
    if (d && !d.configurable) realDefineProperty(host, '_', { ...d, configurable: true });
  } catch {
    /* ignore */
  }
  Object.defineProperty = patchedDefineProperty as typeof Object.defineProperty;

  const scope: Record<string, unknown> = {};
  // Pre-seed CONFIGURABLE placeholders for the globals helper libs define via
  // Object.defineProperty (lodash does `defineProperty(root,"_",…)` which is
  // non-configurable by default → a redefine throws "Cannot redefine property: _").
  // Seeding them configurable lets the libs (re)define cleanly.
  for (const g of ['_', 'components', 'ColorMapper', 'Controller', 'HIDController']) {
    Object.defineProperty(scope, g, { value: undefined, writable: true, configurable: true });
  }
  // Mixxx globals some mappings call directly (shims — fine per the design).
  scope.print = (...args: unknown[]) => logger.log('[mapping]', ...args);
  // `Controller` / `ColorMapper` / `HIDController` are Mixxx engine globals for HID/bulk
  // and LED color mapping. Provide minimal shims so MIDI mappings that merely REFERENCE
  // them at load time don't crash (full HID is out of scope for Web MIDI).
  if (scope.ColorMapper === undefined) {
    scope.ColorMapper = class {
      getValueForNearestColor(): number {
        return 0;
      }
      getNearestColor(): number {
        return 0;
      }
    };
  }
  if (scope.Controller === undefined) {
    // Some mappings do `new Controller()` — make it constructable (HID/bulk shim).
    scope.Controller = class {
      getValue(): number {
        return 0;
      }
      setValue(): void {}
    };
  }

  // Build a preamble that, after the script runs, copies each functionprefix
  // local into the scope object so we can read them back out.
  const prefixes = mapping.scriptFiles.map((f) => f.functionPrefix).filter(Boolean);
  const exporter = prefixes
    .map((p) => `try { this[${JSON.stringify(p)}] = ${p}; } catch (e) {}`)
    .join('\n');

  // `script` is a Mixxx global (common-controller-scripts.js). Many mappings AND
  // midi-components depend on it. Pass it as a parameter so it's in scope.
  //
  // The helper libs (lodash.mixxx.js, midi-components-0.0.js) do `global.X = …` where
  // `global === this` — so they attach `_` and `components` onto our `this` (scope) at
  // RUNTIME. A `with(this)` block makes those bare identifiers (`components`, `_`)
  // resolve from the scope object for the device script that follows, exactly as Mixxx's
  // single global object does. (`with` is the correct tool for a dynamic global object.)
  //
  const body = `with (this) {\n${js}\n;${exporter}\n} return this;`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function('engine', 'midi', 'console', 'script', body);
  let result: Record<string, unknown>;
  try {
    result = factory.call(scope, engine, midi, logger, scriptGlobal ?? {}) as Record<string, unknown>;
  } finally {
    Object.defineProperty = realDefineProperty; // restore
  }

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
