import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { renderHear } from "../src/canticle/hear.ts";
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
  b.closed(NOW);
  assert.equal(b.health, "failed");
  assert.deepEqual(b.healthReasons, ["exit_without_bye"]);
  const d = started();
  d.feed(rec("bye"), NOW);
  d.closed(NOW);
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
  c.closed(NOW);
  assert.equal(c.health, "failed");
  c.feed(rec("hello", {}, "c3d4"), NOW);
  c.feed(rec("landing_state", { mute: null, breaker: "closed" }, "c3d4"), NOW);
  c.feed(frame(1, { run: "c3d4" }), NOW);
  assert.equal(c.health, "ok");
  assert.equal(items(c).length, 1);
});

test("records: run A's live item doesn't survive run B's hello + landing_state (🌫 #34)", () => {
  const c = started();
  c.feed(rec("presence", { station: "ops", state: "on_air" }), NOW);
  c.feed(frame(1), NOW);
  assert.equal(items(c).length, 1);
  // 🌫's sequence, with and without A's bye.
  for (const [run, bye] of [
    ["b0b0", true],
    ["c1c1", false],
  ] as const) {
    if (bye) c.feed(rec("bye"), NOW);
    c.feed(rec("hello", {}, run), NOW);
    c.feed(rec("landing_state", { mute: null, breaker: "closed" }, run), NOW);
    const view = c.hearView(TUNE, NOW, true);
    assert.equal(view.listening, true);
    assert.deepEqual(view.items, [], `nothing from the old run under ${run}`);
    assert.deepEqual(view.stations, [], "old run's presence dropped");
    assert.equal(
      view.lastDatagramAt,
      undefined,
      "old run's datagram clock dropped",
    );
    // Only the new run's own frame brings an item back.
    c.feed(frame(1, { run, dedup: "resurfaced" }), NOW);
    assert.equal(items(c).length, 1);
    if (run === "b0b0") c.feed(frame(2), NOW); // a stray old-run record is a run change too
  }
});

test("records: bye ends the run; its items stop being deliverable while still connected (🌫 #34)", () => {
  const c = started();
  c.feed(frame(1), NOW);
  assert.equal(items(c).length, 1);
  c.feed(rec("bye"), NOW);
  const view = c.hearView(TUNE, NOW, true);
  assert.deepEqual(view.items, []);
  assert.equal(view.listening, false);
  assert.equal(view.ended, true);
  assert.equal(c.health, "stopped");
  c.closed(NOW);
  assert.equal(
    c.health,
    "stopped",
    "a closed transport after bye isn't a failure",
  );
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

test("records: a refused frame carries no receipt pointers; a verified one must", () => {
  const c = started();
  const withFrame = (
    n: number,
    change: Record<string, unknown>,
    extra = {},
  ) => {
    const r = frame(n, extra) as unknown as Record<string, unknown> & {
      frame: Record<string, unknown>;
    };
    Object.assign(r.frame, change);
    return r;
  };
  const nulls = { sha256: null, bytes: null };
  // The nine refusals (binary-canticle#79): null pointers read, never deliver.
  const refusals = [
    "capability_exceeded",
    "scope_violation",
    "hop_limit",
    "over_quota",
    "pluck_mismatch",
    "plucked",
    "superseded",
    "class_change",
    "equivocation",
  ];
  let n = 0;
  for (const admission of refusals)
    c.feed(withFrame(++n, nulls, { admission, disposition: "drop" }), NOW);
  // Tolerant reader: a refusal that carries pointers anyway still reads, unused.
  c.feed(
    withFrame(++n, {}, { admission: "hop_limit", disposition: "drop" }),
    NOW,
  );
  assert.equal(c.counts.malformed_record, undefined);
  for (const admission of refusals)
    assert.ok((c.counts[`not_deliverable_${admission}`] ?? 0) >= 1, admission);
  assert.equal(items(c).length, 0);
  // Verified without either pointer is malformed, delivered or not.
  c.feed(withFrame(++n, { sha256: null }), NOW);
  c.feed(withFrame(++n, { bytes: null }), NOW);
  c.feed(withFrame(++n, nulls), NOW);
  c.feed(
    withFrame(++n, { bytes: null }, { disposition: "ringbuffer_only" }),
    NOW,
  );
  assert.equal(c.counts.malformed_record, 4);
  // Missing and mistyped stay malformed, refusal or not.
  const noBytes = withFrame(++n, { sha256: null }, { admission: "plucked" });
  delete noBytes.frame.bytes;
  c.feed(noBytes, NOW);
  c.feed(withFrame(++n, { sha256: 7 }), NOW);
  c.feed(withFrame(++n, { bytes: "100" }), NOW);
  c.feed(
    withFrame(++n, { sha256: 7, bytes: null }, { admission: "plucked" }),
    NOW,
  );
  c.feed(
    withFrame(++n, { sha256: null, bytes: 1.5 }, { admission: "plucked" }),
    NOW,
  );
  assert.equal(c.counts.malformed_record, 9);
  assert.equal(items(c).length, 0);
  c.feed(frame(++n), NOW);
  assert.equal(items(c).length, 1);
  assert.equal(c.health, "ok");
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
    c.feed(rec("fatal", { reason: `r${i}` }), NOW);
  }
  assert.equal(c.counts.not_deliverable_other, 300);
  assert.equal(
    Object.keys(c.counts).filter((k) => k.startsWith("not_")).length,
    1,
  );
  // A fatal's reason is the sender's: it counts under `fatal`, never as its own key.
  assert.equal(c.counts.fatal, 600);
  assert.deepEqual(Object.keys(c.counts).sort(), [
    "fatal",
    "not_deliverable_other",
    "presence_overflow",
  ]);
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

test("records: principal and lineage root reach the banner; absent reads unavailable", () => {
  const c = started();
  c.feed(
    frame(1, {
      station: { name: "ops", principal: "ops-east" },
      lineage: {
        derived_from: [],
        root: { key_id: "f6eecf2f43082a97", epoch: 7, stream_id: 26, seq: 1 },
      },
    }),
    NOW,
  );
  c.feed(frame(2), NOW);
  const [a, b] = items(c).sort((x, y) => Number(x.seq) - Number(y.seq));
  assert.equal(a!.principal, "ops-east");
  assert.equal(a!.root, "f6eecf2f43082a97:7:0000001a:1");
  assert.equal(b!.principal, undefined);
  assert.equal(b!.root, undefined);
});

test("record client + hear: run A's item never shows under run B, nor after bye (🌫 #34)", async () => {
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
  // A failed assertion must not leave the socket open and hang the run.
  try {
    while (!peer) await new Promise((r) => setTimeout(r, 5));
    const send = async (...recs: object[]) => {
      peer!.write(recs.map((r) => `${JSON.stringify(r)}\n`).join(""));
      await new Promise((r) => setTimeout(r, 30));
    };
    const hear = () =>
      renderHear(client.hearView("gloss"), { limit: 10, maxChars: 4_000 });
    seq = 0;
    await send(
      rec("hello"),
      rec("landing_state", { mute: null, breaker: "closed" }),
      rec("health", { last_datagram_at: NOW, reasons: [] }),
      frame(1),
    );
    assert.match(hear(), /deploy\.started 1/u);
    await send(rec("bye"));
    assert.doesNotMatch(hear(), /deploy\.started/u);
    assert.match(hear(), /ended its run cleanly/u);
    await send(
      rec("hello", {}, "b0b0"),
      rec("landing_state", { mute: null, breaker: "closed" }, "b0b0"),
    );
    assert.equal(client.consumer.health, "ok");
    assert.doesNotMatch(hear(), /deploy\.started/u);
    assert.match(hear(), /nothing live on your tuned streams/u);
  } finally {
    peer?.destroy();
    client.stop();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- §14.18.3 "Joining a run": the host socket's per-connection bootstrap (🌫 #34, bc#69)

/** A record at an exact rec_seq (the daemon's bootstrap replays original values). */
const at = (n: number, make: () => object) => {
  seq = n - 1;
  return make();
};
const landing = (extra: Record<string, unknown> = {}, run = RUN) =>
  rec("landing_state", { mute: null, breaker: "closed", ...extra }, run);

function firstJoin(): RecordConsumer {
  const c = new RecordConsumer();
  c.reconnected(); // every connection, the first included
  c.feed(
    at(1, () => rec("hello")),
    NOW,
  );
  c.feed(
    at(50, () => landing()),
    NOW,
  );
  c.feed(
    at(100, () => frame(100)),
    NOW,
  );
  return c;
}

test("records: first join — hello(1), landing_state(50), live 100 is no loss; landing restored (🌫 #34)", () => {
  const c = firstJoin();
  assert.equal(
    c.counts.records_lost ?? 0,
    0,
    "the 1→50 and 50→100 skips are a join",
  );
  assert.equal(c.counts.rec_seq_regression ?? 0, 0);
  // No join snapshot asked for: blind to what came before the join, and saying so
  // (§14.18.3 "Join snapshot", D36).
  assert.equal(c.health, "degraded");
  assert.deepEqual(c.healthReasons, ["joined_late"]);
  assert.deepEqual(
    items(c).map((i) => i.seq),
    ["100"],
    "the replayed landing_state lets the first live frame deliver",
  );
  assert.equal(c.connectionLost, false);
});

test("records: rejoin — seen to 120, hello(1), landing_state(150), live 151: landing restored, records_lost once (🌫 #34, bc#69)", () => {
  const c = firstJoin();
  // Contiguous live records to 120; a mute lands at 120.
  for (let n = 101; n < 120; n++)
    c.feed(
      at(n, () => rec("health", { reasons: [] })),
      NOW,
    );
  c.feed(
    at(120, () => landing({ mute: { until: null, by: "ops" } })),
    NOW,
  );
  assert.equal(c.counts.records_lost ?? 0, 0);
  assert.equal(items(c).length, 0, "muted");
  // Connection lost; a retract at 130 is missed. Same run, new connection.
  c.closed(NOW);
  c.reconnected();
  c.feed(
    at(1, () => rec("hello")),
    NOW,
  );
  c.feed(
    at(150, () => landing()),
    NOW,
  );
  assert.equal(
    c.counts.rec_seq_regression ?? 0,
    0,
    "bootstrap below 120 isn't a regression",
  );
  assert.equal(
    c.counts.records_lost ?? 0,
    0,
    "nothing counted until the join step",
  );
  c.feed(
    at(151, () => frame(151)),
    NOW,
  );
  assert.equal(
    c.counts.records_lost,
    1,
    "a rejoin loses records exactly once, even 150→151",
  );
  assert.ok(c.healthReasons.includes("records_lost"));
  assert.equal(c.health, "degraded");
  assert.deepEqual(
    items(c).map((i) => i.seq),
    ["151"],
    "the replayed (unmuted) landing_state replaced the muted one",
  );
  c.feed(
    at(152, () => frame(152)),
    NOW,
  );
  assert.equal(c.counts.records_lost, 1, "152 follows 151");
  // Step 3: from the first live record on, any skip is a gap.
  c.feed(
    at(154, () => frame(154)),
    NOW,
  );
  assert.equal(
    c.counts.records_lost,
    2,
    "151→153-style skip after the join is a gap",
  );
  assert.deepEqual(
    items(c).map((i) => i.seq),
    ["154"],
  );
  assert.equal(c.counts.rec_seq_regression ?? 0, 0);
});

test("records: a gap right after the join (151→153) is counted", () => {
  const c = new RecordConsumer();
  c.reconnected();
  c.feed(
    at(1, () => rec("hello")),
    NOW,
  );
  c.feed(
    at(150, () => landing()),
    NOW,
  );
  c.feed(
    at(151, () => frame(151)),
    NOW,
  );
  assert.equal(c.counts.records_lost ?? 0, 0, "first join");
  c.feed(
    at(153, () => frame(153)),
    NOW,
  );
  assert.equal(c.counts.records_lost, 1);
  assert.equal(c.health, "degraded");
});

test("records: a malformed bootstrap is malformed_record and loses the connection", () => {
  const cases: [string, () => object[]][] = [
    [
      "first record not hello",
      () => [at(10, () => rec("health", { reasons: [] }))],
    ],
    [
      "second record not landing_state",
      () => [at(1, () => rec("hello")), at(2, () => frame(2))],
    ],
    [
      "landing_state of another run",
      () => [at(1, () => rec("hello")), at(50, () => landing({}, "f00d"))],
    ],
    [
      "landing_state seq equal to hello's",
      () => [at(5, () => rec("hello")), at(5, () => landing())],
    ],
    [
      "landing_state seq below hello's",
      () => [at(5, () => rec("hello")), at(4, () => landing())],
    ],
    [
      "landing_state with a mistyped mute",
      () => [at(1, () => rec("hello")), at(50, () => landing({ mute: 0 }))],
    ],
  ];
  for (const [name, bootstrap] of cases) {
    const c = new RecordConsumer();
    c.reconnected();
    for (const r of bootstrap()) c.feed(r, NOW);
    assert.equal(c.connectionLost, true, name);
    assert.ok((c.counts.malformed_record ?? 0) >= 1, name);
    assert.equal(c.health, "failed", name);
    // Nothing more is read from this connection.
    c.feed(
      at(60, () => landing()),
      NOW,
    );
    c.feed(
      at(61, () => frame(61)),
      NOW,
    );
    assert.equal(items(c).length, 0, name);
    // The next connection's good bootstrap recovers.
    c.reconnected();
    c.feed(
      at(1, () => rec("hello")),
      NOW,
    );
    c.feed(
      at(70, () => landing()),
      NOW,
    );
    c.feed(
      at(71, () => frame(71)),
      NOW,
    );
    assert.equal(c.connectionLost, false, name);
    assert.equal(items(c).length, 1, name);
  }
  // An unparseable first line is malformed too.
  const d = new RecordConsumer();
  d.reconnected();
  d.feedLine("{not json", NOW);
  assert.equal(d.connectionLost, true);
});

test("records: without a per-connection bootstrap (one reader per run) the ordinary rules hold", () => {
  const c = new RecordConsumer();
  c.feed(
    at(1, () => rec("hello")),
    NOW,
  );
  c.feed(
    at(50, () => landing()),
    NOW,
  );
  assert.equal(
    c.counts.records_lost,
    1,
    "a skip on a bootstrap-less stream is a gap",
  );
  assert.equal(c.connectionLost, false);
});

test("record client: real socket — first join, same-run rejoin, malformed bootstrap reconnects (🌫 #34)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "canticle-sock-"));
  const path = join(dir, "daemon.sock");
  const peers: Socket[] = [];
  const server = createServer((s) => {
    peers.push(s);
    s.resume(); // read the client's request line, so its close is seen as an end
  });
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
  const send = async (peer: Socket, ...recs: object[]) => {
    peer.write(recs.map((r) => `${JSON.stringify(r)}\n`).join(""));
    await new Promise((r) => setTimeout(r, 30));
  };
  const peerAt = async (n: number) => {
    const deadline = Date.now() + 2_000;
    while (peers.length < n) {
      assert.ok(Date.now() < deadline, `connection ${n} never arrived`);
      await new Promise((r) => setTimeout(r, 5));
    }
    return peers[n - 1]!;
  };
  const seqs = () => client.hearView("gloss").items.map((i) => i.seq);
  try {
    client.start();
    const p1 = await peerAt(1);
    await send(
      p1,
      at(1, () => rec("hello")),
      at(50, () => landing()),
      at(100, () => frame(100)),
    );
    assert.deepEqual(seqs(), ["100"]);
    assert.equal(client.consumer.counts.records_lost ?? 0, 0, "first join");
    await send(
      p1,
      ...Array.from({ length: 20 }, (_, i) =>
        at(101 + i, () => rec("health", { reasons: [] })),
      ),
    );
    assert.equal(
      client.consumer.counts.records_lost ?? 0,
      0,
      "contiguous to 120",
    );
    p1.destroy();
    const p2 = await peerAt(2);
    await send(
      p2,
      at(1, () => rec("hello")),
      at(150, () => landing()),
      at(151, () => frame(151)),
    );
    assert.deepEqual(seqs(), ["151"]);
    assert.equal(client.consumer.counts.records_lost, 1, "rejoin, once");
    assert.equal(client.consumer.counts.rec_seq_regression ?? 0, 0);
    // A malformed bootstrap: the client drops the connection and reconnects.
    p2.destroy();
    const p3 = await peerAt(3);
    await send(
      p3,
      at(160, () => frame(160)),
    );
    const p4 = await peerAt(4);
    assert.equal(client.consumer.counts.bootstrap_not_hello, 1);
    assert.equal(p3.destroyed || p3.readableEnded, true);
    await send(
      p4,
      at(1, () => rec("hello")),
      at(170, () => landing()),
      at(171, () => frame(171)),
    );
    assert.deepEqual(seqs(), ["171"]);
    // An over-long line in the bootstrap is malformed too: the client drops the
    // connection rather than staying connected and failed (🌫 #34, second pass).
    p4.destroy();
    const p5 = await peerAt(5);
    p5.write(`${"x".repeat(70 * 1024)}\n`);
    const p6 = await peerAt(6);
    assert.equal(p5.destroyed || p5.readableEnded, true);
    await send(
      p6,
      at(1, () => rec("hello")),
      at(180, () => landing()),
      at(181, () => frame(181)),
    );
    assert.deepEqual(seqs(), ["181"]);
  } finally {
    client.stop();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("records: null stream, class and hop where the frame doesn't carry them aren't malformed, and never deliver (bc#79)", () => {
  const c = started();
  const pluckFrame = frame(1, {
    class: null,
    hop: null,
    state_key: null,
    purpose: null,
    intensity: null,
    lens: null,
    admission: "pluck_mismatch",
    disposition: "drop",
    body: undefined,
  }) as unknown as { frame: Record<string, unknown> };
  pluckFrame.frame.kind = "pluck";
  c.feed(pluckFrame, NOW);
  c.feed(
    frame(2, {
      stream: null,
      disposition: "ringbuffer_only",
      reasons: ["unnamed_stream"],
    }),
    NOW,
  );
  c.feed(
    frame(3, {
      class: null,
      disposition: "ringbuffer_only",
      reasons: ["unknown_class"],
    }),
    NOW,
  );
  assert.equal(c.counts.malformed_record, undefined);
  assert.equal(c.counts.not_deliverable_pluck_mismatch, 1);
  assert.equal(c.counts.not_deliverable_verified, 2);
  assert.equal(items(c).length, 0);
  // Under a tune that would match any stream name, nothing renders as "null".
  const view = c.hearView(["*:null", ...TUNE], NOW, true);
  assert.equal(view.items.length, 0);
  assert.doesNotMatch(
    renderHear(view, { limit: 10, maxChars: 4_000 }),
    /null/u,
  );
  assert.equal(c.health, "ok");
});

test("records: a wrong type in a nullable frame field is still malformed; a surfaced item needs all three", () => {
  const c = started();
  c.feed(frame(1, { hop: "x" }), NOW);
  c.feed(frame(2, { class: 3 }), NOW);
  c.feed(frame(3, { stream: 7 }), NOW);
  c.feed(frame(4, { stream: undefined }), NOW); // missing is not null
  assert.equal(c.counts.malformed_record, 4);
  // `surface` with a null stream, class or hop contradicts itself: dropped, not rendered.
  c.feed(frame(5, { stream: null }), NOW);
  c.feed(frame(6, { class: null }), NOW);
  c.feed(frame(7, { hop: null }), NOW);
  assert.equal(c.counts.malformed_record, 7);
  assert.equal(items(c).length, 0);
  c.feed(frame(8), NOW);
  assert.equal(items(c).length, 1);
});

test("records: binary-canticle#79's emitter output reads with nothing malformed (interop fixture)", () => {
  const T0 = 1_790_000_000_000;
  const lines = readFileSync(
    new URL("./fixtures/canticle/records-v1-sample.jsonl", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((l) => l !== "");
  assert.equal(lines.length, 8);
  // Receipt pointers exactly on verified frames; the two refusals carry null.
  for (const l of lines) {
    const r = JSON.parse(l) as {
      type: string;
      admission?: string;
      frame?: { sha256: unknown; bytes: unknown };
    };
    if (r.type !== "frame") continue;
    const verified = r.admission === "verified";
    assert.equal(typeof r.frame!.sha256, verified ? "string" : "object");
    assert.equal(r.frame!.bytes === null, !verified);
  }
  const c = new RecordConsumer();
  const tune = ["*:chatter"];
  // Through the hop_limit frame, before the valid PLUCK's retract.
  for (const l of lines.slice(0, 6)) c.feedLine(l, T0);
  assert.deepEqual(
    { ...c.counts },
    {
      not_deliverable_verified: 2, // unnamed stream, unknown class
      not_deliverable_pluck_mismatch: 1,
    },
  );
  const live = c.hearView(tune, T0, true).items;
  assert.equal(live.length, 1);
  assert.equal(live[0]!.stream, "chatter");
  assert.equal(live[0]!.seq, "1");
  for (const l of lines.slice(6)) c.feedLine(l, T0);
  assert.equal(c.counts.malformed_record, undefined);
  assert.equal(c.counts.not_deliverable_hop_limit, 1);
  assert.equal(c.hearView(tune, T0, true).items.length, 0); // retracted
  assert.equal(c.health, "ok");
});

// ---- status a reconnect doesn't erase (frond-ear#59, from fe#24's D36 proof)

test("records: a failure a reconnect has cleared is still counted, once, and lastFailure keeps it (frond-ear#59)", () => {
  const c = new RecordConsumer();
  c.reconnected({ joinSnapshot: true });
  const end = (w: number, run = RUN) =>
    rec("snapshot_end", { watermark: w, count: 0, truncated: false }, run);
  c.feed(
    at(1, () => rec("hello", { join_snapshot: true })),
    NOW,
  );
  c.feed(
    at(50, () => landing()),
    NOW,
  );
  c.feed(
    at(50, () => end(50)),
    NOW,
  );
  c.feed(
    at(51, () => frame(51)),
    NOW,
  );
  assert.equal(c.lastFailure, null);
  // The host daemon is SIGKILLed: the connection ends without `bye`.
  c.closed(NOW + 1_000);
  assert.deepEqual(c.healthReasons, ["exit_without_bye"]);
  // Its restart takes three reconnect attempts that never open: still one crash.
  c.closed(NOW + 2_000);
  c.closed(NOW + 4_000);
  c.closed(NOW + 8_000);
  // The new daemon's run: `hello` clears receive health, its snapshot `joined_late`.
  c.reconnected({ joinSnapshot: true });
  c.feed(
    at(1, () => rec("hello", { join_snapshot: true }, "c3d4")),
    NOW + 9_000,
  );
  c.feed(
    at(2, () => landing({}, "c3d4")),
    NOW + 9_000,
  );
  c.feed(
    at(2, () => end(2, "c3d4")),
    NOW + 9_000,
  );
  assert.equal(c.health, "ok");
  assert.deepEqual(c.healthReasons, []);
  assert.deepEqual(
    { ...c.counts },
    { joined_late: 2, exit_without_bye: 1, run_restarted_without_bye: 1 },
  );
  assert.deepEqual(c.lastFailure, {
    reason: "exit_without_bye",
    at: NOW + 1_000,
    run: RUN,
  });
});

test("records: lastFailure is a connection's first failure: a fatal's reason outlives the close it causes (frond-ear#59)", () => {
  const c = started();
  c.feed(rec("fatal", { reason: "state_corrupt" }), NOW + 1);
  c.closed(NOW + 2); // the exit that follows a fatal
  assert.deepEqual(c.healthReasons, ["state_corrupt", "exit_without_bye"]);
  assert.deepEqual(c.lastFailure, {
    reason: "state_corrupt",
    at: NOW + 1,
    run: RUN,
  });
  assert.equal(c.counts.fatal, 1);
  assert.equal(c.counts.state_corrupt, undefined);
  assert.equal(c.counts.exit_without_bye, 1);
  // A later connection's first failure replaces it, though receive health is still
  // `failed` from the last one (only a `hello` clears it): here an unknown major version.
  c.reconnected();
  c.feed(
    { v: "canticle-receptor-record/2", type: "hello", rec_seq: 1, run: "c3d4" },
    NOW + 3,
  );
  const stop = { reason: "record_version", at: NOW + 3, run: RUN };
  assert.deepEqual(c.lastFailure, stop);
  c.closed(NOW + 4);
  assert.deepEqual(c.lastFailure, stop, "its own close is a consequence");
  assert.equal(c.counts.exit_without_bye, 2);
  // Delivery has stopped for good: a later connection's records are ignored, and so is its close.
  c.reconnected();
  c.feed(
    at(1, () => rec("hello")),
    NOW + 5,
  );
  c.closed(NOW + 6);
  assert.deepEqual(c.lastFailure, stop);
  assert.equal(c.counts.exit_without_bye, 2);
});

test("records: with one reader per run, each run's first failure is its own (frond-ear#59)", () => {
  const c = started();
  c.feed(rec("fatal", { reason: "bind_failed" }), NOW + 1);
  c.closed(NOW + 2);
  // The binding restarts the receptor: a new run on a new stream, no bootstrap.
  c.feed(
    at(1, () => rec("hello", {}, "c3d4")),
    NOW + 3,
  );
  c.feed(
    at(2, () => landing({}, "c3d4")),
    NOW + 3,
  );
  assert.equal(c.health, "ok");
  c.closed(NOW + 4);
  assert.deepEqual(c.lastFailure, {
    reason: "exit_without_bye",
    at: NOW + 4,
    run: "c3d4",
  });
  assert.equal(c.counts.exit_without_bye, 2);
  assert.equal(c.counts.run_restarted_without_bye, 1);
});

test("records: a connection that carried only an unreadable line still ends without bye (frond-ear#59)", () => {
  const c = started();
  c.closed(NOW);
  c.reconnected();
  c.feedLine("{not json", NOW + 1); // a malformed bootstrap: the connection is lost
  assert.equal(c.connectionLost, true);
  c.closed(NOW + 2);
  assert.equal(c.counts.exit_without_bye, 2);
  assert.deepEqual(c.lastFailure, {
    reason: "malformed_bootstrap",
    at: NOW + 1,
    run: RUN,
  });
});

/**
 * A stand-in host daemon in its own process, so a test can SIGKILL it: it unlinks a
 * stale socket, listens, and answers each connection's first line with `lines`.
 */
const FAKE_DAEMON = `
const net = require("node:net");
const fs = require("node:fs");
const [path, lines] = process.argv.slice(1);
try { fs.unlinkSync(path); } catch {}
net
  .createServer((s) => {
    s.on("error", () => {});
    s.once("data", () => s.write(lines));
  })
  .listen(path, () => process.stdout.write("ready\\n"));
`;

async function fakeDaemon(path: string, recs: object[]): Promise<ChildProcess> {
  const lines = recs.map((r) => `${JSON.stringify(r)}\n`).join("");
  const child = spawn(process.execPath, ["-e", FAKE_DAEMON, path, lines], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`fake daemon exited ${code}`)),
    );
    child.stdout!.once("data", () => resolve());
  });
  return child;
}

test("record client: a SIGKILLed host daemon still shows in ear_status after the ear reconnects (frond-ear#59)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "canticle-kill-"));
  const path = join(dir, "daemon.sock");
  let now = NOW;
  let attempts = 0;
  const client = new RecordClient({
    socketPath: path,
    tune: { gloss: TUNE },
    logger,
    clock: { now: () => now },
    timers: {
      setTimeout: (fn: () => void) => setTimeout(fn, 5),
      clearTimeout: (t: unknown) => clearTimeout(t as NodeJS.Timeout),
    } as never,
    connect: (p) => {
      attempts += 1;
      return connect(p);
    },
  });
  const status = () =>
    client.status() as {
      state: string;
      receiveHealth: string;
      reasons: string[];
      lastFailure: unknown;
      joinSnapshot: string;
      joinSnapshotFrames?: number;
      run: string | null;
      counts: Record<string, number>;
    };
  const until = async (what: string, ok: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!ok()) {
      assert.ok(Date.now() < deadline, what);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const entryOf = (r: object) => {
    const {
      v: _v,
      type: _t,
      rec_seq: _s,
      run: _r,
      ...rest
    } = r as Record<string, unknown>;
    return rest;
  };
  let daemon: ChildProcess | undefined;
  try {
    // Run a1b2: its join snapshot brings item 40; item 51 surfaces live.
    const item40 = entryOf(frame(40));
    daemon = await fakeDaemon(path, [
      at(1, () => rec("hello", { join_snapshot: true })),
      at(50, () => landing()),
      at(50, () => rec("snapshot", { snap_seq: 1, entry: item40 })),
      at(50, () =>
        rec("snapshot_end", { watermark: 50, count: 1, truncated: false }),
      ),
      at(51, () => frame(51)),
    ]);
    client.start();
    await until(
      "run a1b2's items",
      () => client.hearView("gloss").items.length === 2,
    );
    assert.equal(status().joinSnapshotFrames, 1);
    // SIGKILL: no `bye`, and the socket file stays behind (connect ECONNREFUSED).
    now = NOW + 5_000;
    daemon.kill("SIGKILL");
    await until("the close", () => status().receiveHealth === "failed");
    const before = attempts;
    await until(
      "reconnect attempts that never open",
      () => attempts >= before + 3,
    );
    now = NOW + 9_000;
    // The restarted daemon: a new run, nothing live yet.
    daemon = await fakeDaemon(path, [
      at(1, () => rec("hello", { join_snapshot: true }, "c2be")),
      at(2, () => landing({}, "c2be")),
      at(2, () =>
        rec(
          "snapshot_end",
          { watermark: 2, count: 0, truncated: false },
          "c2be",
        ),
      ),
    ]);
    await until(
      "run c2be's complete join snapshot",
      () => status().run === "c2be" && status().joinSnapshot === "complete",
    );
    const s = status();
    assert.equal(s.state, "connected");
    assert.equal(s.receiveHealth, "ok");
    assert.deepEqual(s.reasons, [], "the reconnect cleared receive health…");
    assert.deepEqual(
      s.lastFailure,
      { reason: "exit_without_bye", at: NOW + 5_000, run: RUN },
      "…but not the failure",
    );
    assert.equal(s.joinSnapshotFrames, 0, "this connection's snapshot");
    assert.deepEqual(s.counts, {
      joined_late: 2,
      snapshot_frames: 1, // the process's, across runs
      exit_without_bye: 1,
      run_restarted_without_bye: 1,
    });
  } finally {
    client.stop();
    daemon?.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
