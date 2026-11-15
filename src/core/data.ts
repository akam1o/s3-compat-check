import { createHash } from "node:crypto";

/** Derive a 32-bit seed from a string (FNV-1a). */
export function seedFrom(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0 || 1;
}

/**
 * Generate reproducible pseudo-random bytes (xorshift32). The content is
 * artificial and never derived from user data.
 */
export function deterministicBytes(size: number, seed: number | string): Buffer {
  let state = (typeof seed === "string" ? seedFrom(seed) : seed >>> 0) || 1;
  const buf = Buffer.allocUnsafe(size);
  let i = 0;
  for (; i + 4 <= size; i += 4) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    buf.writeUInt32LE(state >>> 0, i);
  }
  if (i < size) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    for (let shift = 0; i < size; i++, shift += 8) buf[i] = (state >>> shift) & 0xff;
  }
  return buf;
}

export function sha256Base64(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("base64");
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function md5Hex(data: Uint8Array): string {
  return createHash("md5").update(data).digest("hex");
}

/** Index of the first differing byte, or -1 if the arrays are identical. */
export function firstDifference(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}
