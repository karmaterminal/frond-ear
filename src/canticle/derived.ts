// The derived-publication adapter (binary-canticle#161 item 4): the call path from frond-ear
// to a station's derived op, behind phase 1's closed-by-default seam (custody.ts).
//
// The station side is binary-canticle#159, assembled in #162 (head 452c5433). Its control
// transport takes exactly two messages on the station's Unix control socket, one JSON line
// per connection and one answer line back, from a peer of the station's own uid:
//
//   {"op": "derived_publish", "capsule_b64": …, "text": …}  → {"ok": true, "acceptance": {…}}
//   {"op": "derived_query", "election_id": <32 hex>}         → {"ok": true, "state": …, …}
//
// It takes no lineage, audience, signer, stream or policy field: those are bound inside the
// capsule, an HMAC envelope the owner's authority issues from its own ledger and the station
// checks against that same ledger. So frond-ear never mints a capsule. It hands the owner's
// issuer the lineage custody holds (each source's id and payload digest and what the
// verified record said of itself; the author, the session holding the ear; the audience, no
// wider than the narrowest source scope) with the elected text, and sends the station only
// what #162 accepts. It never sends `sing`: heard content is never sung back as heard.
//
// #162 has no capability advertisement. The one answer that names the derived op without
// any effect is `derived_query`'s, so frond-ear asks it about an election no authority
// issues and reads `station_claim_missing` (the op is configured, this uid admitted, no
// such claim) as the capability. Any other answer is its absence, in the station's words.
//
// A lost answer is never retried. #162: the host queries the same election and never makes
// a new one to retry an uncertain effect, so an unanswered publish stays `unknown` until a
// `derived_query` says otherwise.

import { createHash } from "node:crypto";
import { connect } from "node:net";

import type { CanticleCustody, ExposureLineage } from "../store.ts";

/** #162's bound on the elected text (MAX_PAYLOAD_BYTES), before any grant narrows it. */
export const DERIVED_TEXT_MAX_BYTES = 800;
/** The station's control-line ceiling (#162 runner.CONTROL_LINE_LIMIT). */
const LINE_LIMIT = 64 * 1024;
export const ELECTION_ID = /^[0-9a-f]{32}$/u;
/** The capability probe's election: all zeros, which no authority's token_hex(16) issues. */
const PROBE_ELECTION = "0".repeat(32);
/** RFC-0001 §4.3 scopes, narrowest first. */
const SCOPES = ["host", "lan", "fleet", "public"];

/** A station's control socket: one request, one answer. */
export interface StationControl {
  request(
    message: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>>;
}

/** The station gave no answer frond-ear could read: unreachable, silent, or garbled. */
export class NoAnswer extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "NoAnswer";
  }
}

/**
 * A station's Unix control socket, as #162's runner serves it: each request on its own
 * connection, one JSON line out and one JSON object line back. Anything else (no socket,
 * a close before the newline, a line over 64 KiB or not a JSON object, `timeoutMs` of
 * silence) is `NoAnswer`.
 */
export function unixStationControl(
  path: string,
  timeoutMs = 5_000,
): StationControl {
  return {
    request: (message) =>
      new Promise((resolve, reject) => {
        const socket = connect(path);
        let buffer = Buffer.alloc(0);
        let done = false;
        const finish = (outcome: NoAnswer | Record<string, unknown>) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          socket.destroy();
          if (outcome instanceof NoAnswer) reject(outcome);
          else resolve(outcome);
        };
        const timer = setTimeout(
          () => finish(new NoAnswer(`no answer within ${timeoutMs} ms`)),
          timeoutMs,
        );
        socket.on("connect", () => {
          socket.write(`${JSON.stringify(message)}\n`);
        });
        socket.on("data", (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);
          const newline = buffer.indexOf(0x0a);
          // Bytes, as the station's own line ceiling counts them.
          if ((newline === -1 ? buffer.length : newline) > LINE_LIMIT) {
            finish(new NoAnswer("its answer was over 64 KiB"));
            return;
          }
          if (newline === -1) return;
          let value: unknown;
          try {
            value = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
          } catch {
            finish(new NoAnswer("its answer wasn't JSON"));
            return;
          }
          finish(
            typeof value === "object" && value !== null && !Array.isArray(value)
              ? (value as Record<string, unknown>)
              : new NoAnswer("its answer wasn't a JSON object"),
          );
        });
        socket.on("end", () => {
          finish(
            new NoAnswer(
              buffer.length === 0
                ? "it closed without answering"
                : "its answer had no newline",
            ),
          );
        });
        socket.on("error", (error) => {
          finish(new NoAnswer(error.message));
        });
      }),
  };
}

/** #162's publish request: these three fields and no other. */
export function publishRequest(
  capsule: Uint8Array,
  text: string,
): { op: "derived_publish"; capsule_b64: string; text: string } {
  return {
    op: "derived_publish",
    capsule_b64: Buffer.from(capsule).toString("base64"),
    text,
  };
}

/** #162's query request: no send, refresh or retry. */
export function queryRequest(electionId: string): {
  op: "derived_query";
  election_id: string;
} {
  return { op: "derived_query", election_id: electionId };
}

/** Why the station said no, in its own words, bounded. */
export function stationWords(answer: Record<string, unknown>): string {
  return typeof answer.error === "string" && answer.error !== ""
    ? answer.error.slice(0, 200)
    : "it answered without saying why";
}

export const noAnswer = (error: unknown) =>
  `no answer from the station (${error instanceof Error ? error.message : String(error)})`;

export type DerivedCapability =
  | { derived: true }
  | { derived: false; reason: string };

/**
 * Whether the station's control socket offers the derived op: a `derived_query` for an
 * election no authority issues, answered `station_claim_missing`. No effect either way.
 */
export async function derivedCapability(
  control: StationControl,
): Promise<DerivedCapability> {
  let answer: Record<string, unknown>;
  try {
    answer = await control.request(queryRequest(PROBE_ELECTION));
  } catch (error) {
    return { derived: false, reason: noAnswer(error) };
  }
  return answer.ok === true || answer.error === "station_claim_missing"
    ? { derived: true }
    : { derived: false, reason: stationWords(answer) };
}

/** One source of a derived publication: which record, its digest, and its lineage. */
export interface DerivedSource extends ExposureLineage {
  /** `key:epoch:stream:seq`. */
  identity: string;
  /** SHA-256 of the payload the session heard whole. */
  digest: string;
  station: string;
  stream: string;
  keyId: string;
  epoch: number;
  seq: string;
}

/** What frond-ear hands the owner's issuer, to bind into the capsule. */
export interface DerivedLineage {
  ear: string;
  /** Who publishes: the session holding the ear, which heard every source. */
  author: { ear: string; sessionId: string };
  /** The widest the publication may reach: the narrowest scope among its sources. */
  audience: { scope: string };
  /** In the order the caller named them. */
  sources: DerivedSource[];
  payloadSha256: string;
}

/** A capsule the owner's authority issued for one election, and that election. */
export interface IssuedCapsule {
  capsule: Uint8Array;
  electionId: string;
}

/**
 * The owner's authority (binary-canticle#162's ReplyProposal, or what replaces it): elects
 * and claims, then returns the capsule. It throws to refuse, with its reason.
 */
export interface DerivedIssuer {
  issue(lineage: DerivedLineage, text: string): Promise<IssuedCapsule>;
}

/** The owner's route for derived publication: an issuer and a station's control socket. */
export interface DerivedRoute {
  control: StationControl;
  issuer: DerivedIssuer;
}

/** How a derived publication went: closed before any effect, or what the station said. */
export type DerivedOutcome =
  | { state: "closed"; reason: string }
  | { state: "refused"; electionId: string | null; reason: string }
  | { state: "unknown"; electionId: string; reason: string }
  | {
      state: "accepted";
      electionId: string;
      acceptance: Record<string, unknown>;
    };

/**
 * The station's acceptance receipt, taken only when it names this election and this
 * payload (#162's receipt carries both); otherwise why it isn't one.
 */
export function receiptFor(
  acceptance: unknown,
  electionId: string,
  payloadSha256: string,
): { receipt: Record<string, unknown> } | { why: string } {
  if (
    typeof acceptance !== "object" ||
    acceptance === null ||
    Array.isArray(acceptance)
  ) {
    return { why: "the station said ok without its receipt" };
  }
  const receipt = acceptance as Record<string, unknown>;
  return receipt.election_id === electionId &&
    receipt.payload_sha256 === payloadSha256
    ? { receipt }
    : { why: "the station's receipt names another election or payload" };
}

/** SHA-256 of the elected text, as #162's receipt names it. */
export const payloadDigest = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** Whether `text` is within #162's bound: 1 to 800 UTF-8 bytes. */
export function derivedTextFits(text: string): boolean {
  const bytes = Buffer.byteLength(text, "utf8");
  return bytes > 0 && bytes <= DERIVED_TEXT_MAX_BYTES;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The lineage of a publication from `sources`, each read from its custody `records` (the
 * best exposure per record), or why there is none: custody kept no lineage or digest for a
 * source, or a scope frond-ear doesn't know.
 */
export function derivedLineage(
  ear: string,
  sessionId: string,
  sources: readonly string[],
  records: readonly CanticleCustody[],
  text: string,
): { lineage: DerivedLineage } | { blocked: string } {
  const byIdentity = new Map(
    records.map((record) => [record.identity, record]),
  );
  const named = [...new Set(sources)].map((identity) =>
    byIdentity.get(identity),
  );
  const missing = named.filter(
    (record) =>
      record === undefined || record.lineage === null || record.digest === null,
  ).length;
  if (missing > 0) {
    return {
      blocked: `custody kept no lineage (scope, class, hop) for ${plural(missing, "source record")}`,
    };
  }
  const held = named as CanticleCustody[];
  const ranks = held.map((record) => SCOPES.indexOf(record.lineage!.scope));
  if (ranks.some((rank) => rank === -1)) {
    return { blocked: "a source's scope is not one frond-ear knows" };
  }
  return {
    lineage: {
      ear,
      author: { ear, sessionId },
      audience: { scope: SCOPES[Math.min(...ranks)]! },
      sources: held.map((record) => ({
        identity: record.identity,
        digest: record.digest!,
        station: record.station,
        stream: record.stream,
        keyId: record.keyId,
        epoch: record.epoch,
        seq: record.seq,
        ...record.lineage!,
      })),
      payloadSha256: payloadDigest(text),
    },
  };
}
