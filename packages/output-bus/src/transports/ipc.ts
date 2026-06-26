/**
 * IpcTransport — carries frames over an injected message channel, for the case where
 * producer and consumer are in DIFFERENT processes (Electron main renderer ↔ a popup
 * display window). BroadcastChannel can't cross processes; IPC (via the main process)
 * can. This class is transport-mechanism-agnostic: you inject a `send` (producer side)
 * and/or a `subscribe` (consumer side), so the same class serves both ends.
 *
 *   Producer side:  new IpcTransport({ send: (f) => window.dj.displaySend(f) })
 *   Consumer side:  new IpcTransport({ subscribe: (cb) => window.dj.onDisplayFrame(cb) })
 *
 * The actual wire is Electron IPC (renderer → main → display windows). When we later add
 * WebSocket/RTC, those are sibling transports implementing the same OutputTransport
 * interface — nothing upstream changes.
 */

import type { OutputTransport, OutFrame } from '../contract.js';

export interface IpcTransportOptions {
  /** Producer side: deliver a frame to the IPC layer (→ main → display windows). */
  send?: (frame: OutFrame) => void;
  /** Consumer side: register for frames arriving over IPC. Returns an unsubscribe fn. */
  subscribe?: (cb: (frame: OutFrame) => void) => () => void;
}

export class IpcTransport implements OutputTransport {
  readonly name = 'ipc';
  private readonly sendFn?: (frame: OutFrame) => void;
  private off: (() => void) | null = null;
  private readonly subs = new Set<(f: OutFrame) => void>();

  constructor(opts: IpcTransportOptions) {
    this.sendFn = opts.send;
    if (opts.subscribe) {
      this.off = opts.subscribe((frame) => {
        for (const cb of this.subs) cb(frame);
      });
    }
  }

  send(frame: OutFrame): void {
    this.sendFn?.(frame);
  }

  onFrame(cb: (f: OutFrame) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  close(): void {
    this.off?.();
    this.off = null;
    this.subs.clear();
  }
}
