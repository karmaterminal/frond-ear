// A record v1 consumer (RFC-0001 §14.18.2–§14.18.4): frond-ear as a *binding* that
// reads a host daemon's records instead of running its own listener
// (`canticle.source: "host-daemon"`; binary-canticle#65, §23.2 question 23 (b)).
//
// Transport-agnostic: feed it lines. It keeps the live set the `hear` tool renders,
// applying the binding's fail-closed rules:
// - an unknown major `v` stops delivery (receive health `failed`, `record_version`);
// - an unknown `type` within v1 is counted and ignored;
// - a missing or mistyped required field drops the record (`malformed_record`);
//   `stream`, `class` and `hop` may be null where the frame doesn't carry them, but
//   a surfaced item must have all three;
// - a `rec_seq` gap marks receive health `degraded`, `records_lost`, and clears the
//   live set, since the gap may have held a `retract` (a reconnect loses records too);
// - nothing from a run is delivered before that run's first `landing_state`;
// - only `frame` records with `admission: verified` and `disposition: surface` are
//   deliverable, and never once past `local_expiry_at`;
// - `retract` removes; an active `mute` withdraws everything;
// - `fatal`, or a run that ends without `bye`, marks receive health `failed` until
//   the next run's `hello` (the restart §14.18.2 expects);
// - a record with a new `run` ends the old one: its live items, presence and datagram
//   clock are dropped, so nothing from it can surface under the new run;
// - `bye` ends the run cleanly: its items stop being deliverable and `hear` says so.
// Over the host socket each connection opens with a two-record bootstrap, the run's
// `hello` and its latest `landing_state` with their original `rec_seq` (§14.18.3
// "Joining a run", binary-canticle#69): see `reconnected()`. Other transports (one
// reader per run, no bootstrap) never call it and take the ordinary rules throughout.
// A connection that asked (`reconnected({ joinSnapshot: true })`) may then carry a join
// snapshot (§14.18.3 "Join snapshot", D36, binary-canticle#81): `snapshot` records in
// their own sequence domain, held until `snapshot_end` and applied all at once
// (complete: replaces the local view; truncated: merge only). Every bootstrap on the
// host socket reports `joined_late` until a complete snapshot or a new run.
// Every map here has a fixed bound (§14.18.2 "nothing in the pipe is unbounded").
// Framing: at most 64 KiB per line and nesting depth 8 (§14.18.2 [PROPOSED DEFAULT]).
// Status outlives a reconnect (frond-ear#59): `hello` clears receive health, so `counts`
// (the process's life) counts every health reason each time it is raised, and
// `lastFailure` keeps the latest connection's first failure. `snapshotFrames` counts
// this connection's join snapshot; `counts.snapshot_frames` adds them up.

import type { HearView, LiveItem } from "./receptor.ts";
import { MAX_CLAMP_TTL_S } from "./wire.ts";

export const RECORD_V = "canticle-receptor-record/1";
export const MAX_LINE_BYTES = 64 * 1024;
export const MAX_DEPTH = 8;
/** Bounds on what a record stream can grow (§14.18.2). */
export const MAX_LIVE = 4_096;
export const MAX_STATIONS = 256;
/** The join-snapshot entry cap (§14.18.3 "Join snapshot", [PROPOSED DEFAULT]). */
export const MAX_SNAPSHOT_ENTRIES = 511;
/** …and of entry bytes; an entry is measured as its JSON, which is never above its line. */
export const MAX_SNAPSHOT_BYTES = 1024 * 1024;
/** The join-snapshot request line (§14.18.3 "Join snapshot", opt-in). */
export const JOIN_SNAPSHOT_REQUEST = `${JSON.stringify({
  op: "join_snapshot",
  v: RECORD_V,
})}\n`;
const MAX_REASONS = 16;
/** No item outlives the longest class TTL plus clock skew, whatever the record claims. */
const MAX_LOCAL_LIFE_MS = MAX_CLAMP_TTL_S * 1_000 + 60_000;

/** §10.9 admission results; any other value is counted under `other`. */
const ADMISSIONS = new Set([
  "verified",
  "duplicate",
  "capability_exceeded",
  "scope_violation",
  "hop_limit",
  "over_quota",
  "pluck_mismatch",
  "plucked",
  "superseded",
  "class_change",
  "equivocation",
]);
const BREAKER = new Set(["closed", "open", "half_open"]);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

interface LiveRecord {
  idem: string;
  run: string;
  item: LiveItem;
  localExpiryAt: number;
  /**
   * Held from an earlier connection to this run and not yet confirmed by this one's
   * join snapshot: kept (a truncated snapshot may omit it, and only a `retract`
   * removes it then) but not rendered, since a `retract` may have been missed.
   */
  carried?: boolean;
}

/** A join-snapshot entry, parsed and held until `snapshot_end`. */
type SnapshotEntry =
  | { kind: "frame"; live: LiveRecord }
  | { kind: "presence"; name: string; state: string }
  | { kind: "skip" };

/**
 * Where this connection is with its join snapshot. `not_asked`: no request sent (or a
 * transport without a bootstrap). `unsupported`: asked, but `hello` doesn't offer it.
 * `pending`: asked and offered, nothing yet. `open`: entries arriving. `complete` /
 * `truncated`: `snapshot_end` applied.
 */
export type JoinSnapshotState =
  | "not_asked"
  | "unsupported"
  | "pending"
  | "open"
  | "complete"
  | "truncated";

export type ReceiveHealth =
  | "starting"
  | "ok"
  | "degraded"
  | "failed"
  | "stopped";

/** Nesting depth of a JSON text, counted outside strings; stops early past `limit`. */
export function jsonDepth(text: string, limit = MAX_DEPTH + 1): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") {
      depth++;
      if (depth > max) {
        max = depth;
        if (max > limit) return max;
      }
    } else if (c === "}" || c === "]") depth--;
  }
  return max;
}

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v);
const str = (v: unknown): v is string => typeof v === "string";
const intOrNull = (v: unknown) => v === null || int(v);
const strOrNull = (v: unknown) => v === null || str(v);
/** A sender-chosen reason, bounded to a short token before it is kept. */
const reasonToken = (v: unknown) =>
  str(v) && /^[a-z0-9_]{1,40}$/u.test(v) ? v : "other";

/** §14.11 lineage root from a record, as `key:epoch:stream:seq`; undefined if absent. */
function rootOf(lineage: Json | undefined): string | undefined {
  if (!isObj(lineage)) return undefined;
  const r = lineage.root;
  if (str(r)) return r;
  if (
    isObj(r) &&
    str(r.key_id) &&
    int(r.epoch) &&
    (int(r.stream_id) || str(r.stream_id)) &&
    (int(r.seq) || str(r.seq))
  ) {
    const stream = int(r.stream_id)
      ? r.stream_id.toString(16).padStart(8, "0")
      : r.stream_id;
    return `${r.key_id.slice(0, 16)}:${r.epoch}:${stream}:${r.seq}`;
  }
  return undefined;
}

/** The failure `lastFailure` keeps: its reason, when, and the run the binding held. */
export interface FailureRecord {
  reason: string;
  at: number;
  run: string | null;
}

export class RecordConsumer {
  health: ReceiveHealth = "starting";
  healthReasons: string[] = [];
  /**
   * Counters for the binding's own status over the process's life: malformed records,
   * unknown types, and each health reason every time it is raised (frond-ear#59).
   */
  readonly counts: Record<string, number> = {};
  /**
   * The first failure of the latest connection that failed (frond-ear#59). A later
   * failure on that connection, such as the close after a `fatal`, is its consequence
   * and doesn't replace it. `hello` clears receive health, never this.
   */
  lastFailure: FailureRecord | null = null;
  /** This connection (or run) has failed already. */
  #failedHere = false;
  /** A line arrived since the last close: a close that follows none reports nothing. */
  #receiving = false;
  run: string | undefined;
  #lastSeq: number | undefined;
  /**
   * Where this connection is in §14.18.3 "Joining a run". `stream`: no per-connection
   * bootstrap (a transport that never calls `reconnected()`). `hello` / `landing`: the
   * two bootstrap records are due. `join`: the next record is the first live one.
   * `live`: ordinary rules. `lost`: a malformed bootstrap; nothing more is read from
   * this connection, and the transport closes it (`connectionLost`).
   */
  #conn: "stream" | "hello" | "landing" | "join" | "live" | "lost" = "stream";
  #helloSeq = 0;
  /** This connection rejoins a run the binding already held records from. */
  #rejoin = false;
  #landingSeen = false;
  #byeSeen = false;
  /** This connection asked for a join snapshot (its first line). */
  #snapAsked = false;
  snapshotState: JoinSnapshotState = "not_asked";
  /** The snapshot's watermark *W*, once its first record (or `snapshot_end`) arrives. */
  #snapW: number | undefined;
  /** Entries held until `snapshot_end`; never more than the cap. */
  #snapHeld: SnapshotEntry[] = [];
  #snapBytes = 0;
  /** A truncated snapshot's `omitted`, for status and `hear`. */
  snapshotOmitted: number | undefined;
  /** How many frames this connection's join snapshot applied, once it has (frond-ear#59). */
  snapshotFrames: number | undefined;
  mute: { until: number | null; by: string | null } | null = null;
  lastDatagramAt: number | undefined;
  noDatagrams = false;
  readonly presence = new Map<string, string>();
  readonly #live = new Map<string, LiveRecord>();

  #count(name: string, n = 1): void {
    this.counts[name] = (this.counts[name] ?? 0) + n;
  }

  /** One line from the transport. Never throws. */
  feedLine(line: string, nowMs: number): void {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      this.dropLine("line_too_long", nowMs);
      return;
    }
    if (line.trim() === "") return;
    if (jsonDepth(line) > MAX_DEPTH) {
      this.dropLine("depth_exceeded", nowMs);
      return;
    }
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      this.dropLine("malformed_record", nowMs);
      return;
    }
    this.feed(rec, nowMs);
  }

  /** A line the transport couldn't read as a record. In a bootstrap it loses the connection. */
  dropLine(reason: string, nowMs: number): void {
    this.#receiving = true;
    this.#count(reason);
    if (this.#conn === "hello" || this.#conn === "landing")
      this.#badBootstrap(nowMs);
    // A line lost mid-snapshot is an entry lost: the snapshot can't be applied.
    else if (this.snapshotState === "open") this.#badSnapshot(nowMs);
  }

  /** The bootstrap or the join snapshot was malformed: the transport must drop this connection. */
  get connectionLost(): boolean {
    return this.#conn === "lost";
  }

  feed(rec: unknown, nowMs: number): void {
    if (
      this.health === "failed" &&
      this.healthReasons.includes("record_version")
    ) {
      return; // delivery stopped for good on an unknown major version
    }
    this.#receiving = true;
    if (this.#conn === "lost") return;
    if (
      !isObj(rec) ||
      !str(rec.v) ||
      !str(rec.type) ||
      !int(rec.rec_seq) ||
      !str(rec.run)
    ) {
      this.dropLine("malformed_record", nowMs);
      return;
    }
    if (rec.v !== RECORD_V) {
      if (rec.v.startsWith("canticle-receptor-record/")) {
        this.#fail("record_version", nowMs);
        this.#live.clear();
      } else this.dropLine("malformed_record", nowMs);
      return;
    }
    if (this.#conn === "hello" || this.#conn === "landing") {
      this.#bootstrap(
        rec as Obj & { type: string; rec_seq: number; run: string },
        nowMs,
      );
      return;
    }
    if (rec.type === "snapshot" || rec.type === "snapshot_end") {
      this.#snapshotRecord(
        rec as Obj & { type: string; rec_seq: number; run: string },
        nowMs,
      );
      return;
    }
    if (this.snapshotState === "open") {
      // Live records above W queue behind the snapshot (§14.18.3 "The cut"): one
      // between its entries means the snapshot is not what the daemon cut.
      this.#badSnapshot(nowMs, "snapshot_interrupted");
      return;
    }
    if (this.#conn === "join") {
      this.#conn = "live";
      if (rec.run === this.run) {
        // §14.18.3 step 2: the first live record is above the baseline, and the
        // skip to it is never itself a gap. Loss depends only on the join kind: a
        // first join loses nothing; a rejoin is `records_lost` exactly once, even
        // when the first live record directly follows the baseline (records emitted
        // while away, a retract among them, are not replayed).
        if (rec.rec_seq <= this.#lastSeq!) {
          this.#count("rec_seq_regression");
          this.#conn = "join";
          return;
        }
        // The rejoin's loss keeps what was carried: a join snapshot may still
        // confirm it, and without one it was dropped at `hello` already.
        if (this.#rejoin) this.#lose(false);
        this.#lastSeq = rec.rec_seq - 1; // the join itself is not a gap
      }
    }
    if (rec.run !== this.run) this.#beginRun(rec.run);
    if (this.#lastSeq !== undefined && rec.rec_seq !== this.#lastSeq + 1) {
      if (rec.rec_seq <= this.#lastSeq) {
        this.#count("rec_seq_regression");
        return;
      }
      this.#lose();
    }
    this.#lastSeq = rec.rec_seq;
    switch (rec.type) {
      case "hello":
        // A new run's readiness receipt: a failed or degraded receive recovers
        // (the restart §14.18.2 expects), except an unknown major version.
        this.health = "ok";
        this.healthReasons = [];
        return;
      case "landing_state":
        if (!this.#landing(rec)) this.#count("malformed_record");
        return;
      case "frame":
        this.#frame(rec, nowMs);
        return;
      case "retract":
        if (!str(rec.idem)) {
          this.#count("malformed_record");
          return;
        }
        this.#live.delete(rec.idem);
        return;
      case "presence":
        {
          const name = isObj(rec.station) ? rec.station.name : rec.station;
          if (!str(name) || !str(rec.state)) {
            this.#count("malformed_record");
          } else this.#setPresence(name, rec.state);
        }
        return;
      case "health":
        if (int(rec.last_datagram_at))
          this.lastDatagramAt = rec.last_datagram_at;
        this.noDatagrams =
          Array.isArray(rec.reasons) && rec.reasons.includes("no_datagrams");
        return;
      case "fatal":
        // The reason is the sender's: it counts as `fatal`, never as a key of its own.
        this.#fail(reasonToken(rec.reason), nowMs, "fatal");
        return;
      case "bye":
        // A clean end: the run's items stop being deliverable now, not at local
        // expiry, since no retract for them can follow from this run.
        this.#byeSeen = true;
        this.health = "stopped";
        this.#live.clear();
        this.#landingSeen = false;
        return;
      default:
        this.#count("unknown_type");
    }
  }

  /**
   * §14.18.3 step 1, bootstrap validation: `hello`, then a `landing_state` of the
   * same run with a higher `rec_seq`. Neither is checked against the gap or
   * regression rules; the landing state replaces the run's, and its `rec_seq` is
   * this connection's baseline. Anything else is `malformed_record`: the connection
   * is lost.
   */
  #bootstrap(
    rec: Obj & { type: string; rec_seq: number; run: string },
    nowMs: number,
  ): void {
    if (this.#conn === "hello") {
      if (rec.type !== "hello")
        return this.#badBootstrap(nowMs, "bootstrap_not_hello");
      // A rejoin only if the binding already held records from this run.
      this.#rejoin = rec.run === this.run;
      if (!this.#rejoin) this.#beginRun(rec.run);
      if (this.#snapAsked)
        this.snapshotState =
          rec.join_snapshot === true ? "pending" : "unsupported";
      // What an earlier connection carried survives only for a snapshot to confirm
      // (or, if truncated, to leave alone); with none coming, a missed `retract`
      // could keep it forever, so it goes now, as before D36.
      if (this.snapshotState !== "pending") this.#live.clear();
      this.#helloSeq = rec.rec_seq;
      this.health = "ok";
      this.healthReasons = [];
      // §14.18.3 "Join snapshot": every bootstrap joins a run in progress, however
      // early it looks (the baseline is the *latest* landing_state, not the first).
      // Only a complete snapshot on this connection, or a new run, clears it.
      this.#degrade("joined_late");
      this.#conn = "landing";
      return;
    }
    if (rec.type !== "landing_state")
      return this.#badBootstrap(nowMs, "bootstrap_not_landing_state");
    if (rec.run !== this.run)
      return this.#badBootstrap(nowMs, "bootstrap_run_mismatch");
    if (rec.rec_seq <= this.#helloSeq)
      return this.#badBootstrap(nowMs, "bootstrap_seq_order");
    if (!this.#landing(rec))
      return this.#badBootstrap(nowMs, "bootstrap_landing_state_fields");
    this.#lastSeq = rec.rec_seq;
    this.#conn = "join";
  }

  /**
   * §14.18.3 "Join snapshot", validation and application. `snapshot` records come
   * only after the bootstrap, on a connection that asked, before one `snapshot_end`;
   * `snap_seq` runs 1, 2, 3 … without a skip; every one carries the same `rec_seq`
   * *W* ≥ the baseline and the last live `rec_seq` read; `snapshot_end` repeats *W*
   * and counts them. Anything else is `malformed_record` and loses the connection.
   * None of them is checked against the gap or regression rules.
   */
  #snapshotRecord(
    rec: Obj & { type: string; rec_seq: number; run: string },
    nowMs: number,
  ): void {
    if (this.#conn === "stream") {
      // No connection, so nobody asked: count it, and nothing more.
      this.#count("malformed_record");
      this.#count("snapshot_unsolicited");
      return;
    }
    if (!this.#snapAsked)
      return this.#badSnapshot(nowMs, "snapshot_unsolicited");
    if (this.#conn !== "join" && this.#conn !== "live")
      return this.#badSnapshot(nowMs, "snapshot_before_bootstrap");
    if (this.snapshotState === "complete" || this.snapshotState === "truncated")
      return this.#badSnapshot(nowMs, "snapshot_after_end");
    if (rec.run !== this.run)
      return this.#badSnapshot(nowMs, "snapshot_run_mismatch");
    if (this.#snapW === undefined) {
      if (rec.rec_seq < this.#lastSeq!)
        return this.#badSnapshot(nowMs, "snapshot_watermark_behind");
      this.#snapW = rec.rec_seq;
    } else if (rec.rec_seq !== this.#snapW) {
      return this.#badSnapshot(nowMs, "snapshot_watermark_changed");
    }
    if (this.#conn === "join") {
      // §14.18.3 step 2 for a snapshot that comes first: the step from the baseline
      // is a join, never a gap; a rejoin still reports its loss once.
      this.#conn = "live";
      if (this.#rejoin) this.#lose(false);
    }
    if (rec.type === "snapshot") {
      this.snapshotState = "open";
      if (rec.snap_seq !== this.#snapHeld.length + 1)
        return this.#badSnapshot(nowMs, "snapshot_seq");
      this.#snapBytes += Buffer.byteLength(JSON.stringify(rec.entry ?? null));
      if (
        this.#snapHeld.length >= MAX_SNAPSHOT_ENTRIES ||
        this.#snapBytes > MAX_SNAPSHOT_BYTES
      )
        return this.#badSnapshot(nowMs, "snapshot_over_cap");
      const entry = this.#snapshotEntry(rec, nowMs);
      if (entry === undefined)
        return this.#badSnapshot(nowMs, "snapshot_entry");
      this.#snapHeld.push(entry);
      return;
    }
    // snapshot_end
    if (
      rec.watermark !== this.#snapW ||
      rec.count !== this.#snapHeld.length ||
      typeof rec.truncated !== "boolean" ||
      (rec.truncated && !(int(rec.omitted) && rec.omitted >= 0))
    )
      return this.#badSnapshot(nowMs, "snapshot_end_mismatch");
    this.#applySnapshot(rec.truncated, nowMs);
    this.snapshotOmitted = rec.truncated ? (rec.omitted as number) : undefined;
    this.#lastSeq = this.#snapW; // ordinary rules from W + 1
    if (!rec.truncated) this.#clearReason("joined_late");
  }

  /**
   * One `snapshot` record's `entry`: the fields of the item's latest deliverable
   * `frame` record (without `v`, `type`, `rec_seq` and `run`), or a station's current
   * presence as a `presence` record carries it. Accepted flat in `entry` (told apart by
   * `idem` / `state`) or wrapped one level as `{frame: …}` / `{presence: …}`.
   * Undefined when malformed; `skip` when well-formed but not deliverable now.
   */
  #snapshotEntry(rec: Obj, nowMs: number): SnapshotEntry | undefined {
    const e = rec.entry;
    if (!isObj(e)) return undefined;
    let fields: Obj | undefined;
    let kind: "frame" | "presence" | undefined;
    if (isObj(e.presence)) [kind, fields] = ["presence", e.presence];
    else if (isObj(e.frame) && str(e.frame.idem))
      [kind, fields] = ["frame", e.frame];
    else if (str(e.idem)) [kind, fields] = ["frame", e];
    else if (str(e.state)) [kind, fields] = ["presence", e];
    if (kind === undefined || fields === undefined) return undefined;
    if (kind === "presence") {
      const name = isObj(fields.station) ? fields.station.name : fields.station;
      if (!str(name) || !str(fields.state)) return undefined;
      return { kind: "presence", name, state: fields.state };
    }
    // The same deliverability check as a live `frame` record (§14.18.4).
    const parsed = this.#parseFrame(fields, nowMs);
    if (parsed === "malformed") return undefined;
    if (parsed === undefined) return { kind: "skip" };
    return { kind: "frame", live: parsed };
  }

  /**
   * `snapshot_end` arrived: apply the held entries at once. Complete: the run's
   * presence table and surfaced set become the snapshot's, so an item absent from it
   * leaves the local view (that is all absence does: no `retract`, nothing settled).
   * Truncated: merge only; absence means nothing, and what was carried stays, until a
   * `retract`. Snapshot frames count toward nothing (§14.6 rate, budget, salience) and
   * wake nothing, like `dedup: resurfaced`: this binding keeps no such quantity and
   * `hear` is pull-only, so holding them in the live set is all delivery is here.
   */
  #applySnapshot(truncated: boolean, nowMs: number): void {
    const held = this.#snapHeld;
    this.#snapHeld = [];
    this.#snapBytes = 0;
    this.snapshotState = truncated ? "truncated" : "complete";
    if (!truncated) {
      this.#live.clear();
      this.presence.clear();
    }
    let frames = 0;
    for (const entry of held) {
      if (entry.kind === "frame") {
        frames++;
        this.#hold(entry.live, nowMs);
      } else if (entry.kind === "presence")
        this.#setPresence(entry.name, entry.state);
    }
    this.snapshotFrames = frames;
    if (frames > 0) this.#count("snapshot_frames", frames);
    // Truncated: what the snapshot left out stays held, and is shown again.
    for (const r of this.#live.values()) delete r.carried;
  }

  /** The snapshot can't be trusted: discard it and lose the connection. */
  #badSnapshot(nowMs: number, reason?: string): void {
    if (reason !== undefined) {
      this.#count("malformed_record");
      this.#count(reason);
    }
    this.#snapHeld = [];
    this.#snapBytes = 0;
    this.#conn = "lost";
    this.#landingSeen = false;
    this.#fail("malformed_snapshot", nowMs);
  }

  /** `reason`: what the bootstrap record got wrong (unset: the line was already counted). */
  #badBootstrap(nowMs: number, reason?: string): void {
    if (reason !== undefined) {
      this.#count("malformed_record");
      this.#count(reason);
    }
    this.#conn = "lost";
    this.#live.clear();
    this.#landingSeen = false;
    this.#fail("malformed_bootstrap", nowMs);
  }

  /** A `landing_state`'s fields; false (nothing applied) when malformed. */
  #landing(rec: Obj): boolean {
    // A mistyped mute must not read as "not muted": drop it, keep the last one.
    const mute = rec.mute;
    const muteOk =
      mute === null ||
      (isObj(mute) && intOrNull(mute.until) && strOrNull(mute.by));
    if (
      !("mute" in rec) ||
      !muteOk ||
      !str(rec.breaker) ||
      !BREAKER.has(rec.breaker)
    )
      return false;
    this.#landingSeen = true;
    this.mute = isObj(mute)
      ? { until: mute.until as number | null, by: mute.by as string | null }
      : null;
    return true;
  }

  /** A new receptor run: the previous one ended without `bye` unless we saw it. */
  #beginRun(run: string): void {
    if (this.run !== undefined && !this.#byeSeen)
      this.#degrade("run_restarted_without_bye");
    this.#endRun();
    this.run = run;
    this.#lastSeq = undefined;
    this.#byeSeen = false;
    this.#failedHere = false;
  }

  /**
   * Records were lost: the gap may have held a retract, so nothing heard before it
   * stays. A rejoin's loss (`clear` false) leaves what was carried to the join
   * snapshot, which already hides it until it is confirmed.
   */
  #lose(clear = true): void {
    this.#degrade("records_lost");
    if (clear) this.#live.clear();
  }

  #setPresence(name: string, state: string): void {
    if (!this.presence.has(name) && this.presence.size >= MAX_STATIONS)
      this.#count("presence_overflow");
    else this.presence.set(name, state);
  }

  #frame(rec: Obj, nowMs: number): void {
    const parsed = this.#parseFrame(rec, nowMs);
    if (parsed === "malformed") this.#count("malformed_record");
    else if (parsed !== undefined) this.#hold(parsed, nowMs);
  }

  /** Put a deliverable record in the live set, within its bound. */
  #hold(r: LiveRecord, nowMs: number): void {
    if (!this.#live.has(r.idem) && this.#live.size >= MAX_LIVE) {
      this.#prune(nowMs);
      if (this.#live.size >= MAX_LIVE) {
        this.#count("live_overflow");
        return;
      }
    }
    this.#live.set(r.idem, r);
  }

  /**
   * A `frame` record's fields, checked as §14.18.3–§14.18.4 require: `malformed`, or
   * undefined (counted) when well-formed but not deliverable, or the live record.
   * Live records and join-snapshot entries both come through here.
   */
  #parseFrame(rec: Obj, nowMs: number): LiveRecord | "malformed" | undefined {
    const f = rec.frame;
    const times = rec.times;
    const station = rec.station;
    if (
      !isObj(f) ||
      !isObj(times) ||
      !isObj(station) ||
      !str(rec.idem) ||
      !str(rec.admission) ||
      !str(rec.disposition) ||
      !str(station.name) ||
      !(station.principal === null || str(station.principal)) ||
      !str(f.key_id) ||
      !int(f.epoch) ||
      !(int(f.stream_id) || str(f.stream_id)) ||
      !(int(f.seq) || (str(f.seq) && /^\d{1,20}$/u.test(f.seq))) ||
      !(f.kind === "item" || f.kind === "pluck") ||
      !strOrNull(f.sha256) ||
      !intOrNull(f.bytes) ||
      !(rec.dedup === "first" || rec.dedup === "resurfaced") ||
      !isObj(rec.versions) ||
      // Null where the frame doesn't carry the field (§14.18.3, binary-canticle#79):
      // `stream` for an id with no known name, `class` for an unknown code or a
      // PLUCK, `hop` for a PLUCK. Present either way; a wrong type is malformed.
      !strOrNull(rec.stream) ||
      !strOrNull(rec.class) ||
      !str(rec.scope) ||
      !intOrNull(rec.hop)
    ) {
      return "malformed";
    }
    // The receipt pointers (`frame.sha256`, `frame.bytes`) exist exactly when the
    // frame was admitted: a frame refused before the ring has none (§14.18.3,
    // binary-canticle#79). A verified frame without them is malformed; a refusal
    // that carries them anyway is tolerated, and nothing here reads them.
    if (rec.admission === "verified" && (!str(f.sha256) || !int(f.bytes))) {
      return "malformed";
    }
    if (
      rec.admission !== "verified" ||
      rec.disposition !== "surface" ||
      f.kind !== "item"
    ) {
      const admission = ADMISSIONS.has(rec.admission) ? rec.admission : "other";
      this.#count(`not_deliverable_${admission}`);
      return undefined; // reaches at most the local ring and status (§14.18.4)
    }
    // A surfaced item always names its stream and class and carries a hop: the
    // receptor keeps an unnamed stream or unknown class at `ringbuffer_only`. A
    // `surface` record without them contradicts its own disposition; drop it
    // rather than render a null.
    if (!str(rec.stream) || !str(rec.class) || !int(rec.hop)) {
      return "malformed";
    }
    if (!int(times.local_expiry_at) || times.local_expiry_at <= nowMs) {
      this.#count("expired_on_arrival");
      return undefined; // never delivered without, or past, local_expiry_at
    }
    if (!int(times.issued_at) || !int(times.expires_at)) {
      return "malformed";
    }
    const body = isObj(rec.body) ? rec.body : undefined;
    const text = body && str(body.text) ? body.text : undefined;
    const ref = isObj(rec.body_ref) ? rec.body_ref : undefined;
    const item: LiveItem = {
      station: station.name,
      key: f.key_id,
      stream: rec.stream,
      seq: String(f.seq),
      epoch: f.epoch,
      class: rec.class,
      scope: rec.scope,
      hop: rec.hop,
      purpose: str(rec.purpose) ? rec.purpose : undefined,
      issuedAt: times.issued_at,
      heardAt: int(times.heard_at) ? times.heard_at : nowMs,
      expiresAt: times.expires_at,
      bodyBytes:
        text === undefined && body && int(body.size) ? body.size : undefined,
      stateKey: str(rec.state_key) ? rec.state_key : undefined,
      principal: str(station.principal) ? station.principal : undefined,
      root: rootOf(rec.lineage),
      text,
      ctype:
        body && (str(body.ctype) || int(body.ctype))
          ? body.ctype
          : text !== undefined
            ? 1
            : undefined,
      bodyRef:
        ref && str(ref.url) && str(ref.sha256)
          ? { url: ref.url, sha256: ref.sha256, size: String(ref.size ?? "?") }
          : undefined,
      ageMs: int(times.age_ms)
        ? times.age_ms
        : Math.max(0, nowMs - times.issued_at),
      expiresInMs: times.local_expiry_at - nowMs,
      copies: 1,
    };
    return {
      idem: rec.idem,
      run: this.run!,
      item,
      localExpiryAt: Math.min(times.local_expiry_at, nowMs + MAX_LOCAL_LIFE_MS),
    };
  }

  /**
   * Drop everything the previous run vouched for. A new run can't retract what the
   * last one heard, so its items, presence and datagram clock end with it; anything
   * still live comes back only through the new run's own frames (`dedup: resurfaced`),
   * after its `landing_state`. The last mute stays until that `landing_state` replaces
   * it (status only: nothing is delivered before it anyway).
   */
  #endRun(): void {
    this.#live.clear();
    this.#landingSeen = false;
    this.presence.clear();
    this.lastDatagramAt = undefined;
    this.noDatagrams = false;
  }

  #prune(nowMs: number): void {
    for (const [idem, r] of this.#live) {
      if (r.localExpiryAt <= nowMs) this.#live.delete(idem);
    }
  }

  #degrade(reason: string): void {
    if (this.health !== "failed") this.health = "degraded";
    this.#reason(reason);
    this.#count(reason);
  }

  /** `counter`: the count to raise, when `reason` is the sender's (a `fatal`'s). */
  #fail(reason: string, nowMs: number, counter = reason): void {
    this.health = "failed";
    this.#reason(reason);
    this.#count(counter);
    if (!this.#failedHere)
      this.lastFailure = { reason, at: nowMs, run: this.run ?? null };
    this.#failedHere = true;
  }

  /** One reason no longer holds; a degraded receive with none left is ok again. */
  #clearReason(reason: string): void {
    this.healthReasons = this.healthReasons.filter((r) => r !== reason);
    if (this.health === "degraded" && this.healthReasons.length === 0)
      this.health = "ok";
  }

  /** Receive health says `joined_late` (§14.18.3 "Join snapshot"). */
  get joinedLate(): boolean {
    return this.healthReasons.includes("joined_late");
  }

  #reason(reason: string): void {
    if (this.healthReasons.includes(reason)) return;
    if (this.healthReasons.length >= MAX_REASONS) this.healthReasons.shift();
    this.healthReasons.push(reason);
  }

  /** The transport closed: a run that ended without `bye` is a failed receive. */
  closed(nowMs: number): void {
    // An interrupted snapshot is never authoritative: nothing held is applied.
    this.#snapHeld = [];
    this.#snapBytes = 0;
    // A reconnect attempt that never opened, or carried nothing, ends no run: a
    // crash counts once, however many attempts the restart takes.
    if (!this.#receiving) return;
    this.#receiving = false;
    if (!this.#byeSeen && this.run !== undefined)
      this.#fail("exit_without_bye", nowMs);
  }

  /**
   * A connection to the host daemon opened (every one, the first included). It
   * starts with §14.18.3's bootstrap: `hello`, then the run's latest `landing_state`.
   * Records between connections are lost, so a retract or a mute may have been
   * missed: nothing held so far is shown again unless this connection's join snapshot
   * confirms it (or, truncated, leaves it alone), and nothing is delivered before this
   * connection's `landing_state`. `joinSnapshot`: the transport sent the
   * `join_snapshot` request as this connection's first line.
   */
  reconnected(options: { joinSnapshot?: boolean } = {}): void {
    for (const r of this.#live.values()) r.carried = true;
    this.#landingSeen = false;
    this.#conn = "hello";
    this.#failedHere = false;
    this.#snapAsked = options.joinSnapshot === true;
    this.snapshotState = "not_asked";
    this.snapshotOmitted = undefined;
    this.snapshotFrames = undefined;
    this.#snapW = undefined;
    this.#snapHeld = [];
    this.#snapBytes = 0;
  }

  /** What one ear hears now, through its `station:stream` tune. */
  hearView(
    patterns: readonly string[],
    nowMs: number,
    listening: boolean,
  ): HearView {
    const tuned = (station: string, stream: string) =>
      patterns.some((p) => {
        const at = p.indexOf(":");
        const s = p.slice(0, at);
        return (s === "*" || s === station) && p.slice(at + 1) === stream;
      });
    const live = this.health !== "failed" && this.health !== "stopped";
    const deliverable =
      listening && live && this.#landingSeen && this.mute === null;
    const items: LiveItem[] = [];
    for (const [idem, r] of this.#live) {
      if (r.localExpiryAt <= nowMs) {
        this.#live.delete(idem);
        continue;
      }
      if (r.carried || !deliverable || !tuned(r.item.station, r.item.stream))
        continue;
      items.push({
        ...r.item,
        expiresInMs: r.localExpiryAt - nowMs,
        ageMs: Math.max(r.item.ageMs, nowMs - r.item.issuedAt),
      });
    }
    const blind =
      !listening || this.noDatagrams || this.lastDatagramAt === undefined;
    return {
      now: nowMs,
      tuned: patterns.length > 0,
      listening: listening && live,
      ...(this.health === "stopped" ? { ended: true } : {}),
      blind,
      lastDatagramAt: this.lastDatagramAt,
      ...(this.joinedLate
        ? {
            joinedLate: {
              snapshot: this.snapshotState,
              ...(this.snapshotOmitted !== undefined
                ? { omitted: this.snapshotOmitted }
                : {}),
            },
          }
        : {}),
      stations: [...this.presence].map(([name, state]) => ({
        name,
        presence: blind ? "unknown" : state,
      })),
      items,
    };
  }
}
