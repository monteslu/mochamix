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
import { AnalysisQueue } from './analysis-queue.js';
import { startPerfMonitor } from './perf-monitor.js';
import { ControllerService } from './controller-service.js';
import { RecordingService } from './recording-service.js';

export const NUM_DECKS = 2;
// 2 decks each carry 36 hotcues × 6 keys + loops + beatloops, so the surface is
// large. 2048 Float64 slots = 16KB; trivially cheap, with ample headroom.
const SAB_CAPACITY = 2048;

export interface DjRuntime {
  bus: ControlBus;
  engine: Engine;
  analysis: AnalysisService;
  analysisQueue: AnalysisQueue;
  controllers: ControllerService;
  recording: RecordingService;
  /** True once the AudioContext has been started (needs a user gesture). */
  started: boolean;
  start: () => Promise<void>;
}

const DjContext = createContext<DjRuntime | null>(null);

function buildRuntime(): {
  bus: ControlBus;
  engine: Engine;
  analysis: AnalysisService;
  analysisQueue: AnalysisQueue;
  controllers: ControllerService;
  recording: RecordingService;
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
  const analysisQueue = new AnalysisQueue(engine, analysis);
  const controllers = new ControllerService(bus);
  const recording = new RecordingService(engine);
  return { bus, engine, analysis, analysisQueue, controllers, recording };
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
    // Once the AudioContext exists we can decode, so kick off background analysis
    // of any songs the library hasn't processed yet (app-load / reload catch-up).
    // Re-check a few times in case the library DB query wasn't ready on the first
    // tick after a reload.
    const kick = () => void runtime.analysisQueue.enqueueUnanalyzed();
    kick();
    setTimeout(kick, 1500);
    setTimeout(kick, 5000);
  }, [runtime, started]);

  // SAB readback pump: the AudioWorklet writes play position, effective rate, and
  // VU levels into the shared buffer; this loop pulls them back into the bus each
  // frame so the UI (waveform position, BPM, meters) actually updates. Without it
  // get() only ever returns values the renderer itself set, so playback looks
  // frozen even when audio is running. The generation check makes it cheap.
  useEffect(() => {
    startPerfMonitor(3); // logs FPS + frame timing every 3s
    let raf = 0;
    const pump = () => {
      runtime.bus.syncFromSab();
      raf = requestAnimationFrame(pump);
    };
    raf = requestAnimationFrame(pump);
    return () => cancelAnimationFrame(raf);
  }, [runtime]);

  useEffect(() => {
    return () => {
      runtime.recording.dispose();
      void runtime.engine.dispose();
      runtime.analysis.dispose();
      runtime.analysisQueue.dispose();
      runtime.controllers.dispose();
    };
  }, [runtime]);

  return (
    <DjContext.Provider
      value={{
        bus: runtime.bus,
        engine: runtime.engine,
        analysis: runtime.analysis,
        analysisQueue: runtime.analysisQueue,
        controllers: runtime.controllers,
        recording: runtime.recording,
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
