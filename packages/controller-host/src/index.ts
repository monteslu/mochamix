/**
 * @dj/controller-host — the Mixxx-compatible controller host.
 *
 * The `engine` global API + MIDI value transforms, backed by the control bus, so
 * stock Mixxx mapping scripts run unchanged.
 */

export {
  EngineApi,
  type EngineApiOptions,
  type EngineCallback,
  type ScriptConnection,
} from './engine-api.js';
export {
  computeMidiParameter,
  isRelative,
  type MidiOptions,
} from './midi-options.js';
export {
  parseMidiMapping,
  midiKey,
  type MidiMapping,
  type MidiInputControl,
  type MidiOutputControl,
  type ScriptFile,
} from './midi-mapping.js';
export {
  MidiRouter,
  type MidiRouterDeps,
  type ScriptFunctions,
  type MidiSend,
} from './midi-router.js';
export {
  runMappingScript,
  type MidiGlobal,
  type RunMappingResult,
} from './script-runtime.js';
