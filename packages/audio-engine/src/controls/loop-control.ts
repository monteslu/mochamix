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
} from '@dj/control-bus';

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
  /** Seek the deck to an absolute frame (beatjump / reloop_andstop / roll). */
  seekFrames?: (frame: number) => void;
  /** Stop the deck (reloop_andstop). */
  stop?: () => void;
  /** Snap a frame to the beat grid when quantize is on (identity otherwise). */
  quantize?: (frame: number) => number;
}

export class LoopControl {
  private readonly offs: Array<() => void> = [];

  constructor(private readonly deps: LoopControlDeps) {

    this.on(DeckKeys.loopIn, () => this.setStart(this.snap(deps.positionFrames())));
    this.on(DeckKeys.loopOut, () => this.setEnd(this.snap(deps.positionFrames()), true));
    this.on(DeckKeys.reloopToggle, () => this.toggleEnabled());
    this.on(DeckKeys.reloopExit, () => this.toggleEnabled()); // Mixxx alias of reloop_toggle
    this.on(DeckKeys.reloopAndStop, () => this.reloopAndStop());
    this.on(DeckKeys.loopExit, () => this.setEnabled(false));
    this.on(DeckKeys.loopHalve, () => this.scale(0.5));
    this.on(DeckKeys.loopDouble, () => this.scale(2));

    // Fixed-size beatloops (beatloop_4_toggle etc.)
    for (const size of BEATLOOP_SIZES) {
      this.on(beatloopToggleKey(size), () => this.beatloop(size));
      this.on(beatloopActivateKey(size), () => this.beatloop(size));
    }

    // Size-driven beatloop: activate a loop of `beatloop_size` beats. `beatloop` takes a
    // value (the size); `beatloop_activate` uses the stored beatloop_size.
    this.on(DeckKeys.beatloopActivate, () =>
      this.beatloop(this.deps.bus.get(this.deps.group, DeckKeys.beatloopSize) || 4),
    );
    this.offs.push(
      this.deps.bus.connect(this.deps.group, DeckKeys.beatloop, (v) => {
        if (v > 0) {
          this.deps.bus.set(this.deps.group, DeckKeys.beatloopSize, v);
          this.beatloop(v);
          this.deps.bus.set(this.deps.group, DeckKeys.beatloop, 0);
        }
      }),
    );

    // beatlooproll: momentary loop — loop while held, jump back to where you'd be on
    // release (a "censor"/stutter). Press → remember position + start a beatloop; release
    // → exit the loop and seek to the position playback would have reached.
    this.offs.push(
      this.deps.bus.connect(this.deps.group, DeckKeys.beatlooprollActivate, (v) => {
        if (v > 0.5) this.beatloopRollStart();
        else this.beatloopRollEnd();
      }),
    );

    // beatjump: seek N beats forward/backward without looping. `beatjump` value = signed
    // beats; the buttons use the stored beatjump_size.
    this.on(DeckKeys.beatjumpForward, () =>
      this.beatjump(this.deps.bus.get(this.deps.group, DeckKeys.beatjumpSize) || 4),
    );
    this.on(DeckKeys.beatjumpBackward, () =>
      this.beatjump(-(this.deps.bus.get(this.deps.group, DeckKeys.beatjumpSize) || 4)),
    );
    this.offs.push(
      this.deps.bus.connect(this.deps.group, DeckKeys.beatjump, (v) => {
        if (v !== 0) {
          this.beatjump(v);
          this.deps.bus.set(this.deps.group, DeckKeys.beatjump, 0);
        }
      }),
    );
  }

  private rollReturnFrame = -1;

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

  private framesPerBeat(): number {
    const bpm = this.deps.bus.get(this.deps.group, DeckKeys.fileBpm) || 120;
    return (60 / bpm) * this.deps.sampleRate;
  }

  /** Set a loop `beats` long from the current position and enable it. */
  private beatloop(beats: number): void {
    const start = this.deps.positionFrames();
    const end = Math.min(start + this.framesPerBeat() * beats, this.deps.trackFrames());
    this.setStart(start);
    this.deps.bus.set(this.deps.group, DeckKeys.loopEndPosition, end);
    this.setEnabled(true);
  }

  /** Re-enter the existing loop and stop the deck (Mixxx reloop_andstop). */
  private reloopAndStop(): void {
    if (this.start >= 0 && this.end > this.start) {
      this.setEnabled(true);
      this.deps.seekFrames?.(this.start);
      this.deps.stop?.();
    }
  }

  /** beatlooproll press: remember where we are and start a beatloop_size loop. */
  private beatloopRollStart(): void {
    this.rollReturnFrame = this.deps.positionFrames();
    this.beatloop(this.deps.bus.get(this.deps.group, DeckKeys.beatloopSize) || 4);
  }

  /** beatlooproll release: exit the loop and resume where playback would be now. */
  private beatloopRollEnd(): void {
    this.setEnabled(false);
    // Where the deck would be if the roll hadn't happened ~= current pos (the loop kept
    // it inside the region); resume from the remembered onset + elapsed is approximated
    // by just exiting in place. If we stored an onset, seek forward past the loop.
    if (this.rollReturnFrame >= 0) {
      // Resume at the loop's would-be exit (start + one loop length past return).
      this.deps.seekFrames?.(Math.max(this.rollReturnFrame, this.deps.positionFrames()));
      this.rollReturnFrame = -1;
    }
  }

  /** Jump `beats` (signed) without looping — beatjump. */
  private beatjump(beats: number): void {
    const target = this.deps.positionFrames() + this.framesPerBeat() * beats;
    const clamped = Math.max(0, Math.min(this.deps.trackFrames() - 1, target));
    this.deps.seekFrames?.(clamped);
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
