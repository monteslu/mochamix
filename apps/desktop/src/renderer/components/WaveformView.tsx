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
  type Overlay,
  type Marker,
  DEFAULT_COLORS,
} from '@internal-dj/waveform';
import { useDj } from '../dj-context.js';
import {
  deck as deckGroup,
  DeckKeys,
  hotcuePositionKey,
  hotcueEnabledKey,
} from '@internal-dj/control-bus';

const HOTCUE_COLORS = ['#ff5a5a', '#ffb84d', '#4ade80', '#37b6ff', '#a78bfa', '#f472b6'];
const VISIBLE_HOTCUES = 8;

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

      // Build the overlay (hotcue markers + loop region) from the bus.
      const overlay: Overlay = { markers: [], loop: undefined };
      if (frames > 0) {
        const markers: Marker[] = [];
        for (let n = 1; n <= VISIBLE_HOTCUES; n++) {
          if (bus.get(grp, hotcueEnabledKey(n)) > 0.5) {
            const pos = bus.get(grp, hotcuePositionKey(n));
            if (pos >= 0) {
              markers.push({
                fraction: pos / frames,
                color: HOTCUE_COLORS[(n - 1) % HOTCUE_COLORS.length]!,
              });
            }
          }
        }
        overlay.markers = markers;
        const ls = bus.get(grp, DeckKeys.loopStartPosition);
        const le = bus.get(grp, DeckKeys.loopEndPosition);
        if (ls >= 0 && le > ls) {
          overlay.loop = {
            start: ls / frames,
            end: le / frames,
            active: bus.get(grp, DeckKeys.loopEnabled) > 0.5,
          };
        }
      }

      if (overviewCanvas && overview) {
        drawOverview(overviewCanvas, overview, fraction, DEFAULT_COLORS, overlay);
      }
      if (scrollCanvas && detail) {
        const fileBpm = bus.get(grp, DeckKeys.fileBpm);
        const framesPerBeat = fileBpm > 0 ? (60 / fileBpm) * 48000 : 0;
        drawScrolling(scrollCanvas, detail, positionFrames, framesPerPx, DEFAULT_COLORS, {
          firstBeatFrame: 0,
          framesPerBeat,
        });
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
