// binary-canticle#161 item 3: room output and source use, frond-ear's scope. Every write to
// a Discord room (reply, react, edit_message, and any retry of one) passes one chokepoint,
// which reads the speaking session's canticle custody, asks the configured policy
// (canticle.roomPolicy: observe by default, or strict-fresh), and records an egress row of
// the exposure state at that moment, by record id and digest, never payload. A refusal is a
// tool error and sends nothing. Bash, gh, files and other MCP servers are outside it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import test from "node:test";

import { ROOM_OUTPUT_TOOLS } from "../src/egress.ts";
import { RestError } from "../src/rest.ts";
import { runSend } from "../src/send.ts";
import { listenUnix } from "../src/server.ts";
import { ChannelShim, TOOLS } from "../src/shim.ts";
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
    const first = rows(h).at(-1)!;
    let row = first;
    assert.deepEqual(
      [row.decision, row.outcome, row.messageIds],
      ["allow", "unconfirmed", [part1]],
      "part 2 went unanswered: it may have posted",
    );
    assert.match(row.nonce!, /^[0-9a-f]{20}$/u, "tied to part 2's nonce");

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

    // Fresh again: the retry resumes, posting only part 2, under the first try's nonce. Discord
    // makes them one message, so frond-ear can't tell which try posted it: it is the first
    // row's write, and the retry's row names it as re-sent for that row.
    await h.call(shim, "hear", {});
    result = await h.call(shim, "reply", { chat_id: CHANNEL, text });
    assert.equal(result.ok, true, result.text);
    assert.match(result.text, /part 1 had gone out on an earlier try/u);
    assert.equal(writes(h).length, 2);
    const part2 = writes(h)[1]!.messageId!;
    row = rows(h).at(-1)!;
    assert.deepEqual(
      [row.decision, row.outcome, row.messageIds, row.resent],
      ["allow", "sent", [], [{ egressId: first.id, messageId: part2 }]],
    );
    row = rows(h).find((item) => item.id === first.id)!;
    assert.deepEqual(
      [row.outcome, row.messageIds, row.nonce],
      ["sent", [part1, part2], first.nonce],
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

test("outcome: a definitive Discord refusal (4xx) settles the row as error with nothing confirmed", async () => {
  const { h } = setup({ mode: "immediate" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await pressure(h, "b-1");
    h.rest.sendMessage = async () => {
      throw new RestError(403, 50013, "Missing Permissions");
    };
    const result = await h.call(shim, "reply", {
      chat_id: CHANNEL,
      text: "no permission here",
    });
    assert.equal(result.ok, false);
    assert.match(result.text, /Missing Permissions/u);
    const row = rows(h).at(-1)!;
    assert.deepEqual(
      [row.decision, row.outcome, row.messageIds, row.settledAt],
      ["allow", "error", [], h.clock.now()],
    );
  } finally {
    h.dispose();
  }
});

async function waitFor<T>(
  probe: () => T | undefined,
  what: string,
): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * The real channel shim, as Claude Code runs it for ear scribe, on a real Unix socket to
 * the daemon; `call` is an MCP tools/call over its stdio.
 */
async function realShim(socketPath: string, sessionId: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  const answers = new Map<number, { text: string; isError: boolean }>();
  let buffer = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, at)) as {
        id?: number;
        result?: { content?: Array<{ text: string }>; isError?: boolean };
      };
      buffer = buffer.slice(at + 1);
      if (typeof message.id === "number" && message.result) {
        answers.set(message.id, {
          text: message.result.content?.[0]?.text ?? "",
          isError: message.result.isError === true,
        });
      }
    }
  });
  const shim = new ChannelShim({
    input,
    output,
    connect: () => connect(socketPath),
    ear: "scribe",
    sessionId,
    log: () => undefined,
  });
  shim.start();
  let id = 0;
  const request = (method: string, params: object) => {
    const n = ++id;
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`,
    );
    return waitFor(() => answers.get(n), method);
  };
  // initialize answers once the daemon has welcomed the shim.
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  input.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  return {
    call: (tool: string, args: Record<string, unknown>) =>
      request("tools/call", { name: tool, arguments: args }),
    stop: () => shim.stop(),
  };
}

/** `frond-ear send`, as seat-pulse runs it, against the daemon's socket. */
async function cliSend(socketPath: string, text: string) {
  let stdout = "";
  let stderr = "";
  const out = new PassThrough();
  out.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  const err = new PassThrough();
  err.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await runSend(["--chat", CHANNEL, text], {
    stdout: out,
    stderr: err,
    env: { FROND_EAR_SOCKET: socketPath },
  });
  return { code, stdout, stderr };
}

/**
 * Discord takes every send, as enforce_nonce does (a repeated nonce returns the original),
 * but the answer to the first `lose[text]` tries at a text is lost. Returns each try's nonce.
 */
function losingAnswers(h: Harness, lose: Record<string, number>): string[] {
  const nonces: string[] = [];
  const discordSend = h.rest.sendMessage.bind(h.rest);
  h.rest.sendMessage = async (chatId, content, replyTo, nonce, files) => {
    nonces.push(nonce!);
    const sent = await discordSend(chatId, content, replyTo, nonce, files);
    if ((lose[content] ?? 0) > 0) {
      lose[content]! -= 1;
      throw new TypeError("fetch failed");
    }
    return sent;
  };
  return nonces;
}

test("unconfirmed, through the real shim and `frond-ear send` on a real socket: a reply Discord posted but never answered keeps its own row, unconfirmed and tied to its nonce; the identical retry gets the original back, credits it to that row, and claims nothing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-egress-"));
  const socketPath = join(directory, "daemon.sock");
  const h = harness(testConfig());
  const server = await listenUnix(h.daemon, socketPath);
  const session = await realShim(socketPath, SESSION);
  try {
    const nonces = losingAnswers(h, { "deploy done": 1, "seat gone": 1 });

    // The session's reply: Discord posts it, and its answer is lost.
    let answer = await session.call("reply", {
      chat_id: CHANNEL,
      text: "deploy done",
    });
    assert.equal(answer.isError, true);
    assert.match(answer.text, /^Discord did not confirm this send/u);
    assert.equal(writes(h).length, 1, "Discord did post it");
    const posted = writes(h)[0]!.messageId!;
    const first = rows(h)[0]!;
    assert.deepEqual(
      [
        first.speaker,
        first.decision,
        first.outcome,
        first.messageIds,
        first.nonce,
        first.resent,
      ],
      ["holder", "allow", "unconfirmed", [], nonces[0], []],
      "never error: the send may have posted, and its nonce says which",
    );

    // The identical retry: Discord hands back the message it already has.
    answer = await session.call("reply", {
      chat_id: CHANNEL,
      text: "deploy done",
    });
    assert.equal(answer.isError, false, answer.text);
    assert.match(answer.text, new RegExp(`\\(id ${posted}\\)`, "u"));
    assert.equal(nonces[1], nonces[0], "the retry reused the nonce");
    assert.equal(writes(h).length, 1, "one message in the room");
    let [one, two] = rows(h);
    assert.deepEqual(
      [one!.outcome, one!.messageIds, one!.nonce],
      ["sent", [posted], nonces[0]],
      "the post is the first row's, under its decision and custody",
    );
    assert.deepEqual(
      [two!.decision, two!.outcome, two!.messageIds, two!.resent],
      ["allow", "sent", [], [{ egressId: one!.id, messageId: posted }]],
      "the retry's row names it as re-sent for the first row; it posted nothing of its own",
    );

    // seat-pulse's path: `frond-ear send`, a CLI with no ear's session.
    const lost = await cliSend(socketPath, "seat gone");
    assert.equal(lost.code, 1);
    assert.match(lost.stderr, /Discord did not confirm this send/u);
    const alert = writes(h)[1]!.messageId!;
    const third = rows(h)[2]!;
    assert.deepEqual(
      [third.speaker, third.outcome, third.messageIds, third.nonce],
      ["other", "unconfirmed", [], nonces[2]],
    );
    const retried = await cliSend(socketPath, "seat gone");
    assert.equal(retried.code, 0, retried.stderr);
    assert.equal(writes(h).length, 2);
    [one, two] = rows(h).slice(2);
    assert.deepEqual([one!.outcome, one!.messageIds], ["sent", [alert]]);
    assert.deepEqual(
      [two!.outcome, two!.messageIds, two!.resent],
      ["sent", [], [{ egressId: third.id, messageId: alert }]],
    );
    assert.equal(rows(h).length, 4);
  } finally {
    session.stop();
    server.close();
    h.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unconfirmed: a retry whose answer is lost too stays tied to the same nonce; when a later retry confirms it, every row waiting on it is reconciled, and the post stays the first row's", async () => {
  const h = harness(testConfig());
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const nonces = losingAnswers(h, { "deploy done": 2 });
    const reply = () =>
      h.call(shim, "reply", { chat_id: CHANNEL, text: "deploy done" });
    assert.equal((await reply()).ok, false);
    assert.equal((await reply()).ok, false);
    assert.deepEqual(
      rows(h).map((row) => [row.outcome, row.nonce]),
      [
        ["unconfirmed", nonces[0]],
        ["unconfirmed", nonces[0]],
      ],
    );
    const result = await reply();
    assert.equal(result.ok, true, result.text);
    assert.equal(writes(h).length, 1);
    const posted = writes(h)[0]!.messageId!;
    const [one, two, three] = rows(h);
    assert.deepEqual(
      rows(h).map((row) => [row.outcome, row.messageIds, row.resent]),
      [
        ["sent", [posted], []],
        ["sent", [], [{ egressId: one!.id, messageId: posted }]],
        ["sent", [], [{ egressId: one!.id, messageId: posted }]],
      ],
    );
    assert.equal(two!.settledAt, h.clock.now());
    assert.equal(three!.nonce, null, "the last try was answered");
  } finally {
    h.dispose();
  }
});

test("unconfirmed: a concurrent identical reply that Discord answers first resolves the nonce; the first try's answer, lost after that, settles its row sent, not unconfirmed", async () => {
  const h = harness(testConfig());
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const discordSend = h.rest.sendMessage.bind(h.rest);
    let release: (() => void) | undefined;
    let tries = 0;
    h.rest.sendMessage = async (...args) => {
      tries += 1;
      const sent = await discordSend(...args);
      if (tries === 1) {
        await new Promise<void>((resolve) => (release = resolve));
        throw new TypeError("fetch failed");
      }
      return sent;
    };
    await shim.send({
      type: "call",
      id: 910,
      tool: "reply",
      args: { chat_id: CHANNEL, text: "deploy done" },
    });
    assert.ok(release, "the first try is waiting on Discord");
    const second = await h.call(shim, "reply", {
      chat_id: CHANNEL,
      text: "deploy done",
    });
    assert.equal(second.ok, true, second.text);
    const posted = writes(h)[0]!.messageId!;
    release!();
    const first = await waitFor(
      () => shim.connection.results().find((item) => item.id === 910),
      "the first try's result",
    );
    assert.equal(first.ok, false);
    assert.equal(writes(h).length, 1);
    const [one, two] = rows(h);
    assert.deepEqual(
      [one!.outcome, one!.messageIds],
      ["sent", [posted]],
      "its nonce was already confirmed when its own answer was lost",
    );
    assert.deepEqual(
      [two!.outcome, two!.messageIds, two!.resent],
      ["sent", [], [{ egressId: one!.id, messageId: posted }]],
    );
  } finally {
    h.dispose();
  }
});

test("unconfirmed across a restart: a reply a crash caught mid-send is released unconfirmed, with its nonce, when frond-ear starts; the identical retry credits that row", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-egress-"));
  const path = join(directory, "ear.db");
  try {
    let nonce = "";
    let posted = "";
    {
      const h = harness(testConfig(), { path });
      const shim = h.attach("scribe", { sessionId: SESSION });
      const discordSend = h.rest.sendMessage.bind(h.rest);
      h.rest.sendMessage = async (...args) => {
        nonce = args[3]!;
        posted = (await discordSend(...args)).id;
        return new Promise<never>(() => undefined); // the process dies first
      };
      await shim.send({
        type: "call",
        id: 920,
        tool: "reply",
        args: { chat_id: CHANNEL, text: "deploy done" },
      });
      assert.equal(rows(h)[0]!.outcome, "pending");
      // The crash: the store goes away under the call.
      h.store.close();
      rmSync(h.directory, { recursive: true, force: true });
    }

    const h = harness(testConfig(), { path });
    try {
      const released = rows(h)[0]!;
      assert.deepEqual(
        [released.outcome, released.messageIds, released.nonce],
        ["unconfirmed", [], nonce],
        "a row a previous process left pending may have posted",
      );
      // Discord still has the message under that nonce.
      const discordSend = h.rest.sendMessage.bind(h.rest);
      h.rest.sendMessage = async (...args) =>
        args[3] === nonce ? { id: posted } : discordSend(...args);
      const shim = h.attach("scribe", { sessionId: SESSION });
      const result = await h.call(shim, "reply", {
        chat_id: CHANNEL,
        text: "deploy done",
      });
      assert.equal(result.ok, true, result.text);
      const [one, two] = rows(h);
      assert.deepEqual([one!.outcome, one!.messageIds], ["sent", [posted]]);
      assert.deepEqual(
        [two!.outcome, two!.messageIds, two!.resent],
        ["sent", [], [{ egressId: one!.id, messageId: posted }]],
      );
    } finally {
      h.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unconfirmed: a reaction or an edit whose answer is lost may have applied, so its row is unconfirmed (no nonce: a retry is a write of its own); a definitive refusal is error", async () => {
  const h = harness(testConfig());
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const sent = await h.call(shim, "reply", { chat_id: CHANNEL, text: "x" });
    assert.equal(sent.ok, true, sent.text);
    const id = writes(h)[0]!.messageId!;
    h.rest.addReaction = async () => {
      throw new TypeError("fetch failed");
    };
    h.rest.editMessage = async () => {
      throw new RestError(503, undefined, "Service Unavailable");
    };
    assert.equal(
      (
        await h.call(shim, "react", {
          chat_id: CHANNEL,
          message_id: id,
          emoji: "👍",
        })
      ).ok,
      false,
    );
    assert.equal(
      (
        await h.call(shim, "edit_message", {
          chat_id: CHANNEL,
          message_id: id,
          text: "y",
        })
      ).ok,
      false,
    );
    h.rest.addReaction = async () => {
      throw new RestError(403, 50013, "Missing Permissions");
    };
    assert.equal(
      (
        await h.call(shim, "react", {
          chat_id: CHANNEL,
          message_id: id,
          emoji: "👍",
        })
      ).ok,
      false,
    );
    assert.deepEqual(
      rows(h)
        .slice(1)
        .map((row) => [row.tool, row.outcome, row.messageIds, row.nonce]),
      [
        ["react", "unconfirmed", [], null],
        ["edit_message", "unconfirmed", [], null],
        ["react", "error", [], null],
      ],
    );
  } finally {
    h.dispose();
  }
});

test("unconfirmed: a store from an earlier build of the egress gate (no unconfirmed outcome, no nonce or resent; intents with no egress row) opens with its rows kept, and records unconfirmed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-egress-"));
  const path = join(directory, "ear.db");
  try {
    const before = new EventStore(path);
    before.close();
    const database = new DatabaseSync(path);
    database.exec(`
      DROP TABLE room_egress;
      CREATE TABLE room_egress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ear TEXT NOT NULL,
        tool TEXT NOT NULL CHECK (tool IN ('reply', 'react', 'edit_message')),
        chat_id TEXT NOT NULL,
        target TEXT,
        digest TEXT NOT NULL,
        session_id TEXT,
        speaker TEXT NOT NULL CHECK (speaker IN ('holder', 'superseded', 'other')),
        policy TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('allow', 'refuse')),
        reason TEXT NOT NULL,
        history TEXT NOT NULL CHECK (history IN ('complete', 'incomplete', 'unknown')),
        reasons TEXT NOT NULL,
        boundary TEXT,
        boundary_known INTEGER NOT NULL,
        sources TEXT NOT NULL,
        since INTEGER NOT NULL,
        decided_at INTEGER NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('refused', 'pending', 'sent', 'error')),
        message_ids TEXT NOT NULL DEFAULT '[]',
        settled_at INTEGER
      );
      CREATE INDEX room_egress_ear ON room_egress (ear, decided_at);
      INSERT INTO room_egress (ear, tool, chat_id, digest, speaker, policy, decision,
          reason, history, reasons, boundary_known, sources, since, decided_at, outcome,
          message_ids, settled_at)
        VALUES ('scribe', 'reply', '${CHANNEL}', 'ab', 'holder', 'observe', 'allow',
          'observed, not enforced', 'unknown', '[]', 0, '[]', 0, 5, 'sent',
          '["900000000000000001"]', 6),
        -- Left pending by that build's process: its intents name no egress row.
          ('scribe', 'reply', '${CHANNEL}', 'cd', 'holder', 'observe', 'allow',
          'observed, not enforced', 'unknown', '[]', 0, '[]', 0, 7, 'pending',
          '[]', NULL);
    `);
    const intentColumns = (
      database.prepare("PRAGMA table_info(outbound_intents)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);
    if (intentColumns.includes("egress_id")) {
      database.exec("ALTER TABLE outbound_intents DROP COLUMN egress_id");
    }
    database.close();

    const h = harness(testConfig(), { path });
    try {
      const [old, cutOff] = rows(h);
      assert.deepEqual(
        [old!.outcome, old!.messageIds, old!.nonce, old!.resent],
        ["sent", ["900000000000000001"], null, []],
      );
      assert.deepEqual(
        [cutOff!.outcome, cutOff!.nonce, cutOff!.settledAt],
        ["unconfirmed", null, h.clock.now()],
        "no intent of that build names it, so whether it posted is unknown: never error",
      );
      const shim = h.attach("scribe", { sessionId: SESSION });
      losingAnswers(h, { "deploy done": 1 });
      await h.call(shim, "reply", { chat_id: CHANNEL, text: "deploy done" });
      const row = rows(h).at(-1)!;
      assert.equal(row.id, cutOff!.id + 1, "ids go on from the old rows");
      assert.equal(row.outcome, "unconfirmed");
    } finally {
      h.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unconfirmed at startup: of the rows a previous process left pending, a reply with a part still unanswered and a reaction are unconfirmed; a reply whose every part was answered is error, keeping the message credited when Discord confirmed it", () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-egress-"));
  const path = join(directory, "ear.db");
  try {
    const store = new EventStore(path);
    const open = (tool: "reply" | "react") =>
      store.openEgress({
        ear: "scribe",
        tool,
        chatId: CHANNEL,
        target: null,
        digest: "ab",
        sessionId: SESSION,
        speaker: "holder",
        policy: "observe",
        decision: "allow",
        reason: "observed, not enforced",
        history: "unknown",
        reasons: [],
        boundary: undefined,
        sources: [],
        since: 0,
        decidedAt: 5,
      });
    const part = (key: string) => ({ key, id: key, part: 0, parts: 1 });
    const cutMidSend = open("reply");
    store.beginSend(
      "k1",
      CHANNEL,
      "a",
      "n1",
      300_000,
      "scribe",
      part("k1"),
      cutMidSend,
    );
    const cutAfterConfirm = open("reply");
    store.beginSend(
      "k2",
      CHANNEL,
      "b",
      "n2",
      300_000,
      "scribe",
      part("k2"),
      cutAfterConfirm,
    );
    store.completeSend("n2", "900000000000000002", CHANNEL);
    const reaction = open("react");
    store.close();

    const h = harness(testConfig(), { path });
    try {
      assert.deepEqual(
        rows(h).map((row) => [row.id, row.outcome, row.nonce, row.messageIds]),
        [
          [cutMidSend, "unconfirmed", "n1", []],
          [cutAfterConfirm, "error", null, ["900000000000000002"]],
          [reaction, "unconfirmed", null, []],
        ],
      );
      assert.ok(rows(h).every((row) => row.settledAt === h.clock.now()));
      assert.ok(h.logs.some((line) => line.includes('"room.egress_released"')));
    } finally {
      h.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shutdown: a reply still waiting on Discord when the drain runs out keeps its row pending, unknown; nothing settles it after the store is handed back", async () => {
  const { h } = setup({ mode: "immediate" });
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
      id: 901,
      tool: "reply",
      args: { chat_id: CHANNEL, text: "caught by the shutdown" },
    });
    assert.ok(release, "the send is waiting on Discord");
    assert.deepEqual(await h.daemon.shutdown(20), { drained: false });
    release!();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const row = rows(h).at(-1)!;
    assert.deepEqual(
      [row.decision, row.outcome, row.settledAt],
      ["allow", "pending", null],
    );
  } finally {
    h.dispose();
  }
});

test("one decision per output: a reply's later parts go out under the decision its call got, even if a compaction is reported meanwhile; the next call is judged again", async () => {
  const { h, host } = setup(
    { mode: "immediate" },
    { roomPolicy: "strict-fresh" },
  );
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await pressure(h, "b-1");
    const push = await offered(h, host, shim, 1);
    await h.call(shim, "ack", { batch_id: push.meta.batch_id });
    const send = h.rest.sendMessage.bind(h.rest);
    let parts = 0;
    h.rest.sendMessage = async (...args) => {
      parts += 1;
      if (parts === 1) {
        h.clock.advance(1_000);
        await pressure(h, "compact-1", { tokens: null });
      }
      return send(...args);
    };
    const text = `${"a".repeat(1_990)}\n\n${"b".repeat(100)}`;
    // The report mid-send takes ticks of its own, so wait for the result itself.
    await shim.send({
      type: "call",
      id: 902,
      tool: "reply",
      args: { chat_id: CHANNEL, text },
    });
    let result = shim.connection.results().find((item) => item.id === 902);
    for (let i = 0; i < 50 && result === undefined; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      result = shim.connection.results().find((item) => item.id === 902);
    }
    assert.ok(result, "the reply answered");
    assert.equal(result.ok, true, result.text);
    assert.equal(writes(h).length, 2);
    const row = rows(h).at(-1)!;
    assert.deepEqual(
      [row.decision, row.outcome, row.messageIds.length],
      ["allow", "sent", 2],
    );
    const next = await h.call(shim, "reply", { chat_id: CHANNEL, text: "x" });
    assert.equal(next.ok, false);
    assert.match(next.text, REFUSED);
  } finally {
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
