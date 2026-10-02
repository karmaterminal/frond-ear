// A listener: verify, dedup, pluck, supersede and track presence (RFC-0001 §7.4–§7.8, §8).
// A port of the spike's `canticle/listener.py` at binary-canticle `a15fb9f0d2` (#62),
// which bounds every per-key structure (#60).
//
// It surfaces events (a new item, a withdrawal, a supersession, an expiry, a
// presence change, evidence) and never actuates anything. Landing into a
// session (§14) is the ear's job, not this module's.
//
// Restart safety: the state that must survive a restart (epoch maxima, dedup
// digests with each ITEM's (expires_at, scope), sticky PLUCKs, supersession
// marks; §5.2, §7.4, §7.7, §7.8) round-trips through `snapshot()` / `restore`.
// The caller persists it whenever `dirty` is set. An item accepted before a
// restart is surfaced once more, through the same checks, when next heard.
//
// Bounds (§7.4, #60): dedup entries have a per-key share; supersession marks
// have their own per-key limit (they outlive dedup entries); stream hearing
// times are capped at the share; beacon maps hold one advertised catalog.
// Refusals never change state, and the epoch is adopted only on admission.

import { createHash } from "node:crypto";

import * as cbor from "./cbor.ts";
import {
  CLASSES,
  CLASS_BY_NAME,
  CTYPE_TEXT,
  SCOPES,
  SCOPE_NAMES,
} from "./ids.ts";
import { hex, type Manifest } from "./manifest.ts";
import {
  FLAG_REFRESH,
  KIND_BEACON,
  KIND_ITEM,
  KIND_PLUCK,
  Reject,
  localExpiryMs,
  parse,
  type Frame,
  type Item,
  type StreamEntry,
} from "./wire.ts";

export const SKEW_MS = 5_000;
const OFFSET_SAMPLES = 16;
const LIVE_STATE = CLASS_BY_NAME.get("live-state")!.code;

export type EventKind =
  | "item"
  | "withdrawn"
  | "superseded"
  | "expired"
  | "presence"
  | "evidence";

export interface ListenerEvent {
  event: EventKind;
  station: string;
  keyId: string;
  stream?: string | undefined;
  seq?: bigint | undefined;
  data: Record<string, unknown>;
}

interface Heard {
  item: Item;
  ident: string;
  kid: string;
  localExpiry: number;
  firstHeard: number;
  lastHeard: number;
  copies: number;
}

interface StationState {
  epochHwm: number;
  epochSeenAt: number;
  bseq: bigint;
  lastBeacon: number | undefined;
  periodMs: number;
  signedOff: boolean;
  offsets: number[];
  /** stream_id → advertised loop_ms (rebuilt from `catalogPages`). */
  streamLoops: Map<number, number>;
  /** stream_id → last admitted copy, oldest first; capped at the key's share (#60). */
  lastStreamItem: Map<number, number>;
  /** Nothing reported yet. */
  presence: string;
  /** First beacon heard since this listener started (warm-up, §7.8). */
  firstBeaconAt: number | undefined;
  /** stream_id → advertised loop_max_ms (rebuilt from `catalogPages`). */
  streamLoopMax: Map<number, number>;
  /** stream_id → latest beacon entry (rebuilt from `catalogPages`). */
  streamEntries: Map<number, StreamEntry>;
  /** page index → (bseq heard at, that page's entries): one catalog, at most 8 pages (§8.4). */
  catalogPages: Map<number, { bseq: bigint; streams: StreamEntry[] }>;
}

function newStation(): StationState {
  return {
    epochHwm: 0,
    epochSeenAt: 0,
    bseq: 0n,
    lastBeacon: undefined,
    periodMs: 0,
    signedOff: false,
    offsets: [],
    streamLoops: new Map(),
    lastStreamItem: new Map(),
    presence: "",
    firstBeaconAt: undefined,
    streamLoopMax: new Map(),
    streamEntries: new Map(),
    catalogPages: new Map(),
  };
}

const offsetMs = (st: StationState | undefined) =>
  st && st.offsets.length > 0 ? Math.min(...st.offsets) : 0;

/** (key_id, epoch, stream, seq) as a map key. */
function identKey(
  kid: string,
  epoch: number,
  stream: number,
  seq: bigint,
): string {
  return `${kid}:${epoch}:${stream}:${seq}`;
}

const kidOf = (key: string) => key.slice(0, key.indexOf(":"));

/** (issued_at, epoch, seq) ordering for supersession (§7.7). */
type Order = [number, number, bigint];

function compareOrder(a: Order, b: Order): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return a[2] === b[2] ? 0 : a[2] < b[2] ? -1 : 1;
}

/**
 * Min-heap of (time, key) over one table whose entries expire. Purging pops
 * only what is due rather than scanning the table. Deletion is lazy: the
 * table is the truth, and a popped entry whose row has gone or moved later
 * is skipped.
 */
class Expiries {
  #heap: Array<[number, string]> = [];

  push(t: number, key: string): void {
    const h = this.#heap;
    h.push([t, key]);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p]![0] <= h[i]![0]) break;
      [h[p], h[i]] = [h[i]!, h[p]!];
      i = p;
    }
  }

  *due(nowMs: number): Generator<string> {
    const h = this.#heap;
    while (h.length > 0 && h[0]![0] <= nowMs) {
      const top = h[0]!;
      const last = h.pop()!;
      if (h.length > 0) {
        h[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < h.length && h[l]![0] < h[m]![0]) m = l;
          if (r < h.length && h[r]![0] < h[m]![0]) m = r;
          if (m === i) break;
          [h[m], h[i]] = [h[i]!, h[m]!];
          i = m;
        }
      }
      yield top[1];
    }
  }

  /** Rebuild from the live rows once stale entries outnumber them. */
  compact(live: number, rows: () => Iterable<[number, string]>): void {
    if (this.#heap.length > 2 * live + 1024) {
      this.#heap = [];
      for (const [t, k] of rows()) this.push(t, k);
    }
  }
}

interface DedupEntry {
  digest: string;
  retain: number;
  /** An ITEM's (expires_at, scope), which a later PLUCK must match (§9.7). */
  meta: [number, number] | undefined;
}

interface Held {
  ident: string;
  kid: string;
  item: Item;
  retain: number;
}

export interface ListenerOptions {
  /** Stream names to surface; undefined = every named stream. */
  tuned?: ReadonlySet<string>;
  dedupCapacity?: number;
  /** Fixed per-key dedup share; default an equal share of `dedupCapacity`. */
  perKeyQuota?: number;
  /** Fixed per-key mark limit; default derived from the key's granted classes. */
  perKeyMarkQuota?: number;
  /** Where frames reach this listener (§4.3, §10.9). */
  binding?: string;
  /** Hold live-state keys until warm-up completes (§7.8 rule 4). */
  warmup?: boolean;
  /**
   * Restart safety (§5.2, §7.4, §7.7, §7.8): either pass the last saved snapshot
   * (`null` on first run) and save `snapshot()` whenever `dirty` is set, or opt out
   * with `ephemeral: true` where restarts aren't under test.
   */
  restore?: SafetyState | null;
  ephemeral?: true;
}

/** 2: dedup rows carry the ITEM's (expires_at, scope) for the §9.7 PLUCK check. 1 still loads. */
export const SAFETY_STATE_VERSION = 2;

/** The state that must survive a restart, as JSON (bigints as decimal strings). */
export interface SafetyState {
  version: number;
  /** key-id → [epoch high-water mark, when it was first seen]. */
  epochs: Record<string, [number, number]>;
  /** [identity, sha256(frame) hex, retain_until, expires_at | null, scope | null]; v1 rows stop at retain. */
  dedup: Array<
    | [string, string, number]
    | [string, string, number, number | null, number | null]
  >;
  /** [target identity, retain_until]. */
  stickyPluck: Array<[string, number]>;
  /** [hkey, issued_at, epoch, seq, retain_until]. */
  hwm: Array<[string, number, number, string, number]>;
}

export class Listener {
  readonly manifest: Manifest;
  readonly tuned: ReadonlySet<string> | undefined;
  readonly dedupCapacity: number;
  readonly perKeyQuota: number | undefined;
  readonly perKeyMarkQuota: number | undefined;
  readonly binding: string;
  readonly warmup: boolean;
  readonly dedup = new Map<string, DedupEntry>();
  readonly dedupPerKey = new Map<string, number>();
  readonly stickyPluck = new Map<string, number>();
  /** `${kid}:${stream}:${stateKey}` → order + horizon. */
  readonly hwm = new Map<string, { order: Order; retain: number }>();
  readonly hwmPerKey = new Map<string, number>();
  readonly #dedupDue = new Expiries();
  readonly #stickyDue = new Expiries();
  readonly #hwmDue = new Expiries();
  /** identity → heard item (on air, from this listener's view). */
  readonly current = new Map<string, Heard>();
  readonly stations = new Map<string, StationState>();
  readonly held = new Map<string, Held>();
  readonly evidenceCounts = new Map<string, number>();
  /** Identities loaded from a snapshot that this process hasn't surfaced yet. */
  readonly #restored = new Set<string>();
  #dirty = false;
  #urgent = false;

  constructor(manifest: Manifest, options: ListenerOptions) {
    if (options.ephemeral !== true && options.restore === undefined) {
      throw new Error(
        "a listener needs persisted state for restart safety (§7.4–§7.8): pass restore (null on first run) or ephemeral: true",
      );
    }
    const binding = options.binding ?? "lan";
    if (!SCOPES.has(binding)) {
      throw new Error(`unknown binding ${JSON.stringify(binding)}`);
    }
    this.manifest = manifest;
    this.tuned = options.tuned;
    this.dedupCapacity = options.dedupCapacity ?? 100_000;
    this.perKeyQuota = options.perKeyQuota;
    this.perKeyMarkQuota = options.perKeyMarkQuota;
    this.binding = binding;
    this.warmup = options.warmup ?? true;
    if (options.restore) this.#load(options.restore);
  }

  // ------------------------------------------------------------ persisted safety state

  /** True when the safety state changed since the last `markSaved()`. */
  get dirty(): boolean {
    return this.#dirty;
  }

  /**
   * True when a change since the last `markSaved()` *raised* a safety guard that must
   * outlive a crash: an epoch advance, a sticky pluck mark, or a supersession mark set or
   * raised (§7.7, §7.8). Losing anything else to a crash costs at most a re-heard item
   * marked resurfaced, or a purge redone on the next tick, so it can wait for the
   * caller's periodic save.
   */
  get urgent(): boolean {
    return this.#urgent;
  }

  markSaved(): void {
    this.#dirty = false;
    this.#urgent = false;
  }

  snapshot(): SafetyState {
    const epochs: Record<string, [number, number]> = {};
    for (const [kid, st] of this.stations) {
      if (st.epochHwm) epochs[kid] = [st.epochHwm, st.epochSeenAt];
    }
    return {
      version: SAFETY_STATE_VERSION,
      epochs,
      dedup: [...this.dedup].map(([ident, v]) => [
        ident,
        v.digest,
        v.retain,
        v.meta?.[0] ?? null,
        v.meta?.[1] ?? null,
      ]),
      stickyPluck: [...this.stickyPluck],
      hwm: [...this.hwm].map(([hkey, v]) => [
        hkey,
        v.order[0],
        v.order[1],
        v.order[2].toString(),
        v.retain,
      ]),
    };
  }

  #load(state: SafetyState): void {
    if (state.version !== 1 && state.version !== SAFETY_STATE_VERSION) {
      throw new Error(
        `listener state: unsupported version ${String(state.version)}`,
      );
    }
    for (const [kid, [epoch, seenAt]] of Object.entries(state.epochs)) {
      const st = this.#st(kid);
      st.epochHwm = epoch;
      st.epochSeenAt = seenAt;
    }
    for (const row of state.dedup) {
      const [ident, digest, retain] = row;
      // v1 rows carry no (expires_at, scope): those targets skip the §9.7 PLUCK check.
      const meta: [number, number] | undefined =
        row.length >= 5 && row[3] != null && row[4] != null
          ? [row[3], row[4]]
          : undefined;
      this.dedup.set(ident, { digest, retain, meta });
      const kid = kidOf(ident);
      this.dedupPerKey.set(kid, (this.dedupPerKey.get(kid) ?? 0) + 1);
      this.#dedupDue.push(retain, ident);
      this.#restored.add(ident);
    }
    for (const [ident, retain] of state.stickyPluck) {
      this.stickyPluck.set(ident, retain);
      this.#stickyDue.push(retain, ident);
    }
    for (const [hkey, issuedAt, epoch, seq, retain] of state.hwm) {
      this.hwm.set(hkey, { order: [issuedAt, epoch, BigInt(seq)], retain });
      this.#hwmDue.push(retain, hkey);
      const kid = kidOf(hkey);
      this.hwmPerKey.set(kid, (this.hwmPerKey.get(kid) ?? 0) + 1);
    }
  }

  // ------------------------------------------------------------ helpers

  #name(kid: string): string {
    return this.manifest.entry(Buffer.from(kid, "hex"))?.name ?? kid;
  }

  #streamName(kid: string, sid: number): string | undefined {
    return this.manifest.entry(Buffer.from(kid, "hex"))?.streamNames.get(sid);
  }

  #evidence(
    reason: string,
    kid: string,
    detail = "",
    extra: Record<string, unknown> = {},
  ): ListenerEvent {
    this.evidenceCounts.set(reason, (this.evidenceCounts.get(reason) ?? 0) + 1);
    return {
      event: "evidence",
      station: kid ? this.#name(kid) : "?",
      keyId: kid,
      data: { reason, detail, ...extra },
    };
  }

  #st(kid: string): StationState {
    let st = this.stations.get(kid);
    if (st === undefined) {
      st = newStation();
      this.stations.set(kid, st);
    }
    return st;
  }

  // ------------------------------------------------------------ hearing

  /** Never throws: anything unexpected becomes `internal` evidence, so one datagram can't stop a receiver. */
  hear(datagram: Uint8Array, nowMs: number): ListenerEvent[] {
    try {
      return this.#hear(datagram, nowMs);
    } catch (e) {
      return [
        this.#evidence("internal", "", e instanceof Error ? e.name : typeof e),
      ];
    }
  }

  #hear(datagram: Uint8Array, nowMs: number): ListenerEvent[] {
    const kid = datagram.length >= 12 ? hex(datagram.subarray(4, 12)) : "";
    let f: Frame;
    try {
      f = parse(
        datagram,
        this.manifest.resolve,
        nowMs,
        offsetMs(this.stations.get(kid)),
      );
    } catch (e) {
      const r = e instanceof Reject ? e : new Reject("internal");
      const known =
        kid !== "" &&
        this.manifest.entry(Buffer.from(kid, "hex")) !== undefined;
      return [this.#evidence(r.reason, known ? kid : "", r.detail)];
    }
    return f.kind === KIND_BEACON
      ? this.#beacon(f, nowMs)
      : this.#itemOrPluck(f, nowMs);
  }

  #epochOk(
    kid: string,
    epoch: number,
    nowMs: number,
    events: ListenerEvent[],
    advance = true,
  ): boolean {
    const st = this.#st(kid);
    if (epoch < st.epochHwm) {
      events.push(
        this.#evidence("epoch-regression", kid, `${epoch} < ${st.epochHwm}`),
      );
      return false;
    }
    if (advance && epoch > st.epochHwm) {
      st.epochHwm = epoch;
      st.epochSeenAt = nowMs;
      this.#dirty = true;
      this.#urgent = true;
      // bseq, the advertised catalog and the per-stream hearing times belong to the previous
      // epoch (§9.8): a restarted station counts beacons from 1 again and may loop different streams.
      st.bseq = 0n;
      st.catalogPages.clear();
      st.streamLoops.clear();
      st.streamLoopMax.clear();
      st.streamEntries.clear();
      st.lastStreamItem.clear();
    }
    return true;
  }

  #beacon(
    f: Extract<Frame, { kind: typeof KIND_BEACON }>,
    nowMs: number,
  ): ListenerEvent[] {
    const b = f.body;
    const kid = hex(f.keyId);
    const events: ListenerEvent[] = [];
    if (!this.#epochOk(kid, b.epoch, nowMs, events)) return events;
    const st = this.#st(kid);
    if (
      b.epoch === st.epochHwm &&
      b.bseq <= st.bseq &&
      st.lastBeacon !== undefined
    ) {
      return events; // older or repeated beacon
    }
    st.bseq = b.bseq;
    st.offsets.push(nowMs - b.wallclock);
    if (st.offsets.length > OFFSET_SAMPLES) st.offsets.shift();
    st.lastBeacon = nowMs;
    st.signedOff = b.nextBeaconMs === 0;
    st.periodMs = b.nextBeaconMs || st.periodMs;
    st.firstBeaconAt ??= nowMs;
    // A beacon carries one page of the station's catalog (§8.4): it replaces that page and drops
    // pages past the advertised count. Rebuilding the stream maps from the pages bounds them by
    // what one catalog can advertise, however many beacons (or stream ids) a key sends (#60).
    const [index, count] = b.page ?? [0, 1];
    for (const p of [...st.catalogPages.keys()]) {
      if (p >= count) st.catalogPages.delete(p);
    }
    st.catalogPages.set(index, { bseq: b.bseq, streams: b.streams });
    st.streamLoops.clear();
    st.streamLoopMax.clear();
    st.streamEntries.clear();
    // bseq order, so the newest copy wins: §8.4 lets a changed stream ride the next beacon, whatever
    // its page. bseq only rises within an epoch, and an epoch advance clears the pages.
    const pages = [...st.catalogPages.values()].sort((x, y) =>
      x.bseq < y.bseq ? -1 : x.bseq > y.bseq ? 1 : 0,
    );
    for (const page of pages) {
      for (const e of page.streams) {
        st.streamLoops.set(e.streamId, e.loopMs);
        st.streamLoopMax.set(e.streamId, e.loopMaxMs);
        st.streamEntries.set(e.streamId, e);
      }
    }
    events.push(...this.#presence(kid, nowMs));
    return events;
  }

  #itemOrPluck(
    f: Exclude<Frame, { kind: typeof KIND_BEACON }>,
    nowMs: number,
  ): ListenerEvent[] {
    const events: ListenerEvent[] = [];
    const body = f.body;
    const kid = hex(f.keyId);
    // Authorise before touching any state: a rejected frame must leave epoch, dedup,
    // presence, sticky-pluck and high-water marks exactly as they were (§10.9).
    const entry = this.manifest.entry(f.keyId)!;
    const sname = this.#streamName(kid, body.stream);
    const at = { stream: sname, seq: body.seq };
    if (f.kind === KIND_ITEM && !entry.classes.has(f.body.cls)) {
      events.push(
        this.#evidence(
          "capability",
          kid,
          `class ${f.body.cls} not granted`,
          at,
        ),
      );
      return events;
    }
    if (body.scope < SCOPES.get(this.binding)!) {
      const scope = SCOPE_NAMES.get(body.scope) ?? body.scope;
      events.push(
        this.#evidence(
          "scope-violation",
          kid,
          `${scope} frame heard on a ${this.binding} binding`,
          at,
        ),
      );
      return events;
    }
    if (!entry.scopes.has(body.scope)) {
      const scope = SCOPE_NAMES.get(body.scope) ?? body.scope;
      events.push(
        this.#evidence(
          "scope-violation",
          kid,
          `scope ${scope} not granted`,
          at,
        ),
      );
      return events;
    }
    if (f.kind === KIND_ITEM) {
      const spec = CLASSES.get(f.body.cls);
      if (spec !== undefined && f.body.hop > spec.hopLimit) {
        events.push(
          this.#evidence(
            "hop-limit",
            kid,
            `hop ${f.body.hop} > ${spec.hopLimit} for ${spec.name}`,
            at,
          ),
        );
        return events;
      }
    }
    // Regression is checked now; a higher epoch is adopted only once the frame is admitted, so an
    // over-quota or mismatched frame cannot advance it (§10.9: refusals are state-neutral).
    if (!this.#epochOk(kid, body.epoch, nowMs, events, false)) return events;
    const ident = identKey(kid, body.epoch, body.stream, body.seq);
    const digest = createHash("sha256").update(f.raw).digest("hex");
    const seen = this.dedup.get(ident);
    const st = this.#st(kid);
    let resurface = false;
    let retain: number;
    if (seen !== undefined) {
      if (seen.digest !== digest) {
        events.push(
          this.#evidence(
            "equivocation",
            kid,
            `two frames for ${body.epoch}:${body.stream}:${body.seq}`,
            at,
          ),
        );
        return events;
      }
      const h = this.current.get(ident);
      if (h !== undefined) {
        h.copies += 1;
        h.lastHeard = nowMs;
      }
      if (!this.#restored.has(ident)) {
        this.#heardOn(st, body.stream, nowMs);
        return events; // a repeat is a benign no-op (§7.4)
      }
      // Accepted before a restart: its dedup, pluck and supersession state was kept, but this
      // process hasn't surfaced it yet. Surface it once, through the same checks.
      if (this.#needsMark(f) && !this.#markRoom(kid, nowMs)) {
        events.push(this.#markRefusal(kid, at));
        return events;
      }
      this.#heardOn(st, body.stream, nowMs);
      this.#restored.delete(ident);
      resurface = true;
      retain = seen.retain;
    } else {
      if (f.kind === KIND_PLUCK) {
        // §9.7: a PLUCK carries its target's expires_at and scope. Checkable while the target's
        // dedup entry is held; a PLUCK for a target never heard is still recorded (§7.7).
        const p = f.body;
        const target = this.dedup.get(
          identKey(kid, p.epoch, p.stream, p.targetSeq),
        );
        if (
          target?.meta !== undefined &&
          (target.meta[0] !== p.expiresAt || target.meta[1] !== p.scope)
        ) {
          events.push(
            this.#evidence(
              "pluck-mismatch",
              kid,
              "expires_at or scope differs from the target's (§9.7)",
              at,
            ),
          );
          return events;
        }
      }
      if (!this.#roomFor(kid, nowMs)) {
        events.push(
          this.#evidence(
            "over-quota",
            kid,
            "per-key dedup quota full; live entries kept",
            at,
          ),
        );
        return events;
      }
      if (this.#needsMark(f) && !this.#markRoom(kid, nowMs)) {
        events.push(this.#markRefusal(kid, at));
        return events;
      }
      this.#epochOk(kid, body.epoch, nowMs, events);
      retain = localExpiryMs(f, offsetMs(st), nowMs) + SKEW_MS;
      this.#remember(
        ident,
        kid,
        digest,
        retain,
        f.kind === KIND_ITEM ? [f.body.expiresAt, f.body.scope] : undefined,
      );
      this.#heardOn(st, body.stream, nowMs);
    }
    if (f.kind === KIND_PLUCK) {
      if (resurface) return events; // its sticky mark was kept across the restart
      const p = f.body;
      const target = identKey(kid, p.epoch, p.stream, p.targetSeq);
      this.stickyPluck.set(target, retain);
      this.#stickyDue.push(retain, target);
      this.#dirty = true;
      this.#urgent = true;
      for (const [k, h] of this.held) {
        if (h.ident === target) this.held.delete(k);
      }
      if (this.current.delete(target)) {
        events.push({
          event: "withdrawn",
          station: this.#name(kid),
          keyId: kid,
          stream: sname,
          seq: p.targetSeq,
          data: { by_seq: p.seq, reason: p.reason ?? null },
        });
      }
      return events;
    }
    const it = f.body;
    // A keyed item that arrives after its own PLUCK still superseded what came before it at the
    // station (§7.8, whatever the arrival order), so it moves the mark before it is dropped.
    const spec = CLASSES.get(it.cls);
    const plucked = this.stickyPluck.has(ident);
    if (plucked && (it.stateKey === undefined || spec === undefined)) {
      events.push(
        this.#evidence("plucked", kid, "item arrived after its pluck", at),
      );
      return events;
    }
    if (spec === undefined) {
      events.push(this.#evidence("unknown-class", kid, String(it.cls), at));
      return events; // ringbuffer_only: kept for dedup, never surfaced (§6.2)
    }
    if (it.stateKey !== undefined) {
      const hkey = `${kid}:${it.stream}:${it.stateKey}`;
      const order: Order = [it.issuedAt, it.epoch, it.seq];
      let prev = this.hwm.get(hkey);
      // A mark must outlive every older item for its key (§7.8). Its horizon is the latest
      // (local expiry + skew + class max TTL) over the items admitted for the key while it is
      // held, so it never goes down: a newer value of a shorter-lived class must not shorten it.
      // A mark whose horizon has passed is dropped first, as tick() would, so the outcome
      // doesn't depend on tick cadence.
      if (prev !== undefined && prev.retain <= nowMs) {
        this.hwm.delete(hkey);
        this.hwmPerKey.set(kid, (this.hwmPerKey.get(kid) ?? 1) - 1);
        this.#dirty = true;
        prev = undefined;
      }
      // Equal order is only possible for the same identity, i.e. a re-surface after a restart.
      const cmp = prev === undefined ? 1 : compareOrder(order, prev.order);
      if (cmp < 0 || (cmp === 0 && !resurface)) {
        events.push(
          plucked
            ? this.#evidence("plucked", kid, "item arrived after its pluck", at)
            : this.#evidence(
                "superseded",
                kid,
                "older than the high-water mark",
                at,
              ),
        );
        return events;
      }
      if (cmp > 0) {
        let until = retain + spec.maxTtlS * 1000;
        if (prev === undefined) {
          this.hwmPerKey.set(kid, (this.hwmPerKey.get(kid) ?? 0) + 1);
        } else {
          until = Math.max(until, prev.retain);
        }
        this.hwm.set(hkey, { order, retain: until });
        this.#hwmDue.push(until, hkey);
        this.#dirty = true;
        this.#urgent = true;
      }
      for (const [otherIdent, h] of this.current) {
        if (
          h.kid === kid &&
          h.item.stream === it.stream &&
          h.item.stateKey === it.stateKey
        ) {
          this.current.delete(otherIdent);
          events.push({
            event: "superseded",
            station: this.#name(kid),
            keyId: kid,
            stream: sname,
            seq: h.item.seq,
            data: { by_seq: it.seq },
          });
        }
      }
    }
    if (plucked) {
      events.push(
        this.#evidence("plucked", kid, "item arrived after its pluck", at),
      );
      return events;
    }
    if (
      sname === undefined ||
      (this.tuned !== undefined && !this.tuned.has(sname))
    ) {
      return events; // untuned or unnamed streams are held, not surfaced (§5.4)
    }
    if (
      it.cls === LIVE_STATE &&
      this.warmup &&
      !this.#warm(kid, it.stream, nowMs)
    ) {
      this.held.set(`${kid}:${it.stream}:${it.stateKey}`, {
        ident,
        kid,
        item: it,
        retain,
      });
      return events; // §7.8 rule 4: UNKNOWN until warm-up; released by tick()
    }
    this.current.set(ident, {
      item: it,
      ident,
      kid,
      localExpiry: retain - SKEW_MS,
      firstHeard: nowMs,
      lastHeard: nowMs,
      copies: 1,
    });
    events.push({
      event: "item",
      station: this.#name(kid),
      keyId: kid,
      stream: sname,
      seq: it.seq,
      data: this.#itemData(it, nowMs, st),
    });
    if (sname === "root") events.push(...this.#presence(kid, nowMs));
    return events;
  }

  #itemData(
    it: Item,
    nowMs: number,
    st: StationState,
  ): Record<string, unknown> {
    const d: Record<string, unknown> = {
      class: CLASSES.get(it.cls)!.name,
      epoch: it.epoch,
      issued_at: it.issuedAt,
      expires_at: it.expiresAt,
      age_ms: Math.max(0, nowMs - it.issuedAt - offsetMs(st)),
      hop: it.hop,
      scope: it.scope,
    };
    if (it.stateKey !== undefined) d.state_key = it.stateKey;
    if (it.flags & FLAG_REFRESH) d.refresh = true;
    if (it.purpose !== undefined) d.purpose = it.purpose;
    if (it.intensity !== undefined) d.intensity = it.intensity;
    if (it.body !== undefined) {
      if (it.ctype === CTYPE_TEXT)
        d.text = Buffer.from(it.body).toString("utf8");
      else d.body_hex = hex(it.body);
      d.ctype = it.ctype;
    }
    if (it.bodyRef !== undefined) {
      d.body_ref = {
        url: it.bodyRef.url,
        sha256: hex(it.bodyRef.sha256),
        size: it.bodyRef.size,
      };
    }
    return d;
  }

  // ------------------------------------------------------------ bounds (§7.4, #60)

  /** Per-key share of the dedup store. A key that floods only fills its own share. */
  #quota(): number {
    if (this.perKeyQuota !== undefined) return Math.max(1, this.perKeyQuota);
    return Math.max(
      1,
      Math.floor(this.dedupCapacity / Math.max(1, this.manifest.size)),
    );
  }

  #roomFor(kid: string, nowMs: number): boolean {
    if ((this.dedupPerKey.get(kid) ?? 0) < this.#quota()) return true;
    this.#purgeDedup(nowMs);
    return (this.dedupPerKey.get(kid) ?? 0) < this.#quota();
  }

  /** Would admitting this frame add a supersession mark? (the conditions of the mark step) */
  #needsMark(f: Exclude<Frame, { kind: typeof KIND_BEACON }>): boolean {
    if (f.kind !== KIND_ITEM) return false;
    const it = f.body;
    return (
      it.stateKey !== undefined &&
      CLASSES.has(it.cls) &&
      !this.hwm.has(`${hex(f.keyId)}:${it.stream}:${it.stateKey}`)
    );
  }

  /**
   * Per-key limit on supersession marks, counted apart from dedup entries. A dedup
   * entry lasts about one TTL; a mark lasts that TTL + skew + the class max TTL
   * (§7.8). So the limit is the dedup share scaled by the largest
   * ⌈(default TTL + max TTL + skew) / default TTL⌉ among the key's granted classes.
   */
  #markQuota(kid: string): number {
    if (this.perKeyMarkQuota !== undefined) {
      return Math.max(1, this.perKeyMarkQuota);
    }
    const entry = this.manifest.entry(Buffer.from(kid, "hex"));
    const granted = [...(entry?.classes ?? [])]
      .map((c) => CLASSES.get(c))
      .filter((c) => c !== undefined);
    const specs = granted.length > 0 ? granted : [...CLASSES.values()];
    const factor = Math.max(
      ...specs.map((c) =>
        Math.ceil(
          ((c.defaultTtlS + c.maxTtlS) * 1000 + SKEW_MS) /
            (c.defaultTtlS * 1000),
        ),
      ),
    );
    return this.#quota() * factor;
  }

  /** Checked at admission and never met by evicting a live mark (§7.4). */
  #markRoom(kid: string, nowMs: number): boolean {
    if ((this.hwmPerKey.get(kid) ?? 0) < this.#markQuota(kid)) return true;
    this.#purgeHwm(nowMs);
    return (this.hwmPerKey.get(kid) ?? 0) < this.#markQuota(kid);
  }

  #markRefusal(kid: string, at: Record<string, unknown>): ListenerEvent {
    return this.#evidence(
      "over-quota",
      kid,
      "per-key supersession mark limit full; live marks kept",
      at,
    );
  }

  /**
   * Note an admitted copy on a stream, for presence (§8.6). Capped at the key's
   * share, oldest dropped first: presence only asks whether some stream was
   * heard within its loops.
   */
  #heardOn(st: StationState, stream: number, nowMs: number): void {
    st.lastStreamItem.delete(stream);
    st.lastStreamItem.set(stream, nowMs);
    for (const k of st.lastStreamItem.keys()) {
      if (st.lastStreamItem.size <= this.#quota()) break;
      st.lastStreamItem.delete(k);
    }
  }

  /**
   * Warm-up is over for a stream once a beacon has been heard since start and one
   * advertised loop period of the stream has passed after it (§7.8 rule 4).
   */
  #warm(kid: string, stream: number, nowMs: number): boolean {
    const st = this.stations.get(kid);
    if (st?.firstBeaconAt === undefined) return false;
    const loop =
      st.streamLoopMax.get(stream) ||
      Math.floor((CLASSES.get(LIVE_STATE)!.loopFloorMs * 4) / 3);
    return nowMs >= st.firstBeaconAt + loop;
  }

  #releaseHeld(nowMs: number): ListenerEvent[] {
    const events: ListenerEvent[] = [];
    for (const [hkey, h] of this.held) {
      if (nowMs >= h.retain - SKEW_MS || this.stickyPluck.has(h.ident)) {
        this.held.delete(hkey);
        continue;
      }
      if (!this.#warm(h.kid, h.item.stream, nowMs)) continue;
      this.held.delete(hkey);
      const prev = this.hwm.get(hkey);
      if (
        prev !== undefined &&
        compareOrder([h.item.issuedAt, h.item.epoch, h.item.seq], prev.order) <
          0
      ) {
        continue; // a newer value was heard meanwhile
      }
      const st = this.#st(h.kid);
      this.current.set(h.ident, {
        item: h.item,
        ident: h.ident,
        kid: h.kid,
        localExpiry: h.retain - SKEW_MS,
        firstHeard: nowMs,
        lastHeard: nowMs,
        copies: 1,
      });
      events.push({
        event: "item",
        station: this.#name(h.kid),
        keyId: h.kid,
        stream: this.#streamName(h.kid, h.item.stream),
        seq: h.item.seq,
        data: this.#itemData(h.item, nowMs, st),
      });
    }
    return events;
  }

  #remember(
    ident: string,
    kid: string,
    digest: string,
    retain: number,
    meta: [number, number] | undefined,
  ): void {
    // Live entries are never evicted: they hold the equivocation evidence (§10.8) and stop a
    // repeat from counting as new. New tuples are refused per key instead (#roomFor).
    this.dedup.set(ident, { digest, retain, meta });
    this.dedupPerKey.set(kid, (this.dedupPerKey.get(kid) ?? 0) + 1);
    this.#dedupDue.push(retain, ident);
    this.#dirty = true;
  }

  #purgeDedup(nowMs: number): void {
    for (const k of this.#dedupDue.due(nowMs)) {
      const v = this.dedup.get(k);
      if (v !== undefined && v.retain <= nowMs) {
        this.dedup.delete(k);
        const kid = kidOf(k);
        this.dedupPerKey.set(kid, (this.dedupPerKey.get(kid) ?? 1) - 1);
        this.#restored.delete(k);
        this.#dirty = true;
      }
    }
    // A sticky-pluck mark has its PLUCK's retention (§7.7): purging them together keeps the
    // marks within the dedup quota between ticks too.
    for (const k of this.#stickyDue.due(nowMs)) {
      const v = this.stickyPluck.get(k);
      if (v !== undefined && v <= nowMs) {
        this.stickyPluck.delete(k);
        this.#dirty = true;
      }
    }
    this.#dedupDue.compact(this.dedup.size, () =>
      [...this.dedup].map(([k, v]): [number, string] => [v.retain, k]),
    );
    this.#stickyDue.compact(this.stickyPluck.size, () =>
      [...this.stickyPluck].map(([k, v]): [number, string] => [v, k]),
    );
  }

  #purgeHwm(nowMs: number): void {
    for (const k of this.#hwmDue.due(nowMs)) {
      const v = this.hwm.get(k);
      if (v !== undefined && v.retain <= nowMs) {
        this.hwm.delete(k);
        const kid = kidOf(k);
        this.hwmPerKey.set(kid, (this.hwmPerKey.get(kid) ?? 1) - 1);
        this.#dirty = true;
      }
    }
    this.#hwmDue.compact(this.hwm.size, () =>
      [...this.hwm].map(([k, v]): [number, string] => [v.retain, k]),
    );
  }

  // ------------------------------------------------------------ time

  tick(nowMs: number): ListenerEvent[] {
    const events: ListenerEvent[] = [];
    for (const [ident, h] of this.current) {
      if (nowMs >= h.localExpiry) {
        this.current.delete(ident);
        events.push({
          event: "expired",
          station: this.#name(h.kid),
          keyId: h.kid,
          stream: this.#streamName(h.kid, h.item.stream),
          seq: h.item.seq,
          data: {},
        });
      }
    }
    this.#purgeDedup(nowMs);
    this.#purgeHwm(nowMs);
    events.push(...this.#releaseHeld(nowMs));
    for (const kid of this.stations.keys()) {
      events.push(...this.#presence(kid, nowMs));
    }
    return events;
  }

  // ------------------------------------------------------------ presence (§8.6)

  #rootState(kid: string): boolean | undefined {
    for (const h of this.current.values()) {
      if (
        h.kid === kid &&
        h.item.stateKey === "root" &&
        this.#streamName(kid, h.item.stream) === "root"
      ) {
        let body: cbor.CborValue;
        try {
          body =
            h.item.body !== undefined ? cbor.decode(h.item.body) : new Map();
        } catch {
          return undefined;
        }
        return body instanceof Map && body.has(1n);
      }
    }
    return undefined;
  }

  presenceState(kid: string, nowMs: number): string {
    const st = this.stations.get(kid);
    if (st?.lastBeacon === undefined) return "UNOBSERVABLE";
    if (st.signedOff) return "UNOBSERVABLE:signed_off";
    const period = st.periodMs || 1_000;
    if (nowMs - st.lastBeacon > 3 * period) return "UNOBSERVABLE";
    const root = this.#rootState(kid);
    if (root === undefined) return "ROOT_UNKNOWN";
    if (!root) return "UNEQUIPPED_PRESENT";
    for (const [sid, last] of st.lastStreamItem) {
      const loop = st.streamLoops.get(sid) ?? 0;
      if (
        loop &&
        nowMs - last <= 5 * loop &&
        this.#streamName(kid, sid) !== "root"
      ) {
        return "EQUIPPED_SPEAKING";
      }
    }
    return "EQUIPPED_QUIET";
  }

  #presence(kid: string, nowMs: number): ListenerEvent[] {
    const st = this.#st(kid);
    const state = this.presenceState(kid, nowMs);
    if (state === st.presence) return [];
    st.presence = state;
    return [
      {
        event: "presence",
        station: this.#name(kid),
        keyId: kid,
        data: { state, last_beacon_ms: st.lastBeacon ?? null },
      },
    ];
  }

  /** What this listener currently holds as live (its view, not the station's). */
  onAir(): Array<{
    station: string;
    stream: string | undefined;
    seq: bigint;
    copies: number;
    stateKey: string | undefined;
  }> {
    return [...this.current.values()].map((h) => ({
      station: this.#name(h.kid),
      stream: this.#streamName(h.kid, h.item.stream),
      seq: h.item.seq,
      copies: h.copies,
      stateKey: h.item.stateKey,
    }));
  }
}
