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
  const hasBands = !!(peaks.low && peaks.mid && peaks.high);

  for (let x = 0; x < w; x++) {
    // map canvas column → peak bucket
    const b = Math.min(n - 1, Math.floor((x / w) * n));
    const amp = (peaks.peaks[b]! / 255) * mid;
    if (hasBands) {
      // frequency color: low=red, mid=green, high=blue, normalized to dominant
      ctx.strokeStyle = bandColorCss(peaks.low![b]!, peaks.mid![b]!, peaks.high![b]!, x <= playedX);
    } else {
      ctx.strokeStyle = x <= playedX ? colors.played : colors.wave;
    }
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

/** Per-stem overview colors (NI-Stems order drums/bass/other/vocals) — matches the top
 * scrolling lane + the StemRow mixer so the deck strip reads the same by eye. */
const STEM_OVERVIEW_COLORS = ['255,93,93', '255,210,77', '93,255,158', '93,184,255'];
/** Back→front paint order so vocals sit on top (same as the top lane's STEM_Z). */
const STEM_OVERVIEW_Z = [2, 1, 0, 3];

/**
 * Stem-aware overview: the deck's full-song strip colored by stem (like the top lane),
 * each stem dimmed by its live gain so a muted stem fades out. `stems` is the 4 per-stem
 * overview PeakData (drums/bass/other/vocals); `gains` the live 0..1 stem gains.
 */
export function drawStemOverview(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  stems: PeakData[],
  gains: number[],
  positionFraction: number,
  colors: WaveformColors = DEFAULT_COLORS,
  overlay?: Overlay,
): void {
  const ctx = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx || stems.length === 0) return;
  const w = canvas.width;
  const h = canvas.height;
  const mid = h / 2;

  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = colors.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.stroke();

  const playedX = Math.round(positionFraction * w);
  // Paint each stem back→front; a low live gain dims (fades) that stem's wave.
  for (const si of STEM_OVERVIEW_Z) {
    const p = stems[si];
    if (!p) continue;
    const gain = gains[si] ?? 1;
    if (gain <= 0.001) continue; // muted → don't paint
    const n = p.length;
    const rgb = STEM_OVERVIEW_COLORS[si]!;
    for (let x = 0; x < w; x++) {
      const b = Math.min(n - 1, Math.floor((x / w) * n));
      const amp = (p.peaks[b]! / 255) * mid;
      if (amp < 0.5) continue;
      // dim by gain; further dim the already-played portion
      const a = gain * (x <= playedX ? 0.55 : 1);
      ctx.strokeStyle = `rgba(${rgb},${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, mid - amp);
      ctx.lineTo(x + 0.5, mid + amp);
      ctx.stroke();
    }
  }

  // loop region + markers + playhead (shared with drawOverview)
  if (overlay?.loop && overlay.loop.end > overlay.loop.start) {
    const x0 = overlay.loop.start * w;
    const x1 = overlay.loop.end * w;
    ctx.fillStyle = overlay.loop.active ? 'rgba(74,222,128,0.18)' : 'rgba(125,134,150,0.12)';
    ctx.fillRect(x0, 0, x1 - x0, h);
  }
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
/** Frequency-band color (low=red, mid=green, high=blue), normalized + dimmed. */
function bandColorCss(low: number, mid: number, high: number, played: boolean): string {
  const m = Math.max(low, mid, high, 1);
  const wl = low / m,
    wm = mid / m,
    wh = high / m;
  const dim = played ? 0.5 : 1;
  // anchor colors: low #ff451a, mid #40e628, high #4d9eff
  const r = Math.min(255, (wl * 255 + wm * 64 + wh * 77) * dim) | 0;
  const g = Math.min(255, (wl * 69 + wm * 230 + wh * 158) * dim) | 0;
  const b = Math.min(255, (wl * 51 + wm * 102 + wh * 255) * dim) | 0;
  return `rgb(${r},${g},${b})`;
}

// A reused offscreen canvas for the bars (so the sub-pixel drawImage slide is a
// clean translate of a finished image). One shared canvas, resized on demand —
// the lanes draw sequentially within a frame, so sharing is safe.
let barsCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
function getBarsCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (!barsCanvas) {
    barsCanvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(w, h)
        : (globalThis.document?.createElement('canvas') as HTMLCanvasElement);
  }
  if (barsCanvas.width !== w) barsCanvas.width = w;
  if (barsCanvas.height !== h) barsCanvas.height = h;
  return barsCanvas;
}

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

/** One stem's per-bucket amplitude + display color, for stem-colored waveforms. */
export interface StemBand {
  /** Per-bucket max-abs amplitude 0..255. */
  peaks: Uint8Array;
  /** Source frames per bucket for THIS stem (may differ from the mixdown's after
   *  independent decode — use it so buckets map to the right screen position). */
  framesPerBucket: number;
  /** Display color [r,g,b] 0..255. */
  rgb: [number, number, number];
  /** 0..1 live gain (from the stem mixer) — dims/hides a muted stem's wave. */
  gain?: number;
  /** Shared-max normalization (≈255/loudest-stem-max). */
  scale?: number;
  /** Paint order (low → high = back → front). Vocals get the highest z so they draw
   *  on top (closest to the user); default 0 keeps array order if unset. */
  z?: number;
}

export interface ScrollOverlay {
  /** Beat grid: frame of the first beat + frames per beat (0 = no grid). */
  firstBeatFrame?: number;
  framesPerBeat?: number;
  /** Real downbeat (bar-start) frames from DownBeat analysis. When present, the red
   *  measure markers are drawn at THESE exact positions instead of every 4th beat. */
  downbeatFrames?: Int32Array;
  /** When present, draw the waveform as overlaid color-per-stem bands (mashup view)
   *  instead of the 3-band RGB. Order: drums, bass, other, vocals. */
  stems?: StemBand[];
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

  // beat grid (white ticks; red downbeats). REAL downbeats from DownBeat analysis
  // are used when available; else fall back to every-4th-beat.
  const leftFrame = positionFrames - centerX * framesPerPx;
  const rightFrame = positionFrames + centerX * framesPerPx;
  const realDownbeats = overlay?.downbeatFrames && overlay.downbeatFrames.length > 0;
  if (overlay?.framesPerBeat && overlay.framesPerBeat > 0) {
    const fpb = overlay.framesPerBeat;
    const first = overlay.firstBeatFrame ?? 0;
    let n = Math.ceil((leftFrame - first) / fpb);
    for (;;) {
      const bf = first + n * fpb;
      if (bf > rightFrame) break;
      const x = centerX + (bf - positionFrames) / framesPerPx;
      // when we have real downbeats, the per-beat loop only draws white ticks; red
      // measure markers come from the downbeat pass below.
      const down = !realDownbeats && ((n % 4) + 4) % 4 === 0;
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

  // Real measure markers (red). A measure is EVERY 4th beat, all on the grid — so we take
  // only the BAR PHASE from analysis (which of the 4 beats is the "1") and then stride a
  // uniform 4 beats. Drawing each raw downbeat frame independently was wrong two ways: an
  // off-grid downbeat lands between beats, AND snapping each one separately let adjacent
  // markers round to non-4-apart beats → 3- or 5-beat "measures". Phase from the first
  // downbeat, stride by 4 beats, guarantees uniform 4-beat measures on the grid.
  if (realDownbeats && overlay?.framesPerBeat && overlay.framesPerBeat > 0) {
    const db = overlay!.downbeatFrames!;
    const fpb = overlay.framesPerBeat;
    const first = overlay.firstBeatFrame ?? 0;
    // bar phase = the first downbeat's beat number mod 4 (which beat starts the bar)
    const phase = ((Math.round((db[0]! - first) / fpb) % 4) + 4) % 4;
    ctx.fillStyle = 'rgba(255,60,60,0.85)';
    // first visible measure beat-index ≥ leftFrame, on the every-4 grid at this phase
    const leftBeat = (leftFrame - first) / fpb;
    let n = phase + Math.ceil((leftBeat - phase) / 4) * 4;
    for (;;) {
      const bf = first + n * fpb;
      if (bf > rightFrame) break;
      const x = centerX + (bf - positionFrames) / framesPerPx;
      ctx.fillRect(x, 0, 2, h);
      n += 4;
    }
  }

  // Waveform bars — frozen heights AND smooth sub-pixel scroll, done right:
  //  1. SNAP the sampling origin to the pixel grid so each integer column maps to a
  //     fixed source-bucket range → a bucket's bar height NEVER changes as we
  //     scroll (Mixxx's rule: round(pos/fpp)*fpp). Heights are deterministic.
  //  2. Draw the bars at INTEGER x onto an OFFSCREEN canvas (crisp, full opacity).
  //  3. drawImage the offscreen onto the lane shifted by the sub-pixel REMAINDER.
  //     drawImage does ONE bilinear translate of the finished image — smooth slide,
  //     and it can't change heights OR flicker brightness (the bars are already a
  //     finished picture; we just slide it). This avoids the per-bar anti-alias
  //     brightness pulse that a fractional ctx.translate on 1px fillRects caused.
  const posPx = positionFrames / framesPerPx;
  const snapPx = Math.round(posPx);
  const subPx = posPx - snapPx; // -0.5..0.5
  const bands = detail.low && detail.mid && detail.high;
  const stems = overlay?.stems;

  // offscreen is 2px wider so the sub-pixel slide never reveals an edge gap
  const off = getBarsCanvas(w + 2, h);
  const octx = off.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  octx.clearRect(0, 0, w + 2, h);

  if (stems && stems.length > 0) {
    // STEM MODE: overlay each stem in its own color (Mixxx waveformrendererstem).
    // Painted back-to-front in a fixed Z-ORDER so the most-fun-to-toggle stem sits
    // CLOSEST to the user: other → bass → drums → VOCALS (vocals drawn last, on top).
    // Layers are drawn source-over with high opacity so the front stem visually wins
    // where they overlap (vocals pop), while quieter/back stems still peek through.
    // A muted stem (gain ~0) fades out so the wave reflects the live mix. Heights use
    // a SHARED max (the loudest stem), like Mixxx (height / one m_maxValue).
    const drawn = [...stems].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
    octx.globalCompositeOperation = 'source-over';
    for (const stem of drawn) {
      const g = stem.gain ?? 1;
      if (g <= 0.001) continue; // muted → not drawn
      const [r, gg, bl] = stem.rgb;
      const a = 0.92 * Math.min(1, g + 0.25); // gain dims the band; near-opaque so top wins
      octx.fillStyle = `rgba(${r},${gg},${bl},${a})`;
      const sp = stem.peaks;
      const norm = stem.scale ?? 1;
      // use THIS stem's own bucketing (not the mixdown's) so its bars map correctly
      const sfpb = stem.framesPerBucket || framesPerBucket;
      for (let ox = 0; ox < w + 2; ox++) {
        const x = ox - 1;
        const b = snapPx + (x - centerX);
        const frame = b * framesPerPx;
        if (frame < 0) continue;
        const bi = Math.floor(frame / sfpb);
        if (bi >= sp.length) break;
        const amp = Math.min(1, (sp[bi]! / 255) * norm) * mid * 0.92;
        if (amp <= 0) continue;
        octx.fillRect(ox, mid - amp, 1, amp * 2);
      }
    }
  } else {
    // offscreen column ox corresponds to lane x = ox - 1 (1px left margin)
    for (let ox = 0; ox < w + 2; ox++) {
      const x = ox - 1;
      const b = snapPx + (x - centerX); // integer bucket-column (snapped → frozen)
      const frame = b * framesPerPx;
      if (frame < 0) continue;
      const bi = Math.floor(frame / framesPerBucket);
      if (bi >= length) break;
      const v = peaks[bi]!;
      const amp = (v / 255) * mid * 0.92;
      if (amp <= 0) continue;
      const played = x < centerX;
      if (bands) {
        octx.fillStyle = bandColorCss(detail.low![bi]!, detail.mid![bi]!, detail.high![bi]!, played);
      } else {
        const bucket = ((v / 255) * (PALETTE_N - 1)) | 0;
        octx.fillStyle = played ? PALETTE_PLAYED[bucket]! : PALETTE_LIVE[bucket]!;
      }
      octx.fillRect(ox, mid - amp, 1, amp * 2);
    }
  }
  // blit with the sub-pixel slide. drawImage at a fractional x = smooth translate.
  ctx.drawImage(off as CanvasImageSource, -1 - subPx, 0);

  // center playhead — glowing line (drawn AFTER restore so it stays fixed/sharp)
  ctx.fillStyle = 'rgba(255,90,90,0.18)';
  ctx.fillRect(centerX - 2, 0, 4, h);
  ctx.fillStyle = '#ff5a5a';
  ctx.fillRect(centerX - 0.5, 0, 1.5, h);
}
