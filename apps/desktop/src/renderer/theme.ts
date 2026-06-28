/**
 * Theme system — selectable color themes. Each theme is a `data-theme` value matching a
 * token block in styles.css ([data-theme='id']); applying a theme sets that attribute on
 * the .app element and the CSS tokens cascade. The choice persists in localStorage.
 *
 * Default ("mocha", a warm espresso + amber/gold scheme) lives in :root. Adding a theme =
 * a new token block in styles.css + an entry here.
 */

import { useCallback, useSyncExternalStore } from 'react';

export interface ThemeDef {
  id: string;
  label: string;
  /** A representative swatch (the accent) for the picker. */
  swatch: string;
}

/** Available themes, in picker order. The first is the default. */
export const THEMES: ThemeDef[] = [
  { id: 'mocha', label: 'Mocha', swatch: '#e0a44a' },
  { id: 'nightclub', label: 'Nightclub', swatch: '#38b6ff' },
  { id: 'graphite', label: 'Graphite', swatch: '#e0479e' },
  { id: 'daylight', label: 'Daylight', swatch: '#0b84e6' },
];

const KEY = 'dj-theme';
const DEFAULT_ID = THEMES[0]!.id;

function load(): string {
  try {
    const v = localStorage.getItem(KEY);
    if (v && THEMES.some((t) => t.id === v)) return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_ID;
}

let current = load();
const listeners = new Set<() => void>();

export function setTheme(id: string): void {
  if (!THEMES.some((t) => t.id === id) || id === current) return;
  current = id;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* ignore */
  }
  // The .app element renders data-theme={getTheme()} via useTheme, so notifying the
  // subscribers re-renders it with the new theme — no manual DOM write needed.
  for (const l of listeners) l();
}

export function getTheme(): string {
  return current;
}

export function useTheme(): [string, (id: string) => void] {
  const id = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getTheme,
  );
  const set = useCallback((next: string) => setTheme(next), []);
  return [id, set];
}
