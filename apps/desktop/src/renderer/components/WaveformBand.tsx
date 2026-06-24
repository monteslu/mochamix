/**
 * WaveformBand — the full-width scrolling waveforms across the top (Mixxx/Serato/
 * Traktor signature). Both decks' waveforms stacked + beat-aligned, each with a
 * fixed center playhead. Plus a thin full-track overview strip per deck. Reads
 * peaks from the deck-state store + position/bpm from the control bus, rendered
 * via rAF onto canvases (no React re-render per frame).
 */

import { useEffect, useRef } from 'react';
import { drawScrolling, drawOverview, DEFAULT_COLORS } from '@internal-dj/waveform';
import {
  deck as deckGroup,
  DeckKeys,
  hotcuePositionKey,
  hotcueEnabledKey,
} from '@internal-dj/control-bus';
import { useDj } from '../dj-context.js';
import { getDeckTrack } from '../deck-state.js';

const HOTCUE_COLORS = ['#ff5a5a', '#ffb84d', '#4ade80', '#37b6ff', '#a78bfa', '#f472b6', '#42d4f4', '#f2f2ff'];

function DeckLane({ deckIndex, framesPerPx }: { deckIndex: number; framesPerPx: number }): React.JSX.Element {
  const { bus, engine } = useDj();
  const scrollRef = useRef<HTMLCanvasElement>(null);
  const overviewRef = useRef<HTMLCanvasElement>(null);
  const g = deckGroup(deckIndex + 1);

  useEffect(() => {
    let raf = 0;
    const resize = () => {
      for (const c of [scrollRef.current, overviewRef.current]) {
        if (c) {
          const r = c.getBoundingClientRect();
          if (r.width && c.width !== Math.floor(r.width)) c.width = Math.floor(r.width);
        }
      }
    };
    const tick = () => {
      resize();
      const st = getDeckTrack(deckIndex);
      const frames = bus.get(g, DeckKeys.trackSamples);
      const fraction = bus.get(g, DeckKeys.playPosition);
      const positionFrames = fraction * frames;
      const fileBpm = bus.get(g, DeckKeys.fileBpm);
      const framesPerBeat = fileBpm > 0 ? (60 / fileBpm) * 48000 : 0;

      if (scrollRef.current && st.peaks) {
        const fbf = bus.get(g, DeckKeys.firstBeatFrame);
        drawScrolling(scrollRef.current, st.peaks.detail, positionFrames, framesPerPx, DEFAULT_COLORS, {
          firstBeatFrame: fbf >= 0 ? fbf : 0,
          framesPerBeat,
        });
      } else if (scrollRef.current) {
        const ctx = scrollRef.current.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#080b10';
          ctx.fillRect(0, 0, scrollRef.current.width, scrollRef.current.height);
        }
      }
      if (overviewRef.current && st.peaks && frames > 0) {
        const markers = [];
        for (let n = 1; n <= 8; n++) {
          if (bus.get(g, hotcueEnabledKey(n)) > 0.5) {
            const p = bus.get(g, hotcuePositionKey(n));
            if (p >= 0) markers.push({ fraction: p / frames, color: HOTCUE_COLORS[(n - 1) % 8]! });
          }
        }
        drawOverview(overviewRef.current, st.peaks.overview, fraction, DEFAULT_COLORS, { markers });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [bus, g, deckIndex, framesPerPx]);

  const onSeek = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    engine.seekFraction(deckIndex, Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
  };

  return (
    <div className={`wf-lane deck-${deckIndex === 0 ? 'a' : 'b'}`}>
      <canvas ref={overviewRef} className="wf-overview" height={26} onClick={onSeek} />
      <canvas ref={scrollRef} className="wf-scroll" height={90} />
    </div>
  );
}

export function WaveformBand(): React.JSX.Element {
  return (
    <section className="waveform-band" aria-label="Waveforms">
      <DeckLane deckIndex={0} framesPerPx={90} />
      <DeckLane deckIndex={1} framesPerPx={90} />
    </section>
  );
}
