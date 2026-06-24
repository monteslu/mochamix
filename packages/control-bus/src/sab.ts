/**
 * SharedArrayBuffer mirror of the control bus.
 *
 * This is the JS analog of Mixxx's atomic-double ControlObjects (see
 * 04-audio-engine.md §0/§7): the audio worklet must read control values without
 * locks and without postMessage round-trips. We lay out one Float64 slot per
 * registered control, indexed by the control's stable integer `index`.
 *
 * Writers: whichever thread owns the authoritative store writes values in
 * (renderer main thread for UI-driven controls, the worklet for engine-published
 * controls like playposition/vu). Reads are plain indexed loads. Float64 stores
 * are atomic enough for our single-writer-per-slot discipline; a generation
 * counter lets readers detect a batch of changes cheaply if needed.
 *
 * Slot 0 of a parallel Int32 header array is a global generation counter bumped
 * on every write, so a consumer can `Atomics.load` it to know "did anything
 * change since I last looked" without scanning all slots.
 */

/** Number of Int32 header slots reserved before the value array. */
const HEADER_I32 = 8;
/** Header slot indices (Int32). */
export const HEADER_GENERATION = 0;
export const HEADER_CONTROL_COUNT = 1;

export interface SabLayout {
  /** The backing SharedArrayBuffer. */
  buffer: SharedArrayBuffer;
  /** Int32 header view (generation counter, control count). */
  header: Int32Array;
  /** Float64 value view, one slot per control index. */
  values: Float64Array;
  /** Capacity in controls. */
  capacity: number;
}

/**
 * Allocate a SAB sized for `capacity` controls. Header (Int32) is placed first,
 * then the Float64 value array (8-byte aligned because the header is a multiple
 * of 8 bytes: HEADER_I32 * 4 = 32 bytes).
 */
export function allocateSab(capacity: number): SabLayout {
  const headerBytes = HEADER_I32 * Int32Array.BYTES_PER_ELEMENT; // 32
  const valueBytes = capacity * Float64Array.BYTES_PER_ELEMENT;
  const buffer = new SharedArrayBuffer(headerBytes + valueBytes);
  return wrapSab(buffer, capacity);
}

/** Wrap an existing SAB (e.g. received in a worklet) with typed views. */
export function wrapSab(buffer: SharedArrayBuffer, capacity: number): SabLayout {
  const header = new Int32Array(buffer, 0, HEADER_I32);
  const values = new Float64Array(buffer, HEADER_I32 * Int32Array.BYTES_PER_ELEMENT, capacity);
  return { buffer, header, values, capacity };
}

/** Write a value into a control slot and bump the global generation counter. */
export function sabWrite(layout: SabLayout, index: number, value: number): void {
  layout.values[index] = value;
  // Bump generation last so a reader that sees a new generation also sees the value.
  Atomics.add(layout.header, HEADER_GENERATION, 1);
}

/** Read a control slot (plain load; values are written single-writer-per-slot). */
export function sabRead(layout: SabLayout, index: number): number {
  return layout.values[index] ?? 0;
}

/** Current generation counter (atomic). */
export function sabGeneration(layout: SabLayout): number {
  return Atomics.load(layout.header, HEADER_GENERATION);
}
