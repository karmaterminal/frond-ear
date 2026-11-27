// Letters carry references to heard canticle records, not their words (Deep Dive No. 2 §06):
// `leave_letter` takes `heard: [{station, stream, epoch, seq}]` and hands it back with the
// letter, and a literal-copy guard refuses a letter whose text copies a canticle record frond-ear
// already released to that same session (pushed to it and confirmed, or returned by its own
// `hear`). Never the held buffer or the live set at large, so a write's outcome can't be used to
// guess text the session hasn't elected to receive. Literal copies only: a paraphrase passes.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { COPY_FLOOR } from "../src/letters.ts";
import { EventStore } from "../src/store.ts";
import { confirm, pushes, SESSION, setup } from "./canticle-host.ts";
import type { Harness } from "./helpers.ts";

const OTHER = "22222222-bbbb-4bbb-8bbb-000000000002";

/** Long enough to cross the floor; no 40-character span of it is common prose. */
const RECORD =
  "rune gateway restarted at 03:06Z after the burst; lane=main dropped 26 room events in 18 minutes";
/** Every line under the floor: only normalization across lines can see the copy. */
const MULTI =
  "silas cap revert waits on #182252\nkey-only, never the whole backup\nthen re-read health on silas";
const SECOND =
  "elliott canary held at 61a52ed8 until the second prince reviews the migration plan tonight";

/** A CLI client's release, as the SessionStart hook sends it. */
async function release(h: Harness, sessionId = SESSION) {
  const cli = h.attach(undefined, { role: "cli" });
  const id = 9_000 + Math.floor(Math.random() * 1_000);
  await cli.send({
    type: "release",
    id,
    ear: "scribe",
    source: "compact",
    sessionId,
  });
  const result = cli.connection.results().find((item) => item.id === id);
  assert.ok(result, "release answered");
  return result;
}

const letterEvents = (shim: ReturnType<Harness["attach"]>) =>
  shim.connection.events().filter((event) => event.meta.kind === "letter");

/** No span of `text` at the floor's length appears in `out`. */
function echoesNone(out: string, text: string): boolean {
  for (let at = 0; at + 20 <= text.length; at += 1) {
    if (out.includes(text.slice(at, at + 20))) return false;
  }
  return true;
}

test("letter heard refs: a reference round-trips through leave, release, read and list, and never carries text", async () => {
  const { h } = setup(undefined);
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const left = await h.call(shim, "leave_letter", {
      reason: "the rune restart is the thread",
      body: "check whether rune's lane drained before you trust the room",
      heard: [
        { station: "ops", stream: "ops.fleet", epoch: 7, seq: 2 },
        {
          station: "alpha",
          stream: "ops.deploy",
          epoch: 3,
          seq: "18446744073709551615",
        },
      ],
    });
    assert.equal(left.ok, true, left.text);
    assert.match(left.text, /2 heard references/u);

    const listed = (await h.call(shim, "letters", {})).text;
    assert.match(
      listed,
      /heard: ops:ops\.fleet 7\/2, alpha:ops\.deploy 3\/18446744073709551615/u,
    );
    const read = (await h.call(shim, "letters", { read: 1 })).text;
    assert.match(read, /heard \(references, not words/u);
    assert.match(
      read,
      /> - ops:ops\.fleet 7\/2\n> - alpha:ops\.deploy 3\/18446744073709551615/u,
    );

    await release(h);
    const [event] = letterEvents(shim);
    assert.ok(event, "the letter came back");
    assert.match(event.content, /> - ops:ops\.fleet 7\/2/u);
    assert.match(
      event.content,
      /> - alpha:ops\.deploy 3\/18446744073709551615/u,
    );

    // A letter without refs shows no heard section.
    await h.call(shim, "leave_letter", { reason: "r", body: "plain" });
    const plain = (await h.call(shim, "letters", { read: 2 })).text;
    assert.doesNotMatch(plain, /heard/u);

    // A reference names a record; it can't carry its words.
    const carrying = await h.call(shim, "leave_letter", {
      reason: "r",
      body: "b",
      heard: [
        { station: "ops", stream: "ops.fleet", epoch: 7, seq: 2, text: RECORD },
      ],
    });
    assert.equal(carrying.ok, false);
    assert.match(carrying.text, /station, stream, epoch and seq only/u);
    assert.ok(echoesNone(carrying.text, RECORD));
  } finally {
    h.dispose();
  }
});

test("letter heard refs: the count is bounded and each field is validated", async () => {
  const { h } = setup(undefined);
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const ref = (seq: number) => ({
      station: "ops",
      stream: "ops.fleet",
      epoch: 7,
      seq,
    });
    const many = await h.call(shim, "leave_letter", {
      reason: "r",
      body: "b",
      heard: Array.from({ length: 17 }, (_, index) => ref(index)),
    });
    assert.equal(many.ok, false);
    assert.match(many.text, /heard has 17 references; the limit is 16/u);
    const full = await h.call(shim, "leave_letter", {
      reason: "r",
      body: "b",
      heard: Array.from({ length: 16 }, (_, index) => ref(index)),
    });
    assert.equal(full.ok, true, full.text);
    // the wire's own bounds (🌫, #142 review): epoch is a u32; a stream name is 64 bytes at most
    const STREAM_64 =
      "abbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.abbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; // 31 + 1 + 30 = 62 bytes: ".c" makes 64 (allowed), ".cd" 65 (refused)
    for (const edge of [
      { station: "ops", stream: "ops.fleet", epoch: 4294967295, seq: 2 },
      { station: "ops", stream: `${STREAM_64}.c`, epoch: 7, seq: 2 },
    ]) {
      const result = await h.call(shim, "leave_letter", {
        reason: "r",
        body: "b",
        heard: [edge],
      });
      assert.equal(
        result.ok,
        true,
        `accepted ${JSON.stringify(edge)}: ${result.text}`,
      );
    }
    for (const bad of [
      [{ station: "ops", stream: "ops.fleet", epoch: 4294967296, seq: 2 }],
      [{ station: "ops", stream: `${STREAM_64}.cd`, epoch: 7, seq: 2 }],
      "ops:ops.fleet 7/2",
      [{ station: "OPS", stream: "ops.fleet", epoch: 7, seq: 2 }],
      [{ station: "ops", stream: "Ops Fleet", epoch: 7, seq: 2 }],
      [{ station: "ops", stream: "ops.fleet", epoch: 1.5, seq: 2 }],
      [{ station: "ops", stream: "ops.fleet", epoch: -1, seq: 2 }],
      [{ station: "ops", stream: "ops.fleet", epoch: 7, seq: "2a" }],
      [{ station: "ops", stream: "ops.fleet", epoch: 7 }],
      [{ station: "ops", stream: "ops.fleet", epoch: 7, seq: 2 ** 53 }],
      [
        {
          station: "ops",
          stream: "ops.fleet",
          epoch: 7,
          seq: "18446744073709551616",
        },
      ],
    ]) {
      const result = await h.call(shim, "leave_letter", {
        reason: "r",
        body: "b",
        heard: bad,
      });
      assert.equal(result.ok, false, `refused ${JSON.stringify(bad)}`);
      assert.match(result.text, /heard/u);
    }
  } finally {
    h.dispose();
  }
});

test("copy guard: a letter copying a record its own hear returned is refused, naming the record and never echoing its text", async () => {
  const { h, host } = setup(undefined);
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(2, { text: RECORD });
    h.timers.advance(1_000);
    const heard = (await h.call(shim, "hear", {})).text;
    assert.match(heard, /lane=main dropped 26/u, "the session was shown it");

    // Copied into prose, re-wrapped across lines, as the hear block showed it.
    const body = `Before compaction: ${RECORD.slice(0, 50)}\n>   ${RECORD.slice(50)}. Check it.`;
    const copied = await h.call(shim, "leave_letter", {
      reason: "thread",
      body,
    });
    assert.equal(copied.ok, false, "refused");
    assert.match(copied.text, /ops:ops\.fleet 7\/2/u, "names the record");
    assert.match(
      copied.text,
      /heard: \[\{station: "ops", stream: "ops\.fleet", epoch: 7, seq: 2\}\]/u,
    );
    assert.match(copied.text, /literal-copy detection, not provenance/u);
    assert.ok(echoesNone(copied.text, RECORD), "never echoes the matched text");

    // A span past the floor, alone, is enough; so is the reason or an assumed item.
    const span = await h.call(shim, "leave_letter", {
      reason: "thread",
      body: `§${RECORD.slice(10, 10 + COPY_FLOOR)}§`,
    });
    assert.equal(span.ok, false);
    assert.match(span.text, /body copies/u);
    const inReason = await h.call(shim, "leave_letter", {
      reason: RECORD.slice(0, 60),
      body: "b",
    });
    assert.equal(inReason.ok, false);
    assert.match(inReason.text, /reason copies/u);
    const inAssumed = await h.call(shim, "leave_letter", {
      reason: "r",
      body: "b",
      assumed: ["fine", RECORD.slice(20, 90)],
    });
    assert.equal(inAssumed.ok, false);
    assert.match(inAssumed.text, /assumed item 2 copies/u);
    assert.ok(echoesNone(inAssumed.text, RECORD));

    // A multi-line record, copied as the banner showed it (quote markers and all) or
    // joined onto one line, is still the record: no line alone reaches the floor.
    host.sing(6, { text: MULTI });
    h.timers.advance(1_000);
    await h.call(shim, "hear", {});
    assert.ok(MULTI.split("\n").every((line) => line.length < COPY_FLOOR));
    const asShown = await h.call(shim, "leave_letter", {
      reason: "r",
      body: `from the radio:\n${MULTI.split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}`,
    });
    assert.equal(asShown.ok, false, "copied with its markers");
    assert.match(asShown.text, /ops:ops\.fleet 7\/6/u);
    const joined = await h.call(shim, "leave_letter", {
      reason: "r",
      body: `note: ${MULTI.split("\n").join(" ")}.`,
    });
    assert.equal(joined.ok, false, "re-wrapped onto one line");
    assert.ok(echoesNone(joined.text, MULTI));

    // One character under the floor is not a copy.
    const under = await h.call(shim, "leave_letter", {
      reason: "thread",
      body: `§${RECORD.slice(10, 10 + COPY_FLOOR - 1)}§`,
    });
    assert.equal(under.ok, true, under.text);

    // The reference instead is accepted.
    const ref = await h.call(shim, "leave_letter", {
      reason: "thread",
      body: "rune restarted after the burst and dropped room events; re-read the record",
      heard: [{ station: "ops", stream: "ops.fleet", epoch: 7, seq: 2 }],
    });
    assert.equal(ref.ok, true, ref.text);
  } finally {
    h.dispose();
  }
});

test("copy guard: a record pushed and confirmed to the session counts; one claimed but never confirmed does not", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1, { text: RECORD });
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1, "pushed");
    // Claimed and handed to the connection, but the host hasn't said it reached the session.
    const unconfirmed = await h.call(shim, "leave_letter", {
      reason: "r",
      body: RECORD,
    });
    assert.equal(unconfirmed.ok, true, unconfirmed.text);
    await confirm(shim);
    const confirmed = await h.call(shim, "leave_letter", {
      reason: "r",
      body: RECORD,
    });
    assert.equal(confirmed.ok, false);
    assert.match(confirmed.text, /ops:ops\.fleet 7\/1/u);
    assert.ok(echoesNone(confirmed.text, RECORD));
  } finally {
    h.dispose();
  }
});

test("copy guard: text the session was never released is not compared, so a write is no oracle", async () => {
  const { h, host } = setup(undefined);
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1, { text: RECORD });
    h.clock.advance(1_000);
    host.sing(2, { text: SECOND }); // fresher: hear lists it first
    h.timers.advance(1_000);
    // Live and held, never heard by this session: no refusal, nothing said of it.
    const held = await h.call(shim, "leave_letter", {
      reason: "r",
      body: RECORD,
    });
    assert.equal(held.ok, true, held.text);
    assert.doesNotMatch(held.text, /canticle|ops:ops/u);

    // Hearing one releases that one only.
    await h.call(shim, "hear", { limit: 1 }); // the fresher, seq 2
    const other = await h.call(shim, "leave_letter", {
      reason: "r",
      body: RECORD,
    });
    assert.equal(other.ok, true, other.text);
    const second = await h.call(shim, "leave_letter", {
      reason: "r",
      body: SECOND,
    });
    assert.equal(second.ok, false);
    assert.match(second.text, /ops:ops\.fleet 7\/2/u);
    assert.doesNotMatch(second.text, /7\/1/u);

    // Released to another session is not released to this one.
    const next = h.attach("scribe", { sessionId: OTHER });
    const foreign = await h.call(next, "leave_letter", {
      reason: "r",
      body: SECOND,
    });
    assert.equal(foreign.ok, true, foreign.text);
  } finally {
    h.dispose();
  }
});

test("copy guard: what a hear cut off was never shown, so it is not compared", async () => {
  const long = Array.from(
    { length: 40 },
    (_, index) =>
      `line ${index} of the long fleet report says rune lane ${index * 7} is fine`,
  ).join("\n");
  const { h, host } = setup(
    undefined,
    {},
    { limits: { maxNotificationChars: 1_500 } },
  );
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(3, { text: long });
    h.timers.advance(1_000);
    const shown = (await h.call(shim, "hear", {})).text;
    assert.match(shown, /payload truncated by frond-ear/u, "shown cut");
    const tail = long.slice(-200);
    assert.ok(!shown.includes(tail.slice(0, 60)), "the tail wasn't shown");
    const result = await h.call(shim, "leave_letter", {
      reason: "r",
      body: tail,
    });
    assert.equal(result.ok, true, result.text);
  } finally {
    h.dispose();
  }
});

test("copy guard: a short common phrase is not a copy, and a paraphrase isn't caught (the stated limit)", async () => {
  const { h, host } = setup(undefined);
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(4, { text: "There is a room." });
    host.sing(5, { text: `There is a room. ${RECORD}` });
    h.timers.advance(1_000);
    await h.call(shim, "hear", {});
    const phrase = await h.call(shim, "leave_letter", {
      reason: "r",
      body: "There is a room. I keep it tidy and I log what I change in it.",
    });
    assert.equal(phrase.ok, true, phrase.text);
    // Literal-copy detection only: the same facts in other words pass.
    const paraphrase = await h.call(shim, "leave_letter", {
      reason: "r",
      body: "After the burst rune's gateway came back around 03:06Z; its main lane lost 26 room events over 18 min.",
    });
    assert.equal(paraphrase.ok, true, paraphrase.text);
  } finally {
    h.dispose();
  }
});

test("letter heard refs: a store from before heard refs opens, and its letters name none", () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-letter-heard-"));
  try {
    const path = join(directory, "ear.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE letters (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ear TEXT NOT NULL, session_id TEXT,
        reason TEXT NOT NULL, body TEXT NOT NULL, bytes INTEGER NOT NULL,
        assumed TEXT NOT NULL DEFAULT '[]', left_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, delivered_at INTEGER,
        deliveries INTEGER NOT NULL DEFAULT 0, nonce TEXT, acked_at INTEGER,
        releases_at_leave INTEGER NOT NULL DEFAULT 0)`);
    old
      .prepare(
        "INSERT INTO letters (ear, session_id, reason, body, bytes, left_at, expires_at) VALUES ('scribe', ?, 'r', 'b', 1, 0, 1)",
      )
      .run(SESSION);
    old.close();
    const store = new EventStore(path);
    try {
      const [letter] = store.letters("scribe");
      assert.ok(letter);
      assert.deepEqual(letter.heard, []);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
