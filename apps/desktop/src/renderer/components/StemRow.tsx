/**
 * StemRow — the live-mashup control surface. Shown only when a deck is playing a
 * .stem.mp4 (hasStems). Four stems (drums/bass/other/vocals), each with a gain fader
 * + mute + solo, driving the per-stem gains in the audio worklet. Mute one deck's
 * vocals + solo another's → a live mashup.
 *
 * Colors match the per-stem waveform coloring so the eye maps fader → wave.
 */

import { deck as deckGroup, DeckKeys } from '@dj/control-bus';
import { useDj, useControlValue } from '../dj-context.js';

/** The 4 stems in NI-Stems order, with their display name + color + pitch control. */
export const STEMS = [
  { key: DeckKeys.stemGain0, pitchKey: DeckKeys.stemPitch0, name: 'DRUMS', color: '#ff5d5d' },
  { key: DeckKeys.stemGain1, pitchKey: DeckKeys.stemPitch1, name: 'BASS', color: '#ffd24d' },
  { key: DeckKeys.stemGain2, pitchKey: DeckKeys.stemPitch2, name: 'OTHER', color: '#5dff9e' },
  { key: DeckKeys.stemGain3, pitchKey: DeckKeys.stemPitch3, name: 'VOCAL', color: '#5db8ff' },
] as const;

export function StemRow({ deckIndex }: { deckIndex: number }): React.JSX.Element | null {
  const { bus } = useDj();
  const grp = deckGroup(deckIndex + 1);
  const hasStems = useControlValue(grp, DeckKeys.hasStems) > 0.5;

  // Live gains + pitch (re-render on change). Fixed hooks (stem count is constant).
  const g0 = useControlValue(grp, STEMS[0].key);
  const g1 = useControlValue(grp, STEMS[1].key);
  const g2 = useControlValue(grp, STEMS[2].key);
  const g3 = useControlValue(grp, STEMS[3].key);
  const gains = [g0, g1, g2, g3];
  const p0 = useControlValue(grp, STEMS[0].pitchKey);
  const p1 = useControlValue(grp, STEMS[1].pitchKey);
  const p2 = useControlValue(grp, STEMS[2].pitchKey);
  const p3 = useControlValue(grp, STEMS[3].pitchKey);
  const pitches = [p0, p1, p2, p3];

  if (!hasStems) return null;

  const setGain = (i: number, v: number) => bus.set(grp, STEMS[i]!.key, v);
  const stemPitch = (i: number) => Math.round(pitches[i] ?? 0);
  const nudgeStemPitch = (i: number, delta: number) => {
    bus.set(grp, STEMS[i]!.pitchKey, Math.max(-12, Math.min(12, stemPitch(i) + delta)));
  };
  const isMuted = (i: number) => (gains[i] ?? 0) <= 0.001;
  const isSolo = (i: number) =>
    (gains[i] ?? 0) > 0.001 && gains.every((g, j) => (j === i ? g > 0.001 : g <= 0.001));

  const toggleMute = (i: number) => setGain(i, isMuted(i) ? 1 : 0);
  const toggleSolo = (i: number) => {
    if (isSolo(i)) {
      // already solo → restore all to full
      STEMS.forEach((_, j) => setGain(j, 1));
    } else {
      STEMS.forEach((_, j) => setGain(j, j === i ? 1 : 0));
    }
  };

  return (
    <div className="stem-row" aria-label="Stem mixer">
      {STEMS.map((stem, i) => (
        <div
          key={i}
          className={`stem-control ${isMuted(i) ? 'muted' : ''}`}
          style={{ '--stem': stem.color } as React.CSSProperties}
        >
          <span className="stem-name">{stem.name}</span>
          <input
            type="range"
            className="stem-fader"
            min={0}
            max={1}
            step={0.01}
            value={gains[i] ?? 0}
            onChange={(e) => setGain(i, Number(e.target.value))}
            title={`${stem.name} level`}
          />
          <div className="stem-buttons">
            <button
              className={`tiny stem-mute ${isMuted(i) ? 'active' : ''}`}
              onClick={() => toggleMute(i)}
              title={`${isMuted(i) ? 'Unmute' : 'Mute'} ${stem.name}`}
            >
              M
            </button>
            <button
              className={`tiny stem-solo ${isSolo(i) ? 'active' : ''}`}
              onClick={() => toggleSolo(i)}
              title={`Solo ${stem.name} (click again to restore all)`}
            >
              S
            </button>
          </div>
          <div className="stem-pitch" title={`${stem.name} key shift: ${stemPitch(i)} semitones`}>
            <button className="tiny" onClick={() => nudgeStemPitch(i, -1)} title="Down a semitone">
              ♭
            </button>
            <span className="stem-pitch-val">{stemPitch(i) === 0 ? '0' : `${stemPitch(i) > 0 ? '+' : ''}${stemPitch(i)}`}</span>
            <button className="tiny" onClick={() => nudgeStemPitch(i, 1)} title="Up a semitone">
              ♯
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
