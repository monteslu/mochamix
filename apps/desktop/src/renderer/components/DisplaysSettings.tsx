/**
 * DisplaysSettings — the "Displays" preferences tab. dj-app renders no visuals; it
 * EMITS data (master-bus audio + track metadata + visualization directives) over a
 * pluggable transport. A display (another tab/window/machine) consumes the data and
 * draws the visuals on ITS hardware. This tab toggles emission and acts as the conductor
 * (tell displays which visualization to play). OFF by default.
 */

import { useState } from 'react';
import { useDj } from '../dj-context.js';

export function DisplaysSettings(): React.JSX.Element {
  const { outputEmitter, started } = useDj();
  const [emitting, setEmitting] = useState(outputEmitter.isRunning());
  const [preset, setPreset] = useState('');

  const toggle = (on: boolean): void => {
    if (on) outputEmitter.start();
    else outputEmitter.stop();
    setEmitting(outputEmitter.isRunning());
  };

  // Conductor actions: direct ALL displays. (Per-display targeting comes with the
  // display-registry UI; for now the app broadcasts to every connected display.)
  const sendRandom = () => outputEmitter.control({ scope: 'all' }, { mode: 'random', everySec: 30 });
  const sendPreset = () => {
    if (preset.trim()) outputEmitter.control({ scope: 'all' }, { mode: 'preset', name: preset.trim() });
  };
  const sendOff = () => outputEmitter.control({ scope: 'all' }, { mode: 'off' });

  return (
    <div className="prefs-panel">
      <h3>Visual Displays (output)</h3>
      <p className="prefs-note" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>
        dj-app sends the master-bus audio + track info to displays; a display (another
        browser tab, window, or machine) renders the visuals itself — the app stays light.
        Off by default.
      </p>

      <label className="prefs-row">
        <input
          type="checkbox"
          checked={emitting}
          disabled={!started}
          onChange={(e) => toggle(e.target.checked)}
        />
        <span>
          Emit to displays
          {!started && <small>Start audio first.</small>}
          {started && (
            <small>
              Broadcasts on the &quot;dj-output-bus&quot; channel (same-browser tabs/windows).
              Networked transports (WebSocket/RTC for a remote machine) plug in here later.
            </small>
          )}
        </span>
      </label>

      {emitting && (
        <>
          <div className="prefs-dir-actions" style={{ marginTop: 10 }}>
            <button onClick={() => void window.dj.displayOpen()}>🖥 Open display window</button>
            <span className="bus-hint">Opens a popup visualizer; open several for multiple screens.</span>
          </div>
          <h4 style={{ margin: '16px 0 6px', fontSize: 12, color: 'var(--text-dim)' }}>
            Tell displays what to show
          </h4>
          <div className="prefs-dir-actions">
            <button onClick={sendRandom}>🎲 Random</button>
            <button onClick={sendOff}>Blank</button>
          </div>
          <div className="prefs-dir-actions" style={{ marginTop: 6 }}>
            <input
              placeholder="preset name…"
              value={preset}
              onChange={(e) => setPreset(e.target.value)}
              style={{ minWidth: 200 }}
            />
            <button onClick={sendPreset} disabled={!preset.trim()}>
              Set preset
            </button>
          </div>
          <p className="prefs-note">
            Each display can play something different — these directives target all displays
            for now; per-display control arrives with the display registry.
          </p>
        </>
      )}
    </div>
  );
}
