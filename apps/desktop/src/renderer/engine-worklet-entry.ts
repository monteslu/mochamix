/**
 * Worklet entry point. This file is bundled separately by Vite (referenced via
 * `new URL(...)` in setupEngine) and loaded into the AudioWorkletGlobalScope by
 * `audioWorklet.addModule`. It just pulls in the engine worklet, which calls
 * `registerProcessor('dj-engine', ...)` as a side effect.
 */
import '@dj/audio-engine/worklet';
