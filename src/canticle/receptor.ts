// The binary-canticle receptor: one UDP listener per host, owned by the daemon,
// fanning heard items out to the ears that tune them (frond-ear#24).
//
// Listen-only: nothing here wakes a session or writes the Discord event ledger.
// What's on air lives in the listener's in-memory live set (it refills as
// stations loop); only the restart-safety state is persisted. The `hear` tool
// reads `live()`, and so do the daemon's delivery modes (delivery.ts), which
// alone decide what reaches a session unasked.

import { createHash } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";

import type { CanticleConfig } from "../config.ts";
import type { StructuredLogger } from "../logger.ts";
import type { Clock, Timers } from "../types.ts";
import type { HeardProvenance, SourceTuple } from "./exposure.ts";
import { systemClock, systemTimers } from "../types.ts";
import { CLASSES, EXPIRED_SHOWN_MS, expiryIsNews, SCOPE_NAMES } from "./ids.ts";
import { Listener, type ListenerEvent, type SafetyState } from "./listener.ts";
import type { Manifest } from "./manifest.ts";
import {
  FLAG_EXERCISE,
  FLAG_REFRESH,
  FLAG_WAKE_DERIVED,
  type Identity,
  type Item,
} from "./wire.ts";

/** A station key id as items carry it: SHA-256(public key)[0:8] in hex (§5.1). */
const CANTICLE_KEY_HEX = /^[0-9a-f]{16}$/iu;

const STATE_KEY = "canticle.listener_state";
const TICK_MS = 1_000;
/** The guard journal is checkpointed into a full snapshot before it outgrows either cap. */
export const JOURNAL_MAX_RECORDS = 4_096;
export const JOURNAL_MAX_BYTES = 1 << 20;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** No datagram from anyone for this long: render stations `unknown`, not `offline`. */
const BLIND_AFTER_MS = 30_000;

/**
 * Where restart safety lives (the event store's runtime_state + runtime_journal): a snapshot,
 * plus a write-ahead journal of the guards raised since it was written.
 */
export interface StateStore {
  runtimeState(name: string): string | undefined;
  /** The journal's records, oldest first. */
  runtimeJournal(name: string): string[];
  /** Append one record; durable when it returns, as durable as a snapshot write. */
  appendRuntimeJournal(name: string, value: string): void;
  /** Replace the snapshot and empty its journal, atomically. */
  checkpointRuntimeState(name: string, value: string): void;
}

export interface LiveItem {
  station: string;
  /** Key-id hex: the station's identity as the manifest pins it. */
  key: string;
  stream: string;
  seq: string;
  epoch: number;
  class: string;
  scope: string;
  hop: number;
  /** Declared by the station; context, not authority (§14.13). */
  purpose: string | undefined;
  issuedAt: number;
  /** When this listener first heard it (receiver clock). */
  heardAt: number;
  expiresAt: number;
  /** Bytes, for a body that isn't shown (non-text ctype). */
  bodyBytes: number | undefined;
  stateKey: string | undefined;
  /** The station's principal, from the manifest or the record; never from the frame. */
  principal?: string | undefined;
  /** Lineage root as `key:epoch:stream:seq` (§14.11); undefined when not known. */
  root?: string | undefined;
  text: string | undefined;
  ctype: number | string | undefined;
  bodyRef: { url: string; sha256: string; size: string } | undefined;
  ageMs: number;
  expiresInMs: number;
  copies: number;
  /**
   * Flag bit 1 (§14.8.1): sung during a canticle-woken turn, so it never wakes.
   * Undefined when the source can't tell; delivery then treats it as wake-derived.
   */
  wakeDerived?: boolean | undefined;
  /** Flag bit 0 (§7.9): a keyed item re-issued to stay on air. */
  refresh?: boolean | undefined;
  /** Flag bit 2: a drill, rendered as EXERCISE. */
  exercise?: boolean | undefined;
  /** SHA-256 of the body, hex, for a keyed item: how a refresh is told apart from an update (§7.9). */
  bodyDigest?: string | undefined;
  /**
   * Receiver-measured age at first hearing (`heard_at − issued_at − δ̂`, floored at 0;
   * §6.3 item 3). Undefined when the source doesn't say.
   */
  ageAtHearingMs?: number | undefined;
  /**
   * Set when the record didn't reach this binding as a live hearing: through a join
   * snapshot after a (re)connect, or as a `resurfaced` copy after the host receptor
   * restarted (§14.18.3, D36). Delivery marks either late.
   */
  origin?: "snapshot" | "resurfaced" | undefined;
  /**
   * What the verified record says of itself, as the exposure ledger (#117, binary-canticle
   * #162's `PayloadSource`) keeps it. Lazy: only a push the ledger fences asks for it.
   */
  provenance: () => HeardProvenance;
}

/**
 * A record this ear's tuned streams had on view that its station withdrew (#67): plucked,
 * or over record v1 revoked, quarantined or retracted for its expiry. What a session it
 * was pushed to is told in a withdrawn note: never its payload, only where it was.
 */
export interface Withdrawal {
  station: string;
  key: string;
  stream: string;
  epoch: number;
  seq: string;
  class: string;
  reason: string;
  /** When this binding heard the withdrawal. */
  at: number;
  /** The record's local expiry: after it, no tombstone of it holds and nothing is owed. */
  until: number;
}

/** Withdrawals a source keeps for delivery to read, newest kept; each until its `until`. */
export const MAX_WITHDRAWALS = 4_096;

export interface HearView {
  now: number;
  /** Whether this ear tunes any station:stream at all. */
  tuned: boolean;
  listening: boolean;
  /** The source's run ended cleanly (record v1 `bye`); not set by the embedded receptor. */
  ended?: boolean;
  blind: boolean;
  /**
   * Record v1 over the host socket: this binding joined a run in progress and has no
   * complete join snapshot, so items and presence from before the join may be missing
   * (`joined_late`, RFC-0001 §14.18.3). Not set by the embedded receptor.
   */
  joinedLate?: {
    snapshot: import("./records.ts").JoinSnapshotState;
    omitted?: number;
  };
  /**
   * The host receptor's circuit breaker (§14.8.3), from record v1's `landing_state`.
   * Not set by the embedded receptor, which has none.
   */
  breaker?: "closed" | "open" | "half_open";
  lastDatagramAt: number | undefined;
  stations: Array<{ name: string; presence: string }>;
  items: LiveItem[];
  /**
   * Record v1: what frond-ear's own live set dropped on this ear's tuned streams
   * (binary-canticle#168 §2.7a local omission, `live_overflow`), one entry per
   * `station:stream`. Not set by the embedded receptor, whose listener keeps per-key quotas.
   */
  omitted?: import("./records.ts").LiveOmission[];
  /**
   * Record v1: the live set's drops past the tuned streams it counts one by one (station
   * and stream empty), when one of this ear's patterns took in a stream they came from.
   */
  otherOmitted?: import("./records.ts").LiveOmission;
  /**
   * The embedded receptor: the class names its manifest grants a station key (§10.4), or
   * undefined for a key it doesn't know. Delivery wakes on no record whose key this denies
   * its class (binary-canticle#176, 🪨's negative). Not set over record v1: frond-ear has no
   * manifest there, and the host admits as `verified` only a class the key is granted.
   */
  capability?: (key: string) => ReadonlySet<string> | undefined;
  /**
   * Records withdrawn from this ear's tuned streams while on view (#67): what delivery
   * tells a session they were pushed to, until their local expiry. Plucked, revoked or
   * quarantined, and for a class whose expiry is news, run out on view; from either source.
   * Superseded, lapsed or lost records are not withdrawals. Not the guide's `withdrawn`
   * marks below (#133), which exclude expiry; `hearView` only, never the guide's view.
   */
  withdrawals?: Withdrawal[];
  /**
   * Record v1: tuned records the host daemon withdrew from this ear's live set (a PLUCK, a
   * revocation or a quarantine: `retract` reasons other than supersession and expiry),
   * each kept until the record would have left anyway, so the guide shows them withdrawn
   * and never live (RFC-0002 §2.2). Not set by the embedded receptor, whose listener drops
   * a plucked item from its live set at once.
   */
  withdrawn?: Array<{
    station: string;
    stream: string;
    key: string;
    class: string;
    /** `key:epoch:stream:seq`, as delivery's `identity` spells it. */
    identity: string;
    reason: string;
    at: number;
    until: number;
  }>;
  /** Record v1: the untuned share's drops, while any of them would still be on air. */
  untunedOmitted?: { count: number; from: number; to: number; until: number };
  /**
   * Record v1: patterns tuned while the untuned share was dropping records that would still
   * be on air (`dropped` of them, until `until`): such a stream's records from before `at`
   * may be missing, how many unknown.
   */
  retuned?: Array<{
    pattern: string;
    at: number;
    dropped: number;
    until: number;
  }>;
}

/** The `LiveItem` fields a guide item has. */
type GuideField =
  | "station"
  | "key"
  | "stream"
  | "seq"
  | "epoch"
  | "class"
  | "heardAt"
  | "ageMs"
  | "expiresInMs";

/**
 * One record as the guide sees it (binary-canticle RFC-0002 §3.3): metadata only. A source
 * builds it without reading, decoding, copying or hashing the record's body, text,
 * purpose, state key, body ref or provenance, so a guide call touches no payload at all.
 * Every other `LiveItem` field is `never` here, a field added later included (#138): no
 * `LiveItem` is a `GuideItem`, and no `HearView` a `GuideSourceView`, so an adapter pointed
 * at `hearView` where `guideView` belongs, or a projection spreading the item, fails tsc.
 */
export type GuideItem = GuideMetadata & {
  [K in Exclude<keyof LiveItem, GuideField>]?: never;
};

/**
 * What the guide reads of a `GuideItem`: its metadata fields and no other. A `never` field
 * still reads as `undefined`, so the guide reads items as this, where any other is TS2339.
 */
export type GuideMetadata = Pick<LiveItem, GuideField>;

/**
 * What `canticle_guide` reads from a source: the `hear` view's metadata, its items as
 * `GuideItem`s, and what holds the board empty that `hear`'s view leaves unsaid.
 */
export interface GuideSourceView
  extends Omit<HearView, "items" | "capability"> {
  items: GuideItem[];
  /**
   * Never here: every `HearView` declares it, so a whole `HearView` spread into a guide
   * view fails tsc too (#138). One taken apart first, or cast, still compiles; the
   * adapters' tests, counting payload reads through the real sources, catch those.
   */
  capability?: never;
  /** Record v1: the host daemon's receptor-wide MUTE (§14.8), while it holds. */
  hostMute?: { until: number | null; by: string | null };
  /** Record v1: records were lost on the host socket, and the live set was cleared. */
  recordsLost?: boolean;
  /** Record v1: this connection's `landing_state` hasn't come yet, so nothing is deliverable. */
  awaitingLanding?: boolean;
}

export interface ReceptorOptions {
  config: CanticleConfig;
  manifest: Manifest;
  store: StateStore;
  logger: StructuredLogger;
  clock?: Clock;
  timers?: Timers;
  /** Test seam: a socket factory. Defaults to a real UDPv4 socket. */
  socket?: () => Socket;
}

type ReceptorState = "starting" | "listening" | "backoff" | "stopped";

/**
 * Whether every raised guard is durable. `failed` (reason `state_not_durable`) means a guard
 * the receptor has acted on isn't in the store: nothing is surfaced until a checkpoint lands.
 */
export type ReceptorHealth =
  | { state: "ok" }
  | { state: "failed"; reason: "state_not_durable"; error: string };

/** "station:stream" tune patterns → does this item belong to this ear? */
function tuned(
  patterns: readonly string[],
  station: string,
  stream: string,
): boolean {
  return patterns.some((p) => {
    const at = p.indexOf(":");
    const s = p.slice(0, at);
    return (s === "*" || s === station) && p.slice(at + 1) === stream;
  });
}

/** §14.13 `root=`: the declared lineage root, or the item itself when it has none. */
function rootOf(
  root: Identity | undefined,
  kid: string,
  self: { epoch: number; stream: number; seq: bigint },
): string {
  const r = root ?? { keyId: Buffer.from(kid, "hex"), ...self };
  return `${Buffer.from(r.keyId).toString("hex").slice(0, 16)}:${r.epoch}:${r.stream.toString(16).padStart(8, "0")}:${r.seq}`;
}

const tupleOf = (identity: Identity): SourceTuple => ({
  key_id: Buffer.from(identity.keyId).toString("hex").slice(0, 16),
  epoch: identity.epoch,
  stream_id: identity.stream,
  seq: identity.seq.toString(),
});

const sha256Hex = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * A record this listener heard itself, as the exposure ledger keeps it (#117). There is no
 * record v1 run, so no receiver; the times are this listener's own.
 */
function embeddedProvenance(
  h: {
    kid: string;
    item: Item;
    firstHeard: number;
    localExpiry: number;
  },
  station: string,
  stream: string,
  offset: number,
): HeardProvenance {
  const it = h.item;
  const key = h.kid.toLowerCase().slice(0, 16);
  const streamHex = it.stream.toString(16).padStart(8, "0");
  return {
    item: {
      key_id: key,
      epoch: it.epoch,
      stream_id: it.stream,
      seq: it.seq.toString(),
    },
    idem: `canticle:${key}:${it.epoch}:${streamHex}:${it.seq}`,
    root: it.root === undefined ? null : tupleOf(it.root),
    hop: it.hop,
    class: CLASSES.get(it.cls)?.name ?? String(it.cls),
    scope: SCOPE_NAMES.get(it.scope) ?? String(it.scope),
    lens: it.lens ?? null,
    station,
    principal: null,
    stream,
    stateKey: it.stateKey ?? null,
    flags: {
      refresh: (it.flags & FLAG_REFRESH) !== 0,
      wake_derived: (it.flags & FLAG_WAKE_DERIVED) !== 0,
      exercise: (it.flags & FLAG_EXERCISE) !== 0,
    },
    times: {
      issued_at: it.issuedAt,
      expires_at: it.expiresAt,
      received_at: null,
      heard_at: h.firstHeard,
      offset_ms: offset,
      local_expiry_at: h.localExpiry,
    },
    sourceBody:
      it.body === undefined
        ? null
        : {
            ctype: it.ctype,
            size: it.body.length,
            sha256: sha256Hex(it.body),
            textSha256: it.ctype === 1 ? sha256Hex(it.body) : null,
          },
    bodyRef:
      it.bodyRef === undefined
        ? null
        : {
            url: it.bodyRef.url,
            sha256: Buffer.from(it.bodyRef.sha256).toString("hex"),
            size: Number(it.bodyRef.size),
          },
    receiver: null,
  };
}

export class CanticleReceptor {
  readonly #options: ReceptorOptions;
  readonly #listener: Listener;
  readonly #clock: Clock;
  readonly #timers: Timers;
  #socket: Socket | undefined;
  #state: ReceptorState = "starting";
  #lastError: string | undefined;
  #attempt = 0;
  #tickHandle: unknown;
  #retryHandle: unknown;
  #lastDatagramAt: number | undefined;
  /** Identity → a pluck of a record that was on view (#67), until its local expiry. */
  readonly #withdrawals = new Map<string, Withdrawal>();
  #journalRecords = 0;
  #journalBytes = 0;
  /** Set while a raised guard isn't durable; cleared by the next checkpoint that lands. */
  #notDurable: string | undefined;
  readonly #counts = {
    datagrams: 0,
    items: 0,
    withdrawn: 0,
    superseded: 0,
    expired: 0,
    evidence: 0,
    saveFailures: 0,
  };

  constructor(options: ReceptorOptions) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    this.#timers = options.timers ?? systemTimers;
    const streams = new Set<string>();
    for (const pairs of Object.values(options.config.tune)) {
      for (const p of pairs) streams.add(p.slice(p.indexOf(":") + 1));
    }
    const saved = options.store.runtimeState(STATE_KEY);
    let restore: SafetyState | null = null;
    if (saved !== undefined) {
      try {
        restore = JSON.parse(saved) as SafetyState;
      } catch {
        // A corrupt snapshot must not be silently discarded into a fresh listener:
        // that would forget plucks and supersessions (§7.7). Refuse to start.
        throw new Error(
          "canticle: saved listener state is not valid JSON; refusing to start",
        );
      }
    }
    const lines = options.store.runtimeJournal(STATE_KEY);
    const journal: SafetyState[] = [];
    lines.forEach((line, i) => {
      try {
        journal.push(JSON.parse(line) as SafetyState);
      } catch {
        // Only the last record can be torn by a crash mid-append; its datagram never
        // finished, so it was never relied on. Anything earlier is corruption: refuse.
        if (i < lines.length - 1) {
          throw new Error(
            "canticle: listener journal record is not valid JSON; refusing to start",
          );
        }
        options.logger.log("warn", "canticle.journal_torn", { record: i });
      }
    });
    this.#journalRecords = lines.length;
    this.#journalBytes = lines.reduce((n, l) => n + l.length, 0);
    this.#listener = new Listener(options.manifest, {
      tuned: streams,
      binding: options.config.binding,
      restore,
      journal,
    });
    // Fold the replayed journal into a fresh snapshot before any datagram is accepted, so a
    // torn last record is gone before anything is appended after it (🌫 #27 review).
    if (lines.length > 0) {
      try {
        this.#save();
      } catch (error) {
        this.#failDurability(error);
      }
    }
  }

  start(): void {
    this.#state = "starting";
    this.#bind();
    this.#scheduleTick();
  }

  stop(): void {
    this.#state = "stopped";
    this.#timers.clearTimeout(this.#tickHandle);
    this.#timers.clearTimeout(this.#retryHandle);
    try {
      this.#save();
    } catch (error) {
      this.#saveFailed(error); // a failing store must not stop the rest of shutdown
    }
    try {
      this.#socket?.close();
    } catch {
      // already closed
    }
    this.#socket = undefined;
  }

  #bind(): void {
    const { bindHost, port } = this.#options.config;
    const socket = (this.#options.socket ?? (() => createSocket("udp4")))();
    this.#socket = socket;
    socket.on("message", (buf) => this.receive(buf));
    socket.on("error", (error) => {
      this.#lastError = error.message;
      this.#options.logger.log("warn", "canticle.socket_error", {
        reason: error.message,
      });
      try {
        socket.close();
      } catch {
        // already closed
      }
      if (this.#state !== "stopped") this.#retry();
    });
    socket.bind(port, bindHost, () => {
      this.#state = "listening";
      this.#attempt = 0;
      this.#lastError = undefined;
      this.#options.logger.log("info", "canticle.listening", {
        bindHost,
        port,
      });
    });
  }

  /** Same curve as the Discord gateway reconnect: min(30 s, 1 s·2^min(n,5)) + jitter. */
  #retry(): void {
    this.#state = "backoff";
    const delay =
      Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(this.#attempt, 5)) +
      Math.floor(Math.random() * 1_000);
    this.#attempt += 1;
    this.#retryHandle = this.#timers.setTimeout(() => {
      if (this.#state !== "stopped") this.#bind();
    }, delay);
  }

  #scheduleTick(): void {
    this.#tickHandle = this.#timers.setTimeout(() => {
      if (this.#state === "stopped") return;
      try {
        this.#apply(this.#listener.tick(this.#clock.now()));
        this.#save(this.#notDurable !== undefined);
      } catch (error) {
        if (this.#notDurable !== undefined) this.#failDurability(error);
        else this.#saveFailed(error);
      }
      this.#scheduleTick();
    }, TICK_MS);
  }

  /** One datagram in. Public as the test seam; never throws. */
  receive(datagram: Uint8Array): void {
    this.#counts.datagrams += 1;
    this.#lastDatagramAt = this.#clock.now();
    const events = this.#listener.hear(datagram, this.#clock.now());
    this.#apply(events);
    // A raised safety guard (epoch, sticky pluck, supersession mark) must outlive a crash
    // (§7.7, §7.8), so it is journaled before this returns: one small record of just those
    // guards, not the whole snapshot. Everything else waits for the tick's checkpoint
    // (≤ TICK_MS), so neither a flood of admissions nor keyed churn serialises the state
    // per datagram. A full journal is checkpointed early, keeping it bounded.
    const record = this.#listener.takeJournal();
    if (record === undefined) return;
    // Not durable: append nothing after a possibly torn tail; the tick's checkpoint retries.
    if (this.#notDurable !== undefined) return;
    const line = JSON.stringify(record);
    try {
      this.#options.store.appendRuntimeJournal(STATE_KEY, line);
    } catch (appendError) {
      // The guard is only in memory. A full checkpoint makes it durable another way; if
      // that fails too, fail closed rather than act on a guard a restart would forget.
      this.#saveFailed(appendError);
      try {
        this.#save(true);
      } catch (error) {
        this.#failDurability(error);
      }
      return;
    }
    this.#journalRecords += 1;
    this.#journalBytes += line.length;
    if (
      this.#journalRecords >= JOURNAL_MAX_RECORDS ||
      this.#journalBytes >= JOURNAL_MAX_BYTES
    ) {
      try {
        this.#save();
      } catch (error) {
        this.#saveFailed(error); // the guard is journaled; the next tick retries the checkpoint
      }
    }
  }

  /** Enter `state_not_durable`: logged once per transition, not per datagram or tick. */
  #failDurability(error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    this.#counts.saveFailures += 1;
    if (this.#notDurable === undefined) {
      this.#options.logger.log("error", "canticle.state_not_durable", {
        reason,
      });
    }
    this.#notDurable = reason;
  }

  #saveFailed(error: unknown): void {
    this.#counts.saveFailures += 1;
    this.#options.logger.log("error", "canticle.save_failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  #apply(events: ListenerEvent[]): void {
    for (const e of events) {
      if (e.event === "item") this.#counts.items += 1;
      else if (e.event === "withdrawn") {
        this.#counts.withdrawn += 1;
        this.#keepWithdrawn(e, "plucked");
      } else if (e.event === "superseded") this.#counts.superseded += 1;
      else if (e.event === "expired") {
        this.#counts.expired += 1;
        this.#keepWithdrawn(e, "expired");
      } else if (e.event === "evidence") {
        this.#counts.evidence += 1;
        this.#options.logger.log("debug", "canticle.evidence", {
          station: e.station,
          reason: e.data.reason,
        });
      }
    }
  }

  /**
   * A record that was current, plucked or run out (the listener's own expiry: the
   * positive evidence it ran out on view), kept for delivery's withdrawn notes (#67).
   * An expiry only for a class whose expiry is news, shown for `EXPIRED_SHOWN_MS`.
   */
  #keepWithdrawn(e: ListenerEvent, reason: "plucked" | "expired"): void {
    const { epoch, cls, localExpiry } = e.data as {
      epoch?: number;
      cls?: string;
      localExpiry?: number;
    };
    if (
      e.stream === undefined ||
      e.seq === undefined ||
      epoch === undefined ||
      cls === undefined ||
      localExpiry === undefined ||
      (reason === "expired" && !expiryIsNews(cls))
    ) {
      return;
    }
    const now = this.#clock.now();
    for (const [id, w] of this.#withdrawals) {
      if (w.until <= now) this.#withdrawals.delete(id);
    }
    if (this.#withdrawals.size >= MAX_WITHDRAWALS) {
      this.#withdrawals.delete(this.#withdrawals.keys().next().value!);
    }
    const station =
      this.#options.manifest.entry(Buffer.from(e.keyId, "hex"))?.name ??
      e.keyId;
    const seq = e.seq.toString();
    this.#withdrawals.set(`${e.keyId}:${epoch}:${e.stream}:${seq}`, {
      station,
      key: e.keyId,
      stream: e.stream,
      epoch,
      seq,
      class: cls,
      reason,
      at: reason === "expired" ? localExpiry : now,
      until:
        reason === "expired" ? localExpiry + EXPIRED_SHOWN_MS : localExpiry,
    });
  }

  /** Checkpoint: the full snapshot replaces the old one and empties the journal. */
  #save(force = false): void {
    if (!force && !this.#listener.dirty && this.#journalRecords === 0) return;
    this.#options.store.checkpointRuntimeState(
      STATE_KEY,
      JSON.stringify(this.#listener.snapshot()),
    );
    this.#listener.markSaved();
    this.#journalRecords = 0;
    this.#journalBytes = 0;
    if (this.#notDurable !== undefined) {
      this.#notDurable = undefined;
      this.#options.logger.log("info", "canticle.state_durable", {});
    }
  }

  /** `failed` while a raised guard isn't durable; `live()` surfaces nothing until it clears. */
  health(): ReceptorHealth {
    return this.#notDurable === undefined
      ? { state: "ok" }
      : {
          state: "failed",
          reason: "state_not_durable",
          error: this.#notDurable,
        };
  }

  /**
   * What one ear's guide lists now: the same records as `live`, metadata only. It never
   * reads a record's body, purpose, state key or body ref (RFC-0002 §3.3).
   */
  #guideItems(ear: string): GuideItem[] {
    if (this.#notDurable !== undefined) return [];
    const tune = this.#options.config.tune;
    const patterns = Object.hasOwn(tune, ear) ? (tune[ear] ?? []) : [];
    const now = this.#clock.now();
    const out: GuideItem[] = [];
    for (const h of this.#listener.current.values()) {
      const entry = this.#options.manifest.entry(Buffer.from(h.kid, "hex"));
      const station = entry?.name ?? h.kid;
      const it = h.item;
      const stream = entry?.streamNames.get(it.stream);
      if (stream === undefined || !tuned(patterns, station, stream)) continue;
      const offset = this.#listener.clockOffset(h.kid);
      out.push({
        station,
        key: h.kid,
        stream,
        seq: it.seq.toString(),
        epoch: it.epoch,
        class: CLASSES.get(it.cls)?.name ?? String(it.cls),
        heardAt: h.firstHeard,
        ageMs: Math.max(0, now - it.issuedAt - offset),
        expiresInMs: Math.max(0, h.localExpiry - now),
      });
    }
    return out;
  }

  /** What one ear hears right now: live items on its tuned station:streams. */
  live(ear: string): LiveItem[] {
    if (this.#notDurable !== undefined) return [];
    const tune = this.#options.config.tune;
    const patterns = Object.hasOwn(tune, ear) ? (tune[ear] ?? []) : [];
    const now = this.#clock.now();
    const out: LiveItem[] = [];
    for (const h of this.#listener.current.values()) {
      const station =
        this.#options.manifest.entry(Buffer.from(h.kid, "hex"))?.name ?? h.kid;
      const stream = this.#options.manifest
        .entry(Buffer.from(h.kid, "hex"))
        ?.streamNames.get(h.item.stream);
      if (stream === undefined || !tuned(patterns, station, stream)) continue;
      const it = h.item;
      const offset = this.#listener.clockOffset(h.kid);
      out.push({
        station,
        key: h.kid,
        stream,
        seq: it.seq.toString(),
        epoch: it.epoch,
        class: CLASSES.get(it.cls)?.name ?? String(it.cls),
        scope: SCOPE_NAMES.get(it.scope) ?? String(it.scope),
        hop: it.hop,
        purpose: it.purpose,
        issuedAt: it.issuedAt,
        heardAt: h.firstHeard,
        expiresAt: it.expiresAt,
        bodyBytes:
          it.ctype !== 1 && it.body !== undefined ? it.body.length : undefined,
        stateKey: it.stateKey,
        root: rootOf(it.root, h.kid, it),
        text:
          it.ctype === 1 && it.body !== undefined
            ? Buffer.from(it.body).toString("utf8")
            : undefined,
        ctype: it.ctype,
        bodyRef: it.bodyRef && {
          url: it.bodyRef.url,
          sha256: Buffer.from(it.bodyRef.sha256).toString("hex"),
          size: it.bodyRef.size.toString(),
        },
        ageMs: Math.max(0, now - it.issuedAt - offset),
        ageAtHearingMs: Math.max(0, h.firstHeard - it.issuedAt - offset),
        expiresInMs: Math.max(0, h.localExpiry - now),
        copies: h.copies,
        wakeDerived: (it.flags & FLAG_WAKE_DERIVED) !== 0,
        refresh: (it.flags & FLAG_REFRESH) !== 0,
        exercise: (it.flags & FLAG_EXERCISE) !== 0,
        bodyDigest:
          it.stateKey !== undefined && it.body !== undefined
            ? createHash("sha256").update(it.body).digest("hex")
            : undefined,
        provenance: () => embeddedProvenance(h, station, stream, offset),
      });
    }
    return out;
  }

  /**
   * What one ear hears now, plus who's on air. If this listener has heard no
   * datagram at all for `BLIND_AFTER_MS`, every station reads `unknown`: silence
   * from everyone at once is more likely our own socket or network than every
   * station going quiet together (station silence ≠ transport blindness).
   */
  hearView(ear: string): HearView {
    const tune = this.#options.config.tune;
    const patterns = Object.hasOwn(tune, ear) ? (tune[ear] ?? []) : [];
    return {
      ...this.#viewOf(ear),
      items: this.live(ear),
      ...this.#withdrawalsFor(patterns, this.#clock.now()),
      capability: (key) => {
        if (!CANTICLE_KEY_HEX.test(key)) return undefined;
        const entry = this.#options.manifest.entry(Buffer.from(key, "hex"));
        if (entry === undefined || entry.revoked) return undefined;
        return new Set(
          [...entry.classes].flatMap((code) => {
            const name = CLASSES.get(code)?.name;
            return name === undefined ? [] : [name];
          }),
        );
      },
    };
  }

  /** `hearView` for the guide: metadata only, no body read (RFC-0002 §3.3). */
  guideView(ear: string): GuideSourceView {
    return { ...this.#viewOf(ear), items: this.#guideItems(ear) };
  }

  #viewOf(ear: string): Omit<HearView, "items" | "capability"> {
    const now = this.#clock.now();
    const blind =
      this.#state !== "listening" ||
      this.#lastDatagramAt === undefined ||
      now - this.#lastDatagramAt > BLIND_AFTER_MS;
    const tune = this.#options.config.tune;
    const patterns = Object.hasOwn(tune, ear) ? (tune[ear] ?? []) : [];
    const stations = [...this.#listener.stations.keys()]
      .map((kid) => {
        const name =
          this.#options.manifest.entry(Buffer.from(kid, "hex"))?.name ?? kid;
        return {
          name,
          presence: blind ? "unknown" : this.#listener.presenceState(kid, now),
        };
      })
      .filter((s) =>
        patterns.some((p) => p.startsWith("*:") || p.startsWith(`${s.name}:`)),
      );
    return {
      now,
      tuned: patterns.length > 0,
      listening: this.#state === "listening",
      blind,
      lastDatagramAt: this.#lastDatagramAt,
      stations,
    };
  }

  /** This ear's share of what was withdrawn, while it holds (#67). */
  #withdrawalsFor(
    patterns: readonly string[],
    now: number,
  ): { withdrawals?: Withdrawal[] } {
    const withdrawals = [...this.#withdrawals.values()].filter(
      (w) => w.until > now && tuned(patterns, w.station, w.stream),
    );
    return withdrawals.length > 0 ? { withdrawals } : {};
  }

  status(): object {
    const now = this.#clock.now();
    return {
      state: this.#state,
      bind: `${this.#options.config.bindHost}:${this.#options.config.port}`,
      binding: this.#options.config.binding,
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
      health: this.health(),
      onAir: this.#listener.current.size,
      journal: this.#journalRecords,
      counts: { ...this.#counts },
      evidence: Object.fromEntries(this.#listener.evidenceCounts),
      stations: Object.fromEntries(
        [...this.#listener.stations.keys()].map((kid) => [
          this.#options.manifest.entry(Buffer.from(kid, "hex"))?.name ?? kid,
          this.#listener.presenceState(kid, now),
        ]),
      ),
    };
  }
}
