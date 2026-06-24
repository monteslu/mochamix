/**
 * WaveformView — the deck's waveform surfaces (overview + scrolling), drawn on
 * canvases. Reads the live play position from the control bus each animation
 * frame (the batched hi-rate path; we poll the bus value via rAF rather than
 * re-rendering React per frame). Canvas2D for now; WebGPU render later.
 */

import { useEffect, useRef } from 'react';
import {
  drawOverview,
  drawScrolling,
  type PeakData,
  DEFAULT_COLORS,
} from '@internal-dj/waveform';
import { useDj } from '../dj-context.js';
import { deck as deckGroup, DeckKeys } from '@internal-dj/control-bus';

interface Props {
  deckIndex: number; // 0-based
  detail: PeakData | null;
  overview: PeakData | null;
  /** Zoom: source frames per pixel in the scrolling view. */
  framesPerPx?: number;
  onSeek?: (fraction: number) => void;
}

export function WaveformView({
  deckIndex,
  detail,
  overview,
  framesPerPx = 80,
  onSeek,
}: Props): React.JSX.Element {
  const { bus } = useDj();
  const overviewRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLCanvasElement>(null);
  const grp = deckGroup(deckIndex + 1);

  useEffect(() => {
    let raf = 0;
    const overviewCanvas = overviewRef.current;
    const scrollCanvas = scrollRef.current;

    const tick = () => {
      const fraction = bus.get(grp, DeckKeys.playPosition);
      const frames = bus.get(grp, DeckKeys.trackSamples);
      const positionFrames = fraction * frames;

      if (overviewCanvas && overview) {
        drawOverview(overviewCanvas, overview, fraction, DEFAULT_COLORS);
      }
      if (scrollCanvas && detail) {
        drawScrolling(scrollCanvas, detail, positionFrames, framesPerPx, DEFAULT_COLORS);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [bus, grp, detail, overview, framesPerPx]);

  const handleOverviewClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onSeek) {
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = (e.clientX - rect.left) / rect.width;
    onSeek(Math.max(0, Math.min(1, fraction)));
  };

  return (
    <div className="waveform">
      <canvas
        ref={scrollRef}
        className="waveform-scroll"
        width={900}
        height={120}
        aria-label={`Deck ${deckIndex + 1} scrolling waveform`}
      />
      <canvas
        ref={overviewRef}
        className="waveform-overview"
        width={900}
        height={48}
        onClick={handleOverviewClick}
        aria-label={`Deck ${deckIndex + 1} overview (click to seek)`}
      />
    </div>
  );
}
