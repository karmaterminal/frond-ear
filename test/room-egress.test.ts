// binary-canticle#161 item 3: room output and source use, frond-ear's scope. Every write to
// a Discord room (reply, react, edit_message, and any retry of one) passes one chokepoint,
// which reads the speaking session's canticle custody, asks the configured policy
// (canticle.roomPolicy: observe by default, or strict-fresh), and records an egress row of
// the exposure state at that moment, by record id and digest, never payload. A refusal is a
// tool error and sends nothing. Bash, gh, files and other MCP servers are outside it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ROOM_OUTPUT_TOOLS } from "../src/egress.ts";
import { TOOLS } from "../src/shim.ts";
import { EventStore } from "../src/store.ts";
import {
  canticleConfig,
  offered,
  OPS,
  pressure,
  SESSION,
  setup,
} from "./canticle-host.ts";
import { CHANNEL, type Harness, harness, testConfig } from "./helpers.ts";

type Client = ReturnType<Harness["attach"]>;

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** `key:epoch:stream:seq` of an ops.fleet record the host sang, as custody keys it. */
const identity = (seq: number) => `${OPS}:7:ops.fleet:${seq}`;

/** What the host sings as record `seq` by default, and its custody digest. */
const digestOf = (seq: number) => sha256(`deploy.started ${seq}`);

/** Every Discord write the daemon made: sends, reactions and edits. */
const writes = (h: Harness) =>
  h.rest.calls.filter((call) =>
    ["send", "react", "edit"].includes(call.method),
  );

const rows = (h: Harness) => h.store.roomEgress("scribe", 0);

const REFUSED = /refused by canticle\.roomPolicy strict-fresh: /u;

/** The tools that are not room output: none of them may write to Discord. */
const NOT_ROOM_OUTPUT = [
  "ack",
  "canticle_custody",
  "ear_status",
  "fetch_attachment",
  "fetch_messages",
  "hear",
  "hold_compaction",
  "inbox",
  "leave_letter",
  "letters",
  "set_attention",
  "set_canticle_delivery",
];

/** Arguments that take each tool as far as it goes; `message` is a frond-ear message. */
function argsFor(tool: string, message: string): Record<string, unknown> {
  switch (tool) {
    case "reply":
      return { chat_id: CHANNEL, text: "status: green" };
    case "react":
      return { chat_id: CHANNEL, message_id: message, emoji: "👍" };
    case "edit_message":
      return { chat_id: CHANNEL, message_id: message, text: "status: amber" };
    case "fetch_messages":
    case "inbox":
      return { chat_id: CHANNEL };
    case "fetch_attachment":
      return { chat_id: CHANNEL, message_id: message };
    case "set_attention":
      return { mode: "room", chat_id: CHANNEL, ttl_seconds: 60 };
    case "set_canticle_delivery":
      return { mode: "digest" };
    case "leave_letter":
      return { reason: "test", body: "a note to a later turn" };
    case "hold_compaction":
      return { action: "status" };
    default:
      return {};
  }
}

test("chokepoint: every tool is classified as room output or not; only the three room-output tools write to Discord, each once through the egress gate, refused under strict-fresh and recorded under observe", async () => {
  const names = TOOLS.map((tool) => tool.name).sort();
  assert.deepEqual([...ROOM_OUTPUT_TOOLS].sort(), [
    "edit_message",
    "react",
    "reply",
  ]);
  assert.deepEqual(
    [...ROOM_OUTPUT_TOOLS, ...NOT_ROOM_OUTPUT].sort(),
    names,
    "a new tool must be classified here, and a room-output one must go through the egress gate",
  );

  const { h } = setup({ mode: "immediate" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await pressure(h, "b-1");
    // A message frond-ear sent, for edit_message and react to name.
    const first = await h.call(shim, "reply", {
      chat_id: CHANNEL,
      text: "first",
    });
    assert.equal(first.ok, true, first.text);
    const message = writes(h)[0]!.messageId!;
    assert.equal(rows(h).length, 1);

    // strict-fresh with the session gone: history is unknown, so every room output is
    // refused at the gate, recorded, and nothing reaches Discord; no other tool writes.
    h.daemon.reloadConfig(
      canticleConfig({ mode: "immediate" }, { roomPolicy: "strict-fresh" }),
    );
    const cli = h.attach(undefined, { role: "cli" });
    for (const tool of names) {
      const result = await h.call(cli, tool, argsFor(tool, message));
      if ((ROOM_OUTPUT_TOOLS as readonly string[]).includes(tool)) {
        assert.equal(result.ok, false, `${tool} was refused`);
        assert.match(result.text, REFUSED, tool);
        assert.match(result.text, /nothing was sent/u, tool);
      }
    }
    assert.equal(writes(h).length, 1, "only the first reply reached Discord");
    const refused = rows(h).slice(1);
    assert.deepEqual(
      refused.map((row) => [row.tool, row.decision, row.outcome]).sort(),
      [
        ["edit_message", "refuse", "refused"],
        ["react", "refuse", "refused"],
        ["reply", "refuse", "refused"],
      ],
      "one egress row per room-output call, and none for any other tool",
    );

    // observe: each room-output tool writes once and records one allowed row.
    h.daemon.reloadConfig(canticleConfig({ mode: "immediate" }));
    for (const tool of ROOM_OUTPUT_TOOLS) {
      const result = await h.call(shim, tool, argsFor(tool, message));
      assert.equal(result.ok, true, `${tool}: ${result.text}`);
    }
    assert.deepEqual(
      writes(h)
        .slice(1)
        .map((call) => call.method)
        .sort(),
      ["edit", "react", "send"],
    );
    assert.deepEqual(
      rows(h)
        .slice(4)
        .map((row) => [row.tool, row.decision, row.outcome])
        .sort(),
      [
        ["edit_message", "allow", "sent"],
        ["react", "allow", "sent"],
        ["reply", "allow", "sent"],
      ],
    );
  } finally {
    h.dispose();
  }
});

test("chokepoint: no source file but the egress gate (and rest.ts, which defines them) names a Discord write: sendMessage, addReaction, editMessage", () => {
  const root = join(import.meta.dirname, "..", "src");
  const files = readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts"))
    .map((path) => join(root, path));
  // By name, not only as a method call: a destructured or aliased write counts too.
  const callers = files.filter(
    (path) =>
      !path.endsWith(join("src", "egress.ts")) &&
      !path.endsWith(join("src", "rest.ts")) &&
      /\b(?:sendMessage|addReaction|editMessage)\b/u.test(
        readFileSync(path, "utf8"),
      ),
  );
  assert.deepEqual(callers, []);
});

test("observe: every room output records the speaker's custody at send time, by record id and digest, and refuses nothing", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await pressure(h, "b-1");
    const push = await offered(h, host, shim, 1);
    await h.call(shim, "ack", { batch_id: push.meta.batch_id });

    const sent = await h.call(shim, "reply", {
      chat_id: CHANNEL,
      text: "the deploy started",
    });
    assert.equal(sent.ok, true, sent.text);
    assert.match(sent.text, /^sent 1 message to /u, "observe changes nothing");
    const id = writes(h)[0]!.messageId!;
    const [row] = rows(h);
    assert.ok(row);
    assert.deepEqual(
      {
        ear: row.ear,
        tool: row.tool,
        chatId: row.chatId,
        target: row.target,
        sessionId: row.sessionId,
        speaker: row.speaker,
        policy: row.policy,
        decision: row.decision,
        history: row.history,
        boundary: row.boundary,
        sources: row.sources,
        decidedAt: row.decidedAt,
        outcome: row.outcome,
        messageIds: row.messageIds,
      },
      {
        ear: "scribe",
        tool: "reply",
        chatId: CHANNEL,
        target: null,
        sessionId: SESSION,
        speaker: "holder",
        policy: "observe",
        decision: "allow",
        history: "complete",
        boundary: "b-1",
        sources: [
          { identity: identity(1), digest: digestOf(1), state: "echoed" },
        ],
        decidedAt: h.clock.now(),
        outcome: "sent",
        messageIds: [id],
      },
    );
    assert.match(row.digest, /^[0-9a-f]{64}$/u);
    const kept = JSON.stringify(rows(h));
    assert.ok(!kept.includes("the deploy started"), "never the reply's text");
    assert.ok(!kept.includes("deploy.started 1"), "never a record's payload");

    // A compaction past the echoed record: observe still sends, and records it as history.
    h.clock.advance(1_000);
    await pressure(h, "compact-1", { tokens: null });
    const reacted = await h.call(shim, "react", {
      chat_id: CHANNEL,
      message_id: id,
      emoji: "👍",
    });
    assert.equal(reacted.ok, true, reacted.text);
    const edited = await h.call(shim, "edit_message", {
      chat_id: CHANNEL,
      message_id: id,
      text: "the deploy finished",
    });
    assert.equal(edited.ok, true, edited.text);
    const [, react, edit] = rows(h);
    for (const later of [react!, edit!]) {
      assert.equal(later.decision, "allow");
      assert.equal(later.history, "incomplete");
      assert.equal(later.boundary, "compact-1");
      assert.deepEqual(later.sources, [
        {
          identity: identity(1),
          digest: digestOf(1),
          state: "echoed_before_boundary",
        },
      ]);
      assert.equal(later.target, id);
      assert.equal(later.outcome, "sent");
    }
    assert.equal(react!.tool, "react");
    assert.equal(edit!.tool, "edit_message");
    assert.deepEqual(edit!.messageIds, [id]);
    assert.equal(writes(h).length, 3);
  } finally {
    h.dispose();
  }
});

test("strict-fresh: refuses room output on unknown history, on a record offered and never echoed, and after a compaction past an echoed source; a call naming the push's batch_id echoes it before the gate reads custody", async () => {
  const { h, host } = setup(
    { mode: "immediate" },
    { roomPolicy: "strict-fresh" },
  );
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const reply = (text: string, extra: Record<string, unknown> = {}) =>
      h.call(shim, "reply", { chat_id: CHANNEL, text, ...extra });

    // No reading from the session's pressure hook: its history is unknown.
    let result = await reply("hello");
    assert.equal(result.ok, false);
    assert.match(
      result.text,
      /refused by canticle\.roomPolicy strict-fresh: history unknown: no compaction boundary from this session's pressure hook yet/u,
    );
    assert.match(result.text, /nothing was sent/u);
    assert.equal(writes(h).length, 0);

    // A reading, and nothing heard yet: complete.
    await pressure(h, "b-1");
    result = await reply("hello again");
    assert.equal(result.ok, true, result.text);
    const id = writes(h)[0]!.messageId!;

    // Offered, never echoed: incomplete. Naming the push's batch_id in the reply echoes it
    // first, so the same reply goes out.
    const push = await offered(h, host, shim, 1);
    result = await reply("about that deploy");
    assert.equal(result.ok, false);
    assert.match(
      result.text,
      /strict-fresh: history incomplete: 1 record offered, never echoed/u,
    );
    result = await reply("about that deploy", {
      batch_id: push.meta.batch_id,
    });
    assert.equal(result.ok, true, result.text);
    assert.equal(writes(h).length, 2);

    // The session compacts past the echoed record: every room output is refused.
    h.clock.advance(1_000);
    await pressure(h, "compact-1", { tokens: null });
    const stale =
      /strict-fresh: history incomplete: 1 record echoed before the current compaction boundary or by another session/u;
    result = await reply("still deploying");
    assert.equal(result.ok, false);
    assert.match(result.text, stale);
    result = await h.call(shim, "react", {
      chat_id: CHANNEL,
      message_id: id,
      emoji: "👍",
    });
    assert.equal(result.ok, false);
    assert.match(result.text, stale);
    result = await h.call(shim, "edit_message", {
      chat_id: CHANNEL,
      message_id: id,
      text: "edited",
    });
    assert.equal(result.ok, false);
    assert.match(result.text, stale);
    assert.equal(writes(h).length, 2, "nothing more reached Discord");

    const refused = rows(h).filter((row) => row.decision === "refuse");
    assert.deepEqual(
      refused.map((row) => [row.tool, row.history, row.outcome]),
      [
        ["reply", "unknown", "refused"],
        ["reply", "incomplete", "refused"],
        ["reply", "incomplete", "refused"],
        ["react", "incomplete", "refused"],
        ["edit_message", "incomplete", "refused"],
      ],
    );
    assert.deepEqual(refused.at(-1)!.sources, [
      {
        identity: identity(1),
        digest: digestOf(1),
        state: "echoed_before_boundary",
      },
    ]);
    assert.ok(refused.every((row) => row.messageIds.length === 0));

    // hear shows the record again, inside the new boundary: fresh again.
    await h.call(shim, "hear", {});
    result = await reply("deploy done");
    assert.equal(result.ok, true, result.text);
    assert.equal(rows(h).at(-1)!.history, "complete");
  } finally {
    h.dispose();
  }
});

test("replay: a retry re-checks at the gate and never reuses an earlier allow; an unfinished reply retried after a compaction posts nothing more, and resumes once fresh", async () => {
  const { h, host } = setup(
    { mode: "immediate" },
    { roomPolicy: "strict-fresh" },
  );
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await pressure(h, "b-1");
    const push = await offered(h, host, shim, 1);
    await h.call(shim, "ack", { batch_id: push.meta.batch_id });

    // A two-part reply whose second part Discord never confirms.
    const send = h.rest.sendMessage.bind(h.rest);
    let attempts = 0;
    h.rest.sendMessage = async (...args) => {
      attempts += 1;
      if (attempts === 2) throw new Error("socket hang up");
      return send(...args);
    };
    const text = `${"a".repeat(1_990)}\n\n${"b".repeat(100)}`;
    let result = await h.call(shim, "reply", { chat_id: CHANNEL, text });
    assert.equal(result.ok, false);
    assert.match(result.text, /did not confirm part 2 of 2/u);
    const part1 = writes(h)[0]!.messageId!;
    let row = rows(h).at(-1)!;
    assert.deepEqual(
      [row.decision, row.outcome, row.messageIds],
      ["allow", "error", [part1]],
    );

    // A compaction, then the identical retry: refused, nothing posted.
    h.clock.advance(1_000);
    await pressure(h, "compact-1", { tokens: null });
    result = await h.call(shim, "reply", { chat_id: CHANNEL, text });
    assert.equal(result.ok, false);
    assert.match(result.text, REFUSED);
    assert.equal(writes(h).length, 1);
    assert.equal(attempts, 2, "the retry never reached Discord");
    row = rows(h).at(-1)!;
    assert.deepEqual([row.decision, row.outcome], ["refuse", "refused"]);

    // Fresh again: the retry resumes, posting only part 2.
    await h.call(shim, "hear", {});
    result = await h.call(shim, "reply", { chat_id: CHANNEL, text });
    assert.equal(result.ok, true, result.text);
    assert.match(result.text, /part 1 had gone out on an earlier try/u);
    assert.equal(writes(h).length, 2);
    const part2 = writes(h)[1]!.messageId!;
    row = rows(h).at(-1)!;
    assert.deepEqual(
      [row.decision, row.outcome, row.messageIds],
      ["allow", "sent", [part2]],
    );

    // An allowed reply, repeated after a compaction, is checked again too.
    const done = await h.call(shim, "react", {
      chat_id: CHANNEL,
      message_id: part2,
      emoji: "✅",
    });
    assert.equal(done.ok, true, done.text);
    h.clock.advance(1_000);
    await pressure(h, "compact-2", { tokens: null });
    const again = await h.call(shim, "react", {
      chat_id: CHANNEL,
      message_id: part2,
      emoji: "✅",
    });
    assert.equal(again.ok, false);
    assert.match(again.text, REFUSED);
    assert.equal(writes(h).length, 3);
  } finally {
    h.dispose();
  }
});

test("persistence: the egress row is written before Discord is called, so a send that never answers (or a crash) leaves it pending; it survives a restart", async () => {
  const { h } = setup({ mode: "immediate" });
  let reopened: EventStore | undefined;
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await pressure(h, "b-1");
    let release: (() => void) | undefined;
    const send = h.rest.sendMessage.bind(h.rest);
    h.rest.sendMessage = async (...args) => {
      await new Promise<void>((resolve) => (release = resolve));
      return send(...args);
    };
    await shim.send({
      type: "call",
      id: 900,
      tool: "reply",
      args: { chat_id: CHANNEL, text: "in flight" },
    });
    assert.ok(release, "the send is waiting on Discord");
    let row = rows(h).at(-1)!;
    assert.deepEqual(
      [row.decision, row.outcome, row.messageIds, row.settledAt],
      ["allow", "pending", [], null],
    );
    // What a crash now would leave: the row, pending, on disk.
    reopened = new EventStore(join(h.directory, "ear.db"), h.clock);
    assert.equal(reopened.roomEgress("scribe", 0).at(-1)!.outcome, "pending");

    release!();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const result = shim.connection.results().find((item) => item.id === 900);
    assert.equal(result?.ok, true, result?.text);
    row = rows(h).at(-1)!;
    assert.equal(row.outcome, "sent");
    assert.equal(row.settledAt, h.clock.now());
    assert.equal(reopened.roomEgress("scribe", 0).at(-1)!.outcome, "sent");
  } finally {
    reopened?.close();
    h.dispose();
  }
});

test("speakers: a superseded session or a CLI client is judged unknown (frond-ear holds no custody that is theirs), refused under strict-fresh and recorded under observe", async () => {
  const { h } = setup({ mode: "immediate" }, { roomPolicy: "strict-fresh" });
  try {
    const old = h.attach("scribe", { sessionId: SESSION });
    await pressure(h, "b-1");
    const holder = h.attach("scribe", {
      sessionId: "22222222-bbbb-4bbb-8bbb-000000000002",
    });
    const cli: Client = h.attach(undefined, { role: "cli" });

    let result = await h.call(old, "reply", { chat_id: CHANNEL, text: "x" });
    assert.equal(result.ok, false);
    assert.match(
      result.text,
      /strict-fresh: history unknown: this session no longer holds ear scribe/u,
    );
    result = await h.call(cli, "reply", { chat_id: CHANNEL, text: "y" });
    assert.equal(result.ok, false);
    assert.match(
      result.text,
      /strict-fresh: history unknown: no ear's session is speaking \(a CLI or tools-only connection\)/u,
    );
    assert.deepEqual(
      rows(h).map((row) => [row.speaker, row.sessionId, row.decision]),
      [
        ["superseded", SESSION, "refuse"],
        ["other", null, "refuse"],
      ],
    );
    assert.equal(writes(h).length, 0);

    h.daemon.reloadConfig(canticleConfig({ mode: "immediate" }));
    for (const client of [old, cli, holder]) {
      result = await h.call(client, "reply", { chat_id: CHANNEL, text: "z" });
      assert.equal(result.ok, true, result.text);
    }
    assert.deepEqual(
      rows(h)
        .slice(2)
        .map((row) => [row.speaker, row.policy, row.decision, row.history]),
      [
        ["superseded", "observe", "allow", "unknown"],
        ["other", "observe", "allow", "unknown"],
        ["holder", "observe", "allow", "unknown"],
      ],
    );
  } finally {
    h.dispose();
  }
});

test("config: canticle.roomPolicy is observe by default (and with no canticle section), strict-fresh when chosen, and anything else fails the load; it reloads with the config", async () => {
  assert.equal(
    canticleConfig({ mode: "immediate" }).canticle!.roomPolicy,
    "observe",
  );
  assert.equal(
    canticleConfig({ mode: "immediate" }, { roomPolicy: "strict-fresh" })
      .canticle!.roomPolicy,
    "strict-fresh",
  );
  for (const bad of ["strict", "Observe", true, 1, null]) {
    assert.throws(
      () => canticleConfig({ mode: "immediate" }, { roomPolicy: bad }),
      /canticle\.roomPolicy must be observe or strict-fresh/u,
      String(bad),
    );
  }

  // No canticle section at all: observe, and every room output still gets its row.
  const h = harness(testConfig());
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const result = await h.call(shim, "reply", {
      chat_id: CHANNEL,
      text: "no canticle here",
    });
    assert.equal(result.ok, true, result.text);
    assert.deepEqual(
      rows(h).map((row) => [row.policy, row.decision, row.history]),
      [["observe", "allow", "unknown"]],
    );
  } finally {
    h.dispose();
  }

  const { h: g } = setup({ mode: "immediate" });
  try {
    const shim = g.attach("scribe", { sessionId: SESSION });
    assert.equal(
      (await g.call(shim, "reply", { chat_id: CHANNEL, text: "1" })).ok,
      true,
    );
    g.daemon.reloadConfig(
      canticleConfig({ mode: "immediate" }, { roomPolicy: "strict-fresh" }),
    );
    assert.equal(
      (await g.call(shim, "reply", { chat_id: CHANNEL, text: "2" })).ok,
      false,
    );
    g.daemon.reloadConfig(canticleConfig({ mode: "immediate" }));
    assert.equal(
      (await g.call(shim, "reply", { chat_id: CHANNEL, text: "3" })).ok,
      true,
    );
  } finally {
    g.dispose();
  }
});

test("status: ear_status names each ear's room policy and its egress decisions in the last hour, with the latest refusal's reason", async () => {
  const { h } = setup({ mode: "immediate" }, { roomPolicy: "strict-fresh" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await h.call(shim, "reply", { chat_id: CHANNEL, text: "refused" });
    await pressure(h, "b-1");
    await h.call(shim, "reply", { chat_id: CHANNEL, text: "allowed" });
    const ears = (
      h.daemon.status("scribe") as {
        ears: Array<{ roomEgress?: Record<string, unknown> }>;
      }
    ).ears;
    assert.deepEqual(ears[0]!.roomEgress, {
      policy: "strict-fresh",
      windowMs: 3_600_000,
      allowed: 1,
      refused: 1,
      lastRefusal: {
        at: h.clock.now(),
        tool: "reply",
        chatId: CHANNEL,
        reason:
          "history unknown: no compaction boundary from this session's pressure hook yet (frond-ear pressure --hook --ear)",
      },
    });
  } finally {
    h.dispose();
  }
});
