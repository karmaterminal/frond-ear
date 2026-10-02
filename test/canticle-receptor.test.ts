import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as cbor from "../src/canticle/cbor.ts";
import { streamId } from "../src/canticle/ids.ts";
import { Manifest } from "../src/canticle/manifest.ts";
import { CanticleReceptor, type StateStore } from "../src/canticle/receptor.ts";
import { parseConfig, type CanticleConfig } from "../src/config.ts";
import { StructuredLogger } from "../src/logger.ts";
import { EventStore } from "../src/store.ts";
import { KIND_ITEM, SIGN_DOMAIN } from "../src/canticle/wire.ts";

const vectors = JSON.parse(
  readFileSync(
    new URL("./fixtures/canticle/frame-v2-candidates.json", import.meta.url),
    "utf8",
  ),
) as {
  now_ms: number;
  keys: Record<string, { secret: string; key_id: string }>;
  manifest: unknown;
  parse: Array<{ name: string; datagram_hex: string }>;
  sequences: Array<{ name: string; datagrams_hex: string[] }>;
};
const manifest = Manifest.fromJson(vectors.manifest);
const clock = { now: () => vectors.now_ms };
const vec = (name: string) =>
  Buffer.from(vectors.parse.find((c) => c.name === name)!.datagram_hex, "hex");
const logger = new StructuredLogger(() => {});

/** The durable store a crash leaves behind: snapshot + guard journal, nothing in memory. */
class MemoryStore {
  readonly values = new Map<string, string>();
  readonly journals = new Map<string, string[]>();
  appends = 0;
  checkpoints = 0;
  runtimeState(name: string) {
    return this.values.get(name);
  }
  setRuntimeState(name: string, value: string) {
    this.values.set(name, value);
  }
  runtimeJournal(name: string) {
    return [...(this.journals.get(name) ?? [])];
  }
  appendRuntimeJournal(name: string, value: string) {
    this.appends += 1;
    this.journals.set(name, [...(this.journals.get(name) ?? []), value]);
  }
  checkpointRuntimeState(name: string, value: string) {
    this.checkpoints += 1;
    this.values.set(name, value);
    this.journals.delete(name);
  }
  get journalLength() {
    return this.journals.get("canticle.listener_state")?.length ?? 0;
  }
}

// Signed frames beyond the fixtures (same key as test1), for keyed and epoch guards.
const T0 = 1_790_000_000_000;
const CHATTER = streamId("chatter");
const sk = createPrivateKey({
  key: Buffer.from(
    "302e020100300506032b657004220420" + vectors.keys.test1!.secret,
    "hex",
  ),
  format: "der",
  type: "pkcs8",
});
const kid = Buffer.from(vectors.keys.test1!.key_id, "hex");
function item(o: {
  seq: number;
  epoch?: number;
  issued?: number;
  stateKey?: string;
}): Uint8Array {
  const issued = o.issued ?? T0;
  const m: cbor.CborMap = new Map();
  const fields: Record<number, cbor.CborValue | number> = {
    1: o.epoch ?? 1,
    2: CHATTER,
    3: o.seq,
    4: issued,
    5: issued + 60_000,
    6: 1,
    7: 1,
    8: new TextEncoder().encode(`item ${o.seq}`),
    11: 0,
    13: 1,
  };
  if (o.stateKey !== undefined) fields[10] = o.stateKey;
  for (const [k, v] of Object.entries(fields))
    m.set(BigInt(k), typeof v === "number" ? BigInt(v) : v);
  const unsigned = Buffer.concat([
    Buffer.from([0x42, 0x43, 2, KIND_ITEM]),
    kid,
    cbor.encode(m),
  ]);
  const sig = sign(null, Buffer.concat([SIGN_DOMAIN, unsigned]), sk);
  return new Uint8Array(Buffer.concat([unsigned, sig]));
}

const noSocket = () =>
  ({ on: () => {}, bind: () => {}, close: () => {} }) as never;
/** A started receptor on `store` whose tick only runs when the test calls it. */
function harness(store: StateStore, now: { t: number }) {
  let tick: (() => void) | undefined;
  const receptor = new CanticleReceptor({
    config: config(),
    manifest,
    store,
    logger,
    clock: { now: () => now.t },
    timers: {
      setTimeout: (fn: () => void) => ((tick = fn), 1),
      clearTimeout: () => {},
    },
    socket: noSocket,
  });
  receptor.start();
  return { receptor, tick: () => tick!() };
}
const evidence = (r: CanticleReceptor) =>
  (r.status() as { evidence: Record<string, number> }).evidence;

const config = (over: Partial<CanticleConfig> = {}): CanticleConfig => ({
  enabled: true,
  manifestPath: "unused",
  bindHost: "127.0.0.1",
  port: 0, // tests bind an ephemeral port
  binding: "lan",
  tune: { gloss: ["*:chatter"], other: ["test2:chatter"] },
  ...over,
});

test("receptor: a datagram over real loopback UDP lands in the tuned ear's live set", async () => {
  let bound: Socket | undefined;
  const receptor = new CanticleReceptor({
    config: config(),
    manifest,
    store: new MemoryStore(),
    logger,
    clock,
    socket: () => (bound = createSocket("udp4")),
  });
  receptor.start();
  await new Promise((r) => bound!.once("listening", r));
  const { port } = bound!.address();
  const sender = createSocket("udp4");
  const arrived = new Promise((r) =>
    bound!.once("message", () => setImmediate(r)),
  );
  sender.send(vec("valid-item-named-stream"), port, "127.0.0.1");
  await arrived;
  sender.close();
  const live = receptor.live("gloss");
  assert.equal(live.length, 1);
  assert.equal(live[0]!.station, "test1");
  assert.equal(live[0]!.stream, "chatter");
  assert.equal(live[0]!.text, "hello, station");
  assert.equal(live[0]!.class, "chatter");
  assert.deepEqual(
    receptor.live("other"),
    [],
    "an ear tuned to another station hears nothing",
  );
  const status = receptor.status() as {
    state: string;
    counts: { datagrams: number; items: number };
  };
  assert.equal(status.state, "listening");
  assert.equal(status.counts.datagrams, 1);
  assert.equal(status.counts.items, 1);
  receptor.stop();
});

test("receptor: safety state persists across a restart (a PLUCK still holds)", () => {
  const store = new MemoryStore();
  const seq = vectors.sequences.find(
    (s) => s.name === "pluck-before-original",
  )!;
  const [pluck, original] = seq.datagrams_hex.map((h) => Buffer.from(h, "hex"));
  const first = new CanticleReceptor({
    config: config(),
    manifest,
    store,
    logger,
    clock,
  });
  first.receive(pluck!);
  assert.equal(store.journalLength, 1, "journaled after a change");
  const second = new CanticleReceptor({
    config: config(),
    manifest,
    store,
    logger,
    clock,
  });
  second.receive(original!);
  assert.deepEqual(second.live("gloss"), []);
  assert.deepEqual(
    (second.status() as { evidence: Record<string, number> }).evidence,
    { plucked: 1 },
  );
});

test("receptor: refuses to start on a corrupt saved state rather than forgetting it", () => {
  const store = new MemoryStore();
  store.setRuntimeState("canticle.listener_state", "{not json");
  assert.throws(
    () =>
      new CanticleReceptor({
        config: config(),
        manifest,
        store,
        logger,
        clock,
      }),
    /refusing to start/,
  );
});

test("receptor: a garbage datagram is evidence, never a throw", () => {
  const receptor = new CanticleReceptor({
    config: config(),
    manifest,
    store: new MemoryStore(),
    logger,
    clock,
  });
  receptor.receive(Buffer.from("not a frame"));
  receptor.receive(new Uint8Array(0));
  assert.equal(
    (receptor.status() as { counts: { evidence: number } }).counts.evidence,
    2,
  );
});

// ---- config

const base = {
  botUserId: "1",
  ears: { gloss: { channels: { "2": "room" } } },
};

test("config: canticle is optional and absent by default", () => {
  assert.equal(parseConfig(base).canticle, undefined);
});

test("config: canticle defaults and validation", () => {
  const c = parseConfig({
    ...base,
    canticle: {
      enabled: true,
      manifestPath: "/m.json",
      tune: { gloss: ["*:ops.fleet"] },
    },
  });
  assert.deepEqual(c.canticle, {
    enabled: true,
    manifestPath: "/m.json",
    bindHost: "0.0.0.0",
    port: 9999,
    binding: "lan",
    tune: { gloss: ["*:ops.fleet"] },
  });
  const bad = (canticle: unknown) => () => parseConfig({ ...base, canticle });
  assert.throws(bad({ enabled: true }), /manifestPath is required/);
  assert.throws(bad({ tune: { nobody: ["*:chatter"] } }), /no such ear/);
  assert.throws(bad({ tune: { gloss: ["chatter"] } }), /station:stream/);
  assert.throws(bad({ tune: { toString: ["*:chatter"] } }), /no such ear/);
  assert.throws(bad({ binding: "galaxy" }), /binding must be/);
  assert.throws(bad({ port: 70_000 }), /at most 65535/);
});

test("receptor: a plain admission defers its save to the tick; a failing store never throws", () => {
  const store = new MemoryStore();
  let tick: (() => void) | undefined;
  const timers = {
    setTimeout: (fn: () => void) => ((tick = fn), 1),
    clearTimeout: () => {},
  };
  const fakeSocket = () =>
    ({ on: () => {}, bind: () => {}, close: () => {} }) as never;
  const receptor = new CanticleReceptor({
    config: config(),
    manifest,
    store,
    logger,
    clock,
    timers,
    socket: fakeSocket,
  });
  receptor.start();
  // The key's first frame adopts its epoch: a raised guard, journaled at once.
  receptor.receive(vec("rfc-vector-1-item"));
  assert.equal(store.appends, 1, "epoch adoption is journaled");
  assert.equal(store.values.size, 0, "journaled, not snapshotted");
  receptor.receive(vec("valid-item-named-stream"));
  assert.equal(receptor.live("gloss").length, 1);
  assert.equal(store.appends, 1, "no journal record for an item");
  assert.equal(store.values.size, 0, "no synchronous snapshot for an item");
  tick!();
  assert.ok(store.values.has("canticle.listener_state"), "saved on the tick");

  const broken = new CanticleReceptor({
    config: config(),
    manifest,
    store: {
      runtimeState: () => undefined,
      runtimeJournal: () => [],
      appendRuntimeJournal: () => {
        throw new Error("disk full");
      },
      checkpointRuntimeState: () => {
        throw new Error("disk full");
      },
    },
    logger,
    clock,
    timers,
    socket: fakeSocket,
  });
  const seq = vectors.sequences.find(
    (s) => s.name === "pluck-before-original",
  )!;
  assert.doesNotThrow(() =>
    broken.receive(Buffer.from(seq.datagrams_hex[0]!, "hex")),
  );
  assert.equal(
    (broken.status() as { counts: { saveFailures: number } }).counts
      .saveFailures,
    1,
  );
  receptor.stop();
});

test("receptor: event-less admissions (untuned, unnamed) never write a snapshot synchronously (🌿 #27 B1)", () => {
  const store = new MemoryStore();
  let tick: (() => void) | undefined;
  let now = vectors.now_ms;
  const receptor = new CanticleReceptor({
    config: config({ tune: { gloss: ["*:somewhere-else"] } }),
    manifest,
    store,
    logger,
    clock: { now: () => now },
    timers: {
      setTimeout: (fn: () => void) => ((tick = fn), 1),
      clearTimeout: () => {},
    },
    socket: () => ({ on: () => {}, bind: () => {}, close: () => {} }) as never,
  });
  receptor.start();
  receptor.receive(vec("ttl-clamped-not-rejected")); // first frame: epoch adoption, urgent
  assert.equal(store.appends, 1);
  now += 1_000;
  receptor.receive(vec("valid-item-named-stream")); // admitted, untuned: no event
  now += 1_000;
  receptor.receive(vec("rfc-vector-1-item")); // admitted, unnamed stream: no event
  assert.equal(store.values.size, 0, "no snapshot per event-less admission");
  assert.equal(store.appends, 1, "no journal record per event-less admission");
  tick!();
  assert.ok(store.values.has("canticle.listener_state"), "the tick saves it");
  receptor.stop();
});

// ---- crash safety of raised guards (🌊 #27 review at a188297): every accepted guard is
// durable when receive() returns. A "crash" is a fresh receptor built from the store alone,
// before any tick.

test("receptor: a second PLUCK 10 ms after the first survives a crash before the tick (🌊 repro)", () => {
  const store = new MemoryStore();
  const now = { t: vectors.now_ms };
  const { receptor: first } = harness(store, now);
  const [pluck, original] = vectors.sequences
    .find((s) => s.name === "pluck-before-original")!
    .datagrams_hex.map((h) => Buffer.from(h, "hex"));
  first.receive(vec("rfc-vector-2-pluck"));
  now.t += 10;
  first.receive(pluck!);
  // crash: nothing but the store survives; no tick ran.
  const { receptor: second } = harness(store, now);
  second.receive(original!);
  assert.deepEqual(
    second.live("gloss"),
    [],
    "the withdrawn item never reappears",
  );
  assert.deepEqual(evidence(second), { plucked: 1 });
});

test("receptor: a supersession mark raised inside the window survives a crash before the tick", () => {
  const store = new MemoryStore();
  const now = { t: T0 + 10_000 };
  const { receptor: first } = harness(store, now);
  first.receive(item({ seq: 1 })); // first frame: epoch adopted
  now.t += 10;
  first.receive(item({ seq: 3, stateKey: "k", issued: T0 + 5_000 })); // mark raised
  const { receptor: second } = harness(store, now);
  second.receive(item({ seq: 2, stateKey: "k", issued: T0 + 1_000 }));
  assert.deepEqual(
    evidence(second),
    { superseded: 1 },
    "the older value is refused",
  );
  second.receive(item({ seq: 3, stateKey: "k", issued: T0 + 5_000 }));
  assert.deepEqual(
    second.live("gloss").map((i) => i.seq),
    ["3"],
    "the newest value still resurfaces once (its dedup row is journaled with the mark)",
  );
});

test("receptor: an epoch advance inside the window survives a crash before the tick", () => {
  const store = new MemoryStore();
  const now = { t: T0 + 10_000 };
  const { receptor: first } = harness(store, now);
  first.receive(item({ seq: 1, epoch: 1 }));
  now.t += 10;
  first.receive(item({ seq: 1, epoch: 3 })); // epoch advance
  const { receptor: second } = harness(store, now);
  second.receive(item({ seq: 9, epoch: 2 }));
  assert.deepEqual(evidence(second), { "epoch-regression": 1 });
  assert.deepEqual(second.live("gloss"), []);
});

test("receptor: guards are journaled O(1) each; the tick checkpoints and truncates; keyed churn stays bounded", () => {
  const store = new MemoryStore();
  const now = { t: T0 + 10_000 };
  const { receptor, tick } = harness(store, now);
  receptor.receive(item({ seq: 1 }));
  assert.equal(store.appends, 1, "epoch adoption is journaled at once");
  assert.equal(store.checkpoints, 0, "no full snapshot per guard");
  tick();
  assert.equal(store.checkpoints, 1);
  assert.equal(store.journalLength, 0, "a checkpoint truncates the journal");
  // Keyed churn at line rate: every datagram raises the same key's mark.
  const N = 10_000;
  for (let i = 0; i < N; i++) {
    receptor.receive(item({ seq: 10 + i, stateKey: "k", issued: T0 + i }));
  }
  assert.equal(store.appends, 1 + N, "one small record per raised guard");
  assert.ok(
    store.journalLength <= 4_096,
    `journal holds at most the cap (${store.journalLength})`,
  );
  assert.equal(
    store.checkpoints,
    1 + Math.floor(N / 4_096),
    "a full snapshot only each time the journal reaches its cap",
  );
  for (const line of store.journals.get("canticle.listener_state") ?? []) {
    assert.ok(line.length < 1_024, "each record is small, not O(state)");
  }
  // And the churn's last mark survives a crash.
  const { receptor: second } = harness(store, now);
  second.receive(item({ seq: 9, stateKey: "k", issued: T0 + N - 2 }));
  assert.deepEqual(evidence(second), { superseded: 1 });
});

test("receptor: the guard journal round-trips through the real event store (SQLite), and a checkpoint empties it", () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-canticle-"));
  try {
    const path = join(directory, "events.sqlite");
    const now = { t: vectors.now_ms };
    const [pluck, original] = vectors.sequences
      .find((s) => s.name === "pluck-before-original")!
      .datagrams_hex.map((h) => Buffer.from(h, "hex"));
    let db = new EventStore(path);
    const { receptor: first } = harness(db, now);
    first.receive(vec("rfc-vector-2-pluck"));
    now.t += 10;
    first.receive(pluck!);
    assert.equal(db.runtimeJournal("canticle.listener_state").length, 2);
    assert.equal(db.runtimeState("canticle.listener_state"), undefined);
    db.close(); // crash: no tick, no stop()
    db = new EventStore(path);
    const { receptor: second, tick } = harness(db, now);
    second.receive(original!);
    assert.deepEqual(second.live("gloss"), []);
    assert.deepEqual(evidence(second), { plucked: 1 });
    tick();
    assert.deepEqual(db.runtimeJournal("canticle.listener_state"), []);
    assert.ok(db.runtimeState("canticle.listener_state"));
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("receptor: a torn last journal record is ignored; earlier records still apply", () => {
  const store = new MemoryStore();
  const now = { t: vectors.now_ms };
  const { receptor: first } = harness(store, now);
  const [pluck, original] = vectors.sequences
    .find((s) => s.name === "pluck-before-original")!
    .datagrams_hex.map((h) => Buffer.from(h, "hex"));
  first.receive(pluck!);
  const journal = store.journals.get("canticle.listener_state")!;
  assert.equal(journal.length, 1);
  journal.push(journal[0]!.slice(0, 17)); // a crash mid-append
  const { receptor: second } = harness(store, now);
  second.receive(original!);
  assert.deepEqual(evidence(second), { plucked: 1 });
  // A corrupt record that is not the last one is not a torn write: refuse, like a corrupt snapshot.
  journal.splice(0, 0, "{garbage");
  assert.throws(() => harness(store, now), /refusing to start/);
});

test("receptor: stop() survives a failing store; live() ignores prototype keys", () => {
  const receptor = new CanticleReceptor({
    config: config(),
    manifest,
    store: {
      runtimeState: () => undefined,
      runtimeJournal: () => [],
      appendRuntimeJournal: () => {
        throw new Error("disk full");
      },
      checkpointRuntimeState: () => {
        throw new Error("disk full");
      },
    },
    logger,
    clock,
    timers: { setTimeout: () => 1, clearTimeout: () => {} },
    socket: () => ({ on: () => {}, bind: () => {}, close: () => {} }) as never,
  });
  receptor.start();
  receptor.receive(vec("valid-item-named-stream"));
  assert.doesNotThrow(() => receptor.stop());
  for (const ear of ["__proto__", "constructor", "toString"])
    assert.deepEqual(receptor.live(ear), []);
});
