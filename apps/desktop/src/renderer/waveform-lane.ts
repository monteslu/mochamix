/**
 * WaveformLaneController — the imperative render logic for one scrolling waveform
 * lane, kept OUT of the React component. Owns the GPU renderer + the rAF loop +
 * the per-frame bus/store reads. The component just mounts a canvas and hands it
 * here. Pure logic, no JSX.
 */

import { WaveformGL, drawScrolling, DEFAULT_COLORS } from '@internal-dj/waveform';
import { deck as deckGroup, DeckKeys, type ControlBus } from '@internal-dj/control-bus';
import { getDeckTrack } from './deck-state.js';

const SR = 48000;
// Screen pixels per beat — sets the zoom. Same on every deck, so beats are the
// same width everywhere and synced decks line up. (~64px/beat ≈ 8 beats across a
// 512px lane.)
const PIXELS_PER_BEAT = 64;

export class WaveformLaneController {
  private gl: WaveformGL;
  private uploaded: Uint8Array | null = null;
  private raf = 0;
  private ro: ResizeObserver;
  private readonly group: string;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly bus: ControlBus,
    private readonly deckIndex: number,
    private readonly framesPerPx: number,
  ) {
    this.group = deckGroup(deckIndex + 1);
    this.gl = new WaveformGL(canvas);

    // size the backing store on real resize only (not per frame)
    this.ro = new ResizeObserver(() => this.fit());
    this.fit();
    this.ro.observe(canvas);

    this.raf = requestAnimationFrame(this.tick);
  }

  private fit(): void {
    const w = Math.floor(this.canvas.clientWidth);
    if (w && this.canvas.width !== w) this.canvas.width = w;
  }

  private tick = (): void => {
    const st = getDeckTrack(this.deckIndex);
    if (st.peaks) {
      // upload peaks to the GPU only when the track changes
      if (this.uploaded !== st.peaks.detail.peaks) {
        this.gl.setPeaks(st.peaks.detail.peaks, st.peaks.detail.framesPerBucket);
        this.uploaded = st.peaks.detail.peaks;
      }
      const g = this.group;
      const frames = this.bus.get(g, DeckKeys.trackSamples);
      const fraction = this.bus.get(g, DeckKeys.playPosition);
      const fileBpm = this.bus.get(g, DeckKeys.fileBpm);
      // framesPerBeat in SOURCE frames (for drawing the grid against source peaks).
      const framesPerBeat = fileBpm > 0 ? (60 / fileBpm) * SR : 0;
      const fbf = this.bus.get(g, DeckKeys.firstBeatFrame);

      // Beat-relative zoom: one beat = PIXELS_PER_BEAT pixels, ALWAYS. A track beat
      // spans `framesPerBeat` SOURCE frames (independent of playback rate), and the
      // playhead position is in source frames, so framesPerPx = framesPerBeat /
      // PIXELS_PER_BEAT puts exactly one beat per PIXELS_PER_BEAT pixels. The
      // playhead advances through source frames at the playback rate, so a deck
      // playing faster scrolls faster — and two synced decks (same effective BPM)
      // advance source frames at the same beats/sec → identical visual scroll +
      // aligned grids. (Fixed-px fallback for tracks with no BPM.)
      const framesPerPx =
        framesPerBeat > 0 ? framesPerBeat / PIXELS_PER_BEAT : this.framesPerPx;

      const params = {
        positionFrames: fraction * frames,
        framesPerPx,
        firstBeatFrame: fbf >= 0 ? fbf : 0,
        framesPerBeat,
      };
      if (this.gl.ok) {
        this.gl.draw(params);
      } else {
        // Canvas2D fallback only when WebGL is unavailable.
        drawScrolling(this.canvas, st.peaks.detail, params.positionFrames, framesPerPx, DEFAULT_COLORS, {
          firstBeatFrame: params.firstBeatFrame,
          framesPerBeat,
        });
      }
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.gl.dispose();
  }
}
