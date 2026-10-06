import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import type { ClientMessage, DaemonMessage } from "../src/protocol.ts";
import { BOT, CHANNEL, harness, message, testConfig } from "./helpers.ts";
import type { Harness } from "./helpers.ts";

// Issue #21: the ear binds to a Claude session identity, not to whichever
// process spawned a shim last.

type Status = {
  ears: Array<{
    name: string;
    attached: boolean;
    sessionId: string | null;
    binding: { sessionId: string; cwd: string | null; source: string } | null;
    standby: number;
    delivery: string;
    hint?: string;
  }>;
};

function earStatus(h: Harness) {
  const status = h.daemon.status("scribe") as Status;
  return status.ears[0] as Status["ears"][number];
}

let requestId = 1_000;
/** An operator CLI request (frond-ear bind / the SessionStart hook). */
async function cli(
  h: Harness,
  body: Record<string, unknown> & { type: "bind" | "reentry" },
): Promise<Extract<DaemonMessage, { type: "result" }>> {
  const client = h.attach(undefined, { role: "cli" });
  const id = ++requestId;
  await client.send({ ...body, id } as ClientMessage);
  const result = client.connection.results().find((item) => item.id === id);
  assert.ok(result, `no result for ${body.type}`);
  return result;
}

function welcome(connection: { received: DaemonMessage[] }) {
  const item = connection.received.find((entry) => entry.type === "welcome");
  assert.ok(item?.type === "welcome");
  return item;
}

const mention = (content: string) =>
  message({ content: `<@${BOT}> ${content}`, mentions: [{ id: BOT }] });

test("a second session cannot take a bound ear: it gets tools and a standby notice, the owner keeps hearing", async () => {
  const h = harness();
  try {
    const owner = h.attach("scribe", { sessionId: "session-a", cwd: "/work" });
    const stray = h.attach("scribe", { sessionId: "session-b" });

    const strayWelcome = welcome(stray.connection);
    assert.equal(strayWelcome.attached, false);
    assert.equal(strayWelcome.standby, true);
    assert.match(
      strayWelcome.error ?? "",
      /frond-ear bind --ear scribe --session session-b/u,
    );
    assert.equal(
      owner.connection.received.some((item) => item.type === "detached"),
      false,
      "the owner is never superseded by a stranger",
    );

    h.daemon.ingest(mention("are you there"));
    h.timers.advance(5_000);
    assert.equal(owner.connection.events().length, 1);
    assert.equal(stray.connection.events().length, 0);

    const inbox = await h.call(stray, "inbox", {});
    assert.match(inbox.text, /are you there/u);
    assert.match(inbox.text, /read-only/u);
    assert.match(inbox.text, /belongs to session session-a \(live\)/u);
    assert.match(strayWelcome.instructions, /not the owner of ear "scribe"/u);
    assert.doesNotMatch(strayWelcome.instructions, /your own ear/u);

    // A stray cannot speak, react or choose attention as the ear.
    for (const [tool, args] of [
      ["reply", { chat_id: CHANNEL, text: "hi from the wrong session" }],
      ["react", { chat_id: CHANNEL, message_id: CHANNEL, emoji: "👀" }],
      ["ack", { chat_id: CHANNEL }],
      ["set_attention", { mode: "silent" }],
    ] as const) {
      const refused = await h.call(stray, tool, args);
      assert.equal(refused.ok, false, tool);
      assert.match(
        refused.text,
        /^refused: ear "scribe" belongs to session session-a/u,
      );
    }
    assert.equal(h.rest.calls.length, 0, "nothing reached Discord");

    const status = earStatus(h);
    assert.equal(status.attached, true);
    assert.equal(status.sessionId, "session-a");
    assert.deepEqual(
      { ...status.binding, boundAt: undefined },
      {
        ear: "scribe",
        sessionId: "session-a",
        cwd: "/work",
        source: "claim",
        boundAt: undefined,
        claudePid: null,
        previousSession: null,
      },
    );
    assert.equal(status.standby, 1);
  } finally {
    h.dispose();
  }
});

test("a shim with no session id (health check, old client) never holds the ear, even an unbound one", () => {
  const h = harness();
  try {
    // An empty id is what a client without CLAUDE_CODE_SESSION_ID amounts to.
    const anonymous = h.attach("scribe", { sessionId: "" });
    assert.equal(welcome(anonymous.connection).attached, false);
    assert.equal(earStatus(h).binding, null);
    // The real session still claims it afterwards.
    h.attach("scribe", { sessionId: "session-a" });
    assert.equal(earStatus(h).binding?.sessionId, "session-a");
  } finally {
    h.dispose();
  }
});

test("bind moves the ear on purpose: a waiting session attaches at once and the old owner is told why", async () => {
  const h = harness();
  try {
    const owner = h.attach("scribe", { sessionId: "session-a" });
    const next = h.attach("scribe", { sessionId: "session-b", cwd: "/next" });

    const result = await cli(h, {
      type: "bind",
      ear: "scribe",
      sessionId: "session-b",
    });
    assert.equal(result.ok, true, result.text);
    assert.match(result.text, /attached/u);
    assert.deepEqual(owner.connection.received.at(-1), {
      type: "detached",
      reason: "rebound to session session-b",
    });
    const attached = next.connection.received.filter(
      (item) => item.type === "welcome" && item.attached,
    );
    assert.equal(attached.length, 1);
    assert.equal(earStatus(h).binding?.source, "operator");
    assert.equal(earStatus(h).binding?.cwd, "/next");

    // The old owner's shim reconnecting is now the stranger.
    const back = h.attach("scribe", { sessionId: "session-a" });
    assert.equal(welcome(back.connection).standby, true);
    assert.equal(earStatus(h).sessionId, "session-b");
  } finally {
    h.dispose();
  }
});

test("a shim cannot send reentry: only the hook's CLI connection can report a /clear", async () => {
  const h = harness();
  try {
    h.attach("scribe", {
      sessionId: "session-a",
      launch: { pid: 4242, channels: true },
    });
    const stray = h.attach("scribe", { sessionId: "session-b" });
    await stray.send({
      type: "reentry",
      id: 9,
      sessionId: "session-b",
      source: "clear",
      launch: { pid: 4242, channels: true },
    });
    const refused = stray.connection.results().find((item) => item.id === 9);
    assert.equal(refused?.ok, false);
    assert.equal(earStatus(h).binding?.sessionId, "session-a");
  } finally {
    h.dispose();
  }
});

test("bind is operator-only and validates its input", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe", { sessionId: "session-a" });
    await shim.send({
      type: "bind",
      id: 7,
      ear: "scribe",
      sessionId: "session-evil",
    });
    const refused = shim.connection.results().find((item) => item.id === 7);
    assert.equal(refused?.ok, false);
    assert.equal(earStatus(h).binding?.sessionId, "session-a");

    const unknown = await cli(h, {
      type: "bind",
      ear: "nope",
      sessionId: "x",
    });
    assert.equal(unknown.ok, false);
    const bad = await cli(h, {
      type: "bind",
      ear: "scribe",
      sessionId: "../../etc; rm -rf",
    });
    assert.equal(bad.ok, false);
    assert.equal(earStatus(h).binding?.sessionId, "session-a");
  } finally {
    h.dispose();
  }
});

test("a connection cannot relabel itself as the owner after hello", async () => {
  const h = harness();
  try {
    h.attach("scribe", { sessionId: "session-a" });
    const stray = h.attach("scribe", { sessionId: "session-b" });
    await stray.send({ type: "session", sessionId: "session-a" });
    await stray.send({
      type: "hello",
      role: "shim",
      protocol: 1,
      ear: "scribe",
      sessionId: "session-a",
    });
    // A second hello on a live connection is not a way in: identity is fixed.
    assert.equal(earStatus(h).binding?.sessionId, "session-a");
  } finally {
    h.dispose();
  }
});

test("release leaves the ear unbound; the next session to attach claims it", async () => {
  const h = harness();
  try {
    const owner = h.attach("scribe", { sessionId: "session-a" });
    const result = await cli(h, {
      type: "bind",
      ear: "scribe",
      sessionId: null,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(owner.connection.received.at(-1), {
      type: "detached",
      reason: "released",
    });
    assert.equal(earStatus(h).binding, null);
    h.attach("scribe", { sessionId: "session-c" });
    assert.equal(earStatus(h).binding?.sessionId, "session-c");
    assert.equal(earStatus(h).attached, true);
  } finally {
    h.dispose();
  }
});

test("the binding survives a daemon restart, and what arrived meanwhile reaches only the owner, once", async () => {
  const h = harness();
  const path = join(h.directory, "restart.db");
  try {
    const before = harness(testConfig(), { path });
    before.attach("scribe", { sessionId: "session-a", cwd: "/work" });
    before.daemon.shutdown();

    const after = harness(testConfig(), { path });
    after.daemon.ingest(mention("while you were away"));
    after.timers.advance(5_000);
    // A stray gets there first after the reboot: it must not inherit the ear.
    const stray = after.attach("scribe", { sessionId: "session-z" });
    assert.equal(welcome(stray.connection).standby, true);
    assert.equal(stray.connection.events().length, 0);
    const owner = after.attach("scribe", { sessionId: "session-a" });
    const delivered = owner.connection
      .events()
      .filter((event) => event.batchId !== null);
    assert.equal(delivered.length, 1);
    assert.match(delivered[0]?.content ?? "", /while you were away/u);
    assert.equal(
      (after.daemon.status("scribe") as Status).ears[0]?.binding?.cwd,
      "/work",
    );
    after.daemon.shutdown();
  } finally {
    h.dispose();
  }
});

test("resuming the owner under a new session id keeps the ear, but only while the owner is not live", () => {
  const h = harness();
  try {
    const owner = h.attach("scribe", { sessionId: "session-a", cwd: "/work" });
    const twin = h.attach("scribe", {
      sessionId: "session-a2",
      launch: { pid: 2, channels: true, resumed: "session-a" },
    });
    assert.equal(
      welcome(twin.connection).standby,
      true,
      "the live owner keeps it",
    );
    owner.close();
    const resumed = h.attach("scribe", {
      sessionId: "session-a3",
      launch: { pid: 3, channels: true, resumed: "session-a" },
    });
    assert.equal(welcome(resumed.connection).attached, true);
    assert.equal(earStatus(h).binding?.sessionId, "session-a3");
    assert.equal(earStatus(h).binding?.source, "resume");
    assert.equal(earStatus(h).binding?.cwd, "/work");
    // Resuming some other transcript is not a way in.
    resumed.close();
    const other = h.attach("scribe", {
      sessionId: "session-q",
      launch: { pid: 4, channels: true, resumed: "session-zzz" },
    });
    assert.equal(welcome(other.connection).standby, true);
  } finally {
    h.dispose();
  }
});

test("a session launched without the channel flag is reported deaf immediately, with the rez command", async () => {
  const h = harness(
    testConfig({
      ears: {
        scribe: { attachCanary: true, channels: { [CHANNEL]: "mentions" } },
      },
    }),
  );
  try {
    const deaf = h.attach("scribe", {
      sessionId: "session-a",
      cwd: "/work",
      launch: { pid: 4242, channels: false },
    });
    const status = earStatus(h);
    assert.equal(status.delivery, "unconfirmed");
    assert.match(
      status.hint ?? "",
      /launched without frond-ear's channel flag/u,
    );
    assert.match(status.hint ?? "", /frond-ear rez --ear scribe/u);
    assert.match(
      status.hint ?? "",
      /cd \/work && claude --resume session-a --dangerously-load-development-channels/u,
    );
    const inbox = await h.call(deaf, "inbox", {});
    assert.match(inbox.text, /⚠️ frond-ear: .*launched without/u);

    // A flagged launch waits for the canary as before.
    const heard = harness();
    try {
      heard.attach("scribe", {
        sessionId: "session-a",
        launch: { pid: 1, channels: true },
      });
      assert.equal(earStatus(heard).delivery, "confirmed");
    } finally {
      heard.dispose();
    }
  } finally {
    h.dispose();
  }
});

test("re-entry hook: the owner hears where it stands; a deaf owner and a non-owner are told plainly", async () => {
  const h = harness();
  try {
    h.attach("scribe", { sessionId: "session-a", cwd: "/work" });
    h.daemon.ingest(mention("one"));

    const owner = await cli(h, {
      type: "reentry",
      sessionId: "session-a",
      source: "compact",
      launch: { pid: 1, channels: true },
    });
    assert.match(owner.text, /this session owns ear "scribe" \(compact\)/u);
    assert.match(owner.text, /compacted; inbox/u);
    assert.match(owner.text, /1 Discord message\(s\) are waiting/u);

    const deaf = await cli(h, {
      type: "reentry",
      sessionId: "session-a",
      source: "resume",
      launch: { pid: 1, channels: false },
    });
    assert.match(deaf.text, /⚠️ frond-ear: .* NOT hear Discord pushes/u);
    assert.match(deaf.text, /frond-ear rez --ear scribe/u);

    const other = await cli(h, {
      type: "reentry",
      sessionId: "session-b",
      source: "startup",
      ear: "scribe",
    });
    assert.match(other.text, /belongs to session session-a/u);

    const unrelated = await cli(h, {
      type: "reentry",
      sessionId: "session-b",
      source: "startup",
    });
    assert.equal(
      unrelated.text,
      "",
      "sessions that did not ask about an ear hear nothing",
    );
  } finally {
    h.dispose();
  }
});

test("re-entry hook: /clear moves the binding only when it comes from the owner's own Claude process", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe", {
      sessionId: "session-a",
      launch: { pid: 4242, channels: true },
    });
    const stranger = await cli(h, {
      type: "reentry",
      sessionId: "session-x",
      source: "clear",
      launch: { pid: 9999, channels: true },
    });
    assert.doesNotMatch(stranger.text, /moved/u);
    assert.equal(earStatus(h).binding?.sessionId, "session-a");

    const cleared = await cli(h, {
      type: "reentry",
      sessionId: "session-a2",
      source: "clear",
      launch: { pid: 4242, channels: true },
    });
    assert.match(cleared.text, /ear "scribe" moved with it/u);
    assert.equal(earStatus(h).binding?.sessionId, "session-a2");
    assert.equal(earStatus(h).binding?.source, "clear");
    // The same shim keeps the ear; nothing was detached.
    assert.equal(
      shim.connection.received.some((item) => item.type === "detached"),
      false,
    );
    assert.equal(earStatus(h).attached, true);

    // That process's shim reconnecting (daemon restart) still carries the
    // pre-/clear id in its environment: same pid, old id, so still the owner.
    shim.close();
    const again = h.attach("scribe", {
      sessionId: "session-a",
      launch: { pid: 4242, channels: true },
    });
    assert.equal(welcome(again.connection).attached, true);
    assert.equal(earStatus(h).sessionId, "session-a2");
    again.close();
    // The old id from any other process is a stranger.
    const impostor = h.attach("scribe", {
      sessionId: "session-a",
      launch: { pid: 5555, channels: true },
    });
    assert.equal(welcome(impostor.connection).standby, true);
  } finally {
    h.dispose();
  }
});
