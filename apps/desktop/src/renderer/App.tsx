/**
 * App — the top-level layout. Two decks flanking a center mixer, Mixxx's classic
 * arrangement (02-functional-spec.md §1). A start gate handles the AudioContext
 * autoplay policy (needs a user gesture).
 */

import { useState, useEffect } from 'react';
import { DjProvider, useDj, NUM_DECKS } from './dj-context.js';
import { Deck } from './components/Deck.js';
import { Mixer } from './components/Mixer.js';
import { Library } from './components/Library.js';
import { AudioSettings } from './components/AudioSettings.js';
import { ControllerSettings } from './components/ControllerSettings.js';
import { TempoFader } from './components/Faders.js';
import { WaveformBand } from './components/WaveformBand.js';
import { useLayoutControls, applyPrefs, getPrefs } from './layout-prefs.js';
import { startConsoleResize, clearConsoleHeight, applyConsoleHeight } from './panel-sizes.js';
import { isDemo, seedDemo } from './demo.js';

/**
 * Splitter — drag to resize the console (decks) vs library split. Writes the
 * console height (px) to a CSS var on .app, which the grid uses for its middle
 * row. The size persists across reloads; double-click resets to the layout
 * preset's default.
 */
function Splitter(): React.JSX.Element {
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const app = (e.currentTarget as HTMLElement).closest('.app') as HTMLElement | null;
    if (!app) return;
    const el = e.currentTarget as Element;
    startConsoleResize(app, (id) => el.setPointerCapture(id), e.pointerId);
  };
  const reset = (e: React.MouseEvent) => {
    const app = (e.currentTarget as HTMLElement).closest('.app') as HTMLElement | null;
    app?.style.removeProperty('--console-h');
    clearConsoleHeight(); // back to the preset default
  };
  return (
    <div
      className="splitter"
      onPointerDown={onPointerDown}
      onDoubleClick={reset}
      title="Drag to resize decks vs library · double-click to reset to the preset"
      role="separator"
      aria-label="Resize decks and library"
    >
      <span className="splitter-grip" />
    </div>
  );
}

function RecordButton(): React.JSX.Element {
  const { recording, started, start } = useDj();
  const [rec, setRec] = useState(false);
  const [saving, setSaving] = useState(false);

  const toggle = async () => {
    if (!started) {
      await start();
    }
    if (rec) {
      setSaving(true);
      try {
        await recording.stopAndSave();
      } finally {
        setRec(false);
        setSaving(false);
      }
    } else {
      await recording.start();
      setRec(true);
    }
  };

  return (
    <button
      className={`tiny record-btn ${rec ? 'recording' : ''}`}
      onClick={() => void toggle()}
      disabled={saving}
      title="Record the master mix to a WAV file"
    >
      {saving ? 'saving…' : rec ? '⏹ stop rec' : '⏺ record'}
    </button>
  );
}

function Stage(): React.JSX.Element {
  const { started, start, bus } = useDj();
  const [showAudio, setShowAudio] = useState(false);
  const [showMidi, setShowMidi] = useState(false);
  const { prefs, toggleDensity, setPreset } = useLayoutControls();

  // Apply saved layout prefs to the .app element on mount. A ?layout=/?density=
  // query param overrides (used for screenshots / sharing a view).
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const ql = q.get('layout');
    const qd = q.get('density');
    if (ql === 'performance' || ql === 'library' || ql === 'minimal') setPreset(ql);
    if (qd === 'compact' || qd === 'comfortable') {
      if (getPrefs().density !== qd) toggleDensity();
    }
    applyPrefs(getPrefs());
    const app = document.querySelector('.app') as HTMLElement | null;
    if (app) applyConsoleHeight(app); // restore the persisted splitter size
  }, [setPreset, toggleDensity]);

  useEffect(() => {
    if (isDemo()) {
      // let the deck components mount + subscribe first
      const t = setTimeout(() => seedDemo(bus), 100);
      return () => clearTimeout(t);
    }
  }, [bus]);

  const PRESETS: { id: 'performance' | 'library' | 'minimal'; label: string; hint: string }[] = [
    { id: 'performance', label: 'Perform', hint: 'Balanced decks + library' },
    { id: 'library', label: 'Library', hint: 'Maximize the browser' },
    { id: 'minimal', label: 'Minimal', hint: 'Decks only, compact' },
  ];

  return (
    <div className="app" data-density={prefs.density} data-layout={prefs.preset}>
      <div className="titlebar">
        <span className="brand">dj-app</span>
        <span className="tagline">built for the love of it</span>
        <span className="build-stamp" title="renderer build time">
          {typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'dev'}
        </span>
        <div className="layout-presets" role="group" aria-label="Layout preset">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className={`tiny ${prefs.preset === p.id ? 'active' : ''}`}
              onClick={() => setPreset(p.id)}
              title={p.hint}
            >
              {p.label}
            </button>
          ))}
          <button
            className={`tiny ${prefs.density === 'compact' ? 'active' : ''}`}
            onClick={toggleDensity}
            title="Toggle compact / comfortable spacing"
          >
            {prefs.density === 'compact' ? '⊟ compact' : '⊞ comfy'}
          </button>
        </div>
        <RecordButton />
        <button className="tiny" onClick={() => setShowMidi(true)} title="MIDI controllers">
          🎛 MIDI
        </button>
        <button className="tiny audio-routing-btn" onClick={() => setShowAudio(true)}>
          🔊 audio routing
        </button>
        {!started && (
          <button className="start-audio" onClick={() => void start()}>
            ▶ start audio
          </button>
        )}
      </div>
      {showAudio && <AudioSettings onClose={() => setShowAudio(false)} />}
      {showMidi && <ControllerSettings onClose={() => setShowMidi(false)} />}
      <WaveformBand />
      <main className="console">
        <TempoFader deckIndex={0} side="left" />
        <Deck deckIndex={0} side="left" />
        <Mixer />
        <Deck deckIndex={1} side="right" />
        <TempoFader deckIndex={1} side="right" />
      </main>
      <Splitter />
      <Library />
      <footer className="statusbar">
        <span>{NUM_DECKS} decks · 48 kHz</span>
        <span className={started ? 'status-live' : ''}>
          {started ? '● audio running' : 'audio idle — click start or load a track'}
        </span>
      </footer>
    </div>
  );
}

export function App(): React.JSX.Element {
  return (
    <DjProvider>
      <Stage />
    </DjProvider>
  );
}
