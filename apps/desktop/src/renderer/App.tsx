/**
 * App — the top-level layout. Two decks flanking a center mixer, Mixxx's classic
 * arrangement (02-functional-spec.md §1). A start gate handles the AudioContext
 * autoplay policy (needs a user gesture).
 */

import { useState, useEffect } from 'react';
import { RECORDING, RecordingKeys } from '@dj/control-bus';
import { DjProvider, useDj, useControlValue, NUM_DECKS } from './dj-context.js';
import { Deck } from './components/Deck.js';
import { Mixer } from './components/Mixer.js';
import { Library } from './components/Library.js';
import { Preferences } from './components/Preferences.js';
import { MainControls } from './components/MainControls.js';
import { TempoFader } from './components/Faders.js';
import { WaveformBand } from './components/WaveformBand.js';
import { startConsoleResize, clearConsoleHeight, applyConsoleHeight } from './panel-sizes.js';
import { isDemo, seedDemo } from './demo.js';
import { useTheme } from './theme.js';

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
  const { recordingControl } = useDj();
  // Drive + reflect via the [Recording] bus control, so the on-screen button and a
  // controller's REC button share one state (and LEDs follow).
  const rec = useControlValue(RECORDING, RecordingKeys.status) > 0.5;
  const [saving, setSaving] = useState(false);

  const toggle = async () => {
    if (rec) setSaving(true);
    try {
      await recordingControl.toggle();
    } finally {
      setSaving(false);
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
  const { started, bus } = useDj();
  const [showPrefs, setShowPrefs] = useState(false);
  const [themeId] = useTheme();

  // Restore the persisted splitter size on mount.
  useEffect(() => {
    const app = document.querySelector('.app') as HTMLElement | null;
    if (app) applyConsoleHeight(app);
  }, []);

  useEffect(() => {
    if (isDemo()) {
      // let the deck components mount + subscribe first
      const t = setTimeout(() => seedDemo(bus), 100);
      return () => clearTimeout(t);
    }
  }, [bus]);

  return (
    <div className="app" data-theme={themeId}>
      <div className="titlebar">
        <span className="brand">MochaMix</span>
        <span className="build-stamp" title="renderer build time">
          {typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'dev'}
        </span>
        <RecordButton />
        <button className="tiny" onClick={() => setShowPrefs(true)} title="Preferences">
          ⚙ preferences
        </button>
        <MainControls />
      </div>
      {showPrefs && <Preferences onClose={() => setShowPrefs(false)} />}
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
          {started ? '● audio running' : 'audio idle, load a track to start'}
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
