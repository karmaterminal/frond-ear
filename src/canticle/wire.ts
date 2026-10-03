// Frame v2: fixed header, deterministic CBOR map, Ed25519 trailer (RFC-0001 §9).
// A port of the parsing half of the spike's `canticle/wire.py`; v1 of the ear
// only listens, so there is no encoder for frames here.
//
// `parse` is the strict admission path. It never throws anything but
// `Reject`, whatever the input, so one bad datagram cannot stop a receiver.
//
// One deliberate difference from the spike: every uint except a sequence number
// is a JS number, so a value above Number.MAX_SAFE_INTEGER (2^53 - 1) is rejected
// as `bad-field` where the spike accepts it. That covers millisecond timestamps
// (about year 287 000) and a BEACON's `page`. Sequence numbers keep the full
// uint64 range as bigint, and the §9.8 u32 fields (a stream entry's `.size 4`
// fields, `next_beacon_ms`, `b_station`) are bounded at 2^32 - 1 on both ports.
// Cross-port divergences are tracked in binary-canticle#66.
//
// Unknown extension keys (an ITEM's `extra`) and a BEACON's `capsid` and `relay`
// maps are validated but not kept: nothing in a listen-only receiver reads them.

import { createPublicKey, verify, type KeyObject } from "node:crypto";

import * as cbor from "./cbor.ts";
import { CLASSES } from "./ids.ts";

export const MAGIC_0 = 0x42; // "B"
export const MAGIC_1 = 0x43; // "C"
export const VERSION = 2;
export const KIND_ITEM = 0x01;
export const KIND_BEACON = 0x02;
export const KIND_PLUCK = 0x03;
export const HEADER_LEN = 12;
export const SIG_LEN = 64;
export const MAX_DATAGRAM = 1200;
export const MAX_FRAME = 1100;
export const SIGN_DOMAIN = new TextEncoder().encode(
  "binary-canticle/frame/v2\x00",
);
// Ed25519 group order; signatures with S >= L are rejected (§9.3).
export const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;
export const FUTURE_SKEW_MS = 5_000;
export const MAX_CLAMP_TTL_S = Math.max(
  ...[...CLASSES.values()].map((c) => c.maxTtlS),
);

const KEYED_CLASSES = new Set(
  [...CLASSES.values()].filter((c) => c.keyed).map((c) => c.code),
);
const range = (n: number) => [...Array(n).keys()];
const UNDERSTOOD: ReadonlyMap<number, ReadonlySet<number>> = new Map([
  [KIND_ITEM, new Set(range(19))],
  [KIND_PLUCK, new Set([0, 1, 2, 3, 4, 5, 13, 20, 21])],
  [KIND_BEACON, new Set(range(12))],
]);

/** A datagram was not admitted. `reason` is the evidence name. */
export class Reject extends Error {
  readonly reason: string;
  readonly detail: string;
  constructor(reason: string, detail = "") {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason;
    this.detail = detail;
  }
}

/** (key_id, epoch, stream, seq) (§5.6). */
export interface Identity {
  keyId: Uint8Array;
  epoch: number;
  stream: number;
  seq: bigint;
}

export interface BodyRef {
  url: string;
  sha256: Uint8Array;
  size: bigint;
}

export interface Item {
  epoch: number;
  stream: number;
  seq: bigint;
  issuedAt: number;
  expiresAt: number;
  cls: number;
  ctype: number | string;
  body: Uint8Array | undefined;
  bodyRef: BodyRef | undefined;
  stateKey: string | undefined;
  hop: number;
  derivedFrom: Identity[];
  scope: number;
  intensity: number | undefined;
  flags: number;
  purpose: string | undefined;
  root: Identity | undefined;
  lens: number | undefined;
}

export const FLAG_REFRESH = 1;

export interface Pluck {
  epoch: number;
  stream: number;
  seq: bigint;
  issuedAt: number;
  expiresAt: number;
  scope: number;
  targetSeq: bigint;
  reason: number | undefined;
}

/**
 * One §9.8 `stream-entry` (post-A1): 9 elements, or 10 with `lens`. `trailSeq` (amendment A1) is the
 * lowest seq of any ITEM or PLUCK still on air on the stream in this epoch, `headSeq + 1` when nothing
 * is. A `trailSeq` above `headSeq + 1` is bad-field (§9.8, binary-canticle#72). The listener holds it;
 * §7.10's wait-or-repair is not built (binary-canticle#70).
 */
export interface StreamEntry {
  streamId: number;
  headSeq: bigint;
  trailSeq: bigint;
  live: number;
  loopMs: number;
  loopMaxMs: number;
  defaultTtlS: number;
  maxTtlS: number;
  bStream: number;
  lens: number | undefined;
}

export interface Beacon {
  epoch: number;
  bseq: bigint;
  wallclock: number;
  nextBeaconMs: number;
  profile: string;
  streams: StreamEntry[];
  bStation: number;
  page: [number, number] | undefined;
  catalogDigest: Uint8Array | undefined;
}

export type Frame =
  | { kind: typeof KIND_ITEM; keyId: Uint8Array; body: Item; raw: Uint8Array }
  | { kind: typeof KIND_PLUCK; keyId: Uint8Array; body: Pluck; raw: Uint8Array }
  | {
      kind: typeof KIND_BEACON;
      keyId: Uint8Array;
      body: Beacon;
      raw: Uint8Array;
    };

/** Resolve a key-id to a verifying key, return undefined if unknown, or throw `Reject` (e.g. revoked). */
export type Resolver = (keyId: Uint8Array) => KeyObject | undefined;

const SPKI_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

export function ed25519PublicKey(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) throw new Error("Ed25519 public keys are 32 bytes");
  const der = new Uint8Array(SPKI_ED25519_PREFIX.length + 32);
  der.set(SPKI_ED25519_PREFIX);
  der.set(raw, SPKI_ED25519_PREFIX.length);
  return createPublicKey({
    key: Buffer.from(der),
    format: "der",
    type: "spki",
  });
}

// ---------------------------------------------------------------- field checks

const U32_MAX = 2 ** 32 - 1;
const U64_MAX = (1n << 64n) - 1n;

function uintBig(
  v: cbor.CborValue | undefined,
  name: string,
  max: bigint = U64_MAX,
): bigint {
  if (typeof v !== "bigint" || v < 0n || v > max)
    throw new Reject("bad-field", name);
  return v;
}

function uint(
  v: cbor.CborValue | undefined,
  name: string,
  max: number = Number.MAX_SAFE_INTEGER,
): number {
  return Number(uintBig(v, name, BigInt(max)));
}

function tstr(
  v: cbor.CborValue | undefined,
  name: string,
  lo = 0,
  hi = 1 << 20,
): string {
  if (typeof v !== "string") throw new Reject("bad-field", name);
  const n = Buffer.byteLength(v);
  if (n < lo || n > hi) throw new Reject("bad-field", name);
  return v;
}

function identity(v: cbor.CborValue | undefined, name: string): Identity {
  if (
    !Array.isArray(v) ||
    v.length !== 4 ||
    !(v[0] instanceof Uint8Array) ||
    v[0].length !== 8
  ) {
    throw new Reject("bad-field", name);
  }
  return {
    keyId: v[0],
    epoch: uint(v[1], name, U32_MAX),
    stream: uint(v[2], name, U32_MAX),
    seq: uintBig(v[3], name),
  };
}

type IntMap = Map<number, cbor.CborValue>;

function require(m: IntMap, keys: number[], kindName: string): void {
  const missing = keys.filter((k) => !m.has(k));
  if (missing.length > 0) {
    throw new Reject(
      "missing-field",
      `${kindName} keys [${missing.join(", ")}]`,
    );
  }
}

function optional<T>(
  m: IntMap,
  key: number,
  read: (v: cbor.CborValue) => T,
): T | undefined {
  return m.has(key) ? read(m.get(key)!) : undefined;
}

function parseItem(m: IntMap): Item {
  require(m, [1, 2, 3, 4, 5, 6, 7, 11, 13], "ITEM");
  if (!m.has(8) && !m.has(9)) {
    throw new Reject("missing-field", "ITEM needs body (8) or body_ref (9)");
  }
  const rawCtype = m.get(7);
  const ctype =
    typeof rawCtype === "string"
      ? tstr(rawCtype, "ctype", 1, 64)
      : uint(rawCtype, "ctype", 0xffff);
  const body = m.get(8);
  if (body !== undefined && !(body instanceof Uint8Array))
    throw new Reject("bad-field", "body");
  let bodyRef: BodyRef | undefined;
  if (m.has(9)) {
    const br = m.get(9);
    if (
      !(
        Array.isArray(br) &&
        br.length === 3 &&
        br[1] instanceof Uint8Array &&
        br[1].length === 32
      )
    ) {
      throw new Reject("bad-field", "body_ref");
    }
    bodyRef = {
      url: tstr(br[0], "body_ref.url", 1, 200),
      sha256: br[1],
      size: uintBig(br[2], "body_ref.size"),
    };
  }
  const cls = uint(m.get(6), "class", 0xffff);
  const stateKey = optional(m, 10, (v) => tstr(v, "state_key", 1, 32));
  if (KEYED_CLASSES.has(cls) && stateKey === undefined) {
    throw new Reject("missing-field", "state_key required for keyed classes");
  }
  let derivedFrom: Identity[] = [];
  if (m.has(12)) {
    const d = m.get(12);
    if (!Array.isArray(d) || d.length > 4)
      throw new Reject("bad-field", "derived_from");
    derivedFrom = d.map((t) => identity(t, "derived_from"));
    if (!m.has(17))
      throw new Reject("missing-field", "root required with derived_from");
  }
  const flags = m.has(15) ? uint(m.get(15), "flags", 0xffff) : 0;
  if (flags >> 4) throw new Reject("bad-field", "flags bits 4-15 must be 0");
  const it: Item = {
    epoch: uint(m.get(1), "epoch", U32_MAX),
    stream: uint(m.get(2), "stream", U32_MAX),
    seq: uintBig(m.get(3), "seq"),
    issuedAt: uint(m.get(4), "issued_at"),
    expiresAt: uint(m.get(5), "expires_at"),
    cls,
    ctype,
    body,
    bodyRef,
    stateKey,
    hop: uint(m.get(11), "hop", 15),
    derivedFrom,
    scope: uint(m.get(13), "scope", 3),
    intensity: optional(m, 14, (v) => uint(v, "intensity", 255)),
    flags,
    purpose: optional(m, 16, (v) => tstr(v, "purpose", 0, 128)),
    root: optional(m, 17, (v) => identity(v, "root")),
    lens: optional(m, 18, (v) => uint(v, "lens", 0xffff)),
  };
  if (it.expiresAt <= it.issuedAt) {
    throw new Reject("bad-field", "expires_at must be after issued_at");
  }
  return it;
}

function parsePluck(m: IntMap): Pluck {
  require(m, [1, 2, 3, 4, 5, 13, 20], "PLUCK");
  const p: Pluck = {
    epoch: uint(m.get(1), "epoch", U32_MAX),
    stream: uint(m.get(2), "stream", U32_MAX),
    seq: uintBig(m.get(3), "seq"),
    issuedAt: uint(m.get(4), "issued_at"),
    expiresAt: uint(m.get(5), "expires_at"),
    scope: uint(m.get(13), "scope", 3),
    targetSeq: uintBig(m.get(20), "target_seq"),
    reason: optional(m, 21, (v) => uint(v, "reason", 2)),
  };
  if (p.expiresAt <= p.issuedAt || p.targetSeq >= p.seq) {
    throw new Reject("bad-field", "pluck times or target");
  }
  return p;
}

function parseBeacon(m: IntMap): Beacon {
  require(m, [1, 2, 3, 4, 5, 6, 8], "BEACON");
  const rawStreams = m.get(6);
  if (!Array.isArray(rawStreams)) throw new Reject("bad-field", "streams");
  const streams = rawStreams.map((e): StreamEntry => {
    // 9 elements, or 10 with lens (§9.8 post-A1). A pre-A1 8-element entry is bad-field: accepting it
    // would read every field after head_seq shifted, since no length tells the shapes apart
    // (binary-canticle#70).
    if (!Array.isArray(e) || (e.length !== 9 && e.length !== 10)) {
      throw new Reject("bad-field", "stream-entry");
    }
    // §9.8 CDDL: `.size 4` fields are u32; head_seq and trail_seq (`.size 8`) are u64.
    const n = (i: number, name: string) =>
      uint(e[i], `stream-entry.${name}`, U32_MAX);
    const headSeq = uintBig(e[1], "stream-entry.head_seq");
    const trailSeq = uintBig(e[2], "stream-entry.trail_seq");
    // §9.8 receiver rule (binary-canticle#72): a sender builds trail_seq as min(ring) <= head_seq, or
    // head_seq + 1 when nothing is on air. Anything larger is no station state. bigint doesn't wrap, so
    // head_seq = 2^64-1 is safe.
    if (trailSeq > headSeq + 1n) {
      throw new Reject(
        "bad-field",
        "stream-entry.trail_seq exceeds head_seq + 1",
      );
    }
    return {
      streamId: n(0, "stream_id"),
      headSeq,
      trailSeq,
      live: n(3, "live"),
      loopMs: n(4, "loop_ms"),
      loopMaxMs: n(5, "loop_max_ms"),
      defaultTtlS: n(6, "default_ttl_s"),
      maxTtlS: n(7, "max_ttl_s"),
      bStream: n(8, "b_stream"),
      lens: e.length === 10 ? n(9, "lens") : undefined,
    };
  });
  let page: [number, number] | undefined;
  if (m.has(7)) {
    const pg = m.get(7);
    if (!(Array.isArray(pg) && pg.length === 2))
      throw new Reject("bad-field", "page");
    page = [uint(pg[0], "page"), uint(pg[1], "page", 8)];
    if (page[0] >= page[1]) throw new Reject("bad-field", "page index");
  }
  const digest = m.get(9);
  if (
    digest !== undefined &&
    !(digest instanceof Uint8Array && digest.length === 8)
  ) {
    throw new Reject("bad-field", "catalog_digest");
  }
  for (const k of [10, 11]) {
    if (m.has(k) && !(m.get(k) instanceof Map)) {
      throw new Reject("bad-field", k === 10 ? "capsid" : "relay");
    }
  }
  return {
    epoch: uint(m.get(1), "epoch", U32_MAX),
    bseq: uintBig(m.get(2), "bseq"),
    wallclock: uint(m.get(3), "wallclock"),
    nextBeaconMs: uint(m.get(4), "next_beacon_ms", U32_MAX),
    profile: tstr(m.get(5), "profile", 1, 32),
    streams,
    bStation: uint(m.get(8), "b_station", U32_MAX),
    page,
    catalogDigest: digest,
  };
}

/**
 * Receiver-clock expiry (§14.6.3):
 * `min(expires_eff + δ̂, first_heard + (expires_eff − issued_at))`.
 *
 * `expires_eff` clamps an ITEM to its class max TTL (§6.2). δ̂ (receiver minus
 * station clock, §8.2) moves the station's expiry onto the receiver clock, and
 * the TTL counted from first hearing caps it, so a wrong or lying station
 * clock can never keep an item longer than its full TTL.
 */
export function localExpiryMs(
  frame: { kind: number; body: Item | Pluck },
  clockOffsetMs = 0,
  firstHeardMs?: number,
): number {
  const b = frame.body;
  // An ITEM clamps to its class max TTL (§6.2). A PLUCK clamps to the largest class max
  // TTL, since its target's class isn't known here: a far-future PLUCK must not pin a
  // sticky entry and a dedup slot for decades (binary-canticle#60; the spike doesn't clamp).
  const maxTtlS =
    frame.kind === KIND_ITEM
      ? (CLASSES.get((b as Item).cls)?.maxTtlS ?? MAX_CLAMP_TTL_S)
      : MAX_CLAMP_TTL_S;
  const exp = Math.min(b.expiresAt, b.issuedAt + maxTtlS * 1000);
  let local = exp + clockOffsetMs;
  if (firstHeardMs !== undefined)
    local = Math.min(local, firstHeardMs + (exp - b.issuedAt));
  return local;
}

/**
 * Admit one datagram or throw `Reject`: size, header, key, CBOR, fields, time
 * window, then signature (cheap checks first, §12.2).
 */
export function parse(
  datagram: Uint8Array,
  resolve: Resolver,
  nowMs?: number,
  clockOffsetMs = 0,
): Frame {
  try {
    // Copy once: the frame's byte fields (key-id, body, raw, …) must never alias the caller's
    // datagram, which a dgram socket may reuse or the caller may mutate (wire.py: bytes(datagram)).
    return parseStrict(
      Uint8Array.from(datagram),
      resolve,
      nowMs,
      clockOffsetMs,
    );
  } catch (e) {
    if (e instanceof Reject) throw e;
    // Defence in depth: nothing else may escape.
    throw new Reject("internal", e instanceof Error ? e.name : typeof e);
  }
}

function parseStrict(
  buf: Uint8Array,
  resolve: Resolver,
  nowMs: number | undefined,
  clockOffsetMs: number,
): Frame {
  if (buf.length > MAX_DATAGRAM)
    throw new Reject("oversize", `${buf.length} bytes`);
  if (buf.length < HEADER_LEN + 1 + SIG_LEN) throw new Reject("short");
  if (buf[0] !== MAGIC_0 || buf[1] !== MAGIC_1) throw new Reject("bad-magic");
  if (buf[2] !== VERSION) throw new Reject("bad-version", String(buf[2]));
  const kind = buf[3]!;
  const understood = UNDERSTOOD.get(kind);
  if (understood === undefined) {
    throw new Reject(
      "unsupported-kind",
      `0x${kind.toString(16).padStart(2, "0")}`,
    );
  }
  if (buf.length > MAX_FRAME)
    throw new Reject("oversize", `frame ${buf.length} > ${MAX_FRAME}`);
  const kid = buf.slice(4, 12);
  const publicKey = resolve(kid);
  if (publicKey === undefined)
    throw new Reject("unknown-key", Buffer.from(kid).toString("hex"));
  const rawMap = buf.subarray(HEADER_LEN, buf.length - SIG_LEN);
  let decoded: cbor.CborValue;
  try {
    decoded = cbor.decode(rawMap);
  } catch (e) {
    if (!(e instanceof cbor.CborError)) throw e;
    if (
      [
        "map-key-order",
        "non-shortest",
        "indefinite-length",
        "duplicate-key",
      ].includes(e.reason)
    ) {
      throw new Reject("non-deterministic", e.reason);
    }
    throw new Reject("bad-cbor", e.reason);
  }
  if (
    !(decoded instanceof Map) ||
    ![...decoded.keys()].every((k) => typeof k === "bigint")
  ) {
    throw new Reject("bad-cbor", "top level must be an integer-keyed map");
  }
  if (cbor.compareBytes(cbor.encode(decoded), rawMap) !== 0)
    throw new Reject("non-deterministic");
  const m: IntMap = new Map();
  for (const [k, v] of decoded) {
    const key = k as bigint;
    // Keys beyond the safe range are unknown extensions; they can't collide with core keys.
    m.set(
      key >= -(2n ** 53n) && key <= 2n ** 53n ? Number(key) : Number.NaN,
      v,
    );
  }
  if (m.has(0)) {
    const crit = m.get(0);
    if (!Array.isArray(crit) || !crit.every((k) => typeof k === "bigint")) {
      throw new Reject("bad-field", "crit");
    }
    const unknown = crit.filter(
      (k) => !understood.has(Number(k)) || (k as bigint) > 2n ** 53n,
    );
    if (unknown.length > 0)
      throw new Reject("crit-unknown", `[${unknown.join(", ")}]`);
  }
  let frame: Frame;
  if (kind === KIND_ITEM)
    frame = { kind, keyId: kid, body: parseItem(m), raw: buf };
  else if (kind === KIND_PLUCK)
    frame = { kind, keyId: kid, body: parsePluck(m), raw: buf };
  else
    frame = { kind: KIND_BEACON, keyId: kid, body: parseBeacon(m), raw: buf };
  if (nowMs !== undefined && frame.kind !== KIND_BEACON) {
    if (frame.body.issuedAt > nowMs - clockOffsetMs + FUTURE_SKEW_MS)
      throw new Reject("not-yet-valid");
    if (localExpiryMs(frame, clockOffsetMs) <= nowMs)
      throw new Reject("expired");
  }
  const sig = buf.subarray(buf.length - SIG_LEN);
  let s = 0n;
  for (let i = SIG_LEN - 1; i >= 32; i--) s = (s << 8n) | BigInt(sig[i]!);
  if (s >= ED25519_L) throw new Reject("bad-signature", "non-canonical S");
  const signed = new Uint8Array(SIGN_DOMAIN.length + buf.length - SIG_LEN);
  signed.set(SIGN_DOMAIN);
  signed.set(buf.subarray(0, buf.length - SIG_LEN), SIGN_DOMAIN.length);
  if (!verify(null, signed, publicKey, sig)) throw new Reject("bad-signature");
  return frame;
}
