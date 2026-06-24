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
import { WaveformView } from './WaveformView.js';
import { Knob } from './Knob.js';
import { HotcueRow } from './HotcueRow.js';
import { LoopRow } from './LoopRow.js';
import { VuMeterBar } from './VuMeterBar.js';
import { QuickEffect } from './QuickEffect.js';

interface Props {
  deckIndex: number; // 0-based
}

export function Deck({ deckIndex }: Props): React.JSX.Element {
  const { engine, bus, analysis, started, start } = useDj();
  const grp = deckGroup(deckIndex + 1);

  const [play, setPlay] = useControl(grp, DeckKeys.play);
  const [rate, setRate] = useControl(grp, DeckKeys.rate);
  const [keylock, setKeylock] = useControl(grp, DeckKeys.keylock);
  const [pfl, setPfl] = useControl(grp, DeckKeys.pfl);
  const trackLoaded = useControlValue(grp, DeckKeys.trackLoaded);
  const duration = useControlValue(grp, DeckKeys.duration);
  const rateRatio = useControlValue(grp, DeckKeys.rateRatio);

  const [trackName, setTrackName] = useState<string>('');
  const [detail, setDetail] = useState<PeakData | null>(null);
  const [overview, setOverview] = useState<PeakData | null>(null);
  const [loading, setLoading] = useState(false);

  // Listen for library-initiated loads targeting this deck (peaks + name handoff).
  useEffect(() => {
    const handler = (e: Event) => {
      const detailEv = (e as CustomEvent).detail as {
        deckIndex: number;
        peaks: { detail: PeakData; overview: PeakData };
        track: { title: string | null; artist: string | null; filename: string };
      };
      if (detailEv.deckIndex !== deckIndex) {
        return;
      }
      setDetail(detailEv.peaks.detail);
      setOverview(detailEv.peaks.overview);
      const t = detailEv.track;
      setTrackName(t.artist ? `${t.artist} - ${t.title ?? t.filename}` : (t.title ?? t.filename));
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
        const { detail: d, overview: o } = computePeakSet(
          channelData,
          track.frames,
          detailBucketsForDuration(durationSec),
        );
        setDetail(d);
        setOverview(o);

        engine.loadTrack(deckIndex, track);
        setTrackName(file.name);

        // Analyze BPM/beatgrid off-thread; set file_bpm when done (drives
        // beatloops, sync, smart fader).
        void analysis.analyze(track).then((r) => {
          if (r.bpm > 0) {
            bus.set(grp, DeckKeys.fileBpm, r.bpm);
          }
        });
      } finally {
        setLoading(false);
      }
    },
    [engine, bus, analysis, grp, started, start, deckIndex],
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
        <button
          className={`pfl-btn ${pfl > 0.5 ? 'active' : ''}`}
          onClick={() => setPfl(pfl > 0.5 ? 0 : 1)}
          title="Headphone cue (PFL) — monitor this deck in the headphone bus"
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

      <div className="deck-tempo">
        <button
          className="tiny bend"
          onPointerDown={() => startBend(-1)}
          title="pitch bend down (hold)"
        >
          ‹
        </button>
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
        <button
          className="tiny bend"
          onPointerDown={() => startBend(1)}
          title="pitch bend up (hold)"
        >
          ›
        </button>
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
        <VuMeterBar deckIndex={deckIndex} />
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
