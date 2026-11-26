// The exposure ledger (frond-ear#117): what canticle pushes exposed to an ear's session, kept
// as binary-canticle#162's `canticle-payload-exposure/1` records, for an issuer behind its own
// boundary to read later. frond-ear only records: it holds no key, signs nothing, and calls
// no issuer (🌫's constraint on #117).
//
// One record per canticle push that carries records, written from custody (custody.ts):
// - fenced: in the same transaction as the push's claim, before the push is handed to the
//   session's connection, so no crash can leave an exposure without its record;
// - offered: the host said it handed the push to the session (custody's offered);
// - echoed: the session named the push's whole batch_id (custody's echoed). The strongest
//   receipt, kept alongside the offered one, never in place of it;
// - unknown: a fence whose push never reached `offered` (no connection took it, or a revert
//   gave it back). A fence is never cleared, the same as #162's rule; it can only become
//   unknown, and only a confirmed (offered or echoed) record is ever evicted.
//
// Each source is one pushed record, in the order the push's text carries it, with the
// verified record's own provenance (never read back from rendered text), its scope exactly
// as heard (🌿's F1: passed through, never widened), and the hash of its exact rendered
// entry. The whole record hashes the pushed event text.
//
// How #162's `LocalReader` maps onto a continuing Claude Code session holding an ear:
// - `sessionKey`: `frond-ear:<ear>`. The ear is the continuing reader; #162's Reader admits
//   only sub-agent keys, so a continuing-session form is still to settle (#117, #161).
// - `sessionId`: the Claude Code session id holding the ear when the push was fenced (the
//   shim's CLAUDE_CODE_SESSION_ID or a hook's), or null when its shim gave none.
// - `lifecycleRevision`: `claude-session:<session id>` (`claude-session:unknown` without one).
//   It changes only when the context does: another session taking the ear, or /clear or a
//   fresh start (a new session id). A compaction, a resume or a shim that reattaches keeps it,
//   because the session keeps what it heard. It was the ear's attach generation until 11-25;
//   that made every reattach a new #162 reader generation with an empty ledger, which an
//   issuer could attest as an observed birth and so launder every earlier exposure.
// - Alongside, not in the reader: #114's holder identity then (`known`, `unknown`,
//   `in-doubt`). A record whose reader has no session id is kept, but `conformant` never
//   passes it off as a `PayloadExposure`.

import { createHash } from "node:crypto";

import type {
  LocalReader,
  PayloadExposure,
  PayloadSource,
  Tuple,
} from "./exposure-v1.ts";

export const EXPOSURE_VERSION = "canticle-payload-exposure/1";

/** #162's `Tuple`, except a record v1 `stream_id` that isn't a number is null, not made up. */
export type SourceTuple = Omit<Tuple, "stream_id"> & {
  stream_id: number | null;
};

/** #162's `sourceBody`, except a `ctype` record v1 left out is null, not made up. */
export type SourceBody = Omit<
  NonNullable<PayloadSource["sourceBody"]>,
  "ctype"
> & {
  ctype: NonNullable<PayloadSource["sourceBody"]>["ctype"] | null;
};

/**
 * #162's `PayloadSource` as frond-ear can fill it. `receiver` is null where frond-ear heard
 * the record itself (the embedded receptor has no record v1 run), a tuple's `stream_id` is
 * null where record v1 named the stream by something other than its number, and a body's
 * `ctype` is null where record v1 left it out.
 */
export type ExposureSource = Omit<
  PayloadSource,
  "item" | "root" | "receiver" | "sourceBody"
> & {
  item: SourceTuple;
  root: SourceTuple | null;
  sourceBody: SourceBody | null;
  receiver: PayloadSource["receiver"] | null;
};

/** What a heard record says of itself, before it is rendered: a source less its rendering. */
export type HeardProvenance = Omit<
  ExposureSource,
  "renderedSha256" | "renderedBytes"
>;

export type ExposureReader = Omit<LocalReader, "sessionId"> & {
  sessionId: string | null;
};

export type ExposureRecord = Omit<PayloadExposure, "reader" | "sources"> & {
  reader: ExposureReader;
  sources: readonly ExposureSource[];
};

export type ExposurePhase = "fenced" | "offered" | "echoed" | "unknown";
/** #114's holder identity when the push was fenced. */
export type HolderIdentity = "known" | "unknown" | "in-doubt";

/** What a push fences: its record, and the holder identity then. */
export interface ExposureFence {
  record: ExposureRecord;
  holder: HolderIdentity;
}

/** One record in the ledger, as the store keeps it and `frond-ear exposure` prints it. */
export interface ExposureEntry {
  pendingId: string;
  ear: string;
  batchId: number;
  phase: ExposurePhase;
  fencedAt: number;
  holder: HolderIdentity;
  /** The host's word that the push reached the session, and the session holding the ear then. */
  offered: { at: number; sessionId: string | null } | null;
  /** The session's own echo of the push's whole batch_id, and the tool that carried it. */
  echoed: { at: number; sessionId: string | null; by: string } | null;
  /** A fence whose push never reached `offered`: `unsent` (no connection took it) or `reverted`. */
  unknown: { at: number; reason: "unsent" | "reverted" } | null;
  record: ExposureRecord;
}

export interface ExposureCounts {
  records: number;
  fenced: number;
  offered: number;
  echoed: number;
  unknown: number;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A pushed record as a source: its provenance, and the hash of its exact rendered entry. */
export function exposureSource(
  provenance: HeardProvenance,
  rendered: string,
): ExposureSource {
  return {
    item: { ...provenance.item },
    idem: provenance.idem,
    root: provenance.root === null ? null : { ...provenance.root },
    hop: provenance.hop,
    class: provenance.class,
    scope: provenance.scope,
    lens: provenance.lens,
    station: provenance.station,
    principal: provenance.principal,
    stream: provenance.stream,
    stateKey: provenance.stateKey,
    flags: { ...provenance.flags },
    times: { ...provenance.times },
    sourceBody:
      provenance.sourceBody === null ? null : { ...provenance.sourceBody },
    bodyRef: provenance.bodyRef === null ? null : { ...provenance.bodyRef },
    renderedSha256: sha256(rendered),
    renderedBytes: Buffer.byteLength(rendered),
    receiver: provenance.receiver === null ? null : { ...provenance.receiver },
  };
}

/** The reader a push to `ear` is exposed to: see the mapping at the top of this file. */
export function exposureReader(
  ear: string,
  session: { generation: number; sessionId: string | null },
): ExposureReader {
  return {
    sessionKey: `frond-ear:${ear}`,
    sessionId: session.sessionId,
    lifecycleRevision: `claude-session:${session.sessionId ?? "unknown"}`,
  };
}

/**
 * The record for canticle push `batchId` to `ear`: its whole event text, and its sources in
 * the order that text carries them. `toolCallId` names the push by its bare id; the delivery
 * token the session's copy carries is the session's to echo and is never kept.
 */
export function exposureRecord(
  ear: string,
  batchId: number,
  reader: ExposureReader,
  content: string,
  sources: readonly ExposureSource[],
): ExposureRecord {
  return {
    version: EXPOSURE_VERSION,
    binding: `frond-ear:${ear}`,
    reader,
    toolCallId: `push:${batchId}`,
    resultSha256: sha256(content),
    resultBytes: Buffer.byteLength(content),
    sources,
  };
}

/** Keys in a fixed order at every depth, so one record always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The record's stable id (#162's `pendingId`): the same ear, push and record give the same
 * id, so fencing it again is one record, not two. At most 512 characters, as #162 requires.
 */
export function pendingIdOf(
  ear: string,
  batchId: number,
  record: ExposureRecord,
): string {
  return `frond-ear-exposure:${batchId}:${sha256(`${ear}\n${batchId}\n${canonical(record)}`).slice(0, 32)}`;
}

const tupleOf = (t: SourceTuple): Tuple | null =>
  t.stream_id === null ? null : { ...t, stream_id: t.stream_id };

/**
 * The record as #162's `PayloadExposure`, or null when frond-ear could not fill it whole: a
 * reader with no session id, a source frond-ear heard itself (no record v1 receiver), a
 * tuple whose stream had no number, or a body with no ctype (#162's own record reader
 * refuses such a body). Never fills a gap with a made-up value.
 */
export function conformant(record: ExposureRecord): PayloadExposure | null {
  const { sessionId } = record.reader;
  if (sessionId === null || sessionId === "") return null;
  const sources: PayloadSource[] = [];
  for (const source of record.sources) {
    const item = tupleOf(source.item);
    const root = source.root === null ? null : tupleOf(source.root);
    const body = source.sourceBody;
    if (
      item === null ||
      (source.root !== null && root === null) ||
      source.receiver === null ||
      (body !== null && body.ctype === null)
    ) {
      return null;
    }
    sources.push({
      ...source,
      item,
      root,
      sourceBody: body === null ? null : { ...body, ctype: body.ctype! },
      receiver: source.receiver,
    });
  }
  return {
    version: record.version,
    binding: record.binding,
    reader: { ...record.reader, sessionId },
    toolCallId: record.toolCallId,
    resultSha256: record.resultSha256,
    resultBytes: record.resultBytes,
    sources,
  };
}
