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

import {
  COPY_FLOOR,
  COPY_MIN_SPACES,
  COPY_UNCHECKED,
  copiedRecords,
  refuseCopies,
  type ReleasedRecord,
} from "../src/letters.ts";
import { EventStore } from "../src/store.ts";
import {
  canticleConfig,
  confirm,
  Host,
  pushes,
  SESSION,
  setup,
} from "./canticle-host.ts";
import { harness, type Harness } from "./helpers.ts";

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

/** A record that cites identifiers the way beacons do, then says something in words. */
const CITES =
  "deployed 759883e483cd100de07402321db99dcf6d1c0585 per https://github.com/karmaterminal/openclaw/pull/1501 and rune lane drained cleanly after the restart";

test("copy guard: an identifier the record shares (a full SHA, a URL prefix) is not a copy; a sentence still is", async () => {
  const { h, host } = setup(undefined);
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(2, { text: CITES });
    h.timers.advance(1_000);
    assert.match((await h.call(shim, "hear", {})).text, /759883e4/u);
    // The same 40-hex SHA, cited from the session's own git log.
    const sha = await h.call(shim, "leave_letter", {
      reason: "the head to check",
      body: "my git log says 759883e483cd100de07402321db99dcf6d1c0585 is the head; re-read CI there",
    });
    assert.equal(sha.ok, true, sha.text);
    assert.doesNotMatch(sha.text, /copy check/u, "checked, so nothing extra");
    // Another PR under the same 48-character repository prefix.
    const url = await h.call(shim, "leave_letter", {
      reason: "the follow-up",
      body: "the follow-up is https://github.com/karmaterminal/openclaw/pull/1777, not merged yet",
      assumed: ["https://github.com/karmaterminal/openclaw/pull/1501"],
    });
    assert.equal(url.ok, true, url.text);
    // A sentence from the same record is still the record.
    const said = await h.call(shim, "leave_letter", {
      reason: "r",
      body: "the radio: rune lane drained cleanly after the restart, so trust it",
    });
    assert.equal(said.ok, false, "a copied sentence is refused");
    assert.match(said.text, /ops:ops\.fleet 7\/2/u);
    assert.ok(echoesNone(said.text, CITES));
  } finally {
    h.dispose();
  }
});

/** A released record carrying `text`, for the guard's own unit tests. */
const released = (text: string, seq = "1"): ReleasedRecord => ({
  station: "ops",
  stream: "ops.fleet",
  epoch: 7,
  seq,
  text,
});
const letterOf = (body: string) => ({ body, reason: "r", assumed: [] });

test("copy guard: a shared run counts only with natural-language shape, at least COPY_MIN_SPACES spaces", () => {
  assert.equal(COPY_MIN_SPACES, 4);
  // Exactly the floor long, both sides; nothing longer is shared.
  const four = "aaaaaaaa bbbbbbb ccccccc ddddddd eeeeeee";
  const three = "aaaaaaaaa bbbbbbbbb ccccccccc dddddddddd";
  const none = "0123456789abcdef0123456789abcdef01234567";
  for (const run of [four, three, none]) {
    assert.equal(run.length, COPY_FLOOR);
  }
  assert.equal(four.split(" ").length - 1, COPY_MIN_SPACES);
  assert.equal(three.split(" ").length - 1, COPY_MIN_SPACES - 1);
  const hit = (run: string) =>
    copiedRecords(letterOf(`Q${run}Z`), [released(`X${run}Y`)]).length;
  assert.equal(hit(four), 1, "four spaces: a copy");
  assert.equal(hit(three), 0, "three spaces: not yet a copy");
  assert.equal(hit(none), 0, "no whitespace: an identifier, never a copy");
  // A run one character under the floor is no copy, however many spaces it has.
  const short = "a b c d e f g h i j k l m n o p q r s t";
  assert.equal(short.length, COPY_FLOOR - 1);
  assert.equal(hit(short), 0);
  // Whitespace is counted after it collapses to one space: a run of blanks is one.
  assert.equal(hit("aaaaaaaaa  bbbbbbbbb\n\nccccccccc \t dddddddddd"), 0);
});

/** Deterministic word salad: no 40-character run of it recurs by chance. */
function salad(seed: number, length: number): string {
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const letters = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  while (out.length < length) {
    const size = 2 + (next() % 7);
    for (let i = 0; i < size; i += 1) out += letters[next() % letters.length];
    out += " ";
  }
  return out.slice(0, length);
}

test("copy guard: memory is bounded by the letter, not the released text (3,500 records of 5,800 characters)", () => {
  // The old index held every 40-character window of every record: past ~2,900 records of
  // this size it threw RangeError (Map maximum size exceeded), and the letter failed closed.
  const records = Array.from({ length: 3_500 }, (_, index) =>
    released(salad(index + 1, 5_800), String(index)),
  );
  const sentence = "rune lane drained cleanly after the restart at 03:06Z";
  records[3_499] = released(
    `${salad(9_999, 2_000)} ${sentence} ${salad(7_777, 2_000)}`,
    "3499",
  );
  const body = `${salad(123_456, 7_000)} the radio said ${sentence}.`;
  const started = performance.now();
  const found = copiedRecords(
    { body, reason: "r", assumed: ["a", "b"] },
    records,
  );
  const ms = performance.now() - started;
  assert.deepEqual(
    found.map(({ field, records: hits }) => [
      field,
      hits.map((record) => record.seq),
    ]),
    [["body", ["3499"]]],
  );
  assert.ok(ms < 10_000, `took ${Math.round(ms)} ms`);
});

test("copy guard: an internal failure fails open and says so; a refusal still refuses", () => {
  const broken = {
    station: "ops",
    stream: "ops.fleet",
    epoch: 7,
    seq: "1",
    get text(): string {
      throw new RangeError("boom");
    },
  } as ReleasedRecord;
  const errors: unknown[] = [];
  assert.equal(
    refuseCopies(letterOf(RECORD), [broken], (error) => errors.push(error)),
    COPY_UNCHECKED.failed,
  );
  assert.equal(errors.length, 1);
  assert.equal(
    refuseCopies(letterOf("plain words"), [released(RECORD)]),
    undefined,
  );
  assert.throws(
    () => refuseCopies(letterOf(RECORD), [released(RECORD)]),
    /letter not stored/u,
  );
});

/**
 * Canticle on, with a live view the test can break: `unreadable` makes it throw, `poisoned`
 * hands out items whose text throws when read (a fault inside the guard, past the view).
 */
function breakable() {
  const faults = { unreadable: false, poisoned: false };
  let host: Host | undefined;
  const h = harness(canticleConfig(undefined), {
    canticleHear: () => {
      if (faults.unreadable) throw new Error("host daemon gone");
      const view = host!.view();
      if (!faults.poisoned) return view;
      return {
        ...view,
        items: view.items.map((item) =>
          Object.defineProperty({ ...item }, "text", {
            get() {
              throw new TypeError("poisoned text");
            },
          }),
        ),
      };
    },
    canticleGuide: () => host!.guideView(),
  });
  host = new Host(h.clock);
  host.start();
  return { h, host, faults };
}

/** The daemon-written header line of a rendered letter (the line after `[letter`). */
const headerOf = (text: string) =>
  text.split("\n").find((line) => line.startsWith("[letter ")) ?? "";

test("copy guard: a letter left while the guard couldn't run says so when left, read and released; its body is unchanged", async () => {
  const { h, host, faults } = breakable();
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(2, { text: RECORD });
    h.timers.advance(1_000);
    await h.call(shim, "hear", {});
    const body = `rune's lane: ${RECORD}`;

    // The live set can't be read: the letter is stored (fail open), and told so.
    faults.unreadable = true;
    const unreadable = await h.call(shim, "leave_letter", {
      reason: "r",
      body,
    });
    assert.equal(unreadable.ok, true, unreadable.text);
    assert.match(
      unreadable.text,
      /copy check: not run \(live set unreadable\)/u,
    );
    faults.unreadable = false;

    // The guard itself fails past the view: open too, with its own reason.
    faults.poisoned = true;
    const failed = await h.call(shim, "leave_letter", { reason: "r", body });
    assert.equal(failed.ok, true, failed.text);
    assert.match(failed.text, /copy check: not run \(the check failed\)/u);
    faults.poisoned = false;

    // With the guard back, the same text is refused, and a clean letter shows nothing extra.
    const copied = await h.call(shim, "leave_letter", { reason: "r", body });
    assert.equal(copied.ok, false);
    const clean = await h.call(shim, "leave_letter", {
      reason: "r",
      body: "my own words",
    });
    assert.equal(clean.ok, true, clean.text);
    assert.doesNotMatch(clean.text, /copy check/u);

    // `letters read` shows it in the header, beside left and expires.
    const read1 = (await h.call(shim, "letters", { read: 1 })).text;
    assert.match(
      headerOf(read1),
      / · expires \S+ · copy check: not run \(live set unreadable\) · /u,
    );
    const read2 = (await h.call(shim, "letters", { read: 2 })).text;
    assert.match(headerOf(read2), /copy check: not run \(the check failed\)/u);
    const read3 = (await h.call(shim, "letters", { read: 3 })).text;
    assert.doesNotMatch(read3, /copy check/u);

    // Released after the compaction: the header carries it, the body is as written.
    await release(h);
    const events = letterEvents(shim);
    assert.equal(events.length, 3);
    const [first, second, third] = events;
    assert.match(
      headerOf(first!.content),
      /copy check: not run \(live set unreadable\)/u,
    );
    assert.match(
      headerOf(second!.content),
      /copy check: not run \(the check failed\)/u,
    );
    assert.doesNotMatch(third!.content, /copy check/u);
    for (const event of [first!, second!]) {
      const quoted = event.content.split("\nletter:\n")[1]!;
      assert.equal(quoted, `> ${body}`, "the body is exactly as left");
      assert.doesNotMatch(quoted, /copy check/u);
    }
  } finally {
    h.dispose();
  }
});

test("copy guard: records shown before frond-ear knew the session's id aren't compared, and the letter says so", async () => {
  const { h, host } = setup(undefined);
  try {
    const shim = h.attach("scribe", {});
    host.sing(2, { text: RECORD });
    h.timers.advance(1_000);
    assert.match((await h.call(shim, "hear", {})).text, /lane=main/u);
    // No id: nothing can be stored at all, so nothing is unchecked yet.
    const anonymous = await h.call(shim, "leave_letter", {
      reason: "r",
      body: "b",
    });
    assert.equal(anonymous.ok, false);
    assert.match(anonymous.text, /nothing was stored/u);
    // The session is named later; what this shim was shown before can't be tied to it.
    await shim.send({ type: "session", sessionId: SESSION });
    const left = await h.call(shim, "leave_letter", {
      reason: "r",
      body: `copied: ${RECORD}`,
    });
    assert.equal(left.ok, true, left.text);
    assert.match(
      left.text,
      /copy check: partial \(records shown before frond-ear knew this session's id were not compared\)/u,
    );
    const read = (await h.call(shim, "letters", { read: 1 })).text;
    assert.match(headerOf(read), /copy check: partial/u);
    // Heard again now, under the id: compared, refused, and nothing partial about it.
    await h.call(shim, "hear", {});
    const again = await h.call(shim, "leave_letter", {
      reason: "r",
      body: `copied: ${RECORD}`,
    });
    assert.equal(again.ok, false);
  } finally {
    h.dispose();
  }
});

test("letter copy check: a store from before copy checks opens, and its letters say the check is unknown", () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-letter-copy-"));
  try {
    const path = join(directory, "ear.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE letters (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ear TEXT NOT NULL, session_id TEXT,
        reason TEXT NOT NULL, body TEXT NOT NULL, bytes INTEGER NOT NULL,
        assumed TEXT NOT NULL DEFAULT '[]', heard TEXT NOT NULL DEFAULT '[]',
        left_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, delivered_at INTEGER,
        deliveries INTEGER NOT NULL DEFAULT 0, nonce TEXT, acked_at INTEGER,
        releases_at_leave INTEGER NOT NULL DEFAULT 0)`);
    old
      .prepare(
        "INSERT INTO letters (ear, session_id, reason, body, bytes, left_at, expires_at) VALUES ('scribe', ?, 'r', 'b', 1, 0, 1)",
      )
      .run(SESSION);
    old.close();
    for (let open = 0; open < 2; open += 1) {
      const store = new EventStore(path);
      try {
        const [letter] = store.letters("scribe");
        assert.equal(letter?.copyUnchecked, COPY_UNCHECKED.legacy);
        // A letter left by this build after the migration records its own check.
        if (open === 0) {
          store.leaveLetter({
            ear: "scribe",
            sessionId: SESSION,
            reason: "r",
            body: "b",
            bytes: 1,
            assumed: [],
            heard: [],
            leftAt: 0,
            expiresAt: 1,
            releasesAtLeave: 0,
            copyUnchecked: null,
          });
        }
        assert.equal(store.letters("scribe")[1]?.copyUnchecked, null);
      } finally {
        store.close();
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
