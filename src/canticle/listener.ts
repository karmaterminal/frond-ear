// A listener: verify, dedup, pluck, supersede and track presence (RFC-0001 §7.4–§7.8, §8).
// A port of the spike's `canticle/listener.py`.
//
// It surfaces events (a new item, a withdrawal, a supersession, an expiry, a
// presence change, evidence) and never actuates anything. Landing into a
// session (§14) is the ear's job, not this module's.
//
// P1 scope: in-memory state only. Persisting the restart-safety state (epoch
// maxima, dedup digests, sticky PLUCKs, supersession high-water marks) is P2,
// so `Listener` currently refuses to start without `ephemeral: true`, the
// same guard the spike uses.
//
// Known growth issues inherited from the spike, to fix before P2 binds a real
// socket (frond-ear#25 review, items 3–6): `lastStreamItem` is set before the
// quota and equivocation refusals and never pruned; beacon stream-loop maps grow
// per beacon and `streamLoopMax` survives an epoch advance; `hwm` outlives the
// dedup slot, so distinct state_keys escape the per-key quota; and PLUCK expiry
// isn't clamped. All four need a granted signing key to exploit.

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
  /** stream_id → advertised loop_ms. */
  streamLoops: Map<number, number>;
  /** stream_id → last time a copy was heard. */
  lastStreamItem: Map<number, number>;
  /** Nothing reported yet. */
  presence: string;
  /** First beacon heard since this listener started (warm-up, §7.8). */
  firstBeaconAt: number | undefined;
  /** stream_id → advertised loop_max_ms. */
  streamLoopMax: Map<number, number>;
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

/** (issued_at, epoch, seq) ordering for supersession (§7.7). */
type Order = [number, number, bigint];

function compareOrder(a: Order, b: Order): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return a[2] === b[2] ? 0 : a[2] < b[2] ? -1 : 1;
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
  /** Where frames reach this listener (§4.3, §10.9). */
  binding?: string;
  /** Hold live-state keys until warm-up completes (§7.8 rule 4). */
  warmup?: boolean;
  /** Required until P2 persists the safety state: a restarted ephemeral listener can resurface stale items. */
  ephemeral: true;
}

export class Listener {
  readonly manifest: Manifest;
  readonly tuned: ReadonlySet<string> | undefined;
  readonly dedupCapacity: number;
  readonly binding: string;
  readonly warmup: boolean;
  readonly dedup = new Map<string, { digest: string; retain: number }>();
  readonly dedupPerKey = new Map<string, number>();
  readonly stickyPluck = new Map<string, number>();
  /** `${kid}:${stream}:${stateKey}` → order + retain_until. */
  readonly hwm = new Map<string, { order: Order; retain: number }>();
  /** identity → heard item (on air, from this listener's view). */
  readonly current = new Map<string, Heard>();
  readonly stations = new Map<string, StationState>();
  readonly held = new Map<string, Held>();
  readonly evidenceCounts = new Map<string, number>();

  constructor(manifest: Manifest, options: ListenerOptions) {
    if (options.ephemeral !== true) {
      throw new Error(
        "a listener needs persisted state for restart safety (§7.4–§7.8); pass ephemeral: true",
      );
    }
    const binding = options.binding ?? "lan";
    if (!SCOPES.has(binding))
      throw new Error(`unknown binding ${JSON.stringify(binding)}`);
    this.manifest = manifest;
    this.tuned = options.tuned;
    this.dedupCapacity = options.dedupCapacity ?? 100_000;
    this.binding = binding;
    this.warmup = options.warmup ?? true;
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
  ): boolean {
    const st = this.#st(kid);
    if (epoch < st.epochHwm) {
      events.push(
        this.#evidence("epoch-regression", kid, `${epoch} < ${st.epochHwm}`),
      );
      return false;
    }
    if (epoch > st.epochHwm) {
      st.epochHwm = epoch;
      st.epochSeenAt = nowMs;
      // bseq and the advertised loops belong to the previous epoch (§9.8): a restarted
      // station counts beacons from 1 again and may loop different streams.
      st.bseq = 0n;
      st.streamLoops.clear();
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
    for (const e of b.streams) {
      st.streamLoops.set(e.streamId, e.loopMs);
      st.streamLoopMax.set(e.streamId, e.loopMaxMs);
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
    if (!this.#epochOk(kid, body.epoch, nowMs, events)) return events;
    const ident = identKey(kid, body.epoch, body.stream, body.seq);
    const digest = createHash("sha256").update(f.raw).digest("hex");
    const seen = this.dedup.get(ident);
    const st = this.#st(kid);
    st.lastStreamItem.set(body.stream, nowMs);
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
      return events; // a repeat is a benign no-op (§7.4)
    } else {
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
      retain = localExpiryMs(f, offsetMs(st), nowMs) + SKEW_MS;
      this.#remember(ident, kid, digest, retain);
    }
    if (f.kind === KIND_PLUCK) {
      const p = f.body;
      const target = identKey(kid, p.epoch, p.stream, p.targetSeq);
      this.stickyPluck.set(target, retain);
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
    if (this.stickyPluck.has(ident)) {
      events.push(
        this.#evidence("plucked", kid, "item arrived after its pluck", at),
      );
      return events;
    }
    const spec = CLASSES.get(it.cls);
    if (spec === undefined) {
      events.push(this.#evidence("unknown-class", kid, String(it.cls), at));
      return events; // ringbuffer_only: kept for dedup, never surfaced (§6.2)
    }
    if (it.stateKey !== undefined) {
      const hkey = `${kid}:${it.stream}:${it.stateKey}`;
      const order: Order = [it.issuedAt, it.epoch, it.seq];
      const prev = this.hwm.get(hkey);
      // Equal order is only possible for the same identity, i.e. a re-surface after a restart (P2).
      if (prev !== undefined && compareOrder(order, prev.order) <= 0) {
        events.push(
          this.#evidence(
            "superseded",
            kid,
            "older than the high-water mark",
            at,
          ),
        );
        return events;
      }
      this.hwm.set(hkey, { order, retain: retain + spec.maxTtlS * 1000 });
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

  /** Per-key share of the dedup store (§7.4). A key that floods only fills its own share. */
  #quota(): number {
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

  #remember(ident: string, kid: string, digest: string, retain: number): void {
    // Live entries are never evicted: they hold the equivocation evidence (§10.8) and stop a
    // repeat from counting as new. New tuples are refused per key instead (#roomFor).
    this.dedup.set(ident, { digest, retain });
    this.dedupPerKey.set(kid, (this.dedupPerKey.get(kid) ?? 0) + 1);
  }

  #purgeDedup(nowMs: number): void {
    for (const [k, v] of this.dedup) {
      if (v.retain <= nowMs) {
        this.dedup.delete(k);
        const kid = k.slice(0, k.indexOf(":"));
        this.dedupPerKey.set(kid, (this.dedupPerKey.get(kid) ?? 1) - 1);
      }
    }
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
    for (const [k, v] of this.stickyPluck)
      if (v <= nowMs) this.stickyPluck.delete(k);
    for (const [k, v] of this.hwm) if (v.retain <= nowMs) this.hwm.delete(k);
    events.push(...this.#releaseHeld(nowMs));
    for (const kid of this.stations.keys())
      events.push(...this.#presence(kid, nowMs));
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
