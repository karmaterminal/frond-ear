// A record v1 consumer (RFC-0001 §14.18.2–§14.18.4): frond-ear as a *binding* that
// reads a host daemon's records instead of running its own listener
// (`canticle.source: "host-daemon"`; binary-canticle#65, §23.2 question 23 (b)).
//
// Transport-agnostic: feed it lines. It keeps the live set the `hear` tool renders,
// applying the binding's fail-closed rules:
// - an unknown major `v` stops delivery (receive health `failed`, `record_version`);
// - an unknown `type` within v1 is counted and ignored;
// - a missing or mistyped required field drops the record (`malformed_record`);
// - a `rec_seq` gap marks receive health `degraded`, `records_lost`;
// - nothing from a run is delivered before that run's first `landing_state`;
// - only `frame` records with `admission: verified` and `disposition: surface` are
//   deliverable, and never once past `local_expiry_at`;
// - `retract` removes; an active `mute` withdraws everything;
// - `fatal`, or a run that ends without `bye`, marks receive health `failed`.
// Framing: at most 64 KiB per line and nesting depth 8 (§14.18.2 [PROPOSED DEFAULT]).

import type { HearView, LiveItem } from "./receptor.ts";

export const RECORD_V = "canticle-receptor-record/1";
export const MAX_LINE_BYTES = 64 * 1024;
export const MAX_DEPTH = 8;

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

export class RecordConsumer {
  health: ReceiveHealth = "starting";
  healthReasons: string[] = [];
  /** Counters for the binding's own status: malformed, unknown types, gaps, … */
  readonly counts: Record<string, number> = {};
  run: string | undefined;
  #lastSeq: number | undefined;
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
      this.#count("line_too_long");
      return;
    }
    if (line.trim() === "") return;
    if (jsonDepth(line) > MAX_DEPTH) {
      this.#count("depth_exceeded");
      return;
    }
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      this.#count("malformed_record");
      return;
    }
    this.feed(rec, nowMs);
  }

  feed(rec: unknown, nowMs: number): void {
    if (
      this.health === "failed" &&
      this.healthReasons.includes("record_version")
    ) {
      return; // delivery stopped for good on an unknown major version
    }
    if (
      !isObj(rec) ||
      !str(rec.v) ||
      !str(rec.type) ||
      !int(rec.rec_seq) ||
      !str(rec.run)
    ) {
      this.#count("malformed_record");
      return;
    }
    if (rec.v !== RECORD_V) {
      if (rec.v.startsWith("canticle-receptor-record/")) {
        this.#fail("record_version");
        this.#live.clear();
      } else this.#count("malformed_record");
      return;
    }
    if (rec.run !== this.run) {
      // A new receptor run: the previous one ended without `bye` unless we saw it.
      if (this.run !== undefined && !this.#byeSeen)
        this.#degrade("run_restarted_without_bye");
      this.run = rec.run;
      this.#lastSeq = undefined;
      this.#landingSeen = false;
      this.#byeSeen = false;
    }
    if (this.#lastSeq !== undefined && rec.rec_seq !== this.#lastSeq + 1) {
      if (rec.rec_seq <= this.#lastSeq) {
        this.#count("rec_seq_regression");
        return;
      }
      this.#count("records_lost");
      this.#degrade("records_lost");
    }
    this.#lastSeq = rec.rec_seq;
    switch (rec.type) {
      case "hello":
        if (this.health === "starting" || this.health === "stopped")
          this.health = "ok";
        return;
      case "landing_state":
        this.#landingSeen = true;
        this.mute = isObj(rec.mute)
          ? {
              until: int(rec.mute.until) ? rec.mute.until : null,
              by: str(rec.mute.by) ? rec.mute.by : null,
            }
          : null;
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
        if (isObj(rec.station) && str(rec.station.name) && str(rec.state)) {
          this.presence.set(rec.station.name, rec.state);
        } else if (str(rec.station) && str(rec.state)) {
          this.presence.set(rec.station, rec.state);
        } else this.#count("malformed_record");
        return;
      case "health":
        if (int(rec.last_datagram_at))
          this.lastDatagramAt = rec.last_datagram_at;
        this.noDatagrams =
          Array.isArray(rec.reasons) && rec.reasons.includes("no_datagrams");
        return;
      case "fatal":
        this.#fail(str(rec.reason) ? rec.reason : "fatal");
        return;
      case "bye":
        this.#byeSeen = true;
        this.health = "stopped";
        return;
      default:
        this.#count("unknown_type");
    }
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
      !str(f.key_id) ||
      !int(f.epoch) ||
      !(int(f.seq) || str(f.seq)) ||
      !str(rec.stream) ||
      !str(rec.class) ||
      !str(rec.scope) ||
      !int(rec.hop)
    ) {
      this.#count("malformed_record");
      return;
    }
    if (rec.admission !== "verified" || rec.disposition !== "surface") {
      this.#count(`not_deliverable_${rec.admission}`);
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
    this.#live.set(rec.idem, {
      idem: rec.idem,
      run: this.run!,
      item,
      localExpiryAt: times.local_expiry_at,
    });
  }

  #degrade(reason: string): void {
    if (this.health !== "failed") this.health = "degraded";
    if (!this.healthReasons.includes(reason)) this.healthReasons.push(reason);
  }

  #fail(reason: string): void {
    this.health = "failed";
    if (!this.healthReasons.includes(reason)) this.healthReasons.push(reason);
  }

  /** The transport closed: a run that ended without `bye` is a failed receive. */
  closed(): void {
    if (!this.#byeSeen && this.run !== undefined)
      this.#fail("exit_without_bye");
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
    const deliverable =
      listening &&
      this.health !== "failed" &&
      this.#landingSeen &&
      this.mute === null;
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
      listening: listening && this.health !== "failed",
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
