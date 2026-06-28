/**
 * OverviewStrip — the full-track minimap next to the platter (Mixxx/Serato style).
 * Thin shell: mount a canvas, hand it to the controller (which owns the render
 * loop), and handle click-to-seek. No render logic in the JSX.
 */

import { useEffect, useRef } from 'react';
import { useDj } from '../dj-context.js';
import { OverviewStripController } from '../overview-strip-controller.js';

export function OverviewStrip({ deckIndex }: { deckIndex: number }): React.JSX.Element {
  const { bus, engine } = useDj();
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const ctrl = new OverviewStripController(ref.current, bus, deckIndex);
    return () => ctrl.dispose();
  }, [bus, deckIndex]);

  const onSeek = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    engine.seekFraction(deckIndex, Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
  };

  return (
    <canvas
      ref={ref}
      className="overview-strip"
      height={30}
      onClick={onSeek}
      title="Full track. Click to seek"
    />
  );
}
