/**
 * Panel sizing persistence — the splitter writes a manual console height that
 * survives reloads (localStorage). A manual size overrides the layout preset's
 * default ratio; switching presets clears the manual override so the preset takes
 * effect. Kept tiny + framework-free so the splitter can call it directly.
 */

const KEY = 'dj-panel-console-h';
const WAVE_KEY = 'dj-panel-wave-h';

export function getConsoleHeight(): number | null {
  try {
    const v = localStorage.getItem(KEY);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

/** Per-deck waveform lane height (px). null = use the fluid default. */
export function getWaveHeight(): number | null {
  try {
    const v = localStorage.getItem(WAVE_KEY);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

export function setWaveHeight(px: number): void {
  try {
    localStorage.setItem(WAVE_KEY, String(Math.round(px)));
  } catch {
    /* ignore */
  }
}

/** Apply the saved waveform height to the .app element (if any). */
export function applyWaveHeight(app: HTMLElement): void {
  const h = getWaveHeight();
  if (h && h > 0) app.style.setProperty('--wave-h', `${h}px`);
  else app.style.removeProperty('--wave-h');
}

/**
 * Resize the waveform lane height by dragging the band's bottom handle. Writes --wave-h
 * live (rAF-throttled) and persists on release. Wires + cleans up its own listeners.
 */
export function startWaveResize(app: HTMLElement, startY: number): void {
  const start = getWaveHeight() ?? laneHeightPx(app);
  let last = start;
  let frame = 0;
  const apply = () => {
    frame = 0;
    app.style.setProperty('--wave-h', `${last}px`);
  };
  const move = (ev: PointerEvent) => {
    last = Math.max(40, Math.min(260, start + (ev.clientY - startY)));
    if (!frame) frame = requestAnimationFrame(apply); // throttle to one update/frame
  };
  const up = () => {
    if (frame) cancelAnimationFrame(frame);
    app.style.setProperty('--wave-h', `${last}px`);
    setWaveHeight(last);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/** Current rendered lane height (for a drag that starts from the fluid default). */
function laneHeightPx(app: HTMLElement): number {
  const lane = app.querySelector('.wf-scroll') as HTMLElement | null;
  return lane ? lane.getBoundingClientRect().height : 84;
}

export function setConsoleHeight(px: number): void {
  try {
    localStorage.setItem(KEY, String(Math.round(px)));
  } catch {
    /* ignore */
  }
}

export function clearConsoleHeight(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Apply a saved manual console height to the .app element (if any). */
export function applyConsoleHeight(app: HTMLElement): void {
  const h = getConsoleHeight();
  if (h && h > 0) {
    app.style.setProperty('--console-h', `${h}px`);
  } else {
    app.style.removeProperty('--console-h');
  }
}

/**
 * Begin a splitter drag: resize the console (decks) vs library by dragging.
 * Writes --console-h live, persists the final size. Returns nothing — wires its
 * own global pointer listeners and cleans them up on release. The interaction
 * logic lives here (not in the JSX), paired with the persistence above.
 */
export function startConsoleResize(app: HTMLElement, capture?: (id: number) => void, pointerId?: number): void {
  if (pointerId != null) capture?.(pointerId);
  let lastH = 0;
  const move = (ev: PointerEvent) => {
    const rect = app.getBoundingClientRect();
    const top = app.querySelector('.waveform-band')?.getBoundingClientRect().bottom ?? rect.top;
    lastH = Math.max(140, Math.min(rect.bottom - 120, ev.clientY) - top);
    app.style.setProperty('--console-h', `${lastH}px`);
  };
  const up = () => {
    if (lastH > 0) setConsoleHeight(lastH);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
