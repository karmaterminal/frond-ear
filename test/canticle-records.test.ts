import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RecordClient } from "../src/canticle/record-client.ts";
import {
  MAX_DEPTH,
  MAX_LIVE,
  MAX_STATIONS,
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
    dedup: "first",
    versions: { manifest_sha256: "00", manifest_label: "test" },
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
  c.feed(rec("landing_state", { mute: null, breaker: "closed" }), NOW);
  assert.equal(items(c).length, 1);
});

test("records: an active mute withdraws everything", () => {
  const c = started();
  c.feed(frame(1), NOW);
  c.feed(
    rec("landing_state", {
      mute: { until: NOW + 60_000, by: "ops" },
      breaker: "closed",
    }),
    NOW,
  );
  assert.equal(items(c).length, 0);
  c.feed(rec("landing_state", { mute: null, breaker: "closed" }), NOW);
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
    rec("landing_state", { mute: null, breaker: "closed" }),
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
  // stop() while the probe is still out: the receptor never starts afterwards.
  const lateLog: string[] = [];
  let answer!: (present: boolean) => void;
  const late = new GuardedEmbedded(
    fakeReceptor(lateLog),
    cfg,
    logger,
    () => new Promise<boolean>((r) => (answer = r)),
  );
  const deciding = late.decide();
  late.stop();
  answer(false);
  await deciding;
  assert.deepEqual(lateLog, []);
});

// ---- review hardening (frond-ear#34 web-lane review)

test("records: a missing or mistyped mute is dropped, never read as unmuted", () => {
  seq = 0;
  const c = new RecordConsumer();
  c.feed(rec("hello"), NOW);
  c.feed(rec("landing_state", { mute: "active", breaker: "closed" }), NOW);
  c.feed(rec("landing_state", { breaker: "closed" }), NOW);
  c.feed(
    rec("landing_state", { mute: { until: "soon" }, breaker: "closed" }),
    NOW,
  );
  c.feed(rec("health", { last_datagram_at: NOW - 500, reasons: [] }), NOW);
  c.feed(frame(1), NOW);
  assert.equal(items(c).length, 0);
  assert.equal(c.counts.malformed_record, 3);
  // A good mute, then a mistyped "unmute": the mute holds.
  c.feed(
    rec("landing_state", {
      mute: { until: null, by: "ops" },
      breaker: "closed",
    }),
    NOW,
  );
  c.feed(rec("landing_state", { mute: 0, breaker: "closed" }), NOW);
  assert.deepEqual(c.mute, { until: null, by: "ops" });
  assert.equal(items(c).length, 0);
});

test("records: a new run's hello recovers a failed receive", () => {
  const c = started();
  c.closed();
  assert.equal(c.health, "failed");
  c.feed(rec("hello", {}, "c3d4"), NOW);
  c.feed(rec("landing_state", { mute: null, breaker: "closed" }, "c3d4"), NOW);
  c.feed(frame(1, { run: "c3d4" }), NOW);
  assert.equal(c.health, "ok");
  assert.equal(items(c).length, 1);
});

test("records: a rec_seq gap clears the live set (it may have held a retract)", () => {
  const c = started();
  c.feed(frame(1), NOW);
  assert.equal(items(c).length, 1);
  seq += 3; // records lost
  c.feed(frame(2), NOW);
  assert.deepEqual(
    items(c).map((i) => i.seq),
    ["2"],
  );
  assert.equal(c.health, "degraded");
});

test("records: required frame fields are enforced; a pluck frame is never live", () => {
  const c = started();
  const withFrame = (n: number, change: Record<string, unknown>) => {
    const r = frame(n) as unknown as Record<string, unknown> & {
      frame: Record<string, unknown>;
    };
    Object.assign(r.frame, change);
    return r;
  };
  const noSha = withFrame(1, {});
  delete noSha.frame.sha256;
  c.feed(noSha, NOW);
  c.feed(frame(2, { dedup: undefined }), NOW);
  c.feed(frame(3, { station: { name: "ops" } }), NOW);
  c.feed(withFrame(4, { seq: "4 x" }), NOW);
  assert.equal(c.counts.malformed_record, 4);
  c.feed(withFrame(5, { kind: "pluck" }), NOW);
  assert.equal(c.counts.not_deliverable_verified, 1);
  assert.equal(items(c).length, 0);
  assert.equal(c.health, "ok"); // no rec_seq gap along the way
});

test("records: sender-chosen values never grow a map without bound", () => {
  const c = started();
  for (let i = 0; i < 300; i++) {
    c.feed(frame(i, { admission: `x${i}` }), NOW);
    c.feed(
      rec("presence", { station: { name: `s${i}` }, state: "SPEAKING" }),
      NOW,
    );
    c.feed(rec("fatal", { reason: `r${i} with spaces` }), NOW);
  }
  assert.equal(c.counts.not_deliverable_other, 300);
  assert.equal(
    Object.keys(c.counts).filter((k) => k.startsWith("not_")).length,
    1,
  );
  assert.equal(c.presence.size, MAX_STATIONS);
  assert.ok(c.healthReasons.length <= 16);
  const d = started();
  for (let i = 0; i < MAX_LIVE + 10; i++) {
    d.feed(
      frame(i, {
        times: {
          issued_at: NOW,
          expires_at: NOW + 1e12,
          local_expiry_at: NOW + 1e12,
        },
      }),
      NOW,
    );
  }
  assert.equal(d.counts.live_overflow, 10);
  // local_expiry_at can't outlive the longest class TTL.
  assert.equal(items(d, NOW + 400 * 86_400_000).length, 0);
});

test("record client: a partial line from the last connection doesn't eat the next one's first record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "canticle-sock-"));
  const path = join(dir, "daemon.sock");
  const peers: Socket[] = [];
  const server = createServer((s) => peers.push(s));
  await new Promise<void>((r) => server.listen(path, r));
  const client = new RecordClient({
    socketPath: path,
    tune: { gloss: TUNE },
    logger,
    clock: { now: () => NOW },
    timers: {
      setTimeout: (fn: () => void) => setTimeout(fn, 1),
      clearTimeout: (t: unknown) => clearTimeout(t as NodeJS.Timeout),
    } as never,
  });
  try {
    client.start();
    while (peers.length < 1) await new Promise((r) => setTimeout(r, 5));
    peers[0]!.write('{"v":"canticle-receptor-record/1","type":"hel');
    await new Promise((r) => setTimeout(r, 20));
    peers[0]!.destroy();
    while (peers.length < 2) await new Promise((r) => setTimeout(r, 5));
    seq = 0;
    const lines = [
      rec("hello", {}, "e5f6"),
      rec("landing_state", { mute: null, breaker: "closed" }, "e5f6"),
      rec("health", { last_datagram_at: NOW, reasons: [] }, "e5f6"),
      frame(1, { run: "e5f6" }),
    ];
    peers[1]!.write(`${lines.map((r) => JSON.stringify(r)).join("\n")}\n`);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(client.consumer.counts.malformed_record ?? 0, 0);
    assert.equal(client.hearView("gloss").items.length, 1);
  } finally {
    client.stop();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
