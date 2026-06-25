/**
 * RowWaveform — the tiny per-row overview waveform in the library table
 * (rekordbox / VirtualDJ style). These are STATIC (no playhead movement), so per
 * Luis's perf note we render each once to an image (OffscreenCanvas → data URL)
 * and cache it, then show a plain <img> — no per-frame canvas redraw for dozens
 * of rows. Shows a spinner while the track is being analyzed.
 */

import { useEffect, useState } from 'react';
import { drawOverview, DEFAULT_COLORS, unpackPeaks, type PeakData } from '@dj/waveform';

const W = 120;
const H = 26;

// process-wide cache: trackId → rendered data URL (or '' = no waveform yet)
const cache = new Map<number, string>();

function renderPeaks(blob: Uint8Array): string {
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(W, H)
      : Object.assign(document.createElement('canvas'), { width: W, height: H });
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
  if (canvas instanceof HTMLCanvasElement) return canvas.toDataURL('image/png');
  // OffscreenCanvas path: convert to blob URL synchronously isn't possible, so
  // fall back to a data URL via a 2D readback.
  const ctx = (canvas as OffscreenCanvas).getContext('2d')!;
  const img = ctx.getImageData(0, 0, W, H);
  const tmp = document.createElement('canvas');
  tmp.width = W;
  tmp.height = H;
  tmp.getContext('2d')!.putImageData(img, 0, 0);
  return tmp.toDataURL('image/png');
}

export function RowWaveform({
  trackId,
  analyzing,
  done,
}: {
  trackId: number;
  analyzing: boolean;
  done: boolean;
}): React.JSX.Element {
  const [url, setUrl] = useState<string>(() => cache.get(trackId) ?? '');

  useEffect(() => {
    let cancelled = false;
    // a freshly-analyzed track has new peaks → bust any empty cache entry
    if (done && cache.get(trackId) === '') cache.delete(trackId);
    if (cache.has(trackId)) {
      setUrl(cache.get(trackId)!);
      return;
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
    // re-fetch when this track just finished analyzing (peaks now exist)
  }, [trackId, done]);

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
