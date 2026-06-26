import { describe, it, expect } from 'vitest';
import { parseMidiMapping, serializeMapping } from './midi-mapping.js';

const XML = `<?xml version="1.0"?>
<MixxxControllerPreset>
  <info><name>Test Map</name><author>me</author></info>
  <controller id="Test Map">
    <scriptfiles><file functionprefix="TM" filename="test.js"/></scriptfiles>
    <controls>
      <control><group>[Channel1]</group><key>play</key><status>0x90</status><midino>0x0B</midino><options><button/></options></control>
      <control><group>[Channel1]</group><key>TM.jog</key><status>0xB0</status><midino>0x10</midino><options><script-binding/></options></control>
    </controls>
    <outputs>
      <output><group>[Channel1]</group><key>play_indicator</key><status>0x90</status><midino>0x0B</midino><on>0x7F</on><off>0x00</off><minimum>0.5</minimum></output>
    </outputs>
  </controller>
</MixxxControllerPreset>`;

describe('serializeMapping round-trip', () => {
  it('parse → serialize → parse preserves the structure', () => {
    const m1 = parseMidiMapping(XML);
    const xml2 = serializeMapping(m1);
    const m2 = parseMidiMapping(xml2);
    expect(m2.name).toBe('Test Map');
    expect(m2.author).toBe('me');
    expect(m2.scriptFiles).toEqual(m1.scriptFiles);
    expect(m2.controls.length).toBe(2);
    // control values survive
    expect(m2.controls[0]!.group).toBe('[Channel1]');
    expect(m2.controls[0]!.key).toBe('play');
    expect(m2.controls[0]!.status).toBe(0x90);
    expect(m2.controls[0]!.options.button).toBe(true);
    // script binding survives
    expect(m2.controls[1]!.isScript).toBe(true);
    expect(m2.controls[1]!.key).toBe('TM.jog');
    // output survives
    expect(m2.outputs[0]!.key).toBe('play_indicator');
    expect(m2.outputs[0]!.status).toBe(0x90);
  });

  it('lets you EDIT a control then serialize (the editor use case)', () => {
    const m = parseMidiMapping(XML);
    m.controls[0]!.key = 'cue_default'; // remap play → cue
    const m2 = parseMidiMapping(serializeMapping(m));
    expect(m2.controls[0]!.key).toBe('cue_default');
  });
});
