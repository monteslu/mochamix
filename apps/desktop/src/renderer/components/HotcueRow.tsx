/**
 * HotcueRow — a row of hotcue pads for a deck. Click an empty pad to set a hotcue
 * at the current position; click a set pad to jump to it; shift/right-click to
 * clear. Bound to the control bus (hotcue_N_set/activate/clear/enabled).
 */

import {
  deck as deckGroup,
  hotcueActivateKey,
  hotcueClearKey,
  hotcueEnabledKey,
  hotcueSetKey,
} from '@dj/control-bus';
import { useDj } from '../dj-context.js';
import { useControlValue } from '../dj-context.js';

const VISIBLE_HOTCUES = 8; // show the first 8 pads (of 36)

function HotcuePad({ deckIndex, n }: { deckIndex: number; n: number }): React.JSX.Element {
  const { bus } = useDj();
  const g = deckGroup(deckIndex + 1);
  const enabled = useControlValue(g, hotcueEnabledKey(n)) > 0.5;

  const onClick = (e: React.MouseEvent) => {
    if (e.shiftKey) {
      bus.set(g, hotcueClearKey(n), 1);
      return;
    }
    if (enabled) {
      bus.set(g, hotcueActivateKey(n), 1);
    } else {
      bus.set(g, hotcueSetKey(n), 1);
    }
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    bus.set(g, hotcueClearKey(n), 1);
  };

  return (
    <button
      className={`hotcue-pad ${enabled ? 'set' : ''}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={enabled ? `Hotcue ${n} (click=jump, shift/right-click=clear)` : `Set hotcue ${n}`}
    >
      {n}
    </button>
  );
}

export function HotcueRow({ deckIndex }: { deckIndex: number }): React.JSX.Element {
  return (
    <div className="hotcue-row" aria-label={`Deck ${deckIndex + 1} hotcues`}>
      {Array.from({ length: VISIBLE_HOTCUES }, (_, i) => (
        <HotcuePad key={i} deckIndex={deckIndex} n={i + 1} />
      ))}
    </div>
  );
}
