/**
 * CueControl — main cue + hotcues for one deck (Mixxx CueControl analog,
 * 04-audio-engine.md §5). In our architecture the EngineControl stack lives on
 * the main thread as bus subscribers: cue points are control values; activating a
 * cue is a seek (an engine message). Sample-accurate position lives in the worklet;
 * cues only ever ask it to seek, so they don't need to run per-block.
 *
 * Behaviors:
 *   - cue_set: set main cue to the current play position
 *   - cue_gotoandstop: stop + seek to the main cue
 *   - hotcue_N_set: set hotcue N to the current position (enabled=1)
 *   - hotcue_N_activate: seek to hotcue N (if set)
 *   - hotcue_N_clear: clear hotcue N
 */

import {
  DeckKeys,
  hotcueActivateKey,
  hotcueClearKey,
  hotcueEnabledKey,
  hotcuePositionKey,
  hotcueSetKey,
  MAX_HOTCUES,
  type ControlBus,
  type Group,
} from '@internal-dj/control-bus';

export interface CueControlDeps {
  bus: ControlBus;
  group: Group;
  /** Current play position in source frames. */
  positionFrames: () => number;
  /** Seek the deck to an absolute source frame. */
  seekFrames: (frame: number) => void;
  /** Stop the deck (set play=0). */
  stop: () => void;
  /** Snap a frame to the beat grid when quantize is on (identity otherwise). */
  quantize?: (frame: number) => number;
}

export class CueControl {
  private readonly offs: Array<() => void> = [];

  constructor(private readonly deps: CueControlDeps) {
    const { bus, group } = deps;

    // Main cue.
    this.on(DeckKeys.cueSet, () => {
      bus.set(group, DeckKeys.cuePoint, this.snap(deps.positionFrames()));
    });
    this.on(DeckKeys.cueGotoAndStop, () => {
      const cue = bus.get(group, DeckKeys.cuePoint);
      if (cue >= 0) {
        deps.stop();
        deps.seekFrames(cue);
      }
    });

    // Hotcues.
    for (let n = 1; n <= MAX_HOTCUES; n++) {
      const posKey = hotcuePositionKey(n);
      const enKey = hotcueEnabledKey(n);
      this.on(hotcueSetKey(n), () => {
        bus.set(group, posKey, this.snap(deps.positionFrames()));
        bus.set(group, enKey, 1);
      });
      this.on(hotcueActivateKey(n), () => {
        const pos = bus.get(group, posKey);
        if (pos >= 0) {
          deps.seekFrames(pos);
        }
      });
      this.on(hotcueClearKey(n), () => {
        bus.set(group, posKey, -1);
        bus.set(group, enKey, 0);
      });
    }
  }

  /** Snap to grid when quantize is on; identity otherwise. */
  private snap(frame: number): number {
    return this.deps.quantize ? this.deps.quantize(frame) : frame;
  }

  /** Momentary-trigger subscribe: fire on >0.5, then reset to 0 so it re-fires. */
  private on(key: string, fn: () => void): void {
    this.offs.push(
      this.deps.bus.connect(this.deps.group, key, (v) => {
        if (v > 0.5) {
          fn();
          this.deps.bus.set(this.deps.group, key, 0);
        }
      }),
    );
  }

  dispose(): void {
    for (const off of this.offs) {
      off();
    }
    this.offs.length = 0;
  }
}
