/**
 * Vertical faders — tempo (pitch) faders that sit on the OUTER edges of the deck
 * row (like real DJ gear), and channel gain faders that sit above the crossfader.
 * Both are styled vertical range inputs bound to the control bus.
 */

import { deck as deckGroup, DeckKeys } from '@dj/control-bus';
import { useControl } from '../dj-context.js';

/** Outer-edge tempo/pitch fader for a deck. */
export function TempoFader({
  deckIndex,
  side,
}: {
  deckIndex: number;
  side: 'left' | 'right';
}): React.JSX.Element {
  const g = deckGroup(deckIndex + 1);
  const [rate, setRate] = useControl(g, DeckKeys.rate);
  return (
    <div className={`tempo-fader ${side}`} aria-label={`Deck ${deckIndex + 1} tempo`}>
      <span className="fader-cap">TEMPO</span>
      <input
        type="range"
        className="vfader"
        min={-1}
        max={1}
        step={0.001}
        // top = faster: invert so up = +rate
        value={-rate}
        onChange={(e) => setRate(-Number(e.target.value))}
        onDoubleClick={() => setRate(0)}
        title={`Tempo / pitch fader (deck ${deckIndex + 1}). Drag up = faster, down = slower. Double-click to reset to 0%.`}
      />
      <span className="fader-val">
        {rate >= 0 ? '+' : ''}
        {(rate * 8).toFixed(1)}
      </span>
    </div>
  );
}

/** Channel volume/gain fader (sits above the crossfader in the mixer). */
export function GainFader({ deckIndex }: { deckIndex: number }): React.JSX.Element {
  const g = deckGroup(deckIndex + 1);
  const [vol, setVol] = useControl(g, DeckKeys.volume);
  return (
    <div className={`gain-fader deck-${deckIndex === 0 ? 'a' : 'b'}`}>
      <input
        type="range"
        className="vfader"
        min={0}
        max={1}
        step={0.005}
        value={vol}
        onChange={(e) => setVol(Number(e.target.value))}
        title={`Channel ${deckIndex + 1} volume fader`}
      />
    </div>
  );
}
