// The host-daemon side of record v1 and the canticle delivery setup the canticle tests share
// (frond-ear#65; custody, binary-canticle#161): records go in through the real
// RecordConsumer, on the harness clock; what comes out is what the attached session is sent.
import assert from "node:assert/strict";

import type { DerivedRoute } from "../src/canticle/derived.ts";
import { RECORD_V, RecordConsumer } from "../src/canticle/records.ts";
import type { Config } from "../src/config.ts";
import {
  harness,
  testConfig,
  type Harness,
  type MemoryConnection,
} from "./helpers.ts";

export type R = Record<string, unknown>;

/** Allowlisted station keys (`canticle.wakeKeys`), and one that isn't. */
export const OPS = "f6eecf2f43082a97";
export const ALPHA = "0a1b2c3d4e5f6071";
export const STRAY = "9f8e7d6c5b4a3921";
export const KEYS: Readonly<Record<string, string>> = {
  ops: OPS,
  alpha: ALPHA,
  stray: STRAY,
};
export const TUNE = ["*:ops.fleet", "*:ops.deploy"];

/**
 * `canticle.wakeKeys` entries letting these keys wake for advisory, the songs' default
 * class (binary-canticle#176 decision 1: a bare key would be alarm only).
 */
export const advisory = (keys: readonly string[]) =>
  keys.map((key) => ({ key, classes: ["advisory"] }));

export interface Song {
  station?: string;
  stream?: string;
  epoch?: number;
  text?: string;
  hop?: number;
  /** Merged over all-false flags; `null` leaves `flags` out (a receptor too old to say). */
  flags?: R | null;
  stateKey?: string;
  /** `body.sha256`, for a keyed item. */
  digest?: string;
  ttlMs?: number;
  dedup?: "first" | "resurfaced";
  /** The station's key id, when a manifest renamed the station. */
  key?: string;
  /** How old the record already was when the host receptor first heard it. */
  age?: number;
  /** A non-text body (ctype 2), which no banner shows the text of. */
  binary?: true;
  /** The record's scope (§4.3); `lan` by default. */
  scope?: string;
  /** Merged over `times`; a field set to `undefined` is left out. */
  times?: R;
  /** The record's verified class (§10.4); `advisory` by default. */
  class?: string;
  /** The host's admission result (§10.9); `verified` by default. */
  admission?: string;
  /** Fields the station put on the record beyond record v1's own, merged over the rest. */
  extra?: R;
  /** The frame's `stream_id` as a number (§14.18.3); by default the stream's name. */
  streamId?: number;
  /** `null` leaves `body.ctype` out, as a host daemon that doesn't say would. */
  ctype?: null;
}

/**
 * A host daemon's side of record v1, on the harness clock: one run's records into the
 * real consumer while connected; while the link is down its stream goes on without us,
 * and a rejoin gets the run's state back as a join snapshot (§14.18.3).
 */
export class Host {
  readonly consumer: RecordConsumer;
  listening = true;
  run = "a1b2";
  /** What this run has on air (idem → frame fields), and each station's presence. */
  readonly onAir = new Map<string, R>();
  readonly stations = new Map<string, string>();
  #tune: string[];
  #seq = 0;
  readonly #clock: { now(): number };

  /** `tune` is the ear's, and the consumer admits records against it (§2.4 step 2). */
  constructor(clock: { now(): number }, tune: string[] = TUNE) {
    this.#clock = clock;
    this.#tune = tune;
    this.consumer = new RecordConsumer({ tune });
  }

  /** The `station:stream` pairs the ear follows (`canticle.tune`). */
  get tune(): string[] {
    return this.#tune;
  }

  /** A new tune: the consumer admits against it from now on. */
  set tune(tune: string[]) {
    this.#tune = tune;
    this.consumer.retune(tune, this.now);
  }

  get now(): number {
    return this.#clock.now();
  }

  #emit(type: string, extra: R): void {
    this.#seq += 1;
    if (!this.listening) return; // the run goes on; this connection misses it
    this.consumer.feed(
      { v: RECORD_V, type, rec_seq: this.#seq, run: this.run, ...extra },
      this.now,
    );
  }

  /** A run's first records: hello, landing state, health, and two stations calling CQ. */
  start(run = this.run): void {
    this.run = run;
    this.#seq = 0;
    this.onAir.clear();
    this.#emit("hello", {});
    this.landing();
    this.#emit("health", { last_datagram_at: this.now, reasons: [] });
    this.presence("ops", "EQUIPPED_SPEAKING");
    this.presence("alpha", "EQUIPPED_QUIET");
  }

  landing(extra: R = {}): void {
    this.#emit("landing_state", { mute: null, breaker: "closed", ...extra });
  }

  /** Receive health; `no_datagrams` makes every station read unknown. */
  health(reasons: string[]): void {
    this.#emit("health", { last_datagram_at: this.now, reasons });
  }

  presence(name: string, state: string): void {
    this.stations.set(name, state);
    this.#emit("presence", this.#presenceFields(name, state));
  }

  #presenceFields(name: string, state: string): R {
    return {
      station: { name, principal: null },
      key_id: KEYS[name] ?? OPS,
      state,
    };
  }

  fields(seq: number, o: Song = {}): R {
    const now = this.now;
    const station = o.station ?? "ops";
    const key = o.key ?? KEYS[station] ?? OPS;
    const epoch = o.epoch ?? 7;
    const stream = o.stream ?? "ops.fleet";
    const ttl = o.ttlMs ?? 300_000;
    const text = o.text ?? `deploy.started ${seq}`;
    return {
      frame: {
        key_id: key,
        epoch,
        stream_id: o.streamId ?? stream,
        seq,
        kind: "item",
        sha256: "00",
        bytes: 100,
      },
      idem: `canticle:${key}:${epoch}:${stream}:${seq}`,
      station: { name: station, principal: null },
      stream,
      class: o.class ?? "advisory",
      scope: o.scope ?? "lan",
      hop: o.hop ?? 0,
      ...(o.stateKey !== undefined ? { state_key: o.stateKey } : {}),
      times: Object.fromEntries(
        Object.entries({
          issued_at: now - (o.age ?? 1_000),
          expires_at: now + ttl + 5_000,
          heard_at: now - 500,
          local_expiry_at: now + ttl,
          age_ms: o.age ?? 1_000,
          ...o.times,
        }).filter(([, value]) => value !== undefined),
      ),
      admission: o.admission ?? "verified",
      disposition: "surface",
      dedup: o.dedup ?? "first",
      versions: { manifest_sha256: "00", manifest_label: "test" },
      body: o.binary
        ? { ctype: 2, size: 64 }
        : {
            ...(o.ctype === null ? {} : { ctype: 1 }),
            text,
            size: Buffer.byteLength(text),
            ...(o.digest !== undefined ? { sha256: o.digest } : {}),
          },
      ...(o.flags === null
        ? {}
        : {
            flags: {
              refresh: false,
              wake_derived: false,
              exercise: false,
              ...o.flags,
            },
          }),
      ...o.extra,
    };
  }

  sing(seq: number, o: Song = {}): void {
    const fields = this.fields(seq, o);
    this.onAir.set(fields.idem as string, fields);
    this.#emit("frame", fields);
  }

  /** The station plucks one of its records. */
  pluck(seq: number, o: Song = {}): void {
    this.retract(seq, "plucked", o);
  }

  /**
   * The host retracts one of its records for `reason` (record v1 `retract`, RFC-0001
   * §14.18.3): `plucked`, `revoked`, `quarantined`, `expired` or `superseded`.
   */
  retract(seq: number, reason: string, o: Song = {}): void {
    const idem = this.fields(seq, o).idem as string;
    this.onAir.delete(idem);
    this.#emit("retract", {
      target: {},
      idem,
      reason,
      by: null,
    });
  }

  /**
   * A keyed record's successor: the host retracts the record `old` it supersedes (same
   * key, stream and state_key), then sings `seq`, in the order binary-canticle's host
   * daemon emits them (its listener reports the supersession before the item).
   */
  supersede(old: number, seq: number, o: Song): void {
    const target = this.fields(old, o);
    const successor = this.fields(seq, o);
    this.onAir.delete(target.idem as string);
    this.#emit("retract", {
      target: {},
      idem: target.idem,
      reason: "superseded",
      by: { idem: successor.idem },
    });
    this.sing(seq, o);
  }

  /** The transport closed without a `bye`: the run is out of reach, not over. */
  drop(): void {
    this.consumer.closed(this.now);
    this.listening = false;
  }

  /** A new connection asks for, and gets, a complete join snapshot of the run. */
  rejoin(): void {
    this.consumer.reconnected({ joinSnapshot: true });
    this.listening = true;
    const now = this.now;
    const feed = (type: string, recSeq: number, extra: R) =>
      this.consumer.feed(
        { v: RECORD_V, type, rec_seq: recSeq, run: this.run, ...extra },
        now,
      );
    feed("hello", 1, { join_snapshot: true });
    this.#seq += 1;
    const w = this.#seq; // the latest landing_state is the baseline, and W
    feed("landing_state", w, { mute: null, breaker: "closed" });
    const entries = [
      ...[...this.stations].map(([name, state]) =>
        this.#presenceFields(name, state),
      ),
      ...[...this.onAir.values()].filter(
        (f) => (f.times as { local_expiry_at: number }).local_expiry_at > now,
      ),
    ];
    entries.forEach((entry, i) =>
      feed("snapshot", w, { snap_seq: i + 1, entry }),
    );
    feed("snapshot_end", w, {
      watermark: w,
      count: entries.length,
      truncated: false,
    });
  }

  view() {
    return this.consumer.hearView(this.tune, this.now, this.listening);
  }

  /** The metadata-only view the guide reads (RFC-0002 §3.3). */
  guideView() {
    return this.consumer.guideView(this.tune, this.now, this.listening);
  }
}

/** The test config with canticle on, from the host daemon, delivering to `scribe`. */
export function canticleConfig(
  delivery: unknown,
  canticle: R = {},
  top: R = {},
): Config {
  return testConfig({
    canticle: {
      enabled: true,
      source: "host-daemon",
      hostSocket: "/nonexistent/canticle.sock",
      tune: { scribe: TUNE },
      // The songs' default class is advisory: the keys' entries name it, so it may wake
      // (binary-canticle#176 decision 1; a bare key would be alarm only).
      wakeKeys: advisory([OPS, ALPHA]),
      ...(delivery !== undefined ? { delivery: { scribe: delivery } } : {}),
      ...canticle,
    },
    ...top,
  });
}

export function setup(
  delivery: unknown,
  canticle: R = {},
  top: R = {},
  options: { path?: string; derivedRoute?: DerivedRoute } = {},
): { h: Harness; host: Host } {
  let host: Host | undefined;
  const h = harness(canticleConfig(delivery, canticle, top), {
    canticleHear: () => host!.view(),
    canticleGuide: () => host!.guideView(),
    ...options,
  });
  host = new Host(h.clock);
  host.start();
  return { h, host };
}

/** The canticle pushes the client was sent; a withdrawn note (#67) is not one. */
export const pushes = (client: { connection: MemoryConnection }) =>
  client.connection
    .events()
    .filter(
      (event) =>
        event.meta.kind === "canticle" && event.meta.delivery !== "withdrawn",
    );

/** The withdrawn notes (#67) the client was sent. */
export const notes = (client: { connection: MemoryConnection }) =>
  client.connection
    .events()
    .filter(
      (event) =>
        event.meta.kind === "canticle" && event.meta.delivery === "withdrawn",
    );

/**
 * Answers `offered` for each canticle push the client was sent, as a shim does once it
 * has written it: a push left unconfirmed is given back when the daemon reverts it (a
 * detach, an attach, a shutdown), and its records go out again (#161).
 */
export async function confirm(client: ReturnType<Harness["attach"]>) {
  for (const push of pushes(client)) {
    await client.send({ type: "offered", batchId: push.batchId! });
  }
}

export interface DeliveryStatus {
  ceiling: string;
  mode: string;
  style: string;
  muted?: string;
  stations: Record<string, { ceiling: string; mode: string }>;
  wakeKeys: number;
  warning?: string;
  windowMs: number;
  debounceMs: number;
  maxAgeMs: number;
  waiting: number;
  nextPushAt: number | null;
  held: string | null;
  heldUntil?: number | null;
  lastPushAt: number | null;
  pushesLastHour: number;
  maxPushesPerHour: number;
  reports: number;
  counts: Record<string, number>;
  /** Withdrawn notes (#67): owed, when the next is due, why held, the hour's budget. */
  withdrawn: {
    owed: number;
    nextAt: number | null;
    held: string | null;
    notesLastHour: number;
    maxWithdrawnPerHour: number;
  };
}

export function status(h: Harness): DeliveryStatus {
  const ears = (
    h.daemon.status("scribe") as {
      ears: Array<{ name: string; canticleDelivery?: DeliveryStatus }>;
    }
  ).ears;
  const delivery = ears.find((ear) => ear.name === "scribe")?.canticleDelivery;
  assert.ok(delivery, "ear_status shows scribe's canticle delivery");
  return delivery;
}

/** The session id scribe's shim gives in the tests that judge custody against one. */
export const SESSION = "11111111-aaaa-4aaa-8aaa-000000000001";

let reports = 0;

/**
 * The seat's pressure hook (#98), as a CLI client: the session's context reading with its
 * latest compaction marker (null: none yet). Evidence time is the harness clock.
 */
export async function pressure(
  h: Harness,
  boundary: string | null,
  options: { sessionId?: string; tokens?: number | null } = {},
): Promise<void> {
  const cli = h.attach(undefined, { role: "cli" });
  reports += 1;
  await cli.send({
    type: "pressure",
    id: reports,
    ear: "scribe",
    sessionId: options.sessionId ?? SESSION,
    tokens: options.tokens === undefined ? 1_000 : options.tokens,
    band: null,
    boundary,
    at: h.clock.now(),
  });
  const result = cli.connection.results().at(-1)!;
  assert.equal(result.ok, true, result.text);
  cli.close();
}

/** Sings `seq`, lets immediate push it, and has the shim confirm it: the push. */
export async function offered(
  h: Harness,
  host: Host,
  shim: ReturnType<Harness["attach"]>,
  seq: number,
  song: Song = {},
) {
  const before = pushes(shim).length;
  host.sing(seq, song);
  h.timers.advance(6_000);
  assert.equal(pushes(shim).length, before + 1, `record ${seq} was pushed`);
  const push = pushes(shim).at(-1)!;
  await shim.send({ type: "offered", batchId: push.batchId! });
  return push;
}

/** `station:stream/seq` of each record a push carries, in the order it carries them. */
export const order = (content: string) =>
  [
    ...content.matchAll(
      /station="([\w-]+)" .*? stream=([\w.]+) item=\d+\/(\d+) /gu,
    ),
  ].map((m) => `${m[1]}:${m[2]}/${m[3]}`);
