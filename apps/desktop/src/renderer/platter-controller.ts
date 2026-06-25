/**
 * PlatterController — the platter's imperative logic (kept out of the JSX): the
 * rAF rotation/progress-ring animation AND mouse scratching. Grabbing the disc and
 * dragging it rotationally drives the deck's rate (including REVERSE), like a
 * vinyl. Releasing restores normal playback. Uses the same rate_ratio_override
 * control the MIDI jog-scratch path uses.
 */

import { deck as deckGroup, DeckKeys, type ControlBus } from '@internal-dj/control-bus';

const RPM = 33.333;
const RING_CIRCUMFERENCE = 2 * Math.PI * 46;

export class PlatterController {
  private raf = 0;
  private angle = 0;
  private last = performance.now();
  private readonly group: string;

  // scratch state
  private scratching = false;
  private lastTheta = 0;
  private lastMoveT = 0;
  private velocity = 0; // turntable revs/sec relative to nominal (1 = normal fwd)
  private wasPlaying = false;
  private pointerId = -1;

  constructor(
    private readonly disc: HTMLElement,
    private readonly ring: SVGCircleElement | null,
    private readonly bus: ControlBus,
    deckIndex: number,
  ) {
    this.group = deckGroup(deckIndex + 1);
    this.disc.addEventListener('pointerdown', this.onDown);
    this.raf = requestAnimationFrame(this.tick);
  }

  private centerAngle(e: PointerEvent): number {
    const r = this.disc.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
  }

  private onDown = (e: PointerEvent): void => {
    e.preventDefault();
    this.scratching = true;
    this.pointerId = e.pointerId;
    this.disc.setPointerCapture(e.pointerId);
    this.lastTheta = this.centerAngle(e);
    this.lastMoveT = performance.now();
    this.wasPlaying = this.bus.get(this.group, DeckKeys.play) > 0.5;
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.scratching) return;
    const theta = this.centerAngle(e);
    let dTheta = theta - this.lastTheta;
    // unwrap across the ±π seam
    if (dTheta > Math.PI) dTheta -= 2 * Math.PI;
    else if (dTheta < -Math.PI) dTheta += 2 * Math.PI;
    const now = performance.now();
    const dt = Math.max(0.001, (now - this.lastMoveT) / 1000);
    // revs/sec the user is dragging; normalize to playback rate (33⅓rpm = nominal)
    const revsPerSec = dTheta / (2 * Math.PI) / dt;
    this.velocity = revsPerSec / (RPM / 60);
    // drive the deck rate (reverse allowed)
    this.bus.set(this.group, DeckKeys.rateRatioOverride, this.velocity || 0.0001);
    // move the visual disc with the hand
    this.angle = (this.angle + (dTheta * 180) / Math.PI) % 360;
    this.disc.style.transform = `rotate(${this.angle}deg)`;
    this.lastTheta = theta;
    this.lastMoveT = now;
  };

  private onUp = (): void => {
    this.scratching = false;
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    if (this.pointerId >= 0) {
      try {
        this.disc.releasePointerCapture(this.pointerId);
      } catch {
        /* ignore */
      }
    }
    // release the rate override → back to normal playback
    this.bus.set(this.group, DeckKeys.rateRatioOverride, 0);
  };

  private tick = (now: number): void => {
    const dt = (now - this.last) / 1000;
    this.last = now;
    if (!this.scratching) {
      const playing = this.bus.get(this.group, DeckKeys.play) > 0.5;
      const ratio = this.bus.get(this.group, DeckKeys.rateRatio) || 1;
      if (playing) {
        this.angle = (this.angle + dt * (RPM / 60) * 360 * ratio) % 360;
        this.disc.style.transform = `rotate(${this.angle}deg)`;
      }
    }
    if (this.ring) {
      const pos = this.bus.get(this.group, DeckKeys.playPosition);
      this.ring.style.strokeDashoffset = `${RING_CIRCUMFERENCE * (1 - pos)}`;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.disc.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    void this.wasPlaying; // reserved for ramp-on-release later
  }
}
