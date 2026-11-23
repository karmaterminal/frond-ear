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
  canticleConfig,
  confirm,
  Host,
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
