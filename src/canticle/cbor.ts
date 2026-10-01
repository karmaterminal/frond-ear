// Strict, bounded, deterministic CBOR for binary-canticle frame v2 (RFC-0001 §9.4).
//
// A port of the spike's `canticle/cbor.py`. Only the subset frame v2 needs:
// unsigned and negative integers, byte strings, UTF-8 text, arrays, maps,
// false, true and null. The encoder emits RFC 8949 §4.2.1 core deterministic
// encoding. The decoder accepts nothing else: definite lengths, shortest-form
// heads, map keys in strictly increasing bytewise order of their encodings
// (so no duplicates), no floats, no tags, bounded depth and entry counts, and
// no trailing bytes.
//
// Integers decode to `bigint` so the full uint64 range round-trips exactly.

export const MAX_DEPTH = 4;
export const MAX_ENTRIES = 32;

export type CborKey = bigint | string | Uint8Array | boolean | null;
export type CborValue =
  | bigint
  | string
  | Uint8Array
  | boolean
  | null
  | CborValue[]
  | CborMap;
export type CborMap = Map<CborKey, CborValue>;

export class CborError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

const U64_LIMIT = 1n << 64n;

function head(major: number, value: bigint): Uint8Array {
  const m = major << 5;
  if (value < 0n || value >= U64_LIMIT) throw new CborError("int-range");
  if (value < 24n) return Uint8Array.of(m | Number(value));
  if (value < 0x100n) return Uint8Array.of(m | 24, Number(value));
  const size = value < 0x10000n ? 2 : value < 0x100000000n ? 4 : 8;
  const out = new Uint8Array(1 + size);
  out[0] = m | (size === 2 ? 25 : size === 4 ? 26 : 27);
  let v = value;
  for (let i = size; i >= 1; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

export function encode(value: CborValue | number): Uint8Array {
  if (value === false) return Uint8Array.of(0xf4);
  if (value === true) return Uint8Array.of(0xf5);
  if (value === null) return Uint8Array.of(0xf6);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new CborError("unsupported-number");
    return encode(BigInt(value));
  }
  if (typeof value === "bigint") {
    return value >= 0n ? head(0, value) : head(1, -1n - value);
  }
  if (value instanceof Uint8Array) {
    return concat([head(2, BigInt(value.length)), value]);
  }
  if (typeof value === "string") {
    const raw = new TextEncoder().encode(value);
    return concat([head(3, BigInt(raw.length)), raw]);
  }
  if (Array.isArray(value)) {
    return concat([
      head(4, BigInt(value.length)),
      ...value.map((v) => encode(v)),
    ]);
  }
  const entries = [...value.entries()]
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort((a, b) => compareBytes(a[0], b[0]));
  for (let i = 1; i < entries.length; i++) {
    if (compareBytes(entries[i - 1]![0], entries[i]![0]) === 0) {
      throw new CborError("duplicate-key");
    }
  }
  return concat([head(5, BigInt(entries.length)), ...entries.flat()]);
}

class Reader {
  readonly buf: Uint8Array;
  pos = 0;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  take(n: number): Uint8Array {
    const end = this.pos + n;
    if (end > this.buf.length) throw new CborError("truncated");
    const out = this.buf.subarray(this.pos, end);
    this.pos = end;
    return out;
  }

  head(): { major: number; value: bigint } {
    const ib = this.take(1)[0]!;
    const major = ib >> 5;
    const ai = ib & 0x1f;
    if (major === 7) {
      if (ai === 20 || ai === 21 || ai === 22)
        return { major, value: BigInt(ai) };
      throw new CborError("float-or-simple");
    }
    if (major === 6) throw new CborError("tag");
    if (ai < 24) return { major, value: BigInt(ai) };
    if (ai === 31) throw new CborError("indefinite-length");
    if (ai > 27) throw new CborError("reserved-additional-info");
    const size = 1 << (ai - 24);
    let value = 0n;
    for (const byte of this.take(size)) value = (value << 8n) | BigInt(byte);
    const minimum = size === 1 ? 24n : 1n << BigInt((8 * size) / 2);
    if (value < minimum) throw new CborError("non-shortest");
    return { major, value };
  }
}

// ignoreBOM: keep a leading U+FEFF in the string, as Python does; stripping it would make the
// re-encode check reject a correctly signed frame.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function length(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError("truncated");
  return Number(value);
}

function decodeItem(r: Reader, depth: number): CborValue {
  const { major, value } = r.head();
  switch (major) {
    case 0:
      return value;
    case 1:
      return -1n - value;
    case 2:
      // A copy, never a view: Buffer#slice aliases, Uint8Array#slice copies.
      return new Uint8Array(r.take(length(value)));
    case 3:
      try {
        return utf8.decode(r.take(length(value)));
      } catch {
        throw new CborError("bad-utf8");
      }
    case 7:
      return value === 20n ? false : value === 21n ? true : null;
  }
  if (depth >= MAX_DEPTH) throw new CborError("depth");
  if (value > BigInt(MAX_ENTRIES)) throw new CborError("too-many-entries");
  const count = Number(value);
  if (major === 4) {
    const out: CborValue[] = [];
    for (let i = 0; i < count; i++) out.push(decodeItem(r, depth + 1));
    return out;
  }
  const out: CborMap = new Map();
  let prev: Uint8Array | undefined;
  for (let i = 0; i < count; i++) {
    const keyStart = r.pos;
    const key = decodeItem(r, depth + 1);
    const keyBytes = r.buf.subarray(keyStart, r.pos);
    if (prev !== undefined && compareBytes(keyBytes, prev) <= 0) {
      throw new CborError("map-key-order");
    }
    prev = keyBytes;
    if (Array.isArray(key) || key instanceof Map) {
      throw new CborError("complex-key");
    }
    out.set(key, decodeItem(r, depth + 1));
  }
  return out;
}

/** Decode exactly one strict deterministic CBOR item filling `buf`. */
export function decode(buf: Uint8Array): CborValue {
  const r = new Reader(buf);
  const out = decodeItem(r, 0);
  if (r.pos !== buf.length) throw new CborError("trailing-bytes");
  return out;
}
