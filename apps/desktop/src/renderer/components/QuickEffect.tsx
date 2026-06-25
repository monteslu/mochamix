/**
 * QuickEffect — the per-deck filter super-knob (Mixxx QuickEffect). One knob
 * sweeps lowpass → neutral → highpass via the metaknob link math; a toggle
 * enables/disables it (the filter is bypassed when off). Bound to the
 * quickeffect_super1 + quickeffect_enabled controls.
 */

import { deck as deckGroup, DeckKeys } from '@dj/control-bus';
import { useControl } from '../dj-context.js';
import { Knob } from './Knob.js';

export function QuickEffect({ deckIndex }: { deckIndex: number }): React.JSX.Element {
  const g = deckGroup(deckIndex + 1);
  const [enabled, setEnabled] = useControl(g, DeckKeys.quickEffectEnabled);

  return (
    <div className="quick-effect">
      <Knob group={g} ckey={DeckKeys.quickEffectSuper} label="FILTER" min={0} max={1} center={0.5} />
      <button
        className={`tiny fx-toggle ${enabled > 0.5 ? 'active' : ''}`}
        onClick={() => setEnabled(enabled > 0.5 ? 0 : 1)}
        title="Enable filter"
      >
        ●
      </button>
    </div>
  );
}
