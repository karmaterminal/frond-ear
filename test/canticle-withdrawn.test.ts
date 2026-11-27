// frond-ear#67 (RFC-0001 §14.14): a record already pushed to the session that its station
// withdraws (plucked, revoked, quarantined; for an alarm, expired) gets one short note,
// once, with no payload. Records go in through the real RecordConsumer (record v1) or the
// embedded receptor; what comes out is what the attached session is sent.
import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as cbor from "../src/canticle/cbor.ts";
import { streamId } from "../src/canticle/ids.ts";
import { Manifest } from "../src/canticle/manifest.ts";
import { CanticleReceptor } from "../src/canticle/receptor.ts";
import { RECORD_V } from "../src/canticle/records.ts";
import { KIND_ITEM, KIND_PLUCK, SIGN_DOMAIN } from "../src/canticle/wire.ts";
import { StructuredLogger } from "../src/logger.ts";
import {
  canticleConfig,
  confirm,
  notes,
  OPS,
  order,
  pushes,
  SESSION,
  setup,
  status,
} from "./canticle-host.ts";
import { harness } from "./helpers.ts";

const OTHER_SESSION = "22222222-bbbb-4bbb-8bbb-000000000002";
const LINE =
  /^\[canticle:withdrawn\] (\S+) item=(\S+) reason=(\S+) at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/gmu;

/** Each note's lines, as `station:stream item reason`. */
const lines = (content: string) =>
  [...content.matchAll(LINE)].map(
    ([, at, item, why]) => `${at} ${item} ${why}`,
  );

/** What a note must never carry: a record's payload or banner, or a batch to ack. */
function payloadFree(note: ReturnType<typeof notes>[number]) {
  assert.equal(note.batchId, null, "a note is no batch");
  assert.equal(note.meta.batch_id, undefined, "nothing to ack");
  assert.doesNotMatch(note.content, /deploy\.started/u, "no payload");
  assert.doesNotMatch(note.content, /EXTERNAL_UNTRUSTED_CONTENT/u);
  assert.doesNotMatch(note.content, /\[canticle:heard\]/u, "no record banner");
}

test("#67: a pushed record that is plucked gets exactly one note, after the debounce, with no payload", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1);
    host.sing(2);
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1);
    await confirm(shim);

    host.pluck(1);
    h.timers.advance(1_000);
    assert.equal(notes(shim).length, 0, "notes coalesce like pushes");
    h.timers.advance(5_000);
    assert.equal(notes(shim).length, 1);
    const note = notes(shim)[0]!;
    assert.deepEqual(note.meta, {
      kind: "canticle",
      delivery: "withdrawn",
      count: "1",
    });
    payloadFree(note);
    assert.match(
      note.content,
      /^canticle: 1 record pushed to you earlier was withdrawn \(a note frond-ear writes: no payload, nothing to ack/u,
    );
    assert.deepEqual(lines(note.content), ["ops:ops.fleet 7/1 plucked"]);

    // Once: however long the tombstone holds, and past it.
    h.timers.advance(600_000);
    assert.equal(notes(shim).length, 1);
    assert.equal(pushes(shim).length, 1, "the note re-delivers nothing");
    assert.equal(status(h).counts.withdrawn_notes, 1);
    assert.equal(status(h).counts.withdrawn_noted, 1);
  } finally {
    h.dispose();
  }
});

test("#67: pushed then revoked, and pushed then quarantined: one note each; a superseded one gets none", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1);
    host.sing(2);
    host.sing(3);
    h.timers.advance(6_000);
    await confirm(shim);

    host.retract(1, "revoked");
    h.timers.advance(6_000);
    assert.equal(notes(shim).length, 1);
    assert.deepEqual(lines(notes(shim)[0]!.content), [
      "ops:ops.fleet 7/1 revoked",
    ]);

    host.retract(2, "quarantined");
    h.timers.advance(6_000);
    assert.equal(notes(shim).length, 2);
    assert.deepEqual(lines(notes(shim)[1]!.content), [
      "ops:ops.fleet 7/2 quarantined",
    ]);
    payloadFree(notes(shim)[1]!);

    // Its successor speaks for a superseded record: no note.
    host.retract(3, "superseded");
    h.timers.advance(60_000);
    assert.equal(notes(shim).length, 2);
  } finally {
    h.dispose();
  }
});

test("#67: a record only heard with hear, never pushed, gets no note when plucked", async () => {
  // A bare key wakes for alarm only: the advisory record is passed over (wake_withheld),
  // so it is tombstoned but never pushed. hear shows it to the session.
  const { h, host } = setup({ mode: "immediate" }, { wakeKeys: [OPS] });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1);
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 0);
    const heard = await h.call(shim, "hear", {});
    assert.match(heard.text, /deploy\.started 1/u);

    host.pluck(1);
    h.timers.advance(60_000);
    assert.equal(notes(shim).length, 0, "hear is a read, not a push");
    assert.equal(
      status(h).withdrawn.owed,
      0,
      "a pass-over's tombstone owes none",
    );
    assert.equal(status(h).counts.withdrawn_notes, undefined);
  } finally {
    h.dispose();
  }
});

test("#67: an alarm pushed then expired gets a note; chatter pushed then expired gets none, nor does a host retract for its expiry", async () => {
  const { h, host } = setup(
    { mode: "immediate" },
    { wakeKeys: [{ key: OPS, classes: ["alarm", "chatter"] }] },
  );
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1, { class: "alarm", stateKey: "fire", ttlMs: 30_000 });
    host.sing(2, { class: "chatter", ttlMs: 30_000 });
    host.sing(3, { class: "chatter", ttlMs: 300_000 });
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1);
    assert.equal(pushes(shim)[0]!.meta.count, "3");
    await confirm(shim);

    host.retract(3, "expired"); // the host says chatter 3 expired: noise, no note
    h.timers.advance(20_000);
    assert.equal(notes(shim).length, 0, "nothing has expired on its own yet");
    h.timers.advance(10_000); // past both records' local expiry, then the debounce
    assert.equal(notes(shim).length, 1);
    const note = notes(shim)[0]!;
    payloadFree(note);
    assert.deepEqual(lines(note.content), ["ops:ops.fleet 7/1 expired"]);

    h.timers.advance(600_000);
    assert.equal(notes(shim).length, 1, "chatter's expiry is never a note");

    // A pluck that reaches frond-ear after the record's local expiry is no withdrawal:
    // the record had already left the view.
    host.sing(4, { class: "chatter", ttlMs: 30_000 });
    h.timers.advance(6_000);
    await confirm(shim);
    h.timers.advance(23_500); // the last pass saw 4 live, 500 ms before its expiry
    h.clock.value += 1_000; // its expiry passes before the next pass
    host.pluck(4);
    h.timers.advance(10_000);
    assert.equal(notes(shim).length, 1, "4 had run out before its pluck");
  } finally {
    h.dispose();
  }
});

test("#67: an alarm the host retracts for expiry gets its note too; one superseded before its expiry gets none", async () => {
  const { h, host } = setup(
    { mode: "immediate" },
    { wakeKeys: [{ key: OPS, classes: ["alarm"] }] },
  );
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1, { class: "alarm", stateKey: "fire", ttlMs: 60_000 });
    host.sing(2, { class: "alarm", stateKey: "flood", ttlMs: 60_000 });
    h.timers.advance(6_000);
    await confirm(shim);
    host.retract(1, "expired");
    host.retract(2, "superseded");
    h.timers.advance(6_000);
    assert.equal(notes(shim).length, 1);
    assert.deepEqual(lines(notes(shim)[0]!.content), [
      "ops:ops.fleet 7/1 expired",
    ]);
    h.timers.advance(120_000);
    assert.equal(notes(shim).length, 1, "2 left the view before its expiry");
  } finally {
    h.dispose();
  }
});

test("#67 (🪨 P2 on #134): an alarm that left the view before its expiry gets no expiry note, when frond-ear restarts and first polls inside the tombstone's 5 s skew", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-withdrawn-"));
  const path = join(directory, "ear.db");
  const alarm = { class: "alarm", stateKey: "fire", ttlMs: 30_000 };
  const wake = { wakeKeys: [{ key: OPS, classes: ["alarm"] }] };
  try {
    const first = setup({ mode: "immediate" }, wake, {}, { path });
    let expiry: number;
    try {
      first.h.clock.value = 1_000_000;
      expiry = first.h.clock.value + 30_000; // the alarm's local expiry
      const shim = first.h.attach("scribe", { sessionId: SESSION });
      first.host.sing(1, alarm);
      first.h.timers.advance(6_000);
      assert.equal(pushes(shim).length, 1);
      await confirm(shim);
      // Its successor replaces it on view, well before its expiry.
      first.host.retract(1, "superseded");
      first.h.timers.advance(10_000);
      assert.equal(notes(shim).length, 0);
    } finally {
      first.h.dispose(); // down before the alarm's expiry
    }
    const second = setup({ mode: "immediate" }, wake, {}, { path });
    try {
      // Back up after the expiry, while the tombstone's 5 s skew still holds it.
      second.h.clock.value = expiry + 2_000;
      const shim = second.h.attach("scribe", { sessionId: SESSION });
      second.h.timers.advance(60_000);
      assert.equal(notes(shim).length, 0, "it never expired on view");
      assert.equal(status(second.h).counts.withdrawn_expired, undefined);
    } finally {
      second.h.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("#67 (🪨 P2 on #134): an alarm superseded and past its expiry between two polls gets no expiry note", async () => {
  const { h, host } = setup(
    { mode: "immediate" },
    { wakeKeys: [{ key: OPS, classes: ["alarm"] }] },
  );
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const expiry = h.clock.value + 30_000;
    host.sing(1, { class: "alarm", stateKey: "fire", ttlMs: 30_000 });
    h.timers.advance(6_000);
    await confirm(shim);
    h.timers.advance(expiry - 700 - h.clock.value); // the last poll saw it on view
    h.clock.value = expiry - 300; // between polls: its successor replaces it,
    host.retract(1, "superseded");
    h.clock.value = expiry + 200; // and its expiry passes, before the next poll
    h.timers.advance(60_000);
    assert.equal(notes(shim).length, 0, "it left the view before its expiry");
  } finally {
    h.dispose();
  }
});

test("#67: an alarm whose link is down when it reaches its expiry gets no expiry note: a retract may have been missed meanwhile", async () => {
  const { h, host } = setup(
    { mode: "immediate" },
    { wakeKeys: [{ key: OPS, classes: ["alarm"] }] },
  );
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1, { class: "alarm", stateKey: "fire", ttlMs: 30_000 });
    h.timers.advance(6_000);
    await confirm(shim);
    host.drop(); // what it held is carried, unconfirmed, until a snapshot
    h.timers.advance(60_000);
    assert.equal(notes(shim).length, 0, "no evidence it ran out on view");
  } finally {
    h.dispose();
  }
});

test("#67 (🪨 #134 review, item 1): a tap that throws after the session took a note never makes the session get it twice", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const tap = h.attach("scribe", { role: "tap" });
    tap.connection.send = () => {
      throw new Error("tap socket gone");
    };
    host.sing(1);
    h.timers.advance(6_000);
    await confirm(shim);
    host.pluck(1);
    h.timers.advance(6_000);
    assert.equal(notes(shim).length, 1, "the session took it");
    h.timers.advance(600_000);
    assert.equal(notes(shim).length, 1, "and never again");
    assert.equal(status(h).withdrawn.owed, 0);
    // Counted as the session's delivery: a tap's failure is not the session's.
    assert.equal(status(h).counts.withdrawn_notes, 1);
    assert.equal(status(h).counts.withdrawn_unknown, undefined);
  } finally {
    h.dispose();
  }
});

test("#67 (🪨 #134 review, item 3): at most once: a send that fails after the note was marked sent loses that note, through a restart, and never sends it twice", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-withdrawn-"));
  const path = join(directory, "ear.db");
  try {
    const first = setup({ mode: "immediate" }, {}, {}, { path });
    let send: typeof shim.connection.send;
    let shim!: ReturnType<typeof first.h.attach>;
    try {
      first.h.clock.value = 1_000_000;
      shim = first.h.attach("scribe", { sessionId: SESSION });
      first.host.sing(1);
      first.host.sing(2);
      first.h.timers.advance(6_000);
      await confirm(shim);
      first.host.pluck(1);
      // The crash window: the mark is committed, then the send's I/O dies.
      send = shim.connection.send.bind(shim.connection);
      shim.connection.send = (message) => {
        if (message.type === "event" && message.meta.delivery === "withdrawn") {
          throw new Error("killed mid-send");
        }
        return send(message);
      };
      first.h.timers.advance(6_000);
      assert.equal(notes(shim).length, 0, "it never went out");
      first.h.timers.advance(60_000);
      assert.equal(notes(shim).length, 0, "and is not tried again");
      assert.equal(status(first.h).counts.withdrawn_unknown, 1);
    } finally {
      first.h.dispose();
    }
    const second = setup({ mode: "immediate" }, {}, {}, { path });
    try {
      second.h.clock.value = 1_100_000;
      const back = second.h.attach("scribe", { sessionId: SESSION });
      second.h.timers.advance(60_000);
      assert.equal(
        notes(back).length,
        0,
        "lost, at most once: never sent twice",
      );
    } finally {
      second.h.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("#67: an alarm still carried from before a rejoin, its join snapshot not yet in, gets no expiry note: its retract may have been missed", async () => {
  const { h, host } = setup(
    { mode: "immediate" },
    { wakeKeys: [{ key: OPS, classes: ["alarm"] }] },
  );
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1, { class: "alarm", stateKey: "fire", ttlMs: 30_000 });
    h.timers.advance(6_000);
    await confirm(shim);
    host.drop();
    // A new connection to the same run asks for a join snapshot that never comes in time.
    host.consumer.reconnected({ joinSnapshot: true });
    const feed = (type: string, recSeq: number, extra = {}) =>
      host.consumer.feed(
        { v: RECORD_V, type, rec_seq: recSeq, run: host.run, ...extra },
        h.clock.now(),
      );
    feed("hello", 1, { join_snapshot: true });
    feed("landing_state", 1_000, { mute: null, breaker: "closed" });
    h.timers.advance(60_000); // past its expiry, still carried
    assert.equal(notes(shim).length, 0, "no evidence it ran out on view");
  } finally {
    h.dispose();
  }
});

test("#67 (🌿 B1 on #134): a same-body refresh after an alarm's expiry note is pushed, across a frond-ear restart too: the note's retention is no refresh seed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-withdrawn-"));
  const path = join(directory, "ear.db");
  const A = "a".repeat(64);
  const alarm = {
    class: "alarm",
    stateKey: "fire",
    text: "fire in rack 3",
    digest: A,
    ttlMs: 60_000,
  };
  const wake = { wakeKeys: [{ key: OPS, classes: ["alarm"] }] };
  try {
    const first = setup({ mode: "immediate" }, wake, {}, { path });
    try {
      first.h.clock.value = 1_000_000;
      const shim = first.h.attach("scribe", { sessionId: SESSION });
      first.host.sing(1, alarm);
      first.h.timers.advance(6_000);
      await confirm(shim);
      first.h.timers.advance(62_000); // it runs out on view; its note goes
      assert.equal(notes(shim).length, 1);
      assert.deepEqual(lines(notes(shim)[0]!.content), [
        "ops:ops.fleet 7/1 expired",
      ]);
    } finally {
      first.h.dispose();
    }
    const second = setup({ mode: "immediate" }, wake, {}, { path });
    try {
      second.h.clock.value = 1_100_000; // well inside the note's hour
      const shim = second.h.attach("scribe", { sessionId: SESSION });
      second.host.sing(2, { ...alarm, flags: { refresh: true } });
      second.h.timers.advance(6_000);
      assert.equal(pushes(shim).length, 1, "the alarm is back: news");
      assert.deepEqual(order(pushes(shim)[0]!.content), ["ops:ops.fleet/2"]);
      assert.equal(status(second.h).counts.refresh_collapsed, undefined);
    } finally {
      second.h.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("#67 (🌿 B1 on #134): a same-body refresh after a plucked record's note is news, while the record's own tombstone still holds", async () => {
  const A = "b".repeat(64);
  const keyed = { stateKey: "silas", text: "silas: deploying", digest: A };
  const { h, host } = setup({ mode: "immediate" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1, { ...keyed, ttlMs: 600_000 });
    h.timers.advance(6_000);
    await confirm(shim);
    host.pluck(1, keyed);
    h.timers.advance(6_000);
    assert.equal(notes(shim).length, 1);
    host.sing(2, { ...keyed, ttlMs: 600_000, flags: { refresh: true } });
    h.timers.advance(6_000);
    assert.equal(
      pushes(shim).length,
      2,
      "told it was withdrawn, then told it's back",
    );
    assert.equal(status(h).counts.refresh_collapsed, undefined);
  } finally {
    h.dispose();
  }
});

test("#67 (🌿 B1 on #134): a refresh that collapsed into the withdrawn record seeds no collapse either, across a restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-withdrawn-"));
  const path = join(directory, "ear.db");
  const keyed = {
    stateKey: "silas",
    text: "silas: deploying",
    digest: "c".repeat(64),
    ttlMs: 600_000,
  };
  try {
    const first = setup({ mode: "immediate" }, {}, {}, { path });
    try {
      first.h.clock.value = 1_000_000;
      const shim = first.h.attach("scribe", { sessionId: SESSION });
      first.host.sing(1, keyed);
      first.h.timers.advance(6_000);
      await confirm(shim);
      first.host.sing(2, { ...keyed, flags: { refresh: true } });
      first.h.timers.advance(6_000);
      assert.equal(status(first.h).counts.refresh_collapsed, 1, "2 is 1 again");
      first.host.pluck(1, keyed);
      first.h.timers.advance(6_000);
      assert.equal(notes(shim).length, 1);
    } finally {
      first.h.dispose();
    }
    const second = setup({ mode: "immediate" }, {}, {}, { path });
    try {
      second.h.clock.value = 1_030_000;
      const shim = second.h.attach("scribe", { sessionId: SESSION });
      second.host.sing(3, { ...keyed, flags: { refresh: true } });
      second.h.timers.advance(6_000);
      assert.equal(pushes(shim).length, 1, "news after the note");
    } finally {
      second.h.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("#67 (🌿 B1 on #134): a pluck and a same-body refresh heard in one pass: the refresh is news", async () => {
  const keyed = {
    stateKey: "silas",
    text: "silas: deploying",
    digest: "d".repeat(64),
    ttlMs: 600_000,
  };
  const { h, host } = setup({ mode: "immediate" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1, keyed);
    h.timers.advance(6_000);
    await confirm(shim);
    host.pluck(1, keyed);
    host.sing(2, { ...keyed, flags: { refresh: true } });
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 2);
    assert.equal(notes(shim).length, 1);
  } finally {
    h.dispose();
  }
});

test("#67 (🌿 S1 on #134): a digest-mode station's notes keep its report window; an immediate one's its debounce", async () => {
  const { h, host } = setup({
    mode: "digest",
    windowMs: 60_000,
    stations: { alpha: "immediate" },
  });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1);
    host.sing(1, { station: "alpha" });
    h.timers.advance(61_000);
    assert.equal(pushes(shim).length, 2, "alpha's push, then ops's report");
    await confirm(shim);
    host.pluck(1);
    host.pluck(1, { station: "alpha" });
    h.timers.advance(6_000);
    assert.equal(notes(shim).length, 1, "alpha's note, on its debounce");
    assert.deepEqual(lines(notes(shim)[0]!.content), [
      "alpha:ops.fleet 7/1 plucked",
    ]);
    h.timers.advance(40_000);
    assert.equal(notes(shim).length, 1, "ops's note waits for its window");
    h.timers.advance(20_000);
    assert.equal(notes(shim).length, 2);
    assert.deepEqual(lines(notes(shim)[1]!.content), [
      "ops:ops.fleet 7/1 plucked",
    ]);
  } finally {
    h.dispose();
  }
});

test("#67: a burst of plucks is coalesced into one note and capped on its own budget; notes and pushes never starve each other", async () => {
  const { h, host } = setup({
    mode: "immediate",
    maxItems: 5,
    maxPushesPerHour: 360,
    maxWithdrawnPerHour: 2,
  });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    for (let seq = 1; seq <= 7; seq += 1) host.sing(seq);
    h.timers.advance(12_000);
    assert.equal(pushes(shim).length, 2, "5 then 2");
    await confirm(shim);

    for (let seq = 1; seq <= 7; seq += 1) host.pluck(seq);
    h.timers.advance(6_000);
    assert.equal(notes(shim).length, 1, "one note for the burst");
    const burst = notes(shim)[0]!;
    assert.equal(burst.meta.count, "7");
    // Named up to the dose (maxItems), the rest counted, every one told.
    assert.deepEqual(lines(burst.content), [
      "ops:ops.fleet 7/1 plucked",
      "ops:ops.fleet 7/2 plucked",
      "ops:ops.fleet 7/3 plucked",
      "ops:ops.fleet 7/4 plucked",
      "ops:ops.fleet 7/5 plucked",
    ]);
    assert.match(burst.content, /^\(and 2 more plucked on 1 stream; /mu);

    host.sing(8);
    host.sing(9);
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 3);
    await confirm(shim);
    host.pluck(8);
    h.timers.advance(6_000);
    assert.equal(notes(shim).length, 2, "the hour's second note");
    host.pluck(9);
    h.timers.advance(6_000);
    assert.equal(notes(shim).length, 2, "the note budget is spent");
    assert.equal(status(h).withdrawn.held, "withdrawn_budget");
    assert.equal(status(h).withdrawn.owed, 1);

    // Spent notes never hold a real push back.
    host.sing(10);
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 4);
    assert.equal(status(h).pushesLastHour, 4);

    // The hour frees: 9's note goes, still owed.
    h.timers.advance(3_600_000);
    assert.equal(notes(shim).length, 3);
    assert.deepEqual(lines(notes(shim)[2]!.content), [
      "ops:ops.fleet 7/9 plucked",
    ]);
  } finally {
    h.dispose();
  }
});

test("#67: a spent push budget never holds a note back", async () => {
  const { h, host } = setup({ mode: "immediate", maxPushesPerHour: 1 });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1);
    h.timers.advance(6_000);
    await confirm(shim);
    host.sing(2);
    h.timers.advance(6_000);
    assert.equal(status(h).held, "push_budget");
    host.pluck(1);
    h.timers.advance(6_000);
    assert.equal(notes(shim).length, 1);
    assert.equal(status(h).held, "push_budget", "still held for records");
    assert.equal(status(h).pushesLastHour, 1, "the note spent no push");
  } finally {
    h.dispose();
  }
});

test("#67: a note is settled with the record's tombstone: a frond-ear restart never repeats a sent note and keeps one still owed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-withdrawn-"));
  const path = join(directory, "ear.db");
  try {
    const first = setup({ mode: "immediate" }, {}, {}, { path });
    try {
      first.h.clock.value = 1_000_000;
      const shim = first.h.attach("scribe", { sessionId: SESSION });
      first.host.sing(1);
      first.host.sing(2);
      first.h.timers.advance(6_000);
      await confirm(shim);
      first.host.pluck(1);
      first.h.timers.advance(6_000);
      assert.equal(notes(shim).length, 1, "1's note went");
      first.host.pluck(2);
      first.h.timers.advance(1_000); // 2's note is owed, inside its debounce
      assert.equal(notes(shim).length, 1);
    } finally {
      first.h.dispose();
    }
    const second = setup({ mode: "immediate" }, {}, {}, { path });
    try {
      second.h.clock.value = 1_020_000;
      const shim = second.h.attach("scribe", { sessionId: SESSION });
      second.h.timers.advance(6_000);
      assert.equal(notes(shim).length, 1, "the owed note, once");
      assert.deepEqual(lines(notes(shim)[0]!.content), [
        "ops:ops.fleet 7/2 plucked",
      ]);
      second.h.timers.advance(60_000);
      assert.equal(notes(shim).length, 1);
    } finally {
      second.h.dispose();
    }
    const third = setup({ mode: "immediate" }, {}, {}, { path });
    try {
      third.h.clock.value = 1_100_000;
      const shim = third.h.attach("scribe", { sessionId: SESSION });
      third.h.timers.advance(60_000);
      assert.equal(notes(shim).length, 0, "nothing told twice");
    } finally {
      third.h.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("#67: a note grants no new record or election authority: no payload, no batch, nothing to ack, no push spent, and it never goes to an ear no session holds", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    let shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1);
    host.sing(2);
    h.timers.advance(6_000);
    await confirm(shim);
    const before = status(h);

    host.pluck(1);
    h.timers.advance(6_000);
    assert.equal(notes(shim).length, 1);
    payloadFree(notes(shim)[0]!);
    const after = status(h);
    assert.equal(after.counts.pushes, before.counts.pushes);
    assert.equal(after.counts.records_pushed, before.counts.records_pushed);
    assert.equal(after.pushesLastHour, before.pushesLastHour);
    assert.equal(after.lastPushAt, before.lastPushAt);
    assert.equal(after.held, null);

    // With no session holding the ear, a withdrawal wakes nothing: it waits.
    shim.close();
    host.pluck(2);
    h.timers.advance(60_000);
    assert.equal(status(h).withdrawn.held, "no_session");
    shim = h.attach("scribe", { sessionId: SESSION });
    h.timers.advance(6_000);
    assert.equal(
      notes(shim).length,
      1,
      "the same session hears it on its return",
    );
    assert.deepEqual(lines(notes(shim)[0]!.content), [
      "ops:ops.fleet 7/2 plucked",
    ]);
  } finally {
    h.dispose();
  }
});

test("#67: a note never goes to a session the record was not pushed to: another session, or a push the host never confirmed", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    const first = h.attach("scribe", { sessionId: SESSION });
    host.sing(1);
    h.timers.advance(6_000);
    await confirm(first);
    first.close();

    const other = h.attach("scribe", { sessionId: OTHER_SESSION });
    // It reads 1 itself: custody shows 1 heard by this session, never pushed to it.
    const heard = await h.call(other, "hear", {});
    assert.match(heard.text, /deploy\.started 1/u);
    host.pluck(1);
    h.timers.advance(60_000);
    assert.equal(notes(other).length, 0, "this session was never shown 1");
    assert.equal(status(h).withdrawn.held, "not_offered");
    other.close();

    const back = h.attach("scribe", { sessionId: SESSION });
    h.timers.advance(6_000);
    assert.equal(notes(back).length, 1, "the session 1 was pushed to");

    // A push the host never confirmed: not offered, so no note; its revert ends it.
    host.sing(2);
    h.timers.advance(6_000);
    assert.equal(pushes(back).length, 1);
    host.pluck(2);
    h.timers.advance(60_000);
    assert.equal(notes(back).length, 1, "2 was never offered");
    back.close(); // the unconfirmed push is reverted
    const again = h.attach("scribe", { sessionId: SESSION });
    h.timers.advance(60_000);
    assert.equal(notes(again).length, 0);
    assert.equal(pushes(again).length, 0, "2 is gone, never pushed again");
  } finally {
    h.dispose();
  }
});

test("#67: with no session id on either side, a note goes only for a push the host confirmed under this attach", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    const shim = h.attach("scribe"); // a shim that gives no session id
    host.sing(1);
    h.timers.advance(6_000);
    await confirm(shim);
    host.sing(2);
    h.timers.advance(6_000); // pushed, never confirmed
    assert.equal(pushes(shim).length, 2);
    host.pluck(1);
    host.pluck(2);
    h.timers.advance(6_000);
    assert.equal(notes(shim).length, 1);
    assert.deepEqual(lines(notes(shim)[0]!.content), [
      "ops:ops.fleet 7/1 plucked",
    ]);
    h.timers.advance(60_000);
    assert.equal(notes(shim).length, 1, "2 was only claimed, never offered");
    assert.equal(status(h).withdrawn.held, "not_offered");
  } finally {
    h.dispose();
  }
});

test("#67: maxWithdrawnPerHour is 1 to 360, 30 by default", () => {
  assert.equal(
    canticleConfig({ mode: "immediate" }).canticle!.delivery.scribe!
      .maxWithdrawnPerHour,
    30,
  );
  assert.throws(
    () => canticleConfig({ mode: "immediate", maxWithdrawnPerHour: 361 }),
    /maxWithdrawnPerHour must be at most 360/u,
  );
  assert.throws(
    () => canticleConfig({ mode: "immediate", maxWithdrawnPerHour: 0 }),
    /maxWithdrawnPerHour/u,
  );
});

// The embedded receptor: a signed PLUCK of a pushed item.
const vectors = JSON.parse(
  readFileSync(
    new URL("./fixtures/canticle/frame-v2-candidates.json", import.meta.url),
    "utf8",
  ),
) as {
  keys: Record<string, { secret: string; key_id: string }>;
  manifest: unknown;
};
const T0 = 1_790_000_000_000;
const test1 = vectors.keys.test1!;
const secret = createPrivateKey({
  key: Buffer.from("302e020100300506032b657004220420" + test1.secret, "hex"),
  format: "der",
  type: "pkcs8",
});

function signed(kind: number, fields: Record<number, cbor.CborValue | number>) {
  const m: cbor.CborMap = new Map();
  for (const [k, v] of Object.entries(fields))
    m.set(BigInt(k), typeof v === "number" ? BigInt(v) : v);
  const unsigned = Buffer.concat([
    Buffer.from([0x42, 0x43, 2, kind]),
    Buffer.from(test1.key_id, "hex"),
    cbor.encode(m),
  ]);
  const signature = sign(null, Buffer.concat([SIGN_DOMAIN, unsigned]), secret);
  return new Uint8Array(Buffer.concat([unsigned, signature]));
}

/** A chatter ITEM from test1, issued at T0, for 60 s; `extra` overrides its fields. */
const item = (
  seq: number,
  extra: Record<number, cbor.CborValue | number> = {},
) =>
  signed(KIND_ITEM, {
    1: 1, // epoch
    2: streamId("chatter"),
    3: seq,
    4: T0,
    5: T0 + 60_000,
    6: 1, // chatter
    7: 1, // lan
    8: new TextEncoder().encode(`deploy.started ${seq}`),
    11: 0, // hop
    13: 1, // text
    ...extra,
  });

/** test1's PLUCK of `target`, carrying the target's expires_at and scope (§9.7). */
const pluck = (seq: number, target: number) =>
  signed(KIND_PLUCK, {
    1: 1,
    2: streamId("chatter"),
    3: seq,
    4: T0 + 1_000,
    5: T0 + 60_000,
    13: 1,
    20: target,
  });

test("#67, embedded receptor: a pushed item its station plucks gets one note", async () => {
  const config = canticleConfig(
    { mode: "immediate" },
    {
      source: "embedded",
      manifestPath: "unused",
      tune: { scribe: ["*:chatter"] },
      wakeKeys: [{ key: test1.key_id, classes: ["chatter"] }],
    },
  );
  let receptor: CanticleReceptor | undefined;
  const h = harness(config, { canticleHear: (ear) => receptor!.hearView(ear) });
  try {
    h.clock.value = T0 + 1_000;
    receptor = new CanticleReceptor({
      config: config.canticle!,
      manifest: Manifest.fromJson(vectors.manifest),
      store: h.store,
      logger: new StructuredLogger(() => {}),
      clock: h.clock,
      timers: h.timers,
      socket: () =>
        ({
          on: () => {},
          bind: (_port: number, _host: string, bound: () => void) => bound(),
          close: () => {},
        }) as never,
    });
    receptor.start();
    const shim = h.attach("scribe", { sessionId: SESSION });
    receptor.receive(item(1));
    receptor.receive(item(2));
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1);
    await confirm(shim);

    receptor.receive(pluck(3, 1));
    h.timers.advance(6_000);
    assert.equal(notes(shim).length, 1);
    payloadFree(notes(shim)[0]!);
    assert.deepEqual(lines(notes(shim)[0]!.content), [
      "test1:chatter 1/1 plucked",
    ]);
    // chatter 2 runs out on its own: no note.
    h.timers.advance(120_000);
    assert.equal(notes(shim).length, 1);
    receptor.stop();
  } finally {
    h.dispose();
  }
});

test("#67, embedded receptor: an alarm that runs out while current gets an expiry note; one superseded first gets none", async () => {
  // test1's manifest entry, granted alarm (as #176's proof 3 does), its key bare: alarm only.
  const manifest = structuredClone(vectors.manifest) as {
    stations: Array<{ name: string; classes: string[] }>;
  };
  manifest.stations.find((s) => s.name === "test1")!.classes.push("alarm");
  const config = canticleConfig(
    { mode: "immediate" },
    {
      source: "embedded",
      manifestPath: "unused",
      tune: { scribe: ["*:chatter"] },
      wakeKeys: [test1.key_id],
    },
  );
  let receptor: CanticleReceptor | undefined;
  const h = harness(config, { canticleHear: (ear) => receptor!.hearView(ear) });
  try {
    h.clock.value = T0 + 1_000;
    receptor = new CanticleReceptor({
      config: config.canticle!,
      manifest: Manifest.fromJson(manifest),
      store: h.store,
      logger: new StructuredLogger(() => {}),
      clock: h.clock,
      timers: h.timers,
      socket: () =>
        ({
          on: () => {},
          bind: (_port: number, _host: string, bound: () => void) => bound(),
          close: () => {},
        }) as never,
    });
    receptor.start();
    const shim = h.attach("scribe", { sessionId: SESSION });
    receptor.receive(item(1, { 6: 7, 10: "fire" }));
    receptor.receive(item(2, { 6: 7, 10: "flood" }));
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1);
    assert.equal(pushes(shim)[0]!.meta.count, "2");
    await confirm(shim);
    // 3 replaces 2 (same state_key): 2 leaves before its expiry.
    receptor.receive(item(3, { 4: T0 + 2_000, 6: 7, 10: "flood" }));
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 2);
    await confirm(shim);

    h.timers.advance(60_000); // past T0 + 60 s, when 1 and 3 run out while current
    assert.equal(notes(shim).length, 1);
    payloadFree(notes(shim)[0]!);
    assert.deepEqual(lines(notes(shim)[0]!.content), [
      "test1:chatter 1/1 expired",
      "test1:chatter 1/3 expired",
    ]);
    h.timers.advance(120_000);
    assert.equal(notes(shim).length, 1, "2 was superseded, never expired");
    receptor.stop();
  } finally {
    h.dispose();
  }
});
