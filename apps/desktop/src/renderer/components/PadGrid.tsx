/**
 * PadGrid — the performance-pad grid for a deck (Serato/rekordbox model): a row of mode
 * buttons + 8 pads whose meaning changes with the mode. Data-driven by pad-modes.ts, so
 * Stems / Hot Cue / Beat Loop / Beat Jump all share this one component. Replaces the old
 * hardcoded HotcueRow / LoopRow / StemRow.
 *
 * Stems mode is the headline: 4 colored stem pads (press = mute/unmute, shift = solo) + 4
 * combo pads (acapella/instrumental/…), collapsing the StemRow and reclaiming vertical space.
 */

import { useCallback, useState, useSyncExternalStore } from 'react';
import { useDj } from '../dj-context.js';
import { onFrame } from '../frame-loop.js';
import { PAD_MODES, type PadSpec } from '../pad-modes.js';

/** Re-render when any of the pad's watched controls change (frame-coalesced), returning the
 * pad's live lit state. */
function usePadActive(spec: PadSpec): boolean {
  const { bus } = useDj();
  const subscribe = useCallback(
    (onChange: () => void) => {
      let dirty = false;
      let unsubFrame: (() => void) | null = null;
      const schedule = () => {
        if (dirty) return;
        dirty = true;
        unsubFrame = onFrame(() => {
          dirty = false;
          unsubFrame?.();
          unsubFrame = null;
          onChange();
        });
      };
      const offs = spec.watch.map((w) => bus.connect(w.group, w.key, schedule));
      return () => {
        for (const off of offs) off();
        unsubFrame?.();
      };
    },
    [bus, spec],
  );
  return useSyncExternalStore(subscribe, () => spec.isActive(bus));
}

function Pad({ spec }: { spec: PadSpec }): React.JSX.Element {
  const { bus } = useDj();
  const active = usePadActive(spec);
  const onClick = (e: React.MouseEvent) => {
    if (e.shiftKey && spec.shift) spec.shift(bus);
    else spec.press(bus);
  };
  return (
    <button
      className={`pad ${active ? 'active' : ''}`}
      style={spec.color ? ({ '--pad': spec.color } as React.CSSProperties) : undefined}
      onClick={onClick}
      title={spec.title}
    >
      {spec.label}
    </button>
  );
}

export function PadGrid({ deckIndex }: { deckIndex: number }): React.JSX.Element {
  const { bus } = useDj();
  const [modeId, setModeId] = useState(PAD_MODES[0]!.id);

  // Resolve the active mode; if it's unavailable for this deck (e.g. Stems on a non-stem
  // track), fall back to the first available so the grid is never empty/broken.
  const mode =
    PAD_MODES.find((m) => m.id === modeId && (!m.available || m.available(bus, deckIndex))) ??
    PAD_MODES.find((m) => !m.available || m.available(bus, deckIndex)) ??
    PAD_MODES[0]!;
  const pads = mode.pads(deckIndex);

  return (
    <div className="pad-grid" aria-label={`Deck ${deckIndex + 1} performance pads`}>
      <div className="pad-modes" role="tablist">
        {PAD_MODES.map((m) => {
          const avail = !m.available || m.available(bus, deckIndex);
          return (
            <button
              key={m.id}
              className={`pad-mode ${m.id === mode.id ? 'active' : ''}`}
              disabled={!avail}
              onClick={() => setModeId(m.id)}
              title={avail ? m.hint : `${m.hint} (unavailable: load a stems track)`}
            >
              {m.label}
            </button>
          );
        })}
      </div>
      <div className="pads">
        {pads.map((spec, i) => (
          <Pad key={`${mode.id}-${i}`} spec={spec} />
        ))}
      </div>
    </div>
  );
}
