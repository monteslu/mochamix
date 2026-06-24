/**
 * Deck — one deck's UI: load, transport, tempo, EQ, volume, and the waveform.
 * Everything binds to the control bus via useControl. Loading a track runs the
 * decode → peaks → engine.loadTrack pipeline.
 */

import { useState, useCallback, useEffect } from 'react';
import { deck as deckGroup, DeckKeys } from '@internal-dj/control-bus';
import { decodeArrayBuffer } from '@internal-dj/codec';
import {
  computePeakSet,
  detailBucketsForDuration,
  type PeakData,
} from '@internal-dj/waveform';
import { useDj, useControl, useControlValue } from '../dj-context.js';
import { Knob } from './Knob.js';
import { HotcueRow } from './HotcueRow.js';
import { LoopRow } from './LoopRow.js';
import { QuickEffect } from './QuickEffect.js';
import { Platter } from './Platter.js';
import { setDeckTrack, useDeckTrack } from '../deck-state.js';

interface Props {
  deckIndex: number; // 0-based
  side?: 'left' | 'right';
}

export function Deck({ deckIndex, side = 'left' }: Props): React.JSX.Element {
  const { engine, bus, analysis, started, start } = useDj();
  const grp = deckGroup(deckIndex + 1);

  const [play, setPlay] = useControl(grp, DeckKeys.play);
  const [keylock, setKeylock] = useControl(grp, DeckKeys.keylock);
  const [pfl, setPfl] = useControl(grp, DeckKeys.pfl);
  const trackLoaded = useControlValue(grp, DeckKeys.trackLoaded);
  const duration = useControlValue(grp, DeckKeys.duration);
  const rateRatio = useControlValue(grp, DeckKeys.rateRatio);

  const [loading, setLoading] = useState(false);
  const deckTrack = useDeckTrack(deckIndex);
  const trackName = deckTrack.artist
    ? `${deckTrack.artist} - ${deckTrack.title ?? ''}`
    : (deckTrack.title ?? '');

  // Library-initiated loads (peaks + metadata) write to the shared deck store.
  useEffect(() => {
    const handler = (e: Event) => {
      const ev = (e as CustomEvent).detail as {
        deckIndex: number;
        peaks: { detail: PeakData; overview: PeakData };
        track: { title: string | null; artist: string | null; album?: string | null; filename: string; coverUrl?: string | null };
      };
      if (ev.deckIndex !== deckIndex) return;
      setDeckTrack(deckIndex, {
        peaks: ev.peaks,
        title: ev.track.title ?? ev.track.filename,
        artist: ev.track.artist,
        album: ev.track.album ?? null,
        coverUrl: ev.track.coverUrl ?? null,
      });
    };
    window.addEventListener('deck-track-loaded', handler);
    return () => window.removeEventListener('deck-track-loaded', handler);
  }, [deckIndex]);

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
        const peaks = computePeakSet(
          channelData,
          track.frames,
          detailBucketsForDuration(durationSec),
        );
        setDeckTrack(deckIndex, {
          peaks,
          title: file.name.replace(/\.[^.]+$/, ''),
          artist: null,
          album: null,
          coverUrl: null,
        });

        engine.loadTrack(deckIndex, track);

        // Analyze BPM/beatgrid/key off-thread; set controls when done (drives
        // beatloops, sync, smart fader, grid display, key badge).
        void analysis.analyze(track).then((r) => {
          if (r.bpm > 0) {
            bus.set(grp, DeckKeys.fileBpm, r.bpm);
            bus.set(grp, DeckKeys.firstBeatFrame, r.firstBeatFrame);
          }
          if (r.camelot) {
            setDeckTrack(deckIndex, { key: r.camelot });
          }
        });
      } finally {
        setLoading(false);
      }
    },
    [engine, bus, analysis, grp, started, start, deckIndex],
  );

  // Fetch embedded cover art for a path → object URL on the deck store.
  const fetchCover = useCallback(
    async (path?: string) => {
      if (!path) return;
      const cover = await window.dj.trackCover(path);
      if (cover) {
        const url = URL.createObjectURL(new Blob([cover.data], { type: cover.mime }));
        setDeckTrack(deckIndex, { coverUrl: url });
      }
    },
    [deckIndex],
  );

  const onLoadClick = useCallback(async () => {
    const file = await window.dj.openTrack();
    if (file) {
      await loadFile(file);
      void fetchCover(file.path);
    }
  }, [loadFile, fetchCover]);

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
        void fetchCover(f.path);
      } else {
        const data = await f.arrayBuffer();
        await loadFile({ name: f.name, data });
      }
    },
    [loadFile, fetchCover],
  );

  const togglePlay = useCallback(async () => {
    if (!started) {
      await start();
    }
    setPlay(play > 0.5 ? 0 : 1);
  }, [started, start, play, setPlay]);

  const cue = useCallback(() => {
    // M1 cue = jump to start + stop (full cue modes arrive in M4).
    setPlay(0);
    engine.seekFraction(deckIndex, 0);
  }, [setPlay, engine, deckIndex]);

  // Temporary pitch bend: while held, add a small offset to the rate slider; on
  // release, restore. For manual beatmatching (nudge a deck into phase).
  const startBend = useCallback(
    (dir: number) => {
      const base = bus.get(grp, DeckKeys.rate);
      bus.set(grp, DeckKeys.rate, base + dir * 0.08);
      const end = () => {
        bus.set(grp, DeckKeys.rate, base);
        window.removeEventListener('pointerup', end);
      };
      window.addEventListener('pointerup', end);
    },
    [bus, grp],
  );

  const effectiveBpm = useControlValue(grp, DeckKeys.fileBpm) * rateRatio;
  const posFraction = useControlValue(grp, DeckKeys.playPosition);
  const deckKey = deckTrack.key;

  return (
    <section
      className={`deck ${side}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      aria-label={`Deck ${deckIndex + 1}`}
    >
      {/* top: spinning platter + track info */}
      <div className="deck-top">
        <Platter deckIndex={deckIndex} coverUrl={deckTrack.coverUrl} />
        <div className="deck-info">
          <div className="deck-info-head">
            <span className="deck-label">{deckIndex + 1}</span>
            <span className={`deck-title ${trackName ? '' : 'empty'}`} title={trackName}>
              {deckTrack.title ?? 'no track loaded'}
            </span>
            <button className="tiny" onClick={onLoadClick} disabled={loading}>
              {loading ? '…' : 'load'}
            </button>
          </div>
          <div className="deck-artist">{deckTrack.artist ?? ' '}</div>
          <div className="deck-readout">
            <span className="deck-time">{formatTime(duration * posFraction)}</span>
            <span className="deck-readout-total">
              -{formatTime(duration * (1 - posFraction))}
            </span>
            {deckKey && <span className="deck-key">{deckKey}</span>}
          </div>
          <div className="deck-bpmrow">
            <span className="deck-bpm">{effectiveBpm > 0 ? effectiveBpm.toFixed(1) : '--.-'}</span>
            <span className="deck-rate">
              {rateRatio >= 1 ? '+' : ''}
              {((rateRatio - 1) * 100).toFixed(1)}%
            </span>
          </div>
        </div>
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
        <button
          className={`tiny ${keylock > 0.5 ? 'active' : ''}`}
          onClick={() => setKeylock(keylock > 0.5 ? 0 : 1)}
          title="keylock (master tempo)"
        >
          🔒
        </button>
        <button className="tiny bend" onPointerDown={() => startBend(-1)} title="pitch bend down">
          ‹
        </button>
        <button className="tiny bend" onPointerDown={() => startBend(1)} title="pitch bend up">
          ›
        </button>
        <button
          className={`pfl-btn ${pfl > 0.5 ? 'active' : ''}`}
          onClick={() => setPfl(pfl > 0.5 ? 0 : 1)}
          title="Headphone cue (PFL)"
        >
          🎧
        </button>
      </div>

      <HotcueRow deckIndex={deckIndex} />
      <LoopRow deckIndex={deckIndex} />

      <div className="deck-eq">
        <Knob group={grp} ckey={DeckKeys.eqHigh} label="HI" min={0} max={4} center={1} />
        <Knob group={grp} ckey={DeckKeys.eqMid} label="MID" min={0} max={4} center={1} />
        <Knob group={grp} ckey={DeckKeys.eqLow} label="LOW" min={0} max={4} center={1} />
        <QuickEffect deckIndex={deckIndex} />
      </div>
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
