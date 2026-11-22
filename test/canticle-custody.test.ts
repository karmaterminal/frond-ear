// binary-canticle#161 item 4: custody and honest confirmation for what canticle exposes to a
// session. A push is claimed (its dedup tombstone), offered once the host hands it to the
// session, and echoed only when the session names its batch_id; `hear` is an exposure echoed
// at its own return. Every exposure is stamped with the compaction boundary the session's
// pressure hook reported, so custody can say whether what was heard is still in context.
// Records go in through the real record v1 consumer; what comes out is what the attached
// session is sent, and what canticle_custody and ear_status say about it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { DaemonMessage } from "../src/protocol.ts";
import { EventStore } from "../src/store.ts";
import {
  canticleConfig,
  type Host,
  OPS,
  order,
  pushes,
  setup,
  status,
} from "./canticle-host.ts";
import {
  BOT,
  CHANNEL,
  FakeClock,
  GUILD,
  type Harness,
  message,
  type MemoryConnection,
  PRINCIPAL,
} from "./helpers.ts";

const SESSION = "11111111-aaaa-4aaa-8aaa-000000000001";
const OTHER_SESSION = "22222222-bbbb-4bbb-8bbb-000000000002";

type Client = ReturnType<Harness["attach"]>;

interface CustodyRecord {
  station: string;
  stream: string;
  item: string;
  key: string;
  state: string;
  path: string;
  mode: string;
  shown: string;
  digest: string | null;
  exposures: number;
  claimedAt: number;
  offeredAt: number | null;
  echoedAt: number | null;
  echo: string | null;
}

interface Custody {
  ear: string;
  history: "complete" | "incomplete" | "unknown";
  reasons: string[];
  counts: Record<string, number>;
  records: CustodyRecord[];
  publication: string;
}

async function custody(
  h: Harness,
  client: Client,
  args: Record<string, unknown> = {},
): Promise<Custody> {
  const result = await h.call(client, "canticle_custody", args);
  assert.equal(result.ok, true, result.text);
  return JSON.parse(result.text) as Custody;
}

/** ear_status's custody summary for scribe, read synchronously. */
function summary(h: Harness): Record<string, unknown> | undefined {
  const ears = (
    h.daemon.status("scribe") as {
      ears: Array<{ canticleCustody?: Record<string, unknown> }>;
    }
  ).ears;
  return ears[0]?.canticleCustody;
}

/** `key:epoch:stream:seq` of an ops.fleet record the host sang, as custody keys it. */
const identity = (seq: number, stream = "ops.fleet") =>
  `${OPS}:7:${stream}:${seq}`;

let reports = 0;

/**
 * The seat's pressure hook (#98), as a CLI client: the session's context reading with its
 * latest compaction marker (null: none yet). Evidence time is the harness clock.
 */
async function pressure(
  h: Harness,
  boundary: string | null,
  options: { sessionId?: string; tokens?: number | null } = {},
): Promise<void> {
  const cli = h.attach(undefined, { role: "cli" });
  reports += 1;
  await cli.send({
    type: "pressure",
    id: reports,
    ear: "scribe",
    sessionId: options.sessionId ?? SESSION,
    tokens: options.tokens === undefined ? 1_000 : options.tokens,
    band: null,
    boundary,
    at: h.clock.now(),
  });
  const result = cli.connection.results().at(-1)!;
  assert.equal(result.ok, true, result.text);
  cli.close();
}

/** Sings `seq`, lets immediate push it, and has the shim confirm it: the push. */
async function offered(
  h: Harness,
  host: Host,
  shim: Client,
  seq: number,
): Promise<Extract<DaemonMessage, { type: "event" }>> {
  const before = pushes(shim).length;
  host.sing(seq);
  h.timers.advance(6_000);
  assert.equal(pushes(shim).length, before + 1, `record ${seq} was pushed`);
  const push = pushes(shim).at(-1)!;
  await shim.send({ type: "offered", batchId: push.batchId! });
  return push;
}

const recordOf = (view: Custody, seq: number) => {
  const record = view.records.find((item) => item.item === `7/${seq}`);
  assert.ok(record, `custody holds record ${seq}`);
  return record;
};

/** Runs `spy` on each canticle event before the connection takes it. */
function onCanticle(
  connection: MemoryConnection,
  spy: (event: Extract<DaemonMessage, { type: "event" }>) => void,
): void {
  const deliver = connection.send.bind(connection);
  connection.send = (message) => {
    const event = message as DaemonMessage;
    if (event.type === "event" && event.meta.kind === "canticle") spy(event);
    deliver(message);
  };
}

test("ordering: a canticle push is claimed, then offered only when the host hands it over; nothing reads as pushed, offered or heard before", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const atHandover: unknown[] = [];
    onCanticle(shim.connection, () => {
      atHandover.push({
        pushed: status(h).counts.records_pushed ?? 0,
        custody: (summary(h)?.counts as Record<string, number>) ?? null,
      });
    });
    host.sing(1);
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1);
    const push = pushes(shim)[0]!;
    // The push names its batch as a Discord batch does, so the host's return can reach it.
    assert.equal(
      typeof push.batchId,
      "number",
      "the push has a batch identity the host can confirm",
    );
    assert.match(
      push.meta.batch_id ?? "",
      new RegExp(`^${push.batchId}-[0-9a-f]{8}$`, "u"),
      "the session's copy carries the delivery token",
    );
    // At the moment of handover the record is only claimed: deduplicated, not yet pushed,
    // offered or heard.
    assert.deepEqual(atHandover, [
      {
        pushed: 0,
        custody: {
          records: 1,
          echoed: 0,
          echoedBeforeBoundary: 0,
          echoedBoundaryUnknown: 0,
          offered: 0,
          claimed: 1,
        },
      },
    ]);
    let record = (await custody(h, shim)).records[0]!;
    assert.equal(record.state, "claimed");
    assert.equal(record.offeredAt, null);
    // The shim writes the notification to Claude Code, then says so.
    await shim.send({ type: "offered", batchId: push.batchId! });
    record = (await custody(h, shim)).records[0]!;
    assert.equal(record.state, "offered");
    assert.equal(record.offeredAt, h.clock.now());
    assert.equal(record.echoedAt, null, "a push never reads as heard");
    assert.deepEqual(status(h).counts, { pushes: 1, records_pushed: 1 });
  } finally {
    h.dispose();
  }
});

test("ordering: a push no session took claims nothing; its record waits, and the next session gets it once", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    const broken = h.attach("scribe", { sessionId: SESSION });
    const deliver = broken.connection.send.bind(broken.connection);
    broken.connection.send = (message) => {
      const event = message as DaemonMessage;
      if (event.type === "event" && event.meta.kind === "canticle") {
        throw new Error("the socket refused the write");
      }
      deliver(message);
    };
    host.sing(1);
    h.timers.advance(6_000);
    assert.equal(pushes(broken).length, 0);
    assert.equal(
      status(h).counts.records_pushed ?? 0,
      0,
      "nothing counts as pushed",
    );
    assert.equal(status(h).waiting, 1, "the record still waits");
    // A working session takes the ear: the record goes to it, once.
    const shim = h.attach("scribe", { sessionId: SESSION });
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1);
    assert.deepEqual(order(pushes(shim)[0]!.content), ["ops:ops.fleet/1"]);
    h.timers.advance(60_000);
    assert.equal(pushes(shim).length, 1, "once");
    assert.deepEqual(status(h).counts, {
      pushes: 1,
      records_pushed: 1,
      unsent: 1,
    });
    const custodyNow = await custody(h, shim);
    assert.equal(custodyNow.records.length, 1, "one claim, the one that went");
    assert.equal(custodyNow.records[0]!.exposures, 1);
  } finally {
    h.dispose();
  }
});

test("settlement: a canticle batch_id echoes through ack, reply, react, edit_message and fetch_messages; a call naming no id, a Discord id or a push alone echoes nothing", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const tap = h.attach(undefined, { role: "tap", ear: "scribe" });
    await pressure(h, "b-1");
    const a = await offered(h, host, shim, 1);
    // The tap sees the push with the bare id, which tools take but which proves nothing.
    const tapped = tap.connection
      .events()
      .filter((event) => event.meta.kind === "canticle");
    assert.equal(tapped.at(-1)?.meta.batch_id, String(a.batchId));
    assert.equal(tapped.at(-1)?.batchId, a.batchId);

    // A Discord batch in the same ear, offered too.
    h.daemon.ingest(
      message({
        channel_id: CHANNEL,
        guild_id: GUILD,
        author: { id: PRINCIPAL, username: "figs" },
        content: "<@" + BOT + "> ping",
        mentions: [{ id: BOT }],
      }),
    );
    h.timers.advance(2_000);
    const discord = shim.connection
      .events()
      .filter((event) => event.meta.kind === "mention")
      .at(-1)!;
    await shim.send({ type: "offered", batchId: discord.batchId! });

    // Nothing that names no canticle id echoes it.
    await h.call(shim, "ack", {});
    await h.call(shim, "reply", { chat_id: CHANNEL, text: "on it" });
    await h.call(shim, "ack", {
      chat_id: CHANNEL,
      batch_id: discord.meta.batch_id,
    });
    let view = await custody(h, shim);
    assert.equal(
      recordOf(view, 1).state,
      "offered",
      "a push alone is not heard",
    );
    assert.equal(view.history, "incomplete");
    assert.deepEqual(view.reasons, ["1 record offered, never echoed"]);

    // ack with the canticle id alone: heard, and no Discord event marked seen.
    h.daemon.ingest(
      message({
        channel_id: CHANNEL,
        guild_id: GUILD,
        author: { id: PRINCIPAL, username: "figs" },
        content: "<@" + BOT + "> again",
        mentions: [{ id: BOT }],
      }),
    );
    h.timers.advance(2_000);
    const later = shim.connection
      .events()
      .filter((event) => event.meta.kind === "mention")
      .at(-1)!;
    await shim.send({ type: "offered", batchId: later.batchId! });
    const acked = await h.call(shim, "ack", { batch_id: a.meta.batch_id });
    assert.equal(acked.text, "1 canticle record echoed as heard");
    const events = (
      h.daemon.status("scribe") as {
        ears: Array<{ events: Record<string, number> }>;
      }
    ).ears[0]!.events;
    assert.equal(events.offered, 1, "the Discord batch is still unseen");
    view = await custody(h, shim);
    assert.equal(recordOf(view, 1).state, "echoed");
    assert.equal(recordOf(view, 1).echo, "ack");
    assert.equal(recordOf(view, 1).echoedAt, h.clock.now());

    // Each tool that takes a batch_id echoes the canticle push it names.
    const b = await offered(h, host, shim, 2);
    await h.call(shim, "reply", {
      chat_id: CHANNEL,
      text: "heard the deploy",
      batch_id: b.meta.batch_id,
    });
    const c = await offered(h, host, shim, 3);
    await h.call(shim, "react", {
      chat_id: CHANNEL,
      message_id: later.meta.message_id,
      emoji: "👀",
      batch_id: c.meta.batch_id,
    });
    const sent = (
      await h.call(shim, "reply", { chat_id: CHANNEL, text: "progress" })
    ).text.match(/ids? (\d+)/u)![1]!;
    const d = await offered(h, host, shim, 4);
    await h.call(shim, "edit_message", {
      chat_id: CHANNEL,
      message_id: sent,
      text: "progress: deploy heard",
      batch_id: d.meta.batch_id,
    });
    const e = await offered(h, host, shim, 5);
    await h.call(shim, "fetch_messages", {
      chat_id: CHANNEL,
      batch_id: e.meta.batch_id,
    });
    view = await custody(h, shim);
    assert.deepEqual(
      [2, 3, 4, 5].map((seq) => recordOf(view, seq).echo),
      ["reply", "react", "edit_message", "fetch_messages"],
    );
    assert.equal(view.history, "complete");
    assert.deepEqual(view.reasons, []);

    // Naming a later push echoes the earlier ones of the same session, as a later
    // Discord batch settles its chat; the bare id a tap shows works too.
    await offered(h, host, shim, 6);
    const g = await offered(h, host, shim, 7);
    await h.call(shim, "ack", { batch_id: String(g.batchId) });
    view = await custody(h, shim);
    assert.equal(recordOf(view, 6).state, "echoed");
    assert.equal(
      (recordOf(view, 6) as unknown as { echoedThrough?: string })
        .echoedThrough,
      "a later push",
    );
    assert.equal(
      (recordOf(view, 7) as unknown as { echoedThrough?: string })
        .echoedThrough,
      undefined,
    );
    // The token form registered the ear by use, as a Discord batch's does (#21).
    assert.ok(h.store.ear("scribe")?.registered);
  } finally {
    h.dispose();
  }
});

test("sessions: one session's echo never vouches for a push to another; a push the host never confirms stays claimed through a detach, and is not pushed again", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    const first = h.attach("scribe", { sessionId: SESSION });
    await pressure(h, "b-1");
    await offered(h, host, first, 1);
    // Pushed, but the shim drops it before writing it (it held it, then lost the daemon).
    host.sing(2);
    h.timers.advance(6_000);
    const dropped = pushes(first).at(-1)!;
    assert.deepEqual(order(dropped.content), ["ops:ops.fleet/2"]);
    first.close();

    // Another session takes the ear and hears record 3.
    const second = h.attach("scribe", { sessionId: OTHER_SESSION });
    // A late offered from the old shim changes nothing.
    await first.send({ type: "offered", batchId: dropped.batchId! });
    await pressure(h, null, { sessionId: OTHER_SESSION });
    const third = await offered(h, host, second, 3);
    await h.call(second, "ack", { batch_id: third.meta.batch_id });
    h.timers.advance(60_000);
    assert.equal(
      pushes(second).length,
      1,
      "record 2 is not pushed again: a push is never repeated",
    );
    const view = await custody(h, second);
    assert.equal(recordOf(view, 1).state, "offered", "offered to the first");
    assert.equal(recordOf(view, 2).state, "claimed");
    assert.equal(recordOf(view, 2).offeredAt, null);
    assert.equal(recordOf(view, 3).state, "echoed");
    assert.equal(view.history, "incomplete");
    assert.deepEqual(view.reasons, [
      "1 record pushed, never confirmed handed to the session",
      "1 record offered, never echoed",
    ]);
  } finally {
    h.dispose();
  }
});

test("compaction: every step carries the session's boundary; a compaction makes what was heard history, hear brings a record back, and an idle compaction due unseen makes it unknown", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    // No reading from the session's pressure hook yet: frond-ear can't place anything.
    const first = await offered(h, host, shim, 1);
    await h.call(shim, "ack", { batch_id: first.meta.batch_id });
    let view = await custody(h, shim);
    assert.equal(view.history, "unknown");
    assert.equal(recordOf(view, 1).state, "echoed_boundary_unknown");
    assert.match(view.reasons[0]!, /no compaction boundary from this session/u);

    // The hook reads no compaction marker yet: known, and nothing heard is placed after it.
    h.clock.advance(1_000);
    await pressure(h, null);
    const second = await offered(h, host, shim, 2);
    await h.call(shim, "ack", { batch_id: second.meta.batch_id });
    view = await custody(h, shim, { stream: "*:ops.fleet" });
    assert.equal(recordOf(view, 2).state, "echoed");
    assert.equal(
      (recordOf(view, 2) as unknown as { offerBoundary: unknown })
        .offerBoundary,
      null,
    );
    assert.equal(view.history, "unknown", "record 1's boundary is unknown");

    // The session compacts: the PostCompact hook reports the new marker.
    h.clock.advance(1_000);
    await pressure(h, "compact-1", { tokens: null });
    view = await custody(h, shim);
    assert.equal(recordOf(view, 2).state, "echoed_before_boundary");
    assert.equal(view.history, "incomplete");
    assert.ok(
      view.reasons.includes(
        "1 record echoed before the current compaction boundary or by another session",
      ),
    );
    // A record offered before the cut and echoed after it is history too: only its id
    // is known to have outlasted the compaction.
    host.sing(3);
    h.timers.advance(6_000);
    const third = pushes(shim).at(-1)!;
    await shim.send({ type: "offered", batchId: third.batchId! });
    h.clock.advance(1_000);
    await pressure(h, "compact-2", { tokens: null });
    await h.call(shim, "ack", { batch_id: third.meta.batch_id });
    view = await custody(h, shim);
    assert.equal(recordOf(view, 3).state, "echoed_before_boundary");

    // hear shows every live record again, inside the current boundary.
    await h.call(shim, "hear", {});
    view = await custody(h, shim);
    for (const seq of [1, 2, 3]) {
      assert.equal(recordOf(view, seq).state, "echoed", `record ${seq}`);
      assert.equal(recordOf(view, seq).exposures, 2);
    }
    assert.equal(view.history, "complete");

    // A reading big enough for an idle compaction, then 54 minutes with no hook run.
    h.clock.advance(1_000);
    await pressure(h, "compact-2", { tokens: 250_000 });
    h.clock.advance(54 * 60_000);
    view = await custody(h, shim);
    assert.equal(view.history, "unknown");
    assert.match(view.reasons[0]!, /an idle compaction was due at /u);
  } finally {
    h.dispose();
  }
});

test("restart: custody survives a frond-ear restart on the same store; the boundary is unknown until the session's hook reports again", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-custody-"));
  const path = join(directory, "ear.db");
  try {
    const first = setup({ mode: "immediate" }, {}, {}, { path });
    let at: number;
    try {
      const shim = first.h.attach("scribe", { sessionId: SESSION });
      await pressure(first.h, "b-1");
      const push = await offered(first.h, first.host, shim, 1);
      await first.h.call(shim, "ack", { batch_id: push.meta.batch_id });
      await offered(first.h, first.host, shim, 2);
      assert.equal((await custody(first.h, shim)).history, "incomplete");
      at = first.h.clock.now();
    } finally {
      first.h.dispose();
    }
    const second = setup({ mode: "immediate" }, {}, {}, { path });
    try {
      second.h.clock.value = at + 10_000;
      // The same session resumes (a new shim, a new attach generation).
      const shim = second.h.attach("scribe", { sessionId: SESSION });
      let view = await custody(second.h, shim);
      assert.equal(recordOf(view, 1).state, "echoed_boundary_unknown");
      assert.equal(recordOf(view, 2).state, "offered");
      assert.equal(view.history, "unknown", "no reading since the restart");
      second.h.clock.advance(1_000);
      await pressure(second.h, "b-1");
      view = await custody(second.h, shim);
      assert.equal(recordOf(view, 1).state, "echoed");
      assert.equal(recordOf(view, 2).state, "offered");
      assert.equal(view.history, "incomplete");
      assert.equal(recordOf(view, 1).echo, "ack");
      // The record pushed before the restart is not pushed again.
      second.host.sing(1);
      second.host.sing(2);
      second.h.timers.advance(10_000);
      assert.equal(pushes(shim).length, 0);
    } finally {
      second.h.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hear: what hear shows the ear's own session is custody, echoed at its return; another reader's hear and an item it shows without text record nothing", async () => {
  // No delivery entry: this ear only ever hears by asking.
  const { h, host } = setup(undefined);
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await pressure(h, "b-1");
    host.sing(1);
    h.clock.advance(1_000);
    host.sing(2, { text: "deploy.finished" }); // fresher: hear lists it first
    h.timers.advance(1_000);
    await h.call(shim, "hear", { limit: 1 });
    let view = await custody(h, shim);
    assert.deepEqual(
      view.records.map((record) => record.item),
      ["7/2"],
      "only what the result showed",
    );
    const two = recordOf(view, 2);
    assert.deepEqual(
      {
        state: two.state,
        path: two.path,
        mode: two.mode,
        shown: two.shown,
        echo: two.echo,
        digest: two.digest,
      },
      {
        state: "echoed",
        path: "hear",
        mode: "off",
        shown: "whole",
        echo: "hear",
        digest: createHash("sha256").update("deploy.finished").digest("hex"),
      },
    );
    assert.equal(two.offeredAt, two.echoedAt);
    // custody never carries the payload itself.
    const raw = (await h.call(shim, "canticle_custody", {})).text;
    assert.doesNotMatch(raw, /deploy\.finished/u);

    // A reader that isn't the ear's session reads, and custody doesn't change.
    const reader = h.attach(undefined, { role: "cli" });
    await h.call(reader, "hear", { ear: "scribe" });
    view = await custody(h, shim);
    assert.equal(view.records.length, 1);
    assert.equal(recordOf(view, 2).exposures, 1);

    // The ear's session reads again: both text records now, and the repeat is a new
    // exposure. A non-text record is listed without its payload, so it isn't one.
    host.sing(3, { binary: true });
    h.timers.advance(1_000);
    const listing = (await h.call(shim, "hear", {})).text;
    assert.match(listing, /non-text payload, ctype 2, 64 bytes; not shown/u);
    view = await custody(h, shim);
    assert.deepEqual(view.records.map((record) => record.item).sort(), [
      "7/1",
      "7/2",
    ]);
    assert.equal(recordOf(view, 1).exposures, 1);
    assert.equal(recordOf(view, 2).exposures, 2);
    assert.equal(view.history, "complete");
  } finally {
    h.dispose();
  }
});

test("publication seam: closed by default; with derived publication on, open only while every source was heard whole within the current boundary, and never by the sing route", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await pressure(h, "b-1");
    const push = await offered(h, host, shim, 1);
    await h.call(shim, "ack", { batch_id: push.meta.batch_id });
    const one = [identity(1)];
    assert.equal((await custody(h, shim)).history, "complete");
    assert.deepEqual(h.daemon.derivedPublicationGate("scribe", one), {
      open: false,
      reason:
        "closed: derived publication is off (config canticle.derivedPublication)",
    });
    assert.equal(
      (await custody(h, shim)).publication,
      "closed: derived publication is off (config canticle.derivedPublication)",
    );

    h.daemon.reloadConfig(
      canticleConfig({ mode: "immediate" }, { derivedPublication: true }),
    );
    assert.deepEqual(h.daemon.derivedPublicationGate("scribe", one), {
      open: true,
      op: "derived",
      sources: one,
    });
    assert.deepEqual(h.daemon.derivedPublicationGate("scribe", []), {
      open: false,
      reason: "closed: no source records named",
    });
    // A source custody never held.
    assert.deepEqual(
      h.daemon.derivedPublicationGate("scribe", [...one, identity(99)]),
      {
        open: false,
        reason: "closed: history unknown: no custody for 1 source record",
      },
    );
    // Offered, never echoed.
    await offered(h, host, shim, 2);
    assert.deepEqual(
      h.daemon.derivedPublicationGate("scribe", [...one, identity(2)]),
      {
        open: false,
        reason: "closed: history incomplete: 1 record offered, never echoed",
      },
    );
    // A compaction since: what was heard is history.
    h.clock.advance(1_000);
    await pressure(h, "compact-1", { tokens: null });
    assert.deepEqual(h.daemon.derivedPublicationGate("scribe", one), {
      open: false,
      reason:
        "closed: history incomplete: 1 record echoed before the current compaction boundary or by another session",
    });
    // No session holding the ear: unknown.
    shim.close();
    assert.match(
      (h.daemon.derivedPublicationGate("scribe", one) as { reason: string })
        .reason,
      /^closed: history unknown: no session holds the ear/u,
    );
  } finally {
    h.dispose();
  }
});

test("publication seam: a record heard only as counts was never heard whole, so it can't source a derived publication", async () => {
  const { h, host } = setup(
    { mode: "digest", windowMs: 10_000, style: "counts" },
    { derivedPublication: true },
  );
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await pressure(h, "b-1");
    host.sing(1);
    h.timers.advance(11_000);
    const report = pushes(shim).at(-1)!;
    assert.doesNotMatch(report.content, /deploy\.started 1/u);
    await shim.send({ type: "offered", batchId: report.batchId! });
    await h.call(shim, "ack", { batch_id: report.meta.batch_id });
    const view = await custody(h, shim);
    assert.equal(recordOf(view, 1).state, "echoed");
    assert.equal(recordOf(view, 1).shown, "none");
    assert.equal(recordOf(view, 1).path, "report");
    assert.equal(recordOf(view, 1).mode, "digest");
    assert.deepEqual(h.daemon.derivedPublicationGate("scribe", [identity(1)]), {
      open: false,
      reason:
        "closed: 1 source record never heard whole within the current boundary (cut to fit, counts only, or no text)",
    });
  } finally {
    h.dispose();
  }
});

test("status: ear_status carries the custody summary for the last hour, and canticle_custody refuses a malformed stream", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await pressure(h, "b-1");
    await offered(h, host, shim, 1);
    assert.deepEqual(summary(h), {
      windowMs: 3_600_000,
      history: "incomplete",
      reasons: ["1 record offered, never echoed"],
      counts: {
        records: 1,
        echoed: 0,
        echoedBeforeBoundary: 0,
        echoedBoundaryUnknown: 0,
        offered: 1,
        claimed: 0,
      },
    });
    const bad = await h.call(shim, "canticle_custody", { stream: "nope" });
    assert.equal(bad.ok, false);
    assert.match(bad.text, /stream must be station:stream/u);
    const narrowed = await custody(h, shim, { stream: "*:ops.deploy" });
    assert.equal(narrowed.records.length, 0);
  } finally {
    h.dispose();
  }
});

test("store: custody is whole only from when it began and from the prune's cutoff; an older database gains batch-tagged tombstones in place", () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-custody-store-"));
  const path = join(directory, "ear.db");
  try {
    // A database from before custody: canticle_settled without batch_id, one tombstone.
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE canticle_settled (
      ear TEXT NOT NULL, identity TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('pushed', 'collapsed', 'passed')),
      refresh_key TEXT, digest TEXT, settled_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      PRIMARY KEY (ear, identity))`);
    old
      .prepare(
        "INSERT INTO canticle_settled VALUES ('scribe', 'k:7:s:1', 'pushed', NULL, NULL, 1, 9999999999)",
      )
      .run();
    old.close();
    const clock = new FakeClock(5_000_000);
    const store = new EventStore(path, clock);
    try {
      assert.equal(store.canticleSettled(clock.now()).length, 1);
      assert.equal(store.canticleCustodySince(), 5_000_000);
      const exposure = {
        path: "immediate" as const,
        mode: "immediate",
        identity: "k:7:s:2",
        station: "ops",
        stream: "s",
        keyId: "k",
        epoch: 7,
        seq: "2",
        digest: null,
        shown: "whole" as const,
      };
      const batch = store.claimCanticlePush(
        "scribe",
        { generation: 1, sessionId: SESSION },
        [
          {
            identity: "k:7:s:2",
            outcome: "pushed",
            refreshKey: null,
            digest: null,
            expiresAt: 9_999_999_999,
          },
        ],
        { name: "canticle.cursor.scribe", value: "{}" },
        [exposure],
      );
      assert.equal(store.canticleCustody("scribe", 0).length, 1);
      // Released, the claim is gone whole: custody, tombstone, batch, cursor put back.
      store.releaseCanticlePush("scribe", batch, {
        name: "canticle.cursor.scribe",
        value: "before",
      });
      assert.equal(store.canticleCustody("scribe", 0).length, 0);
      assert.deepEqual(
        store.canticleSettled(clock.now()).map((row) => row.identity),
        ["k:7:s:1"],
      );
      assert.equal(store.runtimeState("canticle.cursor.scribe"), "before");
      assert.equal(store.isCanticleBatch("scribe", batch), false);

      store.recordCanticleHear(
        "scribe",
        { generation: 1, sessionId: SESSION },
        [{ ...exposure, path: "hear" }],
        clock.now(),
        "b-1",
      );
      clock.advance(15 * 24 * 60 * 60 * 1_000);
      store.prune(14 * 24 * 60 * 60 * 1_000);
      assert.equal(store.canticleCustody("scribe", 0).length, 0);
      assert.equal(
        store.canticleCustodySince(),
        clock.now() - 14 * 24 * 60 * 60 * 1_000,
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("config: canticle.derivedPublication is off unless set to true", () => {
  assert.equal(
    canticleConfig({ mode: "immediate" }).canticle!.derivedPublication,
    false,
  );
  assert.equal(
    canticleConfig({ mode: "immediate" }, { derivedPublication: true })
      .canticle!.derivedPublication,
    true,
  );
  assert.throws(
    () => canticleConfig({ mode: "immediate" }, { derivedPublication: "yes" }),
    /canticle\.derivedPublication must be true or false/u,
  );
});

test("shown: custody keeps how much of each record a push showed: whole, cut to fit, or none for a non-text body; and a cut record never opens the seam", async () => {
  const { h, host } = setup(
    { mode: "immediate" },
    { derivedPublication: true },
    { limits: { maxNotificationChars: 1_500 } },
  );
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await pressure(h, "b-1");
    host.sing(1, { text: "x".repeat(3_000) });
    host.sing(2, { binary: true });
    host.sing(3);
    for (let i = 0; i < 3; i += 1) {
      h.timers.advance(6_000);
      const push = pushes(shim).at(-1)!;
      await shim.send({ type: "offered", batchId: push.batchId! });
      await h.call(shim, "ack", { batch_id: push.meta.batch_id });
    }
    const view = await custody(h, shim);
    assert.deepEqual(
      [1, 2, 3].map((seq) => [
        recordOf(view, seq).shown,
        recordOf(view, seq).state,
      ]),
      [
        ["cut", "echoed"],
        ["none", "echoed"],
        ["whole", "echoed"],
      ],
    );
    assert.equal(recordOf(view, 2).digest, null, "no text and no body digest");
    assert.equal(
      recordOf(view, 1).digest,
      createHash("sha256").update("x".repeat(3_000)).digest("hex"),
      "the digest is of the whole payload, not the part shown",
    );
    assert.equal(view.history, "complete");
    assert.deepEqual(h.daemon.derivedPublicationGate("scribe", [identity(3)]), {
      open: true,
      op: "derived",
      sources: [identity(3)],
    });
    assert.equal(
      h.daemon.derivedPublicationGate("scribe", [identity(1), identity(3)])
        .open,
      false,
    );
  } finally {
    h.dispose();
  }
});
