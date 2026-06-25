/**
 * Platter — the spinning vinyl per deck (Serato/rekordbox style). A circular
 * disc with cover art in the center, a rotating position marker, grooves, and an
 * outer progress ring tracking play position. Rotation + ring are driven by the
 * play-position control via rAF (canvas-free; CSS transform + an SVG ring).
 */

import { useEffect, useRef } from 'react';
import { useDj } from '../dj-context.js';
import { PlatterController } from '../platter-controller.js';

// Thin shell: render the disc/ring, hand them to the controller (rotation +
// mouse scratching). No animation/scratch logic in the JSX.
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

  useEffect(() => {
    if (!discRef.current) return;
    const ctrl = new PlatterController(discRef.current, ringRef.current, bus, deckIndex);
    return () => ctrl.dispose();
  }, [bus, deckIndex]);

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
