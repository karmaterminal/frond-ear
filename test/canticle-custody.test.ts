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
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  type DaemonMessage,
  EAR_PROTOCOL_VERSION,
  LineConnection,
} from "../src/protocol.ts";
import { listenUnix } from "../src/server.ts";
import { ChannelShim } from "../src/shim.ts";
import { EventStore } from "../src/store.ts";
import {
  canticleConfig,
  confirm,
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
    return deliver(message);
  };
}

/** Polls `probe` on real time until it gives a value: for what crosses a real socket. */
async function until<T>(
  probe: () => T | undefined,
  what: string,
  ms = 5_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const attached = (h: Harness) =>
  (h.daemon.status("scribe") as { ears: Array<{ attached: boolean }> }).ears[0]!
    .attached;

/**
 * The harness daemon served on a real unix socket, as `frond-ear daemon` serves it
 * (listenUnix → LineConnection → Daemon.connect); `sockets` keeps the daemon's side of
 * each connection, so a test can kill one under the daemon.
 */
async function served(
  h: Harness,
): Promise<{ path: string; server: Server; sockets: Socket[] }> {
  const path = join(h.directory, "d.sock");
  const server = await listenUnix(h.daemon, path);
  const sockets: Socket[] = [];
  server.on("connection", (socket: Socket) => sockets.push(socket));
  return { path, server, sockets };
}

/** A shim's end of a real connection: its hello as scribe's shim, answered. */
async function rawShim(
  path: string,
): Promise<{ socket: Socket; received: DaemonMessage[] }> {
  const socket = connect(path);
  const received: DaemonMessage[] = [];
  const connection = new LineConnection(
    socket,
    (message) => received.push(message as DaemonMessage),
    () => undefined,
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  connection.send({
    type: "hello",
    role: "shim",
    protocol: EAR_PROTOCOL_VERSION,
    ear: "scribe",
    sessionId: SESSION,
  });
  await until(
    () => received.find((message) => message.type === "welcome"),
    "the welcome",
  );
  return { socket, received };
}

/**
 * The real channel shim over a real socket, with PassThroughs for Claude Code's stdio.
 * `raw` is what the daemon wrote to its socket; `notifications` what it wrote to Claude
 * Code; `listen` plays Claude Code's initialize and initialized.
 */
function channelShim(path: string): {
  shim: ChannelShim;
  raw: () => string;
  notifications: () => Array<{ content: string; meta: Record<string, string> }>;
  listen: () => Promise<void>;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: Array<Record<string, unknown>> = [];
  let buffer = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      written.push(
        JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>,
      );
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  });
  let raw = "";
  const shim = new ChannelShim({
    input,
    output,
    connect: () => {
      const socket = connect(path);
      socket.on("data", (chunk) => (raw += String(chunk)));
      return socket;
    },
    ear: "scribe",
    sessionId: SESSION,
    log: () => undefined,
    reconnectMs: 60_000,
    channelSettleMs: 20,
  });
  shim.start();
  return {
    shim,
    raw: () => raw,
    notifications: () =>
      written
        .filter((line) => line.method === "notifications/claude/channel")
        .map(
          (line) =>
            line.params as { content: string; meta: Record<string, string> },
        ),
    listen: async () => {
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } })}\n`,
      );
      await until(
        () => written.find((line) => line.id === 1),
        "the initialize response",
      );
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 60)); // past its settle
    },
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
      return deliver(message);
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

test("settlement: a canticle batch_id echoes through ack, reply, react, edit_message and fetch_messages; a call naming no id, a Discord id, the bare id, another push's id or a push alone echoes nothing", async () => {
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
    // A canticle id names the canticle stream, never a chat: in any tool, it marks no
    // Discord event seen, though the chat's own batch came before it.
    assert.equal(
      (
        h.daemon.status("scribe") as {
          ears: Array<{ events: Record<string, number> }>;
        }
      ).ears[0]!.events.offered,
      1,
      "the Discord batch is still unseen",
    );
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

    // Naming a push echoes that push alone (🍃 on #112): a later push's id vouches for no
    // earlier one, and the bare id a tap shows, without the delivery token, for none.
    const f = await offered(h, host, shim, 6);
    const g = await offered(h, host, shim, 7);
    const bare = await h.call(shim, "ack", { batch_id: String(g.batchId) });
    assert.match(bare.text, /^0 canticle records echoed: .*delivery token/u);
    assert.equal(recordOf(await custody(h, shim), 7).state, "offered");
    await h.call(shim, "ack", { batch_id: g.meta.batch_id });
    view = await custody(h, shim);
    assert.equal(recordOf(view, 7).state, "echoed");
    assert.equal(
      recordOf(view, 6).state,
      "offered",
      "naming push 7 never vouches for push 6",
    );
    assert.equal(view.history, "incomplete");
    await h.call(shim, "ack", { batch_id: f.meta.batch_id });
    view = await custody(h, shim);
    assert.equal(recordOf(view, 6).state, "echoed");
    assert.equal(view.history, "complete");
    // The token form registered the ear by use, as a Discord batch's does (#21).
    assert.ok(h.store.ear("scribe")?.registered);
  } finally {
    h.dispose();
  }
});

test("sessions: one session's echo never vouches for a push to another; a push the host never confirmed is given back at the detach and goes to the next session, once", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    const first = h.attach("scribe", { sessionId: SESSION });
    await pressure(h, "b-1");
    const one = await offered(h, host, first, 1);
    // Pushed, but the shim drops it before writing it (it held it, then lost the daemon).
    host.sing(2);
    h.timers.advance(6_000);
    const dropped = pushes(first).at(-1)!;
    assert.deepEqual(order(dropped.content), ["ops:ops.fleet/2"]);
    first.close();
    // At most once holds for what was offered, not for what was only claimed (🍃 on
    // #112): the detach gives the claim back, and record 2 waits again, as a Discord
    // batch's events are queued again.
    assert.equal(status(h).waiting, 1, "record 2 waits again");
    assert.deepEqual(
      h.store.canticleCustody("scribe", 0).map((row) => row.identity),
      [identity(1)],
      "the claim given back left no row",
    );

    // Another session takes the ear: record 2 goes to it, once.
    const second = h.attach("scribe", { sessionId: OTHER_SESSION });
    // A late offered from the old shim changes nothing.
    await first.send({ type: "offered", batchId: dropped.batchId! });
    await pressure(h, null, { sessionId: OTHER_SESSION });
    h.timers.advance(6_000);
    assert.equal(pushes(second).length, 1);
    const again = pushes(second)[0]!;
    assert.deepEqual(order(again.content), ["ops:ops.fleet/2"]);
    assert.notEqual(again.batchId, dropped.batchId, "a new push");
    await second.send({ type: "offered", batchId: again.batchId! });
    await h.call(second, "ack", { batch_id: again.meta.batch_id });
    const third = await offered(h, host, second, 3);
    await h.call(second, "ack", { batch_id: third.meta.batch_id });
    // The second session names the first's push, token and all: it was never shown it.
    const stolen = await h.call(second, "ack", { batch_id: one.meta.batch_id });
    assert.match(stolen.text, /^0 canticle records echoed/u);
    h.timers.advance(60_000);
    assert.equal(pushes(second).length, 2, "nothing is pushed twice");
    const view = await custody(h, second);
    assert.equal(recordOf(view, 1).state, "offered", "offered to the first");
    assert.equal(recordOf(view, 2).state, "echoed");
    assert.equal(recordOf(view, 2).exposures, 1);
    assert.equal(recordOf(view, 3).state, "echoed");
    assert.equal(view.history, "incomplete");
    assert.deepEqual(view.reasons, ["1 record offered, never echoed"]);
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

test("restart: custody survives a frond-ear restart on the same store; the boundary is unknown until the session's hook reports again, and a push from before it can't be echoed by its id, only heard again", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-custody-"));
  const path = join(directory, "ear.db");
  try {
    const first = setup({ mode: "immediate" }, {}, {}, { path });
    let at: number;
    let two: Extract<DaemonMessage, { type: "event" }>;
    try {
      const shim = first.h.attach("scribe", { sessionId: SESSION });
      await pressure(first.h, "b-1");
      const push = await offered(first.h, first.host, shim, 1);
      await first.h.call(shim, "ack", { batch_id: push.meta.batch_id });
      two = await offered(first.h, first.host, shim, 2);
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
      // Push 2's delivery token was keyed by the process that pushed it, so this one
      // can't tell its id from a forged one: naming it echoes nothing.
      const stale = await second.h.call(shim, "ack", {
        batch_id: two.meta.batch_id,
      });
      assert.equal(
        stale.text,
        "0 canticle records echoed: that push went out before frond-ear last restarted, so its delivery token can't be checked any more; hear shows its records again while they are live",
      );
      assert.equal(recordOf(await custody(second.h, shim), 2).state, "offered");
      // The record pushed before the restart is not pushed again.
      second.host.sing(1);
      second.host.sing(2);
      second.h.timers.advance(10_000);
      assert.equal(pushes(shim).length, 0);
      // hear shows it again: that exposure is echoed at its return.
      await second.h.call(shim, "hear", {});
      view = await custody(second.h, shim);
      assert.equal(recordOf(view, 2).state, "echoed");
      assert.equal(view.history, "complete");
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
        { name: "canticle.cursor.scribe", value: "{}", before: "{}" },
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

test("sessions: a session switch inside one attach never lets the new session's echo vouch for what the old one was shown", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await pressure(h, null);
    await offered(h, host, shim, 1);
    // The same shim now speaks for another session (a /clear in the same process).
    await shim.send({ type: "session", sessionId: OTHER_SESSION });
    h.clock.advance(1_000);
    await pressure(h, null, { sessionId: OTHER_SESSION });
    const second = await offered(h, host, shim, 2);
    await h.call(shim, "ack", { batch_id: second.meta.batch_id });
    const view = await custody(h, shim);
    assert.equal(
      recordOf(view, 1).state,
      "offered",
      "shown to the session before the switch, never echoed by it",
    );
    assert.equal(recordOf(view, 2).state, "echoed");
    assert.equal(view.history, "incomplete");
  } finally {
    h.dispose();
  }
});

test("store: claiming a record over a lapsed tombstone row and giving the claim back leaves no tombstone for it", () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-custody-lapse-"));
  try {
    const clock = new FakeClock(5_000_000);
    const store = new EventStore(join(directory, "ear.db"), clock);
    try {
      const row = {
        identity: "k:7:s:1",
        outcome: "pushed" as const,
        refreshKey: null,
        digest: null,
      };
      store.settleCanticle("scribe", [{ ...row, expiresAt: 5_010_000 }]);
      // The tombstone lapses; no prune has run, so its row is still there.
      clock.advance(60_000);
      const batch = store.claimCanticlePush(
        "scribe",
        { generation: 1, sessionId: SESSION },
        [{ ...row, expiresAt: 5_500_000 }],
        { name: "canticle.cursor.scribe", value: "{}", before: "{}" },
        [],
      );
      store.releaseCanticlePush("scribe", batch, {
        name: "canticle.cursor.scribe",
        value: "{}",
      });
      assert.deepEqual(
        store.canticleSettled(clock.now()).map((item) => item.identity),
        [],
        "a restart would not take the record as pushed",
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ---- 🍃's review of #112 (6009966014): P2-1, P2-2, P2-3, P3 -----------------------------

test("transport: LineConnection.send says whether its socket can still carry a write: not once the socket is destroyed, nor once the peer has closed its end, nor once closed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-line-"));
  const accepted: Socket[] = [];
  const server = createServer((socket) => accepted.push(socket));
  const path = join(directory, "line.sock");
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const peers: Socket[] = [];
  try {
    const pair = async () => {
      const peer = connect(path);
      peers.push(peer);
      peer.on("error", () => undefined);
      await new Promise<void>((resolve) => peer.once("connect", resolve));
      const socket = await until(
        () => accepted[peers.length - 1],
        "the accepted socket",
      );
      return {
        peer,
        socket,
        line: new LineConnection(
          socket,
          () => undefined,
          () => undefined,
        ),
      };
    };
    const probe = { type: "detached", reason: "probe" } as const;

    const destroyed = await pair();
    assert.equal(destroyed.line.send(probe), true, "a live socket takes it");
    destroyed.socket.destroy(); // its close event is still to come
    assert.equal(destroyed.line.send(probe), false, "destroyed");

    const ended = await pair();
    const atEnd: boolean[] = [];
    ended.socket.once("end", () => atEnd.push(ended.line.send(probe)));
    ended.peer.destroy(); // the shim is gone; its end arrives before the close
    await until(() => atEnd[0], "the peer's end", 2_000).catch(() => undefined);
    assert.deepEqual(atEnd, [false], "the peer closed its end");

    const closed = await pair();
    closed.line.close();
    assert.equal(closed.line.send(probe), false, "closed");
  } finally {
    for (const peer of peers) peer.destroy();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("transport: a push onto a real connection whose socket is already gone (destroyed, or closed by the shim) is given back at once: nothing counts as pushed, no claim is kept, and the next session gets the record once (P2-1)", async () => {
  const { h, host } = setup({ mode: "immediate" });
  const { path, server, sockets } = await served(h);
  try {
    host.sing(1);
    // The daemon's side of the connection is destroyed, its close not handled yet: the
    // ear is still attached, so the push is tried, and the write goes nowhere.
    await rawShim(path);
    sockets.at(-1)!.destroy();
    h.timers.advance(6_000);
    assert.equal(
      status(h).counts.records_pushed ?? 0,
      0,
      "nothing counts as pushed",
    );
    assert.equal(status(h).counts.unsent, 1);
    assert.equal(status(h).waiting, 1, "the record waits");
    assert.deepEqual(h.store.canticleCustody("scribe", 0), [], "no claim kept");
    await until(() => (attached(h) ? undefined : true), "the detach");

    // The shim goes away: the daemon reads its end, and pushes before the close comes.
    const shim = await rawShim(path);
    sockets.at(-1)!.once("end", () => h.timers.advance(6_000));
    shim.socket.destroy();
    await until(() => (attached(h) ? undefined : true), "the detach");
    assert.equal(status(h).counts.records_pushed ?? 0, 0);
    assert.equal(status(h).counts.unsent, 2);
    assert.deepEqual(h.store.canticleCustody("scribe", 0), []);

    // A working session takes the ear: the record goes to it, once.
    const working = h.attach("scribe", { sessionId: SESSION });
    h.timers.advance(6_000);
    assert.equal(pushes(working).length, 1);
    assert.deepEqual(order(pushes(working)[0]!.content), ["ops:ops.fleet/1"]);
    await working.send({
      type: "offered",
      batchId: pushes(working)[0]!.batchId!,
    });
    h.timers.advance(60_000);
    assert.equal(pushes(working).length, 1, "once");
    assert.deepEqual(status(h).counts, {
      pushes: 1,
      records_pushed: 1,
      unsent: 2,
    });
    const view = await custody(h, working);
    assert.equal(view.records.length, 1);
    assert.equal(recordOf(view, 1).state, "offered");
    assert.equal(recordOf(view, 1).exposures, 1);
  } finally {
    server.close();
    h.dispose();
  }
});

test("transport: a push the real shim held and never offered is given back when its socket drops, as the Discord batch held with it is; the next session gets both, the record once (P2-2)", async () => {
  const { h, host } = setup({ mode: "immediate" });
  const { path, server } = await served(h);
  const shims: ChannelShim[] = [];
  try {
    // The shim attaches before Claude Code listens, so it holds what it is sent.
    const early = channelShim(path);
    shims.push(early.shim);
    await until(() => (attached(h) ? true : undefined), "the attach");
    host.sing(1);
    h.daemon.ingest(
      message({
        channel_id: CHANNEL,
        guild_id: GUILD,
        author: { id: PRINCIPAL, username: "figs" },
        content: "<@" + BOT + "> ping",
        mentions: [{ id: BOT }],
      }),
    );
    h.timers.advance(6_000);
    await until(
      () =>
        early.raw().includes('"kind":"canticle"') &&
        early.raw().includes('"kind":"mention"')
          ? true
          : undefined,
      "both pushes on the shim's socket",
    );
    assert.equal(early.notifications().length, 0, "held, never written");
    const claimed = h.store.canticleCustody("scribe", 0);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]!.offeredAt, null);

    // The socket drops (the daemon restarts, the shim's process goes): what it held is
    // gone, and nothing it held was offered.
    early.shim.stop();
    await until(() => (attached(h) ? undefined : true), "the detach");
    assert.deepEqual(
      h.store.canticleCustody("scribe", 0),
      [],
      "the claim is given back",
    );
    assert.deepEqual(
      h.store
        .canticleSettled(h.clock.now())
        .filter((row) => row.ear === "scribe"),
      [],
      "and its tombstone",
    );
    assert.equal(status(h).waiting, 1, "the record waits again");
    const events = () =>
      (
        h.daemon.status("scribe") as {
          ears: Array<{ events: Record<string, number> }>;
        }
      ).ears[0]!.events;
    assert.equal(events().queued, 1, "the Discord event is queued again");

    // Claude Code listens behind the next shim: both come to it, and it offers both.
    const next = channelShim(path);
    shims.push(next.shim);
    await until(() => (attached(h) ? true : undefined), "the attach");
    await next.listen();
    h.timers.advance(6_000);
    await until(
      () =>
        next.notifications().length === 2 &&
        h.store.canticleCustody("scribe", 0)[0]?.offeredAt != null
          ? true
          : undefined,
      "both notifications, and the push offered",
    );
    const canticle = next
      .notifications()
      .filter((note) => note.meta.kind === "canticle");
    assert.equal(canticle.length, 1);
    assert.deepEqual(order(canticle[0]!.content), ["ops:ops.fleet/1"]);
    assert.match(canticle[0]!.meta.batch_id ?? "", /^\d+-[0-9a-f]{8}$/u);
    h.timers.advance(60_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      next.notifications().filter((note) => note.meta.kind === "canticle")
        .length,
      1,
      "once",
    );
    const rows = h.store.canticleCustody("scribe", 0);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.offerSession, SESSION);
    assert.deepEqual(status(h).counts, {
      pushes: 2,
      records_pushed: 2,
      reverted: 1,
    });
  } finally {
    for (const shim of shims) shim.stop();
    server.close();
    h.dispose();
  }
});

test("revert: a report the host never confirmed gives back its cursor with its claim; the next session's report carries the same records as new, under the same number", async () => {
  const { h, host } = setup({ mode: "digest", windowMs: 10_000 });
  try {
    const first = h.attach("scribe", { sessionId: SESSION });
    host.sing(1);
    host.sing(2);
    host.sing(3, { ttlMs: 2_000 }); // off air before the report
    h.timers.advance(11_000);
    assert.equal(pushes(first).length, 1);
    assert.equal(pushes(first)[0]!.meta.report, "1");
    const line =
      /^ops:ops\.fleet: 2 new records \(items 7\/1 to 7\/2\), 1 went off air unpushed:$/mu;
    assert.match(pushes(first)[0]!.content, line);
    first.close();
    assert.equal(status(h).waiting, 2);
    assert.equal(status(h).reports, 0, "the report number is given back");
    assert.equal(status(h).pushesLastHour, 0, "and the hour's budget");

    const second = h.attach("scribe", { sessionId: SESSION });
    h.timers.advance(11_000);
    assert.equal(pushes(second).length, 1);
    const report = pushes(second)[0]!;
    assert.equal(report.meta.report, "1");
    assert.deepEqual(order(report.content), [
      "ops:ops.fleet/1",
      "ops:ops.fleet/2",
    ]);
    assert.match(
      report.content,
      line,
      "new records, not out of order, and what it missed",
    );
    await second.send({ type: "offered", batchId: report.batchId! });
    host.sing(3);
    h.timers.advance(11_000);
    assert.equal(pushes(second).length, 2);
    const next = pushes(second)[1]!;
    assert.equal(next.meta.report, "2");
    assert.match(
      next.content,
      /^ops:ops\.fleet: 1 new record \(item 7\/3\):$/mu,
    );
    assert.equal(status(h).pushesLastHour, 2);
    assert.deepEqual(status(h).counts, {
      off_air_unpushed: 1,
      reports: 3,
      records_pushed: 5,
      reverted: 1,
    });
  } finally {
    h.dispose();
  }
});

test("restart: a push the host never confirmed before frond-ear stops is given back at shutdown; after the restart it goes out again while on air, and a confirmed one doesn't", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-custody-"));
  const path = join(directory, "ear.db");
  try {
    const first = setup({ mode: "immediate" }, {}, {}, { path });
    let at: number;
    try {
      const shim = first.h.attach("scribe", { sessionId: SESSION });
      await offered(first.h, first.host, shim, 1);
      first.host.sing(2);
      first.h.timers.advance(6_000);
      assert.equal(pushes(shim).length, 2, "push 2 went out, unconfirmed");
      at = first.h.clock.now();
    } finally {
      first.h.dispose();
    }
    const second = setup({ mode: "immediate" }, {}, {}, { path });
    try {
      second.h.clock.value = at + 10_000;
      const shim = second.h.attach("scribe", { sessionId: SESSION });
      second.host.sing(1);
      second.host.sing(2);
      second.h.timers.advance(6_000);
      assert.equal(pushes(shim).length, 1);
      assert.deepEqual(order(pushes(shim)[0]!.content), ["ops:ops.fleet/2"]);
      second.h.timers.advance(60_000);
      assert.equal(pushes(shim).length, 1, "once");
      assert.deepEqual(
        second.h.store
          .canticleCustody("scribe", 0)
          .map((row) => [row.identity, row.offeredAt !== null]),
        [
          [identity(1), true],
          [identity(2), false],
        ],
      );
    } finally {
      second.h.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restart: a push a crash left unconfirmed is given back when the next session attaches, cursor and all, and its record goes to that session while on air", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-custody-"));
  const path = join(directory, "ear.db");
  try {
    const first = setup({ mode: "immediate" }, {}, {}, { path });
    const shim = first.h.attach("scribe", { sessionId: SESSION });
    first.host.sing(1);
    first.h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1);
    const at = first.h.clock.now();
    // The process dies: no shutdown, so nothing is reverted.
    first.h.store.close();
    rmSync(first.h.directory, { recursive: true, force: true });

    const second = setup({ mode: "immediate" }, {}, {}, { path });
    try {
      second.h.clock.value = at + 10_000;
      second.host.sing(1);
      second.h.timers.advance(6_000);
      assert.equal(status(second.h).waiting, 0, "its tombstone holds it");
      const next = second.h.attach("scribe", { sessionId: SESSION });
      second.h.timers.advance(6_000);
      assert.equal(pushes(next).length, 1);
      assert.deepEqual(order(pushes(next)[0]!.content), ["ops:ops.fleet/1"]);
      assert.equal(
        status(second.h).pushesLastHour,
        1,
        "the crashed push's place in the hour went back with it",
      );
      second.h.timers.advance(60_000);
      assert.equal(pushes(next).length, 1, "once");
      assert.equal(second.h.store.canticleCustody("scribe", 0).length, 1);
    } finally {
      second.h.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("echo: naming a push echoes that push alone; an earlier push stays offered, and naming a push the host never confirmed echoes nothing (P2-3)", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await pressure(h, "b-1");
    await offered(h, host, shim, 1);
    host.sing(2);
    h.timers.advance(6_000);
    const unconfirmed = pushes(shim).at(-1)!;
    const named = await h.call(shim, "ack", {
      batch_id: unconfirmed.meta.batch_id,
    });
    assert.equal(
      named.text,
      "0 canticle records echoed: already echoed, or the push was never confirmed delivered to this session",
    );
    let view = await custody(h, shim);
    assert.equal(
      recordOf(view, 1).state,
      "offered",
      "an unconfirmed push vouches for no earlier one",
    );
    assert.equal(recordOf(view, 2).state, "claimed");

    const third = await offered(h, host, shim, 3);
    // A reply naming push 3 echoes push 3, and only it.
    await h.call(shim, "reply", {
      chat_id: CHANNEL,
      text: "heard 3",
      batch_id: third.meta.batch_id,
    });
    view = await custody(h, shim);
    assert.deepEqual(
      [1, 2, 3].map((seq) => recordOf(view, seq).state),
      ["offered", "claimed", "echoed"],
    );
    assert.deepEqual(view.reasons, [
      "1 record pushed, never confirmed handed to the session",
      "1 record offered, never echoed",
    ]);
  } finally {
    h.dispose();
  }
});

test("echo: a custody echo needs the whole batch_id its push carried: a forged token, another push's token or the bare id echoes nothing, in ack or reply; the same session on a new attach still can (P3)", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await pressure(h, "b-1");
    const a = await offered(h, host, shim, 1);
    const b = await offered(h, host, shim, 2);
    const tokenOf = (push: Extract<DaemonMessage, { type: "event" }>) =>
      push.meta.batch_id!.split("-")[1]!;
    for (const forged of [
      `${a.batchId}-deadbeef`,
      `${a.batchId}-${tokenOf(b)}`,
      String(a.batchId),
    ]) {
      const result = await h.call(shim, "ack", { batch_id: forged });
      assert.equal(result.ok, true, result.text);
      assert.equal(
        result.text,
        "0 canticle records echoed: a canticle push is heard only by the batch_id its event carried, delivery token and all; this one's token is missing or wrong (pass the kind=\"canticle\" event's batch_id as it is)",
        forged,
      );
    }
    const replied = await h.call(shim, "reply", {
      chat_id: CHANNEL,
      text: "heard",
      batch_id: `${b.batchId}-deadbeef`,
    });
    assert.equal(replied.ok, true, "the reply itself still goes");
    let view = await custody(h, shim);
    assert.deepEqual(
      [1, 2].map((seq) => recordOf(view, seq).state),
      ["offered", "offered"],
    );
    assert.equal(view.history, "incomplete");

    // The same session on a new attach (its shim reconnected) still holds each push's id.
    shim.close();
    const again = h.attach("scribe", { sessionId: SESSION });
    assert.equal(
      (await h.call(again, "ack", { batch_id: a.meta.batch_id })).text,
      "1 canticle record echoed as heard",
    );
    await h.call(again, "reply", {
      chat_id: CHANNEL,
      text: "and that",
      batch_id: b.meta.batch_id,
    });
    view = await custody(h, again);
    assert.deepEqual(
      [1, 2].map((seq) => recordOf(view, seq).state),
      ["echoed", "echoed"],
    );
    assert.equal(view.history, "complete");
  } finally {
    h.dispose();
  }
});

test("store: a revert gives back every canticle claim the host never confirmed: custody rows, tombstones and the cursor from before the first; a confirmed push, another ear's claim and a released one keep theirs", () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-custody-revert-"));
  try {
    const clock = new FakeClock(5_000_000);
    const store = new EventStore(join(directory, "ear.db"), clock);
    try {
      const session = { generation: 1, sessionId: SESSION };
      const exposure = (seq: number) => ({
        path: "immediate" as const,
        mode: "immediate",
        identity: `k:7:s:${seq}`,
        station: "ops",
        stream: "s",
        keyId: "k",
        epoch: 7,
        seq: String(seq),
        digest: null,
        shown: "whole" as const,
      });
      const row = (seq: number) => ({
        identity: `k:7:s:${seq}`,
        outcome: "pushed" as const,
        refreshKey: null,
        digest: null,
        expiresAt: 9_999_999_999,
      });
      const claim = (seq: number, before: string, ear = "scribe") =>
        store.claimCanticlePush(
          ear,
          session,
          [row(seq)],
          { name: `canticle.cursor.${ear}`, value: `after ${seq}`, before },
          [exposure(seq)],
        );
      const confirm = (batch: number) => {
        assert.ok(store.confirmBatch(batch, "scribe", 1));
        store.offerCanticleCustody("scribe", batch, {
          at: clock.now(),
          sessionId: SESSION,
          boundary: null,
        });
      };
      const kept = () =>
        store.canticleCustody("scribe", 0).map((item) => item.identity);
      const settled = () =>
        store
          .canticleSettled(clock.now())
          .filter((item) => item.ear === "scribe")
          .map((item) => item.identity);
      const cursor = () => store.runtimeState("canticle.cursor.scribe");

      confirm(claim(1, "start"));
      const b = claim(2, "after 1");
      const c = claim(3, "after 2");
      claim(9, "o before", "other");
      const released = store.revertUnconfirmed("scribe");
      assert.deepEqual(kept(), ["k:7:s:1"], "custody rows given back");
      assert.deepEqual(settled(), ["k:7:s:1"], "tombstones given back");
      assert.equal(cursor(), "after 1", "the cursor from before push 2");
      assert.equal(store.isCanticleBatch("scribe", b), false);
      assert.deepEqual(released, {
        batches: 2,
        canticle: [
          { batchId: b, identities: ["k:7:s:2"], collapsed: [] },
          { batchId: c, identities: ["k:7:s:3"], collapsed: [] },
        ],
      });
      assert.equal(store.runtimeState("canticle.cursor.other"), "after 9");
      assert.equal(store.canticleCustody("other", 0).length, 1);
      assert.deepEqual(store.revertUnconfirmed("scribe"), {
        batches: 0,
        canticle: [],
      });
      assert.equal(cursor(), "after 1");

      // A push released at once (no connection took it) leaves nothing to revert.
      const d = claim(4, "after 1");
      store.releaseCanticlePush("scribe", d, {
        name: "canticle.cursor.scribe",
        value: "after 1",
      });
      store.setRuntimeState("canticle.cursor.scribe", "after 1 again");
      store.revertUnconfirmed("scribe");
      assert.equal(cursor(), "after 1 again");

      // No shim confirms out of order, but if a later push were confirmed before an
      // earlier one, the cursor has moved past both: the revert leaves it.
      const e = claim(5, "after 1 again");
      confirm(claim(6, "after 5"));
      store.revertUnconfirmed("scribe");
      assert.equal(cursor(), "after 6");
      assert.deepEqual(kept(), ["k:7:s:1", "k:7:s:6"]);
      assert.equal(store.isCanticleBatch("scribe", e), false);
      assert.equal(store.canticlePush("scribe", e), "reverted");

      // A refresh that collapses into an unconfirmed push goes back with it; one that a
      // confirmed push stands behind stays.
      const keyed = (seq: number, outcome: "pushed" | "collapsed") => ({
        ...row(seq),
        outcome,
        refreshKey: '["k","s","x"]',
        digest: "d".repeat(64),
      });
      const f = store.claimCanticlePush(
        "scribe",
        session,
        [keyed(7, "pushed")],
        { name: "canticle.cursor.scribe", value: "after 7", before: "after 6" },
        [exposure(7)],
      );
      store.settleCanticle("scribe", [keyed(8, "collapsed")]);
      assert.deepEqual(store.revertUnconfirmed("scribe").canticle, [
        {
          batchId: f,
          identities: ["k:7:s:7"],
          collapsed: ["k:7:s:8"],
        },
      ]);
      assert.equal(settled().includes("k:7:s:8"), false);
      const g = store.claimCanticlePush(
        "scribe",
        session,
        [keyed(9, "pushed")],
        { name: "canticle.cursor.scribe", value: "after 9", before: "after 7" },
        [exposure(9)],
      );
      confirm(g);
      store.settleCanticle("scribe", [keyed(10, "collapsed")]);
      store.revertUnconfirmed("scribe");
      assert.equal(settled().includes("k:7:s:10"), true);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ---- the independent review of the fix (9eafe13..81d9de1) ------------------------------

test("revert: a reverted push's id still names a canticle push: it echoes nothing and marks no Discord event seen, in ack or reply", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    const first = h.attach("scribe", { sessionId: SESSION });
    // A Discord batch, offered and unread.
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
    const discord = first.connection
      .events()
      .filter((event) => event.meta.kind === "mention")
      .at(-1)!;
    await first.send({ type: "offered", batchId: discord.batchId! });
    // A push the shim wrote but never confirmed; then its connection goes.
    host.sing(1);
    h.timers.advance(6_000);
    const lost = pushes(first).at(-1)!;
    first.close();

    const second = h.attach("scribe", { sessionId: SESSION });
    const unseen = () =>
      (
        h.daemon.status("scribe") as {
          ears: Array<{ events: Record<string, number> }>;
        }
      ).ears[0]!.events.offered;
    assert.equal(unseen(), 1);
    const acked = await h.call(second, "ack", { batch_id: lost.meta.batch_id });
    assert.equal(
      acked.text,
      "0 canticle records echoed: that push was given back unconfirmed when its connection went, and its records go out again under a new batch_id; name that one",
    );
    const replied = await h.call(second, "reply", {
      chat_id: CHANNEL,
      text: "on it",
      batch_id: lost.meta.batch_id,
    });
    assert.equal(replied.ok, true, replied.text);
    assert.equal(unseen(), 1, "the Discord batch is still unseen");

    // The record went out again under a new id, and that one echoes.
    h.timers.advance(6_000);
    const again = pushes(second).at(-1)!;
    assert.notEqual(again.batchId, lost.batchId);
    await second.send({ type: "offered", batchId: again.batchId! });
    assert.equal(
      (await h.call(second, "ack", { batch_id: again.meta.batch_id })).text,
      "1 canticle record echoed as heard",
    );
    assert.equal(unseen(), 1);
  } finally {
    h.dispose();
  }
});

test("revert: a refresh that collapsed into a push the host never confirmed is given back with it: it goes out once its original is off air, and stays collapsed into one that goes out again", async () => {
  const A = "a".repeat(64);
  const B = "b".repeat(64);
  const { h, host } = setup({ mode: "immediate" });
  try {
    const first = h.attach("scribe", { sessionId: SESSION });
    const x = { stateKey: "x", text: "x: deploying", digest: A };
    const y = { stateKey: "y", text: "y: deploying", digest: B };
    host.sing(1, { ...x, ttlMs: 9_000 });
    host.sing(3, { ...y, ttlMs: 600_000 });
    h.timers.advance(6_000);
    assert.equal(pushes(first).length, 1, "1 and 3, never confirmed");
    // Their refreshes, same bodies: each collapses into the push.
    host.sing(2, { ...x, ttlMs: 600_000, flags: { refresh: true } });
    host.sing(4, { ...y, ttlMs: 600_000, flags: { refresh: true } });
    h.timers.advance(2_000);
    assert.equal(status(h).counts.refresh_collapsed, 2);
    h.timers.advance(2_000); // record 1 goes off air; 2 carries its body on
    first.close();

    const second = h.attach("scribe", { sessionId: SESSION });
    h.timers.advance(6_000);
    assert.equal(pushes(second).length, 1);
    assert.deepEqual(order(pushes(second)[0]!.content), [
      "ops:ops.fleet/2",
      "ops:ops.fleet/3",
    ]);
    await confirm(second);
    h.timers.advance(60_000);
    assert.equal(pushes(second).length, 1, "4 is 3 again, which went out");
    assert.deepEqual(
      h.store
        .canticleCustody("scribe", 0)
        .map((row) => [row.identity, row.offeredAt !== null]),
      [
        [identity(2), true],
        [identity(3), true],
      ],
    );
  } finally {
    h.dispose();
  }
});

test("revert: a refresh kept collapsed into a record that waits again goes out if that record goes off air before it is pushed", async () => {
  const A = "a".repeat(64);
  const { h, host } = setup({ mode: "immediate", maxAgeMs: 120_000 });
  try {
    const first = h.attach("scribe", { sessionId: SESSION });
    const x = { stateKey: "x", text: "x: deploying", digest: A };
    host.sing(1, { ...x, ttlMs: 30_000 });
    h.timers.advance(6_000);
    assert.equal(pushes(first).length, 1, "record 1, never confirmed");
    host.sing(2, { ...x, ttlMs: 600_000, flags: { refresh: true } });
    h.timers.advance(2_000);
    assert.equal(status(h).counts.refresh_collapsed, 1);
    first.close(); // record 1 is still on air: it waits again
    assert.equal(status(h).waiting, 1);
    h.timers.advance(30_000); // no session; record 1 goes off air as it waits
    assert.equal(status(h).counts.off_air_unpushed, 1);

    const second = h.attach("scribe", { sessionId: SESSION });
    h.timers.advance(6_000);
    assert.equal(pushes(second).length, 1, "refresh 2 carries the body");
    assert.deepEqual(order(pushes(second)[0]!.content), ["ops:ops.fleet/2"]);
  } finally {
    h.dispose();
  }
});

test("restart: after a crash, a refresh that collapsed into the push left unconfirmed stays collapsed when that push's record goes out again", async () => {
  const A = "a".repeat(64);
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-custody-"));
  const path = join(directory, "ear.db");
  try {
    const x = { stateKey: "x", text: "x: deploying", digest: A };
    const first = setup({ mode: "immediate" }, {}, {}, { path });
    const shim = first.h.attach("scribe", { sessionId: SESSION });
    first.host.sing(1, { ...x, ttlMs: 600_000 });
    first.h.timers.advance(6_000);
    first.host.sing(2, { ...x, ttlMs: 600_000, flags: { refresh: true } });
    first.h.timers.advance(2_000);
    assert.equal(pushes(shim).length, 1);
    assert.equal(status(first.h).counts.refresh_collapsed, 1);
    const at = first.h.clock.now();
    first.h.store.close(); // the process dies: nothing is reverted
    rmSync(first.h.directory, { recursive: true, force: true });

    const second = setup({ mode: "immediate" }, {}, {}, { path });
    try {
      second.h.clock.value = at + 5_000;
      second.host.sing(1, { ...x, ttlMs: 600_000 });
      second.host.sing(2, { ...x, ttlMs: 600_000, flags: { refresh: true } });
      second.h.timers.advance(2_000);
      const next = second.h.attach("scribe", { sessionId: SESSION });
      second.h.timers.advance(6_000);
      assert.equal(pushes(next).length, 1);
      assert.deepEqual(order(pushes(next)[0]!.content), ["ops:ops.fleet/1"]);
      await confirm(next);
      second.h.timers.advance(60_000);
      assert.equal(pushes(next).length, 1, "2 is 1 again");
    } finally {
      second.h.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
