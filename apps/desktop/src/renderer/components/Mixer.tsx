/**
 * Mixer — the center section between the two decks. M1: the crossfader + master
 * gain. EQ/volume live on each deck for now. Decks 1/2 are oriented left/right so
 * the crossfader actually blends them.
 */

import { useEffect } from 'react';
import { MASTER, MasterKeys, deck as deckGroup, DeckKeys } from '@internal-dj/control-bus';
import { useControl, useDj } from '../dj-context.js';

export function Mixer(): React.JSX.Element {
  const { bus } = useDj();
  const [xfader, setXfader] = useControl(MASTER, MasterKeys.crossfader);
  const [gain, setGain] = useControl(MASTER, MasterKeys.gain);

  // Orient deck 1 left, deck 2 right so the crossfader blends them.
  useEffect(() => {
    bus.set(deckGroup(1), DeckKeys.orientation, 0); // left
    bus.set(deckGroup(2), DeckKeys.orientation, 2); // right
  }, [bus]);

  return (
    <section className="mixer" aria-label="Mixer">
      <div className="mixer-master">
        <label>MASTER</label>
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
      </div>

      <div className="mixer-xfader">
        <span className="xfader-end">A</span>
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
        <span className="xfader-end">B</span>
        <button className="tiny" onClick={() => setXfader(0)} title="center crossfader">
          ◇
        </button>
      </div>
    </section>
  );
}
