/**
 * Deck — one deck's UI: load, transport, tempo, EQ, volume, and the waveform.
 * Everything binds to the control bus via useControl. Loading a track runs the
 * decode → peaks → engine.loadTrack pipeline.
 */

import { useState, useCallback } from 'react';
import { deck as deckGroup, DeckKeys } from '@internal-dj/control-bus';
import { decodeArrayBuffer } from '@internal-dj/codec';
import {
  computePeakSet,
  detailBucketsForDuration,
  type PeakData,
} from '@internal-dj/waveform';
import { useDj, useControl, useControlValue } from '../dj-context.js';
import { WaveformView } from './WaveformView.js';
import { Knob } from './Knob.js';

interface Props {
  deckIndex: number; // 0-based
}

export function Deck({ deckIndex }: Props): React.JSX.Element {
  const { engine, bus, started, start } = useDj();
  const grp = deckGroup(deckIndex + 1);

  const [play, setPlay] = useControl(grp, DeckKeys.play);
  const [rate, setRate] = useControl(grp, DeckKeys.rate);
  const [keylock, setKeylock] = useControl(grp, DeckKeys.keylock);
  const trackLoaded = useControlValue(grp, DeckKeys.trackLoaded);
  const duration = useControlValue(grp, DeckKeys.duration);
  const rateRatio = useControlValue(grp, DeckKeys.rateRatio);

  const [trackName, setTrackName] = useState<string>('');
  const [detail, setDetail] = useState<PeakData | null>(null);
  const [overview, setOverview] = useState<PeakData | null>(null);
  const [loading, setLoading] = useState(false);

  const loadFile = useCallback(
    async (file: { name: string; data: ArrayBuffer }) => {
      setLoading(true);
      try {
        if (!started) {
          await start();
        }
        const ctx = engine.audioContext!;
        const track = await decodeArrayBuffer(ctx, file.data, file.name);

        // Compute peaks from the decoded planar data.
        const channelData: Float32Array[] = [];
        const all = new Float32Array(track.sampleBuffer);
        for (let c = 0; c < track.channels; c++) {
          channelData.push(all.subarray(c * track.frames, (c + 1) * track.frames));
        }
        const durationSec = track.frames / track.sampleRate;
        const { detail: d, overview: o } = computePeakSet(
          channelData,
          track.frames,
          detailBucketsForDuration(durationSec),
        );
        setDetail(d);
        setOverview(o);

        engine.loadTrack(deckIndex, track);
        setTrackName(file.name);
      } finally {
        setLoading(false);
      }
    },
    [engine, started, start, deckIndex],
  );

  const onLoadClick = useCallback(async () => {
    const file = await window.dj.openTrack();
    if (file) {
      await loadFile(file);
    }
  }, [loadFile]);

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0] as (File & { path?: string }) | undefined;
      if (!f) {
        return;
      }
      // Electron exposes the absolute path on dropped files.
      if (f.path) {
        const file = await window.dj.readTrack(f.path);
        await loadFile(file);
      } else {
        const data = await f.arrayBuffer();
        await loadFile({ name: f.name, data });
      }
    },
    [loadFile],
  );

  const togglePlay = useCallback(async () => {
    if (!started) {
      await start();
    }
    setPlay(play > 0.5 ? 0 : 1);
  }, [started, start, play, setPlay]);

  const onSeek = useCallback(
    (fraction: number) => engine.seekFraction(deckIndex, fraction),
    [engine, deckIndex],
  );

  const cue = useCallback(() => {
    // M1 cue = jump to start + stop (full cue modes arrive in M4).
    setPlay(0);
    engine.seekFraction(deckIndex, 0);
  }, [setPlay, engine, deckIndex]);

  const effectiveBpm = useControlValue(grp, DeckKeys.fileBpm) * rateRatio;

  return (
    <section
      className="deck"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      aria-label={`Deck ${deckIndex + 1}`}
    >
      <header className="deck-header">
        <span className="deck-label">DECK {deckIndex + 1}</span>
        <span className="deck-track" title={trackName}>
          {trackName || 'no track loaded'}
        </span>
        <button onClick={onLoadClick} disabled={loading}>
          {loading ? 'loading…' : 'load'}
        </button>
      </header>

      <WaveformView
        deckIndex={deckIndex}
        detail={detail}
        overview={overview}
        onSeek={onSeek}
      />

      <div className="deck-readout">
        <span>{formatTime(duration * useControlValue(grp, DeckKeys.playPosition))}</span>
        <span className="deck-readout-total">{formatTime(duration)}</span>
        {effectiveBpm > 0 && <span className="deck-bpm">{effectiveBpm.toFixed(1)} BPM</span>}
        <span className="deck-rate">{((rateRatio - 1) * 100).toFixed(1)}%</span>
      </div>

      <div className="deck-transport">
        <button className="cue-btn" onClick={cue} disabled={!trackLoaded}>
          CUE
        </button>
        <button
          className={`play-btn ${play > 0.5 ? 'playing' : ''}`}
          onClick={togglePlay}
          disabled={!trackLoaded}
        >
          {play > 0.5 ? '❚❚' : '▶'}
        </button>
      </div>

      <div className="deck-eq">
        <Knob group={grp} ckey={DeckKeys.eqHigh} label="HI" min={0} max={4} center={1} />
        <Knob group={grp} ckey={DeckKeys.eqMid} label="MID" min={0} max={4} center={1} />
        <Knob group={grp} ckey={DeckKeys.eqLow} label="LOW" min={0} max={4} center={1} />
      </div>

      <div className="deck-tempo">
        <label>TEMPO</label>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.001}
          value={rate}
          onChange={(e) => setRate(Number(e.target.value))}
          className="tempo-slider"
          aria-label={`Deck ${deckIndex + 1} tempo`}
        />
        <button className="tiny" onClick={() => setRate(0)} title="reset tempo">
          0
        </button>
        <button
          className={`tiny ${keylock > 0.5 ? 'active' : ''}`}
          onClick={() => setKeylock(keylock > 0.5 ? 0 : 1)}
          title="keylock (master tempo): change speed without changing pitch"
        >
          🔒
        </button>
      </div>

      <div className="deck-volume">
        <Knob group={grp} ckey={DeckKeys.volume} label="VOL" min={0} max={1} center={1} />
      </div>

      {/* silence unused import warning while bus is reserved for future direct reads */}
      <span hidden>{bus ? '' : ''}</span>
    </section>
  );
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) {
    return '0:00';
  }
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
