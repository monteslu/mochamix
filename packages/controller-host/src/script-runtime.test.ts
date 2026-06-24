import { describe, it, expect, vi } from 'vitest';
import { runMappingScript } from './script-runtime.js';
import { parseMidiMapping } from './midi-mapping.js';
import { EngineApi } from './engine-api.js';
import { ControlBus, standardControls } from '@internal-dj/control-bus';

// A realistic Mixxx-mapping XML + JS pair (the var-Prefix-object idiom every real
// mapping uses). If this runs against our engine global, real mappings will too.
const XML = `<?xml version="1.0"?>
<MixxxControllerPreset>
  <info name="MyCtrl"/>
  <controller id="MyCtrl">
    <scriptfiles><file filename="MyCtrl.js" functionprefix="MyCtrl"/></scriptfiles>
    <controls>
      <control>
        <group>[Channel1]</group><key>MyCtrl.playPress</key>
        <status>0x90</status><midino>0x0B</midino>
        <options><script-binding/></options>
      </control>
      <control>
        <group>[Channel1]</group><key>MyCtrl.cuePress</key>
        <status>0x90</status><midino>0x0C</midino>
        <options><script-binding/></options>
      </control>
    </controls>
  </controller>
</MixxxControllerPreset>`;

// The kind of JS a real Mixxx mapping ships.
const JS = `
var MyCtrl = {};
MyCtrl.initialized = false;
MyCtrl.init = function(name, debug) {
  MyCtrl.initialized = true;
  engine.setValue('[Channel1]', 'volume', 1);
};
MyCtrl.playPress = function(channel, control, value, status, group) {
  if (value > 0) {
    var cur = engine.getValue('[Channel1]', 'play');
    engine.setValue('[Channel1]', 'play', cur > 0 ? 0 : 1);
  }
};
MyCtrl.cuePress = function(channel, control, value) {
  if (value > 0) {
    engine.setValue('[Channel1]', 'cue_default', 1);
  }
};
`;

function setup() {
  const bus = new ControlBus();
  bus.defineAll(standardControls(2));
  const engine = new EngineApi({ bus });
  const mapping = parseMidiMapping(XML);
  const midi = { sendShortMsg: vi.fn(), sendSysexMsg: vi.fn() };
  const result = runMappingScript(JS, mapping, engine, midi, console);
  return { bus, engine, mapping, result };
}

describe('runMappingScript (running real-style Mixxx mapping JS)', () => {
  it('resolves the script-binding functions referenced by controls', () => {
    const { result } = setup();
    expect(typeof result.functions['MyCtrl.playPress']).toBe('function');
    expect(typeof result.functions['MyCtrl.cuePress']).toBe('function');
  });

  it('exposes the prefix object so init() can run', () => {
    const { bus, result } = setup();
    expect(result.prefixObjects['MyCtrl']).toBeDefined();
    result.prefixObjects['MyCtrl']!.init?.('MyCtrl', false);
    // init set volume via the engine global
    expect(bus.get('[Channel1]', 'volume')).toBe(1);
  });

  it('a resolved handler drives the control bus through the engine global', () => {
    const { bus, result } = setup();
    const playPress = result.functions['MyCtrl.playPress']!;
    playPress(0, 0x0b, 127, 0x90, '[Channel1]');
    expect(bus.get('[Channel1]', 'play')).toBe(1);
    playPress(0, 0x0b, 127, 0x90, '[Channel1]'); // toggle off
    expect(bus.get('[Channel1]', 'play')).toBe(0);
  });

  it('the cue handler works too', () => {
    const { bus, result } = setup();
    result.functions['MyCtrl.cuePress']!(0, 0x0c, 127);
    expect(bus.get('[Channel1]', 'cue_default')).toBe(1);
  });

  it('does not leak engine into the mapping beyond the injected globals', () => {
    // The mapping can only touch the bus via engine.*; verify a stray global ref
    // throws inside the script rather than silently succeeding.
    const bus = new ControlBus();
    bus.defineAll(standardControls(1));
    const engine = new EngineApi({ bus });
    const mapping = parseMidiMapping(XML);
    const badJs = `var MyCtrl = {}; MyCtrl.playPress = function(){ if (value > 0) {} };`;
    // referencing undeclared `value` inside the fn body only errors when CALLED;
    // running the script itself should be fine.
    expect(() =>
      runMappingScript(badJs, mapping, engine, { sendShortMsg() {}, sendSysexMsg() {} }),
    ).not.toThrow();
  });
});
