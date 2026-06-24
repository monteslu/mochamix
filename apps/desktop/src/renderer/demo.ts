/**
 * Demo seeding — when the app is loaded with `?demo`, inject synthetic waveform
 * peaks + track metadata + a couple of hotcues so the UI can be screenshotted in
 * a "loaded" state (no real audio device needed). Purely for visual development.
 */

import { computePeakSet, detailBucketsForDuration, type PeakData } from '@internal-dj/waveform';
import {
  deck as deckGroup,
  DeckKeys,
  hotcuePositionKey,
  hotcueEnabledKey,
  MASTER,
  MasterKeys,
  type ControlBus,
} from '@internal-dj/control-bus';

export function isDemo(): boolean {
  return new URLSearchParams(location.search).has('demo');
}

/** Build musical-looking peaks (kick pattern + sweeps) for a fake `frames`-long track. */
function fakePeaks(frames: number, sampleRate: number): { detail: PeakData; overview: PeakData } {
  const ch = new Float32Array(frames);
  const fpb = (60 / 128) * sampleRate; // 128 bpm
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const beatPhase = (i % fpb) / fpb;
    // kick transient at each beat
    const kick = beatPhase < 0.06 ? Math.exp(-beatPhase * 40) : 0;
    // bassline + hats + a slow energy swell
    const bass = 0.5 * Math.sin(2 * Math.PI * 2 * t) * (0.6 + 0.4 * Math.sin(t * 0.2));
    const hat = beatPhase > 0.5 && beatPhase < 0.55 ? 0.3 : 0;
    const swell = 0.3 + 0.5 * Math.abs(Math.sin(t * 0.05));
    ch[i] = Math.min(1, (kick + Math.abs(bass) + hat) * swell);
  }
  const dur = frames / sampleRate;
  return computePeakSet([ch, ch], frames, detailBucketsForDuration(dur));
}

const TRACKS = [
  { artist: 'Com Truise', title: 'Flightwave', bpm: 128 },
  { artist: 'Bonobo', title: 'Kerala', bpm: 122 },
];

/** Seed both decks with demo state. Call once after the React tree mounts. */
export function seedDemo(bus: ControlBus): void {
  const sampleRate = 48000;
  for (let d = 0; d < 2; d++) {
    const g = deckGroup(d + 1);
    const t = TRACKS[d]!;
    const frames = Math.floor((180 + d * 30) * sampleRate); // ~3 min
    const peaks = fakePeaks(frames, sampleRate);

    bus.set(g, DeckKeys.trackLoaded, 1);
    bus.set(g, DeckKeys.trackSamples, frames);
    bus.set(g, DeckKeys.duration, frames / sampleRate);
    bus.set(g, DeckKeys.fileBpm, t.bpm);
    bus.set(g, DeckKeys.playPosition, d === 0 ? 0.34 : 0.52);
    if (d === 0) bus.set(g, DeckKeys.play, 1);
    // a few hotcues
    for (let n = 1; n <= 4; n++) {
      bus.set(g, hotcuePositionKey(n), frames * (0.1 + n * 0.18));
      bus.set(g, hotcueEnabledKey(n), 1);
    }

    window.dispatchEvent(
      new CustomEvent('deck-track-loaded', {
        detail: { deckIndex: d, peaks, track: { ...t, filename: `${t.title}.flac` } },
      }),
    );
  }
  bus.set(MASTER, MasterKeys.crossfader, -0.25);
}
