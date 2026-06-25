/**
 * LoopRow — manual loop + beatloop controls for a deck. Bound to the loop trigger
 * controls on the bus; the LoopControl (main thread) + DeckPlayback (worklet) do
 * the work.
 */

import { deck as deckGroup, DeckKeys, beatloopActivateKey } from '@dj/control-bus';
import { useDj, useControlValue } from '../dj-context.js';

const BEATLOOP_BUTTONS = [1, 2, 4, 8, 16] as const;

export function LoopRow({ deckIndex }: { deckIndex: number }): React.JSX.Element {
  const { bus } = useDj();
  const g = deckGroup(deckIndex + 1);
  const looping = useControlValue(g, DeckKeys.loopEnabled) > 0.5;

  const trigger = (key: string) => bus.set(g, key, 1);

  return (
    <div className="loop-row" aria-label={`Deck ${deckIndex + 1} loops`}>
      <button className="tiny" onClick={() => trigger(DeckKeys.loopIn)} title="Loop in">
        IN
      </button>
      <button className="tiny" onClick={() => trigger(DeckKeys.loopOut)} title="Loop out">
        OUT
      </button>
      <button
        className={`tiny ${looping ? 'active' : ''}`}
        onClick={() => trigger(DeckKeys.reloopToggle)}
        title="Reloop / exit"
      >
        LOOP
      </button>
      <button className="tiny" onClick={() => trigger(DeckKeys.loopHalve)} title="Halve loop">
        ½
      </button>
      <button className="tiny" onClick={() => trigger(DeckKeys.loopDouble)} title="Double loop">
        2×
      </button>
      <span className="loop-sep" />
      {BEATLOOP_BUTTONS.map((size) => (
        <button
          key={size}
          className="tiny beatloop"
          onClick={() => trigger(beatloopActivateKey(size))}
          title={`${size}-beat loop`}
        >
          {size}
        </button>
      ))}
    </div>
  );
}
