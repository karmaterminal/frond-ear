// binary-canticle#171 (measurement findings 3–5; cells F9, A1, A4), against #168 §2.4 and
// §2.7a: the record v1 live set admits against the tune, with a share for each tuned
// stream and one for every untuned stream together, and says what it drops; the push
// budget's hold is visible, and what it held until it went off air is reported by the
// next push the budget allows, never by a push beyond it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { iso, renderHear } from "../src/canticle/hear.ts";
import type { HearView } from "../src/canticle/receptor.ts";
import { RecordClient } from "../src/canticle/record-client.ts";
import { MAX_LIVE, RECORD_V } from "../src/canticle/records.ts";
import { StructuredLogger } from "../src/logger.ts";
import { channelInstructions } from "../src/render.ts";
import {
  ALPHA,
  canticleConfig,
  confirm,
  Host,
  OPS,
  order,
  pushes,
  SESSION,
  setup,
  status,
  STRAY,
} from "./canticle-host.ts";

/** A clock for a consumer on its own. */
function clock(value = 1_000_000) {
  const time = { value, now: () => time.value };
  return time;
}

const quietSeqs = (host: Host, stream = "ops.fleet", station = "ops") =>
  host
    .view()
    .items.filter((item) => item.stream === stream && item.station === station)
    .map((item) => Number(item.seq))
    .sort((a, b) => a - b);

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

test("live set (F9, a): an untuned flood that fills the live set can't refuse a quiet tuned stream's items", () => {
  const time = clock();
  const host = new Host(time, ["*:ops.fleet"]);
  host.start();
  // An untuned producer past the bound, its items long-lived: nothing in the set expires.
  for (let n = 1; n <= MAX_LIVE + 300; n++) {
    host.sing(n, { stream: "ops.chatter", ttlMs: 3_600_000 });
  }
  // The quiet tuned stream, one item every 10 s, while the flood goes on at 15 a second.
  let flood = MAX_LIVE + 300;
  for (let n = 1; n <= 20; n++) {
    host.sing(n, { ttlMs: 3_600_000 });
    for (let i = 0; i < 150; i++) {
      host.sing(++flood, { stream: "ops.chatter", ttlMs: 3_600_000 });
    }
    time.value += 10_000;
  }
  assert.deepEqual(quietSeqs(host), range(1, 20), "every quiet item admitted");
  assert.ok(host.consumer.liveSize <= MAX_LIVE, "the live set stays bounded");
});

test("live set (b): a tuned flood can't starve a quiet tuned stream, on another tuned stream or on the same pattern from another station", () => {
  const time = clock();
  const host = new Host(time, ["*:ops.fleet", "*:ops.deploy"]);
  host.start();
  // stray floods a tuned stream; it is hear-only, but tuned all the same.
  for (let n = 1; n <= MAX_LIVE + 300; n++) {
    host.sing(n, { station: "stray", stream: "ops.deploy", ttlMs: 3_600_000 });
  }
  for (let n = 1; n <= 20; n++) host.sing(n, { ttlMs: 3_600_000 });
  assert.deepEqual(quietSeqs(host), range(1, 20), "another tuned stream");

  // `*:ops.fleet` tunes every station's ops.fleet: stray flooding its own can't take ops's.
  const same = new Host(clock(), ["*:ops.fleet"]);
  same.start();
  for (let n = 1; n <= MAX_LIVE + 300; n++) {
    same.sing(n, { station: "stray", ttlMs: 3_600_000 });
  }
  for (let n = 1; n <= 20; n++) same.sing(n, { ttlMs: 3_600_000 });
  assert.deepEqual(quietSeqs(same), range(1, 20), "the same pattern");
  assert.ok(same.consumer.liveSize <= MAX_LIVE);
});

test("live set (c): every record the live set drops degrades receive health with a reason naming the stream class, and is counted per stream", () => {
  const time = clock();
  const host = new Host(time, ["*:ops.fleet", "*:ops.deploy"]);
  host.start();
  const c = host.consumer;
  for (let n = 1; n <= MAX_LIVE + 10; n++) {
    host.sing(n, { stream: "ops.chatter", ttlMs: 60_000 });
  }
  assert.equal(c.health, "degraded", "an untuned refusal degrades");
  assert.ok(
    c.healthReasons.includes("live_overflow_untuned"),
    c.healthReasons.join(),
  );
  assert.equal(c.counts.live_overflow, 10);
  assert.equal(c.counts.live_overflow_untuned, 10);

  // A tuned flood takes every untuned record's place first; past that, its own newest go.
  for (let n = 1; n <= MAX_LIVE + 5; n++) {
    host.sing(n, { station: "stray", stream: "ops.deploy", ttlMs: 60_000 });
  }
  assert.ok(
    c.healthReasons.includes("live_overflow_tuned"),
    c.healthReasons.join(),
  );
  const live = c.liveStatus(time.now());
  assert.equal(live.max, MAX_LIVE);
  assert.deepEqual(live.shares, { "stray:ops.deploy": MAX_LIVE });
  const deploy = live.omitted["stray:ops.deploy"]!;
  const untuned = live.omitted.untuned!;
  assert.equal(deploy.count, 5, JSON.stringify(live));
  assert.equal(untuned.count, MAX_LIVE + 10);
  assert.equal(
    c.counts.live_overflow,
    deploy.total + untuned.total,
    "every drop counted once, against the share that lost it",
  );
  assert.equal(c.counts.live_overflow_tuned, deploy.total);
  assert.equal(c.counts.live_overflow_untuned, untuned.total);
  assert.equal(
    Object.keys(live.omitted).length,
    2,
    "no untuned stream gets state of its own",
  );

  // Now, not since: once every dropped record would have gone off air, the reasons lapse.
  time.value += 61_000;
  host.view();
  assert.equal(c.health, "ok", c.healthReasons.join());
  assert.equal(c.counts.live_overflow, deploy.total + untuned.total);
});

test("live set (F9, a) end to end: with an untuned flood filling the live set, every quiet tuned item is pushed", async () => {
  const { h, host } = setup({ mode: "immediate", maxPushesPerHour: 360 });
  try {
    const shim = h.attach("scribe");
    let flood = 0;
    for (; flood < MAX_LIVE + 300; ) {
      host.sing(++flood, { stream: "ops.chatter", ttlMs: 3_600_000 });
    }
    for (let n = 1; n <= 20; n++) {
      host.sing(n);
      for (let i = 0; i < 150; i++) {
        host.sing(++flood, { stream: "ops.chatter", ttlMs: 3_600_000 });
      }
      h.timers.advance(10_000);
    }
    h.timers.advance(10_000);
    assert.deepEqual(
      pushes(shim).flatMap((push) => order(push.content)),
      range(1, 20).map((n) => `ops:ops.fleet/${n}`),
    );
    // The untuned stream's loss isn't this ear's to be told about in a push.
    assert.ok(
      pushes(shim).every((push) => !/live_overflow/u.test(push.content)),
    );
  } finally {
    h.dispose();
  }
});

test("live set (b) end to end: a hear-only tuned flood can't keep a quiet stream's items from being pushed; hear names the flood's loss as a local omission", async () => {
  const { h, host } = setup({ mode: "immediate", maxPushesPerHour: 360 });
  try {
    const shim = h.attach("scribe");
    for (let n = 1; n <= MAX_LIVE + 300; n++) {
      host.sing(n, {
        station: "stray",
        stream: "ops.deploy",
        ttlMs: 3_600_000,
      });
    }
    for (let n = 1; n <= 5; n++) {
      host.sing(n);
      h.timers.advance(10_000);
    }
    assert.deepEqual(
      pushes(shim).flatMap((push) => order(push.content)),
      range(1, 5).map((n) => `ops:ops.fleet/${n}`),
    );
    // stray isn't on wakeKeys: its loss is hear's to show, not a push's.
    assert.ok(pushes(shim).every((push) => !/stray/u.test(push.content)));
    const heard = (await h.call(shim, "hear", {})).text;
    assert.match(
      heard,
      /^local omission \(live_overflow\): stray:ops\.deploy: \d+ records? dropped by frond-ear's full live set between \S+Z and \S+Z; they would be on air until \S+Z\.$/mu,
    );
  } finally {
    h.dispose();
  }
});

test("live set: what the live set drops on an allowlisted tuned stream is in the next push's coverage note, as a local omission with its reason", async () => {
  const { h, host } = setup({ mode: "immediate", maxPushesPerHour: 360 });
  try {
    const shim = h.attach("scribe");
    const at = h.clock.now();
    for (let n = 1; n <= MAX_LIVE + 50; n++) {
      host.sing(n, { stream: "ops.deploy", ttlMs: 3_600_000 });
    }
    h.timers.advance(6_000);
    const push = pushes(shim)[0]!;
    assert.match(
      push.content,
      new RegExp(
        `^local omissions \\(frond-ear withheld these itself\\):\\n- ops:ops\\.deploy: 50 dropped by frond-ear's full live set \\(live_overflow; between ${iso(at)} and ${iso(at)}\\)\\.$`,
        "mu",
      ),
    );
    // Told once: the next push doesn't repeat it.
    h.timers.advance(6_000);
    assert.doesNotMatch(pushes(shim)[1]!.content, /live_overflow/u);
  } finally {
    h.dispose();
  }
});

test("push budget (A4, d): what the budget held until it went off air is reported by the next push the budget allows: count, stream, heard range, reason push_budget", async () => {
  const { h, host } = setup({ mode: "immediate", maxPushesPerHour: 2 });
  try {
    const shim = h.attach("scribe");
    host.sing(1);
    h.timers.advance(6_000);
    host.sing(2);
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 2, "the hour's two pushes are spent");
    const firstPush = status(h).lastPushAt! - 6_000;
    const heard3 = h.clock.now() - 500;
    host.sing(3, { ttlMs: 60_000 });
    h.timers.advance(10_000);
    const heard4 = h.clock.now() - 500;
    host.sing(4, { ttlMs: 60_000 });
    h.timers.advance(1_000);
    assert.equal(status(h).held, "push_budget");
    h.timers.advance(70_000);
    assert.equal(status(h).counts.off_air_unpushed, 2);
    assert.equal(pushes(shim).length, 2);
    host.sing(5, { ttlMs: 7_200_000 });
    // The first push leaves the rolling hour an hour after it went out.
    h.timers.advance(firstPush + 3_600_000 + 1_000 - h.clock.now());
    assert.equal(pushes(shim).length, 3);
    const next = pushes(shim)[2]!.content;
    assert.deepEqual(order(next), ["ops:ops.fleet/5"]);
    assert.ok(
      next.includes(
        `\n- ops:ops.fleet: 2 went off air unpushed while the hour's push budget was spent (push_budget; heard ${iso(heard3)} to ${iso(heard4)}).`,
      ),
      next,
    );
    // No push beyond the budget, and nothing told twice.
    h.timers.advance(3_600_000);
    assert.equal(pushes(shim).length, 3);
  } finally {
    h.dispose();
  }
});

test('push budget (e): "N more wait for the next push" is true when written: it says when the budget holds them, and the next push reports any that went off air', async () => {
  const { h, host } = setup({
    mode: "immediate",
    maxItems: 1,
    maxPushesPerHour: 1,
  });
  try {
    const shim = h.attach("scribe");
    const heard2 = h.clock.now() - 500;
    host.sing(1);
    host.sing(2, { ttlMs: 30_000 });
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1);
    const pushedAt = status(h).lastPushAt!;
    assert.match(
      pushes(shim)[0]!.content,
      new RegExp(
        `\\n\\(1 more record waits for the next push; the hour's push budget holds it until ${iso(pushedAt + 3_600_000)}, and any that go off air first are reported then\\.\\)$`,
        "u",
      ),
    );
    // Record 2 goes off air while held; nothing new comes. The next push still comes,
    // when the hour has room, and says what became of it.
    h.timers.advance(pushedAt + 3_600_000 + 6_000 - h.clock.now());
    assert.equal(pushes(shim).length, 2);
    const note = pushes(shim)[1]!;
    assert.deepEqual(order(note.content), []);
    assert.equal(note.meta.count, "0");
    assert.match(
      note.content,
      /^canticle: no new records from allowlisted stations \(immediate\); a coverage note for what frond-ear withheld\./u,
    );
    assert.ok(
      note.content.includes(
        `\n- ops:ops.fleet: 1 went off air unpushed while the hour's push budget was spent (push_budget; heard ${iso(heard2)} to ${iso(heard2)}).`,
      ),
      note.content,
    );
    h.timers.advance(3_600_000);
    assert.equal(pushes(shim).length, 2, "told once");
  } finally {
    h.dispose();
  }
});

test("push budget (e), finding 3: a record a push said waits, routed to a report it expires before, is reported by a push of its own", async () => {
  const { h, host } = setup({
    mode: "immediate",
    maxAgeMs: 10_000,
    windowMs: 60_000,
  });
  try {
    const shim = h.attach("scribe");
    const heard = h.clock.now() - 500;
    host.sing(1);
    host.sing(2, { age: 20_000, ttlMs: 20_000 }); // too old for immediate: the next report
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1);
    assert.match(
      pushes(shim)[0]!.content,
      /\n\(1 more record waits for the next push\.\)$/u,
    );
    h.timers.advance(30_000);
    assert.equal(pushes(shim).length, 2);
    const note = pushes(shim)[1]!.content;
    assert.deepEqual(order(note), []);
    assert.ok(
      note.includes(
        `\n- ops:ops.fleet: 1 went off air unpushed while waiting for a push (expired_waiting; heard ${iso(heard)} to ${iso(heard)}).`,
      ),
      note,
    );
    h.timers.advance(120_000);
    assert.equal(pushes(shim).length, 2, "told once");
  } finally {
    h.dispose();
  }
});

test("push budget (f): with nothing new sung, held records push on their own, as one push, once the hour has room", async () => {
  const { h, host } = setup({ mode: "immediate", maxPushesPerHour: 1 });
  try {
    const shim = h.attach("scribe");
    host.sing(1);
    h.timers.advance(6_000);
    const pushedAt = status(h).lastPushAt!;
    host.sing(2, { ttlMs: 7_200_000 });
    host.sing(3, { ttlMs: 7_200_000 });
    h.timers.advance(pushedAt + 3_600_000 - 1_000 - h.clock.now());
    assert.equal(pushes(shim).length, 1, "held for the hour");
    h.timers.advance(2_000);
    assert.equal(pushes(shim).length, 2);
    assert.deepEqual(order(pushes(shim)[1]!.content), [
      "ops:ops.fleet/2",
      "ops:ops.fleet/3",
    ]);
    h.timers.advance(3_600_000);
    assert.equal(pushes(shim).length, 2);
  } finally {
    h.dispose();
  }
});

test("push budget (f): with nothing new sung and every held record gone off air, the hour's next push still comes, once, with the coverage note", async () => {
  const { h, host } = setup({ mode: "immediate", maxPushesPerHour: 1 });
  try {
    const shim = h.attach("scribe");
    host.sing(1);
    h.timers.advance(6_000);
    const pushedAt = status(h).lastPushAt!;
    const heard = h.clock.now() - 500;
    host.sing(2, { ttlMs: 60_000 });
    host.sing(3, { ttlMs: 60_000 });
    h.timers.advance(120_000);
    assert.equal(status(h).counts.off_air_unpushed, 2);
    h.timers.advance(pushedAt + 3_600_000 - 1_000 - h.clock.now());
    assert.equal(pushes(shim).length, 1, "held for the hour");
    h.timers.advance(2_000);
    assert.equal(pushes(shim).length, 2);
    const note = pushes(shim)[1]!.content;
    assert.deepEqual(order(note), []);
    assert.ok(
      note.includes(
        `\n- ops:ops.fleet: 2 went off air unpushed while the hour's push budget was spent (push_budget; heard ${iso(heard)} to ${iso(heard)}).`,
      ),
      note,
    );
    h.timers.advance(3_600_000);
    assert.equal(pushes(shim).length, 2);
  } finally {
    h.dispose();
  }
});

test("push budget: while the budget holds records, ear_status and hear name the hold and when it lifts", async () => {
  const { h, host } = setup({ mode: "immediate", maxPushesPerHour: 1 });
  try {
    const shim = h.attach("scribe");
    host.sing(1);
    h.timers.advance(6_000);
    const pushedAt = status(h).lastPushAt!;
    host.sing(2, { ttlMs: 7_200_000 });
    h.timers.advance(10_000);
    assert.equal(status(h).held, "push_budget");
    assert.equal(status(h).heldUntil, pushedAt + 3_600_000);
    const heard = (await h.call(shim, "hear", {})).text;
    assert.match(
      heard,
      new RegExp(
        `^canticle delivery: held \\(push_budget\\): the hour's 1 push is spent until ${iso(pushedAt + 3_600_000)}; 1 record waits\\.$`,
        "mu",
      ),
    );
    await confirm(shim);
  } finally {
    h.dispose();
  }
  // The session is told what such a note is.
  assert.match(
    channelInstructions(canticleConfig({ mode: "immediate" }), "scribe"),
    /A push may end with a local omissions note: records frond-ear itself withheld[^.]*, each with its reason; one with no records carries only that note\./u,
  );
});

test("live set: a stream tuned later gets a share of its own from then on, and hear says its earlier records may be missing", () => {
  const time = clock();
  const host = new Host(time, ["*:ops.fleet"]);
  host.start();
  for (let n = 1; n <= MAX_LIVE + 50; n++) {
    host.sing(n, { stream: "ops.chatter", ttlMs: 600_000 });
  }
  host.sing(1, { stream: "ops.deploy", ttlMs: 600_000 }); // untuned yet: the full share's own
  const tune = ["*:ops.fleet", "*:ops.deploy"];
  const deploy = () =>
    host.consumer
      .hearView(tune, time.now(), true)
      .items.filter((item) => item.stream === "ops.deploy")
      .map((item) => Number(item.seq));
  assert.deepEqual(deploy(), [], "refused while untuned");
  time.value += 1_000;
  const tunedAt = time.now();
  host.tune = tune;
  host.sing(2, { stream: "ops.deploy", ttlMs: 600_000 });
  assert.deepEqual(deploy(), [2], "admitted once tuned, in a share of its own");
  const view = host.consumer.hearView(tune, time.now(), true);
  assert.deepEqual(view.retuned, [
    {
      pattern: "*:ops.deploy",
      at: tunedAt,
      dropped: 51,
      until: 1_000_000 + 600_000,
    },
  ]);
  assert.match(
    renderHear(view, { limit: 1, maxChars: 6_000 }),
    new RegExp(
      `^coverage unknown: \\*:ops\\.deploy was tuned at ${iso(tunedAt)}, while frond-ear's live set was dropping untuned records \\(51 that would be on air until ${iso(1_600_000)}\\); its records from before then may be missing, how many unknown \\(local omission, live_overflow\\)\\.$`,
      "mu",
    ),
  );
  // An ear that doesn't tune the pattern isn't told; once those records would be off
  // air, nobody is.
  assert.equal(
    host.consumer.hearView(["*:ops.fleet"], time.now(), true).retuned,
    undefined,
  );
  time.value = 1_600_001;
  assert.equal(
    host.consumer.hearView(tune, time.now(), true).retuned,
    undefined,
  );
});

test("live set: a new run or lost records close what the set dropped before; a rejoin's hello that clears a reason still open raises it again", () => {
  const time = clock();
  const host = new Host(time, ["*:ops.fleet"]);
  host.start();
  for (let n = 1; n <= MAX_LIVE + 5; n++) {
    host.sing(n, { stream: "ops.chatter", ttlMs: 600_000 });
  }
  const c = host.consumer;
  assert.ok(c.healthReasons.includes("live_overflow_untuned"));
  // A rejoin awaiting its join snapshot keeps what it holds, and its bootstrap clears
  // receive health; the window is still open, so receive health says so again.
  c.reconnected({ joinSnapshot: true });
  c.feed(
    {
      v: RECORD_V,
      type: "hello",
      rec_seq: 1,
      run: host.run,
      join_snapshot: true,
    },
    time.now(),
  );
  assert.ok(!c.healthReasons.includes("live_overflow_untuned"));
  host.view();
  assert.ok(c.healthReasons.includes("live_overflow_untuned"), "raised again");
  assert.equal(c.counts.live_overflow_untuned, 5, "and not counted again");

  // A rec_seq gap: everything heard before it goes, and with it what the set dropped.
  const gap = new Host(time, ["*:ops.fleet"]);
  gap.start();
  for (let n = 1; n <= MAX_LIVE + 5; n++) {
    gap.sing(n, { stream: "ops.chatter", ttlMs: 600_000 });
  }
  gap.consumer.feed(
    { v: RECORD_V, type: "health", rec_seq: 1_000_000, run: gap.run },
    time.now(),
  );
  assert.ok(gap.consumer.healthReasons.includes("records_lost"));
  assert.ok(!gap.consumer.healthReasons.includes("live_overflow_untuned"));
  assert.equal(gap.consumer.liveStatus(time.now()).omitted.untuned!.count, 0);
  assert.equal(gap.consumer.liveSize, 0);

  const next = new Host(time, ["*:ops.fleet"]);
  next.start();
  for (let n = 1; n <= MAX_LIVE + 5; n++) {
    next.sing(n, { stream: "ops.chatter", ttlMs: 600_000 });
  }
  next.start("c3d4"); // a new run: nothing from the old one can surface, drops included
  const status = next.consumer.liveStatus(time.now());
  assert.equal(status.omitted.untuned!.count, 0);
  assert.equal(status.omitted.untuned!.total, 5, "the count since start stays");
  assert.equal(next.view().untunedOmitted, undefined);
  assert.ok(!next.consumer.healthReasons.includes("live_overflow_untuned"));
});

test("live set: ear_status shows the live set, its shares and what each dropped, and receive health with the reason", () => {
  const time = clock();
  const client = new RecordClient({
    socketPath: "/nonexistent/canticle.sock",
    tune: { scribe: ["*:ops.fleet"], other: ["*:ops.deploy"] },
    logger: new StructuredLogger(() => {}),
    clock: time,
  });
  const host = new Host(time);
  // Feed the client's own consumer, as its socket would.
  const feed = (type: string, extra: Record<string, unknown>, seq: number) =>
    client.consumer.feed(
      { v: RECORD_V, type, rec_seq: seq, run: "a1b2", ...extra },
      time.now(),
    );
  let seq = 0;
  feed("hello", {}, ++seq);
  feed("landing_state", { mute: null, breaker: "closed" }, ++seq);
  for (let n = 1; n <= MAX_LIVE + 3; n++) {
    feed(
      "frame",
      host.fields(n, { station: "stray", stream: "ops.deploy" }),
      ++seq,
    );
  }
  feed("frame", host.fields(1), ++seq);
  const s = client.status() as {
    receiveHealth: string;
    reasons: string[];
    liveSet: {
      size: number;
      max: number;
      shares: Record<string, number>;
      omitted: Record<string, { count: number; total: number }>;
    };
  };
  assert.equal(s.receiveHealth, "degraded");
  assert.deepEqual(s.reasons, ["live_overflow_tuned"]);
  assert.equal(s.liveSet.size, MAX_LIVE);
  assert.equal(s.liveSet.max, MAX_LIVE);
  assert.deepEqual(s.liveSet.shares, {
    "stray:ops.deploy": MAX_LIVE - 1,
    "ops:ops.fleet": 1,
  });
  assert.equal(s.liveSet.omitted["stray:ops.deploy"]!.total, 4);
  assert.equal(s.liveSet.omitted["stray:ops.deploy"]!.count, 4);
});

test("hear: local omissions name at most five streams and count the rest; a stream filter narrows them", () => {
  const now = 2_000_000;
  const omitted = Array.from({ length: 7 }, (_, i) => ({
    station: "ops",
    stream: `s${i}`,
    key: "f6eecf2f43082a97",
    count: i + 1,
    total: i + 1,
    pushable: i + 1,
    pushableTotal: i + 1,
    evicted: 0,
    evictedTotal: 0,
    serial: i + 1,
    from: now - 10_000,
    to: now - 1_000,
    until: now + 60_000,
  }));
  const view: HearView = {
    now,
    tuned: true,
    listening: true,
    blind: false,
    lastDatagramAt: now - 1_000,
    stations: [],
    items: [],
    omitted: [
      ...omitted,
      { ...omitted[0]!, stream: "lapsed", until: now - 1, count: 3 },
    ],
  };
  const out = renderHear(view, { limit: 10, maxChars: 6_000 });
  assert.equal(out.match(/^local omission \(live_overflow\): /gmu)?.length, 5);
  assert.match(
    out,
    /^\(2 more tuned streams lost records to frond-ear's full live set; ear_status counts them\.\)$/mu,
  );
  assert.doesNotMatch(
    out,
    /lapsed/u,
    "one whose records are all off air is done",
  );
  const one = renderHear(view, { stream: "*:s3", limit: 10, maxChars: 6_000 });
  assert.match(
    one,
    new RegExp(
      `^local omission \\(live_overflow\\): ops:s3: 4 records dropped by frond-ear's full live set between ${iso(now - 10_000)} and ${iso(now - 1_000)}; they would be on air until ${iso(now + 60_000)}\\.$`,
      "mu",
    ),
  );
  assert.equal(one.match(/^local omission/gmu)?.length, 1);
  assert.ok(
    renderHear(view, { limit: 10, maxChars: 300 }).length <= 300,
    "within the cap",
  );
});

test("coverage note: a push of the note alone is a canticle batch; naming it echoes nothing and marks no Discord event seen; given back unconfirmed, the note is owed again", async () => {
  const { h, host } = setup({ mode: "immediate", maxPushesPerHour: 1 });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1);
    h.timers.advance(6_000);
    await confirm(shim);
    const pushedAt = status(h).lastPushAt!;
    host.sing(2, { ttlMs: 60_000 });
    h.timers.advance(pushedAt + 3_600_000 + 6_000 - h.clock.now());
    assert.equal(pushes(shim).length, 2);
    const note = pushes(shim)[1]!;
    const line =
      /^- ops:ops\.fleet: 1 went off air unpushed while the hour's push budget was spent \(push_budget; heard \S+Z to \S+Z\)\.$/mu;
    assert.match(note.content, line);
    const acked = await h.call(shim, "ack", { batch_id: note.meta.batch_id });
    assert.equal(
      acked.text,
      "0 canticle records echoed: that push was a coverage note and carried no record",
    );
    // The shim goes before saying it wrote the note: frond-ear gives it back.
    shim.close();
    assert.equal(status(h).pushesLastHour, 0, "the budget's push with it");
    const next = h.attach("scribe", { sessionId: SESSION });
    h.timers.advance(6_000);
    assert.equal(pushes(next).length, 1);
    assert.match(pushes(next)[0]!.content, line, "owed again, and told");
    await confirm(next);
    h.timers.advance(3_600_000);
    assert.equal(pushes(next).length, 1, "once");
    assert.equal(status(h).counts.coverage_notes, 2);
  } finally {
    h.dispose();
  }
});

test("coverage note: what the live set dropped before the ear delivered, and is off air by now, isn't reported once it does", async () => {
  const { h, host } = setup(undefined);
  try {
    const shim = h.attach("scribe");
    for (let n = 1; n <= MAX_LIVE + 20; n++) {
      host.sing(n, { stream: "ops.deploy", ttlMs: 30_000 });
    }
    h.timers.advance(31_000); // every dropped record is off air
    h.daemon.reloadConfig(
      canticleConfig({ mode: "immediate", maxPushesPerHour: 360 }),
    );
    host.sing(1);
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1);
    assert.doesNotMatch(pushes(shim)[0]!.content, /live_overflow/u);
  } finally {
    h.dispose();
  }
});

test("coverage note: what went off air while no session held the ear or frond-ear was paused is named with that reason in the next push", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    host.sing(1, { ttlMs: 10_000 });
    h.timers.advance(15_000);
    h.daemon.reloadConfig(
      canticleConfig({ mode: "immediate" }, {}, { paused: true }),
    );
    const shim = h.attach("scribe");
    host.sing(2, { ttlMs: 10_000 });
    h.timers.advance(15_000);
    h.daemon.reloadConfig(canticleConfig({ mode: "immediate" }));
    host.sing(3);
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1);
    const push = pushes(shim)[0]!.content;
    assert.deepEqual(order(push), ["ops:ops.fleet/3"]);
    assert.match(
      push,
      /^- ops:ops\.fleet: 1 went off air unpushed while no session held this ear \(no_session; heard \S+Z to \S+Z\)\.$/mu,
    );
    assert.match(
      push,
      /^- ops:ops\.fleet: 1 went off air unpushed while frond-ear was paused \(paused; heard \S+Z to \S+Z\)\.$/mu,
    );
  } finally {
    h.dispose();
  }
});

test("review 1: what the live set drops of relayed or wake-derived records wakes nobody: no note of its own, nothing in a push; hear still names it", async () => {
  const { h, host } = setup({ mode: "immediate", maxPushesPerHour: 360 });
  try {
    const shim = h.attach("scribe");
    for (let n = 1; n <= MAX_LIVE + 20; n++) {
      host.sing(n, {
        stream: "ops.deploy",
        ttlMs: 3_600_000,
        ...(n % 2 === 0 ? { hop: 1 } : { flags: { wake_derived: true } }),
      });
    }
    h.timers.advance(60_000);
    assert.equal(
      pushes(shim).length,
      0,
      "nothing a push could carry, so no push",
    );
    assert.equal(status(h).counts.live_overflow, undefined);
    assert.match(
      (await h.call(shim, "hear", {})).text,
      /^local omission \(live_overflow\): ops:ops\.deploy: 20 records dropped by frond-ear's full live set /mu,
    );
    host.sing(1);
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1);
    assert.doesNotMatch(pushes(shim)[0]!.content, /live_overflow/u);
  } finally {
    h.dispose();
  }
});

test("review 2: what the budget held until it went off air is still told after frond-ear restarts, and a note a crash left unconfirmed is told again", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-withheld-"));
  const path = join(directory, "ear.db");
  const delivery = { mode: "immediate", maxPushesPerHour: 1 };
  const line =
    /^- ops:ops\.fleet: 1 went off air unpushed while the hour's push budget was spent \(push_budget; heard \S+Z to \S+Z\)\.$/mu;
  try {
    // A restart during the hold: the owed note is saved, and the hour too.
    const first = setup(delivery, {}, {}, { path });
    let pushedAt: number;
    try {
      const shim = first.h.attach("scribe", { sessionId: SESSION });
      first.host.sing(1);
      first.h.timers.advance(6_000);
      await confirm(shim);
      pushedAt = status(first.h).lastPushAt!;
      first.host.sing(2, { ttlMs: 60_000 });
      first.h.timers.advance(120_000);
      assert.equal(status(first.h).counts.off_air_unpushed, 1);
    } finally {
      first.h.dispose();
    }
    const second = setup(delivery, {}, {}, { path });
    let at: number;
    try {
      second.h.clock.value = pushedAt + 3_600_000 + 1_000;
      const shim = second.h.attach("scribe", { sessionId: SESSION });
      second.h.timers.advance(6_000);
      assert.equal(pushes(shim).length, 1, "told after the restart");
      assert.match(pushes(shim)[0]!.content, line);
      at = second.h.clock.now();
      // The process dies before the host confirms that note.
      second.h.store.close();
      rmSync(second.h.directory, { recursive: true, force: true });
    } catch (error) {
      second.h.dispose();
      throw error;
    }
    const third = setup(delivery, {}, {}, { path });
    try {
      third.h.clock.value = at + 10_000;
      const shim = third.h.attach("scribe", { sessionId: SESSION });
      third.h.timers.advance(6_000);
      assert.equal(pushes(shim).length, 1, "given back, and told again");
      assert.match(pushes(shim)[0]!.content, line);
      await confirm(shim);
      third.h.timers.advance(3_600_000);
      assert.equal(pushes(shim).length, 1, "once confirmed, done");
    } finally {
      third.h.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("review 3: the budget's hold is named the moment a push spends the hour and leaves records waiting, not only once the next push falls due", async () => {
  const { h, host } = setup({
    mode: "immediate",
    maxItems: 1,
    maxPushesPerHour: 1,
  });
  try {
    const shim = h.attach("scribe");
    host.sing(1);
    host.sing(2, { ttlMs: 7_200_000 });
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1);
    assert.equal(status(h).held, "push_budget", "on the pass that spent it");
    assert.equal(status(h).heldUntil, status(h).lastPushAt! + 3_600_000);
    assert.match(
      (await h.call(shim, "hear", {})).text,
      /^canticle delivery: held \(push_budget\): the hour's 1 push is spent until \S+Z; 1 record waits\.$/mu,
    );
  } finally {
    h.dispose();
  }
});

test("review 4: past 256 tuned streams with drops, an entry whose records are all off air makes room; only with every entry open do the rest share one count", () => {
  const time = clock();
  const host = new Host(time, ["*:x"]);
  host.start();
  const key = (i: number) => i.toString(16).padStart(16, "0");
  const fill = (from: number) => {
    // 256 stations, 16 records each: the set exactly full, every share equal.
    for (let i = from; i < from + 256; i++) {
      for (let n = 1; n <= 16; n++) {
        host.sing(n, {
          station: `s${i}`,
          key: key(i),
          stream: "x",
          ttlMs: 10_000,
        });
      }
    }
    // One more each: every share holds as many as the most, so each refuses its own.
    for (let i = from; i < from + 256; i++) {
      host.sing(17, {
        station: `s${i}`,
        key: key(i),
        stream: "x",
        ttlMs: 10_000,
      });
    }
  };
  fill(0);
  let omitted = host.consumer.liveStatus(time.now()).omitted;
  assert.equal(Object.keys(omitted).length, 256);
  // A 257th stream loses records while every entry is open: the shared count.
  for (let n = 1; n <= 20; n++) {
    host.sing(n, {
      station: "s999",
      key: key(999),
      stream: "x",
      ttlMs: 10_000,
    });
  }
  omitted = host.consumer.liveStatus(time.now()).omitted;
  assert.ok(omitted.other!.total > 0, JSON.stringify(Object.keys(omitted)));
  assert.equal(omitted["s999:x"], undefined);
  // Once those records are all off air, new streams get entries of their own again.
  time.value += 11_000;
  fill(256);
  omitted = host.consumer.liveStatus(time.now()).omitted;
  for (let i = 256; i < 512; i++) assert.ok(omitted[`s${i}:x`], `s${i}:x`);
  const tuned = Object.keys(omitted).filter((key) => key.includes(":"));
  assert.ok(tuned.length <= 256, `${tuned.length} entries`);
  const view = host.consumer.hearView(["*:x"], time.now(), true);
  assert.equal(view.omitted!.filter((o) => o.count > 0).length, 256);
});

test("review 5: a push given back unconfirmed keeps each note as it was: one that rode with records rides with the next push, never on a push of its own", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1, { ttlMs: 20_000 });
    host.sing(2, { ttlMs: 3_000 }); // off air before the debounce closes
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1);
    assert.match(pushes(shim)[0]!.content, /\(expired_waiting; heard/u);
    h.timers.advance(20_000); // record 1 goes off air too, still unconfirmed
    shim.close();
    const next = h.attach("scribe", { sessionId: SESSION });
    h.timers.advance(60_000);
    assert.equal(
      pushes(next).length,
      0,
      "no push of its own for a note that rode",
    );
    host.sing(3);
    h.timers.advance(6_000);
    assert.equal(pushes(next).length, 1);
    const push = pushes(next)[0]!.content;
    assert.deepEqual(order(push), ["ops:ops.fleet/3"]);
    assert.match(
      push,
      /^- ops:ops\.fleet: 1 went off air unpushed while waiting for a push \(expired_waiting; heard \S+Z to \S+Z\)\.$/mu,
    );
    assert.match(push, /^ops:ops\.fleet: 1 went off air unpushed\.$/mu);
  } finally {
    h.dispose();
  }
});

test("coverage note: saved notes that don't read are dropped with a warning, and delivery goes on", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    h.store.setRuntimeState("canticle.withheld.scribe", "null");
    const shim = h.attach("scribe");
    host.sing(1);
    h.timers.advance(6_000);
    assert.deepEqual(order(pushes(shim)[0]!.content), ["ops:ops.fleet/1"]);
  } finally {
    h.dispose();
  }
});

// 🍃's review of #119 (6019901734): untuned records give way first; the admission bound as
// it is; drops past the streams counted one by one; no declared shape; one count per record.

/** What a push reports of `stream`'s records it didn't carry: its coverage note and footer. */
function reported(content: string, stream: string): number {
  let n = 0;
  for (const line of content.split("\n")) {
    if (line.startsWith(`- ${stream}: `)) {
      n += Number(/^- \S+: (\d+) /u.exec(line)![1]);
    } else if (line.startsWith(`${stream}: `)) {
      for (const m of line.matchAll(
        /(\d+) (?:went off air unpushed|dropped from a full buffer)/gu,
      )) {
        n += Number(m[1]);
      }
    }
  }
  return n;
}

/** Records a push carried on `stream`, and those it reports it didn't. */
function tally(shim: Parameters<typeof pushes>[0], stream: string) {
  const all = pushes(shim);
  return {
    pushed: all.flatMap((push) =>
      order(push.content).filter((r) => r.startsWith(`${stream}/`)),
    ).length,
    reported: all.reduce((n, push) => n + reported(push.content, stream), 0),
  };
}

test("#119 review, blocker (i): a tuned stream's long-lived records stay through an untuned flood; only untuned records give way or are refused", () => {
  const time = clock();
  const host = new Host(time, ["*:ops.fleet"]);
  host.start();
  for (let n = 1; n <= 3_000; n++) host.sing(n, { ttlMs: 3_600_000 });
  for (let n = 1; n <= 6_000; n++) {
    host.sing(n, { stream: "ops.chatter", ttlMs: 3_600_000 });
  }
  assert.deepEqual(quietSeqs(host), range(1, 3_000), "no tuned record evicted");
  const c = host.consumer;
  const live = c.liveStatus(time.now());
  assert.deepEqual(live.shares, {
    "ops:ops.fleet": 3_000,
    untuned: MAX_LIVE - 3_000,
  });
  assert.equal(live.omitted["ops:ops.fleet"], undefined);
  assert.equal(live.omitted.untuned!.total, 6_000 - (MAX_LIVE - 3_000));
  assert.deepEqual(c.healthReasons, ["live_overflow_untuned"]);
  assert.equal(c.counts.live_overflow_tuned, undefined);
});

test("#119 review, blocker (ii): tuned and untuned at 2048 each, a new tuned record gets in and the oldest untuned one gives up its place; an untuned record never takes a tuned one's", () => {
  const time = clock();
  const host = new Host(time, ["*:ops.fleet", "*:ops.deploy"]);
  host.start();
  const half = MAX_LIVE / 2;
  for (let n = 1; n <= half; n++) host.sing(n, { ttlMs: 3_600_000 });
  for (let n = 1; n <= half; n++) {
    host.sing(n, { stream: "ops.chatter", ttlMs: 3_600_000 });
  }
  host.sing(half + 1, { ttlMs: 3_600_000 });
  assert.deepEqual(quietSeqs(host), range(1, half + 1), "admitted");
  const c = host.consumer;
  const chatter = () =>
    c
      .hearView(["*:ops.chatter"], time.now(), true)
      .items.map((item) => Number(item.seq))
      .sort((a, b) => a - b);
  assert.deepEqual(chatter(), range(2, half), "the oldest untuned one went");
  assert.deepEqual(c.liveStatus(time.now()).shares, {
    "ops:ops.fleet": half + 1,
    untuned: half - 1,
  });
  assert.equal(c.liveStatus(time.now()).omitted.untuned!.count, 1);

  // An untuned record at a full set is refused, whatever the tuned shares hold.
  host.sing(half + 1, { stream: "ops.chatter", ttlMs: 3_600_000 });
  assert.deepEqual(chatter(), range(2, half));
  assert.equal(c.liveStatus(time.now()).omitted.untuned!.count, 2);

  // Only once no untuned record is left does the largest tuned share give way.
  for (let n = 1; n <= MAX_LIVE; n++) {
    host.sing(n, { stream: "ops.deploy", ttlMs: 3_600_000 });
  }
  assert.deepEqual(c.liveStatus(time.now()).shares, {
    "ops:ops.fleet": half,
    "ops:ops.deploy": half,
  });
  assert.deepEqual(chatter(), []);
  assert.deepEqual(quietSeqs(host), range(2, half + 1), "its oldest went");

  // A set full of tuned records refuses an untuned one, with no untuned share to give way.
  const full = new Host(clock(), ["*:ops.fleet"]);
  full.start();
  for (let n = 1; n <= MAX_LIVE; n++) full.sing(n, { ttlMs: 3_600_000 });
  full.sing(1, { stream: "ops.chatter", ttlMs: 3_600_000 });
  assert.deepEqual(quietSeqs(full), range(1, MAX_LIVE));
  const status = full.consumer.liveStatus(full.now);
  assert.deepEqual(status.shares, { "ops:ops.fleet": MAX_LIVE });
  assert.equal(status.omitted.untuned!.count, 1);
});

test("#119 review, blocker: records a retune leaves untuned give way first to a tuned arrival, though a tuned share holds more", () => {
  const time = clock();
  const host = new Host(time, ["*:ops.fleet", "*:ops.deploy"]);
  host.start();
  for (let n = 1; n <= 3_000; n++) host.sing(n, { ttlMs: 3_600_000 });
  for (let n = 1; n <= MAX_LIVE - 3_000; n++) {
    host.sing(n, { stream: "ops.deploy", ttlMs: 3_600_000 });
  }
  host.tune = ["*:ops.fleet"];
  host.sing(1, { station: "alpha", ttlMs: 3_600_000 });
  assert.deepEqual(quietSeqs(host, "ops.fleet", "alpha"), [1]);
  assert.deepEqual(quietSeqs(host), range(1, 3_000), "no tuned record went");
  const c = host.consumer;
  const deploy = c
    .hearView(["*:ops.deploy"], time.now(), true)
    .items.map((item) => Number(item.seq))
    .sort((a, b) => a - b);
  assert.deepEqual(
    deploy,
    range(2, MAX_LIVE - 3_000),
    "the oldest untuned one",
  );
  const live = c.liveStatus(time.now());
  assert.deepEqual(live.shares, {
    "ops:ops.fleet": 3_000,
    untuned: MAX_LIVE - 3_001,
    "alpha:ops.fleet": 1,
  });
  assert.equal(live.omitted.untuned!.count, 1);
  assert.equal(live.omitted["ops:ops.fleet"], undefined);
});

test("#119 review 2: a tuned record finds room only if some tuned share holds two more than its own; a `*:` tune over 4096 stations of one record each refuses a new quiet stream, counts it and degrades receive health", () => {
  const key = (i: number) => i.toString(16).padStart(16, "0");
  const singer = (host: Host) => (i: number, n: number) =>
    host.sing(n, {
      station: `s${i}`,
      key: key(i),
      stream: "x",
      ttlMs: 3_600_000,
    });
  const time = clock();
  const host = new Host(time, ["*:x"]);
  host.start();
  const sing = singer(host);
  for (let i = 0; i < MAX_LIVE; i++) sing(i, 1);
  sing(MAX_LIVE, 1); // a new quiet stream: every share holds one, so none gives way
  const c = host.consumer;
  const live = c.liveStatus(time.now());
  assert.equal(live.size, MAX_LIVE);
  assert.equal(live.shares[`s${MAX_LIVE}:x`], undefined, "refused");
  assert.equal(live.omitted[`s${MAX_LIVE}:x`]!.count, 1, "counted");
  assert.equal(c.health, "degraded");
  assert.deepEqual(c.healthReasons, ["live_overflow_tuned"]);

  // One station holding two (one station fewer): the newcomer gets in, and that station's
  // oldest record goes.
  const time2 = clock();
  const two = new Host(time2, ["*:x"]);
  two.start();
  const sing2 = singer(two);
  for (let i = 0; i < MAX_LIVE - 1; i++) sing2(i, 1);
  sing2(0, 2);
  sing2(MAX_LIVE, 1);
  const seqs = (station: string) =>
    two
      .view()
      .items.filter((item) => item.station === station)
      .map((item) => Number(item.seq));
  assert.deepEqual(seqs(`s${MAX_LIVE}`), [1], "admitted");
  assert.deepEqual(seqs("s0"), [2]);
  assert.equal(two.consumer.liveStatus(time2.now()).omitted["s0:x"]!.count, 1);
});

/** 256 stations with records dropped and still on air: the live set names no more one by one. */
function overflowEntries(host: Host, stream: string, ttlMs: number) {
  const key = (i: number) => i.toString(16).padStart(16, "0");
  for (let i = 0; i < 256; i++) {
    for (let n = 1; n <= 16; n++) {
      host.sing(n, { station: `s${i}`, key: key(i), stream, ttlMs });
    }
  }
  for (let i = 0; i < 256; i++) {
    host.sing(17, { station: `s${i}`, key: key(i), stream, ttlMs });
  }
  return key;
}

test("#119 review 3: what the live set drops past the 256 tuned streams it counts one by one is in hear, for an ear that tunes those streams", () => {
  const time = clock();
  const host = new Host(time, ["*:x", "*:y"]);
  host.start();
  const key = overflowEntries(host, "x", 600_000);
  const at = time.now();
  // A 257th stream: it takes places from the full shares until it is within one of them,
  // and what it can't place goes to the shared count.
  for (let n = 1; n <= 20; n++) {
    host.sing(n, {
      station: "s999",
      key: key(999),
      stream: "x",
      ttlMs: 600_000,
    });
  }
  const other = host.consumer.liveStatus(time.now()).omitted.other!;
  assert.equal(other.count, 5);
  const view = host.consumer.hearView(["*:x"], time.now(), true);
  assert.match(
    renderHear(view, { limit: 1, maxChars: 6_000 }),
    new RegExp(
      `^local omission \\(live_overflow\\): other tuned streams: 5 records dropped by frond-ear's full live set between ${iso(at)} and ${iso(at)}, past the 256 streams it names one by one, so which streams is unknown; they would be on air until ${iso(at + 600_000)}\\.$`,
      "mu",
    ),
  );
  // An ear that tunes none of those streams isn't told; once they're off air, nobody is.
  const y = host.consumer.hearView(["*:y"], time.now(), true);
  assert.doesNotMatch(
    renderHear(y, { limit: 1, maxChars: 6_000 }),
    /other tuned streams/u,
  );
  time.value = at + 600_001;
  assert.doesNotMatch(
    renderHear(host.consumer.hearView(["*:x"], time.now(), true), {
      limit: 1,
      maxChars: 6_000,
    }),
    /other tuned streams/u,
  );
});

test("#119 review 3: the shared count past 256 tuned streams rides with the next push, saying which stations is unknown; it wakes nobody on its own", async () => {
  const { h, host } = setup({ mode: "immediate", maxPushesPerHour: 360 });
  try {
    const shim = h.attach("scribe");
    const key = overflowEntries(host, "ops.deploy", 3_600_000);
    const at = h.clock.now();
    for (let n = 1; n <= 20; n++) {
      host.sing(n, {
        station: "s999",
        key: key(999),
        stream: "ops.deploy",
        ttlMs: 3_600_000,
      });
    }
    h.timers.advance(60_000);
    assert.equal(pushes(shim).length, 0, "no push of its own");
    host.sing(1);
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1);
    const push = pushes(shim)[0]!.content;
    assert.deepEqual(order(push), ["ops:ops.fleet/1"]);
    assert.match(
      push,
      new RegExp(
        `^- other tuned streams: 5 dropped by frond-ear's full live set \\(live_overflow; between ${iso(at)} and ${iso(at)}\\), past the 256 streams it names one by one, so which stations, and whether this ear would push them, is unknown\\.$`,
        "mu",
      ),
    );
    // None of those 256 stations is on wakeKeys: none is named in a push.
    assert.doesNotMatch(push, /^- s\d+:/mu);
    // Told once.
    host.sing(2);
    h.timers.advance(6_000);
    assert.doesNotMatch(pushes(shim)[1]!.content, /other tuned streams/u);
  } finally {
    h.dispose();
  }
});

test("#119 review 3: a shared-count note not yet told survives a restart, and one in a push a crash left unconfirmed is told again", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-other-"));
  const path = join(directory, "ear.db");
  const delivery = { mode: "immediate", maxPushesPerHour: 360 };
  const line =
    /^- other tuned streams: 5 dropped by frond-ear's full live set \(live_overflow; between \S+Z and \S+Z\), past the 256 streams it names one by one, so which stations, and whether this ear would push them, is unknown\.$/mu;
  try {
    const first = setup(delivery, {}, {}, { path });
    try {
      first.h.attach("scribe", { sessionId: SESSION });
      const key = overflowEntries(first.host, "ops.deploy", 3_600_000);
      for (let n = 1; n <= 20; n++) {
        first.host.sing(n, {
          station: "s999",
          key: key(999),
          stream: "ops.deploy",
          ttlMs: 3_600_000,
        });
      }
      first.h.timers.advance(2_000); // read and saved; nothing pushes it on its own
      assert.equal(status(first.h).counts.live_overflow_other, 5);
    } finally {
      first.h.dispose();
    }
    const second = setup(delivery, {}, {}, { path });
    let at: number;
    try {
      const shim = second.h.attach("scribe", { sessionId: SESSION });
      second.host.sing(1);
      second.h.timers.advance(6_000);
      assert.equal(pushes(shim).length, 1, "rides with the first push");
      assert.match(pushes(shim)[0]!.content, line);
      at = second.h.clock.now();
      // The process dies before the host confirms that push.
      second.h.store.close();
      rmSync(second.h.directory, { recursive: true, force: true });
    } catch (error) {
      second.h.dispose();
      throw error;
    }
    const third = setup(delivery, {}, {}, { path });
    try {
      third.h.clock.value = at + 10_000;
      const shim = third.h.attach("scribe", { sessionId: SESSION });
      third.host.sing(1); // still on air: the record waits again, and the note rides with it
      third.h.timers.advance(6_000);
      assert.equal(pushes(shim).length, 1, "given back: the record again");
      assert.deepEqual(order(pushes(shim)[0]!.content), ["ops:ops.fleet/1"]);
      assert.match(pushes(shim)[0]!.content, line, "and the note with it");
      await confirm(shim);
      third.host.sing(2);
      third.h.timers.advance(6_000);
      assert.doesNotMatch(pushes(shim)[1]!.content, /other tuned streams/u);
    } finally {
      third.h.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("#119 review 4: record v1 declares no stream's shape, so a tuned flood's full share keeps its oldest and refuses its newest; a keyed record's successor still takes its predecessor's place, which the host retracts first", () => {
  const time = clock();
  const host = new Host(time, ["*:ops.fleet"]);
  host.start();
  for (let n = 1; n <= MAX_LIVE; n++) {
    host.sing(n, { stateKey: `k${n}`, ttlMs: 3_600_000 });
  }
  host.sing(MAX_LIVE + 1, { stateKey: `k${MAX_LIVE + 1}`, ttlMs: 3_600_000 });
  assert.deepEqual(quietSeqs(host), range(1, MAX_LIVE), "the newest refused");
  const omitted = () =>
    host.consumer.liveStatus(time.now()).omitted["ops:ops.fleet"]!.total;
  assert.equal(omitted(), 1);
  host.supersede(1, MAX_LIVE + 2, { stateKey: "k1", ttlMs: 3_600_000 });
  assert.deepEqual(quietSeqs(host), [...range(2, MAX_LIVE), MAX_LIVE + 2]);
  assert.equal(omitted(), 1, "the successor was not refused");
});

test("#119 review 5: with 16 full shares, a record delivery waits on that the live set evicts is reported once, never also as gone off air", async () => {
  const { h, host } = setup({
    mode: "immediate",
    maxPushesPerHour: 360,
    bufferPerStream: 256,
    maxItems: 10,
  });
  try {
    const shim = h.attach("scribe");
    // ops's share first, so it is the first of the largest and gives up the first record.
    for (let n = 1; n <= 256; n++) host.sing(n, { ttlMs: 300_000 });
    for (let s = 1; s <= 15; s++) {
      for (let n = 1; n <= 256; n++) {
        host.sing(n, {
          station: `stray${s}`,
          key: STRAY,
          epoch: s,
          ttlMs: 300_000,
        });
      }
    }
    h.timers.advance(1_000); // delivery takes in ops's 256: all wait
    host.sing(1, { station: "stray16", key: STRAY, epoch: 16, ttlMs: 300_000 });
    assert.equal(
      host.consumer.liveStatus(h.clock.now()).omitted["ops:ops.fleet"]!.count,
      1,
      "ops's oldest, which delivery waits on, was evicted",
    );
    h.timers.advance(1_000);
    assert.match(
      h.store.runtimeState("canticle.withheld.scribe") ?? "",
      /"ops:ops\.fleet":\{[^}]*"withheld":\[\["live_overflow",\{"count":1,/u,
      "told at the next push, and saved for it until then",
    );
    // Until every one of them is pushed or off air; then one more push carries what's left.
    for (let t = 0; t < 310; t++) h.timers.advance(1_000);
    host.sing(257, { ttlMs: 300_000 });
    for (let t = 0; t < 120; t++) h.timers.advance(1_000);
    const { pushed, reported: told } = tally(shim, "ops:ops.fleet");
    assert.equal(pushed + told, 257, `pushed ${pushed}, reported ${told}`);
    const overflow = pushes(shim)
      .flatMap((push) => [
        ...push.content.matchAll(
          /^- ops:ops\.fleet: (\d+) dropped by frond-ear's full live set \(live_overflow; /gmu,
        ),
      ])
      .reduce((n, m) => n + Number(m[1]), 0);
    assert.equal(overflow, 1, "the evicted record, as the live set's drop");
  } finally {
    h.dispose();
  }
});

test("#119 review 5: what the live set evicts after delivery pushed it, or dropped it from its own full buffer, is not reported again; what it evicts before delivery saw it is", async () => {
  /** 15 stray stations flood the tuned ops.fleet: every share ends near 256. */
  const flood = (host: Host) => {
    for (let s = 1; s <= 15; s++) {
      for (let n = 1; n <= 300; n++) {
        host.sing(n, {
          station: `stray${s}`,
          key: STRAY,
          epoch: s,
          ttlMs: 3_600_000,
        });
      }
    }
  };
  const deploy = { stream: "ops.deploy", ttlMs: 3_600_000 };

  // Pushed, then evicted.
  {
    const { h, host } = setup({
      mode: "immediate",
      maxPushesPerHour: 360,
      maxItems: 10,
    });
    try {
      const shim = h.attach("scribe");
      for (let round = 0; round < 30; round++) {
        for (let i = 1; i <= 10; i++) host.sing(round * 10 + i, deploy);
        h.timers.advance(6_000);
      }
      h.timers.advance(6_000);
      assert.equal(tally(shim, "ops:ops.deploy").pushed, 300);
      flood(host);
      const evicted = host.consumer.liveStatus(h.clock.now()).omitted[
        "ops:ops.deploy"
      ]!.total;
      assert.ok(evicted > 0, "pushed records were evicted");
      host.sing(301, deploy);
      h.timers.advance(12_000);
      const { pushed, reported: told } = tally(shim, "ops:ops.deploy");
      assert.equal(pushed + told, 301, `pushed ${pushed}, reported ${told}`);
    } finally {
      h.dispose();
    }
  }

  // Dropped from delivery's full buffer, then evicted.
  {
    const { h, host } = setup({
      mode: "immediate",
      maxPushesPerHour: 360,
      maxItems: 10,
    });
    try {
      const shim = h.attach("scribe");
      for (let n = 1; n <= 300; n++) host.sing(n, deploy);
      h.timers.advance(30_000);
      flood(host);
      host.sing(301, deploy);
      h.timers.advance(12_000);
      const { pushed, reported: told } = tally(shim, "ops:ops.deploy");
      assert.equal(pushed, 32, "the buffer's newest 32");
      assert.equal(pushed + told, 301, `pushed ${pushed}, reported ${told}`);
    } finally {
      h.dispose();
    }
  }

  // Evicted before delivery's first look: reported as the live set's drops.
  {
    const { h, host } = setup({
      mode: "immediate",
      maxPushesPerHour: 360,
      maxItems: 10,
    });
    try {
      const shim = h.attach("scribe");
      for (let n = 1; n <= 300; n++) host.sing(n, deploy);
      flood(host);
      const evicted = host.consumer.liveStatus(h.clock.now()).omitted[
        "ops:ops.deploy"
      ]!.total;
      h.timers.advance(30_000);
      const { pushed, reported: told } = tally(shim, "ops:ops.deploy");
      assert.equal(pushed + told, 300, `pushed ${pushed}, reported ${told}`);
      assert.ok(
        pushes(shim).some((push) =>
          push.content.includes(
            `\n- ops:ops.deploy: ${evicted} dropped by frond-ear's full live set (live_overflow; `,
          ),
        ),
      );
    } finally {
      h.dispose();
    }
  }
});

// Independent review of the repair: what is reported once stays reported once.

/** 16 full shares: ops:ops.fleet's 256 first (the first of the largest), then 15 strays'. */
function sixteenShares(host: Host, ttlMs = 300_000) {
  for (let n = 1; n <= 256; n++) host.sing(n, { ttlMs });
  for (let s = 1; s <= 15; s++) {
    for (let n = 1; n <= 256; n++) {
      host.sing(n, { station: `stray${s}`, key: STRAY, epoch: s, ttlMs });
    }
  }
}

/** live_overflow counts a stream's coverage-note lines told, across every push. */
const overflowTold = (shim: Parameters<typeof pushes>[0], stream: string) =>
  pushes(shim)
    .flatMap((push) => [
      ...push.content.matchAll(
        new RegExp(
          `^- ${stream.replace(/\./gu, "\\.")}: (\\d+) dropped by frond-ear's full live set \\(live_overflow; `,
          "gmu",
        ),
      ),
    ])
    .reduce((n, m) => n + Number(m[1]), 0);

test("#119 re-review 1: records the live set refused and told are not told again when their copies are refused again; a pushed record's refused copy is not told at all", async () => {
  const { h, host } = setup({ mode: "immediate", maxPushesPerHour: 360 });
  try {
    const shim = h.attach("scribe");
    const deploy = { stream: "ops.deploy", ttlMs: 3_600_000 };
    for (let n = 1; n <= MAX_LIVE + 50; n++) host.sing(n, deploy);
    h.timers.advance(6_000);
    assert.equal(overflowTold(shim, "ops:ops.deploy"), 50);
    // The host sends the 50 again (a restarted receptor's resurfaced copies): refused again.
    for (let n = MAX_LIVE + 1; n <= MAX_LIVE + 50; n++) {
      host.sing(n, { ...deploy, dedup: "resurfaced" });
    }
    host.sing(1);
    h.timers.advance(6_000);
    assert.equal(overflowTold(shim, "ops:ops.deploy"), 50, "told once");
  } finally {
    h.dispose();
  }

  const second = setup({
    mode: "immediate",
    maxPushesPerHour: 360,
    maxItems: 10,
  });
  try {
    const { h, host } = second;
    const shim = h.attach("scribe");
    const deploy = { stream: "ops.deploy", ttlMs: 3_600_000 };
    for (let round = 0; round < 30; round++) {
      for (let i = 1; i <= 10; i++) host.sing(round * 10 + i, deploy);
      h.timers.advance(6_000);
    }
    h.timers.advance(6_000);
    for (let s = 1; s <= 15; s++) {
      for (let n = 1; n <= 300; n++) {
        host.sing(n, {
          station: `stray${s}`,
          key: STRAY,
          epoch: s,
          ttlMs: 3_600_000,
        });
      }
    }
    // Copies of pushed records the flood evicted come back, and are refused.
    for (let n = 1; n <= 10; n++)
      host.sing(n, { ...deploy, dedup: "resurfaced" });
    host.sing(1);
    h.timers.advance(6_000);
    assert.equal(tally(shim, "ops:ops.deploy").pushed, 300);
    assert.equal(
      overflowTold(shim, "ops:ops.deploy"),
      0,
      "the session has them",
    );
  } finally {
    second.h.dispose();
  }
});

test("#119 re-review 2: a record the live set evicts and admits again before delivery's next pass is pushed, and not told as dropped", async () => {
  const { h, host } = setup({
    mode: "immediate",
    maxPushesPerHour: 360,
    bufferPerStream: 256,
    maxItems: 10,
  });
  try {
    const shim = h.attach("scribe");
    sixteenShares(host);
    h.timers.advance(1_000); // ops's 256 wait
    host.sing(1, { station: "stray16", key: STRAY, epoch: 16, ttlMs: 300_000 });
    host.pluck(256, { station: "stray15", key: STRAY, epoch: 15 }); // a place frees
    host.sing(1, { dedup: "resurfaced", ttlMs: 300_000 }); // ops's first, back on air
    assert.ok(
      host.view().items.some((i) => i.station === "ops" && i.seq === "1"),
    );
    for (let t = 0; t < 30; t++) h.timers.advance(1_000);
    assert.ok(
      pushes(shim).some((push) =>
        order(push.content).includes("ops:ops.fleet/1"),
      ),
      "pushed",
    );
    assert.equal(overflowTold(shim, "ops:ops.fleet"), 0);
  } finally {
    h.dispose();
  }
});

test("#119 re-review 3: with every station muted, the shared count past 256 tuned streams is not told, then or after the mute lifts", async () => {
  const delivery = { mode: "immediate", maxPushesPerHour: 360 };
  const { h, host } = setup(delivery, { muted: true });
  try {
    const shim = h.attach("scribe");
    const key = overflowEntries(host, "ops.deploy", 3_600_000);
    for (let n = 1; n <= 20; n++) {
      host.sing(n, {
        station: "s999",
        key: key(999),
        stream: "ops.deploy",
        ttlMs: 3_600_000,
      });
    }
    h.timers.advance(2_000);
    h.daemon.reloadConfig(canticleConfig(delivery));
    host.sing(1);
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1);
    assert.deepEqual(order(pushes(shim)[0]!.content), ["ops:ops.fleet/1"]);
    assert.doesNotMatch(pushes(shim)[0]!.content, /other tuned streams/u);
  } finally {
    h.dispose();
  }
});

test("#119 re-review 4: a pushed record the live set evicts while its push is unconfirmed is told as the live set's drop once the push is given back", async () => {
  const { h, host } = setup({
    mode: "immediate",
    maxPushesPerHour: 360,
    bufferPerStream: 256,
    maxItems: 10,
  });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    sixteenShares(host);
    h.timers.advance(6_000);
    assert.deepEqual(order(pushes(shim)[0]!.content).slice(0, 1), [
      "ops:ops.fleet/1",
    ]);
    // Unconfirmed: the flood's next record evicts ops's first, which that push carried.
    host.sing(1, { station: "stray16", key: STRAY, epoch: 16, ttlMs: 300_000 });
    h.timers.advance(1_000);
    shim.close(); // given back
    const next = h.attach("scribe", { sessionId: SESSION });
    h.timers.advance(6_000);
    assert.equal(overflowTold(next, "ops:ops.fleet"), 1, "told at once");
    assert.ok(
      !order(pushes(next)[0]!.content).includes("ops:ops.fleet/1"),
      "never pushed from memory",
    );
    for (let t = 0; t < 400; t++) h.timers.advance(1_000);
    host.sing(257, { ttlMs: 300_000 });
    for (let t = 0; t < 60; t++) h.timers.advance(1_000);
    assert.equal(overflowTold(next, "ops:ops.fleet"), 1, "and only once");
    assert.ok(
      pushes(next).every(
        (push) =>
          !/^ops:ops\.fleet: \d+ went off air unpushed/mu.test(push.content),
      ),
    );
  } finally {
    h.dispose();
  }
});

test("#119 re-review: records dropped from delivery's buffer are not told again when the live set evicts them after a reload", async () => {
  const delivery = { mode: "immediate", maxPushesPerHour: 360, maxItems: 10 };
  const { h, host } = setup(delivery);
  try {
    const shim = h.attach("scribe");
    const deploy = { stream: "ops.deploy", ttlMs: 3_600_000 };
    for (let n = 1; n <= 300; n++) host.sing(n, deploy);
    h.timers.advance(30_000); // the buffer keeps the newest 32; the rest are told dropped
    h.daemon.reloadConfig(canticleConfig(delivery));
    for (let s = 1; s <= 15; s++) {
      for (let n = 1; n <= 300; n++) {
        host.sing(n, {
          station: `stray${s}`,
          key: STRAY,
          epoch: s,
          ttlMs: 3_600_000,
        });
      }
    }
    assert.ok(
      host.consumer.liveStatus(h.clock.now()).omitted["ops:ops.deploy"]!.total >
        0,
    );
    h.timers.advance(30_000);
    assert.equal(overflowTold(shim, "ops:ops.deploy"), 0);
  } finally {
    h.dispose();
  }
});

test("#119 re-review 1: records pushed before a reload are not told as dropped when the live set evicts them after it", async () => {
  const delivery = { mode: "immediate", maxPushesPerHour: 360, maxItems: 10 };
  const { h, host } = setup(delivery);
  try {
    const shim = h.attach("scribe");
    const deploy = { stream: "ops.deploy", ttlMs: 3_600_000 };
    for (let round = 0; round < 30; round++) {
      for (let i = 1; i <= 10; i++) host.sing(round * 10 + i, deploy);
      h.timers.advance(6_000);
    }
    h.timers.advance(6_000);
    assert.equal(tally(shim, "ops:ops.deploy").pushed, 300);
    // A reload: what is on air is read again; the pushed records stay decided.
    h.daemon.reloadConfig(canticleConfig(delivery));
    h.timers.advance(1_000);
    for (let s = 1; s <= 15; s++) {
      for (let n = 1; n <= 300; n++) {
        host.sing(n, {
          station: `stray${s}`,
          key: STRAY,
          epoch: s,
          ttlMs: 3_600_000,
        });
      }
    }
    assert.ok(
      host.consumer.liveStatus(h.clock.now()).omitted["ops:ops.deploy"]!.total >
        0,
    );
    host.sing(1);
    h.timers.advance(6_000);
    assert.equal(
      overflowTold(shim, "ops:ops.deploy"),
      0,
      "the session has them",
    );
  } finally {
    h.dispose();
  }
});

test("#119 re-review 2: a record told as the live set's drop that comes back on air later is pushed all the same, and not told again", async () => {
  const { h, host } = setup({
    mode: "immediate",
    maxPushesPerHour: 360,
    bufferPerStream: 256,
    maxItems: 10,
  });
  try {
    const shim = h.attach("scribe");
    sixteenShares(host);
    h.timers.advance(1_000); // ops's 256 wait
    host.sing(1, { station: "stray16", key: STRAY, epoch: 16, ttlMs: 300_000 });
    h.timers.advance(1_000); // the pass that tells it
    host.pluck(256, { station: "stray15", key: STRAY, epoch: 15 }); // a place frees
    host.sing(1, { dedup: "resurfaced", ttlMs: 300_000 }); // ops's first, back on air
    for (let t = 0; t < 60; t++) h.timers.advance(1_000);
    assert.ok(
      pushes(shim).some((push) =>
        order(push.content).includes("ops:ops.fleet/1"),
      ),
      "pushed once back on air",
    );
    assert.equal(overflowTold(shim, "ops:ops.fleet"), 1, "the drop, told once");
  } finally {
    h.dispose();
  }
});

test("#119 re-review 2: a hear-only flood's refusals can't push an allowlisted drop out of what the live set names", async () => {
  const { h, host } = setup({
    mode: "immediate",
    maxPushesPerHour: 360,
    bufferPerStream: 256,
    maxItems: 10,
  });
  try {
    const shim = h.attach("scribe");
    sixteenShares(host);
    h.timers.advance(1_000); // ops's 256 wait
    host.sing(1, { station: "stray16", key: STRAY, epoch: 16, ttlMs: 300_000 });
    // In the same second, stray1's full share refuses more than the set holds.
    for (let n = 257; n <= 257 + MAX_LIVE + 100; n++) {
      host.sing(n, { station: "stray1", key: STRAY, epoch: 1, ttlMs: 300_000 });
    }
    for (let t = 0; t < 310; t++) h.timers.advance(1_000);
    host.sing(257, { ttlMs: 300_000 });
    for (let t = 0; t < 120; t++) h.timers.advance(1_000);
    const { pushed, reported: told } = tally(shim, "ops:ops.fleet");
    assert.equal(pushed + told, 257, `pushed ${pushed}, reported ${told}`);
    assert.equal(overflowTold(shim, "ops:ops.fleet"), 1);
  } finally {
    h.dispose();
  }
});

test("#119 re-review 2: a told drop that came back and waits again is not told again if the live set drops it again", async () => {
  const { h, host } = setup({ mode: "immediate", maxPushesPerHour: 360 });
  try {
    const key = (i: number) => (i + 1).toString(16).padStart(16, "0");
    const station = (name: string, i: number) =>
      host.sing(1, { station: name, key: key(i), ttlMs: 3_600_000 });
    host.sing(1, { ttlMs: 3_600_000 });
    host.sing(2, { ttlMs: 3_600_000 });
    for (let i = 0; i < MAX_LIVE - 2; i++) station(`s${i}`, i);
    h.timers.advance(1_000); // no session yet: ops's two wait
    station("n1", 10_001); // ops holds the most: its oldest, ops/1, goes
    h.timers.advance(1_000); // told
    host.pluck(1, { station: "s0", key: key(0) });
    host.sing(1, { dedup: "resurfaced", ttlMs: 3_600_000 }); // back, and waited on again
    h.timers.advance(1_000);
    host.pluck(2);
    host.sing(3, { ttlMs: 3_600_000 }); // ops/1 is ops's oldest again
    station("n2", 10_002); // and goes again
    h.timers.advance(1_000);
    const shim = h.attach("scribe");
    for (let t = 0; t < 30; t++) h.timers.advance(1_000);
    assert.equal(overflowTold(shim, "ops:ops.fleet"), 1, "told once");
    assert.deepEqual(
      pushes(shim).flatMap((push) => order(push.content)),
      ["ops:ops.fleet/3"],
    );
  } finally {
    h.dispose();
  }
});

// 🌫's second review of #119 (6021431579): an owed note meets the boundary as it is now,
// not as it was when it was owed (R1); and nothing a note owes is lost at the bound on the
// streams it names one by one (R2).

type Harnessed = ReturnType<typeof setup>["h"];

interface SavedNote {
  offAir: number;
  dropped: number;
  withheld: Array<[string, { count: number; from: number; to: number }]>;
  key: string;
  owed: boolean;
  streams?: Array<{
    stream: string;
    key: string;
    owed: boolean;
    withheld: boolean;
    missed: boolean;
  }>;
  more?: true;
}

/** The coverage notes not told yet, as `canticle.withheld.<ear>` saves them. */
const pendingNotes = (h: Harnessed): Record<string, SavedNote> =>
  (
    JSON.parse(h.store.runtimeState("canticle.withheld.scribe") ?? "{}") as {
      pending?: Record<string, SavedNote>;
    }
  ).pending ?? {};

/** The records saved notes hold as local omissions, for one reason or all. */
const withheldSum = (notes: Record<string, SavedNote>, reason?: string) =>
  Object.values(notes).reduce(
    (n, note) =>
      n +
      note.withheld
        .filter(([r]) => reason === undefined || r === reason)
        .reduce((m, [, span]) => m + span.count, 0),
    0,
  );

/**
 * The local omissions a push's coverage note accounts for: each line's count, the count
 * of the lines it doesn't name, and what it folded past the streams it names one by one.
 */
function omissionsTold(content: string): number {
  let n = 0;
  for (const line of content.split("\n")) {
    const named =
      /^- (?:\S+|other tuned streams): (\d+) (?:went off air unpushed while|dropped by frond-ear's full live set)/u.exec(
        line,
      );
    const rest = /^\(\d+ more local omissions?, (\d+) records?; /u.exec(line);
    const folded = /^- and (\d+) more across /u.exec(line);
    n += Number(named?.[1] ?? rest?.[1] ?? folded?.[1] ?? 0);
  }
  return n;
}

const budgetLine =
  /^- ops:ops\.fleet: 1 went off air unpushed while the hour's push budget was spent \(push_budget; heard \S+Z to \S+Z\)\.$/mu;

/** Pushes record 1, then lets record 2 go off air under the spent budget: an owed note. */
async function owedNote(h: Harnessed, host: Host) {
  const shim = h.attach("scribe", { sessionId: SESSION });
  host.sing(1);
  h.timers.advance(6_000);
  await confirm(shim);
  const pushedAt = status(h).lastPushAt!;
  host.sing(2, { ttlMs: 10_000 });
  h.timers.advance(12_000);
  assert.equal(pendingNotes(h)["ops:ops.fleet"]?.owed, true, "owed");
  return { shim, pushedAt };
}

test("#119 second review R1: a note owed before a reload took its key off wakeKeys pushes nothing on its own; it waits, hear says so, and the next push that goes tells it", async () => {
  const delivery = { mode: "immediate", maxPushesPerHour: 1 };
  const { h, host } = setup(delivery);
  try {
    const { shim, pushedAt } = await owedNote(h, host);
    h.daemon.reloadConfig(canticleConfig(delivery, { wakeKeys: [] }));
    h.timers.advance(pushedAt + 3_600_000 + 60_000 - h.clock.now());
    assert.equal(status(h).wakeKeys, 0);
    assert.equal(pushes(shim).length, 1, "no push of its own");
    assert.match(
      (await h.call(shim, "hear", {})).text,
      /^canticle delivery: the next push reports 1 it withheld \(local omissions\); nothing pushes it on its own now, so it waits for a push that goes anyway\.$/mu,
    );
    assert.equal(withheldSum(pendingNotes(h)), 1, "kept");
    // Another station's key: still nothing of its own, but that station's push tells it.
    h.daemon.reloadConfig(canticleConfig(delivery, { wakeKeys: [ALPHA] }));
    h.timers.advance(60_000);
    assert.equal(pushes(shim).length, 1);
    host.sing(1, { station: "alpha" });
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 2);
    const push = pushes(shim)[1]!.content;
    assert.deepEqual(order(push), ["alpha:ops.fleet/1"]);
    assert.match(push, budgetLine);
    await confirm(shim);
    h.timers.advance(2 * 3_600_000);
    assert.equal(pushes(shim).length, 2, "told once");
  } finally {
    h.dispose();
  }
});

test("#119 second review R1, control: a note owed while its key is on wakeKeys pushes on its own after a reload that keeps the key, or puts it back", async () => {
  const delivery = { mode: "immediate", maxPushesPerHour: 1 };
  for (const off of [false, true]) {
    const { h, host } = setup(delivery);
    try {
      const { shim, pushedAt } = await owedNote(h, host);
      if (off) {
        h.daemon.reloadConfig(canticleConfig(delivery, { wakeKeys: [] }));
        h.timers.advance(10_000);
      }
      h.daemon.reloadConfig(canticleConfig(delivery));
      h.timers.advance(pushedAt + 3_600_000 + 6_000 - h.clock.now());
      assert.equal(
        pushes(shim).length,
        2,
        `the budget's next push (off ${off})`,
      );
      const note = pushes(shim)[1]!.content;
      assert.deepEqual(order(note), []);
      assert.match(note, budgetLine);
      await confirm(shim);
      h.timers.advance(3_600_000);
      assert.equal(pushes(shim).length, 2);
    } finally {
      h.dispose();
    }
  }
});

test("#119 second review R1, sibling: an off ceiling or a mute for the note's station holds its push of its own the same way; a push that goes tells it", async () => {
  const delivery = { mode: "immediate", maxPushesPerHour: 1 };
  for (const hold of ["off", "mute"]) {
    const { h, host } = setup(delivery);
    try {
      const { shim, pushedAt } = await owedNote(h, host);
      if (hold === "off") {
        h.daemon.reloadConfig(
          canticleConfig({ ...delivery, stations: { ops: "off" } }),
        );
      } else {
        await h.call(shim, "set_canticle_delivery", {
          station: "ops",
          mode: "mute",
        });
      }
      h.timers.advance(pushedAt + 3_600_000 + 60_000 - h.clock.now());
      assert.equal(pushes(shim).length, 1, `held by ${hold}`);
      host.sing(1, { station: "alpha" });
      h.timers.advance(6_000);
      assert.equal(pushes(shim).length, 2);
      assert.match(pushes(shim)[1]!.content, budgetLine);
    } finally {
      h.dispose();
    }
  }
});

test("#119 second review R1: a note owed and saved before a restart whose config took its key off wakeKeys pushes nothing on its own after it; restarted with the key on, it does", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-owed-"));
  const path = join(directory, "ear.db");
  const delivery = { mode: "immediate", maxPushesPerHour: 1 };
  try {
    let pushedAt: number;
    const first = setup(delivery, {}, {}, { path });
    try {
      ({ pushedAt } = await owedNote(first.h, first.host));
    } finally {
      first.h.dispose();
    }
    const second = setup(delivery, { wakeKeys: [] }, {}, { path });
    let at: number;
    try {
      second.h.clock.value = pushedAt + 3_600_000 + 1_000;
      const shim = second.h.attach("scribe", { sessionId: SESSION });
      second.h.timers.advance(6_000);
      assert.equal(pushes(shim).length, 0, "no push of its own");
      second.h.timers.advance(3_600_000);
      assert.equal(pushes(shim).length, 0);
      assert.match(
        (await second.h.call(shim, "hear", {})).text,
        /^canticle delivery: the next push reports 1 it withheld \(local omissions\); nothing pushes it on its own now, so it waits for a push that goes anyway\.$/mu,
      );
      assert.equal(withheldSum(pendingNotes(second.h)), 1, "kept");
      at = second.h.clock.now();
    } finally {
      second.h.dispose();
    }
    const third = setup(delivery, {}, {}, { path });
    try {
      third.h.clock.value = at + 1_000;
      const shim = third.h.attach("scribe", { sessionId: SESSION });
      third.h.timers.advance(6_000);
      assert.equal(
        pushes(shim).length,
        1,
        "the key is back: a push of its own",
      );
      assert.deepEqual(order(pushes(shim)[0]!.content), []);
      assert.match(pushes(shim)[0]!.content, budgetLine);
      await confirm(shim);
      third.h.timers.advance(3_600_000);
      assert.equal(pushes(shim).length, 1, "once");
    } finally {
      third.h.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Station keys for many allowlisted stations, none of them OPS's or ALPHA's. */
const manyKey = (i: number) => (i + 1).toString(16).padStart(16, "0");

test("#119 second review R2 (i): with 256 named streams' drops untold, what the live set drops past them is saved and told as the shared count; one station fewer is the control", async () => {
  const key = (i: number) => i.toString(16).padStart(16, "0");
  for (const allowed of [256, 255]) {
    // s0 off the allowlist leaves 255 named entries: the threshold's other side.
    const wakeKeys = [
      OPS,
      ...Array.from({ length: 256 }, (_, i) => key(i)).slice(256 - allowed),
      key(999),
    ];
    const { h, host } = setup(
      { mode: "immediate", maxPushesPerHour: 360 },
      { wakeKeys },
    );
    try {
      const shim = h.attach("scribe");
      overflowEntries(host, "ops.fleet", 3_600_000);
      for (let n = 1; n <= 20; n++) {
        host.sing(n, { station: "s999", key: key(999), ttlMs: 3_600_000 });
      }
      const omitted = host.consumer.liveStatus(h.clock.now()).omitted;
      assert.equal(omitted.other!.total, 5);
      const named = Object.entries(omitted)
        .filter(([share]) => share.includes(":"))
        .filter(([share]) => allowed === 256 || share !== "s0:ops.fleet")
        .reduce((n, [, o]) => n + o.total, 0);
      h.timers.advance(1_000);
      const notes = pendingNotes(h);
      assert.equal(status(h).counts.live_overflow_other, 5);
      assert.equal(
        notes[""]?.withheld.find(([r]) => r === "live_overflow")?.[1].count,
        5,
        `the shared count is saved (${allowed} allowed)`,
      );
      assert.equal(
        withheldSum(notes, "live_overflow"),
        named + 5,
        "every drop saved",
      );
      h.timers.advance(5_000);
      const push = pushes(shim)[0]!.content;
      assert.match(
        push,
        /^- other tuned streams: 5 dropped by frond-ear's full live set \(live_overflow; between \S+Z and \S+Z\), past the 256 streams it names one by one, so which stations, and whether this ear would push them, is unknown\.$/mu,
      );
      assert.equal(omissionsTold(push), named + 5, "the push accounts for all");
      assert.equal(withheldSum(pendingNotes(h)), 0, "and they are told");
    } finally {
      h.dispose();
    }
  }
});

/**
 * One 10 s record on each of `streams` allowlisted stations, `maxItems: 1` and one push an
 * hour: the first push carries one and promises the rest, which go off air under the
 * spent budget. Returns the harness at that point, and when the budget frees.
 */
async function promised(
  streams: number,
  delivery: Record<string, unknown> = {},
  options: { path?: string } = {},
) {
  const wakeKeys = [
    ALPHA,
    ...Array.from({ length: streams }, (_, i) => manyKey(i)),
  ];
  const { h, host } = setup(
    { mode: "immediate", maxItems: 1, maxPushesPerHour: 1, ...delivery },
    { wakeKeys },
    {},
    options,
  );
  const shim = h.attach("scribe", { sessionId: SESSION });
  for (let i = 0; i < streams; i++) {
    host.sing(1, { station: `s${i}`, key: manyKey(i), ttlMs: 10_000 });
  }
  h.timers.advance(6_000);
  assert.equal(pushes(shim).length, 1);
  assert.match(
    pushes(shim)[0]!.content,
    new RegExp(
      `\\n\\(${streams - 1} more records wait for the next push; the hour's push budget holds them until `,
      "u",
    ),
  );
  await confirm(shim);
  const frees = status(h).lastPushAt! + 3_600_000;
  h.timers.advance(12_000);
  assert.equal(status(h).counts.off_air_unpushed, streams - 1);
  return { h, host, shim, frees, wakeKeys };
}

const foldedLine = (records: number, streams: number) =>
  new RegExp(
    `^- and ${records} more across ${streams} streams? past the 256 it names one by one: ${records} went off air unpushed while the hour's push budget was spent \\(push_budget; heard \\S+Z to \\S+Z\\)\\.$`,
    "mu",
  );

test("#119 second review R2 (ii): a push that promised 257 records on 257 streams reports all 257 once the budget frees, 256 by name and one folded; 256 promised is the control", async () => {
  for (const streams of [258, 257]) {
    const { h, shim, frees } = await promised(streams);
    try {
      assert.equal(
        withheldSum(pendingNotes(h), "push_budget"),
        streams - 1,
        `every promised record that went off air is saved (${streams - 1})`,
      );
      h.timers.advance(frees + 6_000 - h.clock.now());
      assert.equal(pushes(shim).length, 2);
      const note = pushes(shim)[1]!.content;
      assert.deepEqual(order(note), []);
      assert.equal(omissionsTold(note), streams - 1, "the note tells them all");
      if (streams === 257)
        assert.doesNotMatch(note, /^- and \d+ more across /mu);
      else assert.match(note, foldedLine(1, 1));
      assert.equal(withheldSum(pendingNotes(h)), 0, "told, so cleared");
      await confirm(shim);
      h.timers.advance(3_600_000);
      assert.equal(pushes(shim).length, 2, "once");
    } finally {
      h.dispose();
    }
  }
});

test("#119 second review R2: what is folded past the 256 named streams survives a restart, and a push given back (live or after a crash) tells it again, owed as before", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-folded-"));
  const path = join(directory, "ear.db");
  const delivery = { mode: "immediate", maxItems: 1, maxPushesPerHour: 1 };
  try {
    const first = await promised(258, {}, { path });
    const { frees, wakeKeys } = first;
    first.h.dispose();
    const second = setup(delivery, { wakeKeys }, {}, { path });
    let at: number;
    try {
      second.h.clock.value = frees + 1_000;
      const shim = second.h.attach("scribe", { sessionId: SESSION });
      second.h.timers.advance(6_000);
      assert.equal(pushes(shim).length, 1, "told after the restart");
      assert.equal(omissionsTold(pushes(shim)[0]!.content), 257);
      assert.match(pushes(shim)[0]!.content, foldedLine(1, 1));
      shim.close(); // given back, unconfirmed: owed again
      const next = second.h.attach("scribe", { sessionId: SESSION });
      second.h.timers.advance(6_000);
      assert.equal(pushes(next).length, 1, "told again");
      assert.equal(omissionsTold(pushes(next)[0]!.content), 257);
      assert.match(pushes(next)[0]!.content, foldedLine(1, 1));
      at = second.h.clock.now();
      // The process dies before the host confirms it.
      second.h.store.close();
      rmSync(second.h.directory, { recursive: true, force: true });
    } catch (error) {
      second.h.dispose();
      throw error;
    }
    const third = setup(delivery, { wakeKeys }, {}, { path });
    try {
      third.h.clock.value = at + 10_000;
      const shim = third.h.attach("scribe", { sessionId: SESSION });
      third.h.timers.advance(6_000);
      assert.equal(pushes(shim).length, 1, "given back after the crash");
      assert.equal(omissionsTold(pushes(shim)[0]!.content), 257);
      assert.match(pushes(shim)[0]!.content, foldedLine(1, 1));
      await confirm(shim);
      third.h.timers.advance(3_600_000);
      assert.equal(pushes(shim).length, 1, "once confirmed, done");
    } finally {
      third.h.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("#119 second review R2: what is folded keeps each stream's station, so a folded note owed a push wakes as a named one does, under the boundary as it is now; outside it, it rides with a push that goes", async () => {
  for (const allowed of [true, false]) {
    const { h, host, shim, frees } = await promised(258);
    try {
      // s1..s256 are named and owed; s257 is folded. Every named station's key goes.
      h.daemon.reloadConfig(
        canticleConfig(
          { mode: "immediate", maxItems: 1, maxPushesPerHour: 1 },
          { wakeKeys: allowed ? [ALPHA, manyKey(257)] : [ALPHA] },
        ),
      );
      h.timers.advance(frees + 60_000 - h.clock.now());
      if (allowed) {
        assert.equal(pushes(shim).length, 2, "s257's push of its own");
        const note = pushes(shim)[1]!.content;
        assert.deepEqual(order(note), []);
        assert.equal(omissionsTold(note), 257);
        assert.match(note, foldedLine(1, 1));
      } else {
        assert.equal(pushes(shim).length, 1, "nothing of its own");
        host.sing(1, { station: "alpha" });
        h.timers.advance(6_000);
        assert.equal(pushes(shim).length, 2);
        const push = pushes(shim)[1]!.content;
        assert.deepEqual(order(push), ["alpha:ops.fleet/1"]);
        assert.equal(omissionsTold(push), 257);
        assert.match(push, foldedLine(1, 1));
      }
    } finally {
      h.dispose();
    }
  }
});

/**
 * The records a push's footer says went off air unpushed: each stream's line, what it
 * folded, and the count of the streams it doesn't name.
 */
function offAirTold(content: string): number {
  let n = 0;
  for (const line of content.split("\n")) {
    const named =
      /^(?:\S+|and (?:at least )?\d+ more streams? past the 256 it names one by one): (\d+) went off air unpushed/u.exec(
        line,
      );
    const rest =
      /^\((?:at least )?\d+ (?:more|other) streams? missed (\d+) records? too\.\)$/u.exec(
        line,
      );
    n += Number(named?.[1] ?? rest?.[1] ?? 0);
  }
  return n;
}

test("#119 second review R2: at the bound, with 256 notes owed nothing in every named place, a note owed a push is folded with its station and still gets that push; the footer counts every record", async () => {
  const wakeKeys = [
    OPS,
    ALPHA,
    ...Array.from({ length: 256 }, (_, i) => manyKey(i)),
  ];
  const { h, host } = setup(
    { mode: "immediate", maxItems: 1, maxPushesPerHour: 1 },
    { wakeKeys },
  );
  try {
    const shim = h.attach("scribe");
    host.sing(1, { station: "alpha", ttlMs: 7_200_000 });
    host.sing(1, { ttlMs: 30_000 }); // ops's: promised, under the spent budget
    h.timers.advance(6_000);
    assert.deepEqual(order(pushes(shim)[0]!.content), ["alpha:ops.fleet/1"]);
    await confirm(shim);
    const frees = status(h).lastPushAt! + 3_600_000;
    // 256 streams' records leave the view and then go off air: notes owed nothing.
    for (let i = 0; i < 256; i++) {
      host.sing(1, { station: `s${i}`, key: manyKey(i), ttlMs: 5_000 });
    }
    h.timers.advance(1_000);
    for (let i = 0; i < 256; i++) {
      host.pluck(1, { station: `s${i}`, key: manyKey(i) });
    }
    h.timers.advance(6_000);
    assert.equal(Object.keys(pendingNotes(h)).length, 256);
    h.timers.advance(30_000); // ops's promised record goes off air: owed
    h.timers.advance(frees + 6_000 - h.clock.now());
    assert.equal(pushes(shim).length, 2, "the push it was owed");
    const note = pushes(shim)[1]!.content;
    assert.deepEqual(order(note), []);
    assert.equal(omissionsTold(note), 1, "ops's record");
    assert.equal(offAirTold(note), 256, "every record that left the view");
  } finally {
    h.dispose();
  }
});

test("#119 second review R2: a note too long for limits.maxNotificationChars sums up in one line, what it folded counted with the rest", async () => {
  const { h, shim, frees, wakeKeys } = await promised(258);
  try {
    h.daemon.reloadConfig(
      canticleConfig(
        { mode: "immediate", maxItems: 1, maxPushesPerHour: 1 },
        { wakeKeys },
        { limits: { maxNotificationChars: 500 } },
      ),
    );
    h.timers.advance(frees + 6_000 - h.clock.now());
    assert.equal(pushes(shim).length, 2);
    const note = pushes(shim)[1]!.content;
    assert.ok(note.length <= 500, `${note.length} chars`);
    assert.match(
      note,
      /^local omissions \(frond-ear withheld these itself\): 257 records on 257 streams; ear_status counts them\.$/mu,
    );
  } finally {
    h.dispose();
  }
});

// An independent review of the repair: a folded note keeps its wake; stream counts exact.

test("#119 second review, re-review 1: with 256 named notes owed a push their stations may no longer have, an owed note on an allowed station past them still gets its own; 10 named is the control", async () => {
  for (const named of [256, 10]) {
    const streams = named + 1;
    const delivery = { mode: "immediate", maxItems: 1, maxPushesPerHour: 1 };
    const wakeKeys = [
      ALPHA,
      ...Array.from({ length: streams }, (_, i) => manyKey(i)),
      manyKey(300),
    ];
    const { h, host } = setup(delivery, { wakeKeys });
    try {
      const shim = h.attach("scribe", { sessionId: SESSION });
      for (let i = 0; i < streams; i++) {
        host.sing(1, { station: `s${i}`, key: manyKey(i), ttlMs: 10_000 });
      }
      h.timers.advance(6_000);
      await confirm(shim);
      const frees = status(h).lastPushAt! + 3_600_000;
      h.timers.advance(12_000);
      // Every one of those stations' keys goes; s300's stays.
      h.daemon.reloadConfig(
        canticleConfig(delivery, { wakeKeys: [ALPHA, manyKey(300)] }),
      );
      h.timers.advance(1_000);
      host.sing(1, { station: "s300", key: manyKey(300), ttlMs: 10_000 });
      h.timers.advance(12_000); // off air under the spent budget: owed, allowed
      h.timers.advance(frees + 60_000 - h.clock.now());
      assert.equal(pushes(shim).length, 2, `a push of its own (${named})`);
      const note = pushes(shim)[1]!.content;
      assert.deepEqual(order(note), []);
      assert.equal(omissionsTold(note), named + 1);
    } finally {
      h.dispose();
    }
  }
});

test("#119 second review, re-review 2: a push given back after new notes came in counts each folded stream once, by kind: what went off air unpushed is not said of streams that had none", async () => {
  const delivery = { mode: "immediate", maxItems: 1, maxPushesPerHour: 1 };
  const x = (i: number) => manyKey(400 + i);
  const { h, host, shim, frees, wakeKeys } = await promised(258);
  try {
    h.daemon.reloadConfig(
      canticleConfig(delivery, { wakeKeys: [...wakeKeys, x(0), x(1), x(2)] }),
    );
    h.timers.advance(frees + 6_000 - h.clock.now());
    assert.equal(pushes(shim).length, 2);
    // Unconfirmed: three new stations' records leave the view and go off air.
    for (let i = 0; i < 3; i++) {
      host.sing(1, { station: `x${i}`, key: x(i), ttlMs: 5_000 });
    }
    h.timers.advance(1_000);
    for (let i = 0; i < 3; i++) host.pluck(1, { station: `x${i}`, key: x(i) });
    h.timers.advance(6_000);
    shim.close(); // the note is given back, and merges with the three
    const next = h.attach("scribe", { sessionId: SESSION });
    h.timers.advance(6_000);
    assert.equal(pushes(next).length, 1, "told again");
    const note = pushes(next)[0]!.content;
    assert.equal(omissionsTold(note), 257);
    assert.equal(offAirTold(note), 3);
    // x0..x2 kept their names; three of the given-back streams fold beside s257.
    assert.match(note, foldedLine(4, 4));
    assert.doesNotMatch(note, /^and \d+ more streams? past the 256/mu);
  } finally {
    h.dispose();
  }
});

test("#119 second review, re-review 2: a stream folded once stays folded until the note is told, never named as well, so the summary counts it once", async () => {
  const delivery = { mode: "immediate", maxItems: 1, maxPushesPerHour: 1 };
  const wakeKeys = [
    ALPHA,
    ...Array.from({ length: 256 }, (_, i) => manyKey(i)),
    manyKey(400),
  ];
  const { h, host } = setup(delivery, { wakeKeys });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1, { station: "alpha", ttlMs: 7_200_000 });
    h.timers.advance(6_000);
    await confirm(shim);
    const frees = status(h).lastPushAt! + 3_600_000;
    // Paused: 256 streams' notes and x0's go off air, owed nothing; x0's is folded.
    h.daemon.reloadConfig(
      canticleConfig(delivery, { wakeKeys }, { paused: true }),
    );
    for (let i = 0; i < 256; i++) {
      host.sing(1, { station: `s${i}`, key: manyKey(i), ttlMs: 10_000 });
    }
    host.sing(1, { station: "x0", key: manyKey(400), ttlMs: 10_000 });
    h.timers.advance(12_000);
    h.daemon.reloadConfig(
      canticleConfig(
        delivery,
        { wakeKeys },
        { limits: { maxNotificationChars: 600 } },
      ),
    );
    // x0 again, now under the spent budget: owed.
    host.sing(2, { station: "x0", key: manyKey(400), ttlMs: 10_000 });
    h.timers.advance(12_000);
    assert.equal(pendingNotes(h)["x0:ops.fleet"], undefined, "still folded");
    h.timers.advance(frees + 6_000 - h.clock.now());
    assert.equal(pushes(shim).length, 2, "x0's push of its own");
    assert.match(pushes(shim)[1]!.content, / 258 records on 257 streams;/u);
  } finally {
    h.dispose();
  }
});

test("#119 second review, re-review 3: hear says a note waits when what it owes went off air unpushed or was dropped, not only withheld", async () => {
  const delivery = { mode: "immediate", maxItems: 1, maxPushesPerHour: 1 };
  const { h, host } = setup(delivery);
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1, { ttlMs: 10_000 });
    host.sing(2, { ttlMs: 10_000 });
    h.timers.advance(6_000);
    await confirm(shim);
    const frees = status(h).lastPushAt! + 3_600_000;
    host.pluck(2); // promised, leaves the view, then goes off air
    h.timers.advance(12_000);
    h.daemon.reloadConfig(canticleConfig(delivery, { wakeKeys: [ALPHA] }));
    h.timers.advance(frees + 60_000 - h.clock.now());
    assert.equal(pushes(shim).length, 1);
    assert.match(
      (await h.call(shim, "hear", {})).text,
      /^canticle delivery: the next push reports 1 that went off air unpushed; nothing pushes it on its own now, so it waits for a push that goes anyway\.$/mu,
    );
    host.sing(1, { station: "alpha" });
    h.timers.advance(6_000);
    assert.match(
      pushes(shim)[1]!.content,
      /^ops:ops\.fleet: 1 went off air unpushed\.$/mu,
    );
  } finally {
    h.dispose();
  }
});

test("#119 second review, re-review 4: past five streams, the footer counts the records the rest missed, so every promised record is accounted for", async () => {
  const delivery = { mode: "immediate", maxItems: 1, maxPushesPerHour: 1 };
  const wakeKeys = [ALPHA, ...Array.from({ length: 7 }, (_, i) => manyKey(i))];
  const { h, host } = setup(delivery, { wakeKeys });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1, { station: "s0", key: manyKey(0), ttlMs: 10_000 });
    for (let i = 1; i < 7; i++) {
      for (const n of [1, 2]) {
        host.sing(n, { station: `s${i}`, key: manyKey(i), ttlMs: 10_000 });
      }
    }
    h.timers.advance(6_000);
    assert.match(pushes(shim)[0]!.content, /\(12 more records wait /u);
    await confirm(shim);
    const frees = status(h).lastPushAt! + 3_600_000;
    for (let i = 1; i < 7; i++) {
      for (const n of [1, 2]) {
        host.pluck(n, { station: `s${i}`, key: manyKey(i) });
      }
    }
    h.timers.advance(12_000);
    h.timers.advance(frees + 6_000 - h.clock.now());
    assert.equal(pushes(shim).length, 2);
    const note = pushes(shim)[1]!.content;
    assert.match(note, /^\(1 more stream missed 2 records too\.\)$/mu);
    assert.equal(offAirTold(note), 12);
  } finally {
    h.dispose();
  }
});

test("#119 second review R2: what the folded count holds past the streams it names has no station, so it never asks for a push of its own", async () => {
  const { h, host } = setup({ mode: "immediate", maxPushesPerHour: 360 });
  try {
    const at = h.clock.now() - 60_000;
    h.store.setRuntimeState(
      "canticle.withheld.scribe",
      JSON.stringify({
        pending: {
          "*": {
            offAir: 0,
            dropped: 0,
            withheld: [["push_budget", { count: 300, from: at, to: at }]],
            key: "",
            owed: true,
            streams: Array.from({ length: 256 }, (_, i) => ({
              stream: `s${i}:ops.fleet`,
              key: manyKey(i),
              owed: false,
              withheld: true,
              missed: false,
            })),
            more: true,
          },
        },
        carried: {},
      }),
    );
    const shim = h.attach("scribe");
    h.timers.advance(60_000);
    assert.equal(pushes(shim).length, 0, "nothing of its own");
    host.sing(1);
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1);
    assert.match(
      pushes(shim)[0]!.content,
      /^- and 300 more across at least 256 streams past the 256 it names one by one: 300 went off air unpushed while the hour's push budget was spent \(push_budget; heard \S+Z to \S+Z\)\.$/mu,
    );
  } finally {
    h.dispose();
  }
});

test("#119 second review, re-review 2: a push given back folds again what it had folded, with that stream's notes since, and it stays folded, so no stream is named and folded both", async () => {
  const { h, host, shim, frees } = await promised(258);
  try {
    h.timers.advance(frees + 6_000 - h.clock.now());
    assert.equal(pushes(shim).length, 2, "s1..s256 by name, s257 folded");
    // Unconfirmed: s257's next record leaves the view and goes off air, named now.
    host.sing(2, { station: "s257", key: manyKey(257), ttlMs: 5_000 });
    h.timers.advance(1_000);
    host.pluck(2, { station: "s257", key: manyKey(257) });
    h.timers.advance(6_000);
    assert.equal(pendingNotes(h)["s257:ops.fleet"]?.offAir, 1);
    shim.close(); // given back: s257's own entry folds, and a named place frees
    // With no session, s257's next record goes off air: folded still, not named again.
    host.sing(3, { station: "s257", key: manyKey(257), ttlMs: 3_000 });
    h.timers.advance(5_000);
    assert.equal(pendingNotes(h)["s257:ops.fleet"], undefined, "folded");
    const next = h.attach("scribe", { sessionId: SESSION });
    h.timers.advance(6_000);
    assert.equal(pushes(next).length, 1, "told again");
    const note = pushes(next)[0]!.content;
    assert.equal(omissionsTold(note), 258);
    assert.equal(offAirTold(note), 1);
    assert.doesNotMatch(note, /^-? ?s257:ops\.fleet: /mu);
    assert.match(
      note,
      /^and 1 more stream past the 256 it names one by one: 1 went off air unpushed\.$/mu,
    );
    assert.match(
      note,
      /^- and 3 more across 2 streams past the 256 it names one by one: 1 went off air unpushed while no session held this ear \(no_session; heard \S+Z to \S+Z\); 2 went off air unpushed while the hour's push budget was spent \(push_budget; heard \S+Z to \S+Z\)\.$/mu,
    );
  } finally {
    h.dispose();
  }
});

/** A saved note owed nothing: one record that went off air while frond-ear was paused. */
const pausedNote = (key: string, at: number, count = 1) => ({
  offAir: 0,
  dropped: 0,
  withheld: [["paused", { count, from: at, to: at }]],
  key,
  owed: false,
});

test("#119 second review, re-review 5: the stations FOLDED keeps go to streams owed a push before streams owed nothing, so an owed note past 512 streams still wakes; 255 owed nothing is the control", async () => {
  const s = manyKey(900);
  for (const unowed of [256, 255]) {
    const { h, host } = setup(
      { mode: "immediate", maxItems: 1, maxPushesPerHour: 1 },
      { wakeKeys: [ALPHA, s] },
    );
    try {
      const now = h.clock.now();
      const pending: Record<string, unknown> = {};
      for (let i = 0; i < 256; i++) {
        pending[`n${i}:ops.fleet`] = pausedNote(manyKey(i), now - 1_000);
      }
      pending["*"] = {
        ...pausedNote("", now - 1_000, unowed),
        streams: Array.from({ length: unowed }, (_, i) => ({
          stream: `f${i}:ops.fleet`,
          key: manyKey(300 + i),
          owed: false,
          withheld: true,
          missed: false,
        })),
      };
      h.store.setRuntimeState(
        "canticle.withheld.scribe",
        JSON.stringify({ pending, carried: {} }),
      );
      // The hour's one push went a second ago.
      h.store.setRuntimeState(
        "canticle.cursor.scribe",
        JSON.stringify({
          report: 0,
          after: {},
          streams: {},
          pushes: [now - 1_000],
        }),
      );
      const shim = h.attach("scribe", { sessionId: SESSION });
      host.sing(1, { station: "s", key: s, ttlMs: 10_000 }); // owed under the budget
      h.timers.advance(12_000);
      h.timers.advance(3_600_000);
      assert.equal(pushes(shim).length, 1, `s's push of its own (${unowed})`);
      assert.equal(omissionsTold(pushes(shim)[0]!.content), 256 + unowed + 1);
    } finally {
      h.dispose();
    }
  }
});

test("#119 second review, re-review 5: a given-back FOLDED with every station it keeps owed leaves a named note owed a push named, so it keeps that push; with a station free it is folded and keeps it too", async () => {
  const s = manyKey(900);
  for (const folded of [256, 255]) {
    const delivery = { mode: "immediate", maxItems: 1, maxPushesPerHour: 1 };
    const t = Array.from({ length: 255 }, (_, i) => manyKey(i));
    const u = Array.from({ length: folded }, (_, i) => manyKey(300 + i));
    const { h, host } = setup(delivery, { wakeKeys: [ALPHA, s, ...t, ...u] });
    try {
      const at = h.clock.now() - 1_000;
      h.store.setRuntimeState(
        "canticle.withheld.scribe",
        JSON.stringify({
          pending: {
            "*": {
              offAir: 0,
              dropped: 0,
              withheld: [["push_budget", { count: 1, from: at, to: at }]],
              key: "",
              owed: true,
              streams: [
                {
                  stream: "s:ops.fleet",
                  key: s,
                  owed: true,
                  withheld: true,
                  missed: false,
                },
              ],
            },
          },
          carried: {},
        }),
      );
      const shim = h.attach("scribe", { sessionId: SESSION });
      h.timers.advance(6_000);
      assert.equal(
        pushes(shim).length,
        1,
        "s's folded note, a push of its own",
      );
      // Unconfirmed, the budget spent: s, 255 t's and the u's go off air, owed; s and the
      // t's are named, the u's folded.
      host.sing(2, { station: "s", key: s, ttlMs: 10_000 });
      t.forEach((key, i) =>
        host.sing(1, { station: `t${i}`, key, ttlMs: 10_000 }),
      );
      u.forEach((key, i) =>
        host.sing(1, { station: `u${i}`, key, ttlMs: 10_000 }),
      );
      h.timers.advance(12_000);
      shim.close(); // given back: the folded s merges in
      h.daemon.reloadConfig(canticleConfig(delivery, { wakeKeys: [ALPHA, s] }));
      const next = h.attach("scribe", { sessionId: SESSION });
      h.timers.advance(60_000);
      assert.equal(pushes(next).length, 1, `s's push of its own (${folded})`);
      assert.equal(omissionsTold(pushes(next)[0]!.content), 2 + 255 + folded);
    } finally {
      h.dispose();
    }
  }
});

test("#119 second review, re-review 5: a folded count whose streams of one kind are all past the stations it keeps says at least one, never at least 0", async () => {
  const { h, host } = setup({ mode: "immediate", maxPushesPerHour: 360 });
  try {
    const at = h.clock.now() - 60_000;
    h.store.setRuntimeState(
      "canticle.withheld.scribe",
      JSON.stringify({
        pending: {
          "*": {
            ...pausedNote("", at, 256),
            offAir: 1,
            streams: Array.from({ length: 256 }, (_, i) => ({
              stream: `s${i}:ops.fleet`,
              key: manyKey(i),
              owed: false,
              withheld: true,
              missed: false,
            })),
            more: true,
          },
        },
        carried: {},
      }),
    );
    const shim = h.attach("scribe");
    host.sing(1);
    h.timers.advance(6_000);
    const push = pushes(shim)[0]!.content;
    assert.doesNotMatch(push, /at least 0 /u);
    assert.match(
      push,
      /^and at least 1 more stream past the 256 it names one by one: 1 went off air unpushed\.$/mu,
    );
  } finally {
    h.dispose();
  }
});

test("#119 second review, re-review 6: a given-back FOLDED owed for a stream with no place to be had makes that stream's own entry owed, so the push it was owed still comes; with a place free, its place is owed", async () => {
  const s = manyKey(900);
  for (const folded of [256, 255]) {
    const delivery = { mode: "immediate", maxItems: 1, maxPushesPerHour: 1 };
    const t = Array.from({ length: 255 }, (_, i) => manyKey(i));
    const u = Array.from({ length: folded }, (_, i) => manyKey(300 + i));
    const { h, host } = setup(delivery, { wakeKeys: [ALPHA, s, ...t, ...u] });
    try {
      const at = h.clock.now() - 1_000;
      h.store.setRuntimeState(
        "canticle.withheld.scribe",
        JSON.stringify({
          pending: {
            "*": {
              offAir: 0,
              dropped: 0,
              withheld: [["push_budget", { count: 1, from: at, to: at }]],
              key: "",
              owed: true,
              streams: [
                {
                  stream: "s:ops.fleet",
                  key: s,
                  owed: true,
                  withheld: true,
                  missed: false,
                },
              ],
            },
          },
          carried: {},
        }),
      );
      const shim = h.attach("scribe", { sessionId: SESSION });
      h.timers.advance(6_000);
      assert.equal(
        pushes(shim).length,
        1,
        "s's folded note, a push of its own",
      );
      // Unconfirmed, the budget spent: s's next record leaves the view first (named,
      // owed nothing); 255 t's (named) and the u's (folded) go off air, owed.
      host.sing(2, { station: "s", key: s, ttlMs: 10_000 });
      t.forEach((key, i) =>
        host.sing(1, { station: `t${i}`, key, ttlMs: 10_000 }),
      );
      u.forEach((key, i) =>
        host.sing(1, { station: `u${i}`, key, ttlMs: 10_000 }),
      );
      h.timers.advance(1_000);
      host.pluck(2, { station: "s", key: s });
      h.timers.advance(11_000);
      assert.equal(pendingNotes(h)["s:ops.fleet"]?.owed, false);
      shim.close(); // given back: the folded s, owed, merges in
      h.daemon.reloadConfig(canticleConfig(delivery, { wakeKeys: [ALPHA, s] }));
      const next = h.attach("scribe", { sessionId: SESSION });
      h.timers.advance(60_000);
      assert.equal(pushes(next).length, 1, `owed again, and told (${folded})`);
    } finally {
      h.dispose();
    }
  }
});

// 🌫's re-review of round 2 (6022698074), R3: a note given back from several unconfirmed
// pushes keeps the station key of the latest push that carried it, whatever order the
// pushes come back in, live or after a crash; a note since any of them keeps its own.

/** Each key rotation, earlier key first, with its name. */
const ROTATIONS = [
  { keys: [OPS, ALPHA], name: "OPS, then ALPHA" },
  { keys: [ALPHA, OPS], name: "ALPHA, then OPS" },
] as const;

/** Every station s0, s1, … but `but`'s off: only that stream's note can push on its own. */
const offBut = (streams: number, but: number) =>
  Object.fromEntries(
    range(0, streams - 1)
      .filter((i) => i !== but)
      .map((i) => [`s${i}`, "off"]),
  );

/** A folded stream's place among the saved notes not told yet. */
const foldedPlace = (h: Harnessed, stream: string) =>
  pendingNotes(h)["*"]?.streams?.find((f) => f.stream === stream);

/**
 * Reloads with `key` alone on wakeKeys (and `stations`' ceilings), then gives the ear a
 * minute: how many pushes it brought.
 */
function wakesUnder(
  h: Harnessed,
  shim: Parameters<typeof pushes>[0],
  key: string,
  stations: Record<string, string> = {},
): number {
  const before = pushes(shim).length;
  h.daemon.reloadConfig(
    canticleConfig(
      { mode: "immediate", maxPushesPerHour: 1, stations },
      { wakeKeys: [key] },
    ),
  );
  h.timers.advance(60_000);
  return pushes(shim).length - before;
}

/**
 * 🌫's R3 setup, at one push an hour: that push spent and confirmed, stations s0, s1, …
 * (`streams` of them, one key, distinct epochs) each sing a 10 s record under `first`,
 * which goes off air under the spent budget; once the hour frees, the note goes out on its
 * own, unconfirmed: past 256 streams, s256 on is folded. Then the stations `again` names
 * (every one by default) sing under `later`, and go off air too: with `pushed` 2, that
 * note goes out the next hour, unconfirmed as well; with 1, it waits for a push, owed.
 */
async function rotated(
  [first, later]: readonly [string, string],
  streams: number,
  options: { pushed?: 1 | 2; again?: readonly number[]; path?: string } = {},
) {
  const { h, host } = setup(
    { mode: "immediate", maxPushesPerHour: 1 },
    {},
    {},
    options,
  );
  const shim = h.attach("scribe", { sessionId: SESSION });
  host.sing(1);
  h.timers.advance(6_000);
  await confirm(shim);
  const sing = (key: string, seq: number, stations: readonly number[]) => {
    for (const i of stations) {
      host.sing(seq, { station: `s${i}`, key, epoch: 100 + i, ttlMs: 10_000 });
    }
    h.timers.advance(12_000); // off air under the spent budget: owed
  };
  const free = () =>
    h.timers.advance(status(h).lastPushAt! + 3_600_000 + 6_000 - h.clock.now());
  sing(first, 1, range(0, streams - 1));
  free();
  assert.equal(pushes(shim).length, 2, "the first note, on its own");
  sing(later, 2, options.again ?? range(0, streams - 1));
  if ((options.pushed ?? 2) === 2) {
    free();
    assert.equal(pushes(shim).length, 3, "the later note, on its own");
  }
  return { h, host, shim };
}

/**
 * The process holding `h` dies (nothing reverts its unconfirmed pushes), and a fresh one
 * starts on the same database at `path`, a second later. With `pass`, a delivery pass
 * reads the saved notes before the attach reverts the pushes; else the revert reads them.
 */
function crashed(
  h: Harnessed,
  path: string,
  pass: boolean,
  delivery: Record<string, unknown>,
  canticle: Record<string, unknown> = {},
) {
  const at = h.clock.now();
  h.store.close();
  rmSync(h.directory, { recursive: true, force: true });
  const again = setup(delivery, canticle, {}, { path }).h;
  again.clock.value = at + 1_000;
  if (pass) again.timers.advance(1_000);
  return { h: again, shim: again.attach("scribe", { sessionId: SESSION }) };
}

for (const { keys, name } of ROTATIONS) {
  test(`#119 re-review R3 (${name}): two unconfirmed notes for 257 streams, under a key and then a later one, given back on a disconnect: every stream keeps the later key, so the folded one pushes on its own under that key alone, never under the earlier`, async () => {
    const [first, later] = keys;
    const { h, shim } = await rotated(keys, 257);
    try {
      shim.close(); // both given back, the earlier first
      const place = foldedPlace(h, "s256:ops.fleet");
      assert.equal(place?.key, later, "the folded stream's key");
      assert.equal(place?.owed, true, "owed");
      assert.equal(
        pendingNotes(h)["s0:ops.fleet"]?.key,
        later,
        "a named one's",
      );
      const next = h.attach("scribe", { sessionId: SESSION });
      assert.equal(
        wakesUnder(h, next, first, offBut(257, 256)),
        0,
        "earlier key",
      );
      assert.equal(
        wakesUnder(h, next, later, offBut(257, 256)),
        1,
        "later key",
      );
      assert.equal(omissionsTold(pushes(next)[0]!.content), 2 * 257);
      await confirm(next);
      h.timers.advance(3_600_000);
      assert.equal(pushes(next).length, 1, "once");
    } finally {
      h.dispose();
    }
  });
}

for (const pass of [false, true]) {
  for (const { keys, name } of ROTATIONS) {
    test(`#119 re-review R3 (${name}; ${pass ? "a pass reads the saved notes, then the revert" : "the revert reads the saved notes"}): the same two notes left unconfirmed by a crash: a fresh process on the saved database gives both back with the later key`, async () => {
      const [first, later] = keys;
      const directory = mkdtempSync(join(tmpdir(), "frond-ear-rotated-"));
      const path = join(directory, "ear.db");
      try {
        const { h } = await rotated(keys, 257, { path });
        const again = crashed(
          h,
          path,
          pass,
          {
            mode: "immediate",
            maxPushesPerHour: 1,
            stations: offBut(257, 256),
          },
          { wakeKeys: [first] },
        );
        try {
          const place = foldedPlace(again.h, "s256:ops.fleet");
          assert.equal(place?.key, later, "the folded stream's key");
          assert.equal(place?.owed, true, "owed");
          assert.equal(pendingNotes(again.h)["s0:ops.fleet"]?.key, later);
          again.h.timers.advance(60_000);
          assert.equal(pushes(again.shim).length, 0, "earlier key");
          assert.equal(
            wakesUnder(again.h, again.shim, later, offBut(257, 256)),
            1,
            "later key",
          );
          assert.equal(omissionsTold(pushes(again.shim)[0]!.content), 2 * 257);
        } finally {
          again.h.dispose();
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}

for (const again of [range(0, 256), [256]]) {
  for (const { keys, name } of ROTATIONS) {
    test(`#119 re-review R3, control (${name}; ${again.length === 1 ? "named" : "folded"} since): a note since an unconfirmed push, under a later key, keeps that key when the push is given back, folded or named over the push's fold; a blind overwrite would push under the earlier key`, async () => {
      const [first, later] = keys;
      const { h, shim } = await rotated(keys, 257, { pushed: 1, again });
      try {
        // s256's note since is folded behind 256 named ones, or named on its own.
        assert.equal(
          pendingNotes(h)["s256:ops.fleet"]?.key,
          again.length === 1 ? later : undefined,
        );
        shim.close(); // the earlier note given back
        const place = foldedPlace(h, "s256:ops.fleet");
        assert.equal(place?.key, later, "kept");
        assert.equal(place?.owed, true, "owed");
        if (again.length > 1) {
          assert.equal(pendingNotes(h)["s0:ops.fleet"]?.key, later);
        }
        const next = h.attach("scribe", { sessionId: SESSION });
        assert.equal(
          wakesUnder(h, next, first, offBut(257, 256)),
          0,
          "earlier key",
        );
        assert.equal(
          wakesUnder(h, next, later, offBut(257, 256)),
          1,
          "later key",
        );
        assert.equal(
          omissionsTold(pushes(next)[0]!.content),
          257 + again.length,
        );
      } finally {
        h.dispose();
      }
    });
  }
}

for (const crash of [undefined, "the revert reads", "a pass reads"]) {
  for (const { keys, name } of ROTATIONS) {
    test(`#119 re-review R3, named (${name}; ${crash === undefined ? "a disconnect" : `a crash, ${crash} the saved notes`}): one stream's two unconfirmed notes, under a key and then a later one, given back: its own entry keeps the later key`, async () => {
      const [first, later] = keys;
      const directory = mkdtempSync(join(tmpdir(), "frond-ear-rotated-"));
      const path = join(directory, "ear.db");
      try {
        const { h, shim } = await rotated(keys, 1, { path });
        let ear: { h: Harnessed; shim: Parameters<typeof pushes>[0] };
        if (crash === undefined) {
          shim.close();
          ear = { h, shim: h.attach("scribe", { sessionId: SESSION }) };
        } else {
          ear = crashed(h, path, crash === "a pass reads", {
            mode: "immediate",
            maxPushesPerHour: 1,
          });
        }
        try {
          assert.equal(pendingNotes(ear.h)["s0:ops.fleet"]?.key, later);
          assert.equal(pendingNotes(ear.h)["s0:ops.fleet"]?.owed, true);
          assert.equal(wakesUnder(ear.h, ear.shim, first), 0, "earlier");
          assert.equal(wakesUnder(ear.h, ear.shim, later), 1, "later");
          assert.equal(omissionsTold(pushes(ear.shim)[0]!.content), 2);
        } finally {
          ear.h.dispose();
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}

/**
 * At one push an hour, an unconfirmed push carries s0's record 1 under `first` (30 s) and
 * spends the hour; s0's record 2, under `later`, goes off air under the spent budget,
 * owed, and so does record 1, before anything is given back. With `pushed`, the note goes
 * out on its own the next hour, unconfirmed too.
 */
async function carried(
  [first, later]: readonly [string, string],
  pushed: boolean,
) {
  const { h, host } = setup({ mode: "immediate", maxPushesPerHour: 1 });
  const shim = h.attach("scribe", { sessionId: SESSION });
  host.sing(1, { station: "s0", key: first, epoch: 100, ttlMs: 30_000 });
  h.timers.advance(6_000);
  assert.deepEqual(order(pushes(shim)[0]!.content), ["s0:ops.fleet/1"]);
  host.sing(2, { station: "s0", key: later, epoch: 100, ttlMs: 10_000 });
  h.timers.advance(30_000);
  assert.equal(pendingNotes(h)["s0:ops.fleet"]?.key, later, "owed since");
  if (pushed) {
    h.timers.advance(status(h).lastPushAt! + 3_600_000 + 6_000 - h.clock.now());
    assert.equal(pushes(shim).length, 2, "the note, on its own");
  }
  return { h, host, shim };
}

for (const pushed of [false, true]) {
  for (const { keys, name } of ROTATIONS) {
    test(`#119 re-review R3, sibling (${name}; the later note ${pushed ? "in a later unconfirmed push" : "waiting since"}): a record a given-back push carried, off air by then, is told as of that push, so the later note's key is kept`, async () => {
      const [first, later] = keys;
      const { h, shim } = await carried(keys, pushed);
      try {
        shim.close(); // given back: record 1 is off air, so it is told
        assert.equal(pendingNotes(h)["s0:ops.fleet"]?.key, later, "kept");
        assert.equal(pendingNotes(h)["s0:ops.fleet"]?.offAir, 1);
        const next = h.attach("scribe", { sessionId: SESSION });
        assert.equal(wakesUnder(h, next, first), 0, "earlier key");
        assert.equal(wakesUnder(h, next, later), 1, "later key");
        const push = pushes(next)[0]!.content;
        assert.equal(offAirTold(push), 1);
        assert.equal(omissionsTold(push), 1);
      } finally {
        h.dispose();
      }
    });
  }
}

for (const { keys, name } of ROTATIONS) {
  test(`#119 re-review R3, sibling (${name}): a pushed record the live set evicts while its push is unconfirmed, told as that drop on the pass after the push is given back, is told as of that push, so a note since keeps its later key`, async () => {
    const [first, later] = keys;
    const { h, host } = setup({
      mode: "immediate",
      maxPushesPerHour: 360,
      bufferPerStream: 256,
      maxItems: 10,
    });
    try {
      const shim = h.attach("scribe", { sessionId: SESSION });
      // 16 full shares, ops:ops.fleet's first: its record 1 under `first`, the rest
      // hear-only.
      host.sing(1, { key: first, ttlMs: 300_000 });
      for (let n = 2; n <= 256; n++) {
        host.sing(n, { key: STRAY, epoch: 50, ttlMs: 300_000 });
      }
      for (let s = 1; s <= 15; s++) {
        for (let n = 1; n <= 256; n++) {
          host.sing(n, { station: `stray${s}`, key: STRAY, epoch: s });
        }
      }
      h.timers.advance(6_000);
      assert.deepEqual(order(pushes(shim)[0]!.content), ["ops:ops.fleet/1"]);
      // Unconfirmed: the flood's next record evicts record 1, and the full share refuses
      // ops:ops.fleet's record 2 under `later`, which is told as a drop of its own, owed.
      host.sing(1, { station: "stray16", key: STRAY, epoch: 16 });
      host.sing(2, { key: later, epoch: 60, ttlMs: 300_000 });
      h.timers.advance(1_000);
      assert.equal(pendingNotes(h)["ops:ops.fleet"]?.key, later, "the drop");
      shim.close(); // given back: record 1 waits again, marked dropped
      const next = h.attach("scribe", { sessionId: SESSION });
      h.timers.advance(1_000); // and is told as the live set's drop
      const note = pendingNotes(h)["ops:ops.fleet"];
      assert.equal(withheldSum({ note: note! }, "live_overflow"), 2, "both");
      assert.equal(note?.key, later, "kept");
      assert.equal(wakesUnder(h, next, first), 0, "earlier key");
      assert.equal(wakesUnder(h, next, later), 1, "later key");
      assert.equal(overflowTold(next, "ops:ops.fleet"), 2);
    } finally {
      h.dispose();
    }
  });
}

for (const pushed of [1, 2] as const) {
  for (const pass of [false, true]) {
    test(`#119 re-review R3, upgrade (${pushed === 1 ? "a push, then notes since" : "two pushes"}; ${pass ? "a pass reads the saved notes, then the revert" : "the revert reads the saved notes"}): notes an earlier build saved, which say no push they are as of, are as of the push that carried them, so a crash's given-back push can't put its earlier key over a later push's or the notes since`, async () => {
      const [first, later] = [OPS, ALPHA];
      const directory = mkdtempSync(join(tmpdir(), "frond-ear-rotated-"));
      const path = join(directory, "ear.db");
      try {
        const { h } = await rotated([first, later], 257, { pushed, path });
        // As an earlier build saved them: the carried pushes' notes without `asOf`.
        const name = "canticle.withheld.scribe";
        const saved = h.store.runtimeState(name)!;
        assert.match(saved, /"carried":\{"\d+":\{.*"asOf":\d+/u);
        h.store.setRuntimeState(name, saved.replace(/,"asOf":[\d.]+/gu, ""));
        assert.doesNotMatch(h.store.runtimeState(name)!, /asOf/u);
        const again = crashed(
          h,
          path,
          pass,
          {
            mode: "immediate",
            maxPushesPerHour: 1,
            stations: offBut(257, 256),
          },
          { wakeKeys: [first] },
        );
        try {
          assert.equal(foldedPlace(again.h, "s256:ops.fleet")?.key, later);
          assert.equal(pendingNotes(again.h)["s0:ops.fleet"]?.key, later);
          again.h.timers.advance(60_000);
          assert.equal(pushes(again.shim).length, 0, "earlier key");
          assert.equal(
            wakesUnder(again.h, again.shim, later, offBut(257, 256)),
            1,
            "later key",
          );
          assert.equal(omissionsTold(pushes(again.shim)[0]!.content), 2 * 257);
        } finally {
          again.h.dispose();
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}

/**
 * At one push an hour, that push spent and confirmed: stations s0, s1, … (`earlier` of
 * them) go off air under `first`, owed, and their note goes out on its own, unconfirmed;
 * then t0 to t255 and s0 go off air under `later`, in that order, so s0 is folded behind
 * the t's, and that note goes out the next hour, unconfirmed too.
 */
async function refolded(
  [first, later]: readonly [string, string],
  earlier: number,
) {
  const { h, host } = setup({ mode: "immediate", maxPushesPerHour: 1 });
  const shim = h.attach("scribe", { sessionId: SESSION });
  host.sing(1);
  h.timers.advance(6_000);
  await confirm(shim);
  const free = () =>
    h.timers.advance(status(h).lastPushAt! + 3_600_000 + 6_000 - h.clock.now());
  for (let i = 0; i < earlier; i++) {
    host.sing(1, {
      station: `s${i}`,
      key: first,
      epoch: 100 + i,
      ttlMs: 10_000,
    });
  }
  h.timers.advance(12_000);
  free();
  assert.equal(pushes(shim).length, 2, "the first note, on its own");
  for (let i = 0; i < 256; i++) {
    host.sing(1, {
      station: `t${i}`,
      key: later,
      epoch: 1_000 + i,
      ttlMs: 10_000,
    });
  }
  host.sing(2, { station: "s0", key: later, epoch: 100, ttlMs: 10_000 });
  h.timers.advance(12_000);
  assert.equal(pendingNotes(h)["s0:ops.fleet"], undefined, "s0 folded");
  free();
  assert.equal(pushes(shim).length, 3, "the later note, on its own");
  return { h, shim };
}

for (const earlier of [1, 512]) {
  for (const { keys, name } of ROTATIONS) {
    test(`#119 re-review R3, folded later (${name}; ${earlier === 1 ? "a place free" : "no place to be had"}): a stream named in an earlier unconfirmed push and folded in a later one, both given back: folded into its place, or left named, it keeps the later key`, async () => {
      const [first, later] = keys;
      const { h, shim } = await refolded(keys, earlier);
      try {
        shim.close(); // both given back, the earlier first
        const named = pendingNotes(h)["s0:ops.fleet"];
        if (earlier === 1) {
          assert.equal(named, undefined, "folded into its place");
          assert.equal(foldedPlace(h, "s0:ops.fleet")?.key, later, "its key");
          assert.equal(foldedPlace(h, "s0:ops.fleet")?.owed, true);
        } else {
          assert.equal(foldedPlace(h, "s0:ops.fleet"), undefined, "no place");
          assert.equal(named?.key, later, "its entry's key");
          assert.equal(named?.owed, true);
        }
        const stations = Object.fromEntries([
          ...range(1, earlier - 1).map((i) => [`s${i}`, "off"]),
          ...range(0, 255).map((i) => [`t${i}`, "off"]),
        ]);
        const next = h.attach("scribe", { sessionId: SESSION });
        assert.equal(wakesUnder(h, next, first, stations), 0, "earlier key");
        assert.equal(wakesUnder(h, next, later, stations), 1, "later key");
        assert.equal(omissionsTold(pushes(next)[0]!.content), earlier + 257);
      } finally {
        h.dispose();
      }
    });
  }
}

for (const { keys, name } of ROTATIONS) {
  test(`#119 re-review R3, ties (${name}; live): with no push between, a stream's later note keeps its own key over an earlier note's, named or folded, as before`, async () => {
    const [first, later] = keys;
    const { h, host } = setup({ mode: "immediate", maxPushesPerHour: 1 });
    try {
      const shim = h.attach("scribe", { sessionId: SESSION });
      host.sing(1);
      h.timers.advance(6_000);
      await confirm(shim);
      for (const [seq, key] of [
        [1, first],
        [2, later],
      ] as const) {
        for (let i = 0; i < 257; i++) {
          host.sing(seq, {
            station: `s${i}`,
            key,
            epoch: 100 + i,
            ttlMs: 10_000,
          });
        }
        h.timers.advance(12_000); // off air under the spent budget: owed
      }
      assert.equal(pendingNotes(h)["s0:ops.fleet"]?.key, later, "named");
      assert.equal(foldedPlace(h, "s256:ops.fleet")?.key, later, "folded");
      // Under the earlier key alone, the hour frees and nothing pushes on its own.
      wakesUnder(h, shim, first, offBut(257, 256));
      h.timers.advance(status(h).lastPushAt! + 3_600_000 - h.clock.now());
      assert.equal(wakesUnder(h, shim, first, offBut(257, 256)), 0, "earlier");
      assert.equal(wakesUnder(h, shim, later, offBut(257, 256)), 1, "later");
    } finally {
      h.dispose();
    }
  });

  test(`#119 re-review R3, ties (${name}; one push): a given-back push that carried a note of a stream and a record of it, off air by then, leaves the record's key: it was on air when the push went, the note's record before`, async () => {
    const [first, later] = keys;
    const { h, host } = setup({ mode: "immediate", maxPushesPerHour: 1 });
    try {
      const shim = h.attach("scribe", { sessionId: SESSION });
      host.sing(1);
      h.timers.advance(6_000);
      await confirm(shim);
      const frees = status(h).lastPushAt! + 3_600_000;
      host.sing(1, { station: "s0", key: first, epoch: 100, ttlMs: 10_000 });
      h.timers.advance(12_000); // off air under the spent budget: owed
      h.timers.advance(frees - 10_000 - h.clock.now());
      host.sing(2, { station: "s0", key: later, epoch: 100, ttlMs: 20_000 });
      h.timers.advance(frees + 1_000 - h.clock.now());
      assert.equal(pushes(shim).length, 2, "the note and record 2, one push");
      assert.deepEqual(order(pushes(shim)[1]!.content), ["s0:ops.fleet/2"]);
      assert.equal(omissionsTold(pushes(shim)[1]!.content), 1);
      h.timers.advance(30_000); // record 2 goes off air, its push unconfirmed
      shim.close(); // given back: the note, then record 2, told as off air
      const note = pendingNotes(h)["s0:ops.fleet"];
      assert.equal(note?.key, later, "record 2's key");
      assert.equal(note?.offAir, 1);
      assert.equal(note?.owed, true);
      const next = h.attach("scribe", { sessionId: SESSION });
      assert.equal(wakesUnder(h, next, first), 0, "earlier key");
      assert.equal(wakesUnder(h, next, later), 1, "later key");
    } finally {
      h.dispose();
    }
  });
}

// The independent review of the R3 repair (F1, F2): a note carried again by a later push
// is no later for it, and a push's records are later than the notes it carried, in the
// order they were heard.

/**
 * At one push an hour, the hour's push spent and confirmed: s0's record 1 under `first`
 * goes off air under the spent budget, owed (with `folded`, behind 256 t stations' notes,
 * so s0 is folded). Record 2, under `later`, heard after it, goes out with that note in
 * push b1 once the hour frees. While b1 is unconfirmed the station plucks record 2, and b1
 * is given back: the note waits again, and record 2 waits off view. Another stream's record
 * sets off push b2, which carries the note again; record 2 goes off air after b2 went out
 * (with `early`, before it, so b2 carries its note too).
 */
async function recarried(
  [first, later]: readonly [string, string],
  options: { folded?: boolean; early?: boolean; path?: string } = {},
) {
  const { h, host } = setup(
    { mode: "immediate", maxPushesPerHour: 1 },
    {},
    {},
    options,
  );
  const shim = h.attach("scribe", { sessionId: SESSION });
  host.sing(1);
  h.timers.advance(6_000);
  await confirm(shim);
  const frees = status(h).lastPushAt! + 3_600_000;
  if (options.folded) {
    for (let i = 0; i < 256; i++) {
      host.sing(1, {
        station: `t${i}`,
        key: first,
        epoch: 1_000 + i,
        ttlMs: 10_000,
      });
    }
    h.timers.advance(12_000);
  }
  host.sing(1, { station: "s0", key: first, epoch: 100, ttlMs: 10_000 });
  h.timers.advance(12_000); // off air under the spent budget: owed
  h.timers.advance(frees - 10_000 - h.clock.now());
  const ttlMs = options.early ? 15_000 : 120_000;
  host.sing(2, { station: "s0", key: later, epoch: 100, ttlMs });
  h.timers.advance(frees + 1_000 - h.clock.now());
  assert.equal(pushes(shim).length, 2, "b1");
  assert.deepEqual(order(pushes(shim)[1]!.content), ["s0:ops.fleet/2"]);
  host.pluck(2, { station: "s0", key: later, epoch: 100 });
  shim.close(); // b1 given back
  const next = h.attach("scribe", { sessionId: SESSION });
  host.sing(1, { station: "s1", key: OPS, epoch: 200, ttlMs: 20_000 });
  h.timers.advance(6_000);
  assert.equal(pushes(next).length, 1, "b2");
  assert.deepEqual(order(pushes(next)[0]!.content), ["s1:ops.fleet/1"]);
  assert.equal(
    omissionsTold(pushes(next)[0]!.content),
    options.folded ? 257 : 1,
  );
  h.timers.advance(130_000);
  if (!options.early) {
    assert.equal(pendingNotes(h)["s0:ops.fleet"]?.key, later, "noted since b2");
  }
  return { h, shim: next };
}

/** Every station a `recarried` note can't wake on its own: the t's and s1. */
const othersOff = Object.fromEntries([
  ...range(0, 255).map((i) => [`t${i}`, "off"]),
  ["s1", "off"],
]);

const s0Key = (h: Harnessed) =>
  pendingNotes(h)["s0:ops.fleet"]?.key ?? foldedPlace(h, "s0:ops.fleet")?.key;

for (const crash of [undefined, "the revert reads", "a pass reads"]) {
  for (const { keys, name } of ROTATIONS) {
    test(`#119 R3 re-review F1 (${name}; ${crash === undefined ? "a disconnect" : `a crash, ${crash} the saved notes`}): a note carried again by a later push is no later for it: given back, it can't put its key over that of a record given back before, which went off air since`, async () => {
      const [first, later] = keys;
      const directory = mkdtempSync(join(tmpdir(), "frond-ear-recarried-"));
      const path = join(directory, "ear.db");
      try {
        const { h, shim } = await recarried(keys, { path });
        let ear: { h: Harnessed; shim: Parameters<typeof pushes>[0] };
        if (crash === undefined) {
          shim.close(); // b2 given back
          ear = { h, shim: h.attach("scribe", { sessionId: SESSION }) };
        } else {
          ear = crashed(h, path, crash === "a pass reads", {
            mode: "immediate",
            maxPushesPerHour: 1,
          });
        }
        try {
          assert.equal(pendingNotes(ear.h)["s0:ops.fleet"]?.key, later);
          assert.equal(pendingNotes(ear.h)["s0:ops.fleet"]?.owed, true);
          assert.equal(
            wakesUnder(ear.h, ear.shim, first, othersOff),
            0,
            "earlier",
          );
          assert.equal(
            wakesUnder(ear.h, ear.shim, later, othersOff),
            1,
            "later",
          );
        } finally {
          ear.h.dispose();
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}

for (const variant of ["folded", "early"] as const) {
  for (const { keys, name } of ROTATIONS) {
    test(`#119 R3 re-review F1 (${name}; ${variant === "folded" ? "s0 folded" : "control: record 2 off air before b2"}): given back on a disconnect, s0 keeps record 2's later key`, async () => {
      const [first, later] = keys;
      const { h, shim } = await recarried(keys, { [variant]: true });
      try {
        shim.close(); // b2 given back
        assert.equal(s0Key(h), later);
        const next = h.attach("scribe", { sessionId: SESSION });
        assert.equal(wakesUnder(h, next, first, othersOff), 0, "earlier key");
        assert.equal(wakesUnder(h, next, later, othersOff), 1, "later key");
      } finally {
        h.dispose();
      }
    });
  }
}

for (const { keys, name } of ROTATIONS) {
  test(`#119 R3 re-review F2 (${name}): of a given-back push's records of one stream, off air by then, the last heard leaves its key, whatever order their key ids sort in`, async () => {
    const [first, later] = keys;
    const { h, host } = setup({ mode: "immediate", maxPushesPerHour: 1 });
    try {
      const shim = h.attach("scribe", { sessionId: SESSION });
      host.sing(1);
      h.timers.advance(6_000);
      await confirm(shim);
      const frees = status(h).lastPushAt! + 3_600_000;
      host.sing(1, { station: "s0", key: first, epoch: 100, ttlMs: 10_000 });
      h.timers.advance(12_000); // off air under the spent budget: owed
      h.timers.advance(frees - 10_000 - h.clock.now());
      host.sing(2, { station: "s0", key: first, epoch: 100, ttlMs: 20_000 });
      h.timers.advance(1_000);
      host.sing(3, { station: "s0", key: later, epoch: 100, ttlMs: 20_000 });
      h.timers.advance(frees + 1_000 - h.clock.now());
      assert.equal(pushes(shim).length, 2, "the note and records 2 and 3");
      assert.equal(order(pushes(shim)[1]!.content).length, 2);
      h.timers.advance(25_000); // both off air, the push unconfirmed
      shim.close(); // given back: the note, then records 2 and 3, told off air
      const note = pendingNotes(h)["s0:ops.fleet"];
      assert.equal(note?.key, later, "record 3's key, the last heard");
      assert.equal(note?.offAir, 2);
      const next = h.attach("scribe", { sessionId: SESSION });
      assert.equal(wakesUnder(h, next, first), 0, "earlier key");
      assert.equal(wakesUnder(h, next, later), 1, "later key");
    } finally {
      h.dispose();
    }
  });
}

// The confirm pass of the independent review (G1, G2): of one push's records, the last
// heard leaves its key, whether they are told at the revert or later, and whichever side
// of a later push they are told on.

/**
 * At one push an hour, the hour's push spent and confirmed: s0's record 1 under `k1` goes
 * off air under the spent budget, owed (with `folded`, behind 256 t stations' notes).
 * Push b carries that note and two records of s0: rX (under `k1`, a minute on air) and rY
 * (under `k2`, heard 10 s later, or with `same` in the same instant, on air for over three
 * minutes). The station plucks both while b is unconfirmed, and b is given back: both wait
 * off view. rX goes off air, and its note goes out again in push c, set off by s1's
 * record; rY goes off air after c went out. With `mirror`, rY (still heard last) goes off
 * air first and goes out in c, and rX after c.
 */
async function split(
  [k1, k2]: readonly [string, string],
  options: {
    folded?: boolean;
    same?: boolean;
    mirror?: boolean;
    path?: string;
  } = {},
) {
  const [ttlX, ttlY] = options.mirror ? [200_000, 50_000] : [60_000, 200_000];
  const [before, since] = options.mirror ? [k2, k1] : [k1, k2];
  const { h, host } = setup(
    { mode: "immediate", maxPushesPerHour: 1 },
    {},
    {},
    options,
  );
  const shim = h.attach("scribe", { sessionId: SESSION });
  host.sing(1);
  h.timers.advance(6_000);
  await confirm(shim);
  const frees = status(h).lastPushAt! + 3_600_000;
  if (options.folded) {
    for (let i = 0; i < 256; i++) {
      host.sing(1, {
        station: `t${i}`,
        key: k1,
        epoch: 1_000 + i,
        ttlMs: 10_000,
      });
    }
    h.timers.advance(12_000);
  }
  host.sing(1, { station: "s0", key: k1, epoch: 100, ttlMs: 10_000 });
  h.timers.advance(12_000); // off air under the spent budget: owed
  h.timers.advance(frees - 20_000 - h.clock.now());
  host.sing(2, { station: "s0", key: k1, epoch: 100, ttlMs: ttlX }); // rX
  if (!options.same) h.timers.advance(10_000);
  host.sing(3, { station: "s0", key: k2, epoch: 100, ttlMs: ttlY }); // rY
  h.timers.advance(frees + 1_000 - h.clock.now());
  assert.equal(pushes(shim).length, 2, "b");
  assert.equal(order(pushes(shim)[1]!.content).length, 2, "rX and rY");
  host.pluck(2, { station: "s0", key: k1, epoch: 100 });
  host.pluck(3, { station: "s0", key: k2, epoch: 100 });
  shim.close(); // b given back: rX and rY wait off view
  const next = h.attach("scribe", { sessionId: SESSION });
  h.timers.advance(frees + 45_000 - h.clock.now()); // rX (or rY) goes off air
  assert.equal(s0Key(h), before, "told before c");
  host.sing(1, { station: "s1", key: OPS, epoch: 200, ttlMs: 20_000 });
  h.timers.advance(6_000);
  assert.equal(pushes(next).length, 1, "c");
  assert.equal(offAirTold(pushes(next)[0]!.content), 1, "in c");
  h.timers.advance(frees + 210_000 - h.clock.now()); // rY (or rX) goes off air
  assert.equal(pendingNotes(h)["s0:ops.fleet"]?.key, since, "told since c");
  return { h, shim: next };
}

for (const mirror of [false, true]) {
  for (const crash of [undefined, "the revert reads", "a pass reads"]) {
    for (const { keys, name } of ROTATIONS) {
      test(`#119 R3 re-review G1 (${name}; ${mirror ? "the last heard told first, " : ""}${crash === undefined ? "a disconnect" : `a crash, ${crash} the saved notes`}): of a given-back push's two records of one stream, told on either side of a later push, the last heard leaves its key when that push is given back too`, async () => {
        const [k1, k2] = keys;
        const directory = mkdtempSync(join(tmpdir(), "frond-ear-split-"));
        const path = join(directory, "ear.db");
        try {
          const { h, shim } = await split(keys, { mirror, path });
          let ear: { h: Harnessed; shim: Parameters<typeof pushes>[0] };
          if (crash === undefined) {
            shim.close(); // c given back
            ear = { h, shim: h.attach("scribe", { sessionId: SESSION }) };
          } else {
            ear = crashed(h, path, crash === "a pass reads", {
              mode: "immediate",
              maxPushesPerHour: 1,
            });
          }
          try {
            assert.equal(pendingNotes(ear.h)["s0:ops.fleet"]?.key, k2, "rY's");
            assert.equal(wakesUnder(ear.h, ear.shim, k1, othersOff), 0, "k1");
            assert.equal(wakesUnder(ear.h, ear.shim, k2, othersOff), 1, "k2");
          } finally {
            ear.h.dispose();
          }
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
  }
}
for (const variant of ["folded", "same"] as const) {
  for (const { keys, name } of ROTATIONS) {
    test(`#119 R3 re-review G1 (${name}; ${variant === "folded" ? "s0 folded" : "rX and rY heard in the same instant"}): given back on a disconnect, s0 keeps rY's key: ${variant === "folded" ? "folded or named alike" : "a note a push gives back takes no tie from one told since"}`, async () => {
      const [k1, k2] = keys;
      const { h, shim } = await split(keys, { [variant]: true });
      try {
        shim.close(); // c given back
        assert.equal(s0Key(h), k2, "rY's");
        const next = h.attach("scribe", { sessionId: SESSION });
        assert.equal(wakesUnder(h, next, k1, othersOff), 0, "k1");
        assert.equal(wakesUnder(h, next, k2, othersOff), 1, "k2");
      } finally {
        h.dispose();
      }
    });
  }
}

for (const { keys, name } of ROTATIONS) {
  test(`#119 R3 re-review G2 (${name}): of a given-back push's records of one stream, the last heard leaves its key though it is told at the revert and the other later`, async () => {
    const [k1, k2] = keys;
    const { h, host } = setup({ mode: "immediate", maxPushesPerHour: 1 });
    try {
      const shim = h.attach("scribe", { sessionId: SESSION });
      host.sing(1);
      h.timers.advance(6_000);
      await confirm(shim);
      const frees = status(h).lastPushAt! + 3_600_000;
      host.sing(1, { station: "s0", key: k1, epoch: 100, ttlMs: 10_000 });
      h.timers.advance(12_000); // off air under the spent budget: owed
      h.timers.advance(frees - 20_000 - h.clock.now());
      host.sing(2, { station: "s0", key: k1, epoch: 100, ttlMs: 200_000 });
      h.timers.advance(10_000);
      host.sing(3, { station: "s0", key: k2, epoch: 100, ttlMs: 20_000 });
      h.timers.advance(frees + 1_000 - h.clock.now());
      assert.equal(pushes(shim).length, 2, "the note and records 2 and 3");
      host.pluck(2, { station: "s0", key: k1, epoch: 100 });
      h.timers.advance(frees + 15_000 - h.clock.now()); // record 3 goes off air
      shim.close(); // given back: record 3 told now, record 2 waits off view
      assert.equal(pendingNotes(h)["s0:ops.fleet"]?.key, k2, "record 3 told");
      h.timers.advance(frees + 190_000 - h.clock.now()); // record 2 goes off air
      assert.equal(pendingNotes(h)["s0:ops.fleet"]?.offAir, 2, "both told");
      assert.equal(pendingNotes(h)["s0:ops.fleet"]?.key, k2, "record 3's");
      const next = h.attach("scribe", { sessionId: SESSION });
      assert.equal(wakesUnder(h, next, k1), 0, "k1");
      assert.equal(wakesUnder(h, next, k2), 1, "k2");
    } finally {
      h.dispose();
    }
  });
}

// The third pass of the independent review (H1): a record a push gave back is no newer for
// being on view again, as a note carried again is no newer for it.

for (const plucked of [true, false]) {
  for (const { keys, name } of ROTATIONS) {
    test(`#119 R3 re-review H1 (${name}; the given-back record ${plucked ? "off view" : "on view again"}): a record a push gave back, still on air, that goes off air later, can't put its key over a later push's note given back with it`, async () => {
      const [k1, k2] = keys;
      const { h, host } = setup({ mode: "immediate", maxPushesPerHour: 1 });
      try {
        const shim = h.attach("scribe", { sessionId: SESSION });
        host.sing(1);
        h.timers.advance(6_000);
        await confirm(shim);
        const frees = status(h).lastPushAt! + 3_600_000;
        h.timers.advance(frees - 10_000 - h.clock.now());
        // r, heard before push b went, on air past push c.
        host.sing(1, { station: "s0", key: k1, epoch: 100, ttlMs: 4_200_000 });
        h.timers.advance(frees + 1_000 - h.clock.now());
        assert.equal(pushes(shim).length, 2, "b");
        assert.deepEqual(order(pushes(shim)[1]!.content), ["s0:ops.fleet/1"]);
        // r2, heard after b, under k2: off air under the spent budget, owed.
        host.sing(2, { station: "s0", key: k2, epoch: 100, ttlMs: 10_000 });
        h.timers.advance(12_000);
        h.timers.advance(
          status(h).lastPushAt! + 3_600_000 + 6_000 - h.clock.now(),
        );
        assert.equal(pushes(shim).length, 3, "c, r2's note on its own");
        if (plucked) host.pluck(1, { station: "s0", key: k1, epoch: 100 });
        shim.close(); // b and c given back; no session until r goes off air
        assert.equal(pendingNotes(h)["s0:ops.fleet"]?.key, k2, "c's note");
        h.timers.advance(frees + 4_200_000 - h.clock.now()); // r goes off air
        const note = pendingNotes(h)["s0:ops.fleet"]!;
        // r2's, and r's: off air unpushed, or withheld (no_session) if on view.
        assert.equal(note.offAir + withheldSum({ note }), 2, "r told");
        assert.equal(note.key, k2, "c's key kept");
        const next = h.attach("scribe", { sessionId: SESSION });
        assert.equal(wakesUnder(h, next, k1), 0, "k1");
        assert.equal(wakesUnder(h, next, k2), 1, "k2");
      } finally {
        h.dispose();
      }
    });
  }
}
