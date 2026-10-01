// Station identity, stream ids and the class registry (RFC-0001 §5, §6.2).
// A port of the spike's `canticle/ids.py`.

import { createHash } from "node:crypto";

const SEGMENT = "[a-z][a-z0-9-]{0,30}";
const STREAM_NAME_RE = new RegExp(`^${SEGMENT}(\\.${SEGMENT}){0,3}$`);

/** SHA-256(public key)[0:8] (§5.1). */
export function keyId(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== 32) {
    throw new Error("Ed25519 public keys are 32 bytes");
  }
  return new Uint8Array(
    createHash("sha256").update(publicKey).digest().subarray(0, 8),
  );
}

export function checkStreamName(name: string): string {
  if (Buffer.byteLength(name) > 64 || !STREAM_NAME_RE.test(name)) {
    throw new Error(
      `invalid stream name ${JSON.stringify(name)}: up to 4 dot-joined segments of [a-z][a-z0-9-]{0,30}, 64 bytes max`,
    );
  }
  return name;
}

/** First 4 bytes, big-endian, of SHA-256("canticle-stream/v2" || 0x00 || name) (§5.4). */
export function streamId(name: string): number {
  checkStreamName(name);
  const digest = createHash("sha256")
    .update("canticle-stream/v2\x00")
    .update(name)
    .digest();
  return digest.readUInt32BE(0);
}

/** Map names to ids, refusing collisions (§5.4): rename, never rehash. */
export function streamIds(names: Iterable<string>): Map<number, string> {
  const out = new Map<number, string>();
  for (const name of names) {
    const sid = streamId(name);
    const other = out.get(sid);
    if (other !== undefined && other !== name) {
      throw new Error(
        `stream_id collision: ${JSON.stringify(other)} and ${JSON.stringify(name)} both map to 0x${sid.toString(16).padStart(8, "0")}; rename one`,
      );
    }
    out.set(sid, name);
  }
  return out;
}

export interface ClassSpec {
  code: number;
  name: string;
  defaultTtlS: number;
  maxTtlS: number;
  loopFloorMs: number;
  hopLimit: number;
  /** state_key REQUIRED. */
  keyed: boolean;
  /** v1: alarm only, and gated (§14.10). */
  wakeEligible: boolean;
}

function spec(
  code: number,
  name: string,
  defaultTtlS: number,
  maxTtlS: number,
  loopFloorMs: number,
  hopLimit: number,
  keyed: boolean,
  wakeEligible: boolean,
): ClassSpec {
  return {
    code,
    name,
    defaultTtlS,
    maxTtlS,
    loopFloorMs,
    hopLimit,
    keyed,
    wakeEligible,
  };
}

export const CLASSES: ReadonlyMap<number, ClassSpec> = new Map(
  [
    spec(1, "chatter", 60, 300, 5_000, 2, false, false),
    spec(2, "ambient", 300, 3_600, 10_000, 2, false, false),
    spec(3, "live-state", 180, 900, 5_000, 2, true, false),
    spec(4, "advisory", 900, 3_600, 5_000, 1, false, false),
    spec(5, "finding-ref", 900, 86_400, 10_000, 1, false, false),
    spec(6, "regulatory", 600, 3_600, 5_000, 0, true, false),
    spec(7, "alarm", 900, 3_600, 2_000, 0, true, true),
    spec(8, "control", 600, 3_600, 1_000, 0, true, false),
    spec(9, "root", 3_600, 3_600, 30_000, 0, true, false),
  ].map((c) => [c.code, c]),
);

export const CLASS_BY_NAME: ReadonlyMap<string, ClassSpec> = new Map(
  [...CLASSES.values()].map((c) => [c.name, c]),
);

export const SCOPES: ReadonlyMap<string, number> = new Map([
  ["host", 0],
  ["lan", 1],
  ["fleet", 2],
  ["public", 3],
]);

export const SCOPE_NAMES: ReadonlyMap<number, string> = new Map(
  [...SCOPES].map(([name, code]) => [code, name]),
);

/** Content-type registry (§9.9). */
export const CTYPE_TEXT = 1;
