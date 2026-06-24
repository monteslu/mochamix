/**
 * The renderer's DJ runtime context: builds the control bus (with SAB) + the
 * audio Engine, and exposes them + a `useControl` hook to the React tree. This is
 * the renderer-side wiring of the spine (03-architecture.md §1).
 *
 * The control bus is the single source of truth; React components bind to it via
 * useControl (the analog of a Mixxx skin <Connection> / QmlControlProxy).
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  useCallback,
  type ReactNode,
} from 'react';
import { ControlBus, standardControls, type Group, type Key } from '@internal-dj/control-bus';
import { Engine } from '@internal-dj/audio-engine';
import { AnalysisService } from './analysis-service.js';
import { ControllerService } from './controller-service.js';

export const NUM_DECKS = 2;
// 2 decks each carry 36 hotcues × 6 keys + loops + beatloops, so the surface is
// large. 2048 Float64 slots = 16KB; trivially cheap, with ample headroom.
const SAB_CAPACITY = 2048;

export interface DjRuntime {
  bus: ControlBus;
  engine: Engine;
  analysis: AnalysisService;
  controllers: ControllerService;
  /** True once the AudioContext has been started (needs a user gesture). */
  started: boolean;
  start: () => Promise<void>;
}

const DjContext = createContext<DjRuntime | null>(null);

function buildRuntime(): {
  bus: ControlBus;
  engine: Engine;
  analysis: AnalysisService;
  controllers: ControllerService;
} {
  const bus = new ControlBus({
    sab: { capacity: SAB_CAPACITY },
    // M1: persistence is in-memory only (no disk yet). Wire to electron-store later.
  });
  bus.defineAll(standardControls(NUM_DECKS));

  // The worklet is built separately (vite.worklet.config.ts) to a stable path
  // next to index.html, because Vite's asset handling can't bundle a .ts worklet.
  // Resolve it relative to the current document so file:// loading works.
  const workletUrl = new URL('./worklets/engine.worklet.js', document.baseURI);

  const engine = new Engine({ bus, numDecks: NUM_DECKS, workletUrl });
  const analysis = new AnalysisService();
  const controllers = new ControllerService(bus);
  return { bus, engine, analysis, controllers };
}

export function DjProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [runtime] = useState(buildRuntime);
  const [started, setStarted] = useState(false);

  const start = useCallback(async () => {
    if (started) {
      return;
    }
    await runtime.engine.start();
    setStarted(true);
  }, [runtime, started]);

  useEffect(() => {
    return () => {
      void runtime.engine.dispose();
      runtime.analysis.dispose();
      runtime.controllers.dispose();
    };
  }, [runtime]);

  return (
    <DjContext.Provider
      value={{
        bus: runtime.bus,
        engine: runtime.engine,
        analysis: runtime.analysis,
        controllers: runtime.controllers,
        started,
        start,
      }}
    >
      {children}
    </DjContext.Provider>
  );
}

export function useDj(): DjRuntime {
  const ctx = useContext(DjContext);
  if (!ctx) {
    throw new Error('useDj must be used within a DjProvider');
  }
  return ctx;
}

/**
 * Bind to a control value. Returns [value, setValue]. The analog of a Mixxx skin
 * <Connection> with both directions. Re-renders when the control changes.
 */
export function useControl(group: Group, key: Key): [number, (v: number) => void] {
  const { bus } = useDj();

  const subscribe = useCallback(
    (onChange: () => void) => bus.connect(group, key, onChange),
    [bus, group, key],
  );
  const getSnapshot = useCallback(() => bus.get(group, key), [bus, group, key]);

  const value = useSyncExternalStore(subscribe, getSnapshot);
  const setValue = useCallback((v: number) => bus.set(group, key, v), [bus, group, key]);

  return [value, setValue];
}

/** Read-only variant for display bindings. */
export function useControlValue(group: Group, key: Key): number {
  return useControl(group, key)[0];
}
