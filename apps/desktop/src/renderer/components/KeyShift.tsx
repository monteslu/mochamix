/**
 * KeyShift — per-deck key (pitch) controls: the current key, a ± semitone shifter, and
 * a one-click "match" that transposes this deck to be harmonically compatible with the
 * OTHER deck (Mixxx's sync_key / Camelot harmonic mixing). For DJs without music theory:
 * press MATCH and the two tracks blend in key. Sensible defaults — 0 shift, formant
 * preserve on (set in Preferences).
 *
 * The shift drives DeckKeys.pitch (semitones), which the worklet applies via the
 * time-stretch scaler (pitch independent of tempo).
 */

import { deck as deckGroup, DeckKeys } from '@dj/control-bus';
import { keyToCamelot, transposeKey, shortestStepsToCompatibleKey, areKeysCompatible } from '@dj/analysis';
import { useControl, useControlValue } from '../dj-context.js';

export function KeyShift({ deckIndex }: { deckIndex: number }): React.JSX.Element | null {
  const grp = deckGroup(deckIndex + 1);
  const [pitch, setPitch] = useControl(grp, DeckKeys.pitch);
  const fileKeyNum = useControlValue(grp, DeckKeys.fileKeyNum);

  // The OTHER deck's detected key (for "match"). 2-deck layout.
  const otherIndex = deckIndex === 0 ? 1 : 0;
  const otherKeyNum = useControlValue(deckGroup(otherIndex + 1), DeckKeys.fileKeyNum);

  if (!fileKeyNum) return null; // no detected key → nothing to shift meaningfully

  const semis = Math.round(pitch);
  // Current sounding key = detected key transposed by the active shift.
  const shiftedKey = transposeKey(fileKeyNum, semis);
  const shiftedCamelot = keyToCamelot(shiftedKey);
  const origCamelot = keyToCamelot(fileKeyNum);

  const nudge = (delta: number) => setPitch(Math.max(-12, Math.min(12, semis + delta)));
  const reset = () => setPitch(0);

  // "Match": shortest shift that makes THIS deck compatible with the other deck.
  const matchSteps = otherKeyNum ? shortestStepsToCompatibleKey(fileKeyNum, otherKeyNum) : 0;
  const alreadyCompatible = otherKeyNum ? areKeysCompatible(shiftedKey, otherKeyNum) : false;
  const canMatch = otherKeyNum > 0;
  const doMatch = () => setPitch(matchSteps);

  return (
    <div className="keyshift" title="Key shift (harmonic mixing)">
      <div className="keyshift-readout">
        <span className={`keyshift-key${semis !== 0 ? ' shifted' : ''}`}>{shiftedCamelot}</span>
        {semis !== 0 && (
          <span className="keyshift-orig" title={`Original key ${origCamelot}`}>
            ({semis > 0 ? '+' : ''}
            {semis})
          </span>
        )}
      </div>
      <div className="keyshift-controls">
        <button className="tiny keyshift-btn" onClick={() => nudge(-1)} title="Down a semitone">
          ♭
        </button>
        <button
          className="tiny keyshift-btn keyshift-reset"
          onClick={reset}
          disabled={semis === 0}
          title="Reset to original key"
        >
          0
        </button>
        <button className="tiny keyshift-btn" onClick={() => nudge(1)} title="Up a semitone">
          ♯
        </button>
        {canMatch && (
          <button
            className={`tiny keyshift-match${alreadyCompatible ? ' ok' : ''}`}
            onClick={doMatch}
            title={
              alreadyCompatible
                ? 'Already in a compatible key with the other deck'
                : `Match the other deck's key (shift ${matchSteps > 0 ? '+' : ''}${matchSteps})`
            }
          >
            {alreadyCompatible ? '✓ key' : 'match'}
          </button>
        )}
      </div>
    </div>
  );
}
