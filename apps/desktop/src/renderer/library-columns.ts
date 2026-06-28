/**
 * Library column widths — resizable, persisted. The table uses `table-layout: fixed`
 * with a <colgroup>; widths (px) live in localStorage and a hook exposes them as state.
 * Dragging a column's right edge resizes it live (rAF-throttled) and persists on release.
 *
 * WAVE and LOAD are fixed utility columns (not user-resizable); the rest are.
 */

import { useCallback, useSyncExternalStore } from 'react';

/** Resizable column ids, in table order. */
export const COLUMN_IDS = [
  'artist',
  'title',
  'album',
  'genre',
  'bpm',
  'key',
  'time',
  'stems',
] as const;
export type ColumnId = (typeof COLUMN_IDS)[number];

export type ColumnWidths = Record<ColumnId, number>;

const KEY = 'dj-library-columns';
const MIN_WIDTH = 48;
const DEFAULTS: ColumnWidths = {
  artist: 170,
  title: 200,
  album: 160,
  genre: 110,
  bpm: 64,
  key: 64,
  time: 64,
  stems: 92,
};

let current: ColumnWidths = load();
const listeners = new Set<() => void>();

function load(): ColumnWidths {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<ColumnWidths>) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* ignore */
  }
}

function emit(): void {
  for (const l of listeners) l();
}

/** Set one column's width (clamped) and notify subscribers. Does NOT persist (the drag
 * handler persists once on release to avoid a write per pointermove). */
export function setColumnWidth(id: ColumnId, px: number): void {
  const w = Math.max(MIN_WIDTH, Math.round(px));
  if (current[id] === w) return;
  current = { ...current, [id]: w };
  emit();
}

export function getColumnWidths(): ColumnWidths {
  return current;
}

export function useColumnWidths(): ColumnWidths {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getColumnWidths,
  );
}

// True for a tick after a resize drag ends, so the header's click→sort handler can ignore
// the synthetic click that fires on pointerup at the end of a drag.
let justResized = false;
/** Did a column resize just happen? (clears itself on the next event loop turn) */
export function didJustResize(): boolean {
  return justResized;
}

/**
 * Begin resizing column `id` from a pointerdown on its handle. Captures the pointer on the
 * handle element (so the drag tracks even if the cursor leaves the 10px grip), updates the
 * width live (rAF-throttled), and persists once on release.
 */
export function startColumnResize(id: ColumnId, startX: number, handle: HTMLElement, pointerId: number): void {
  const startW = current[id];
  let pending = 0;
  let frame = 0;
  let moved = false;

  // Pointer capture: all subsequent move/up events go to `handle` regardless of where the
  // cursor is — the key to a drag that doesn't drop when you leave the tiny grip.
  try {
    handle.setPointerCapture(pointerId);
  } catch {
    /* not all envs support capture; the drag still works via the captured handle */
  }

  const flush = () => {
    frame = 0;
    setColumnWidth(id, startW + pending);
  };
  const move = (ev: PointerEvent) => {
    pending = ev.clientX - startX;
    if (Math.abs(pending) > 2) moved = true;
    if (!frame) frame = requestAnimationFrame(flush);
  };
  const up = () => {
    if (frame) cancelAnimationFrame(frame);
    setColumnWidth(id, startW + pending);
    persist();
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', up);
    try {
      handle.releasePointerCapture(pointerId);
    } catch {
      /* ignore */
    }
    // Suppress the click→sort that fires right after a real drag.
    if (moved) {
      justResized = true;
      setTimeout(() => {
        justResized = false;
      }, 0);
    }
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
}

/** Reset all columns to defaults (double-click a handle). */
export function resetColumnWidths(): void {
  current = { ...DEFAULTS };
  persist();
  emit();
}

/** Convenience hook: widths + a resize starter + reset. */
export function useColumns() {
  const widths = useColumnWidths();
  const onResizeStart = useCallback((id: ColumnId, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation(); // don't trigger the header's sort click
    startColumnResize(id, e.clientX, e.currentTarget as HTMLElement, e.pointerId);
  }, []);
  return { widths, onResizeStart, reset: resetColumnWidths, didJustResize };
}
