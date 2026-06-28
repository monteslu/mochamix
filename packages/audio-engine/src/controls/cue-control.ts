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
} from '@dj/control-bus';

export interface CueControlDeps {
  bus: ControlBus;
  group: Group;
  /** Current play position in source frames. */
  positionFrames: () => number;
  /** Seek the deck to an absolute source frame. */
  seekFrames: (frame: number) => void;
  /** Stop the deck (set play=0). */
  stop: () => void;
  /** Start the deck (set play=1). Needed for cue_default preview-while-held. */
  play?: () => void;
  /** Whether the deck is currently playing. Needed for cue_default. */
  isPlaying?: () => boolean;
  /** Whether the platter/jog is being scratched (then a cue press SETS, not jumps). */
  isScratching?: () => boolean;
  /** Snap a frame to the beat grid when quantize is on (identity otherwise). */
  quantize?: (frame: number) => number;
}

export class CueControl {
  private readonly offs: Array<() => void> = [];
  /** True while cue_default is previewing (deck plays while the cue button is held). */
  private previewing = false;

  constructor(private readonly deps: CueControlDeps) {
    const { bus, group } = deps;

    // Main cue.
    this.on(DeckKeys.cueSet, () => {
      this.setMainCue();
    });
    this.on(DeckKeys.cueGotoAndStop, () => {
      const cue = bus.get(group, DeckKeys.cuePoint);
      if (cue >= 0) {
        deps.stop();
        deps.seekFrames(cue);
      }
    });

    // cue_default — the combined CDJ/Pioneer cue button real controllers send (the
    // DJ2GO2 CueButton drives this). Faithful port of Mixxx CueControl::cueCDJ:
    //   press while freely playing      → stop + seek to cue
    //   press while paused AT the cue   → play (preview while held)
    //   press while paused NOT at cue   → set cue here (and seek to it if quantized)
    //   release after a cue-preview     → stop + seek back to cue
    // This is press-AND-release (not momentary), so it's wired raw, not via this.on().
    this.offs.push(
      bus.connect(group, DeckKeys.cueDefault, (v) => {
        const cue = bus.get(group, DeckKeys.cuePoint);
        const playing = (deps.isPlaying?.() ?? bus.get(group, DeckKeys.play) > 0.5);
        const scratching = deps.isScratching?.() ?? false;
        const atCue = cue >= 0 && Math.abs(deps.positionFrames() - cue) < 1;
        if (v > 0.5) {
          if (cue < 0) {
            // No cue set yet → pressing sets one (also covers "paused not at cue").
            this.setMainCue();
            return;
          }
          if (playing && !scratching) {
            // Freely playing → jump to cue and stop (CDJ behavior).
            deps.stop();
            deps.seekFrames(cue);
          } else if (!playing && atCue) {
            // Paused exactly at the cue → preview: play while held.
            this.previewing = true;
            deps.play?.();
          } else {
            // Paused away from the cue (or scratching) → set a new cue here.
            this.setMainCue();
            if (bus.get(group, DeckKeys.quantize) > 0.5) {
              const nc = bus.get(group, DeckKeys.cuePoint);
              if (nc >= 0) deps.seekFrames(nc);
            }
          }
        } else {
          // Release: if we were previewing from the cue, stop + return to the cue.
          if (this.previewing) {
            this.previewing = false;
            deps.stop();
            if (cue >= 0) deps.seekFrames(cue);
          }
        }
      }),
    );

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

  /** Set the main cue point to the current (snapped) play position. */
  private setMainCue(): void {
    this.deps.bus.set(
      this.deps.group,
      DeckKeys.cuePoint,
      this.snap(this.deps.positionFrames()),
    );
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
