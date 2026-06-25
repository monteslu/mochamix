/**
 * VuMeterBar — a vertical level meter bound to a deck's vu_meter control. Polls
 * the bus value via rAF (the hi-rate path) and updates the bar height directly,
 * avoiding per-frame React re-renders.
 */

import { useRef } from 'react';
import { deck as deckGroup, DeckKeys } from '@dj/control-bus';
import { useDj } from '../dj-context.js';
import { useBusRaf } from '../use-bus-raf.js';

/** sqrt scaling lifts low levels into view (perceptual-ish). 0..1 → 0..100%. */
export function vuFillPercent(level: number): number {
  return Math.min(100, Math.sqrt(level) * 100);
}

export function VuMeterBar({ deckIndex }: { deckIndex: number }): React.JSX.Element {
  const { bus } = useDj();
  const fillRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const g = deckGroup(deckIndex + 1);

  useBusRaf(() => {
    const level = bus.get(g, DeckKeys.vuMeter);
    const clip = bus.get(g, DeckKeys.peakIndicator) > 0.5;
    if (fillRef.current) fillRef.current.style.height = `${vuFillPercent(level)}%`;
    if (clipRef.current) clipRef.current.style.opacity = clip ? '1' : '0';
  });

  return (
    <div className="vu-meter" aria-label={`Deck ${deckIndex + 1} level`}>
      <div ref={clipRef} className="vu-clip" />
      <div className="vu-track">
        <div ref={fillRef} className="vu-fill" />
      </div>
    </div>
  );
}
