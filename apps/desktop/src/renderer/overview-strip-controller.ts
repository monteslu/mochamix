/**
 * OverviewStripController — the imperative render loop for the deck's full-track
 * minimap, kept out of the JSX (same pattern as WaveformLaneController). Owns the
 * canvas sizing (ResizeObserver) + the rAF draw (overview peaks + hotcue markers +
 * position). The component is a thin shell that mounts a canvas + handles seek.
 */

import { drawOverview, DEFAULT_COLORS } from '@dj/waveform';
import {
  deck as deckGroup,
  DeckKeys,
  hotcuePositionKey,
  hotcueEnabledKey,
  type ControlBus,
} from '@dj/control-bus';
import { getDeckTrack } from './deck-state.js';
import { onFrame } from './frame-loop.js';

const HOTCUE_COLORS = ['#ff5a5a', '#ffb84d', '#4ade80', '#37b6ff', '#a78bfa', '#f472b6', '#42d4f4', '#f2f2ff'];

/** Collect enabled hotcue markers (fraction + color) for a deck. Pure-ish read. */
export function collectHotcueMarkers(
  bus: ControlBus,
  group: string,
  frames: number,
): Array<{ fraction: number; color: string }> {
  const markers: Array<{ fraction: number; color: string }> = [];
  for (let n = 1; n <= 8; n++) {
    if (bus.get(group, hotcueEnabledKey(n)) > 0.5) {
      const p = bus.get(group, hotcuePositionKey(n));
      if (p >= 0) markers.push({ fraction: p / frames, color: HOTCUE_COLORS[(n - 1) % 8]! });
    }
  }
  return markers;
}

export class OverviewStripController {
  private unsub: () => void = () => {};
  private ro: ResizeObserver;
  private readonly group: string;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly bus: ControlBus,
    private readonly deckIndex: number,
  ) {
    this.group = deckGroup(deckIndex + 1);
    this.ro = new ResizeObserver(() => this.fit());
    this.fit();
    this.ro.observe(canvas);
    this.unsub = onFrame(this.tick);
  }

  private fit(): void {
    const w = Math.floor(this.canvas.clientWidth);
    if (w && this.canvas.width !== w) this.canvas.width = w;
  }

  private tick = (): void => {
    const c = this.canvas;
    const st = getDeckTrack(this.deckIndex);
    const frames = this.bus.get(this.group, DeckKeys.trackSamples);
    const fraction = this.bus.get(this.group, DeckKeys.playPosition);
    if (st.peaks && frames > 0) {
      const markers = collectHotcueMarkers(this.bus, this.group, frames);
      drawOverview(c, st.peaks.overview, fraction, DEFAULT_COLORS, { markers });
    } else {
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#0b0e14';
        ctx.fillRect(0, 0, c.width, c.height);
      }
    }
  };

  dispose(): void {
    this.unsub();
    this.ro.disconnect();
  }
}
