/**
 * WaveformLaneController — the imperative render logic for one scrolling waveform
 * lane, kept OUT of the React component. Owns the GPU renderer + the rAF loop +
 * the per-frame bus/store reads. The component just mounts a canvas and hands it
 * here. Pure logic, no JSX.
 */

import { drawScrolling, DEFAULT_COLORS } from '@dj/waveform';
import { deck as deckGroup, DeckKeys, MASTER, MasterKeys, type ControlBus } from '@dj/control-bus';
import { getDeckTrack } from './deck-state.js';
import { reportLaneDraw } from './perf-monitor.js';
import { onFrame } from './frame-loop.js';

const SR = 48000;

// Per-stem waveform colors + their gain keys (NI-Stems order: drums/bass/other/
// vocals). Must match the StemRow mixer colors so fader ↔ wave map by eye.
const STEM_WAVE_COLORS: Array<[number, number, number]> = [
  [255, 93, 93], // drums
  [255, 210, 77], // bass
  [93, 255, 158], // other
  [93, 184, 255], // vocals
];
const STEM_GAIN_KEYS = [
  DeckKeys.stemGain0,
  DeckKeys.stemGain1,
  DeckKeys.stemGain2,
  DeckKeys.stemGain3,
];

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
  private unsub: () => void = () => {};
  private ro: ResizeObserver;
  private readonly group: string;

  // Position smoothing. The worklet publishes playPosition only every ~10.7ms, so
  // the raw value arrives in chunks; two synced decks de-quantize those chunks
  // through DIFFERENT framesPerPx and their stutters don't match → one looks
  // jittery vs the other. We extrapolate the position forward each frame at the
  // deck's rate so both advance smoothly and stay locked. Safe now: heights are
  // pixel-snapped (frozen), so a fractional position only slides the image.
  private smoothFrames = -1;
  private lastTime = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly bus: ControlBus,
    private readonly deckIndex: number,
    private readonly framesPerPx: number,
  ) {
    this.group = deckGroup(deckIndex + 1);
    // Canvas2D scrolling renderer. drawScrolling pixel-SNAPS the bar sampling (so
    // heights are deterministic — horizontal scroll can never change a bar's
    // height) and translates by the sub-pixel remainder (smooth). 2D blit is
    // GPU-composited by the browser. (GPU is still REQUIRED for stems — that's
    // WebGPU compute, a separate pipeline; only this display widget is 2D.)
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
    if (!st.peaks) {
      const ctx = this.canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#0a0d13';
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      }
      return;
    }
    const g = this.group;
    const frames = this.bus.get(g, DeckKeys.trackSamples);
    const fraction = this.bus.get(g, DeckKeys.playPosition);
    const fileBpm = this.bus.get(g, DeckKeys.fileBpm);
    // Use the REAL sample rate (positions + firstBeatFrame are in decoded frames at
    // the AudioContext rate); a hardcoded 48000 drifts the grid at 44100.
    const sr = this.bus.get(MASTER, MasterKeys.sampleRate) || SR;
    const framesPerBeat = fileBpm > 0 ? (60 / fileBpm) * sr : 0;
    const fbf = this.bus.get(g, DeckKeys.firstBeatFrame);

    // Zoom = user preset × the deck's EFFECTIVE rate (rate_ratio), exactly like
    // Mixxx: visualSamplePerPixel = zoomFactor * rateRatio / scaleFactor. Scaling
    // by rate_ratio means a synced/sped-up track is squished so 1 beat occupies the
    // same screen width on BOTH decks — so two synced tracks (even different native
    // BPMs) show matching bar/measure widths and their grids snap together. The
    // base preset is in source-frames-per-pixel at rate 1.0; rate_ratio is stable
    // (changes only on load/sync), so this doesn't reintroduce per-frame rescale.
    const zoomIdx = this.bus.get(MASTER, MasterKeys.waveformZoom);
    const baseFramesPerPx = framesPerPxForZoom(zoomIdx >= 0 ? zoomIdx : DEFAULT_ZOOM_INDEX);
    const rateRatio = this.bus.get(g, DeckKeys.rateRatio) || 1;
    const framesPerPx = baseFramesPerPx * rateRatio;

    // Smooth, rate-extrapolated position so the scroll flows between the worklet's
    // chunky (~10.7ms) publishes — and two synced decks advance in lockstep (no
    // relative jitter). Snap on pause/seek; advance by rate*elapsed while playing,
    // converging gently to the published truth so it never drifts.
    const publishedFrames = fraction * frames;
    const playing = this.bus.get(g, DeckKeys.play) > 0.5;
    const now = performance.now();
    const dt = this.lastTime > 0 ? (now - this.lastTime) / 1000 : 0;
    this.lastTime = now;
    if (this.smoothFrames < 0 || !playing || Math.abs(publishedFrames - this.smoothFrames) > sr * 0.25) {
      this.smoothFrames = publishedFrames; // first frame / paused / seek → snap
    } else {
      const advanced = this.smoothFrames + rateRatio * sr * dt;
      this.smoothFrames = advanced + (publishedFrames - advanced) * 0.1; // converge
    }
    const positionFrames = this.smoothFrames;
    // Stem deck: color each stem, dimming by its live gain (from the stem mixer), so
    // the wave reflects the current mash (muted stem fades out).
    const stemBands =
      st.stemPeaks && st.stemPeaks.length === STEM_WAVE_COLORS.length
        ? st.stemPeaks.map((p, i) => ({
            peaks: p.peaks,
            framesPerBucket: p.framesPerBucket,
            rgb: STEM_WAVE_COLORS[i]!,
            gain: this.bus.get(g, STEM_GAIN_KEYS[i]!),
            scale: st.stemScales?.[i] ?? 1,
          }))
        : undefined;

    const t0 = performance.now();
    drawScrolling(this.canvas, st.peaks.detail, positionFrames, framesPerPx, DEFAULT_COLORS, {
      firstBeatFrame: fbf >= 0 ? fbf : 0,
      framesPerBeat,
      stems: stemBands,
    });
    reportLaneDraw(`deck${this.deckIndex}`, false, performance.now() - t0);
  };

  dispose(): void {
    this.unsub();
    this.ro.disconnect();
  }
}
