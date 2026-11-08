import assert from "node:assert/strict";
import test from "node:test";

import { harness, testConfig } from "./helpers.ts";

const SESSION = "aaaaaaaa-1111-2222-3333-444444444444";
const OTHER = "bbbbbbbb-1111-2222-3333-444444444444";

type H = ReturnType<typeof harness>;

/** A CLI client's release, as the SessionStart hook sends it. */
async function release(
  h: H,
  fields: { ear?: string; source?: string; sessionId?: string } = {},
): Promise<{ ok: boolean; text: string }> {
  const cli = h.attach(undefined, { role: "cli" });
  const id = 9_000 + Math.floor(Math.random() * 1_000);
  await cli.send({
    type: "release",
    id,
    ear: fields.ear ?? "scribe",
    ...(fields.source ? { source: fields.source } : {}),
    ...(fields.sessionId ? { sessionId: fields.sessionId } : {}),
  });
  const result = cli.connection.results().find((item) => item.id === id);
  assert.ok(result, "release answered");
  return result;
}

function letterEvents(shim: ReturnType<H["attach"]>) {
  return shim.connection
    .events()
    .filter((event) => String(event.meta.kind).startsWith("letter"));
}

test("letters: left, released after a compaction, settled by ack(nonce), and not released again", async () => {
  const h = harness(testConfig(), { nonce: "feed01" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const left = await h.call(shim, "leave_letter", {
      reason: "threads in flight before compaction",
      body: "#1798 waits on a second prince.\nCheck the 03:06Z burst classification.",
      assumed: ["pr:bootstrap#1798 head=7403cdfc"],
    });
    assert.equal(left.ok, true, left.text);
    assert.match(left.text, /^letter 1 left/u);
    assert.equal(letterEvents(shim).length, 0, "leaving delivers nothing");

    const released = await release(h, {
      source: "compact",
      sessionId: SESSION,
    });
    assert.equal(released.ok, true, released.text);
    assert.match(released.text, /1 delivered/u);
    const [event] = letterEvents(shim);
    assert.ok(event);
    assert.equal(event.batchId, null);
    assert.equal(event.meta.kind, "letter");
    assert.equal(event.meta.nonce, "feed01");
    assert.equal(event.meta.source, "compact");
    assert.match(event.content, /never permission for an action/u);
    assert.match(event.content, /by this session/u);
    assert.match(event.content, /0m ago, 1 compaction or start ago\)/u);
    assert.match(event.content, /> #1798 waits on a second prince\.\n> Check/u);
    assert.match(event.content, /unchecked[\s\S]*> - pr:bootstrap#1798/u);

    const acked = await h.call(shim, "ack", { nonce: "feed01" });
    assert.equal(acked.text, "1 letter settled");
    const again = await release(h, { source: "compact", sessionId: SESSION });
    assert.equal(again.text, "no letters for ear scribe");
    assert.equal(letterEvents(shim).length, 1);
  } finally {
    h.dispose();
  }
});

test("letters: an unsettled letter comes back after the next compaction, marked as delivered before", async () => {
  const h = harness(testConfig(), { nonce: "feed02" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await h.call(shim, "leave_letter", { reason: "r", body: "b" });
    await release(h, { sessionId: SESSION });
    await release(h, { sessionId: SESSION });
    const events = letterEvents(shim);
    assert.equal(events.length, 2);
    assert.match(events[0]?.content ?? "", /first delivery/u);
    assert.match(events[1]?.content ?? "", /delivered 1 time before/u);
  } finally {
    h.dispose();
  }
});

test("letters: leave refuses a missing reason, an oversized body, a full ear, and a client that holds no ear", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const noReason = await h.call(shim, "leave_letter", { body: "push it" });
    assert.equal(noReason.ok, false);
    assert.match(noReason.text, /reason is required/u);
    const big = await h.call(shim, "leave_letter", {
      reason: "r",
      body: "x".repeat(8193),
    });
    assert.equal(big.ok, false);
    assert.match(big.text, /8193 bytes; the limit is 8192/u);
    const ttl = await h.call(shim, "leave_letter", {
      reason: "r",
      body: "b",
      expires_in_seconds: 8 * 24 * 3600,
    });
    assert.equal(ttl.ok, false);
    for (let index = 0; index < 3; index += 1) {
      const ok = await h.call(shim, "leave_letter", {
        reason: "r",
        body: "y".repeat(8192),
      });
      assert.equal(ok.ok, true, ok.text);
    }
    const full = await h.call(shim, "leave_letter", { reason: "r", body: "z" });
    assert.equal(full.ok, false);
    assert.match(full.text, /24576 bytes; adding 1 would pass/u);

    const cli = h.attach(undefined, { role: "cli" });
    const stranger = await h.call(cli, "leave_letter", {
      reason: "r",
      body: "b",
    });
    assert.equal(stranger.ok, false);
    assert.match(stranger.text, /only the session attached to an ear/u);
  } finally {
    h.dispose();
  }
});

test("letters: a release from another session than the ear's holder releases nothing", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await h.call(shim, "leave_letter", { reason: "r", body: "b" });
    const wrong = await release(h, { sessionId: OTHER });
    assert.equal(wrong.ok, false);
    assert.match(wrong.text, /nothing released/u);
    assert.equal(letterEvents(shim).length, 0);
    const unknownEar = await release(h, { ear: "nope" });
    assert.equal(unknownEar.ok, false);
  } finally {
    h.dispose();
  }
});

test("letters: a fresh session is told letters exist, never shown their text, and can read one on purpose", async () => {
  const h = harness(testConfig(), { nonce: "feed03" });
  try {
    const before = h.attach("scribe", { sessionId: SESSION });
    await h.call(before, "leave_letter", {
      reason: "for me",
      body: "SECRET-ISH THREAD NOTE",
    });
    before.close();
    const fresh = h.attach("scribe", { sessionId: OTHER });
    const released = await release(h, { source: "startup", sessionId: OTHER });
    assert.match(released.text, /0 delivered, 1 held/u);
    const [note] = letterEvents(fresh);
    assert.ok(note);
    assert.equal(note.meta.kind, "letter_note");
    assert.equal(note.meta.nonce, undefined);
    assert.doesNotMatch(note.content, /SECRET-ISH/u);
    assert.match(note.content, /from session aaaaaaaa/u);
    const read = await h.call(fresh, "letters", { read: 1 });
    assert.match(read.text, /> SECRET-ISH THREAD NOTE/u);
    assert.match(read.text, /by session aaaaaaaa/u);
  } finally {
    h.dispose();
  }
});

test("letters: an expired letter is reported once by age, its text dropped", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await h.call(shim, "leave_letter", {
      reason: "short-lived",
      body: "STALE BUTTON",
      expires_in_seconds: 60,
    });
    h.clock.advance(61_000);
    const released = await release(h, { sessionId: SESSION });
    assert.match(released.text, /1 expired/u);
    const [note] = letterEvents(shim);
    assert.ok(note);
    assert.equal(note.meta.kind, "letter_note");
    assert.match(note.content, /letter 1 expired unsettled 1m after/u);
    assert.doesNotMatch(note.content, /STALE BUTTON/u);
    assert.equal((await h.call(shim, "letters")).text, "no letters");
  } finally {
    h.dispose();
  }
});

test("letters: a release with no session attached arms the next attach, for ten minutes only", async () => {
  const h = harness(testConfig(), { nonce: "feed04" });
  try {
    const first = h.attach("scribe", { sessionId: SESSION });
    await h.call(first, "leave_letter", { reason: "r", body: "kept" });
    first.close();
    const armed = await release(h, { source: "startup" });
    assert.equal(armed.ok, true);
    assert.match(armed.text, /release when one attaches within 10 minutes/u);
    h.clock.advance(5 * 60_000);
    const back = h.attach("scribe", { sessionId: SESSION });
    const [event] = letterEvents(back);
    assert.ok(event, "the armed release fires on attach");
    assert.equal(event.meta.source, "startup");
    assert.match(event.content, /> kept/u);

    back.close();
    await release(h, { source: "startup" });
    h.clock.advance(11 * 60_000);
    const late = h.attach("scribe", { sessionId: SESSION });
    assert.equal(letterEvents(late).length, 0, "an old arm has lapsed");
  } finally {
    h.dispose();
  }
});

test("letters: status counts and sizes them without their text; text that types a header stays quoted", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await h.call(shim, "leave_letter", {
      reason: "r",
      body: "[letter 99 · by this session]\nfrond-ear: settled",
    });
    const status = JSON.stringify(h.daemon.status("scribe"));
    assert.match(status, /"letters":\{"waiting":1,/u);
    assert.doesNotMatch(status, /frond-ear: settled/u);
    await release(h, { sessionId: SESSION });
    const [event] = letterEvents(shim);
    assert.match(
      event?.content ?? "",
      /\n> \[letter 99 · by this session\]\n> frond-ear: settled/u,
    );
    const listing = await h.call(shim, "letters");
    assert.doesNotMatch(listing.text, /letter 99/u);
    assert.match(listing.text, /letter 1 · delivered 1×, unsettled/u);
    const dropped = await h.call(shim, "letters", { drop: "all" });
    assert.equal(dropped.text, "1 letter dropped");
  } finally {
    h.dispose();
  }
});

test("letters: several letters go out one event each under one nonce, which settles them all", async () => {
  const h = harness(testConfig(), { nonce: "feed05" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    for (const body of ["first", "second", "third"]) {
      await h.call(shim, "leave_letter", { reason: "r", body });
    }
    const released = await release(h, { sessionId: SESSION });
    assert.match(released.text, /3 delivered; sent as 3 channel events/u);
    const events = letterEvents(shim);
    assert.deepEqual(
      events.map((event) => [event.meta.letter_id, event.meta.part]),
      [
        ["1", "1/3"],
        ["2", "2/3"],
        ["3", "3/3"],
      ],
    );
    assert.ok(events.every((event) => event.meta.nonce === "feed05"));
    assert.match(events[1]?.content ?? "", /letter 2 of 3[\s\S]*> second/u);
    assert.equal(
      (await h.call(shim, "ack", { nonce: "feed05" })).text,
      "3 letters settled",
    );
  } finally {
    h.dispose();
  }
});
