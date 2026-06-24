/**
 * Platter — the spinning vinyl per deck (Serato/rekordbox style). A circular
 * disc with cover art in the center, a rotating position marker, grooves, and an
 * outer progress ring tracking play position. Rotation + ring are driven by the
 * play-position control via rAF (canvas-free; CSS transform + an SVG ring).
 */

import { useEffect, useRef } from 'react';
import { deck as deckGroup, DeckKeys } from '@internal-dj/control-bus';
import { useDj } from '../dj-context.js';

const RPM = 33.333;

export function Platter({
  deckIndex,
  coverUrl,
}: {
  deckIndex: number;
  coverUrl: string | null;
}): React.JSX.Element {
  const { bus } = useDj();
  const discRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<SVGCircleElement>(null);
  const g = deckGroup(deckIndex + 1);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let angle = 0;
    const circumference = 2 * Math.PI * 46;

    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const playing = bus.get(g, DeckKeys.play) > 0.5;
      const ratio = bus.get(g, DeckKeys.rateRatio) || 1;
      if (playing) {
        angle = (angle + dt * (RPM / 60) * 360 * ratio) % 360;
        if (discRef.current) {
          discRef.current.style.transform = `rotate(${angle}deg)`;
        }
      }
      // progress ring
      const pos = bus.get(g, DeckKeys.playPosition);
      if (ringRef.current) {
        ringRef.current.style.strokeDashoffset = `${circumference * (1 - pos)}`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [bus, g]);

  const accent = deckIndex === 0 ? 'var(--deck-a)' : 'var(--deck-b)';

  return (
    <div className="platter">
      <svg className="platter-ring" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="46" className="platter-ring-bg" />
        <circle
          ref={ringRef}
          cx="50"
          cy="50"
          r="46"
          className="platter-ring-fg"
          stroke={accent}
          strokeDasharray={2 * Math.PI * 46}
          strokeDashoffset={2 * Math.PI * 46}
          transform="rotate(-90 50 50)"
        />
      </svg>
      <div ref={discRef} className="platter-disc">
        <div className="platter-grooves" />
        {coverUrl ? (
          <img className="platter-cover" src={coverUrl} alt="" />
        ) : (
          <div className="platter-label" style={{ background: accent }} />
        )}
        <div className="platter-marker" />
      </div>
    </div>
  );
}
