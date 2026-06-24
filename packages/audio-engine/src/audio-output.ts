/**
 * AudioOutputRouter — routes each engine output bus (master/booth/headphone) to a
 * user-chosen output device. Follows Mixxx's model (a device→bus assignment; the
 * engine just exposes buses) with Web Audio mechanics proven in Loukai.
 *
 * Mechanism per bus:
 *   - device 'default' (or the context's own device): connect the bus straight to
 *     `ctx.destination`.
 *   - a specific device: route the bus through a MediaStreamAudioDestinationNode →
 *     an <audio> element with setSinkId(deviceId). This keeps ONE engine clock
 *     (Mixxx's invariant) while sending each bus to a different sound card — the
 *     headphone-cue-on-a-separate-interface case.
 *
 * (Newer Chromium also supports `new AudioContext({ sinkId })`, but that needs a
 * context per device — multiple clocks. The MediaStream bridge keeps the single
 * engine clock, which is the Mixxx-faithful choice. We can switch to per-context
 * later if a bus needs its own lower-latency device.)
 */

import type { BusNodes, BusType } from './mix-buses.js';

export interface OutputDevice {
  deviceId: string;
  label: string;
}

interface BusRoute {
  /** The MediaStreamDestination feeding the <audio>, or null when on default. */
  streamDest: MediaStreamAudioDestinationNode | null;
  audioEl: HTMLAudioElement | null;
  deviceId: string;
}

export class AudioOutputRouter {
  private readonly routes = new Map<BusType, BusRoute>();

  constructor(
    private readonly ctx: AudioContext,
    private readonly buses: BusNodes,
  ) {
    // All buses start on the default device (master already → destination in the
    // engine; we (re)assert routing here so booth/head can be assigned too).
    this.routes.set('master', { streamDest: null, audioEl: null, deviceId: 'default' });
    this.routes.set('booth', { streamDest: null, audioEl: null, deviceId: 'default' });
    this.routes.set('headphone', { streamDest: null, audioEl: null, deviceId: 'default' });
  }

  /** Enumerate available audio output devices (label-stable; id may rotate). */
  static async listOutputs(): Promise<OutputDevice[]> {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return [];
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audiooutput')
      .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Unknown output' }));
  }

  private busNode(bus: BusType): GainNode {
    return bus === 'master'
      ? this.buses.master
      : bus === 'booth'
        ? this.buses.booth
        : this.buses.headphone;
  }

  /** Currently-assigned device id for a bus. */
  getDevice(bus: BusType): string {
    return this.routes.get(bus)?.deviceId ?? 'default';
  }

  /**
   * Route a bus to a device. 'default' connects to ctx.destination; any other id
   * routes via a MediaStream → <audio sinkId>. setSinkId requires a user gesture
   * to have unlocked audio (same as starting the context).
   */
  async setDevice(bus: BusType, deviceId: string): Promise<void> {
    const route = this.routes.get(bus)!;
    const node = this.busNode(bus);

    // Tear down whatever this bus was connected to.
    try {
      node.disconnect();
    } catch {
      /* not connected */
    }
    if (route.audioEl) {
      route.audioEl.pause();
      route.audioEl.srcObject = null;
      route.audioEl = null;
    }
    if (route.streamDest) {
      route.streamDest.disconnect();
      route.streamDest = null;
    }

    if (deviceId === 'default') {
      node.connect(this.ctx.destination);
      route.deviceId = 'default';
      return;
    }

    // Bridge: bus → MediaStreamDestination → <audio sinkId=deviceId>.
    const streamDest = this.ctx.createMediaStreamDestination();
    node.connect(streamDest);
    const el = new Audio();
    el.srcObject = streamDest.stream;
    el.autoplay = true;
    // setSinkId is on HTMLMediaElement in Chromium.
    await (el as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(deviceId);
    await el.play().catch(() => {
      /* will retry on next gesture */
    });

    route.streamDest = streamDest;
    route.audioEl = el;
    route.deviceId = deviceId;
  }

  dispose(): void {
    for (const route of this.routes.values()) {
      route.audioEl?.pause();
      if (route.audioEl) {
        route.audioEl.srcObject = null;
      }
      route.streamDest?.disconnect();
    }
    this.routes.clear();
  }
}
