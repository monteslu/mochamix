/**
 * WaveformLaneController — the imperative render logic for one scrolling waveform
 * lane, kept OUT of the React component. Owns the GPU renderer + the rAF loop +
 * the per-frame bus/store reads. The component just mounts a canvas and hands it
 * here. Pure logic, no JSX.
 */

import { WaveformGL } from '@dj/waveform';
import { deck as deckGroup, DeckKeys, MASTER, MasterKeys, type ControlBus } from '@dj/control-bus';
import { getDeckTrack } from './deck-state.js';
import { reportLaneDraw } from './perf-monitor.js';
import { onFrame } from './frame-loop.js';

const SR = 48000;
// FIXED zoom presets: source frames per screen pixel. Like Mixxx, the waveform's
// sample→pixel scale is a CONSTANT (never derived from BPM — that caused the
// every-frame rescale/shimmer). A few discrete levels the user cycles through;
// global (same on both decks) so synced waves line up. Index 0 = most zoomed in.
// At 48k: 256→5.3ms/px, 512→10.7ms/px, etc.
export const ZOOM_PRESETS = [256, 384, 512, 768, 1152];
const DEFAULT_ZOOM_INDEX = 2;

export function framesPerPxForZoom(index: number): number {
  const i = Math.max(0, Math.min(ZOOM_PRESETS.length - 1, Math.round(index)));
  return ZOOM_PRESETS[i]!;
}

export class WaveformLaneController {
  private gl: WaveformGL;
  private uploaded: Uint8Array | null = null;
  private unsub: () => void = () => {};
  private ro: ResizeObserver;
  private readonly group: string;

  // Position smoothing (dead-reckoning). The worklet publishes playPosition only
  // every ~10.7ms, not every frame, so reading it raw makes the scroll jump-then-
  // hold ("quantized"). We extrapolate between updates: anchor on each NEW
  // published frame, then advance by rate*elapsed each render → flowing motion.
  private anchorFrames = -1; // last published position (source frames)
  private anchorTime = 0; // performance.now() when we anchored
  private lastPublished = -1; // raw published fraction we last saw, to detect change

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly bus: ControlBus,
    private readonly deckIndex: number,
    private readonly framesPerPx: number,
  ) {
    this.group = deckGroup(deckIndex + 1);
    // WebGL is the ONLY renderer — this app requires the GPU (no Canvas2D fallback).
    // WaveformGL never throws; if the context can't init it reports ok=false and the
    // lane shows the GPU-unavailable state instead of silently CPU-rendering.
    this.gl = new WaveformGL(canvas);

    // size the backing store on real resize only (not per frame)
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
    const st = getDeckTrack(this.deckIndex);
    if (st.peaks) {
      // upload peaks to the GPU only when the track changes
      if (this.uploaded !== st.peaks.detail.peaks) {
        const d = st.peaks.detail;
        this.gl?.setPeaks(d.peaks, d.framesPerBucket, d.low, d.mid, d.high);
        this.uploaded = d.peaks;
      }
      const g = this.group;
      const frames = this.bus.get(g, DeckKeys.trackSamples);
      const fraction = this.bus.get(g, DeckKeys.playPosition);
      const fileBpm = this.bus.get(g, DeckKeys.fileBpm);
      const playing = this.bus.get(g, DeckKeys.play) > 0.5;
      const rateRatio = this.bus.get(g, DeckKeys.rateRatio) || 1;
      // Use the REAL sample rate (positions + firstBeatFrame are in decoded frames
      // at the AudioContext rate); a hardcoded 48000 drifts the grid when the
      // context runs at 44100, so synced grids wouldn't line up.
      const sr = this.bus.get(MASTER, MasterKeys.sampleRate) || SR;
      const framesPerBeat = fileBpm > 0 ? (60 / fileBpm) * sr : 0;
      const fbf = this.bus.get(g, DeckKeys.firstBeatFrame);

      // FIXED zoom from the global preset index — does NOT depend on BPM, so the
      // wave scale never rescales/shimmers. The beat grid below still uses
      // framesPerBeat for its lines.
      const zoomIdx = this.bus.get(MASTER, MasterKeys.waveformZoom);
      const framesPerPx = framesPerPxForZoom(zoomIdx >= 0 ? zoomIdx : DEFAULT_ZOOM_INDEX);

      // Smooth, MONOTONIC position. The worklet publishes playPosition only every
      // ~10.7ms, so reading it raw makes the scroll jump-then-hold ("quantized").
      // We extrapolate forward by rate*elapsed between publishes — but the position
      // must only ever MOVE FORWARD at a steady rate while playing; any backward or
      // jittery correction makes each pixel re-sample a different bucket and the
      // amplitudes shimmer. So: take the MAX of (last estimate continued) and the
      // newly published value, never snapping backward. Seeks/pause snap exactly.
      const publishedFrames = fraction * frames;
      const now = performance.now();
      const continued =
        this.anchorFrames < 0
          ? publishedFrames
          : this.anchorFrames + ((now - this.anchorTime) / 1000) * rateRatio * sr;

      let positionFrames: number;
      if (!playing || this.anchorFrames < 0 || Math.abs(publishedFrames - continued) > sr * 0.5) {
        // paused, first frame, or a seek/jump → snap exactly to truth
        positionFrames = publishedFrames;
      } else {
        // playing: never go backward; let the published value pull us forward when
        // it's ahead, otherwise keep gliding at the steady rate.
        positionFrames = Math.max(continued, publishedFrames);
      }
      this.anchorFrames = positionFrames;
      this.anchorTime = now;
      this.lastPublished = fraction;

      const params = {
        positionFrames,
        framesPerPx,
        firstBeatFrame: fbf >= 0 ? fbf : 0,
        framesPerBeat,
      };
      const t0 = performance.now();
      this.gl.draw(params);
      reportLaneDraw(`deck${this.deckIndex}`, this.gl.ok, performance.now() - t0);
    } else {
      // no track → clear the GL framebuffer to the panel grey (so the band never
      // shows white from an undrawn buffer).
      this.gl.clear();
      this.uploaded = null;
    }
  };

  dispose(): void {
    this.unsub();
    this.ro.disconnect();
    this.gl?.dispose();
  }
}
