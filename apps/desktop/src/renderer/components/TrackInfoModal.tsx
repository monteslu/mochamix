/**
 * TrackInfoModal: a details dialog for a library track (like Loukai's song-info button).
 * Opened from the row right-click menu. Read-only; dismiss on backdrop click or Esc.
 */

import { useEffect } from 'react';
import type { LibTrack } from '../../shared/ipc.js';

function fmtDuration(s: number | null): string {
  if (!s || s <= 0) return '-';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function TrackInfoModal({
  track,
  onClose,
}: {
  track: LibTrack;
  onClose: () => void;
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows: Array<[string, string]> = [
    ['Title', track.title ?? track.filename],
    ['Artist', track.artist ?? '-'],
    ['Album', track.album ?? '-'],
    ['Genre', track.genre ?? '-'],
    ['Year', track.year ?? '-'],
    ['BPM', track.bpm > 0 ? track.bpm.toFixed(2).replace(/\.00$/, '') : '-'],
    ['Key', track.key ?? '-'],
    ['Duration', fmtDuration(track.duration)],
    ['Bitrate', track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : '-'],
    ['Format', track.filetype ? track.filetype.toUpperCase() : '-'],
    ['Stems', track.stemPath ? 'Generated ✓' : 'Not generated'],
    ['Plays', String(track.timesPlayed ?? 0)],
    ['Path', track.location],
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="track-info-modal" onClick={(e) => e.stopPropagation()}>
        <header className="track-info-header">
          <h2>Track Info</h2>
          <button className="tiny" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <dl className="track-info-grid">
          {rows.map(([label, value]) => (
            <div className="track-info-row" key={label}>
              <dt>{label}</dt>
              <dd className={label === 'Path' ? 'track-info-path' : undefined}>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
