/**
 * Daemon-held schedules (#111): a wake that comes due is a durable occurrence owed to the
 * session that set it until that session acks the exact delivery, whatever happens to the
 * daemon, the shim or the session in between (🌫's amendments 1–3).
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ancestorPids } from "../src/shim.ts";
import { harness, testConfig } from "./helpers.ts";

const A = "aaaaaaaa-1111-2222-3333-444444444444";
const B = "bbbbbbbb-1111-2222-3333-444444444444";
const HOST_PID = 4242;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type H = ReturnType<typeof harness>;
type Shim = ReturnType<H["attach"]>;

function wakes(shim: Shim) {
  return shim.connection.events().filter((event) => event.meta.kind === "wake");
}

function lastWake(shim: Shim) {
  const all = wakes(shim);
  const event = all[all.length - 1];
  assert.ok(event, "a wake event was pushed");
  return event;
}

function earStatus(h: H): Record<string, unknown> & {
  schedules: Record<string, unknown>;
} {
  const status = h.daemon.status("scribe") as {
    ears: Array<
      Record<string, unknown> & { schedules: Record<string, unknown> }
    >;
  };
  const ear = status.ears[0];
  assert.ok(ear);
  return ear;
}

/** A CLI client's SessionStart release, as `frond-ear release --hook` sends it. */
async function release(
  h: H,
  fields: { sessionId: string; source: string; hostPid?: number },
): Promise<{ ok: boolean; text: string }> {
  const cli = h.attach(undefined, { role: "cli" });
  const id = 9_000 + Math.floor(Math.random() * 1_000);
  await cli.send({ type: "release", id, ear: "scribe", ...fields });
  const result = cli.connection.results().find((item) => item.id === id);
  assert.ok(result, "release answered");
  return result;
}

async function every(
  h: H,
  shim: Shim,
  args: Record<string, unknown> = {},
): Promise<number> {
  const set = await h.call(shim, "schedule", {
    every: "1h",
    note: "seat-health sweep: check every prince's gateway",
    ...args,
  });
  assert.equal(set.ok, true, set.text);
  const id = /^schedule (\d+) set/u.exec(set.text)?.[1];
  assert.ok(id, set.text);
  return Number(id);
}

test("schedule: an every schedule fires on its fixed cadence, owed to its setter until that delivery's nonce is acked", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe", { sessionId: A, hostPids: [HOST_PID] });
    const start = h.clock.now();
    const id = await every(h, shim);
    assert.equal(wakes(shim).length, 0, "nothing is due yet");
    assert.equal(earStatus(h).schedules.active, 1);
    assert.equal(earStatus(h).schedules.nextDueAt, start + HOUR);

    h.timers.advance(HOUR);
    const first = lastWake(shim);
    assert.equal(first.batchId, null);
    assert.equal(first.meta.schedule_id, String(id));
    assert.equal(first.meta.ticks, "1");
    assert.equal(first.meta.missed, "0");
    assert.equal(first.meta.first_due, new Date(start + HOUR).toISOString());
    assert.match(first.content, /never a command/u);
    assert.match(
      first.content,
      /> seat-health sweep: check every prince's gateway/u,
    );
    const nonce = first.meta.nonce;
    assert.ok(nonce);
    assert.equal(earStatus(h).schedules.owed, 1);

    // Pushing it is not acking it: the wake stays owed.
    h.timers.advance(10 * 60_000);
    assert.equal(earStatus(h).schedules.owed, 1);
    const acked = await h.call(shim, "ack", { nonce });
    assert.equal(acked.ok, true, acked.text);
    assert.match(acked.text, /^1 wake settled/u);
    assert.equal(earStatus(h).schedules.owed, 0);
    assert.equal(earStatus(h).schedules.lastAckedAt, h.clock.now());

    // Fixed cadence from the original due time, not from delivery or ack.
    h.timers.advance(50 * 60_000);
    const second = lastWake(shim);
    assert.notEqual(second.meta.wake_ids, first.meta.wake_ids);
    assert.equal(
      second.meta.first_due,
      new Date(start + 2 * HOUR).toISOString(),
    );
    assert.equal(wakes(shim).length, 2);
  } finally {
    h.dispose();
  }
});

test("schedule: refuses what it can't hold, rather than trimming it", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe", { sessionId: A });
    const refused = async (args: Record<string, unknown>, pattern: RegExp) => {
      const result = await h.call(shim, "schedule", args);
      assert.equal(result.ok, false, JSON.stringify(args));
      assert.match(result.text, pattern);
    };
    await refused({ every: "1h" }, /note is required/u);
    await refused({ note: "x" }, /at or every/u);
    await refused({ every: 299, note: "x" }, /at least 300 seconds/u);
    await refused({ every: "4m", note: "x" }, /at least 300 seconds/u);
    await refused({ every: "1h", note: "x", ttl_days: 31 }, /ttl_days/u);
    await refused(
      { every: "1h", note: "x".repeat(2001) },
      /note is 2001 bytes/u,
    );
    await refused(
      { at: new Date(h.clock.now() - 10 * 60_000).toISOString(), note: "x" },
      /in the past/u,
    );
    await refused(
      {
        at: new Date(h.clock.now() + 3 * DAY).toISOString(),
        note: "x",
        ttl_days: 2,
      },
      /after the schedule expires/u,
    );
    await refused({ at: "tomorrow", note: "x" }, /at must be/u);

    // A session whose id frond-ear doesn't know can't own anything.
    const anonymous = h.attach("scribe");
    const nobody = await h.call(anonymous, "schedule", {
      every: "1h",
      note: "x",
    });
    assert.equal(nobody.ok, false);
    assert.match(nobody.text, /does not know this session's id/u);

    // Caps: 16 per setting session, 32 per ear.
    const a = h.attach("scribe", { sessionId: A });
    for (let index = 0; index < 16; index += 1) {
      await every(h, a);
    }
    const seventeenth = await h.call(a, "schedule", { every: "1h", note: "x" });
    assert.equal(seventeenth.ok, false);
    assert.match(seventeenth.text, /16 active schedules/u);
    const b = h.attach("scribe", { sessionId: B });
    for (let index = 0; index < 16; index += 1) {
      await every(h, b);
    }
    const c = h.attach("scribe", { sessionId: "cccccccc-0000" });
    const full = await h.call(c, "schedule", { every: "1h", note: "x" });
    assert.equal(full.ok, false);
    assert.match(full.text, /32 active schedules/u);
    const caps = earStatus(h).schedules.caps as Record<string, number>;
    assert.deepEqual(caps, {
      maxPerEar: 32,
      maxPerSession: 16,
      minPeriodSeconds: 300,
      maxTtlDays: 30,
      orphanAfterDays: 7,
      maxNoteBytes: 2000,
    });
  } finally {
    h.dispose();
  }
});

test("schedule: a crash inside the trigger→pending transaction loses nothing, and the restart writes the occurrence once", async () => {
  const h1 = harness();
  const path = join(h1.directory, "ear.db");
  try {
    const shim = h1.attach("scribe", { sessionId: A });
    const id = await every(h1, shim);
    shim.close();
    // The occurrence is written, then the schedule advanced: abort the advance, as a
    // crash between the two would leave it, and nothing of the step may survive.
    const side = new DatabaseSync(path);
    side.exec(`CREATE TRIGGER crash BEFORE UPDATE OF next_due ON schedules
               BEGIN SELECT RAISE(ABORT, 'crash'); END;`);
    h1.timers.advance(HOUR);
    const occurrences = () =>
      (side.prepare("SELECT COUNT(*) AS n FROM wakes").get() as { n: number })
        .n;
    assert.equal(occurrences(), 0, "the aborted step left no occurrence");
    side.exec("DROP TRIGGER crash");
    side.close();
    h1.store.close();

    // The restarted daemon finds the due time persisted and fires it, once.
    const h2 = harness(testConfig(), { path });
    try {
      h2.clock.value = h1.clock.now();
      h2.timers.advance(1);
      const again = h2.attach("scribe", { sessionId: A });
      const event = lastWake(again);
      assert.equal(event.meta.schedule_id, String(id));
      assert.equal(event.meta.ticks, "1");
      assert.equal(wakes(again).length, 1);
    } finally {
      h2.dispose();
    }
  } finally {
    try {
      h1.store.close();
    } catch {
      // already closed
    }
    rmSync(h1.directory, { recursive: true, force: true });
  }
});

test("schedule: a crash after the occurrence is written replays the same wake, never a second one", async () => {
  const h1 = harness();
  const path = join(h1.directory, "ear.db");
  const shim = h1.attach("scribe", { sessionId: A });
  await every(h1, shim);
  shim.close();
  h1.timers.advance(HOUR);
  const status = earStatus(h1).schedules;
  assert.equal(status.owed, 1, "written while no session was attached");
  const at = h1.clock.now();
  h1.store.close();

  const h2 = harness(testConfig(), { path });
  try {
    h2.clock.value = at + 60_000;
    h2.timers.advance(1);
    assert.equal(
      earStatus(h2).schedules.owed,
      1,
      "the restart wrote no second occurrence",
    );
    const again = h2.attach("scribe", { sessionId: A });
    const event = lastWake(again);
    assert.equal(event.meta.ticks, "1");
    assert.equal(event.meta.wake_ids, "1");
    assert.equal(wakes(again).length, 1);
  } finally {
    h2.dispose();
    rmSync(h1.directory, { recursive: true, force: true });
  }
});

test("schedule: a duplicate delivery settles once; a stale nonce settles nothing later; another session's ack is refused", async () => {
  const h = harness();
  try {
    let shim = h.attach("scribe", { sessionId: A });
    await every(h, shim);
    h.timers.advance(HOUR);
    const first = lastWake(shim);

    // The same session reconnects: the same occurrence comes back under a new nonce.
    shim = h.attach("scribe", { sessionId: A });
    const replay = lastWake(shim);
    assert.equal(replay.meta.wake_ids, first.meta.wake_ids);
    assert.notEqual(replay.meta.nonce, first.meta.nonce);
    assert.match(replay.content, /delivered 1 time before/u);

    // Another session can't settle it, even holding the nonce.
    const other = h.attach("scribe", { sessionId: B });
    const foreign = await h.call(other, "ack", { nonce: first.meta.nonce });
    assert.equal(foreign.ok, false);
    assert.match(
      foreign.text,
      /delivered to session aaaaaaaa, not this one; nothing settled/u,
    );
    shim = h.attach("scribe", { sessionId: A });
    assert.equal(earStatus(h).schedules.owed, 1);

    const settled = await h.call(shim, "ack", { nonce: first.meta.nonce });
    assert.match(settled.text, /^1 wake settled/u);
    const twice = await h.call(shim, "ack", { nonce: replay.meta.nonce });
    assert.equal(twice.ok, true);
    assert.match(twice.text, /^0 wakes settled: already settled/u);

    // A stale nonce never settles a later occurrence.
    h.timers.advance(HOUR);
    const later = lastWake(shim);
    assert.notEqual(later.meta.wake_ids, first.meta.wake_ids);
    const stale = await h.call(shim, "ack", { nonce: first.meta.nonce });
    assert.match(stale.text, /^0 wakes settled/u);
    assert.equal(earStatus(h).schedules.owed, 1);
  } finally {
    h.dispose();
  }
});

test("schedule: overdue ticks behind an unacked earlier generation come as one event; an ack settles only what it was delivered with", async () => {
  const h = harness();
  try {
    let shim = h.attach("scribe", { sessionId: A });
    const start = h.clock.now();
    const id = await every(h, shim);
    h.timers.advance(HOUR);
    const gen1 = lastWake(shim);
    shim.close();

    // Five more ticks while the seat is down.
    h.timers.advance(5 * HOUR);
    assert.equal(
      earStatus(h).schedules.owed,
      2,
      "gen 1 (delivered) and gen 2 (five ticks)",
    );
    shim = h.attach("scribe", { sessionId: A });
    const forSchedule = wakes(shim).filter(
      (event) => event.meta.schedule_id === String(id),
    );
    assert.equal(forSchedule.length, 1, "one event per schedule on reconnect");
    const both = forSchedule[0]!;
    assert.equal(both.meta.wake_ids, "1,2");
    assert.equal(both.meta.ticks, "6");
    assert.equal(both.meta.missed, "5");
    assert.equal(both.meta.first_due, new Date(start + HOUR).toISOString());
    assert.equal(
      both.meta.latest_due,
      new Date(start + 6 * HOUR).toISOString(),
    );
    assert.match(both.content, /late/u);

    // The first delivery's nonce names gen 1 only.
    const old = await h.call(shim, "ack", { nonce: gen1.meta.nonce });
    assert.match(old.text, /^1 wake settled/u);
    assert.equal(earStatus(h).schedules.owed, 1);
    const rest = await h.call(shim, "ack", { nonce: both.meta.nonce });
    assert.match(rest.text, /^1 wake settled/u);
    assert.equal(earStatus(h).schedules.owed, 0);
  } finally {
    h.dispose();
  }
});

test("schedule: A→B→A: another session is told what is held, never shown it, and can't cancel or settle it; A gets it back", async () => {
  const h = harness();
  try {
    const a = h.attach("scribe", { sessionId: A });
    const id = await every(h, a, { note: "private: rotate the canary key" });
    h.timers.advance(HOUR);
    const owed = lastWake(a);

    const b = h.attach("scribe", { sessionId: B });
    assert.equal(wakes(b).length, 0, "nothing of A's is pushed to B");
    const note = b.connection
      .events()
      .find((event) => event.meta.kind === "wake_note");
    assert.ok(note, "B is told wakes are held");
    assert.doesNotMatch(note.content, /rotate/u);
    assert.match(note.content, /session aaaaaaaa/u);

    const listed = await h.call(b, "schedules");
    assert.equal(listed.ok, true, listed.text);
    assert.match(listed.text, new RegExp(`schedule ${id}`, "u"));
    assert.doesNotMatch(listed.text, /rotate/u);
    const read = await h.call(b, "schedules", { read: id });
    assert.doesNotMatch(read.text, /rotate/u);
    const cancel = await h.call(b, "schedules", { cancel: id });
    assert.equal(cancel.ok, false);
    assert.match(cancel.text, /only the session that set schedule/u);
    const ack = await h.call(b, "ack", { nonce: owed.meta.nonce });
    assert.equal(ack.ok, false);

    // B's own schedule is B's; A can't see its note either.
    await every(h, b, { note: "B's own thing" });

    const back = h.attach("scribe", { sessionId: A });
    const returned = lastWake(back);
    assert.equal(returned.meta.wake_ids, owed.meta.wake_ids);
    assert.match(returned.content, /rotate the canary key/u);
    const mine = await h.call(back, "schedules");
    assert.doesNotMatch(mine.text, /B's own thing/u);
    const settled = await h.call(back, "ack", { nonce: returned.meta.nonce });
    assert.match(settled.text, /^1 wake settled/u);
  } finally {
    h.dispose();
  }
});

test("schedule: a real /clear keeps the shim and its stale session id; the SessionStart hook from the same Claude process moves the holder, never the wakes", async () => {
  const h = harness();
  try {
    // Claude Code keeps MCP servers across /clear: the shim still says A.
    const shim = h.attach("scribe", { sessionId: A, hostPids: [77, HOST_PID] });
    const id = await every(h, shim, { note: "A's sweep" });
    h.timers.advance(HOUR);
    const owed = lastWake(shim);

    const cleared = await release(h, {
      sessionId: B,
      source: "clear",
      hostPid: HOST_PID,
    });
    assert.equal(cleared.ok, true, cleared.text);
    assert.equal(
      earStatus(h).sessionId,
      B,
      "the holder is the cleared session now",
    );
    const note = shim.connection
      .events()
      .filter((event) => event.meta.kind === "wake_note");
    assert.equal(note.length, 1, "B is told A's wakes are held");
    assert.doesNotMatch(note[0]!.content, /A's sweep/u);

    // Through the very same shim, B is not A.
    const ack = await h.call(shim, "ack", { nonce: owed.meta.nonce });
    assert.equal(ack.ok, false);
    const cancel = await h.call(shim, "schedules", { cancel: id });
    assert.equal(cancel.ok, false);
    const listed = await h.call(shim, "schedules");
    assert.doesNotMatch(listed.text, /A's sweep/u);
    h.timers.advance(HOUR);
    assert.equal(
      wakes(shim).length,
      1,
      "A's next tick is written, not pushed to B",
    );
    assert.equal(earStatus(h).schedules.owed, 2);

    // /resume A inside the same TUI: the hook names A again, and A's wakes come back.
    const resumed = await release(h, {
      sessionId: A,
      source: "resume",
      hostPid: HOST_PID,
    });
    assert.equal(resumed.ok, true, resumed.text);
    const back = lastWake(shim);
    assert.equal(back.meta.wake_ids, "1,2");
    assert.match(back.content, /A's sweep/u);

    // A hook from another Claude process moves nothing.
    const stray = await release(h, {
      sessionId: B,
      source: "clear",
      hostPid: 9999,
    });
    assert.equal(stray.ok, false);
    assert.equal(earStatus(h).sessionId, A);
  } finally {
    h.dispose();
  }
});

test("schedule: a /clear frond-ear can't tie to the holding shim puts its wake identity in doubt, failing closed", async () => {
  const h = harness();
  try {
    // An older shim, or one behind a wrapper: no host pid to match.
    const shim = h.attach("scribe", { sessionId: A });
    const id = await every(h, shim, { note: "A's sweep" });
    h.timers.advance(HOUR);
    const owed = lastWake(shim);

    const cleared = await release(h, {
      sessionId: B,
      source: "clear",
      hostPid: HOST_PID,
    });
    assert.equal(cleared.ok, false);
    assert.match(cleared.text, /in doubt/u);
    assert.equal(earStatus(h).schedules.holderIdentity, "in-doubt");
    for (const [tool, args] of [
      ["ack", { nonce: owed.meta.nonce }],
      ["schedules", { cancel: id }],
      ["schedule", { every: "1h", note: "x" }],
    ] as const) {
      const result = await h.call(shim, tool, args);
      assert.equal(result.ok, false, `${tool} fails closed`);
    }
    const listed = await h.call(shim, "schedules");
    assert.doesNotMatch(listed.text, /A's sweep/u);
    h.timers.advance(HOUR);
    assert.equal(wakes(shim).length, 1, "nothing pushed while in doubt");

    // The holder's own session speaking again (its next compaction) clears the doubt.
    const own = await release(h, { sessionId: A, source: "compact" });
    assert.equal(own.ok, true, own.text);
    assert.equal(earStatus(h).schedules.holderIdentity, "known");
    assert.equal(lastWake(shim).meta.wake_ids, "1,2");
  } finally {
    h.dispose();
  }
});

test("schedule: cancel stops future ticks and keeps the wake already owed; expiry writes one ended notice and keeps owed wakes too", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe", { sessionId: A });
    const cancelled = await every(h, shim, { note: "cancel me" });
    const expiring = await every(h, shim, { note: "expire me", ttl_days: 1 });
    h.timers.advance(HOUR);
    shim.close();
    // Both are owed (gen 1 each, delivered once and unacked).
    assert.equal(earStatus(h).schedules.owed, 2);

    const again = h.attach("scribe", { sessionId: A });
    const cancel = await h.call(again, "schedules", { cancel: cancelled });
    assert.equal(cancel.ok, true, cancel.text);
    assert.match(cancel.text, /1 wake it already owes stays owed/u);
    again.close();

    // A day on: the cancelled one never ticks again; the other expired with a notice.
    h.timers.advance(DAY);
    const back = h.attach("scribe", { sessionId: A });
    const events = wakes(back);
    const forCancelled = events.filter(
      (event) => event.meta.schedule_id === String(cancelled),
    );
    const forExpired = events.filter(
      (event) => event.meta.schedule_id === String(expiring),
    );
    assert.equal(forCancelled.length, 1);
    assert.equal(forCancelled[0]!.meta.ticks, "1", "no tick after the cancel");
    assert.equal(forCancelled[0]!.meta.ended, "cancelled");
    assert.equal(forExpired.length, 1);
    assert.equal(forExpired[0]!.meta.ended, "expired");
    assert.match(forExpired[0]!.content, /expired/u);
    assert.match(forExpired[0]!.content, /will not fire again/u);
    // Ticks before the expiry are all owed; none after it.
    assert.equal(forExpired[0]!.meta.ticks, "23");
    assert.equal(earStatus(h).schedules.active, 0);

    // A second look at the ended schedule writes no second notice.
    h.timers.advance(DAY);
    const ackAll = await h.call(back, "ack", {
      nonce: forExpired[0]!.meta.nonce,
    });
    assert.match(ackAll.text, /settled/u);
    const later = h.attach("scribe", { sessionId: A });
    assert.equal(
      wakes(later).filter(
        (event) => event.meta.schedule_id === String(expiring),
      ).length,
      0,
    );
  } finally {
    h.dispose();
  }
});

test("schedule: a lost setter's schedules retire as orphaned after 7 days without the ear, counted where seat-pulse looks", async () => {
  const h = harness();
  try {
    const a = h.attach("scribe", { sessionId: A });
    for (let index = 0; index < 3; index += 1) {
      await every(h, a, { note: `lost ${index}`, every: "1d" });
    }
    const b = h.attach("scribe", { sessionId: B });
    assert.equal(
      earStatus(h).schedules.orphaned,
      3,
      "active, setter not the holder",
    );
    h.timers.advance(7 * DAY + HOUR);
    const status = earStatus(h).schedules;
    assert.equal(status.active, 0, "A never came back: retired");
    assert.equal(status.retiredOrphaned, 3);
    assert.equal(status.owed, 3, "what A was already owed stays owed");
    // B was never shown any of it.
    assert.equal(wakes(b).length, 0);
  } finally {
    h.dispose();
  }
});

test("schedule: the wall clock jumping back fires nothing twice; jumping forward coalesces", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe", { sessionId: A });
    const start = h.clock.now();
    await every(h, shim);
    h.timers.advance(HOUR);
    assert.equal(wakes(shim).length, 1);
    await h.call(shim, "ack", { nonce: lastWake(shim).meta.nonce });

    h.clock.value -= 2 * HOUR;
    h.timers.advance(HOUR);
    assert.equal(wakes(shim).length, 1, "the past due time is not due again");
    h.timers.advance(2 * HOUR);
    assert.equal(wakes(shim).length, 2);
    assert.equal(
      lastWake(shim).meta.first_due,
      new Date(start + 2 * HOUR).toISOString(),
    );
    await h.call(shim, "ack", { nonce: lastWake(shim).meta.nonce });

    h.clock.value += 10 * HOUR;
    h.timers.advance(1);
    const jumped = lastWake(shim);
    assert.equal(wakes(shim).length, 3);
    assert.equal(jumped.meta.ticks, "10");
  } finally {
    h.dispose();
  }
});

test("schedule: at fires once and retires; ear_status shows counts and times, never a note", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe", { sessionId: A });
    const at = h.clock.now() + 2 * HOUR;
    const set = await h.call(shim, "schedule", {
      at: new Date(at).toISOString(),
      note: "check the 03:06Z burst",
    });
    assert.equal(set.ok, true, set.text);
    const view = earStatus(h).schedules;
    assert.equal(view.nextDueAt, at);
    assert.deepEqual(view.byKind, { at: 1, every: 0, github: 0 });
    assert.doesNotMatch(JSON.stringify(h.daemon.status()), /03:06Z burst/u);

    h.timers.advance(2 * HOUR);
    const event = lastWake(shim);
    assert.equal(event.meta.ended, "done");
    assert.equal(earStatus(h).schedules.active, 0);
    assert.equal(earStatus(h).schedules.lastDeliveredAt, h.clock.now());
    h.timers.advance(5 * HOUR);
    // A one-shot fires once: what comes after is that occurrence pushed again, 1 h after
    // the first push and 2 h after that, until it is acked: never a drumbeat.
    assert.equal(earStatus(h).schedules.owed, 1);
    assert.deepEqual(
      wakes(shim).map((item) => item.meta.wake_ids),
      [event.meta.wake_ids, event.meta.wake_ids, event.meta.wake_ids],
    );
    await h.call(shim, "ack", { nonce: lastWake(shim).meta.nonce });
    h.timers.advance(5 * HOUR);
    assert.equal(wakes(shim).length, 3, "settled: never again");
    const read = await h.call(shim, "schedules", { read: 1 });
    assert.match(read.text, /check the 03:06Z burst/u);
  } finally {
    h.dispose();
  }
});

test("schedule: the shim names its ancestors, so a hook's CLAUDE_PID finds it through a wrapper", () => {
  // claude (100) → sh -c (200) → node shim; comm may hold spaces and parentheses.
  const stats: Record<string, string> = {
    "/proc/200/stat": "200 (sh) S 100 200 200 0",
    "/proc/100/stat": "100 (claude (x) 2) S 1 100 100 0",
  };
  const read = (path: string): string => {
    const stat = stats[path];
    if (stat === undefined) {
      throw new Error("ENOENT");
    }
    return stat;
  };
  assert.deepEqual(ancestorPids(read, 200), [200, 100]);
  assert.deepEqual(ancestorPids(read, 200, 1), [200]);
  // No /proc: the parent alone.
  assert.deepEqual(
    ancestorPids(() => {
      throw new Error("ENOENT");
    }, 300),
    [300],
  );
});

test("schedule: a suspended ear is not a stopped daemon: paused, wakes are written and held; removed, its schedules wait untouched and catch up coalesced", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe", { sessionId: A });
    const start = h.clock.now();
    await every(h, shim);
    h.daemon.reloadConfig(testConfig({ paused: true }));
    h.timers.advance(2 * HOUR);
    assert.equal(wakes(shim).length, 0, "paused: nothing pushed");
    assert.equal(
      earStatus(h).schedules.owed,
      1,
      "but the occurrence is written",
    );
    h.daemon.reloadConfig(testConfig());
    const resumed = lastWake(shim);
    assert.equal(resumed.meta.ticks, "2");

    await h.call(shim, "ack", { nonce: resumed.meta.nonce });
    // The ear leaves the config: its schedule keeps its due time and writes nothing.
    h.daemon.reloadConfig(
      testConfig({
        ears: {
          other: {
            target: "claude-channel",
            dms: false,
            attachCanary: false,
            channels: {},
          },
        },
      }),
    );
    h.timers.advance(5 * HOUR);
    h.daemon.reloadConfig(testConfig());
    const back = h.attach("scribe", { sessionId: A });
    const caught = lastWake(back);
    assert.equal(
      caught.meta.ticks,
      "5",
      "the five due times while it was gone, as one event",
    );
    assert.equal(
      caught.meta.first_due,
      new Date(start + 3 * HOUR).toISOString(),
    );
  } finally {
    h.dispose();
  }
});

/** A pressure hook's report (PostToolUse), as `frond-ear pressure --hook --ear` sends it. */
async function pressure(
  h: H,
  fields: { sessionId: string; hostPid?: number },
): Promise<{ ok: boolean; text: string }> {
  const cli = h.attach(undefined, { role: "cli" });
  const id = 19_000 + Math.floor(Math.random() * 1_000);
  await cli.send({
    type: "pressure",
    id,
    ear: "scribe",
    tokens: 1_000,
    band: null,
    boundary: null,
    at: h.clock.now(),
    event: "PostToolUse",
    ...fields,
  });
  const result = cli.connection.results().find((item) => item.id === id);
  assert.ok(result, "pressure answered");
  return result;
}

test("schedule: a /clear's new session survives the shim reconnecting and the daemon restarting; the old one's wakes stay hidden", async () => {
  const h1 = harness();
  const path = join(h1.directory, "ear.db");
  try {
    const shim = h1.attach("scribe", { sessionId: A, hostPids: [HOST_PID] });
    await every(h1, shim, { note: "A's private sweep" });
    h1.timers.advance(HOUR);
    const owed = lastWake(shim);
    const cleared = await release(h1, {
      sessionId: B,
      source: "clear",
      hostPid: HOST_PID,
    });
    assert.equal(cleared.ok, true, cleared.text);

    // The socket drops; the same shim says hello again with its spawn-time id, A.
    const again = h1.attach("scribe", { sessionId: A, hostPids: [HOST_PID] });
    assert.equal(earStatus(h1).sessionId, B, "still the cleared session");
    assert.equal(wakes(again).length, 0, "A's wake is not pushed to B");
    const ack = await h1.call(again, "ack", { nonce: owed.meta.nonce });
    assert.equal(ack.ok, false);
    await every(h1, again, { note: "B's own" });
    const listed = await h1.call(again, "schedules");
    assert.doesNotMatch(listed.text, /A's private sweep/u);
    assert.match(listed.text, /set by this session · note: B's own/u);
    again.close();
    h1.store.close();

    // The daemon restarts; the shim (same Claude process) says A again.
    const h2 = harness(testConfig(), { path });
    try {
      h2.clock.value = h1.clock.now();
      const after = h2.attach("scribe", { sessionId: A, hostPids: [HOST_PID] });
      assert.equal(earStatus(h2).sessionId, B);
      assert.ok(
        !wakes(after).some((event) => /A's private sweep/u.test(event.content)),
      );
      // A genuinely new Claude process for A (another host pid) is A again.
      const fresh = h2.attach("scribe", { sessionId: A, hostPids: [5151] });
      assert.equal(earStatus(h2).sessionId, A);
      assert.ok(
        wakes(fresh).some((event) => /A's private sweep/u.test(event.content)),
      );
    } finally {
      h2.dispose();
    }
  } finally {
    try {
      h1.store.close();
    } catch {
      // already closed
    }
    rmSync(h1.directory, { recursive: true, force: true });
  }
});

test("schedule: a doubt survives the shim reconnecting; a session change seen only by the pressure hook (a /resume the matcher missed) fails closed or turns", async () => {
  const h = harness();
  try {
    const old = h.attach("scribe", { sessionId: A });
    await every(h, old, { note: "A's sweep" });
    h.timers.advance(HOUR);
    await release(h, { sessionId: B, source: "clear", hostPid: HOST_PID });
    assert.equal(earStatus(h).schedules.holderIdentity, "in-doubt");
    const again = h.attach("scribe", { sessionId: A });
    assert.equal(
      earStatus(h).schedules.holderIdentity,
      "in-doubt",
      "a reconnect is no proof",
    );
    assert.equal(wakes(again).length, 0);
    const own = await release(h, { sessionId: A, source: "compact" });
    assert.equal(own.ok, true, own.text);
    assert.equal(earStatus(h).schedules.holderIdentity, "known");

    // A /resume with no resume hook: the pressure hook names the other session.
    const tied = h.attach("scribe", { sessionId: A, hostPids: [HOST_PID] });
    const untied = await pressure(h, { sessionId: B });
    assert.equal(untied.ok, false);
    assert.equal(earStatus(h).schedules.holderIdentity, "in-doubt");
    const ack = await h.call(tied, "schedules", { cancel: 1 });
    assert.equal(ack.ok, false, "nothing through a shim in doubt");
    const before = wakes(tied).length;
    const proven = await pressure(h, { sessionId: B, hostPid: HOST_PID });
    assert.equal(proven.ok, true, proven.text);
    assert.equal(earStatus(h).sessionId, B);
    assert.equal(earStatus(h).schedules.holderIdentity, "known");
    assert.ok(
      !wakes(tied)
        .slice(before)
        .some((event) => /A's sweep/u.test(event.content)),
      "nothing of A's after the turn to B",
    );
  } finally {
    h.dispose();
  }
});

test("schedule: the orphan clock counts from when the setter last held the ear, not from when it set the schedule", async () => {
  for (const leave of ["clear", "detach"] as const) {
    const h = harness();
    try {
      const shim = h.attach("scribe", { sessionId: A, hostPids: [HOST_PID] });
      const set = await h.call(shim, "schedule", {
        at: new Date(h.clock.now() + 20 * DAY).toISOString(),
        note: "far off",
      });
      assert.equal(set.ok, true, set.text);
      // A holds the ear, quietly, for almost seven days: no tick runs meanwhile.
      h.timers.advance(7 * DAY - HOUR);
      if (leave === "clear") {
        await release(h, { sessionId: B, source: "clear", hostPid: HOST_PID });
      } else {
        shim.close();
      }
      h.timers.advance(2 * HOUR);
      const status = earStatus(h).schedules;
      assert.equal(status.active, 1, `${leave}: A held it until 2 h ago`);
      assert.equal(status.retiredOrphaned, 0, leave);
      // Seven days after A left, it is orphaned.
      h.timers.advance(7 * DAY);
      assert.equal(earStatus(h).schedules.retiredOrphaned, 1, leave);
    } finally {
      h.dispose();
    }
  }
});
