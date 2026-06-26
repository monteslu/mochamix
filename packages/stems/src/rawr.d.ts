/** Minimal ambient types for the untyped `rawr` JSON-RPC library. */
declare module 'rawr' {
  interface RawrOpts {
    transport: unknown;
    timeout?: number;
    methods?: Record<string, (...args: never[]) => unknown>;
  }
  interface RawrPeer {
    methods: Record<string, (...args: unknown[]) => Promise<unknown>>;
    /** Send a notification: peer.notifiers.<name>(...args). */
    notifiers: Record<string, (...args: unknown[]) => void>;
    /** Subscribe to notifications: peer.notifications.on<Name>(cb). */
    notifications: Record<string, (cb: (...args: never[]) => void) => void>;
  }
  export default function rawr(opts: RawrOpts): RawrPeer;
}

declare module 'rawr/transports/worker' {
  /** Page-side transport: wraps a Worker instance. */
  export function dom(worker: Worker): unknown;
  /** Worker-side transport: uses the worker's own postMessage. */
  export function worker(): unknown;
}
