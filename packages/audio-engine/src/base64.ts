/**
 * base64 → bytes, using ZERO globals. Critically this must run in the
 * AudioWorklet, whose global scope has neither `atob` (browser/worker only) nor
 * `Buffer` (Node only) — both crash there. So we decode manually. Used to unpack
 * the embedded WASM (resampler, beat detector) that loads inside the worklet.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// reverse lookup: char code → 6-bit value (-1 for non-alphabet, e.g. padding)
const LOOKUP = /* @__PURE__ */ (() => {
  const t = new Int8Array(256).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  return t;
})();

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  // strip padding for length math; ignore any whitespace/newlines defensively
  let len = b64.length;
  while (len > 0 && (b64[len - 1] === '=' || b64.charCodeAt(len - 1) <= 32)) len--;

  // count real alphabet chars to size the output exactly
  let nChars = 0;
  for (let i = 0; i < len; i++) {
    if (LOOKUP[b64.charCodeAt(i)]! >= 0) nChars++;
  }
  const outLen = Math.floor((nChars * 6) / 8);
  const out = new Uint8Array(new ArrayBuffer(outLen));

  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < len; i++) {
    const v = LOOKUP[b64.charCodeAt(i)]!;
    if (v < 0) continue; // skip whitespace
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}
