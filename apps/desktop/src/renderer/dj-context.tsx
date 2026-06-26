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
import { ControlBus, standardControls, type Group, type Key } from '@dj/control-bus';
import { Engine } from '@dj/audio-engine';
import { AnalysisService } from './analysis-service.js';
import { AnalysisQueue } from './analysis-queue.js';
import { StemQueue } from './stem-queue.js';
import { StemThumbnailBackfill } from './stem-thumbnail-backfill.js';
import { startPerfMonitor } from './perf-monitor.js';
import { onFrame } from './frame-loop.js';
import { ControllerService } from './controller-service.js';
import { RecordingService } from './recording-service.js';
import { loadTrackToDeck } from './track-loader.js';

export const NUM_DECKS = 2;
// 2 decks each carry 36 hotcues × 6 keys + loops + beatloops, so the surface is
// large. 2048 Float64 slots = 16KB; trivially cheap, with ample headroom.
const SAB_CAPACITY = 2048;

export interface DjRuntime {
  bus: ControlBus;
  engine: Engine;
  analysis: AnalysisService;
  analysisQueue: AnalysisQueue;
  stemQueue: StemQueue;
  stemThumbnails: StemThumbnailBackfill;
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
  stemQueue: StemQueue;
  stemThumbnails: StemThumbnailBackfill;
  controllers: ControllerService;
  recording: RecordingService;
} {
  // Persist `persist:true` controls (keylock, smart fader, crossfader curve, etc.)
  // to localStorage so they survive restarts.
  const PERSIST_KEY = 'dj-controls';
  let persisted: Record<string, number> = {};
  try {
    persisted = JSON.parse(localStorage.getItem(PERSIST_KEY) ?? '{}');
  } catch {
    persisted = {};
  }
  const bus = new ControlBus({
    sab: { capacity: SAB_CAPACITY },
    persistedValues: persisted,
    onPersist: (id, value) => {
      persisted[id] = value;
      try {
        localStorage.setItem(PERSIST_KEY, JSON.stringify(persisted));
      } catch {
        /* quota / unavailable */
      }
    },
  });
  bus.defineAll(standardControls(NUM_DECKS));

  // The worklet is built separately (vite.worklet.config.ts) to a stable path
  // next to index.html, because Vite's asset handling can't bundle a .ts worklet.
  // Resolve it relative to the current document so file:// loading works.
  const workletUrl = new URL('./worklets/engine.worklet.js', document.baseURI);

  const engine = new Engine({ bus, numDecks: NUM_DECKS, workletUrl });
  const analysis = new AnalysisService();
  const analysisQueue = new AnalysisQueue(engine, analysis);
  const stemQueue = new StemQueue(engine);
  const stemThumbnails = new StemThumbnailBackfill(engine);
  const controllers = new ControllerService(bus);
  const recording = new RecordingService(engine);
  const runtime = { bus, engine, analysis, analysisQueue, stemQueue, stemThumbnails, controllers, recording };
  // Expose the runtime for e2e/debugging (drive sync, read positions, inspect the
  // bus from the page). Harmless in prod; invaluable for the Playwright loop. The
  // loadToDeck helper uses the REAL load pipeline (decode → peaks → engine), so
  // tests exercise exactly what the UI does.
  (globalThis as Record<string, unknown>).__dj = {
    ...runtime,
    loadToDeck: (deckIndex: number, file: { name: string; data: ArrayBuffer }) =>
      loadTrackToDeck({ engine, bus, analysis }, deckIndex, { file }),
  };
  return runtime;
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
    const kick = () => {
      void runtime.analysisQueue.enqueueUnanalyzed();
      // backfill colored stem thumbnails so they're ready before you scroll to them
      void runtime.stemThumbnails.run();
    };
    kick();
    setTimeout(kick, 1500);
    setTimeout(kick, 5000);
    // Rescan-on-startup (Mixxx kRescanOnStartup): sync the library on launch so songs
    // added/removed since last time are picked up, then analyze the new ones. DEFAULT
    // ON — only an explicit '0' disables it (null/unset = on).
    void window.dj.settingsGet('rescanOnStartup').then((v) => {
      if (v !== '0') {
        void window.dj.librarySync().then(() => {
          kick();
        });
      }
    });
  }, [runtime, started]);

  // Auto-start the engine in Electron (our app, not an untrusted page → no autoplay-
  // gesture requirement; main.ts disables that policy). Only the WEB build needs a
  // user gesture, so there it starts on first interaction (track load / play) instead.
  useEffect(() => {
    const isWeb = (window as unknown as { __DJ_WEB__?: boolean }).__DJ_WEB__ === true;
    if (!isWeb && !started) void start();
  }, [started, start]);

  // SAB readback pump: the AudioWorklet writes play position, effective rate, and
  // VU levels into the shared buffer; this loop pulls them back into the bus each
  // frame so the UI (waveform position, BPM, meters) actually updates. Without it
  // get() only ever returns values the renderer itself set, so playback looks
  // frozen even when audio is running. The generation check makes it cheap.
  useEffect(() => {
    startPerfMonitor(3); // logs FPS + frame timing every 3s
    // SAB readback runs FIRST each frame on the shared loop, so the values the
    // waveform/meters read are this-frame fresh.
    return onFrame(() => runtime.bus.syncFromSab());
  }, [runtime]);

  // Start listening for MIDI controllers as soon as the app opens — no need to open
  // settings or start audio. Auto-loads the Generic MIDI mapping onto a connected
  // controller (and on hot-plug). Web MIDI is independent of the AudioContext.
  useEffect(() => {
    void runtime.controllers.autoConnect();
  }, [runtime]);

  useEffect(() => {
    return () => {
      runtime.recording.dispose();
      void runtime.engine.dispose();
      runtime.analysis.dispose();
      runtime.analysisQueue.dispose();
      runtime.stemQueue.dispose();
      runtime.stemThumbnails.dispose();
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
        stemQueue: runtime.stemQueue,
        stemThumbnails: runtime.stemThumbnails,
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
