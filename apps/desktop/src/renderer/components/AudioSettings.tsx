/**
 * AudioSettings — assign each output bus (master/booth/headphone) to a device.
 * Follows Mixxx's device→bus model. Uses the engine's router (sinkId via a
 * MediaStream bridge). Device labels are shown (ids aren't stable across reboots);
 * persistence by label can be wired to the main process later.
 */

import { useCallback, useEffect, useState } from 'react';
import type { BusType, OutputDevice } from '@dj/audio-engine';
import { useDj } from '../dj-context.js';

const BUSES: Array<{ id: BusType; label: string; hint: string }> = [
  { id: 'master', label: 'Master / PA', hint: 'main mix to the speakers' },
  { id: 'headphone', label: 'Headphones (cue)', hint: 'PFL/cue monitor' },
  { id: 'booth', label: 'Booth', hint: 'booth monitor (own gain)' },
];

export function AudioSettings({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { engine, started, start } = useDj();
  const [devices, setDevices] = useState<OutputDevice[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      if (!started) {
        await start();
      }
      // enumerateDevices needs a prior getUserMedia/gesture for labels; the audio
      // start covers the gesture. Labels may be blank until mic permission, but
      // device switching still works by id.
      const list = await engine.listOutputDevices();
      setDevices([{ deviceId: 'default', label: 'System default' }, ...list]);
      const a: Record<string, string> = {};
      for (const b of BUSES) {
        a[b.id] = engine.getOutputDevice(b.id);
      }
      setAssignments(a);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [engine, started, start]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const assign = useCallback(
    async (bus: BusType, deviceId: string) => {
      try {
        await engine.setOutputDevice(bus, deviceId);
        setAssignments((a) => ({ ...a, [bus]: deviceId }));
        setError(null);
      } catch (e) {
        setError(`Could not route ${bus} to that device: ${e}`);
      }
    },
    [engine],
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal audio-settings" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Audio Output Routing</h2>
          <button className="tiny" onClick={onClose}>
            ✕
          </button>
        </header>
        <p className="modal-note">
          Send each bus to a different sound card — e.g. Master to the PA, Headphones to a USB
          interface for cueing. One engine clock, Mixxx-style.
        </p>
        {error && <p className="library-error">{error}</p>}
        <div className="bus-routes">
          {BUSES.map((b) => (
            <div key={b.id} className="bus-route">
              <label>
                <span className="bus-label">{b.label}</span>
                <span className="bus-hint">{b.hint}</span>
              </label>
              <select
                value={assignments[b.id] ?? 'default'}
                onChange={(e) => void assign(b.id, e.target.value)}
              >
                {devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
        <button className="tiny" onClick={() => void refresh()}>
          ↻ rescan devices
        </button>
      </div>
    </div>
  );
}
