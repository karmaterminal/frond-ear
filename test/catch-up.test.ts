// The read-back after a fresh Gateway session (#70, 🌻's follow-up to #72). When Discord has
// dropped the daemon's session, it replays nothing sent before the new one, so each chat the ear
// has heard is read back from its last-seen anchor: one capped history page, deduplicated by
// the ledger's unique message id, with any gap left over reported to the session.
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { parseConfig } from "../src/config.ts";
import { DiscordGateway } from "../src/gateway.ts";
import { StructuredLogger } from "../src/logger.ts";
import { renderCatchUp } from "../src/render.ts";
import { RestError } from "../src/rest.ts";
import { EventStore } from "../src/store.ts";
import type { DiscordMessage } from "../src/types.ts";
import {
  AMBIENT,
  BOT,
  CHANNEL,
  FakeClock,
  FakeSocket,
  GUILD,
  PRINCIPAL,
  ROOM,
  SILENT,
  harness,
  message,
  testConfig,
} from "./helpers.ts";

/** Lets the read-back's awaits run (RecordingRest answers at once). */
async function settled(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** History as Discord's REST API returns it: newest first, at most `limit`, no guild_id. */
function historyOf(
  channels: Record<string, DiscordMessage[]>,
): (channelId: string, limit: number) => DiscordMessage[] {
  return (channelId, limit) =>
    [...(channels[channelId] ?? [])]
      .reverse()
      .slice(0, limit)
      .map((item) => {
        const copy = { ...item };
        delete copy.guild_id;
        return copy;
      });
}

function mention(content: string, author = PRINCIPAL): DiscordMessage {
  return message({
    author: { id: author, username: author === PRINCIPAL ? "figs" : "ana" },
    content: `<@${BOT}> ${content}`,
    mentions: [{ id: BOT }],
  });
}

function kinds(events: Array<{ meta: Record<string, string> }>): string[] {
  return events.map((event) => event.meta.kind ?? "");
}

/** The daemon's log lines that say a session was told of a read-back. */
function told(logs: string[]): Array<Record<string, unknown>> {
  return logs
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.event === "ear.catch_up_told")
    .map(({ ear, chats, skipped }) => ({ ear, chats, skipped }));
}

test("a fresh Gateway session reads back what was sent while the old one had expired, once (gap)", async () => {
  const before = mention("before the outage");
  const chatter = message({ content: "chatter while the ear was away" });
  const missed = mention("sent while the ear was away");
  const channel = [before];
  const h = harness(testConfig(), {
    history: historyOf({ [CHANNEL]: channel }),
  });
  try {
    const shim = h.attach("scribe");
    assert.equal(h.daemon.ingest(before), "inserted");
    h.timers.advance(1_000);
    assert.deepEqual(kinds(shim.connection.events()), ["mention"]);

    // Discord drops the session while the daemon is down; two messages are sent meanwhile.
    channel.push(chatter, missed);
    h.daemon.gatewayReady();
    await settled();
    assert.deepEqual(
      h.rest.calls.map((call) => [call.method, call.channelId]),
      [["fetch", CHANNEL]],
    );
    // The notice comes first, so the session knows the batch after it is late.
    const notice = shim.connection.events()[1];
    assert.equal(notice?.meta.kind, "catch_up");
    assert.equal(notice?.meta.count, "2");
    assert.equal(notice?.batchId, null);
    assert.match(
      notice?.content ?? "",
      new RegExp(`chat ${CHANNEL}: 2 messages read back\\.`, "u"),
    );
    h.timers.advance(1_000);
    const batch = shim.connection.events()[2];
    assert.equal(batch?.meta.kind, "mention");
    assert.equal(batch?.meta.message_id, missed.id);
    assert.equal(
      batch?.meta.guild_id,
      GUILD,
      "read back as a channel message, not a DM",
    );
    assert.match(
      batch?.content ?? "",
      /chatter while the ear was away[\s\S]*New for you:[\s\S]*sent while the ear was away/u,
    );
    assert.doesNotMatch(batch?.content ?? "", /before the outage/u);
    assert.deepEqual(told(h.logs), [{ ear: "scribe", chats: 1, skipped: 0 }]);

    // Another fresh session with nothing new: the anchor has moved, nothing is read twice.
    h.daemon.gatewayReady();
    await settled();
    h.timers.advance(60_000);
    assert.equal(shim.connection.events().length, 3);
    assert.equal(h.store.counters().catch_up_read, 2);
  } finally {
    h.dispose();
  }
});

test("through the Gateway: READY owes the read-back before the new session's first message moves the anchor", async () => {
  const heard = mention("last heard");
  const gap = mention("sent while the session was gone");
  const live = mention("first on the new session");
  const channel = [heard];
  const h = harness(testConfig(), {
    history: historyOf({ [CHANNEL]: channel }),
  });
  const sockets: FakeSocket[] = [];
  const gateway = new DiscordGateway({
    token: "fixture-token",
    gatewayUrl: "wss://gateway.example",
    store: h.store,
    logger: new StructuredLogger(() => undefined),
    onMessage: (event) => {
      h.daemon.ingest(event);
    },
    onReady: () => h.daemon.gatewayReady(),
    onResumed: () => h.daemon.gatewayResumed(),
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    setTimeout: (() =>
      ({}) as NodeJS.Timeout) as unknown as typeof globalThis.setTimeout,
    clearTimeout: (() => undefined) as typeof globalThis.clearTimeout,
    random: () => 0,
  });
  try {
    gateway.start();
    h.daemon.ingest(heard);
    channel.push(gap, live);
    sockets[0]?.emitMessage({
      op: 0,
      t: "READY",
      s: 1,
      d: { session_id: "fresh", resume_gateway_url: "wss://resume.example" },
    });
    sockets[0]?.emitMessage({ op: 0, t: "MESSAGE_CREATE", s: 2, d: live });
    await settled();
    assert.deepEqual(
      h.store.unseen("scribe", CHANNEL, 10).map((event) => event.messageId),
      [heard.id, gap.id, live.id],
    );
  } finally {
    gateway.stop();
    h.dispose();
  }
});

test("a resumed session reads nothing back: Discord replays what was missed", async () => {
  const h = harness(testConfig(), {
    history: historyOf({ [CHANNEL]: [mention("never fetched")] }),
  });
  try {
    h.daemon.ingest(mention("heard live"));
    h.daemon.gatewayResumed();
    await settled();
    assert.equal(h.rest.calls.length, 0);
    assert.deepEqual((h.daemon.status() as { catchUp: object }).catchUp, {
      owed: 0,
      running: false,
      last: null,
    });
  } finally {
    h.dispose();
  }
});

test("a read-back stops at its cap and tells the session where the rest is", async () => {
  const anchor = mention("last heard");
  const gap = Array.from({ length: 5 }, (_, index) =>
    message({ content: `gap ${index}` }),
  );
  const h = harness(testConfig({ limits: { catchUpMessages: 3 } }), {
    history: historyOf({ [CHANNEL]: [anchor, ...gap] }),
  });
  try {
    const shim = h.attach("scribe");
    h.daemon.ingest(anchor);
    h.daemon.gatewayReady();
    await settled();
    const [first, second, third] = gap.slice(2);
    assert.ok(first && second && third);
    const notice = shim.connection
      .events()
      .find((event) => event.meta.kind === "catch_up");
    assert.match(
      notice?.content ?? "",
      new RegExp(
        `chat ${CHANNEL}: 3 messages read back, but older ones may be missing, back to message ${anchor.id} \\(the last one heard before\\): fetch_messages with this chat_id and before=${first.id} reads them\\.`,
        "u",
      ),
    );
    const held = h.store.unseen("scribe", CHANNEL, 50).map((e) => e.content);
    assert.deepEqual(held, [anchor.content, "gap 2", "gap 3", "gap 4"]);
    const status = h.daemon.status() as {
      catchUp: { last: { chats: object[] } };
    };
    assert.deepEqual(status.catchUp.last.chats, [
      {
        ear: "scribe",
        chatId: CHANNEL,
        read: 3,
        missing: { after: anchor.id, before: first.id },
      },
    ]);
    assert.equal(h.store.counters().catch_up_truncated, 1);
  } finally {
    h.dispose();
  }
});

test("a message heard live during the read-back is held once, and batches keep Discord's order", async () => {
  const anchor = mention("last heard");
  const early = message({ content: "early, read back" });
  const late = message({ content: "later, read back" });
  const live = message({ content: "newest, heard live" });
  const channel = [anchor, early, late];
  let h: ReturnType<typeof harness> | undefined;
  const history = historyOf({ [CHANNEL]: channel });
  h = harness(
    testConfig({
      defaults: {
        quietWindowMs: 4_000,
        maxDelayMs: 20_000,
        priorityQuietMs: 1_000,
        historyLimit: 2,
      },
    }),
    {
      history: (channelId, limit) => {
        // The live message arrives while the history request is in flight, and is in the page.
        channel.push(live);
        assert.equal(h?.daemon.ingest(live), "inserted");
        return history(channelId, limit);
      },
    },
  );
  try {
    const shim = h.attach("scribe");
    h.daemon.ingest(anchor);
    h.timers.advance(1_000);
    h.daemon.gatewayReady();
    await settled();
    assert.equal(h.store.counters().duplicates, 1, "heard live and read back");
    // historyLimit keeps the newest context by Discord's clock, not by admission: the live
    // message was admitted first but is the newest, so the earliest read-back one expires.
    const byState = (state: string): string[] =>
      h!.store
        .recent(CHANNEL, 50)
        .filter((event) => event.state === state)
        .map((event) => event.content)
        .sort();
    assert.deepEqual(byState("context"), [
      "later, read back",
      "newest, heard live",
    ]);
    assert.deepEqual(byState("expired"), ["early, read back"]);
    h.daemon.ingest(mention("anyone there?"));
    h.timers.advance(1_000);
    const batch = shim.connection.events().at(-1);
    assert.match(
      batch?.content ?? "",
      /later, read back[\s\S]*newest, heard live[\s\S]*New for you:[\s\S]*anyone there\?/u,
    );
  } finally {
    h.dispose();
  }
});

test("a read-back left unfinished by a stop survives the restart and finishes after a resume", async () => {
  const outer = harness();
  const path = join(outer.directory, "restart.db");
  const heard = mention("last heard");
  const missed = mention("sent while the ear was away");
  const channel = [heard];
  const history = historyOf({ [CHANNEL]: channel });
  try {
    const first = harness(testConfig(), { path, history });
    first.daemon.ingest(heard);
    channel.push(missed);
    first.daemon.gatewayReady();
    // The daemon stops before the history page comes back.
    void first.daemon.shutdown();
    await settled();
    first.store.close();

    const second = harness(testConfig(), { path, history });
    try {
      const shim = second.attach("scribe");
      assert.equal(
        (second.daemon.status() as { catchUp: { owed: number } }).catchUp.owed,
        1,
        "the anchor's debt is durable",
      );
      second.daemon.gatewayResumed();
      await settled();
      second.timers.advance(1_000);
      assert.deepEqual(kinds(shim.connection.events()), [
        "catch_up",
        "mention",
      ]);
      assert.equal(shim.connection.events()[1]?.meta.message_id, missed.id);
    } finally {
      second.dispose();
    }
  } finally {
    outer.dispose();
  }
});

test("a fresh session during a read-back keeps the chat owed until a read after it", async () => {
  const anchor = mention("last heard");
  const channel = [anchor];
  const history = historyOf({ [CHANNEL]: channel });
  let reads = 0;
  let h: ReturnType<typeof harness> | undefined;
  h = harness(testConfig(), {
    history: (channelId, limit) => {
      reads += 1;
      if (reads === 1) {
        // The new session drops while this page is in flight, and the next one starts
        // after one more message: the first page cannot hold it.
        const page = history(channelId, limit);
        channel.push(mention("between two sessions"));
        h?.daemon.gatewayReady();
        return page;
      }
      return history(channelId, limit);
    },
  });
  try {
    h.daemon.ingest(anchor);
    h.daemon.gatewayReady();
    await settled();
    assert.equal(reads, 2, "read again after the newer session began");
    assert.deepEqual(
      h.store.unseen("scribe", CHANNEL, 50).map((event) => event.content),
      [`<@${BOT}> last heard`, `<@${BOT}> between two sessions`],
    );
    assert.equal(
      (h.daemon.status() as { catchUp: { owed: number } }).catchUp.owed,
      0,
    );
  } finally {
    h.dispose();
  }
});

test("only chats the ear still hears are read back, the most recently active first, and the rest are named", async () => {
  // Message ids grow with time: ROOM was active last, then SILENT, then CHANNEL.
  const quiet = mention("channel, last heard");
  const silent = message({ channel_id: SILENT, content: "silent, last heard" });
  const room = message({ channel_id: ROOM, content: "room, last heard" });
  const h = harness(testConfig({ limits: { catchUpChats: 1 } }));
  try {
    h.daemon.ingest(quiet);
    h.daemon.ingest(silent);
    h.daemon.ingest(room);
    // SILENT is unbound while the daemon is down.
    h.daemon.reloadConfig(
      parseConfig({
        botUserId: BOT,
        principals: [PRINCIPAL],
        ears: {
          scribe: {
            attachCanary: false,
            channels: { [CHANNEL]: "mentions", [ROOM]: "room" },
          },
        },
        limits: { catchUpChats: 1 },
      }),
    );
    h.daemon.gatewayReady();
    await settled();
    assert.deepEqual(
      h.rest.calls.map((call) => call.channelId),
      [ROOM],
    );
    const shim = h.attach("scribe");
    const notice = shim.connection
      .events()
      .find((event) => event.meta.kind === "catch_up");
    assert.match(
      notice?.content ?? "",
      new RegExp(
        `Past limits\\.catchUpChats, 1 less recently active chat was not read back: chat ${CHANNEL}\\. fetch_messages reads any of them\\.`,
        "u",
      ),
    );
    assert.doesNotMatch(notice?.content ?? "", new RegExp(SILENT, "u"));
    assert.equal(
      (h.daemon.status() as { catchUp: { owed: number } }).catchUp.owed,
      0,
    );
  } finally {
    h.dispose();
  }
});

test("with no session attached, the read-back is told at the next attach, failures included, and only once", async () => {
  const h = harness(testConfig(), {
    history: (channelId) => {
      if (channelId === ROOM) {
        throw new RestError(403, 50001, "Missing Access");
      }
      return [];
    },
  });
  try {
    h.daemon.ingest(message({ channel_id: ROOM, content: "room, last heard" }));
    h.daemon.ingest(mention("channel, last heard"));
    h.daemon.gatewayReady();
    await settled();
    assert.equal(h.store.counters().catch_up_failed, 1);
    assert.deepEqual(told(h.logs), []);
    const shim = h.attach("scribe");
    const [notice] = shim.connection.events();
    assert.equal(notice?.meta.kind, "catch_up");
    assert.match(
      notice?.content ?? "",
      new RegExp(
        `chat ${ROOM}: not read back \\(Discord answered 403\\); fetch_messages with this chat_id reads it\\.`,
        "u",
      ),
    );
    shim.close();
    const again = h.attach("scribe");
    assert.deepEqual(kinds(again.connection.events()), []);
    assert.deepEqual(told(h.logs), [{ ear: "scribe", chats: 1, skipped: 0 }]);
  } finally {
    h.dispose();
  }
});

test("a saved read-back report the daemon cannot read is dropped: the attach still finishes, and the next report is kept", async () => {
  const anchor = mention("last heard");
  const missed = mention("sent while down");
  const config = testConfig({
    ears: {
      scribe: { attachCanary: true, channels: { [CHANNEL]: "mentions" } },
    },
  });
  const h = harness(config, {
    history: historyOf({ [CHANNEL]: [anchor, missed] }),
  });
  const pending = "catch_up.pending.scribe";
  // Rows the daemon never writes. Some threw in the attach, before the canary; the others told
  // the session of chats that are not there.
  const unreadable = [
    "{not json",
    "null",
    '{"skipped":[]}',
    '{"chats":[]}',
    '{"chats":[null],"skipped":[]}',
    '{"chats":[{"read":1}],"skipped":[]}',
    '{"chats":[{"chatId":"1"}],"skipped":[]}',
    '{"chats":[{"chatId":"1","read":0,"failed":403}],"skipped":[]}',
    '{"chats":[{"chatId":"1","read":0,"missing":{"after":"1"}}],"skipped":[]}',
    '{"chats":[{"chatId":"1","read":0,"missing":{"before":"2"}}],"skipped":[]}',
    '{"chats":[],"skipped":[7]}',
  ];
  try {
    for (const saved of unreadable) {
      h.store.setRuntimeState(pending, saved);
      const shim = h.attach("scribe");
      assert.deepEqual(kinds(shim.connection.events()), ["attach"], saved);
      assert.equal(h.store.runtimeState(pending), undefined, saved);
      shim.close();
    }
    // With no session attached, a read-back threw adding its report to an unreadable one, so
    // its own was lost too.
    h.daemon.ingest(anchor);
    h.store.setRuntimeState(pending, "{not json");
    h.daemon.gatewayReady();
    await settled();
    const shim = h.attach("scribe");
    const [notice, canary] = shim.connection.events();
    assert.equal(notice?.meta.kind, "catch_up");
    assert.match(
      notice?.content ?? "",
      new RegExp(`chat ${CHANNEL}: 1 message read back\\.`, "u"),
    );
    assert.equal(canary?.meta.kind, "attach");
    assert.equal(h.store.counters().catch_up_unreadable, unreadable.length + 1);
    const warned = h.logs.filter(
      (line) =>
        (JSON.parse(line) as { event?: unknown }).event ===
        "ear.catch_up_unreadable",
    );
    assert.equal(warned.length, unreadable.length + 1);
    assert.deepEqual(told(h.logs), [{ ear: "scribe", chats: 1, skipped: 0 }]);
  } finally {
    h.dispose();
  }
});

test("read-back mentions spend no wake budget, so live mentions still wake afterwards", async () => {
  const anchor = mention("last heard", AMBIENT);
  const channel = [anchor];
  const h = harness(
    testConfig({ ambientWake: { maxEvents: 2, windowMs: 60_000 } }),
    { history: historyOf({ [CHANNEL]: channel }) },
  );
  try {
    const shim = h.attach("scribe");
    h.daemon.ingest(anchor);
    h.timers.advance(1_000);
    channel.push(
      ...Array.from({ length: 5 }, (_, index) =>
        mention(`missed ${index}`, AMBIENT),
      ),
    );
    h.daemon.gatewayReady();
    await settled();
    h.timers.advance(1_000);
    assert.equal(h.store.stateCounts("scribe").offered, 6);
    h.daemon.ingest(mention("live, after the read-back", AMBIENT));
    h.timers.advance(1_000);
    const last = shim.connection.events().at(-1);
    assert.equal(last?.meta.kind, "mention");
    assert.match(last?.content ?? "", /live, after the read-back/u);
  } finally {
    h.dispose();
  }
});

test("an anchor only moves forward, follows the bot's own replies, and never exists for unheard chats", () => {
  const h = harness();
  const owed = () => {
    h.store.oweCatchUp();
    const rows = h.store.owedCatchUps().map((row) => ({ ...row }));
    for (const row of rows) {
      h.store.settleCatchUp(row.chatId);
    }
    return rows;
  };
  try {
    const later = mention("later");
    // Older than every id the helper hands out.
    const earlier = message({ id: "1000000000000000", content: "earlier" });
    h.daemon.ingest(later);
    assert.equal(h.daemon.ingest(earlier), "inserted");
    assert.deepEqual(owed(), [
      { chatId: CHANNEL, guildId: GUILD, after: later.id },
    ]);
    const own = message({ author: { id: BOT, username: "scribe", bot: true } });
    assert.equal(h.daemon.ingest(own), "rejected");
    h.daemon.ingest(
      message({ channel_id: "700000000000000099", content: "unbound" }),
    );
    assert.deepEqual(owed(), [
      { chatId: CHANNEL, guildId: GUILD, after: own.id },
    ]);
  } finally {
    h.dispose();
  }
});

test("the prune keeps the most recently active anchors", () => {
  const store = new EventStore(":memory:", new FakeClock());
  try {
    for (let index = 0; index < 1_005; index += 1) {
      store.advanceAnchor(
        String(800_000_000_000_000_000n + BigInt(index)),
        GUILD,
        String(1_200_000_000_000_000_000n + BigInt(index)),
      );
    }
    store.prune(60_000);
    store.oweCatchUp();
    const owed = store.owedCatchUps();
    assert.equal(owed.length, 1_000);
    assert.equal(owed.at(-1)?.chatId, String(800_000_000_000_000_005n));
  } finally {
    store.close();
  }
});

test("catch-up limits: 50 messages and 25 chats by default, one page at most, 0 turns it off", () => {
  assert.deepEqual(
    [testConfig().limits.catchUpMessages, testConfig().limits.catchUpChats],
    [50, 25],
  );
  assert.equal(
    testConfig({ limits: { catchUpMessages: 0 } }).limits.catchUpMessages,
    0,
  );
  assert.throws(
    () => testConfig({ limits: { catchUpMessages: 101 } }),
    /limits\.catchUpMessages must be at most 100/u,
  );
  assert.throws(
    () => testConfig({ limits: { catchUpChats: 0 } }),
    /limits\.catchUpChats must be an integer >= 1/u,
  );
});

test("with catch-up off, a fresh session owes nothing and reads nothing", async () => {
  const h = harness(testConfig({ limits: { catchUpMessages: 0 } }), {
    history: historyOf({ [CHANNEL]: [mention("never fetched")] }),
  });
  try {
    h.daemon.ingest(mention("heard live"));
    h.daemon.gatewayReady();
    await settled();
    assert.equal(h.rest.calls.length, 0);
  } finally {
    h.dispose();
  }
});

test("the catch_up notice lists gaps and failures first, then chats read back in full up to 20 named", () => {
  const chats = [
    ...Array.from({ length: 25 }, (_, index) => ({
      chatId: String(700_000_000_000_000_100n + BigInt(index)),
      read: 1,
    })),
    {
      chatId: "700000000000000200",
      read: 50,
      missing: { after: "1000000000000000001", before: "1000000000000000060" },
    },
    { chatId: "700000000000000201", read: 0, failed: "Discord answered 403" },
  ];
  const notice = renderCatchUp(chats, []);
  assert.equal(notice.meta.count, "75");
  assert.match(
    notice.content,
    /read back from channel history what was sent while it was disconnected\. chat 700000000000000200: 50 messages read back, but older ones may be missing[\s\S]*chat 700000000000000201: not read back \(Discord answered 403\)/u,
  );
  assert.match(notice.content, / 7 more chats were read back in full\./u);
  assert.equal(notice.content.match(/chat 7\d+:/gu)?.length, 20);
});

test("the catch_up notice names every gap and failure past 20, and counts only chats read back in full (#75)", () => {
  const chatId = (index: number) =>
    String(700_000_000_000_001_000n + BigInt(index));
  // Discord's REST API failing right after a fresh session fails every page.
  const failed = renderCatchUp(
    Array.from({ length: 25 }, (_, index) => ({
      chatId: chatId(index),
      read: 0,
      failed: "Discord answered 503",
    })),
    [],
  );
  assert.equal(failed.meta.count, "0");
  assert.equal(
    failed.content.match(/: not read back \(Discord answered 503\)/gu)?.length,
    25,
  );
  assert.doesNotMatch(failed.content, /read back in full/u);
  const gaps = renderCatchUp(
    Array.from({ length: 25 }, (_, index) =>
      index < 22
        ? {
            chatId: chatId(index),
            read: 50,
            missing: {
              after: "1000000000000000001",
              before: "1000000000000000060",
            },
          }
        : { chatId: chatId(index), read: 1 },
    ),
    [],
  );
  for (let index = 0; index < 22; index += 1) {
    assert.match(
      gaps.content,
      new RegExp(
        `chat ${chatId(index)}: 50 messages read back, but older ones may be missing`,
        "u",
      ),
    );
  }
  assert.equal(gaps.content.match(/chat 7\d+:/gu)?.length, 22);
  assert.match(gaps.content, / 3 more chats were read back in full\./u);
});
