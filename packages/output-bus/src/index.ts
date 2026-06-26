/**
 * @dj/output-bus — dj-app emits master-bus audio + track metadata + per-display
 * visualization directives over a PLUGGABLE transport. dj-app renders nothing; displays
 * (another tab/window/machine) consume the data and draw the visuals themselves.
 */

export type {
  OutputTransport,
  OutFrame,
  AudioFrame,
  MetaFrame,
  DeckMeta,
  ControlFrame,
  ControlTarget,
  VizDirective,
} from './contract.js';
export { OutputProducer } from './producer.js';
export { BroadcastChannelTransport } from './transports/broadcast-channel.js';
export { IpcTransport, type IpcTransportOptions } from './transports/ipc.js';
export { OutputConsumer, type ConsumerIdentity } from './consumer.js';
