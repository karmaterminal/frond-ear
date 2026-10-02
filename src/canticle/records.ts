// A record v1 consumer (RFC-0001 §14.18.2–§14.18.4): frond-ear as a *binding* that
// reads a host daemon's records instead of running its own listener
// (`canticle.source: "host-daemon"`; binary-canticle#65, §23.2 question 23 (b)).
//
// Transport-agnostic: feed it lines. It keeps the live set the `hear` tool renders,
// applying the binding's fail-closed rules:
// - an unknown major `v` stops delivery (receive health `failed`, `record_version`);
// - an unknown `type` within v1 is counted and ignored;
// - a missing or mistyped required field drops the record (`malformed_record`);
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
// Every map here has a fixed bound (§14.18.2 "nothing in the pipe is unbounded").
// Framing: at most 64 KiB per line and nesting depth 8 (§14.18.2 [PROPOSED DEFAULT]).

import type { HearView, LiveItem } from "./receptor.ts";
import { MAX_CLAMP_TTL_S } from "./wire.ts";

export const RECORD_V = "canticle-receptor-record/1";
export const MAX_LINE_BYTES = 64 * 1024;
export const MAX_DEPTH = 8;
/** Bounds on what a record stream can grow (§14.18.2). */
export const MAX_LIVE = 4_096;
export const MAX_STATIONS = 256;
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
}

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

export class RecordConsumer {
  health: ReceiveHealth = "starting";
  healthReasons: string[] = [];
  /** Counters for the binding's own status: malformed, unknown types, gaps, … */
  readonly counts: Record<string, number> = {};
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
  mute: { until: number | null; by: string | null } | null = null;
  lastDatagramAt: number | undefined;
  noDatagrams = false;
  readonly presence = new Map<string, string>();
  readonly #live = new Map<string, LiveRecord>();

  #count(name: string): void {
    this.counts[name] = (this.counts[name] ?? 0) + 1;
  }

  /** One line from the transport. Never throws. */
  feedLine(line: string, nowMs: number): void {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      this.dropLine("line_too_long");
      return;
    }
    if (line.trim() === "") return;
    if (jsonDepth(line) > MAX_DEPTH) {
      this.dropLine("depth_exceeded");
      return;
    }
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      this.dropLine("malformed_record");
      return;
    }
    this.feed(rec, nowMs);
  }

  /** A line the transport couldn't read as a record. In a bootstrap it loses the connection. */
  dropLine(reason: string): void {
    this.#count(reason);
    if (this.#conn === "hello" || this.#conn === "landing")
      this.#badBootstrap();
  }

  /** The bootstrap was malformed: the transport must drop this connection. */
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
    if (this.#conn === "lost") return;
    if (
      !isObj(rec) ||
      !str(rec.v) ||
      !str(rec.type) ||
      !int(rec.rec_seq) ||
      !str(rec.run)
    ) {
      this.dropLine("malformed_record");
      return;
    }
    if (rec.v !== RECORD_V) {
      if (rec.v.startsWith("canticle-receptor-record/")) {
        this.#fail("record_version");
        this.#live.clear();
      } else this.dropLine("malformed_record");
      return;
    }
    if (this.#conn === "hello" || this.#conn === "landing") {
      this.#bootstrap(
        rec as Obj & { type: string; rec_seq: number; run: string },
      );
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
        if (this.#rejoin) this.#lose();
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
          } else if (
            !this.presence.has(name) &&
            this.presence.size >= MAX_STATIONS
          ) {
            this.#count("presence_overflow");
          } else this.presence.set(name, rec.state);
        }
        return;
      case "health":
        if (int(rec.last_datagram_at))
          this.lastDatagramAt = rec.last_datagram_at;
        this.noDatagrams =
          Array.isArray(rec.reasons) && rec.reasons.includes("no_datagrams");
        return;
      case "fatal":
        this.#fail(reasonToken(rec.reason));
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
  #bootstrap(rec: Obj & { type: string; rec_seq: number; run: string }): void {
    if (this.#conn === "hello") {
      if (rec.type !== "hello")
        return this.#badBootstrap("bootstrap_not_hello");
      // A rejoin only if the binding already held records from this run.
      this.#rejoin = rec.run === this.run;
      if (!this.#rejoin) this.#beginRun(rec.run);
      this.#helloSeq = rec.rec_seq;
      this.health = "ok";
      this.healthReasons = [];
      this.#conn = "landing";
      return;
    }
    if (rec.type !== "landing_state")
      return this.#badBootstrap("bootstrap_not_landing_state");
    if (rec.run !== this.run)
      return this.#badBootstrap("bootstrap_run_mismatch");
    if (rec.rec_seq <= this.#helloSeq)
      return this.#badBootstrap("bootstrap_seq_order");
    if (!this.#landing(rec))
      return this.#badBootstrap("bootstrap_landing_state_fields");
    this.#lastSeq = rec.rec_seq;
    this.#conn = "join";
  }

  /** `reason`: what the bootstrap record got wrong (unset: the line was already counted). */
  #badBootstrap(reason?: string): void {
    if (reason !== undefined) {
      this.#count("malformed_record");
      this.#count(reason);
    }
    this.#conn = "lost";
    this.#live.clear();
    this.#landingSeen = false;
    this.#fail("malformed_bootstrap");
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
  }

  /** Records were lost: the gap may have held a retract, so nothing heard before it stays. */
  #lose(): void {
    this.#count("records_lost");
    this.#degrade("records_lost");
    this.#live.clear();
  }

  #frame(rec: Obj, nowMs: number): void {
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
      !str(f.sha256) ||
      !int(f.bytes) ||
      !(rec.dedup === "first" || rec.dedup === "resurfaced") ||
      !isObj(rec.versions) ||
      !str(rec.stream) ||
      !str(rec.class) ||
      !str(rec.scope) ||
      !int(rec.hop)
    ) {
      this.#count("malformed_record");
      return;
    }
    if (
      rec.admission !== "verified" ||
      rec.disposition !== "surface" ||
      f.kind !== "item"
    ) {
      const admission = ADMISSIONS.has(rec.admission) ? rec.admission : "other";
      this.#count(`not_deliverable_${admission}`);
      return; // reaches at most the local ring and status (§14.18.4)
    }
    if (!int(times.local_expiry_at) || times.local_expiry_at <= nowMs) {
      this.#count("expired_on_arrival");
      return; // never delivered without, or past, local_expiry_at
    }
    if (!int(times.issued_at) || !int(times.expires_at)) {
      this.#count("malformed_record");
      return;
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
    if (!this.#live.has(rec.idem) && this.#live.size >= MAX_LIVE) {
      this.#prune(nowMs);
      if (this.#live.size >= MAX_LIVE) {
        this.#count("live_overflow");
        return;
      }
    }
    this.#live.set(rec.idem, {
      idem: rec.idem,
      run: this.run!,
      item,
      localExpiryAt: Math.min(times.local_expiry_at, nowMs + MAX_LOCAL_LIFE_MS),
    });
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
  }

  #fail(reason: string): void {
    this.health = "failed";
    this.#reason(reason);
  }

  #reason(reason: string): void {
    if (this.healthReasons.includes(reason)) return;
    if (this.healthReasons.length >= MAX_REASONS) this.healthReasons.shift();
    this.healthReasons.push(reason);
  }

  /** The transport closed: a run that ended without `bye` is a failed receive. */
  closed(): void {
    if (!this.#byeSeen && this.run !== undefined)
      this.#fail("exit_without_bye");
  }

  /**
   * A connection to the host daemon opened (every one, the first included). It
   * starts with §14.18.3's bootstrap: `hello`, then the run's latest `landing_state`.
   * Records between connections are lost, so a retract or a mute may have been
   * missed: clear the live set and deliver nothing until this connection's
   * `landing_state`.
   */
  reconnected(): void {
    this.#live.clear();
    this.#landingSeen = false;
    this.#conn = "hello";
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
      if (!deliverable || !tuned(r.item.station, r.item.stream)) continue;
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
      stations: [...this.presence].map(([name, state]) => ({
        name,
        presence: blind ? "unknown" : state,
      })),
      items,
    };
  }
}
