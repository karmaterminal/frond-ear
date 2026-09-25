import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { chunkMessage } from "../src/rest.ts";
import {
  AMBIENT,
  BOT,
  CHANNEL,
  DM,
  PEER_BOT,
  PRINCIPAL,
  ROOM,
  SILENT,
  harness,
  message,
  testConfig,
} from "./helpers.ts";
import * as helpers from "./helpers.ts";

test("a mention flushes after the priority quiet window and carries buffered context", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe");
    h.daemon.ingest(message({ content: "context one" }));
    h.daemon.ingest(message({ content: "context two" }));
    assert.equal(
      shim.connection.events().length,
      0,
      "context alone never wakes",
    );
    h.daemon.ingest(
      message({
        author: { id: AMBIENT, username: "ana" },
        content: `<@${BOT}> are you there?`,
      }),
    );
    h.timers.advance(999);
    assert.equal(shim.connection.events().length, 0);
    h.timers.advance(1);
    const [event] = shim.connection.events();
    assert.ok(event);
    assert.equal(event.meta.kind, "mention");
    assert.equal(event.meta.chat_id, CHANNEL);
    assert.equal(event.meta.trust, "ambient");
    assert.equal(event.meta.count, "3");
    assert.match(
      event.content,
      /Room context since you last looked[\s\S]*context one[\s\S]*context two[\s\S]*New for you:[\s\S]*are you there\?/u,
    );
    for (const key of Object.keys(event.meta)) {
      assert.match(
        key,
        /^[A-Za-z0-9_]+$/u,
        "meta keys must survive Claude Code's filter",
      );
    }
    await shim.send({ type: "offered", batchId: event.batchId as number });
    assert.equal(h.store.stateCounts("scribe").offered, 3);
  } finally {
    h.dispose();
  }
});

test("room mode debounces: quiet window extends, max delay bounds starvation", () => {
  const h = harness();
  try {
    const shim = h.attach("scribe");
    // Continuous chatter every 3s never leaves a 4s quiet gap...
    for (let index = 0; index < 8; index += 1) {
      h.daemon.ingest(
        message({ channel_id: ROOM, content: `chatter ${index}` }),
      );
      h.timers.advance(3_000);
    }
    // ...but the 20s max delay forces exactly one batch containing the first 7.
    const events = shim.connection.events();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.meta.kind, "room");
    assert.equal(events[0]?.meta.count, "7");
    h.timers.advance(4_000);
    assert.equal(
      shim.connection.events().length,
      2,
      "the tail flushes after its quiet window",
    );
  } finally {
    h.dispose();
  }
});

test("later room chatter cannot push a pending mention back", () => {
  const h = harness();
  try {
    const shim = h.attach("scribe");
    h.daemon.ingest(
      message({
        channel_id: ROOM,
        mentions: [{ id: BOT }],
        content: "hey scribe",
      }),
    );
    h.timers.advance(500);
    h.daemon.ingest(message({ channel_id: ROOM, content: "unrelated" }));
    h.timers.advance(500);
    assert.equal(shim.connection.events().length, 1);
    assert.equal(shim.connection.events()[0]?.meta.count, "2");
  } finally {
    h.dispose();
  }
});

test("events wait while no shim is attached and flow on attach; silent channels never push", () => {
  const h = harness();
  try {
    h.daemon.ingest(
      message({ author: { id: PRINCIPAL }, content: "while you were away" }),
    );
    h.daemon.ingest(
      message({
        channel_id: SILENT,
        author: { id: PRINCIPAL },
        content: "silent",
      }),
    );
    h.timers.advance(60_000);
    const shim = h.attach("scribe");
    const events = shim.connection.events();
    assert.equal(events.length, 1);
    assert.match(events[0]?.content ?? "", /while you were away/u);
    assert.equal(h.store.stateCounts("scribe").stored, 1);
  } finally {
    h.dispose();
  }
});

test("an unconfirmed batch reverts when the shim drops and is redelivered to the next attach", () => {
  const h = harness();
  try {
    const first = h.attach("scribe");
    h.daemon.ingest(
      message({ author: { id: PRINCIPAL }, content: "important" }),
    );
    h.timers.advance(1_000);
    assert.equal(first.connection.events().length, 1);
    first.close(); // never confirmed "offered"
    assert.equal(h.store.stateCounts("scribe").queued, 1);
    const second = h.attach("scribe");
    assert.match(second.connection.events()[0]?.content ?? "", /important/u);
  } finally {
    h.dispose();
  }
});

test("takeover detaches the old shim; offered-but-unseen work becomes one digest, not a replay", async () => {
  const h = harness();
  try {
    const first = h.attach("scribe", { sessionId: "session-a" });
    h.daemon.ingest(
      message({ author: { id: PRINCIPAL }, content: "first secret plan" }),
    );
    h.timers.advance(1_000);
    const batch = first.connection.events()[0];
    await first.send({ type: "offered", batchId: batch?.batchId as number });

    const second = h.attach("scribe", { sessionId: "session-b" });
    assert.deepEqual(first.connection.received.at(-1), {
      type: "detached",
      reason: "superseded",
    });
    const welcome = second.connection.received[0];
    assert.equal(welcome?.type, "welcome");
    assert.equal(welcome?.type === "welcome" && welcome.generation, 2);
    const [digest] = second.connection.events();
    assert.equal(digest?.meta.kind, "digest");
    assert.doesNotMatch(digest?.content ?? "", /secret plan/u);
    // The superseded shim can no longer mark anything seen.
    const stale = await h.call(first, "ack", {});
    assert.match(stale.text, /^0 events/u);
    const inbox = await h.call(second, "inbox", {});
    assert.match(inbox.text, /first secret plan/u);
    assert.match(inbox.text, /1 marked seen/u);
    assert.equal(h.store.stateCounts("scribe").seen, 1);
  } finally {
    h.dispose();
  }
});

test("attach canary: registered only after ack(nonce)", async () => {
  const config = testConfig({
    ears: {
      scribe: { attachCanary: true, channels: { [CHANNEL]: "mentions" } },
    },
  });
  const h = harness(config, { nonce: "c0ffee" });
  try {
    const shim = h.attach("scribe");
    const [canary] = shim.connection.events();
    assert.equal(canary?.meta.kind, "attach");
    assert.match(canary?.content ?? "", /nonce "c0ffee"/u);
    const status = () =>
      h.daemon.status("scribe") as { ears: Array<{ registered: boolean }> };
    assert.equal(status().ears[0]?.registered, false);
    assert.equal((await h.call(shim, "ack", { nonce: "wrong" })).ok, false);
    assert.equal((await h.call(shim, "ack", { nonce: "c0ffee" })).ok, true);
    assert.equal(status().ears[0]?.registered, true);
  } finally {
    h.dispose();
  }
});

test("reply chunks long text, quotes only the first chunk, and marks the chat seen", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe");
    h.daemon.ingest(
      message({ author: { id: PRINCIPAL }, content: "write me an essay" }),
    );
    h.timers.advance(1_000);
    await shim.send({
      type: "offered",
      batchId: shim.connection.events()[0]?.batchId as number,
    });
    const text = `${"a".repeat(1_500)}\n\n${"b".repeat(1_500)}`;
    const result = await h.call(shim, "reply", {
      chat_id: CHANNEL,
      text,
      reply_to: "42",
    });
    assert.equal(result.ok, true);
    const sends = h.rest.calls.filter((call) => call.method === "send");
    assert.equal(sends.length, 2);
    assert.equal(sends[0]?.replyTo, "42");
    assert.equal(sends[1]?.replyTo, undefined);
    assert.equal(h.store.stateCounts("scribe").seen, 1);
  } finally {
    h.dispose();
  }
});

test("outbound is limited to bound channels, their threads and known DMs", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe");
    const denied = await h.call(shim, "reply", {
      chat_id: "123456",
      text: "hi",
    });
    assert.equal(denied.ok, false);
    assert.match(denied.text, /not bound/u);
    assert.equal(
      (await h.call(shim, "reply", { chat_id: DM, text: "hi" })).ok,
      false,
    );
    const { guild_id: _guild, ...dm } = message({
      channel_id: DM,
      author: { id: PRINCIPAL },
    });
    h.daemon.ingest(dm);
    assert.equal(
      (await h.call(shim, "reply", { chat_id: DM, text: "hi" })).ok,
      true,
    );
    assert.equal(h.rest.calls.length, 1);
  } finally {
    h.dispose();
  }
});

test("a session without an ear gets tools but cannot mark the attached session's events", async () => {
  const h = harness();
  try {
    const attached = h.attach("scribe");
    const toolsOnly = h.attach();
    const welcome = toolsOnly.connection.received[0];
    assert.equal(welcome?.type === "welcome" && welcome.attached, false);
    h.daemon.ingest(
      message({ author: { id: PRINCIPAL }, content: "for scribe" }),
    );
    h.timers.advance(1_000);
    assert.equal(toolsOnly.connection.events().length, 0);
    assert.equal(attached.connection.events().length, 1);
    const inbox = await h.call(toolsOnly, "inbox", {});
    assert.match(inbox.text, /read-only/u);
    assert.equal(h.store.stateCounts("scribe").seen, 0);
  } finally {
    h.dispose();
  }
});

test("bot ping-pong is broken: after the loop limit, peer bot messages stop waking", () => {
  const h = harness(
    testConfig({
      botLoop: { maxEvents: 3, windowMs: 60_000, cooldownMs: 60_000 },
    }),
  );
  try {
    h.attach("scribe");
    for (let index = 0; index < 6; index += 1) {
      h.daemon.ingest(
        message({
          author: { id: PEER_BOT, bot: true },
          mentions: [{ id: BOT }],
          content: `ping ${index}`,
        }),
      );
    }
    const counts = h.store.stateCounts("scribe");
    assert.equal(counts.queued, 3);
    assert.equal(counts.context, 3);
    assert.equal(h.store.counters().bot_loop_suppressed, 3);
  } finally {
    h.dispose();
  }
});

test("history and pending caps bound the ledger", () => {
  const h = harness(testConfig({ limits: { maxPendingPerEar: 4 } }));
  try {
    for (let index = 0; index < 8; index += 1) {
      h.daemon.ingest(message({ content: `ambient ${index}` }));
    }
    const counts = h.store.stateCounts("scribe");
    assert.equal(counts.context, 4);
    assert.equal(counts.expired + counts.dropped, 4);
  } finally {
    h.dispose();
  }
});

test("duplicates are ignored and survive a restart", () => {
  const h = harness();
  const path = join(h.directory, "restart.db");
  try {
    const first = harness(testConfig(), { path });
    const event = message({ author: { id: PRINCIPAL } });
    assert.equal(first.daemon.ingest(event), "inserted");
    first.daemon.shutdown();
    first.store.close();
    const second = harness(testConfig(), { path });
    assert.equal(second.daemon.ingest(event), "duplicate");
    second.daemon.shutdown();
    second.store.close();
  } finally {
    h.dispose();
  }
});

test("paused config keeps ingesting but pushes nothing", () => {
  const h = harness(testConfig({ paused: true }));
  try {
    const shim = h.attach("scribe");
    h.daemon.ingest(message({ author: { id: PRINCIPAL } }));
    h.timers.advance(60_000);
    assert.equal(shim.connection.events().length, 0);
    assert.equal(h.store.stateCounts("scribe").queued, 1);
    h.daemon.reloadConfig(testConfig());
    assert.equal(shim.connection.events().length, 1);
  } finally {
    h.dispose();
  }
});

test("invalid payloads are rejected, not thrown", () => {
  const h = harness();
  try {
    assert.equal(h.daemon.ingest({ id: 1 }), "rejected");
    assert.equal(h.daemon.ingest(null), "rejected");
    assert.equal(h.store.counters().rejected_invalid_payload, 2);
  } finally {
    h.dispose();
  }
});

test("chunkMessage prefers paragraph boundaries and never exceeds the limit", () => {
  const chunks = chunkMessage(
    `${"x".repeat(1_200)}\n\n${"y".repeat(1_200)}\n${"z".repeat(3_000)}`,
  );
  assert.ok(chunks.every((chunk) => chunk.length <= 2_000));
  assert.equal(chunks[0], "x".repeat(1_200));
  assert.equal(chunks.join("").replace(/\s/gu, "").length, 5_400);
  assert.deepEqual(chunkMessage("short"), ["short"]);
});

test("TCP clients must present the shared token", () => {
  const h = harness();
  try {
    const { MemoryConnection } = helpers;
    for (const token of [undefined, "wrong"]) {
      const connection = new MemoryConnection();
      const handlers = h.daemon.connect(connection, { requireToken: true });
      handlers.onMessage({
        type: "hello",
        role: "shim",
        protocol: 1,
        ear: "scribe",
        ...(token ? { token } : {}),
      });
      assert.equal(connection.closed, true);
      assert.equal(connection.received.length, 0);
    }
  } finally {
    h.dispose();
  }
});

test("reload revokes queued events for a channel removed from its ear", () => {
  const h = harness();
  try {
    const shim = h.attach("scribe");
    h.daemon.ingest(
      message({ author: { id: PRINCIPAL }, content: "for a revoked channel" }),
    );
    h.daemon.ingest(message({ channel_id: ROOM, content: "room stays bound" }));
    h.daemon.reloadConfig(
      testConfig({
        ears: {
          scribe: {
            attachCanary: false,
            dms: true,
            channels: { [ROOM]: "room" },
          },
        },
      }),
    );
    h.timers.advance(60_000);
    const events = shim.connection.events();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.meta.chat_id, ROOM);
    assert.doesNotMatch(events[0]?.content ?? "", /revoked channel/u);
    assert.equal(h.store.counters().routing_revoked, 1);
    assert.equal(h.store.unseen("scribe", CHANNEL, 10).length, 0);
  } finally {
    h.dispose();
  }
});

test("reload moving a channel to another ear never delivers its backlog to the old ear", () => {
  const h = harness();
  try {
    const old = h.attach("scribe");
    h.daemon.ingest(
      message({ author: { id: PRINCIPAL }, content: "moved channel backlog" }),
    );
    h.daemon.reloadConfig(
      testConfig({
        ears: {
          scribe: { attachCanary: false, channels: { [ROOM]: "room" } },
          other: { attachCanary: false, channels: { [CHANNEL]: "mentions" } },
        },
      }),
    );
    h.timers.advance(60_000);
    assert.equal(old.connection.events().length, 0);
    assert.equal(h.store.stateCounts("scribe").dropped, 1);
  } finally {
    h.dispose();
  }
});

test("reload turning a channel silent keeps its pending events inbox-only", () => {
  const h = harness();
  try {
    const shim = h.attach("scribe");
    h.daemon.ingest(
      message({ author: { id: PRINCIPAL }, content: "now silent" }),
    );
    h.daemon.reloadConfig(
      testConfig({
        ears: {
          scribe: { attachCanary: false, channels: { [CHANNEL]: "silent" } },
        },
      }),
    );
    h.timers.advance(60_000);
    assert.equal(shim.connection.events().length, 0);
    assert.equal(h.store.stateCounts("scribe").stored, 1);
  } finally {
    h.dispose();
  }
});

test("an ambient user cannot hold the session awake: mention wakes are budgeted per chat", () => {
  const h = harness(
    testConfig({
      ambientWake: { maxEvents: 2, windowMs: 60_000, cooldownMs: 60_000 },
    }),
  );
  try {
    h.attach("scribe");
    for (let index = 0; index < 5; index += 1) {
      h.daemon.ingest(
        message({ mentions: [{ id: BOT }], content: `wake up ${index}` }),
      );
    }
    h.daemon.ingest(
      message({ author: { id: PRINCIPAL }, content: "principal still wakes" }),
    );
    const counts = h.store.stateCounts("scribe");
    assert.equal(counts.queued, 3);
    assert.equal(counts.context, 3);
    assert.equal(h.store.counters().ambient_wake_suppressed, 3);
  } finally {
    h.dispose();
  }
});

// ---- review round 3 regressions -------------------------------------------

test("crash between insert and scheduling cannot strand a queued event", async () => {
  const h = harness();
  const path = join(h.directory, "crash.db");
  try {
    // Simulate an older build that crashed after the insert autocommitted.
    const before = harness(testConfig(), { path });
    const event = message({ author: { id: PRINCIPAL }, content: "stranded?" });
    before.store.insertEvent({
      messageId: event.id,
      ear: "scribe",
      chatId: CHANNEL,
      guildId: event.guild_id ?? null,
      authorId: PRINCIPAL,
      authorName: "figs",
      isBot: false,
      trust: "principal",
      wake: true,
      priority: true,
      content: event.content,
      timestamp: event.timestamp,
      replyTo: null,
      attachments: [],
      state: "queued",
    });
    assert.equal(before.store.nextDue("scribe"), undefined);
    before.daemon.shutdown();
    before.store.close();

    // Restart repairs it; the gateway replay is then a harmless duplicate.
    const after = harness(testConfig(), { path });
    assert.equal(after.daemon.ingest(event), "duplicate");
    const shim = after.attach("scribe");
    after.timers.advance(1_000);
    assert.match(shim.connection.events()[0]?.content ?? "", /stranded\?/u);
    after.daemon.shutdown();
    after.store.close();
  } finally {
    h.dispose();
  }
});

test("admission is one transaction: a failure mid-admission leaves no row behind", () => {
  const h = harness();
  try {
    const original = h.store.scheduleChat.bind(h.store);
    h.store.scheduleChat = () => {
      throw new Error("disk full");
    };
    assert.throws(
      () => h.daemon.ingest(message({ author: { id: PRINCIPAL } })),
      /disk full/u,
    );
    h.store.scheduleChat = original;
    assert.equal(
      h.store.stateCounts("scribe").queued,
      0,
      "rolled back, so the replay is admitted fresh",
    );
  } finally {
    h.dispose();
  }
});

test("tool IDs must be snowflakes, so crafted IDs cannot steer the REST path", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe");
    for (const [tool, args] of [
      [
        "react",
        {
          chat_id: CHANNEL,
          message_id: "../../../channels/999/messages/888",
          emoji: "👍",
        },
      ],
      [
        "edit_message",
        { chat_id: CHANNEL, message_id: "1/../../999", text: "x" },
      ],
      ["reply", { chat_id: `${CHANNEL}/../999`, text: "x" }],
      ["reply", { chat_id: CHANNEL, text: "x", reply_to: "1?x=1" }],
      ["fetch_messages", { chat_id: CHANNEL, before: "../1" }],
    ] as const) {
      const result = await h.call(shim, tool, args);
      assert.equal(result.ok, false, `${tool} ${JSON.stringify(args)}`);
    }
    assert.equal(h.rest.calls.length, 0);
  } finally {
    h.dispose();
  }
});

test("edit_message only edits messages frond-ear itself sent in that chat", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe");
    const foreign = await h.call(shim, "edit_message", {
      chat_id: CHANNEL,
      message_id: "123456789",
      text: "x",
    });
    assert.equal(foreign.ok, false);
    assert.match(foreign.text, /not sent by frond-ear/u);
    await h.call(shim, "reply", { chat_id: CHANNEL, text: "progress 1" });
    const sentId = h.rest.calls[0]?.messageId as string;
    const elsewhere = await h.call(shim, "edit_message", {
      chat_id: ROOM,
      message_id: sentId,
      text: "x",
    });
    assert.equal(elsewhere.ok, false, "an ID sent in another chat is refused");
    const own = await h.call(shim, "edit_message", {
      chat_id: CHANNEL,
      message_id: sentId,
      text: "progress 2",
    });
    assert.equal(own.ok, true);
  } finally {
    h.dispose();
  }
});

test("offered events a session never acts on are still bounded by the per-ear cap and retention", async () => {
  const h = harness(
    testConfig({ limits: { maxPendingPerEar: 3, retentionMs: 60_000 } }),
  );
  try {
    const shim = h.attach("scribe");
    for (let index = 0; index < 6; index += 1) {
      h.daemon.ingest(
        message({ author: { id: PRINCIPAL }, content: `unanswered ${index}` }),
      );
      h.timers.advance(1_000);
      const event = shim.connection.events().at(-1);
      await shim.send({ type: "offered", batchId: event?.batchId as number });
    }
    const counts = h.store.stateCounts("scribe");
    assert.ok(counts.offered <= 3, `offered ${counts.offered}`);
    assert.equal(counts.offered + counts.dropped, 6);
    h.clock.advance(120_000);
    h.store.prune(60_000);
    assert.equal(
      h.store.stateCounts("scribe").offered,
      0,
      "old offered rows are retained only for retentionMs",
    );
  } finally {
    h.dispose();
  }
});

test("an action for batch A never marks a later batch B seen, even mid-request", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe");
    const offer = async (content: string) => {
      h.daemon.ingest(message({ author: { id: PRINCIPAL }, content }));
      h.timers.advance(1_000);
      const event = shim.connection.events().at(-1);
      await shim.send({ type: "offered", batchId: event?.batchId as number });
      return event?.batchId as number;
    };
    const batchA = await offer("question A");

    // B arrives while the reply for A is still in flight.
    let release: () => void = () => undefined;
    const originalSend = h.rest.sendMessage.bind(h.rest);
    h.rest.sendMessage = async (...args) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return originalSend(...args);
    };
    const pending = shim.send({
      type: "call",
      id: 900,
      tool: "reply",
      args: { chat_id: CHANNEL, text: "answer A" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await offer("question B");
    release();
    await pending;
    await new Promise((resolve) => setImmediate(resolve));
    const unseen = h.store
      .unseen("scribe", CHANNEL, 10)
      .map((event) => event.content);
    assert.deepEqual(unseen, ["question B"]);

    // With an explicit batch_id, only that batch (and earlier) is acknowledged.
    h.rest.sendMessage = originalSend;
    const batchC = await offer("question C");
    assert.ok(batchC > batchA);
    await h.call(shim, "react", {
      chat_id: CHANNEL,
      message_id: "1",
      emoji: "👀",
      batch_id: batchA,
    });
    assert.deepEqual(
      h.store.unseen("scribe", CHANNEL, 10).map((event) => event.content),
      ["question B", "question C"],
    );
  } finally {
    h.dispose();
  }
});
