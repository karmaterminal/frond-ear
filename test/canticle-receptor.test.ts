import assert from "node:assert/strict";
import { createSocket, type Socket } from "node:dgram";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Manifest } from "../src/canticle/manifest.ts";
import { CanticleReceptor } from "../src/canticle/receptor.ts";
import { parseConfig, type CanticleConfig } from "../src/config.ts";
import { StructuredLogger } from "../src/logger.ts";

const vectors = JSON.parse(
  readFileSync(
    new URL("./fixtures/canticle/frame-v2-candidates.json", import.meta.url),
    "utf8",
  ),
) as {
  now_ms: number;
  manifest: unknown;
  parse: Array<{ name: string; datagram_hex: string }>;
  sequences: Array<{ name: string; datagrams_hex: string[] }>;
};
const manifest = Manifest.fromJson(vectors.manifest);
const clock = { now: () => vectors.now_ms };
const vec = (name: string) =>
  Buffer.from(vectors.parse.find((c) => c.name === name)!.datagram_hex, "hex");
const logger = new StructuredLogger(() => {});

class MemoryStore {
  readonly values = new Map<string, string>();
  runtimeState(name: string) {
    return this.values.get(name);
  }
  setRuntimeState(name: string, value: string) {
    this.values.set(name, value);
  }
}

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
  assert.ok(
    store.values.has("canticle.listener_state"),
    "saved after a change",
  );
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

test("receptor: hearView is sighted after a datagram, then blind (unknown, not offline) after 30 s of total silence", async () => {
  let now = vectors.now_ms;
  let bound: Socket | undefined;
  const receptor = new CanticleReceptor({
    config: config(),
    manifest,
    store: new MemoryStore(),
    logger,
    clock: { now: () => now },
    socket: () => (bound = createSocket("udp4")),
  });
  assert.equal(receptor.hearView("gloss").blind, true, "not bound yet");
  receptor.start();
  await new Promise((r) => bound!.once("listening", r));
  assert.equal(
    receptor.hearView("gloss").blind,
    true,
    "bound, but nothing heard yet",
  );
  receptor.receive(vec("valid-item-named-stream"));
  const sighted = receptor.hearView("gloss");
  assert.equal(sighted.blind, false);
  assert.equal(sighted.items.length, 1);
  now += 31_000;
  const blind = receptor.hearView("gloss");
  assert.equal(blind.blind, true);
  assert.ok(
    blind.stations.length > 0 &&
      blind.stations.every((st) => st.presence === "unknown"),
  );
  receptor.stop();
});
