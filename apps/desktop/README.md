# @internal-dj/desktop

The internal-dj Electron app. Two decks + a center mixer, bound to the control bus.

## Run it

From the **monorepo root** (`internal-dj/`):

```bash
npm install            # installs all workspaces; downloads Electron
npm run dev            # builds packages + app, launches Electron
```

Or from this directory:

```bash
npm run build          # renderer + worklet + main
npm start              # launch Electron (after a build)
npm run dev            # build + launch with devtools
```

## What works (M1)

- Load a track (button or drag-and-drop) → decode → waveform (overview + scrolling) → play/pause/seek.
- Two decks, a crossfader (deck 1 = left, deck 2 = right), per-deck 3-band EQ + volume + tempo (±10%,
  varispeed for now — keylock is M2).
- Everything is bound to the **control bus** (`@internal-dj/control-bus`) via the `useControl` hook.
  The audio engine (`@internal-dj/audio-engine`) runs in an AudioWorklet reading control values from a
  SharedArrayBuffer mirror of the bus.

## Architecture notes

- **Cross-origin isolation:** the renderer is served from a custom `app://` protocol with
  COOP/COEP headers so `SharedArrayBuffer` + WASM threads work. (Injecting the headers on a `file://`
  load does *not* work — see `../../12-build-log.md`.)
- **WebGPU is required, no fallback** (`../../10-electron-feasibility.md` §0a). The renderer logs an
  error if it's unavailable.
- **The worklet is built separately** (`vite.worklet.config.ts`) into `dist-renderer/worklets/` because
  Vite can't bundle a `.ts` AudioWorklet via `new URL(...)`.

## Layout

```
src/
  main/      main process (app:// protocol, window, file IPC) + preload
  shared/    IPC type contracts
  renderer/  React UI + the dj-context (control bus + engine wiring)
    components/  Deck, Mixer, Knob, WaveformView
```

See the design docs in the repo root (`01`–`12`) for the full picture.
