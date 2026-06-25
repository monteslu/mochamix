/**
 * Mixer — the center section, modeled on Mixxx's mixer (see manual screenshot):
 * two channel strips (one per deck) flanking center VU meters, with the crossfader
 * across the bottom. Each strip: gain/trim knob → 3-band EQ (HI/MID/LOW) → filter
 * (quick-effect) knob → tall vertical volume fader → PFL. The EQ lives HERE (not on
 * the decks), matching Mixxx — the decks hold transport/cues/loops/waveform.
 */

import { useEffect } from 'react';
import { MASTER, MasterKeys, deck as deckGroup, DeckKeys } from '@dj/control-bus';
import { useControl, useControlValue, useDj } from '../dj-context.js';
import { Knob } from './Knob.js';
import { VuMeterBar } from './VuMeterBar.js';
import { QuickEffect } from './QuickEffect.js';

/** One channel strip: trim, EQ, filter, volume fader, PFL. */
function ChannelStrip({ deckIndex }: { deckIndex: number }): React.JSX.Element {
  const g = deckGroup(deckIndex + 1);
  const [vol, setVol] = useControl(g, DeckKeys.volume);
  const [pfl, setPfl] = useControl(g, DeckKeys.pfl);
  const accent = deckIndex === 0 ? 'a' : 'b';

  return (
    <div className={`chan chan-${accent}`}>
      <button
        className={`pfl-mini ${pfl > 0.5 ? 'active' : ''}`}
        onClick={() => setPfl(pfl > 0.5 ? 0 : 1)}
        title="Headphone cue (PFL) — monitor this deck in the headphones"
      >
        🎧
      </button>
      {/* EQ knob column + the channel fader beside it (Mixxx layout) */}
      <div className="chan-body">
        <div className="chan-knobs">
          <Knob group={g} ckey={DeckKeys.pregain} label="GAIN" min={0} max={4} center={1} hint="Gain / trim" />
          <Knob group={g} ckey={DeckKeys.eqHigh} label="HI" min={0} max={4} center={1} hint="High EQ (treble)" />
          <Knob group={g} ckey={DeckKeys.eqMid} label="MID" min={0} max={4} center={1} hint="Mid EQ" />
          <Knob group={g} ckey={DeckKeys.eqLow} label="LOW" min={0} max={4} center={1} hint="Low EQ (bass)" />
          <QuickEffect deckIndex={deckIndex} />
        </div>
        <input
          type="range"
          className="vfader chan-fader"
          min={0}
          max={1}
          step={0.005}
          value={vol}
          onChange={(e) => setVol(Number(e.target.value))}
          title={`Channel ${deckIndex + 1} volume fader`}
        />
      </div>
    </div>
  );
}

export function Mixer(): React.JSX.Element {
  const { bus } = useDj();
  const [xfader, setXfader] = useControl(MASTER, MasterKeys.crossfader);
  const [smartFader, setSmartFader] = useControl(MASTER, MasterKeys.smartFaderEnabled);
  const gain = useControlValue(MASTER, MasterKeys.gain);
  const sfTargetBpm = useControlValue(MASTER, MasterKeys.smartFaderTargetBpm);
  const sfActive = useControlValue(MASTER, MasterKeys.smartFaderActive) > 0.5;

  // Orient deck 1 left, deck 2 right so the crossfader blends them.
  useEffect(() => {
    bus.set(deckGroup(1), DeckKeys.orientation, 0);
    bus.set(deckGroup(2), DeckKeys.orientation, 2);
  }, [bus]);

  return (
    <section className="mixer" aria-label="Mixer">
      <div className="mixer-top">
        <button
          className={`smart-icon ${smartFader > 0.5 ? 'active' : ''}`}
          onClick={() => setSmartFader(smartFader > 0.5 ? 0 : 1)}
          title={`Smart Fader: the crossfader blends the two decks' TEMPO, not just volume.${
            sfActive && sfTargetBpm > 0 ? ` Target ${sfTargetBpm.toFixed(0)} BPM.` : ''
          }`}
        >
          🧠
        </button>
        <Knob group={MASTER} ckey={MasterKeys.gain} label="MAIN" min={0} max={5} center={1} hint="Master output level" />
        <span className="mixer-mainval">{gain.toFixed(1)}</span>
      </div>

      <div className="mixer-strips">
        <ChannelStrip deckIndex={0} />
        <div className="mixer-vus">
          <VuMeterBar deckIndex={0} />
          <VuMeterBar deckIndex={1} />
        </div>
        <ChannelStrip deckIndex={1} />
      </div>

      <div className="mixer-bottom">
        <div className="mixer-xfader">
          <span className="xfader-end a">A</span>
          <input
            type="range"
            min={-1}
            max={1}
            step={0.001}
            value={xfader}
            onChange={(e) => setXfader(Number(e.target.value))}
            className="xfader-slider"
            onDoubleClick={() => setXfader(0)}
            title="Crossfader — blends deck 1 (A) and deck 2 (B). Double-click to center."
          />
          <span className="xfader-end b">B</span>
        </div>
      </div>
    </section>
  );
}
