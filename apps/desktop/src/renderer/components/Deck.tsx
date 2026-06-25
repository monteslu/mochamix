/**
 * Deck — one deck's UI: load, transport, tempo, EQ, volume, and the waveform.
 * Everything binds to the control bus via useControl. Loading a track runs the
 * decode → peaks → engine.loadTrack pipeline.
 */

import { useState, useCallback, useRef } from 'react';
import { deck as deckGroup, DeckKeys } from '@dj/control-bus';
import { useDj, useControl, useControlValue } from '../dj-context.js';
import { HotcueRow } from './HotcueRow.js';
import { LoopRow } from './LoopRow.js';
import { Platter } from './Platter.js';
import { OverviewStrip } from './OverviewStrip.js';
import { useDeckTrack } from '../deck-state.js';
import { loadTrackToDeck } from '../track-loader.js';

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
  const [sync, setSync] = useControl(grp, DeckKeys.syncEnabled);
  const [quantize, setQuantize] = useControl(grp, DeckKeys.quantize);
  const trackLoaded = useControlValue(grp, DeckKeys.trackLoaded);
  const duration = useControlValue(grp, DeckKeys.duration);
  const rateRatio = useControlValue(grp, DeckKeys.rateRatio);

  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const deckTrack = useDeckTrack(deckIndex);
  const trackName = deckTrack.artist
    ? `${deckTrack.artist} - ${deckTrack.title ?? ''}`
    : (deckTrack.title ?? '');

  // Load a file's bytes into this deck via the shared pipeline (decode → peaks →
  // engine → analysis → deck-state). All the heavy logic lives in track-loader.ts.
  const load = useCallback(
    async (file: { name: string; data: ArrayBuffer; path?: string }, libraryId?: number) => {
      setLoading(true);
      try {
        if (!started) await start();
        await loadTrackToDeck({ engine, bus, analysis }, deckIndex, {
          file,
          coverPath: file.path,
          libraryId,
        });
      } finally {
        setLoading(false);
      }
    },
    [engine, bus, analysis, deckIndex, started, start],
  );

  const onLoadClick = useCallback(async () => {
    const file = await window.dj.openTrack();
    if (file) await load(file);
  }, [load]);

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);

      // 1. Drag from the library (a track id) → load that track to THIS deck.
      const libId = e.dataTransfer.getData('application/x-dj-track-id');
      if (libId) {
        const file = await window.dj.readTrackById(Number(libId));
        if (file) await load(file, Number(libId));
        return;
      }

      // 2. Drag a file from the OS.
      const f = e.dataTransfer.files[0] as (File & { path?: string }) | undefined;
      if (!f) return;
      if (f.path) {
        await load(await window.dj.readTrack(f.path));
      } else {
        await load({ name: f.name, data: await f.arrayBuffer() });
      }
    },
    [load],
  );

  const togglePlay = useCallback(async () => {
    if (!started) {
      await start();
    }
    // Browsers auto-suspend the AudioContext; resume on the play gesture so
    // pressing play always actually produces sound (not just advances state).
    const ctx = engine.audioContext;
    if (ctx && ctx.state === 'suspended') {
      await ctx.resume();
    }
    setPlay(play > 0.5 ? 0 : 1);
  }, [started, start, play, setPlay, engine]);

  // CUE — standard Pioneer/CDJ behavior (per the DJ-software spec):
  //  press while PLAYING            → jump back to the cue point + pause (back-cue)
  //  press while PAUSED AT the cue  → preview: play from the cue while held
  //  press while PAUSED elsewhere   → set the cue point here (paused, silent)
  //  release after a preview        → snap back to the cue point + pause
  // The cue point defaults to track start on load, so CUE always has a target.
  const cuePreviewing = useRef(false);
  const cueDown = useCallback(() => {
    if (play > 0.5) {
      // back-cue: return to the cue point and pause
      bus.set(grp, DeckKeys.cueGotoAndStop, 1);
      return;
    }
    // paused: are we AT the cue point? (within ~1/8 sec)
    const frames = bus.get(grp, DeckKeys.trackSamples);
    const cuePos = bus.get(grp, DeckKeys.cuePoint);
    const posFrames = bus.get(grp, DeckKeys.playPosition) * frames;
    const atCue = cuePos >= 0 && Math.abs(posFrames - cuePos) < 48000 / 8;
    if (atCue) {
      // preview: play from the cue while held
      cuePreviewing.current = true;
      setPlay(1);
    } else {
      // set a new cue point here
      bus.set(grp, DeckKeys.cueSet, 1);
    }
  }, [play, bus, grp, setPlay]);
  const cueUp = useCallback(() => {
    if (cuePreviewing.current) {
      cuePreviewing.current = false;
      setPlay(0);
      bus.set(grp, DeckKeys.cueGotoAndStop, 1); // snap back to the cue
    }
  }, [bus, grp, setPlay]);

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
      className={`deck ${side} ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={(e) => {
        // only clear when leaving the deck entirely, not crossing children
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
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

      <OverviewStrip deckIndex={deckIndex} />

      <div className="deck-transport">
        <button
          className="cue-btn"
          onPointerDown={cueDown}
          onPointerUp={cueUp}
          onPointerLeave={cueUp}
          disabled={!trackLoaded}
          title="CUE (Pioneer/CDJ): playing → jump back to cue + pause. Paused at cue → hold to preview (plays while held, snaps back on release). Paused elsewhere → set cue here."
        >
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
          className={`sync-btn tiny ${sync > 0.5 ? 'active' : ''}`}
          onClick={() => setSync(sync > 0.5 ? 0 : 1)}
          title="Beat sync: match tempo + phase-lock to the other deck"
        >
          SYNC
        </button>
        <button
          className={`tiny ${quantize > 0.5 ? 'active' : ''}`}
          onClick={() => setQuantize(quantize > 0.5 ? 0 : 1)}
          title="Quantize: snap cues/loops to the beat grid"
        >
          QNT
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
