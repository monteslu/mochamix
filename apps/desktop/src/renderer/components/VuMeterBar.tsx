/**
 * VuMeterBar — a vertical level meter bound to a deck's vu_meter control. Polls
 * the bus value via rAF (the hi-rate path) and updates the bar height directly,
 * avoiding per-frame React re-renders.
 */

import { useEffect, useRef } from 'react';
import { deck as deckGroup, DeckKeys } from '@internal-dj/control-bus';
import { useDj } from '../dj-context.js';

export function VuMeterBar({ deckIndex }: { deckIndex: number }): React.JSX.Element {
  const { bus } = useDj();
  const fillRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const g = deckGroup(deckIndex + 1);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const level = bus.get(g, DeckKeys.vuMeter);
      const clip = bus.get(g, DeckKeys.peakIndicator) > 0.5;
      if (fillRef.current) {
        // Perceptual-ish scaling: sqrt lifts low levels into view.
        const h = Math.min(100, Math.sqrt(level) * 100);
        fillRef.current.style.height = `${h}%`;
      }
      if (clipRef.current) {
        clipRef.current.style.opacity = clip ? '1' : '0';
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [bus, g]);

  return (
    <div className="vu-meter" aria-label={`Deck ${deckIndex + 1} level`}>
      <div ref={clipRef} className="vu-clip" />
      <div className="vu-track">
        <div ref={fillRef} className="vu-fill" />
      </div>
    </div>
  );
}
