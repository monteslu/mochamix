/**
 * DecksMixingSettings — the "Decks & Mixing" preferences tab: beat/measure behavior
 * DJs expect to control. Settings apply to BOTH decks (they're per-deck controls on
 * the bus, written to deck 1 and 2 together). Reads current values from the bus.
 */

import { useEffect, useState } from 'react';
import { deck as deckGroup, DeckKeys } from '@dj/control-bus';
import { useDj } from '../dj-context.js';

const DECK_GROUPS = [deckGroup(1), deckGroup(2)];

export function DecksMixingSettings(): React.JSX.Element {
  const { bus } = useDj();

  // Read the current value off deck 1 (both are kept in lockstep here).
  const [quantize, setQuantizeState] = useState(() => bus.get(DECK_GROUPS[0]!, DeckKeys.quantize) > 0.5);
  const [releaseMode, setReleaseModeState] = useState(() =>
    Math.round(bus.get(DECK_GROUPS[0]!, DeckKeys.platterReleaseMode)),
  );
  const [formant, setFormantState] = useState(() => bus.get(DECK_GROUPS[0]!, DeckKeys.formantPreserve) > 0.5);
  const [autoMatch, setAutoMatchState] = useState(false);
  useEffect(() => {
    void window.dj.settingsGet('autoMatchKey').then((v) => setAutoMatchState(v === '1'));
  }, []);

  const setQuantize = (on: boolean): void => {
    setQuantizeState(on);
    for (const g of DECK_GROUPS) bus.set(g, DeckKeys.quantize, on ? 1 : 0);
  };
  const setReleaseMode = (mode: number): void => {
    setReleaseModeState(mode);
    for (const g of DECK_GROUPS) bus.set(g, DeckKeys.platterReleaseMode, mode);
  };
  const setFormant = (on: boolean): void => {
    setFormantState(on);
    for (const g of DECK_GROUPS) bus.set(g, DeckKeys.formantPreserve, on ? 1 : 0);
  };
  const setAutoMatch = (on: boolean): void => {
    setAutoMatchState(on);
    void window.dj.settingsSet('autoMatchKey', on ? '1' : '0');
  };

  return (
    <div className="prefs-panel">
      <h3>Beat & Measure</h3>

      <label className="prefs-row">
        <input type="checkbox" checked={quantize} onChange={(e) => setQuantize(e.target.checked)} />
        <span>
          Quantize to beat grid
          <small>Snap cue points, loops, and play drops to the nearest beat.</small>
        </span>
      </label>

      <fieldset className="prefs-radio">
        <legend>When I release the platter (after nudging to line up measures)</legend>
        <label className="prefs-row">
          <input
            type="radio"
            name="release"
            checked={releaseMode === 1}
            onChange={() => setReleaseMode(1)}
          />
          <span>
            Snap to the nearest beat <em>(recommended)</em>
            <small>
              Tightens hand wobble to this deck&apos;s own grid (≤¼ beat). Your manual
              measure alignment survives. This is how Rekordbox/Mixxx behave.
            </small>
          </span>
        </label>
        <label className="prefs-row">
          <input
            type="radio"
            name="release"
            checked={releaseMode === 0}
            onChange={() => setReleaseMode(0)}
          />
          <span>
            Leave it exactly where I let go
            <small>Pure manual control. No snapping at all on release.</small>
          </span>
        </label>
        <label className="prefs-row">
          <input
            type="radio"
            name="release"
            checked={releaseMode === 2}
            onChange={() => setReleaseMode(2)}
          />
          <span>
            Re-sync to the other deck
            <small>
              Re-aligns phase to the leader deck (only when this deck is synced). Can
              move you off your manual alignment.
            </small>
          </span>
        </label>
      </fieldset>

      <p className="prefs-note">
        Tip: with real downbeat markers on the waveform, you can hand-align measures by
        eye, then release — the beat snap keeps your alignment locked. We don&apos;t
        auto-jump to the bar (a full-measure jump mid-mix would be jarring).
      </p>

      <h3 style={{ marginTop: 22 }}>Key &amp; Harmonic Mixing</h3>
      <label className="prefs-row">
        <input
          type="checkbox"
          checked={autoMatch}
          onChange={(e) => setAutoMatch(e.target.checked)}
        />
        <span>
          Auto-match key on load
          <small>
            When you load a track, automatically shift it into a key compatible with the
            OTHER deck (like sync, but for key). Off by default — auto-shifting runs the
            pitch engine on every load. You can always press <strong>match</strong> on a
            deck manually instead.
          </small>
        </span>
      </label>
      <label className="prefs-row">
        <input type="checkbox" checked={formant} onChange={(e) => setFormant(e.target.checked)} />
        <span>
          Preserve formants on key shift
          <small>
            Keep voices/instruments sounding natural when you shift key (avoids the
            &quot;chipmunk&quot; effect) — uses the Rubber Band engine. Recommended on.
          </small>
        </span>
      </label>
      <p className="prefs-note">
        Each deck has a key (Camelot, e.g. 8A). Use the ♯/♭ buttons on a deck to shift its
        key, or <strong>match</strong> to auto-shift it into a harmonically compatible key
        with the other deck — no music theory needed. The library highlights tracks that
        already mix in key with the loaded deck.
      </p>
    </div>
  );
}
