/**
 * RowWaveform — the tiny per-row overview waveform in the library table
 * (rekordbox / VirtualDJ style). These are STATIC (no playhead movement), so per
 * Luis's perf note we render each once to an image (OffscreenCanvas → data URL)
 * and cache it, then show a plain <img> — no per-frame canvas redraw for dozens
 * of rows. Shows a spinner while the track is being analyzed.
 */

import { useEffect, useState } from 'react';
import {
  drawOverview,
  DEFAULT_COLORS,
  unpackPeaks,
  unpackStemWaveforms,
  STEM_COLORS,
  type PeakData,
} from '@dj/waveform';
import { computeStemWaveforms } from '../stem-thumbnail.js';
import { useDj } from '../dj-context.js';

const W = 120;
const H = 26;

// Per-stem thumbnail colors from the canonical palette (matches the deck lane).
const STEM_RGB: Array<[number, number, number]> = STEM_COLORS.map((s) => [...s.rgb]);
const STEM_DRAW_ORDER = [2, 1, 0, 3]; // other, bass, drums, vocals(last/on top)

// process-wide cache: trackId → rendered data URL (or '' = no waveform yet)
const cache = new Map<number, string>();

function canvasToDataUrl(canvas: OffscreenCanvas | HTMLCanvasElement): string {
  if (canvas instanceof HTMLCanvasElement) return canvas.toDataURL('image/png');
  const ctx = (canvas as OffscreenCanvas).getContext('2d')!;
  const img = ctx.getImageData(0, 0, W, H);
  const tmp = document.createElement('canvas');
  tmp.width = W;
  tmp.height = H;
  tmp.getContext('2d')!.putImageData(img, 0, 0);
  return tmp.toDataURL('image/png');
}

function newCanvas(): OffscreenCanvas | HTMLCanvasElement {
  return typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(W, H)
    : Object.assign(document.createElement('canvas'), { width: W, height: H });
}

/** Render the 4-stem colored thumbnail (vocals on top) from a packed stem blob. */
function renderStemPeaks(blob: Uint8Array): string {
  const sw = unpackStemWaveforms(blob);
  const canvas = newCanvas();
  const ctx = (canvas as OffscreenCanvas | HTMLCanvasElement).getContext(
    '2d',
  ) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  ctx.clearRect(0, 0, W, H);
  if (!sw) return canvasToDataUrl(canvas);
  const mid = H / 2;
  for (const k of STEM_DRAW_ORDER) {
    const peaks = sw.peaks[k]!;
    const [r, g, b] = STEM_RGB[k]!;
    ctx.fillStyle = `rgba(${r},${g},${b},0.92)`;
    const n = peaks.length;
    for (let x = 0; x < W; x++) {
      const bi = Math.floor((x / W) * n);
      const amp = Math.min(1, (peaks[bi]! / 255) * sw.scale) * mid * 0.92;
      if (amp <= 0) continue;
      ctx.fillRect(x, mid - amp, 1, amp * 2);
    }
  }
  return canvasToDataUrl(canvas);
}

function renderPeaks(blob: Uint8Array): string {
  const canvas = newCanvas();
  // The cached blob is packed (amp/low/mid/high per bucket). Unpack so the row
  // waveform is FREQUENCY-COLORED like the deck overview.
  const u = unpackPeaks(blob);
  const data: PeakData = {
    length: u.peaks.length,
    peaks: u.peaks,
    low: u.low,
    mid: u.mid,
    high: u.high,
    framesPerBucket: 1,
    frames: u.peaks.length,
  };
  // fraction 0 (no playhead emphasis needed for a static thumbnail)
  drawOverview(canvas as unknown as HTMLCanvasElement, data, 0, DEFAULT_COLORS);
  return canvasToDataUrl(canvas);
}

export function RowWaveform({
  trackId,
  analyzing,
  done,
  hasStems = false,
}: {
  trackId: number;
  analyzing: boolean;
  done: boolean;
  /** Track has a generated .stem.mp4 → render the colored 4-stem thumbnail. */
  hasStems?: boolean;
}): React.JSX.Element {
  const { engine, started } = useDj();
  const [url, setUrl] = useState<string>(() => cache.get(trackId) ?? '');

  useEffect(() => {
    let cancelled = false;
    // a freshly-analyzed track has new peaks → bust any empty cache entry
    if (done && cache.get(trackId) === '') cache.delete(trackId);
    if (cache.has(trackId)) {
      setUrl(cache.get(trackId)!);
      return;
    }

    // Stem track: prefer the colored 4-stem thumbnail. Use the cached per-stem blob,
    // or compute it lazily from the .stem.mp4 the first time (then it's cached in DB).
    if (hasStems) {
      void (async () => {
        try {
          let blob = await window.dj.libraryStemWaveforms(trackId);
          if ((!blob || blob.length === 0) && engine.audioContext) {
            const file = await window.dj.readTrackById(trackId);
            if (file?.isStem) {
              const computed = await computeStemWaveforms(engine.audioContext, file.data);
              if (computed) {
                await window.dj.librarySetStemWaveforms(trackId, computed);
                blob = computed;
              }
            }
          }
          if (cancelled) return;
          if (blob && blob.length > 0) {
            const u = renderStemPeaks(blob);
            cache.set(trackId, u);
            setUrl(u);
            return;
          }
        } catch {
          /* fall through to the plain mixdown wave below */
        }
        // no stem thumbnail → fall back to the mixdown overview
        if (cancelled) return;
        const peaks = await window.dj.libraryWaveform(trackId);
        if (cancelled) return;
        if (peaks && peaks.length > 0) {
          const u = renderPeaks(peaks);
          cache.set(trackId, u);
          setUrl(u);
        } else {
          setUrl('');
        }
      })();
      return () => {
        cancelled = true;
      };
    }
    // demo mode: synthesize a packed (amp/low/mid/high) blob so the mini-waves are
    // visible AND colored in screenshots.
    if (new URLSearchParams(location.search).has('demo')) {
      const n = 120;
      const blob = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) {
        const amp = 0.4 + 0.6 * Math.abs(Math.sin(i * 0.3 + trackId));
        blob[i * 4] = Math.floor(amp * 255);
        blob[i * 4 + 1] = Math.floor(amp * Math.abs(Math.sin(i * 0.11)) * 255); // low
        blob[i * 4 + 2] = Math.floor(amp * Math.abs(Math.sin(i * 0.37)) * 255); // mid
        blob[i * 4 + 3] = Math.floor(amp * Math.abs(Math.sin(i * 0.9)) * 255); // high
      }
      const u = renderPeaks(blob);
      cache.set(trackId, u);
      setUrl(u);
      return;
    }
    void window.dj.libraryWaveform(trackId).then((peaks) => {
      if (cancelled) return;
      if (peaks && peaks.length > 0) {
        const u = renderPeaks(peaks);
        cache.set(trackId, u);
        setUrl(u);
      } else {
        setUrl('');
      }
    });
    return () => {
      cancelled = true;
    };
    // re-fetch when this track just finished analyzing (peaks now exist) or gains stems
    // `started` is a dep so the web build (where the AudioContext only exists after the
    // user gesture) re-runs the stem-thumbnail compute once audio starts — otherwise the
    // demo rows render with no thumbnail because engine.audioContext was null on mount.
  }, [trackId, done, hasStems, engine, started]);

  if (analyzing) {
    return (
      <span className="rowwave rowwave-analyzing" title="Analyzing…">
        <span className="spin" />
      </span>
    );
  }
  if (url) {
    return <img className="rowwave" src={url} width={W} height={H} alt="" draggable={false} />;
  }
  return <span className="rowwave rowwave-empty" title="Not analyzed yet" />;
}
