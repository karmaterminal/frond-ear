// binary-canticle#171 (measurement findings 3–5; cells F9, A1, A4), against #168 §2.4 and
// §2.7a: the record v1 live set admits against the tune, with a share for each tuned
// stream and one for every untuned stream together, and says what it drops; the push
// budget's hold is visible, and what it held until it went off air is reported by the
// next push the budget allows, never by a push beyond it.
import assert from "node:assert/strict";
import test from "node:test";

import { iso } from "../src/canticle/hear.ts";
import { MAX_LIVE } from "../src/canticle/records.ts";
import {
  confirm,
  Host,
  order,
  pushes,
  setup,
  status,
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

  // A tuned flood takes its share from the untuned one; past it, its own records go.
  for (let n = 1; n <= MAX_LIVE; n++) {
    host.sing(n, { station: "stray", stream: "ops.deploy", ttlMs: 60_000 });
  }
  assert.ok(
    c.healthReasons.includes("live_overflow_tuned"),
    c.healthReasons.join(),
  );
  const live = c.liveStatus(time.now());
  assert.equal(live.max, MAX_LIVE);
  assert.ok(live.size <= MAX_LIVE);
  const deploy = live.omitted["stray:ops.deploy"]!;
  const untuned = live.omitted.untuned!;
  assert.ok(deploy.count > 0 && untuned.count > 10, JSON.stringify(live));
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
});
