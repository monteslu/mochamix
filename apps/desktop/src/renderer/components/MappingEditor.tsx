/**
 * MappingEditor — clone + customize controller mappings in-app (Mixxx's mapping editor,
 * sans MIDI-learn for now). Pick a bundled Mixxx mapping, clone it into an editable USER
 * copy, then remap what each MIDI control drives (group + key) and save. User mappings
 * persist in userData/controllers as standard .midi.xml, so they're portable.
 *
 * Editing targets the control BINDINGS (group/key). Script-bound controls show their
 * function name (read-only — editing JS handlers is out of scope here).
 */

import { useCallback, useEffect, useState } from 'react';
import { parseMidiMapping, serializeMapping, type MidiMapping } from '@dj/controller-host';

// Common control groups + keys to suggest in the editor (not exhaustive — free text too).
const GROUPS = ['[Channel1]', '[Channel2]', '[Master]', '[Playlist]', '[Library]'];
const COMMON_KEYS = [
  'play',
  'cue_default',
  'volume',
  'rate',
  'pregain',
  'pfl',
  'keylock',
  'sync_enabled',
  'beatsync',
  'hotcue_1_activate',
  'loop_in',
  'loop_out',
  'reloop_toggle',
  'jog',
  'wheel',
];

function hex(n: number): string {
  return '0x' + n.toString(16).toUpperCase().padStart(2, '0');
}

export function MappingEditor(): React.JSX.Element {
  const [bundled, setBundled] = useState<Array<{ file: string; name: string }>>([]);
  const [userMaps, setUserMaps] = useState<Array<{ file: string; name: string }>>([]);
  const [editing, setEditing] = useState<{ file: string; mapping: MidiMapping } | null>(null);
  const [status, setStatus] = useState('');

  const refreshUser = useCallback(async () => {
    setUserMaps(await window.dj.userControllersList());
  }, []);

  useEffect(() => {
    void (async () => {
      setBundled(await window.dj.controllersList());
      await refreshUser();
    })();
  }, [refreshUser]);

  // Clone a bundled mapping → an editable user copy.
  const clone = useCallback(
    async (file: string, name: string) => {
      const xml = await window.dj.controllersReadFile(file);
      if (!xml) return;
      const mapping = parseMidiMapping(xml);
      mapping.name = `${name} (custom)`;
      const userFile = file.replace(/\.midi\.xml$/, '') + '.custom.midi.xml';
      await window.dj.userControllersSave(userFile, serializeMapping(mapping));
      await refreshUser();
      setEditing({ file: userFile, mapping });
      setStatus(`Cloned "${name}" → editable copy.`);
    },
    [refreshUser],
  );

  const openUser = useCallback(async (file: string) => {
    const xml = await window.dj.userControllersRead(file);
    if (!xml) return;
    setEditing({ file, mapping: parseMidiMapping(xml) });
    setStatus('');
  }, []);

  const save = useCallback(async () => {
    if (!editing) return;
    await window.dj.userControllersSave(editing.file, serializeMapping(editing.mapping));
    await refreshUser();
    setStatus('Saved.');
  }, [editing, refreshUser]);

  const removeUser = useCallback(
    async (file: string) => {
      if (!window.confirm(`Delete mapping "${file}"?`)) return;
      await window.dj.userControllersDelete(file);
      if (editing?.file === file) setEditing(null);
      await refreshUser();
    },
    [editing, refreshUser],
  );

  // Mutate a control binding in the editing mapping (immutably for React).
  const setControl = (i: number, patch: { group?: string; key?: string }) => {
    if (!editing) return;
    const controls = editing.mapping.controls.map((c, idx) => (idx === i ? { ...c, ...patch } : c));
    setEditing({ ...editing, mapping: { ...editing.mapping, controls } });
  };

  return (
    <div className="prefs-panel mapping-editor">
      <h3>Custom Controller Mappings</h3>
      <p className="prefs-note" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>
        Clone a Mixxx mapping into an editable copy, then remap what each MIDI control does.
        Custom mappings are saved as standard .midi.xml and appear in the Controllers picker.
      </p>

      {!editing && (
        <>
          {userMaps.length > 0 && (
            <>
              <h4>Your mappings</h4>
              <ul className="prefs-dirs">
                {userMaps.map((m) => (
                  <li key={m.file} className="prefs-dir">
                    <span className="prefs-dir-path">{m.name}</span>
                    <span style={{ display: 'flex', gap: 6 }}>
                      <button className="tiny" onClick={() => void openUser(m.file)}>
                        edit
                      </button>
                      <button className="tiny" onClick={() => void removeUser(m.file)}>
                        delete
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h4>Clone a mapping</h4>
          <select
            className="mapping-clone-select"
            defaultValue=""
            onChange={(e) => {
              const m = bundled.find((b) => b.file === e.target.value);
              if (m) void clone(m.file, m.name);
              e.target.value = '';
            }}
          >
            <option value="" disabled>
              Pick a Mixxx mapping to clone…
            </option>
            {bundled.map((m) => (
              <option key={m.file} value={m.file}>
                {m.name}
              </option>
            ))}
          </select>
        </>
      )}

      {editing && (
        <>
          <div className="mapping-edit-head">
            <input
              className="mapping-name"
              value={editing.mapping.name}
              onChange={(e) =>
                setEditing({ ...editing, mapping: { ...editing.mapping, name: e.target.value } })
              }
            />
            <span style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => void save()}>Save</button>
              <button className="tiny" onClick={() => setEditing(null)}>
                Close
              </button>
            </span>
          </div>
          <div className="mapping-table-wrap">
            <table className="mapping-table">
              <thead>
                <tr>
                  <th>MIDI</th>
                  <th>Group</th>
                  <th>Control / Key</th>
                </tr>
              </thead>
              <tbody>
                {editing.mapping.controls.map((c, i) => (
                  <tr key={i}>
                    <td className="mapping-midi">
                      {hex(c.status)} {hex(c.midino)}
                    </td>
                    <td>
                      <input
                        list="mapping-groups"
                        value={c.group}
                        onChange={(e) => setControl(i, { group: e.target.value })}
                      />
                    </td>
                    <td>
                      {c.isScript ? (
                        <span className="mapping-script" title="Script-bound (edit the JS, not here)">
                          ƒ {c.key}
                        </span>
                      ) : (
                        <input
                          list="mapping-keys"
                          value={c.key}
                          onChange={(e) => setControl(i, { key: e.target.value })}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <datalist id="mapping-groups">
              {GROUPS.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
            <datalist id="mapping-keys">
              {COMMON_KEYS.map((k) => (
                <option key={k} value={k} />
              ))}
            </datalist>
          </div>
        </>
      )}

      {status && <p className="bus-hint">{status}</p>}
    </div>
  );
}
