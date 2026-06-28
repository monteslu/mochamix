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
  /** Eagerly-resolved handlers (kept for back-compat; empty now — see resolveHandler). */
  functions: ScriptFunctions;
  /**
   * Resolve a control's `<key>` path to its handler, BOUND to its parent component, at
   * call time (lazy). Use this from the router per message: components created in init()
   * (playButton, faders, hotcueButtons[n], …) only exist after init() runs, so handlers
   * must be looked up on demand, not snapshotted at load.
   */
  resolveHandler: (path: string) => ((...a: Array<number | string>) => void) | undefined;
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
  // Clear any stale `_` from a PRIOR mapping load on the host global so lodash defines a
  // fresh one for this mapping (our patch keeps it configurable, so the delete works).
  // Without this, a second lodash-based mapping inherits the first's `_` closure and its
  // methods read as undefined. (App sessions are fresh; this matters for back-to-back
  // loads / the bulk test.)
  try {
    const host = globalThis as unknown as Record<PropertyKey, unknown>;
    const d = Object.getOwnPropertyDescriptor(host, '_');
    if (d) {
      if (!d.configurable) realDefineProperty(host, '_', { ...d, configurable: true });
      delete host['_'];
    }
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
  // NOTE: a handful of OLD pre-Components mappings (American Audio VMS2/VMS4, Hercules
  // DJ Console RMX, Numark NS7, Stanton SCS) reference bare global classes
  // (Button/Deck/Pot) AND build deep custom class hierarchies (addButton, illuminate,
  // Decks.Left…) on top of removed Mixxx globals. Faithfully shimming those would mean
  // reimplementing each device's class API — out of scope. They simply don't load; the
  // 126 that DO cover all modern/common controllers. (Deliberately NOT shimming Button/
  // Deck globally — it would shadow components.* for the working mappings.)

  // Build a preamble that, after the script runs, copies each functionprefix
  // local into the scope object so we can read them back out.
  const prefixes = mapping.scriptFiles.map((f) => f.functionPrefix).filter(Boolean);
  const exporter = prefixes
    .map((p) => `try { this[${JSON.stringify(p)}] = ${p}; } catch (e) {}`)
    .join('\n');

  // `script` is a Mixxx global (common-controller-scripts.js). Many mappings AND
  // midi-components depend on it. Pass it as a parameter so it's in scope.
  //
  // The helper libs are written for ONE global object. lodash.mixxx.js resolves its root
  // via `Function('return this')()` → the HOST global (globalThis), and defines `_`
  // there; midi-components does `global.components = …` (global === our `this`). So `_`
  // lands on globalThis while `components`/prefixes land on our scope. To present the
  // device script with a SINGLE global where both resolve, we run inside `with(proxy)`:
  // reads fall through scope → globalThis (so `_`, `components`, the prefixes all
  // resolve), writes land on scope. The `has` trap returns true so `with` intercepts
  // every bare identifier (and our injected params still shadow correctly).
  const host = (typeof globalThis !== 'undefined' ? globalThis : {}) as Record<PropertyKey, unknown>;
  // The injected function params must NOT be intercepted by `with` (else they'd resolve
  // to the proxy → undefined). Returning false from `has` for them lets the parameter
  // win; everything else is intercepted so it resolves scope → host.
  const params = new Set(['engine', 'midi', 'console', 'script']);
  const proxy = new Proxy(scope, {
    has: (_t, prop) => !params.has(prop as string),
    get: (target, prop) => (prop in target ? target[prop as string] : host[prop]),
    set: (target, prop, value) => {
      target[prop as string] = value;
      return true;
    },
  });
  const body = `with (this) {\n${js}\n;${exporter}\n} return this;`;
   
  const factory = new Function('engine', 'midi', 'console', 'script', body);
  try {
    factory.call(proxy, engine, midi, logger, scriptGlobal ?? {});
  } finally {
    Object.defineProperty = realDefineProperty; // restore
  }
  const result = scope; // prefixes/components were written onto scope via the proxy

  // Split a Mixxx control path into property steps, handling BOTH dot access and array
  // indices: "DJ2GO2Touch.leftDeck.hotcueButtons[1].input" →
  // ["DJ2GO2Touch","leftDeck","hotcueButtons","1","input"].
  const pathSteps = (path: string): string[] =>
    path
      .replace(/\[(\w+)\]/g, '.$1') // foo[1] → foo.1
      .split('.')
      .filter(Boolean);

  // Resolve a control path against the LIVE script scope and return the handler BOUND to
  // its parent object. Resolved LAZILY (per message) because many handlers live on
  // components created in init() (e.g. `this.playButton = new components.PlayButton(...)`),
  // which runs AFTER this function returns — so eager resolution would miss them (they'd
  // be undefined). Binding to the parent gives `this` = the owning component, matching how
  // Mixxx evaluates `(Prefix.deck.playButton.input)(...)` as a member call.
  const resolveFn = (path: string): ((...a: Array<number | string>) => void) | undefined => {
    const parts = pathSteps(path);
    let obj: unknown = result;
    let parent: unknown = undefined;
    for (const p of parts) {
      if (obj && typeof obj === 'object' && p in (obj as Record<string, unknown>)) {
        parent = obj;
        obj = (obj as Record<string, unknown>)[p];
      } else {
        return undefined;
      }
    }
    if (typeof obj !== 'function') return undefined;
    const fn = obj as (...a: Array<number | string>) => void;
    return parent && typeof parent === 'object' ? fn.bind(parent) : fn;
  };

  // The router dispatches by calling resolveHandler(key) per message (lazy). We keep a
  // small cache keyed by path so repeated messages don't re-walk the scope, but the
  // cache is only populated once a path successfully resolves (post-init), so controls
  // created in init() bind correctly the first time they're actually used.
  const handlerCache = new Map<string, (...a: Array<number | string>) => void>();
  const resolveHandler = (path: string): ((...a: Array<number | string>) => void) | undefined => {
    const cached = handlerCache.get(path);
    if (cached) return cached;
    const fn = resolveFn(path);
    if (fn) handlerCache.set(path, fn);
    return fn;
  };

  const prefixObjects: RunMappingResult['prefixObjects'] = {};
  for (const p of prefixes) {
    const obj = result[p];
    if (obj && typeof obj === 'object') {
      prefixObjects[p] = obj as { init?: (n: string, d: boolean) => void; shutdown?: () => void };
    }
  }

  return { functions: {}, resolveHandler, prefixObjects };
}
