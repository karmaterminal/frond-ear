import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../src/config.ts";
import { WakeLimiter, classify, type PolicyContext } from "../src/policy.ts";
import {
  AMBIENT,
  BOT,
  CHANNEL,
  DM,
  OTHER_BOT,
  PEER_BOT,
  PRINCIPAL,
  ROOM,
  SILENT,
  THREAD,
  message,
  testConfig,
} from "./helpers.ts";

const context = (overrides: Partial<PolicyContext> = {}): PolicyContext => ({
  threadParent: () => undefined,
  wakeBudgetExhausted: () => false,
  now: 0,
  ...overrides,
});

function accepted(result: ReturnType<typeof classify>) {
  assert.equal(result.accept, true, result.accept ? "" : result.reason);
  return result as Extract<ReturnType<typeof classify>, { accept: true }>;
}

test("self messages, unbound channels and unknown bots are rejected", () => {
  const config = testConfig();
  assert.deepEqual(
    classify(config, message({ author: { id: BOT, bot: true } }), context()),
    {
      accept: false,
      reason: "self_message",
    },
  );
  assert.deepEqual(
    classify(config, message({ channel_id: "123" }), context()),
    {
      accept: false,
      reason: "channel_not_bound",
    },
  );
  assert.deepEqual(
    classify(
      config,
      message({ author: { id: OTHER_BOT, bot: true } }),
      context(),
    ),
    {
      accept: false,
      reason: "bot_not_allowed",
    },
  );
  assert.deepEqual(
    classify(
      config,
      message({ author: { id: OTHER_BOT }, webhook_id: "w" }),
      context(),
    ),
    {
      accept: false,
      reason: "bot_not_allowed",
    },
  );
});

test("peer-agent bots are admitted and classified peer_agent", () => {
  const result = accepted(
    classify(
      testConfig(),
      message({
        author: { id: PEER_BOT, bot: true },
        content: `<@${BOT}> ping`,
      }),
      context(),
    ),
  );
  assert.equal(result.trust, "peer_agent");
  assert.equal(result.isBot, true);
  assert.equal(result.wake, true);
});

test("every mention form wakes in mentions mode", () => {
  const config = testConfig();
  const forms = [
    message({ mentions: [{ id: BOT }] }),
    message({ content: `hey <@${BOT}>` }),
    message({ content: `hey <@!${BOT}>` }),
    message({ referenced_message: { id: "1", author: { id: BOT } } }),
    message({ content: "is scribe around?" }),
  ];
  for (const form of forms) {
    const result = accepted(classify(config, form, context()));
    assert.equal(result.mentioned, true, form.content);
    assert.equal(result.state, "queued");
  }
});

test("mentions mode: trust grants command, not interruption: unaddressed principal messages are context", () => {
  const config = testConfig();
  const ambient = accepted(
    classify(config, message({ content: "just chatting" }), context()),
  );
  assert.equal(ambient.trust, "ambient");
  assert.equal(ambient.state, "context");
  const principal = accepted(
    classify(config, message({ author: { id: PRINCIPAL } }), context()),
  );
  assert.equal(principal.trust, "principal");
  assert.equal(principal.priority, false);
  assert.equal(principal.state, "context");
  const addressed = accepted(
    classify(
      config,
      message({ author: { id: PRINCIPAL }, mentions: [{ id: BOT }] }),
      context(),
    ),
  );
  assert.equal(addressed.state, "queued");
  assert.equal(addressed.priority, true);
});

test("room mode wakes on everything; silent mode never wakes, even for principals", () => {
  const config = testConfig();
  const room = accepted(
    classify(config, message({ channel_id: ROOM }), context()),
  );
  assert.equal(room.state, "queued");
  assert.equal(room.priority, false);
  assert.equal(room.route.kind, "room");
  const silent = accepted(
    classify(
      config,
      message({
        channel_id: SILENT,
        author: { id: PRINCIPAL },
        mentions: [{ id: BOT }],
      }),
      context(),
    ),
  );
  assert.equal(silent.state, "stored");
  assert.equal(silent.wake, false);
});

test("threads inherit their parent's binding and keep their own chat_id", () => {
  const result = accepted(
    classify(
      testConfig(),
      message({ channel_id: THREAD, mentions: [{ id: BOT }] }),
      context({ threadParent: (id) => (id === THREAD ? CHANNEL : undefined) }),
    ),
  );
  assert.equal(result.route.chatId, THREAD);
  assert.equal(result.route.boundChannelId, CHANNEL);
});

test("DMs route to the DM ear only from principals and peer agents", () => {
  const config = testConfig();
  const { guild_id: _unused, ...fromPrincipal } = message({
    channel_id: DM,
    author: { id: PRINCIPAL },
  });
  const dm = accepted(classify(config, fromPrincipal, context()));
  assert.equal(dm.route.kind, "dm");
  assert.equal(dm.state, "queued");
  const { guild_id: _guild, ...withoutGuild } = message({
    channel_id: DM,
    author: { id: AMBIENT },
  });
  assert.deepEqual(classify(config, withoutGuild, context()), {
    accept: false,
    reason: "dm_sender_not_allowed",
  });
});

test("bot-loop cooldown demotes bot wakes to context", () => {
  const result = accepted(
    classify(
      testConfig(),
      message({ author: { id: PEER_BOT, bot: true }, mentions: [{ id: BOT }] }),
      context({ wakeBudgetExhausted: (kind) => kind === "bot" }),
    ),
  );
  assert.equal(result.wake, false);
  assert.equal(result.state, "context");
  assert.equal(result.reason, "bot_loop_cooldown");
});

test("WakeLimiter trips above maxEvents and recovers after cooldown", () => {
  const limiter = new WakeLimiter({
    maxEvents: 3,
    windowMs: 1_000,
    cooldownMs: 5_000,
  });
  assert.deepEqual(
    [0, 10, 20].map((time) => limiter.recordAndCheck("c", time)),
    [false, false, false],
  );
  assert.equal(limiter.recordAndCheck("c", 30), true);
  assert.equal(limiter.recordAndCheck("c", 4_000), true);
  assert.deepEqual(limiter.cooling(4_000), ["c"]);
  assert.equal(limiter.recordAndCheck("c", 5_100), false);
  assert.equal(limiter.recordAndCheck("other", 30), false);
});

test("config validation rejects ambiguous routing and reserved targets", () => {
  const base = {
    botUserId: BOT,
    ears: { a: { channels: { [CHANNEL]: "mentions" } } },
  };
  assert.equal(parseConfig(base).ears.a?.channels[CHANNEL]?.mode, "mentions");
  assert.throws(
    () =>
      parseConfig({
        ...base,
        ears: {
          a: { channels: { [CHANNEL]: "room" } },
          b: { channels: { [CHANNEL]: "room" } },
        },
      }),
    /bound to both a and b/u,
  );
  assert.throws(
    () =>
      parseConfig({ ...base, ears: { a: { dms: true }, b: { dms: true } } }),
    /only one ear may own DMs/u,
  );
  assert.throws(
    () => parseConfig({ ...base, ears: { a: { target: "copilot-sdk" } } }),
    /reserved/u,
  );
  assert.throws(
    () => parseConfig({ ...base, ears: { "bad name": {} } }),
    /must match/u,
  );
  assert.throws(
    () => parseConfig({ ...base, principals: ["figs"] }),
    /snowflake/u,
  );
  assert.throws(
    () =>
      parseConfig({
        ...base,
        ears: { a: { channels: { [CHANNEL]: "loud" } } },
      }),
    /mode/u,
  );
});

test("ambient mention wakes are budgeted; principals and peers are not", () => {
  const config = testConfig();
  const exhausted = context({
    wakeBudgetExhausted: (kind) => kind === "ambient",
  });
  const ambient = accepted(
    classify(config, message({ mentions: [{ id: BOT }] }), exhausted),
  );
  assert.equal(ambient.wake, false);
  assert.equal(ambient.state, "context");
  assert.equal(ambient.reason, "ambient_wake_budget");
  const principal = accepted(
    classify(
      config,
      message({ author: { id: PRINCIPAL }, mentions: [{ id: BOT }] }),
      exhausted,
    ),
  );
  assert.equal(
    principal.wake,
    true,
    "the ambient budget never applies to principals",
  );
  const peer = accepted(
    classify(
      config,
      message({ author: { id: PEER_BOT, bot: true }, mentions: [{ id: BOT }] }),
      exhausted,
    ),
  );
  assert.equal(peer.wake, true);
});

test("DMs bind to the single configured DM ear and honour dmMode", () => {
  const config = testConfig({
    ears: {
      a: { channels: { [CHANNEL]: "mentions" } },
      b: { dms: true, dmMode: "silent", channels: { [ROOM]: "room" } },
    },
  });
  assert.equal(config.dmEar, "b");
  const { guild_id: _unused, ...dm } = message({
    channel_id: DM,
    author: { id: PRINCIPAL },
  });
  const result = accepted(classify(config, dm, context()));
  assert.equal(result.route.ear, "b");
  assert.equal(result.state, "stored");
  assert.throws(
    () => testConfig({ ears: { a: { dms: true, dmMode: "loud" } } }),
    /dmMode/u,
  );
});

test("mention patterns are compiled once at config load", () => {
  const config = testConfig();
  assert.equal(config.mentionMatchers.length, 1);
  assert.ok(config.mentionMatchers[0] instanceof RegExp);
  assert.throws(
    () => testConfig({ mentionPatterns: ["(unclosed"] }),
    /invalid mention pattern/u,
  );
});

test("in room mode an over-budget ambient mention loses priority but still flows as room traffic", () => {
  const config = testConfig();
  const exhausted = context({
    wakeBudgetExhausted: (kind) => kind === "ambient",
  });
  const result = accepted(
    classify(
      config,
      message({ channel_id: ROOM, mentions: [{ id: BOT }] }),
      exhausted,
    ),
  );
  assert.equal(result.wake, true);
  assert.equal(result.priority, false);
  assert.equal(result.reason, "ambient_wake_budget");
  const plain = accepted(
    classify(config, message({ channel_id: ROOM }), exhausted),
  );
  assert.equal(plain.reason, "room", "plain room chatter is not budgeted");
});
