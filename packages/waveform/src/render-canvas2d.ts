/**
 * Canvas2D waveform renderers — the fast path to "I can see the waveform" (first
 * light). A WebGPU/WGSL renderer (porting Mixxx's GLSL from res/shaders) replaces
 * these for the GPU-accelerated scrolling view later (10-electron-feasibility.md
 * §3a). Canvas2D is fine for the overview and good enough to start.
 */

import type { PeakData } from './peaks.js';

/** A point marker (hotcue, main cue) at a track fraction 0..1. */
export interface Marker {
  fraction: number;
  color: string;
  label?: string;
}

/** A loop region (start/end fractions 0..1). */
export interface LoopRegion {
  start: number;
  end: number;
  active: boolean;
}

export interface WaveformColors {
  background: string;
  /** Waveform body color. */
  wave: string;
  /** Already-played portion (overview). */
  played: string;
  /** Playhead line. */
  playhead: string;
  /** Center axis line. */
  axis: string;
}

export const DEFAULT_COLORS: WaveformColors = {
  background: '#14161c',
  wave: '#37b6ff',
  played: '#1d5e80',
  playhead: '#ff5a5a',
  axis: '#2a2e38',
};

/**
 * Draw the full-track overview: the whole waveform scaled to the canvas width,
 * with the played portion tinted and a playhead at `positionFraction` (0..1).
 */
export interface Overlay {
  markers?: Marker[];
  loop?: LoopRegion;
}

export function drawOverview(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  peaks: PeakData,
  positionFraction: number,
  colors: WaveformColors = DEFAULT_COLORS,
  overlay?: Overlay,
): void {
  const ctx = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) {
    return;
  }
  const w = canvas.width;
  const h = canvas.height;
  const mid = h / 2;

  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, w, h);

  // center axis
  ctx.strokeStyle = colors.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.stroke();

  const playedX = Math.round(positionFraction * w);
  const n = peaks.length;

  for (let x = 0; x < w; x++) {
    // map canvas column → peak bucket
    const b = Math.min(n - 1, Math.floor((x / w) * n));
    const amp = (peaks.peaks[b]! / 255) * mid;
    ctx.strokeStyle = x <= playedX ? colors.played : colors.wave;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, mid - amp);
    ctx.lineTo(x + 0.5, mid + amp);
    ctx.stroke();
  }

  // loop region
  if (overlay?.loop && overlay.loop.end > overlay.loop.start) {
    const x0 = overlay.loop.start * w;
    const x1 = overlay.loop.end * w;
    ctx.fillStyle = overlay.loop.active ? 'rgba(74,222,128,0.18)' : 'rgba(125,134,150,0.12)';
    ctx.fillRect(x0, 0, x1 - x0, h);
  }

  // markers (hotcues / main cue)
  if (overlay?.markers) {
    for (const m of overlay.markers) {
      const mx = Math.round(m.fraction * w);
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(mx + 0.5, 0);
      ctx.lineTo(mx + 0.5, h);
      ctx.stroke();
    }
  }

  // playhead
  ctx.strokeStyle = colors.playhead;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(playedX + 0.5, 0);
  ctx.lineTo(playedX + 0.5, h);
  ctx.stroke();
}

/**
 * Draw the zoomed scrolling waveform centered on the play position. `framesPerPx`
 * controls zoom (source frames per canvas pixel). The playhead sits at canvas
 * center; the waveform scrolls under it. Uses the detailed peak set.
 */
/**
 * Amplitude → color, approximating the pro DJ convention (low energy = cool/blue,
 * high energy = warm). Until real 4-band data lands, we grade by overall peak so
 * the waveform reads as colorful + alive rather than a flat monochrome block.
 * `played` dims/desaturates the already-played portion.
 */
// Precomputed color palette (built once). Changing ctx.fillStyle per pixel +
// allocating an rgb() string per pixel was the cause of choppy waveform playback
// (~1000 string allocs + 1000 GPU state flushes per frame). Instead we quantize
// amplitude into PALETTE_N buckets, look up a cached color string, and BATCH all
// columns of the same color into one fill pass — turning ~1000 fillStyle changes
// per frame into ~PALETTE_N.
const PALETTE_N = 48;

function buildPalette(played: boolean): string[] {
  const pal: string[] = new Array(PALETTE_N);
  for (let i = 0; i < PALETTE_N; i++) {
    const amp01 = i / (PALETTE_N - 1);
    let r: number, g: number, b: number;
    if (amp01 < 0.5) {
      const t = amp01 / 0.5;
      r = 30 + t * 20;
      g = 120 + t * 110;
      b = 220 - t * 90;
    } else {
      const t = (amp01 - 0.5) / 0.5;
      r = 50 + t * 200;
      g = 230 - t * 60;
      b = 130 - t * 90;
    }
    if (played) {
      r *= 0.45;
      g *= 0.45;
      b *= 0.45;
    }
    pal[i] = `rgb(${r | 0},${g | 0},${b | 0})`;
  }
  return pal;
}
const PALETTE_LIVE = /* @__PURE__ */ buildPalette(false);
const PALETTE_PLAYED = /* @__PURE__ */ buildPalette(true);

export interface ScrollOverlay {
  /** Beat grid: frame of the first beat + frames per beat (0 = no grid). */
  firstBeatFrame?: number;
  framesPerBeat?: number;
}

export function drawScrolling(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  detail: PeakData,
  positionFrames: number,
  framesPerPx: number,
  _colors: WaveformColors = DEFAULT_COLORS,
  overlay?: ScrollOverlay,
): void {
  const ctx = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) {
    return;
  }
  const w = canvas.width;
  const h = canvas.height;
  const mid = h / 2;
  const centerX = w / 2;
  const { peaks, framesPerBucket, length } = detail;

  // background gradient
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#0c1018');
  bg.addColorStop(0.5, '#06090e');
  bg.addColorStop(1, '#0c1018');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // beat grid (white ticks; brighter downbeat every 4)
  if (overlay?.framesPerBeat && overlay.framesPerBeat > 0) {
    const fpb = overlay.framesPerBeat;
    const first = overlay.firstBeatFrame ?? 0;
    const leftFrame = positionFrames - centerX * framesPerPx;
    const rightFrame = positionFrames + centerX * framesPerPx;
    let n = Math.ceil((leftFrame - first) / fpb);
    for (;;) {
      const bf = first + n * fpb;
      if (bf > rightFrame) break;
      const x = centerX + (bf - positionFrames) / framesPerPx;
      const down = ((n % 4) + 4) % 4 === 0; // downbeat = start of a 4/4 measure
      if (down) {
        // red measure marker (rekordbox / VirtualDJ convention)
        ctx.fillStyle = 'rgba(255,60,60,0.85)';
        ctx.fillRect(x, 0, 2, h);
      } else {
        // brighter white beat ticks
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.fillRect(x, 0, 1, h);
      }
      n++;
    }
  }

  // waveform columns, colored by amplitude, dimmed when played. ONE pass builds a
  // Path2D per palette bucket (×2 for played/live), then each bucket is filled in
  // a single fill() call — so fillStyle changes drop from ~1000/frame to ~96, and
  // there are zero per-pixel string allocations. This is what fixes choppy
  // playback.
  const paths: Path2D[] = [];
  for (let i = 0; i < PALETTE_N * 2; i++) paths.push(new Path2D());
  for (let x = 0; x < w; x++) {
    const frame = positionFrames + (x - centerX) * framesPerPx;
    if (frame < 0) continue;
    const b = Math.floor(frame / framesPerBucket);
    if (b >= length) break;
    const v = peaks[b]!;
    const amp = (v / 255) * mid * 0.92;
    const bucket = ((v / 255) * (PALETTE_N - 1)) | 0;
    const played = x < centerX ? 1 : 0;
    paths[bucket * 2 + played]!.rect(x, mid - amp, 1, amp * 2);
  }
  for (let p = 0; p < PALETTE_N; p++) {
    ctx.fillStyle = PALETTE_LIVE[p]!;
    ctx.fill(paths[p * 2]!);
    ctx.fillStyle = PALETTE_PLAYED[p]!;
    ctx.fill(paths[p * 2 + 1]!);
  }

  // center playhead — glowing line
  ctx.fillStyle = 'rgba(255,90,90,0.18)';
  ctx.fillRect(centerX - 2, 0, 4, h);
  ctx.fillStyle = '#ff5a5a';
  ctx.fillRect(centerX - 0.5, 0, 1.5, h);
}
