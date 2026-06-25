/**
 * MainControls — the master OUTPUT gain + Smart Fader toggle, in the titlebar.
 * Mixxx keeps main output out of the channel-strip stack (Deere puts it in the
 * toolbar); doing the same keeps the mixer panel short.
 */

import { MASTER, MasterKeys } from '@dj/control-bus';
import { useControl, useControlValue } from '../dj-context.js';
import { Knob } from './Knob.js';

export function MainControls(): React.JSX.Element {
  const gain = useControlValue(MASTER, MasterKeys.gain);
  const [smartFader, setSmartFader] = useControl(MASTER, MasterKeys.smartFaderEnabled);
  const sfActive = useControlValue(MASTER, MasterKeys.smartFaderActive) > 0.5;
  const sfTargetBpm = useControlValue(MASTER, MasterKeys.smartFaderTargetBpm);

  return (
    <div className="main-controls">
      <button
        className={`smart-icon ${smartFader > 0.5 ? 'active' : ''}`}
        onClick={() => setSmartFader(smartFader > 0.5 ? 0 : 1)}
        title={`Smart Fader: the crossfader blends the two decks' TEMPO, not just volume.${
          sfActive && sfTargetBpm > 0 ? ` Target ${sfTargetBpm.toFixed(0)} BPM.` : ''
        }`}
      >
        🧠
      </button>
      <Knob group={MASTER} ckey={MasterKeys.gain} label="MAIN" min={0} max={5} center={1} hint="Master output level" />
      <span className="mixer-mainval">{gain.toFixed(1)}</span>
    </div>
  );
}
