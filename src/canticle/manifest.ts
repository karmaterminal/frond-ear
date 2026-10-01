// Fleet manifest: the only place a key-id resolves to a public key (RFC-0001 §5.1, §10.3).
// A port of the spike's `canticle/manifest.py`.
//
// Spike limitation, kept here: the manifest is an unsigned JSON file. RFC-0001
// requires a manifest signed by an offline 2-of-n root with capability
// classes, audiences and a revocation list; this file carries the same fields
// without the signature. The ear only ever reads a local file named in its
// config, and never fetches one.

import type { KeyObject } from "node:crypto";

import {
  CLASS_BY_NAME,
  SCOPES,
  checkStreamName,
  keyId,
  streamIds,
} from "./ids.ts";
import { Reject, ed25519PublicKey } from "./wire.ts";

const DEFAULT_SCOPES: ReadonlySet<number> = new Set([
  SCOPES.host!,
  SCOPES.lan!,
]);

export interface StationEntry {
  name: string;
  publicKey: Uint8Array;
  /** Class codes this key may sign (§10.4). */
  classes: ReadonlySet<number>;
  /** Stream names, so listeners can map ids to names (§5.4). */
  streams: readonly string[];
  revoked: boolean;
  /** Scope codes this key may sign (§4.3, §10.3 `scopes`). */
  scopes: ReadonlySet<number>;
  keyIdHex: string;
  streamNames: ReadonlyMap<number, string>;
}

export interface StationInput {
  name: string;
  publicKey: Uint8Array;
  classes: Iterable<number>;
  streams?: readonly string[];
  revoked?: boolean;
  scopes?: Iterable<number>;
}

export function stationEntry(input: StationInput): StationEntry {
  const streams = [...(input.streams ?? [])];
  for (const s of streams) checkStreamName(s);
  return {
    name: input.name,
    publicKey: input.publicKey,
    classes: new Set(input.classes),
    streams,
    revoked: input.revoked ?? false,
    scopes: input.scopes ? new Set(input.scopes) : DEFAULT_SCOPES,
    keyIdHex: hex(keyId(input.publicKey)),
    streamNames: streamIds(streams),
  };
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function fromHex(text: unknown, what: string): Uint8Array {
  if (typeof text !== "string" || !/^([0-9a-f]{2})*$/i.test(text)) {
    throw new Error(`manifest: ${what} must be a hex string`);
  }
  return new Uint8Array(Buffer.from(text, "hex"));
}

export class Manifest {
  readonly #byKid = new Map<string, StationEntry>();
  readonly #keys = new Map<string, KeyObject>();

  constructor(entries: Iterable<StationEntry> = []) {
    for (const e of entries) this.add(e);
  }

  add(e: StationEntry): void {
    if (this.#byKid.has(e.keyIdHex)) {
      throw new Error(
        `two keys share key-id ${e.keyIdHex}; the manifest is invalid (§5.1)`,
      );
    }
    this.#byKid.set(e.keyIdHex, e);
    this.#keys.set(e.keyIdHex, ed25519PublicKey(e.publicKey));
  }

  entry(kid: Uint8Array): StationEntry | undefined {
    return this.#byKid.get(hex(kid));
  }

  /** The verifying key for `kid`, undefined if unknown; throws `Reject("revoked-key")` if revoked. */
  resolve = (kid: Uint8Array): KeyObject | undefined => {
    const k = hex(kid);
    const e = this.#byKid.get(k);
    if (e === undefined) return undefined;
    if (e.revoked) throw new Reject("revoked-key", k);
    return this.#keys.get(k);
  };

  get size(): number {
    return this.#byKid.size;
  }

  [Symbol.iterator](): IterableIterator<StationEntry> {
    return this.#byKid.values();
  }

  static fromJson(data: unknown): Manifest {
    if (typeof data !== "object" || data === null)
      throw new Error("manifest: not an object");
    const stations = (data as { stations?: unknown }).stations ?? [];
    if (!Array.isArray(stations))
      throw new Error("manifest: stations must be an array");
    return new Manifest(
      stations.map((s: Record<string, unknown>) => {
        if (typeof s.name !== "string")
          throw new Error("manifest: station name must be a string");
        const classes = (s.classes ?? []) as unknown[];
        const scopes = s.scopes as unknown[] | undefined;
        return stationEntry({
          name: s.name,
          publicKey: fromHex(s.public_key, `${s.name}.public_key`),
          classes: classes.map((c) => {
            const spec =
              typeof c === "string" ? CLASS_BY_NAME.get(c) : undefined;
            if (spec === undefined)
              throw new Error(
                `manifest: ${s.name}: unknown class ${String(c)}`,
              );
            return spec.code;
          }),
          streams: (s.streams ?? []) as string[],
          revoked: s.revoked === true,
          ...(scopes === undefined
            ? {}
            : {
                scopes: scopes.map((x) => {
                  const code = typeof x === "string" ? SCOPES[x] : undefined;
                  if (code === undefined)
                    throw new Error(
                      `manifest: ${s.name}: unknown scope ${String(x)}`,
                    );
                  return code;
                }),
              }),
        });
      }),
    );
  }
}
