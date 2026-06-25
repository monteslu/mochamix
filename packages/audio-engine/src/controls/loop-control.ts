/**
 * LoopControl — loops for one deck (Mixxx LoopingControl analog). Translates bus
 * trigger controls into loop region changes that the worklet's DeckPlayback
 * applies (it owns the sample-accurate wrap + seam crossfade).
 *
 * Behaviors:
 *   - loop_in / loop_out: set the loop boundaries to the current position
 *   - reloop_toggle: enable/disable the current loop
 *   - loop_halve / loop_double: resize the loop (keeping the start)
 *   - loop_exit: disable the loop
 *   - beatloop_X_(toggle|activate): set a loop X beats long from the current
 *     position and enable it. Beat length comes from file_bpm (until the analysis
 *     package provides a real beatgrid in M5).
 *
 * Loop bounds live on the bus (loop_start_position / loop_end_position /
 * loop_enabled) so the UI can render them; this control keeps them in sync and
 * messages the worklet.
 */

import {
  beatloopActivateKey,
  beatloopToggleKey,
  BEATLOOP_SIZES,
  DeckKeys,
  type ControlBus,
  type Group,
} from '@internal-dj/control-bus';

export interface LoopControlDeps {
  bus: ControlBus;
  group: Group;
  /** Engine sample rate (frames/sec). */
  sampleRate: number;
  positionFrames: () => number;
  trackFrames: () => number;
  /** Push the loop region to the engine worklet. */
  applyLoop: (start: number, end: number, enabled: boolean) => void;
  /** Enable/disable without changing bounds. */
  enableLoop: (enabled: boolean) => void;
  /** Snap a frame to the beat grid when quantize is on (identity otherwise). */
  quantize?: (frame: number) => number;
}

export class LoopControl {
  private readonly offs: Array<() => void> = [];

  constructor(private readonly deps: LoopControlDeps) {

    this.on(DeckKeys.loopIn, () => this.setStart(this.snap(deps.positionFrames())));
    this.on(DeckKeys.loopOut, () => this.setEnd(this.snap(deps.positionFrames()), true));
    this.on(DeckKeys.reloopToggle, () => this.toggleEnabled());
    this.on(DeckKeys.loopExit, () => this.setEnabled(false));
    this.on(DeckKeys.loopHalve, () => this.scale(0.5));
    this.on(DeckKeys.loopDouble, () => this.scale(2));

    for (const size of BEATLOOP_SIZES) {
      this.on(beatloopToggleKey(size), () => this.beatloop(size));
      this.on(beatloopActivateKey(size), () => this.beatloop(size));
    }
  }

  /** Snap to grid when quantize is on; identity otherwise. */
  private snap(frame: number): number {
    return this.deps.quantize ? this.deps.quantize(frame) : frame;
  }

  /**
   * Subscribe to a momentary trigger control. When it goes >0.5 we run `fn` and
   * reset it to 0, so a second press re-fires (the control bus suppresses no-op
   * sets, so a button stuck at 1 would never trigger again).
   */
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

  private get start(): number {
    return this.deps.bus.get(this.deps.group, DeckKeys.loopStartPosition);
  }
  private get end(): number {
    return this.deps.bus.get(this.deps.group, DeckKeys.loopEndPosition);
  }
  private get enabled(): boolean {
    return this.deps.bus.get(this.deps.group, DeckKeys.loopEnabled) > 0.5;
  }

  private setStart(frame: number): void {
    this.deps.bus.set(this.deps.group, DeckKeys.loopStartPosition, frame);
  }

  private setEnd(frame: number, enable: boolean): void {
    const start = this.start;
    if (start < 0 || frame <= start) {
      return;
    }
    this.deps.bus.set(this.deps.group, DeckKeys.loopEndPosition, frame);
    if (enable) {
      this.setEnabled(true);
    } else {
      this.push();
    }
  }

  private setEnabled(enabled: boolean): void {
    this.deps.bus.set(this.deps.group, DeckKeys.loopEnabled, enabled ? 1 : 0);
    if (this.start >= 0 && this.end > this.start) {
      this.deps.applyLoop(this.start, this.end, enabled);
    } else {
      this.deps.enableLoop(false);
    }
  }

  private toggleEnabled(): void {
    if (this.start >= 0 && this.end > this.start) {
      this.setEnabled(!this.enabled);
    }
  }

  private scale(factor: number): void {
    const start = this.start;
    const end = this.end;
    if (start < 0 || end <= start) {
      return;
    }
    const len = (end - start) * factor;
    const newEnd = Math.min(start + len, this.deps.trackFrames());
    this.deps.bus.set(this.deps.group, DeckKeys.loopEndPosition, newEnd);
    this.push();
  }

  /** Set a loop `beats` long from the current position and enable it. */
  private beatloop(beats: number): void {
    const bpm = this.deps.bus.get(this.deps.group, DeckKeys.fileBpm) || 120;
    const framesPerBeat = (60 / bpm) * this.deps.sampleRate;
    const start = this.deps.positionFrames();
    const end = Math.min(start + framesPerBeat * beats, this.deps.trackFrames());
    this.setStart(start);
    this.deps.bus.set(this.deps.group, DeckKeys.loopEndPosition, end);
    this.setEnabled(true);
  }

  /** Re-push current bounds to the worklet (keeps enabled state). */
  private push(): void {
    if (this.start >= 0 && this.end > this.start) {
      this.deps.applyLoop(this.start, this.end, this.enabled);
    }
  }

  dispose(): void {
    for (const off of this.offs) {
      off();
    }
    this.offs.length = 0;
  }
}
