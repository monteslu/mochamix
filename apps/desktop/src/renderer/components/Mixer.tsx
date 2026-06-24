/**
 * Mixer — the center section between the two decks. M1: the crossfader + master
 * gain. EQ/volume live on each deck for now. Decks 1/2 are oriented left/right so
 * the crossfader actually blends them.
 */

import { useEffect } from 'react';
import { MASTER, MasterKeys, deck as deckGroup, DeckKeys } from '@internal-dj/control-bus';
import { useControl, useControlValue, useDj } from '../dj-context.js';

export function Mixer(): React.JSX.Element {
  const { bus } = useDj();
  const [xfader, setXfader] = useControl(MASTER, MasterKeys.crossfader);
  const [gain, setGain] = useControl(MASTER, MasterKeys.gain);
  const [smartFader, setSmartFader] = useControl(MASTER, MasterKeys.smartFaderEnabled);
  const sfTargetBpm = useControlValue(MASTER, MasterKeys.smartFaderTargetBpm);
  const sfActive = useControlValue(MASTER, MasterKeys.smartFaderActive) > 0.5;

  // Orient deck 1 left, deck 2 right so the crossfader blends them.
  useEffect(() => {
    bus.set(deckGroup(1), DeckKeys.orientation, 0); // left
    bus.set(deckGroup(2), DeckKeys.orientation, 2); // right
  }, [bus]);

  return (
    <section className="mixer" aria-label="Mixer">
      <div className="mixer-title">MASTER</div>
      <div className="mixer-master">
        <input
          type="range"
          min={0}
          max={5}
          step={0.01}
          value={gain}
          onChange={(e) => setGain(Number(e.target.value))}
          className="master-gain"
          aria-label="Master gain"
        />
        <label>{gain.toFixed(1)}</label>
      </div>

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
          aria-label="Crossfader"
        />
        <span className="xfader-end b">B</span>
        <button className="tiny" onClick={() => setXfader(0)} title="center crossfader">
          ◇
        </button>
      </div>

      <div className="mixer-smartfader">
        <button
          className={`smartfader-btn ${smartFader > 0.5 ? 'active' : ''}`}
          onClick={() => setSmartFader(smartFader > 0.5 ? 0 : 1)}
          title="Smart Fader: crossfader blends the two decks' tempo (load both decks first)"
        >
          SMART FADER
        </button>
        {sfActive && sfTargetBpm > 0 && (
          <span className="smartfader-bpm">{sfTargetBpm.toFixed(1)} BPM</span>
        )}
      </div>
    </section>
  );
}
