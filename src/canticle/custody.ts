// Custody of what canticle exposed to a session (binary-canticle#161 item 4).
//
// A push counter is not acknowledgement. Each exposure of a record to an ear's session is
// kept in three steps, the way letters settle: claimed (deduplicated and handed to the
// session's connection), offered (the host, the shim or Copilot extension, says it handed
// the event to the session) and echoed (the session named the push's batch_id in a tool
// call). `hear` returning a payload is an exposure offered and echoed at once, at its
// return. Every step is stamped with the session's compaction boundary as its pressure hook
// last reported it (#98), and compaction is the history cut: a record echoed before the
// current boundary, or by another session, was exposed but is no longer in context.
//
// This module only reads custody: what each record's state is now, the `history` flag
// over a window, and the closed-by-default seam a derived-publication path would ask.

import type { CanticleCustody, CompactionBoundary } from "../store.ts";
import { iso } from "./hear.ts";

/** Where a record stands with the session holding the ear, from its best exposure. */
export type CustodyState =
  /** Offered and echoed within the current boundary of the session holding the ear. */
  | "echoed"
  /** Echoed, but a boundary then or now is unknown, so whether it is in context is too. */
  | "echoed_boundary_unknown"
  /** Echoed before the current boundary, or by another session: no longer in context. */
  | "echoed_before_boundary"
  /** The host handed it to the session; the session never echoed it. */
  | "offered"
  /** Handed to the session's connection; the host never confirmed it reached the session. */
  | "claimed";

const STATES: readonly CustodyState[] = [
  "echoed",
  "echoed_boundary_unknown",
  "echoed_before_boundary",
  "offered",
  "claimed",
];
const RANK: Readonly<Record<CustodyState, number>> = {
  echoed: 4,
  echoed_boundary_unknown: 3,
  echoed_before_boundary: 2,
  offered: 1,
  claimed: 0,
};

export type History = "complete" | "incomplete" | "unknown";

/** What custody is judged against: the session holding the ear now, and its boundary. */
export interface CustodyNow {
  /** The session holding the ear (its id as frond-ear knows it, or null); undefined: none. */
  session: { id: string | null } | undefined;
  /** That session's compaction boundary now; undefined when no reading of it is kept. */
  boundary: CompactionBoundary;
  /** The kept pressure reading's idle-compaction forecast (#98), or null. */
  idleCompactDueAt: number | null;
  now: number;
}

/** One record in a window: its best exposure and the state that exposure gives it. */
export interface CustodyRecord {
  state: CustodyState;
  /** The exposure that gives it `state` (the latest of equals). */
  exposure: CanticleCustody;
  exposures: number;
  /** Whether an exposure within the current boundary showed its payload whole. */
  heardWhole: boolean;
}

export interface CustodyView {
  history: History;
  reasons: string[];
  counts: Record<"records" | CamelState, number>;
  records: CustodyRecord[];
}

type CamelState =
  | "echoed"
  | "echoedBoundaryUnknown"
  | "echoedBeforeBoundary"
  | "offered"
  | "claimed";

const camel = (state: CustodyState): CamelState =>
  state.replace(/_([a-z])/gu, (_, c: string) => c.toUpperCase()) as CamelState;

/** One exposure's state, judged against the session and boundary now. */
export function placeExposure(
  exposure: CanticleCustody,
  current: CustodyNow,
): CustodyState {
  if (exposure.echoedAt === null) {
    return exposure.offeredAt === null ? "claimed" : "offered";
  }
  const session = current.session?.id ?? null;
  const { offerSession, echoSession } = exposure;
  if (
    offerSession !== null &&
    echoSession !== null &&
    offerSession !== echoSession
  ) {
    // Shown to one session, echoed by another: the echo vouches for nothing.
    return "echoed_before_boundary";
  }
  if (session === null || offerSession === null || echoSession === null) {
    // Without every id frond-ear can't tell this session's echo from another's.
    return "echoed_boundary_unknown";
  }
  if (echoSession !== session) {
    return "echoed_before_boundary";
  }
  const { offerBoundary, echoBoundary } = exposure;
  if (
    offerBoundary === undefined ||
    echoBoundary === undefined ||
    current.boundary === undefined
  ) {
    return "echoed_boundary_unknown";
  }
  // Offered under one boundary and echoed under a later one: the text was shown before
  // the compaction, and only its id is known to have outlasted it.
  return offerBoundary === current.boundary && echoBoundary === current.boundary
    ? "echoed"
    : "echoed_before_boundary";
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Custody over a window: each record's state, and `history`. `history` is `complete` only
 * when every record exposed in the window was offered and echoed within the current
 * boundary of the session holding the ear; `incomplete` when one is known not to be
 * (claimed but never offered, offered but never echoed, or echoed before the boundary);
 * `unknown` when frond-ear can't tell (no session, no boundary reading from it, an idle
 * compaction due since the last reading, custody missing for part of the window, or an
 * echo under a boundary it doesn't know).
 */
export function custodyView(
  rows: readonly CanticleCustody[],
  current: CustodyNow,
  missing: readonly string[] = [],
): CustodyView {
  const byRecord = new Map<string, CanticleCustody[]>();
  for (const row of rows) {
    const list = byRecord.get(row.identity) ?? [];
    list.push(row);
    byRecord.set(row.identity, list);
  }
  const records: CustodyRecord[] = [];
  for (const exposures of byRecord.values()) {
    let best: { state: CustodyState; exposure: CanticleCustody } | undefined;
    let heardWhole = false;
    for (const exposure of exposures) {
      const state = placeExposure(exposure, current);
      if (state === "echoed" && exposure.shown === "whole") heardWhole = true;
      if (best === undefined || RANK[state] >= RANK[best.state]) {
        best = { state, exposure };
      }
    }
    records.push({ ...best!, exposures: exposures.length, heardWhole });
  }
  const counts = Object.fromEntries([
    ["records", records.length],
    ...STATES.map((state) => [
      camel(state),
      records.filter((record) => record.state === state).length,
    ]),
  ]) as CustodyView["counts"];

  const unknown: string[] = [...missing];
  if (current.session === undefined) {
    unknown.push("no session holds the ear");
  } else if (current.boundary === undefined) {
    unknown.push(
      "no compaction boundary from this session's pressure hook yet (frond-ear pressure --hook --ear)",
    );
  } else if (
    current.idleCompactDueAt !== null &&
    current.now >= current.idleCompactDueAt
  ) {
    unknown.push(
      `an idle compaction was due at ${iso(current.idleCompactDueAt)} and no pressure reading has come since`,
    );
  }
  const gaps = [
    ...(counts.claimed > 0
      ? [
          `${plural(counts.claimed, "record")} pushed, never confirmed handed to the session`,
        ]
      : []),
    ...(counts.offered > 0
      ? [`${plural(counts.offered, "record")} offered, never echoed`]
      : []),
    ...(counts.echoedBeforeBoundary > 0
      ? [
          `${plural(counts.echoedBeforeBoundary, "record")} echoed before the current compaction boundary or by another session`,
        ]
      : []),
  ];
  const unplaced =
    counts.echoedBoundaryUnknown > 0
      ? [
          `${plural(counts.echoedBoundaryUnknown, "record")} echoed under a boundary frond-ear doesn't know`,
        ]
      : [];
  const history: History =
    unknown.length > 0
      ? "unknown"
      : gaps.length > 0
        ? "incomplete"
        : unplaced.length > 0
          ? "unknown"
          : "complete";
  return {
    history,
    reasons: [...unknown, ...gaps, ...unplaced],
    counts,
    records,
  };
}

/** What a derived-publication path may do with heard records. */
export type PublicationDecision =
  | { open: false; reason: string }
  | { open: true; op: "derived"; sources: string[] };

/**
 * The seam a derived-publication path calls before publishing anything derived from heard
 * records (binary-canticle#161; the station's derived op is binary-canticle#162). It is
 * closed unless `enabled` (config `canticle.derivedPublication`, off by default) and every
 * source record was heard whole and echoed within the current boundary of the session
 * holding the ear. It only decides: it makes no station call, and an open answer names
 * the derived op, never the `sing` route, so heard content is never sung back as heard.
 */
export function derivedPublication(
  enabled: boolean,
  sources: readonly string[],
  view: CustodyView,
): PublicationDecision {
  const blocks: string[] = [];
  if (sources.length === 0) {
    blocks.push("no source records named");
  } else if (view.history !== "complete") {
    blocks.push(`history ${view.history}: ${view.reasons.join("; ")}`);
  } else {
    const partial = view.records.filter((record) => !record.heardWhole);
    if (partial.length > 0) {
      blocks.push(
        `${plural(partial.length, "source record")} never heard whole within the current boundary (cut to fit, counts only, or no text)`,
      );
    }
  }
  if (!enabled) {
    blocks.unshift(
      "derived publication is off (config canticle.derivedPublication)",
    );
  }
  return blocks.length > 0
    ? { open: false, reason: `closed: ${blocks.join("; ")}` }
    : { open: true, op: "derived", sources: [...sources] };
}

/** How a record is named in custody output: never its text, never a signer secret. */
export function custodyEntry(record: CustodyRecord): object {
  const { exposure } = record;
  const boundary = (value: CompactionBoundary) =>
    value === undefined ? "unknown" : value;
  return {
    station: exposure.station,
    stream: exposure.stream,
    item: `${exposure.epoch}/${exposure.seq}`,
    key: exposure.keyId,
    state: record.state,
    path: exposure.path,
    mode: exposure.mode,
    shown: exposure.shown,
    digest: exposure.digest,
    exposures: record.exposures,
    // The session it was shown to (or, before the host confirmed it, pushed to).
    session: (exposure.offerSession ?? exposure.sessionId)?.slice(0, 8) ?? null,
    claimedAt: exposure.claimedAt,
    offeredAt: exposure.offeredAt,
    offerBoundary:
      exposure.offeredAt === null ? null : boundary(exposure.offerBoundary),
    echoedAt: exposure.echoedAt,
    echo: exposure.echoKind,
    // Echoed by naming a later push of the same session, as a later Discord batch does.
    ...(exposure.echoBatch !== null && exposure.echoBatch !== exposure.batchId
      ? { echoedThrough: "a later push" }
      : {}),
    echoBoundary:
      exposure.echoedAt === null ? null : boundary(exposure.echoBoundary),
  };
}
