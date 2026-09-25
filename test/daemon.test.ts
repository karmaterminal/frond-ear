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
