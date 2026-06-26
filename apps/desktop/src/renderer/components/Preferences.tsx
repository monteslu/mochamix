/**
 * Preferences — a single tabbed settings window (Mixxx / rekordbox style): a left
 * rail of tabs, content on the right. Consolidates what used to be separate modals
 * (audio routing, MIDI) and adds the behavioral toggles (quantize, platter-release,
 * etc.) that DJs expect to control. One backdrop; each tab renders its own panel.
 */

import { useState } from 'react';
import { AudioSettings } from './AudioSettings.js';
import { ControllerSettings } from './ControllerSettings.js';
import { DecksMixingSettings } from './DecksMixingSettings.js';
import { WaveformSettings } from './WaveformSettings.js';
import { LibrarySettings } from './LibrarySettings.js';

type TabId = 'sound' | 'decks' | 'waveforms' | 'library' | 'controllers';

const TABS: Array<{ id: TabId; label: string; icon: string }> = [
  { id: 'sound', label: 'Sound Hardware', icon: '🔊' },
  { id: 'decks', label: 'Decks & Mixing', icon: '🎚' },
  { id: 'waveforms', label: 'Waveforms', icon: '〰' },
  { id: 'library', label: 'Library', icon: '📁' },
  { id: 'controllers', label: 'Controllers', icon: '🎛' },
];

export function Preferences({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [tab, setTab] = useState<TabId>('decks');

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal preferences" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Preferences</h2>
          <button className="tiny" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="prefs-body">
          <nav className="prefs-tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`prefs-tab${tab === t.id ? ' active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                <span className="prefs-tab-icon">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </nav>
          <section className="prefs-content">
            {tab === 'sound' && <AudioSettings embedded />}
            {tab === 'decks' && <DecksMixingSettings />}
            {tab === 'waveforms' && <WaveformSettings />}
            {tab === 'library' && <LibrarySettings />}
            {tab === 'controllers' && <ControllerSettings embedded />}
          </section>
        </div>
      </div>
    </div>
  );
}
