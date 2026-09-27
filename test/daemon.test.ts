import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { chunkMessage, RestError } from "../src/rest.ts";
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
      message({
        author: { id: PRINCIPAL },
        mentions: [{ id: BOT }],
        content: "while you were away",
      }),
    );
    h.daemon.ingest(
      message({
        channel_id: SILENT,
        author: { id: PRINCIPAL },
        mentions: [{ id: BOT }],
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
      message({
        author: { id: PRINCIPAL },
        mentions: [{ id: BOT }],
        content: "important",
      }),
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

test("re-entry by the same session detaches its old shim; offered-but-unseen work becomes one digest, not a replay", async () => {
  const h = harness();
  try {
    const first = h.attach("scribe", { sessionId: "session-a" });
    h.daemon.ingest(
      message({
        author: { id: PRINCIPAL },
        mentions: [{ id: BOT }],
        content: "first secret plan",
      }),
    );
    h.timers.advance(1_000);
    const batch = first.connection.events()[0];
    await first.send({ type: "offered", batchId: batch?.batchId as number });

    // The same session coming back (resume, crash, /mcp reconnect): a new shim.
    const second = h.attach("scribe", { sessionId: "session-a" });
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
    assert.equal(stale.ok, false);
    assert.match(stale.text, /^refused: this connection was superseded/u);
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

test("delivery: an unacked canary is reported as a deaf session, with the relaunch hint", async () => {
  const config = testConfig({
    ears: {
      scribe: { attachCanary: true, channels: { [CHANNEL]: "mentions" } },
    },
  });
  const h = harness(config, { nonce: "c0ffee" });
  try {
    const shim = h.attach("scribe");
    const status = () =>
      h.daemon.status("scribe") as {
        ears: Array<{ delivery: string; hint?: string }>;
      };
    assert.equal(status().ears[0]?.delivery, "pending");

    h.clock.advance(2 * 60 * 1_000);
    assert.equal(status().ears[0]?.delivery, "unconfirmed");
    assert.match(
      status().ears[0]?.hint ?? "",
      /--dangerously-load-development-channels server:frond-ear/u,
    );
    const deaf = await h.call(shim, "inbox", { chat_id: CHANNEL });
    assert.match(deaf.text, /⚠️ frond-ear: this session never acked/u);

    assert.equal((await h.call(shim, "ack", { nonce: "c0ffee" })).ok, true);
    assert.equal(status().ears[0]?.delivery, "confirmed");
    const heard = await h.call(shim, "inbox", { chat_id: CHANNEL });
    assert.doesNotMatch(heard.text, /⚠️ frond-ear/u);
  } finally {
    h.dispose();
  }
});

test("tap: mirrors exactly the batch pushed to the attached session, at the same moment", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe");
    const tap = h.attach("scribe", { role: "tap" });
    h.daemon.ingest(message({ content: "context one" }));
    h.daemon.ingest(
      message({
        author: { id: AMBIENT, username: "ana" },
        content: `<@${BOT}> are you there?`,
      }),
    );
    h.timers.advance(999);
    assert.equal(
      tap.connection.events().length,
      0,
      "the tap never runs ahead of the push",
    );
    h.timers.advance(1);
    const [pushed] = shim.connection.events();
    const [tapped] = tap.connection.events();
    assert.ok(pushed && pushed.batchId !== null);
    assert.deepEqual(tapped, pushed);
  } finally {
    h.dispose();
  }
});

test("tap: with or without a tap, attachment, canary and confirmed batches are identical", async () => {
  const run = (tap: "none" | "before" | "after") => {
    const config = testConfig({
      ears: {
        scribe: { attachCanary: true, channels: { [CHANNEL]: "mentions" } },
      },
    });
    const h = harness(config, { nonce: "c0ffee" });
    try {
      if (tap === "before") {
        h.attach("scribe", { role: "tap" });
      }
      const shim = h.attach("scribe", { sessionId: "session-1" });
      if (tap === "after") {
        h.attach("scribe", { role: "tap" });
      }
      h.daemon.ingest(message({ content: `<@${BOT}> ping` }));
      h.timers.advance(5_000);
      for (const event of shim.connection.events()) {
        if (event.batchId !== null) {
          void shim.send({ type: "offered", batchId: event.batchId });
        }
      }
      const status = h.daemon.status("scribe") as {
        ears: Array<Record<string, unknown>>;
      };
      const { taps: _taps, ...ear } = status.ears[0] ?? {};
      return {
        ear,
        counts: h.store.stateCounts("scribe"),
        pushed: shim.connection.events().map((event) => event.meta.kind),
      };
    } finally {
      h.dispose();
    }
  };
  const baseline = run("none");
  assert.deepEqual(run("before"), baseline);
  assert.deepEqual(run("after"), baseline);
});

test("tap: every message a tap can send leaves ear state untouched", async () => {
  const config = testConfig({
    ears: {
      scribe: { attachCanary: true, channels: { [CHANNEL]: "mentions" } },
    },
  });
  const h = harness(config, { nonce: "c0ffee" });
  try {
    h.attach("scribe", { sessionId: "session-1" });
    const tap = h.attach("scribe", { role: "tap" });
    h.daemon.ingest(message({ content: `<@${BOT}> ping` }));
    h.timers.advance(5_000);
    const [event] = tap.connection.events();
    assert.ok(event && event.batchId !== null);
    const snapshot = () => ({
      status: h.daemon.status("scribe"),
      counts: h.store.stateCounts("scribe"),
    });
    const before = snapshot();
    await tap.send({ type: "offered", batchId: event.batchId });
    await tap.send({ type: "session", sessionId: "intruder" });
    await h.call(tap, "ack", { chat_id: CHANNEL, batch_id: event.batchId });
    await h.call(tap, "ack", { nonce: "c0ffee" }).catch(() => undefined);
    await h
      .call(tap, "set_attention", { mode: "silent" })
      .catch(() => undefined);
    await h.call(tap, "inbox", { chat_id: CHANNEL });
    assert.deepEqual(snapshot(), before);
  } finally {
    h.dispose();
  }
});

test("tap: a tap cannot re-hello into a shim", async () => {
  const h = harness();
  try {
    const tap = h.attach("scribe", { role: "tap" });
    await tap.send({ type: "hello", role: "shim", protocol: 1, ear: "scribe" });
    assert.equal(tap.connection.closed, true);
    const status = h.daemon.status("scribe") as {
      ears: Array<{ attached: boolean }>;
    };
    assert.equal(status.ears[0]?.attached, false);
  } finally {
    h.dispose();
  }
});

test("tap: an unknown ear is refused, and a closed tap stops receiving", async () => {
  const h = harness();
  try {
    const stray = h.attach("nope", { role: "tap" });
    const [welcome] = stray.connection.received;
    assert.equal(welcome?.type, "welcome");
    assert.match(
      (welcome as { error?: string }).error ?? "",
      /unknown ear nope/u,
    );
    assert.equal(stray.connection.closed, true);

    const shim = h.attach("scribe");
    const tap = h.attach("scribe", { role: "tap" });
    tap.close();
    h.daemon.ingest(message({ content: `<@${BOT}> after close` }));
    h.timers.advance(5_000);
    assert.equal(shim.connection.events().length, 1);
    assert.equal(tap.connection.events().length, 0);
  } finally {
    h.dispose();
  }
});

test("reply chunks long text, quotes only the first chunk, and marks the chat seen", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe");
    h.daemon.ingest(
      message({
        author: { id: PRINCIPAL },
        mentions: [{ id: BOT }],
        content: "write me an essay",
      }),
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
      mentions: [{ id: BOT }],
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
      message({
        author: { id: PRINCIPAL },
        mentions: [{ id: BOT }],
        content: "for scribe",
      }),
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
    const event = message({
      author: { id: PRINCIPAL },
      mentions: [{ id: BOT }],
    });
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
    h.daemon.ingest(
      message({ author: { id: PRINCIPAL }, mentions: [{ id: BOT }] }),
    );
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
      message({
        author: { id: PRINCIPAL },
        mentions: [{ id: BOT }],
        content: "for a revoked channel",
      }),
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
      message({
        author: { id: PRINCIPAL },
        mentions: [{ id: BOT }],
        content: "moved channel backlog",
      }),
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
      message({
        author: { id: PRINCIPAL },
        mentions: [{ id: BOT }],
        content: "now silent",
      }),
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
      message({
        author: { id: PRINCIPAL },
        mentions: [{ id: BOT }],
        content: "principal still wakes",
      }),
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
    const event = message({
      author: { id: PRINCIPAL },
      mentions: [{ id: BOT }],
      content: "stranded?",
    });
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
      () =>
        h.daemon.ingest(
          message({ author: { id: PRINCIPAL }, mentions: [{ id: BOT }] }),
        ),
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
        message({
          author: { id: PRINCIPAL },
          mentions: [{ id: BOT }],
          content: `unanswered ${index}`,
        }),
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
      h.daemon.ingest(
        message({
          author: { id: PRINCIPAL },
          mentions: [{ id: BOT }],
          content,
        }),
      );
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

// ---- session-chosen attention (#17) ----------------------------------------

test("a session's silence is total: principal mentions and DMs are held, not pushed", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe");
    const set = await h.call(shim, "set_attention", { mode: "silent" });
    assert.equal(set.ok, true, set.text);
    h.daemon.ingest(
      message({
        author: { id: PRINCIPAL },
        mentions: [{ id: BOT }],
        content: "figs, delightful distraction",
      }),
    );
    const { guild_id: _unused, ...dm } = message({
      channel_id: DM,
      author: { id: PRINCIPAL },
      content: "dm too",
    });
    h.daemon.ingest(dm);
    h.timers.advance(60_000);
    assert.equal(
      shim.connection.events().length,
      0,
      "nothing pierces a chosen silence",
    );
    assert.equal(h.store.stateCounts("scribe").stored, 2);
    const inbox = await h.call(shim, "inbox", {});
    assert.match(
      inbox.text,
      /delightful distraction[\s\S]*dm too/u,
      "held messages stay readable",
    );

    // Lifting it is the session's call; later mentions wake again.
    await h.call(shim, "set_attention", { mode: "configured" });
    h.daemon.ingest(
      message({
        author: { id: PRINCIPAL },
        mentions: [{ id: BOT }],
        content: "after",
      }),
    );
    h.timers.advance(2_000);
    assert.equal(shim.connection.events().length, 1);
  } finally {
    h.dispose();
  }
});

test("set_attention is reduce-only: the operator's mode is a ceiling it cannot widen", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe");
    const result = await h.call(shim, "set_attention", {
      chat_id: CHANNEL,
      mode: "room",
    });
    assert.equal(result.ok, true);
    const view = JSON.parse(result.text) as {
      chats: Record<string, { ceiling: string; effective: string }>;
      note?: string;
    };
    assert.deepEqual(view.chats[CHANNEL], {
      ceiling: "mentions",
      effective: "mentions",
    });
    assert.match(view.note ?? "", /exceeds the operator's ceiling/u);
    h.daemon.ingest(message({ content: "ambient chatter" }));
    assert.equal(
      h.store.stateCounts("scribe").context,
      1,
      "still mentions-only",
    );
  } finally {
    h.dispose();
  }
});

test("narrowing a room to mentions demotes waiting chatter; an addressed message still wakes", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe");
    h.daemon.ingest(message({ channel_id: ROOM, content: "chatter one" }));
    h.daemon.ingest(message({ channel_id: ROOM, content: "chatter two" }));
    const result = await h.call(shim, "set_attention", {
      chat_id: ROOM,
      mode: "mentions",
    });
    assert.equal(
      (JSON.parse(result.text) as { narrowedPending: number }).narrowedPending,
      2,
    );
    h.timers.advance(60_000);
    assert.equal(shim.connection.events().length, 0);
    h.daemon.ingest(
      message({
        channel_id: ROOM,
        mentions: [{ id: BOT }],
        content: "hey scribe",
      }),
    );
    h.timers.advance(2_000);
    const [event] = shim.connection.events();
    assert.match(
      event?.content ?? "",
      /chatter one[\s\S]*hey scribe/u,
      "held chatter rides along as context",
    );
  } finally {
    h.dispose();
  }
});

test("an optional ttl lets a chosen quiet lapse on its own; without it the choice stands", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe");
    await h.call(shim, "set_attention", {
      chat_id: CHANNEL,
      mode: "silent",
      ttl_seconds: 60,
    });
    await h.call(shim, "set_attention", { chat_id: ROOM, mode: "silent" });
    h.clock.advance(61_000);
    h.daemon.ingest(
      message({
        author: { id: PRINCIPAL },
        mentions: [{ id: BOT }],
        content: "ttl lapsed",
      }),
    );
    h.daemon.ingest(
      message({
        channel_id: ROOM,
        mentions: [{ id: BOT }],
        content: "still quiet",
      }),
    );
    h.timers.advance(2_000);
    const contents = shim.connection
      .events()
      .map((event) => event.content)
      .join("\n");
    assert.match(contents, /ttl lapsed/u);
    assert.doesNotMatch(contents, /still quiet/u);
    const status = h.daemon.status("scribe") as {
      ears: Array<{
        attention: {
          overrides: Array<{
            scope: string;
            mode: string;
            expiresAt: number | null;
          }>;
        };
      }>;
    };
    assert.deepEqual(status.ears[0]?.attention.overrides, [
      { scope: ROOM, mode: "silent", expiresAt: null },
    ]);
  } finally {
    h.dispose();
  }
});

test("only the attached session sets its attention", async () => {
  const h = harness();
  try {
    h.attach("scribe");
    const other = h.attach();
    const result = await h.call(other, "set_attention", { mode: "silent" });
    assert.equal(result.ok, false);
    assert.match(result.text, /only the session attached/u);
  } finally {
    h.dispose();
  }
});

test("shutdown drains in-flight tool calls before the store can close", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe");
    h.daemon.ingest(
      message({
        author: { id: PRINCIPAL },
        mentions: [{ id: BOT }],
        content: "reply before you go",
      }),
    );
    h.timers.advance(1_000);
    await shim.send({
      type: "offered",
      batchId: shim.connection.events()[0]?.batchId as number,
    });

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
      id: 700,
      tool: "reply",
      args: { chat_id: CHANNEL, text: "on my way out" },
    });
    await new Promise((resolve) => setImmediate(resolve));

    // SIGTERM arrives while Discord is still answering.
    let stopped = false;
    const stopping = h.daemon.shutdown().then((result) => {
      stopped = true;
      return result;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false, "shutdown waits for the in-flight reply");

    // New calls are refused without side effects while draining.
    const refused = await h.call(shim, "reply", {
      chat_id: CHANNEL,
      text: "late",
    });
    assert.equal(refused.ok, false);
    assert.match(refused.text, /shutting down; nothing was sent/u);

    release();
    await pending;
    assert.deepEqual(await stopping, { drained: true });
    // The side effect and its receipt were both recorded before any close.
    const sent = h.rest.calls.filter((call) => call.method === "send");
    assert.equal(sent.length, 1);
    assert.equal(h.store.sentIn(sent[0]?.messageId as string, CHANNEL), true);
    assert.equal(h.store.stateCounts("scribe").seen, 1);
    assert.equal(
      shim.connection.results().find((item) => item.id === 700)?.ok,
      true,
    );
  } finally {
    h.dispose();
  }
});

// ---- chaos-harness regressions (tools/chaos, R-FE-* rows) --------------------

test("a connection closing after shutdown never touches the closed store (R-FE-SHUTDOWN-DRAIN)", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe");
    await h.daemon.shutdown();
    h.store.close();
    // The socket's close event arrives after the store was closed.
    assert.doesNotThrow(() => shim.close());
  } finally {
    h.daemon.shutdown();
    rmSync(h.directory, { recursive: true, force: true });
  }
});

test("a lost Discord response is ambiguous, and an identical retry posts once (R-FE-DROP-AFTER-ACCEPT)", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe");
    const discordSend = h.rest.sendMessage.bind(h.rest);
    let dropNext = true;
    h.rest.sendMessage = async (...args) => {
      const sent = await discordSend(...args); // Discord accepted it...
      if (dropNext) {
        dropNext = false;
        throw new TypeError("fetch failed"); // ...but the response was lost
      }
      return sent;
    };
    const first = await h.call(shim, "reply", {
      chat_id: CHANNEL,
      text: "pong",
    });
    assert.equal(first.ok, false);
    assert.match(first.text, /may already have been posted/u);
    const status = h.daemon.status() as { ambiguousSends: unknown[] };
    assert.equal(status.ambiguousSends.length, 1);
    const retry = await h.call(shim, "reply", {
      chat_id: CHANNEL,
      text: "pong",
    });
    assert.equal(retry.ok, true, retry.text);
    const sends = h.rest.calls.filter((call) => call.method === "send");
    assert.equal(sends.length, 1, "Discord received exactly one message");
    assert.equal(
      (h.daemon.status() as { ambiguousSends: unknown[] }).ambiguousSends
        .length,
      0,
    );
    assert.equal(h.store.sentIn(sends[0]?.messageId as string, CHANNEL), true);
  } finally {
    h.dispose();
  }
});

test("a send killed mid-flight is surfaced after restart and an identical retry is de-duplicated (R-FE-KILL-MID-SEND)", async () => {
  const h = harness();
  const path = join(h.directory, "kill.db");
  try {
    const before = harness(testConfig(), { path });
    const discordSend = before.rest.sendMessage.bind(before.rest);
    before.rest.sendMessage = async (...args) => {
      await discordSend(...args); // Discord accepts the post...
      return new Promise<never>(() => undefined); // ...and the daemon dies before hearing back
    };
    const shimBefore = before.attach("scribe");
    void shimBefore.send({
      type: "call",
      id: 1,
      tool: "reply",
      args: { chat_id: CHANNEL, text: "status: all green" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    // SIGKILL: no shutdown, no store close, nothing else runs.

    const after = harness(testConfig(), { path });
    after.rest.sendMessage = discordSend; // same Discord on the other side
    const shim = after.attach("scribe");
    const notice = shim.connection
      .events()
      .find((event) => event.meta.kind === "send_check");
    assert.ok(notice, "the reattached session is told the send is unconfirmed");
    assert.match(notice.content, /status: all green/u);
    const retry = await after.call(shim, "reply", {
      chat_id: CHANNEL,
      text: "status: all green",
    });
    assert.equal(retry.ok, true, retry.text);
    const sends = before.rest.calls.filter((call) => call.method === "send");
    assert.equal(sends.length, 1, "no duplicate Discord message");
    assert.equal(
      after.store.sentIn(sends[0]?.messageId as string, CHANNEL),
      true,
      "the post is receipted",
    );
    after.daemon.shutdown();
    after.store.close();
  } finally {
    h.dispose();
  }
});

test("a definitive Discord rejection is not ambiguous, and a deliberate repeat after success still posts", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe");
    const discordSend = h.rest.sendMessage.bind(h.rest);
    let reject = true;
    h.rest.sendMessage = async (...args) => {
      if (reject) {
        reject = false;
        throw new RestError(403, 50013, "Missing Permissions");
      }
      return discordSend(...args);
    };
    assert.equal(
      (await h.call(shim, "reply", { chat_id: CHANNEL, text: "ok" })).ok,
      false,
    );
    assert.equal(
      (h.daemon.status() as { ambiguousSends: unknown[] }).ambiguousSends
        .length,
      0,
    );
    assert.equal(
      (await h.call(shim, "reply", { chat_id: CHANNEL, text: "ok" })).ok,
      true,
    );
    assert.equal(
      (await h.call(shim, "reply", { chat_id: CHANNEL, text: "ok" })).ok,
      true,
    );
    assert.equal(
      h.rest.calls.filter((call) => call.method === "send").length,
      2,
      "two confirmed, deliberate sends are two messages",
    );
  } finally {
    h.dispose();
  }
});

// ---- Rune follow-up (5d5bbe1) ------------------------------------------------

test("startup reconciles persisted queues against a config changed while the daemon was down", () => {
  const h = harness();
  const path = join(h.directory, "restart-silent.db");
  try {
    const before = harness(testConfig(), { path });
    before.daemon.ingest(
      message({
        author: { id: PRINCIPAL },
        mentions: [{ id: BOT }],
        content: "must stay silent after restart",
      }),
    );
    before.daemon.shutdown();
    before.store.close();

    const after = harness(
      testConfig({
        ears: {
          scribe: { attachCanary: false, channels: { [CHANNEL]: "silent" } },
        },
      }),
      { path },
    );
    const shim = after.attach("scribe");
    after.timers.advance(60_000);
    assert.equal(
      shim.connection.events().length,
      0,
      "silent channels never push, even after a restart",
    );
    assert.equal(after.store.stateCounts("scribe").stored, 1);
    after.daemon.shutdown();
    after.store.close();
  } finally {
    h.dispose();
  }
});

test("removing a principal revokes their DM: queued DMs are dropped and outbound is refused", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe");
    const { guild_id: _unused, ...dm } = message({
      channel_id: DM,
      author: { id: PRINCIPAL },
      content: "private note",
    });
    h.daemon.ingest(dm);
    h.daemon.reloadConfig(testConfig({ principals: [] }));
    h.timers.advance(60_000);
    assert.equal(shim.connection.events().length, 0);
    assert.equal(h.store.stateCounts("scribe").dropped, 1);
    const reply = await h.call(shim, "reply", {
      chat_id: DM,
      text: "still there?",
    });
    assert.equal(reply.ok, false);
    assert.equal(h.rest.calls.length, 0);
  } finally {
    h.dispose();
  }
});

test("only the attached session can confirm a batch; a stale confirm cannot hide an undelivered event", async () => {
  const h = harness();
  try {
    const old = h.attach("scribe");
    const current = h.attach("scribe");
    h.daemon.ingest(
      message({
        author: { id: PRINCIPAL },
        mentions: [{ id: BOT }],
        content: "for the current shim",
      }),
    );
    h.timers.advance(1_000);
    const batchId = current.connection.events().at(-1)?.batchId as number;
    await old.send({ type: "offered", batchId }); // superseded shim tries to confirm
    current.close(); // the real receiver drops before confirming
    const next = h.attach("scribe");
    const redelivered = next.connection
      .events()
      .find((event) => event.meta.kind === "mention");
    assert.ok(
      redelivered,
      "the unconfirmed event is redelivered, not reduced to a digest",
    );
    assert.match(redelivered.content, /for the current shim/u);
  } finally {
    h.dispose();
  }
});

test("a reload that lowers retention prunes immediately against the new policy", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe");
    h.daemon.ingest(
      message({
        author: { id: PRINCIPAL },
        mentions: [{ id: BOT }],
        content: "old news",
      }),
    );
    h.timers.advance(1_000);
    await shim.send({
      type: "offered",
      batchId: shim.connection.events().at(-1)?.batchId as number,
    });
    await h.call(shim, "ack", {});
    assert.equal(h.store.stateCounts("scribe").seen, 1);
    h.clock.advance(10 * 60_000);
    h.daemon.reloadConfig(testConfig({ limits: { retentionMs: 60_000 } }));
    assert.equal(
      h.store.stateCounts("scribe").seen,
      0,
      "pruned under the reloaded retention",
    );
  } finally {
    h.dispose();
  }
});
