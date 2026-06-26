/**
 * display.ts — the visualizer DISPLAY (popup window) renderer. This is the CONSUMER of
 * the output bus: it subscribes via IpcTransport (frames relayed by main from the dj-app
 * producer), and renders the visuals here — dj-app itself renders nothing.
 *
 * v1 is intentionally a simple, honest proof the pipe works end-to-end: a live
 * oscilloscope of the master-bus audio bytes + the now-playing metadata. Butterchurn/
 * MilkDrop slots in next, reading the same `consumer.latestAudio()` (feed its patched
 * internal analysers) + `consumer.directive()` for which preset to show.
 */

import { OutputConsumer, IpcTransport } from '@dj/output-bus';

const scope = document.getElementById('scope') as HTMLCanvasElement;
const metaEl = document.getElementById('meta') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const ctx = scope.getContext('2d')!;

function fit(): void {
  scope.width = window.innerWidth * devicePixelRatio;
  scope.height = window.innerHeight * devicePixelRatio;
}
fit();
window.addEventListener('resize', fit);

// A unique id so the app can address THIS display specifically later.
const displayId = `display-${Math.floor(performance.now())}`;
const consumer = new OutputConsumer(
  new IpcTransport({ subscribe: (cb) => window.dj.onDisplayFrame((f) => cb(f as never)) }),
  { id: displayId },
);

let gotData = false;

consumer.onChange(() => {
  const meta = consumer.latestMeta();
  const master = meta?.masterDeck;
  const deck = master != null ? meta?.decks[master] : meta?.decks.find((d) => d.playing);
  if (deck?.title) {
    const pos = deck.positionSec ?? 0;
    const dur = deck.durationSec ?? 0;
    const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    metaEl.innerHTML =
      `<div class="title">${escapeHtml(deck.title)}</div>` +
      `<div class="sub">${escapeHtml(deck.artist ?? '')} ` +
      `${deck.bpm ? `· ${deck.bpm.toFixed(0)} BPM` : ''} ${deck.key ? `· ${deck.key}` : ''} ` +
      `· ${fmt(pos)} / ${fmt(dur)}</div>`;
  } else {
    metaEl.innerHTML = '';
  }
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// Render loop: draw the latest audio bytes as an oscilloscope. The directive() tells us
// what the app wants shown (mode: random/preset/off) — honored simply for v1.
function draw(): void {
  requestAnimationFrame(draw);
  const w = scope.width;
  const h = scope.height;
  const directive = consumer.directive();
  if (directive.mode === 'off') {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    statusEl.textContent = 'blank (off)';
    return;
  }

  const samples = consumer.latestAudio();
  // Fade-trail background for a nicer scope.
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(0, 0, w, h);
  if (!samples) {
    statusEl.textContent = 'waiting for data…';
    return;
  }
  if (!gotData) {
    gotData = true;
    statusEl.textContent = `live · ${samples.length} samples`;
  }

  // Audio energy → hue (so it reacts to loudness). 128 = silence.
  let energy = 0;
  for (let i = 0; i < samples.length; i++) energy += Math.abs(samples[i]! - 128);
  energy /= samples.length;
  const hue = (200 + energy * 4) % 360;
  ctx.lineWidth = Math.max(1, devicePixelRatio * (1 + energy / 8));
  ctx.strokeStyle = `hsl(${hue} 90% ${50 + Math.min(energy, 30)}%)`;
  ctx.beginPath();
  const step = w / samples.length;
  for (let i = 0; i < samples.length; i++) {
    const y = (samples[i]! / 255) * h;
    const x = i * step;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
draw();
