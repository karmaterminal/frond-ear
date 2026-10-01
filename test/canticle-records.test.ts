import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RecordClient } from "../src/canticle/record-client.ts";
import {
  MAX_DEPTH,
  RECORD_V,
  RecordConsumer,
  jsonDepth,
} from "../src/canticle/records.ts";
import { GuardedEmbedded } from "../src/canticle/source.ts";
import { StructuredLogger } from "../src/logger.ts";

const NOW = 1_790_000_100_000;
const RUN = "a1b2";
const logger = new StructuredLogger(() => {});
const TUNE = ["*:ops.fleet"];

let seq = 0;
const rec = (type: string, extra: Record<string, unknown> = {}, run = RUN) => ({
  v: RECORD_V,
  type,
  rec_seq: ++seq,
  run,
  ...extra,
});
const frame = (n: number, extra: Record<string, unknown> = {}) =>
  rec("frame", {
    frame: {
      key_id: "f6eecf2f43082a97",
      epoch: 7,
      stream_id: 1,
      seq: n,
      kind: "item",
      sha256: "00",
      bytes: 100,
    },
    idem: `canticle:f6eecf2f43082a97:7:1:${n}`,
    station: { name: "ops", principal: null },
    stream: "ops.fleet",
    class: "advisory",
    scope: "lan",
    hop: 0,
    state_key: "silas",
    times: {
      issued_at: NOW - 5_000,
      expires_at: NOW + 300_000,
      heard_at: NOW - 4_000,
      local_expiry_at: NOW + 295_000,
      age_ms: 5_000,
    },
    admission: "verified",
    disposition: "surface",
    body: { ctype: 1, text: `deploy.started ${n}`, size: 16 },
    ...extra,
  });

function started(): RecordConsumer {
  seq = 0;
  const c = new RecordConsumer();
  c.feed(rec("hello"), NOW);
  c.feed(
    rec("landing_state", { mute: null, breaker: "closed", modulation: [] }),
    NOW,
  );
  c.feed(rec("health", { last_datagram_at: NOW - 500, reasons: [] }), NOW);
  return c;
}
const items = (c: RecordConsumer, now = NOW) =>
  c.hearView(TUNE, now, true).items;

test("records: a verified, surfaced frame is live; retract removes it", () => {
  const c = started();
  c.feed(frame(1), NOW);
  assert.equal(items(c).length, 1);
  assert.equal(items(c)[0]!.text, "deploy.started 1");
  c.feed(
    rec("retract", {
      target: {},
      idem: "canticle:f6eecf2f43082a97:7:1:1",
      reason: "plucked",
      by: null,
    }),
    NOW,
  );
  assert.equal(items(c).length, 0);
});

test("records: nothing from a run is delivered before its first landing_state", () => {
  seq = 0;
  const c = new RecordConsumer();
  c.feed(rec("hello"), NOW);
  c.feed(frame(1), NOW);
  assert.equal(items(c).length, 0);
  c.feed(rec("landing_state", { mute: null }), NOW);
  assert.equal(items(c).length, 1);
});

test("records: an active mute withdraws everything", () => {
  const c = started();
  c.feed(frame(1), NOW);
  c.feed(
    rec("landing_state", { mute: { until: NOW + 60_000, by: "ops" } }),
    NOW,
  );
  assert.equal(items(c).length, 0);
  c.feed(rec("landing_state", { mute: null }), NOW);
  assert.equal(items(c).length, 1);
});

test("records: only verified+surface is deliverable; never past local_expiry_at", () => {
  const c = started();
  c.feed(frame(1, { disposition: "ringbuffer_only" }), NOW);
  c.feed(frame(2, { admission: "over_quota", disposition: "drop" }), NOW);
  c.feed(
    frame(3, {
      times: {
        issued_at: NOW - 9,
        expires_at: NOW + 1,
        local_expiry_at: NOW - 1,
      },
    }),
    NOW,
  );
  assert.equal(items(c).length, 0);
  c.feed(frame(4), NOW);
  assert.equal(items(c).length, 1);
  assert.equal(
    items(c, NOW + 295_001).length,
    0,
    "expires from the live set at local_expiry_at",
  );
});

test("records: unknown major version stops delivery for good", () => {
  const c = started();
  c.feed(frame(1), NOW);
  c.feed(
    { v: "canticle-receptor-record/2", type: "frame", rec_seq: 99, run: RUN },
    NOW,
  );
  assert.equal(c.health, "failed");
  assert.deepEqual(c.healthReasons, ["record_version"]);
  c.feed(frame(2), NOW);
  assert.equal(items(c).length, 0);
});

test("records: unknown type counted and ignored; malformed dropped; gaps degrade", () => {
  const c = started();
  c.feed(rec("whisper"), NOW);
  c.feed(rec("frame", { idem: 5 }), NOW);
  assert.equal(c.counts.unknown_type, 1);
  assert.equal(c.counts.malformed_record, 1);
  seq += 3; // three records lost
  c.feed(frame(1), NOW);
  assert.equal(c.health, "degraded");
  assert.ok(c.healthReasons.includes("records_lost"));
  assert.equal(items(c).length, 1, "a gap degrades but doesn't stop delivery");
});

test("records: health no_datagrams renders blind (unknown, not offline)", () => {
  const c = started();
  c.feed(
    rec("presence", { station: { name: "ops" }, state: "EQUIPPED_QUIET" }),
    NOW,
  );
  c.feed(
    rec("health", {
      last_datagram_at: NOW - 40_000,
      reasons: ["no_datagrams"],
    }),
    NOW,
  );
  const view = c.hearView(TUNE, NOW, true);
  assert.equal(view.blind, true);
  assert.deepEqual(view.stations, [{ name: "ops", presence: "unknown" }]);
});

test("records: fatal fails; a closed transport without bye fails; bye is a clean stop", () => {
  const a = started();
  a.feed(rec("fatal", { reason: "state_corrupt" }), NOW);
  assert.equal(a.health, "failed");
  assert.deepEqual(a.healthReasons, ["state_corrupt"]);
  const b = started();
  b.closed();
  assert.equal(b.health, "failed");
  assert.deepEqual(b.healthReasons, ["exit_without_bye"]);
  const d = started();
  d.feed(rec("bye"), NOW);
  d.closed();
  assert.equal(d.health, "stopped");
});

test("records: framing limits (line size, nesting depth)", () => {
  const c = started();
  c.feedLine("x".repeat(64 * 1024 + 1), NOW);
  c.feedLine(`${"[".repeat(MAX_DEPTH + 1)}${"]".repeat(MAX_DEPTH + 1)}`, NOW);
  c.feedLine("{not json", NOW);
  assert.equal(c.counts.line_too_long, 1);
  assert.equal(c.counts.depth_exceeded, 1);
  assert.equal(c.counts.malformed_record, 1);
  assert.equal(
    jsonDepth('{"a":"[[[[[[[[[[","b":[1]}'),
    2,
    "brackets inside strings don't count",
  );
});

// ---- over a real unix socket

test("record client: reads split lines over a unix socket, drops an over-long line, fails on close without bye", async () => {
  const dir = mkdtempSync(join(tmpdir(), "canticle-sock-"));
  const path = join(dir, "daemon.sock");
  let peer: Socket | undefined;
  const server = createServer((s) => (peer = s));
  await new Promise<void>((r) => server.listen(path, r));
  const client = new RecordClient({
    socketPath: path,
    tune: { gloss: TUNE },
    logger,
    clock: { now: () => NOW },
  });
  client.start();
  while (!peer) await new Promise((r) => setTimeout(r, 5));
  seq = 0;
  const lines = [
    rec("hello"),
    rec("landing_state", { mute: null }),
    rec("health", { last_datagram_at: NOW, reasons: [] }),
    frame(1),
  ]
    .map((r) => JSON.stringify(r))
    .join("\n");
  peer.write(lines.slice(0, 40));
  peer.write(`${lines.slice(40)}\n${"y".repeat(70_000)}\n`);
  peer.write(`${JSON.stringify(frame(2))}\n`);
  await new Promise((r) => setTimeout(r, 50));
  const view = client.hearView("gloss");
  assert.equal(view.items.length, 2);
  assert.equal(client.consumer.counts.line_too_long, 1);
  assert.equal((client.status() as { state: string }).state, "connected");
  peer.destroy();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(client.consumer.health, "failed");
  assert.equal(client.hearView("gloss").listening, false);
  client.stop();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---- the embedded guard

test("embedded guard: refuses to bind while a host daemon answers; binds when none does", async () => {
  const fakeReceptor = (log: string[]) =>
    ({
      start: () => log.push("start"),
      stop: () => log.push("stop"),
      status: () => ({ state: "listening" }),
      hearView: () => ({
        now: NOW,
        tuned: true,
        listening: true,
        blind: false,
        lastDatagramAt: NOW,
        stations: [],
        items: [],
      }),
    }) as never;
  const cfg = { hostSocket: "/run/x/canticle/daemon.sock" } as never;
  const refusedLog: string[] = [];
  const refused = new GuardedEmbedded(
    fakeReceptor(refusedLog),
    cfg,
    logger,
    async () => true,
  );
  await refused.decide();
  assert.deepEqual(refusedLog, []);
  assert.equal((refused.status() as { state: string }).state, "refused");
  assert.equal(refused.hearView("gloss").listening, false);
  const okLog: string[] = [];
  const ok = new GuardedEmbedded(
    fakeReceptor(okLog),
    cfg,
    logger,
    async () => false,
  );
  await ok.decide();
  assert.deepEqual(okLog, ["start"]);
});
