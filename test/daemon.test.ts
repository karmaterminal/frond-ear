import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { targetAdvice } from "../src/advice.ts";
import { chunkMessage, RestError } from "../src/rest.ts";
import { renderAmbiguousSends } from "../src/render.ts";
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

test("takeover detaches the old shim; offered-but-unseen work becomes one digest, not a replay", async () => {
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

/** Setup advice only a Claude session should get; a Copilot ear must never see it (#39). */
const CLAUDE_ADVICE =
  /claude mcp|claude --|dangerously-load-development-channels|Claude Code/u;
const COPILOT_ADVICE = /copilot-extension --ear|copilot --experimental/u;

/** The ear's `status` view: delivery state and, when unconfirmed, the warning text. */
function delivery(h: ReturnType<typeof harness>): {
  delivery: string;
  hint?: string;
} {
  const status = h.daemon.status("scribe") as {
    ears: Array<{ delivery: string; hint?: string }>;
  };
  assert.ok(status.ears[0]);
  return status.ears[0];
}

test("delivery: an unacked canary on a claude-channel ear is reported as deaf, with #30's proofs and the relaunch hint", async () => {
  const config = testConfig({
    ears: {
      scribe: { attachCanary: true, channels: { [CHANNEL]: "mentions" } },
    },
  });
  const h = harness(config, { nonce: "c0ffee", env: {} });
  try {
    // No session id reported: the relaunch still resumes, with a placeholder.
    const shim = h.attach("scribe");
    assert.equal(delivery(h).delivery, "pending");

    h.clock.advance(2 * 60 * 1_000);
    assert.equal(delivery(h).delivery, "unconfirmed");
    const hint = delivery(h).hint ?? "";
    assert.match(
      hint,
      /^this session never acked frond-ear's attach canary or used a pushed batch_id in its token form, so frond-ear cannot confirm/u,
    );
    assert.match(hint, /act on a pushed batch_id exactly as .* \(N-<token>\)/u);
    assert.ok(
      hint.includes(
        "If no <channel> events arrive at all: Claude Code delivers channel events only to a session launched with the development-channel flag: claude --resume <session-id> --dangerously-load-development-channels server:frond-ear.",
      ),
      hint,
    );
    assert.doesNotMatch(hint, COPILOT_ADVICE);
    const deaf = await h.call(shim, "inbox", { chat_id: CHANNEL });
    assert.ok(deaf.text.endsWith(`\n\n⚠️ frond-ear: ${hint}`), deaf.text);
    // Once the shim reports its session id, the relaunch names it.
    await shim.send({ type: "session", sessionId: "session-b" });
    assert.match(
      delivery(h).hint ?? "",
      / claude --resume session-b --dangerously-load-development-channels server:frond-ear\. /u,
    );

    assert.equal((await h.call(shim, "ack", { nonce: "c0ffee" })).ok, true);
    assert.equal(delivery(h).delivery, "confirmed");
    const heard = await h.call(shim, "inbox", { chat_id: CHANNEL });
    assert.doesNotMatch(heard.text, /⚠️ frond-ear/u);
  } finally {
    h.dispose();
  }
});

test("delivery: a deaf copilot-extension session gets the Copilot fix, never Claude's relaunch (#39)", async () => {
  const config = testConfig({
    ears: {
      scribe: {
        target: "copilot-extension",
        attachCanary: true,
        channels: { [CHANNEL]: "mentions" },
      },
    },
  });
  const socket = "/run/frond-ear-test/daemon.sock";
  const env = { FROND_EAR_SOCKET: socket };
  const h = harness(config, { nonce: "c0ffee", env });
  try {
    const shim = h.attach("scribe", { sessionId: "copilot-session-1" });
    h.clock.advance(2 * 60 * 1_000);
    assert.equal(delivery(h).delivery, "unconfirmed");
    const hint = delivery(h).hint ?? "";
    assert.ok(
      hint.includes(
        'If no <channel> events arrive at all: check the Copilot session for "frond-ear: could not deliver batch"',
      ) && hint.includes("Copilot started with copilot --experimental;"),
      hint,
    );
    // The reinstall carries the daemon's own socket, so it reaches this daemon.
    assert.ok(
      hint.includes(
        `after upgrading frond-ear, re-run the install: FROND_EAR_SOCKET=${socket} `,
      ) &&
        hint.includes(
          " copilot-extension --ear scribe. Until then, read new messages with inbox.",
        ),
      hint,
    );
    assert.ok(
      hint.includes(
        `If no <channel> events arrive at all: ${targetAdvice({ name: "scribe", target: "copilot-extension" }, env)?.deaf}.`,
      ),
      "the same advice doctor prints",
    );
    assert.match(hint, /\(N-<token>\)/u);
    assert.doesNotMatch(hint, CLAUDE_ADVICE);
    const deaf = await h.call(shim, "inbox", { chat_id: CHANNEL });
    assert.ok(deaf.text.endsWith(`\n\n⚠️ frond-ear: ${hint}`), deaf.text);
    assert.doesNotMatch(deaf.text, CLAUDE_ADVICE);
  } finally {
    h.dispose();
  }
});

test("delivery: a deaf copilot-extension session on a TCP daemon is told a TCP reinstall, never a socket one (#40 review)", async () => {
  const config = testConfig({
    ears: {
      scribe: {
        target: "copilot-extension",
        attachCanary: true,
        channels: { [CHANNEL]: "mentions" },
      },
    },
  });
  // The installer writes a unix socket unless FROND_EAR_TCP is set (cli.ts), so a
  // socket-only reinstall would replace this ear's working TCP config.
  // A real token file: its path is advice, its contents never are.
  const secret = "tcp-shared-secret-never-printed";
  const directory = mkdtempSync(join(tmpdir(), "frond-ear tcp-"));
  const tokenFile = join(directory, "tcp-token");
  writeFileSync(tokenFile, `${secret}\n`, { mode: 0o600 });
  const env = {
    FROND_EAR_TCP: "127.0.0.1:7461",
    FROND_EAR_TOKEN_FILE: tokenFile,
  };
  const h = harness(config, { nonce: "c0ffee", env });
  try {
    const shim = h.attach("scribe", { sessionId: "copilot-session-1" });
    h.clock.advance(2 * 60 * 1_000);
    const hint = delivery(h).hint ?? "";
    assert.ok(
      hint.includes(
        `after upgrading frond-ear, re-run the install: FROND_EAR_TCP=127.0.0.1:7461 FROND_EAR_TOKEN_FILE='${tokenFile}' `,
      ) && hint.includes(" copilot-extension --ear scribe. Until then"),
      hint,
    );
    assert.doesNotMatch(hint, /FROND_EAR_SOCKET/u);
    assert.doesNotMatch(hint, new RegExp(secret, "u"));
    const deaf = await h.call(shim, "inbox", { chat_id: CHANNEL });
    assert.ok(deaf.text.endsWith(`\n\n⚠️ frond-ear: ${hint}`), deaf.text);
    assert.doesNotMatch(deaf.text, new RegExp(secret, "u"));
  } finally {
    h.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("advice: a TCP env without a token file names a placeholder, never a guessed path or a socket", () => {
  const advice = targetAdvice(
    { name: "scribe", target: "copilot-extension" },
    { FROND_EAR_TCP: "127.0.0.1:7461", FROND_EAR_SOCKET: "/run/x.sock" },
  );
  assert.ok(advice);
  for (const text of [advice.attach, advice.deaf]) {
    assert.match(
      text,
      /FROND_EAR_TCP=127\.0\.0\.1:7461 FROND_EAR_TOKEN_FILE=<token-file> \S+ \S+ copilot-extension --ear scribe \(replace <token-file> with the daemon's FROND_EAR_TOKEN_FILE path/u,
    );
    assert.doesNotMatch(text, /FROND_EAR_SOCKET/u);
  }
});

test("delivery: an ear target with no advice gets the proofs and inbox, no guessed setup", async () => {
  const config = testConfig({
    ears: {
      scribe: { attachCanary: true, channels: { [CHANNEL]: "mentions" } },
    },
  });
  // config.ts rejects reserved targets; force one to reach the no-advice branch.
  (config.ears.scribe as { target: string }).target = "copilot-sdk";
  const h = harness(config, { nonce: "c0ffee", env: {} });
  try {
    const shim = h.attach("scribe");
    h.clock.advance(2 * 60 * 1_000);
    const deaf = await h.call(shim, "inbox", { chat_id: CHANNEL });
    assert.match(
      deaf.text,
      /⚠️ frond-ear: this session never acked frond-ear's attach canary/u,
    );
    assert.match(
      deaf.text,
      /\(N-<token>\)\. Until then, read new messages with inbox\.$/u,
    );
    assert.doesNotMatch(deaf.text, CLAUDE_ADVICE);
    assert.doesNotMatch(deaf.text, COPILOT_ADVICE);
  } finally {
    h.dispose();
  }
});

test("delivery: acting on a pushed batch by its batch_id proves delivery when the canary was lost (#21)", async () => {
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
        ears: Array<{ delivery: string; registered: boolean }>;
      };
    // The canary is never acked (lost before the session could take it).
    h.daemon.ingest(
      message({
        author: { id: PRINCIPAL },
        mentions: [{ id: BOT }],
        content: "can you hear me?",
      }),
    );
    h.timers.advance(1_000);
    const pushed = shim.connection.events().at(-1);
    const batchId = pushed?.batchId as number;
    await shim.send({ type: "offered", batchId });
    h.clock.advance(2 * 60 * 1_000);
    assert.equal(status().ears[0]?.delivery, "unconfirmed");

    // The pushed batch_id carries a delivery token only the push has: using it
    // proves delivery.
    assert.match(
      pushed?.meta.batch_id ?? "",
      new RegExp(`^${batchId}-[0-9a-f]+$`, "u"),
    );
    const reply = await h.call(shim, "reply", {
      chat_id: CHANNEL,
      text: "yes",
      batch_id: pushed?.meta.batch_id,
    });
    assert.equal(reply.ok, true);
    assert.doesNotMatch(reply.text, /⚠️ frond-ear/u);
    assert.equal(status().ears[0]?.delivery, "confirmed");
    assert.equal(status().ears[0]?.registered, true);
  } finally {
    h.dispose();
  }
});

test("delivery: a batch_id learned from a tap marks seen but does not prove delivery (#21)", async () => {
  const config = testConfig({
    ears: {
      scribe: { attachCanary: true, channels: { [CHANNEL]: "mentions" } },
    },
  });
  const h = harness(config, { nonce: "c0ffee" });
  try {
    // A deaf session: attached, canary never acked, no push reaches the model.
    const shim = h.attach("scribe");
    const tap = h.attach("scribe", { role: "tap" });
    h.daemon.ingest(
      message({
        author: { id: PRINCIPAL },
        mentions: [{ id: BOT }],
        content: "anyone there?",
      }),
    );
    h.timers.advance(1_000);
    const pushed = shim.connection.events().at(-1);
    const batchId = pushed?.batchId as number;
    await shim.send({ type: "offered", batchId });
    h.clock.advance(2 * 60 * 1_000);
    // What `frond-ear tap` prints: the bare id, never the session's token.
    const tapped = tap.connection.events().at(-1);
    assert.equal(tapped?.batchId, batchId);
    assert.equal(tapped?.meta.batch_id, String(batchId));
    assert.equal(h.store.stateCounts("scribe").offered, 1);

    const acked = await h.call(shim, "ack", {
      chat_id: CHANNEL,
      batch_id: tapped?.meta.batch_id,
    });
    assert.equal(acked.ok, true);
    assert.equal(h.store.stateCounts("scribe").seen, 1);
    // The bare id with a forged token proves nothing either.
    await h.call(shim, "ack", {
      chat_id: CHANNEL,
      batch_id: `${batchId}-00000000`,
    });
    const status = h.daemon.status("scribe") as {
      ears: Array<{ delivery: string; registered: boolean }>;
    };
    assert.equal(status.ears[0]?.registered, false);
    assert.equal(status.ears[0]?.delivery, "unconfirmed");
  } finally {
    h.dispose();
  }
});

test("delivery: a batch_id that was never pushed to this attach does not prove delivery", async () => {
  const config = testConfig({
    ears: {
      scribe: { attachCanary: true, channels: { [CHANNEL]: "mentions" } },
    },
  });
  const h = harness(config, { nonce: "c0ffee" });
  try {
    const first = h.attach("scribe");
    h.daemon.ingest(
      message({
        author: { id: PRINCIPAL },
        mentions: [{ id: BOT }],
        content: "for the first attach",
      }),
    );
    h.timers.advance(1_000);
    const earlier = first.connection.events().at(-1)?.batchId as number;
    await first.send({ type: "offered", batchId: earlier });
    // A new attach (new generation) that guesses or carries over an old batch id…
    const second = h.attach("scribe");
    h.clock.advance(2 * 60 * 1_000);
    await h.call(second, "ack", { chat_id: CHANNEL, batch_id: earlier });
    // …and one that names a batch that doesn't exist.
    await h.call(second, "ack", { chat_id: CHANNEL, batch_id: 99_999 });
    const status = h.daemon.status("scribe") as {
      ears: Array<{ delivery: string }>;
    };
    assert.equal(status.ears[0]?.delivery, "unconfirmed");
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
    // Except the session's delivery token: the tap gets the bare batch id (#21).
    assert.deepEqual(tapped, {
      ...pushed,
      meta: { ...pushed.meta, batch_id: String(pushed.batchId) },
    });
    assert.notEqual(pushed.meta.batch_id, String(pushed.batchId));
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

// ---- unconfirmed sends: who is asked to check them, and for how long (#49) ---

/** Discord takes every post, but no response arrives: each send stays unconfirmed. */
function loseEveryResponse(h: helpers.Harness): void {
  const discordSend = h.rest.sendMessage.bind(h.rest);
  h.rest.sendMessage = async (...args) => {
    await discordSend(...args);
    throw new TypeError("fetch failed");
  };
}

function sendChecks(shim: { connection: helpers.MemoryConnection }) {
  return shim.connection
    .events()
    .filter((event) => event.meta.kind === "send_check");
}

function unconfirmed(h: helpers.Harness): Array<[string, string | null]> {
  const status = h.daemon.status() as {
    ambiguousSends: Array<{ preview: string; sessionEar: string | null }>;
  };
  return status.ambiguousSends.map((send) => [send.preview, send.sessionEar]);
}

test("an unconfirmed send is put only to the session that made it, at its next attach (#49)", async () => {
  const h = harness(
    testConfig({
      ears: {
        scribe: { attachCanary: false, channels: { [CHANNEL]: "mentions" } },
        other: { attachCanary: false, channels: { [ROOM]: "room" } },
      },
    }),
  );
  try {
    loseEveryResponse(h);
    const script = h.attach(undefined, { role: "cli" }); // what `frond-ear send` is
    const scribe = h.attach("scribe");
    for (const [client, chat, text] of [
      [script, CHANNEL, "⚠️ frond-gloss@silas: tmux session gone"],
      [scribe, CHANNEL, "scribe's own reply"],
      [scribe, ROOM, "scribe's reply in the other ear's room"],
    ] as const) {
      const result = await h.call(client, "reply", { chat_id: chat, text });
      assert.match(result.text, /may already have been posted/u);
      h.clock.advance(1_000);
    }
    assert.deepEqual(
      unconfirmed(h),
      [
        ["⚠️ frond-gloss@silas: tmux session gone", null],
        ["scribe's own reply", "scribe"],
        ["scribe's reply in the other ear's room", "scribe"],
      ],
      "status shows every unconfirmed send, and which session made it",
    );

    const other = h.attach("other");
    assert.deepEqual(
      sendChecks(other),
      [],
      "the room's ear did not write the send made into its room",
    );
    const back = h.attach("scribe"); // supersedes the first scribe session
    const checks = sendChecks(back);
    assert.equal(checks.length, 1);
    assert.equal(checks[0]?.meta.count, "2");
    assert.match(checks[0]?.content ?? "", /scribe's own reply/u);
    assert.match(checks[0]?.content ?? "", /the other ear's room/u);
    assert.doesNotMatch(
      checks[0]?.content ?? "",
      /tmux session gone/u,
      "a script's send is not a session's to check",
    );
  } finally {
    h.dispose();
  }
});

test("a replaced session's unconfirmed send still goes to its ear's next session (#49)", async () => {
  const h = harness();
  try {
    loseEveryResponse(h);
    const first = h.attach("scribe");
    h.attach("scribe"); // a second session takes the ear; the first keeps its tools
    await h.call(first, "reply", {
      chat_id: CHANNEL,
      text: "from the replaced session",
    });
    assert.deepEqual(unconfirmed(h), [["from the replaced session", "scribe"]]);
    const checks = sendChecks(h.attach("scribe"));
    assert.equal(checks.length, 1);
    assert.match(checks[0]?.content ?? "", /from the replaced session/u);
  } finally {
    h.dispose();
  }
});

test("a session retrying a script's unconfirmed send is told about it; a script's retry changes nothing (#49)", async () => {
  const h = harness();
  try {
    loseEveryResponse(h);
    const script = h.attach(undefined, { role: "cli" });
    const shim = h.attach("scribe");
    // Each pair is sent twice inside the reuse window, so the retry reuses the nonce.
    await h.call(script, "reply", { chat_id: CHANNEL, text: "script first" });
    await h.call(shim, "reply", { chat_id: CHANNEL, text: "script first" });
    h.clock.advance(1_000);
    await h.call(shim, "reply", { chat_id: CHANNEL, text: "session first" });
    await h.call(script, "reply", { chat_id: CHANNEL, text: "session first" });
    assert.equal(
      h.rest.calls.filter((call) => call.method === "send").length,
      2,
      "Discord de-duplicated both retries",
    );
    assert.deepEqual(unconfirmed(h), [
      ["script first", "scribe"],
      ["session first", "scribe"],
    ]);
    const checks = sendChecks(h.attach("scribe"));
    assert.equal(checks[0]?.meta.count, "2");
  } finally {
    h.dispose();
  }
});

test("the prune drops an unconfirmed send once it is past retention (#49)", async () => {
  const h = harness();
  try {
    loseEveryResponse(h);
    const shim = h.attach("scribe");
    const retentionMs = testConfig().limits.retentionMs;
    await h.call(shim, "reply", { chat_id: CHANNEL, text: "an old reply" });
    h.clock.advance(retentionMs - 1_000);
    await h.call(shim, "reply", { chat_id: CHANNEL, text: "a recent reply" });
    h.clock.advance(2_000);
    h.daemon.prune();
    assert.deepEqual(unconfirmed(h), [["a recent reply", "scribe"]]);
    const checks = sendChecks(h.attach("scribe"));
    assert.equal(checks.length, 1);
    assert.match(checks[0]?.content ?? "", /a recent reply/u);
    assert.doesNotMatch(checks[0]?.content ?? "", /an old reply/u);
  } finally {
    h.dispose();
  }
});

test("a database from before session_ear gains it, and its unconfirmed sends go to no session (#49)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-legacy-"));
  const path = join(directory, "ear.db");
  try {
    // outbound_intents as it shipped before #49, with a pending row from a
    // minute before the upgrade (the harness clock starts at 1_000_000).
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE outbound_intents (
        nonce TEXT PRIMARY KEY,
        intent_key TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        preview TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'failed')),
        message_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO outbound_intents VALUES ('legacy-nonce', 'legacy-key', '${CHANNEL}',
        'a reply from before the upgrade', 'pending', NULL, 940000, 940000);
    `);
    legacy.close();

    const h = harness(testConfig(), { path });
    try {
      loseEveryResponse(h);
      assert.deepEqual(unconfirmed(h), [
        ["a reply from before the upgrade", null],
      ]);
      const shim = h.attach("scribe");
      assert.deepEqual(sendChecks(shim), [], "an older row names no session");
      await h.call(shim, "reply", {
        chat_id: CHANNEL,
        text: "a reply after the upgrade",
      });
      const checks = sendChecks(h.attach("scribe"));
      assert.equal(checks.length, 1);
      assert.match(checks[0]?.content ?? "", /a reply after the upgrade/u);
      assert.doesNotMatch(checks[0]?.content ?? "", /before the upgrade/u);
    } finally {
      h.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ---- retrying a long reply resumes it instead of posting it again (#55) -----

/** Three parts once chunked: 1500 a's, then 1500 b's, then 1500 c's. */
const LONG = ["a", "b", "c"].map((letter) => letter.repeat(1_500)).join("\n\n");
const WINDOW_MS = 5 * 60_000;

/** What Discord shows, one letter per message: "abc" is each part of LONG once. */
function posted(h: helpers.Harness): string {
  return h.rest.calls
    .filter((call) => call.method === "send")
    .map((call) => call.content?.charAt(0))
    .join("");
}

function postedIds(h: helpers.Harness): string[] {
  return h.rest.calls
    .filter((call) => call.method === "send")
    .map((call) => call.messageId as string);
}

/** Discord takes these posts (counted from 1, retries included), but each response is lost. */
function loseResponsesTo(h: helpers.Harness, ...posts: number[]): void {
  const discordSend = h.rest.sendMessage.bind(h.rest);
  let count = 0;
  h.rest.sendMessage = async (...args) => {
    const sent = await discordSend(...args);
    count += 1;
    if (posts.includes(count)) {
      throw new TypeError("fetch failed");
    }
    return sent;
  };
}

/** Discord refuses these posts (counted from 1, retries included) outright. */
function refusePosts(h: helpers.Harness, ...posts: number[]): void {
  const discordSend = h.rest.sendMessage.bind(h.rest);
  let count = 0;
  h.rest.sendMessage = async (...args) => {
    count += 1;
    if (posts.includes(count)) {
      throw new RestError(
        403,
        50013,
        `Discord POST /channels/${CHANNEL}/messages failed: 403 Missing Permissions`,
      );
    }
    return discordSend(...args);
  };
}

test("a long reply retried after an unconfirmed part posts only what did not go out (#55)", async () => {
  const h = harness();
  try {
    loseResponsesTo(h, 2);
    const shim = h.attach("scribe");
    const args = { chat_id: CHANNEL, text: LONG, reply_to: "42" };
    const first = await h.call(shim, "reply", args);
    assert.equal(first.ok, false);
    const [one] = postedIds(h);
    assert.equal(
      first.text,
      `Discord did not confirm part 2 of 3 (fetch failed); it may already have been posted. ` +
        `Part 1 was sent (id ${one}). Part 3 was not sent. ` +
        `Retrying the identical text and reply_to within 5 minutes is safe: frond-ear does not post part 1 again ` +
        `and reuses part 2's nonce, so Discord returns the original instead of posting it twice.`,
    );
    assert.equal(posted(h), "ab");

    h.clock.advance(WINDOW_MS - 1_000);
    const retry = await h.call(shim, "reply", args);
    assert.equal(retry.ok, true, retry.text);
    assert.equal(posted(h), "abc", "parts 1 and 2 are not posted again");
    assert.equal(
      retry.text,
      `sent 3 messages to ${CHANNEL} (ids ${postedIds(h).join(", ")}); ` +
        `part 1 had gone out on an earlier try and was not posted again`,
    );
    assert.equal(h.rest.calls[0]?.replyTo, "42");
    assert.deepEqual(unconfirmed(h), [], "part 2 is confirmed now");
  } finally {
    h.dispose();
  }
});

test("a long reply refused partway names what went out, and a retry posts only the rest (#55)", async () => {
  const h = harness();
  try {
    refusePosts(h, 1, 3);
    const script = h.attach(undefined, { role: "cli" }); // what `frond-ear send` is
    const args = { chat_id: CHANNEL, text: LONG };
    const refused = `Discord POST /channels/${CHANNEL}/messages failed: 403 Missing Permissions`;
    const first = await h.call(script, "reply", args);
    assert.equal(first.text, `${refused} (part 1 of 3). Nothing was posted.`);
    const second = await h.call(script, "reply", args);
    assert.equal(
      second.text,
      `${refused} (part 2 of 3). Part 1 was sent (id ${postedIds(h)[0]}). Parts 2 and 3 were not posted. ` +
        `Retrying the identical text within 5 minutes does not post part 1 again.`,
    );
    assert.deepEqual(unconfirmed(h), [], "a refusal is not ambiguous");
    const third = await h.call(script, "reply", args);
    assert.equal(third.ok, true, third.text);
    assert.match(third.text, /part 1 had gone out on an earlier try/u);
    assert.equal(posted(h), "abc");
  } finally {
    h.dispose();
  }
});

test("a long reply resumed twice stays resumable for 5 minutes after its latest part (#55)", async () => {
  const h = harness();
  try {
    loseResponsesTo(h, 2, 4); // part 2, then part 3 on the first retry
    const shim = h.attach("scribe");
    const args = { chat_id: CHANNEL, text: LONG };
    await h.call(shim, "reply", args);
    h.clock.advance(4 * 60_000);
    const firstRetry = await h.call(shim, "reply", args);
    const [one, two] = postedIds(h);
    assert.equal(
      firstRetry.text,
      `Discord did not confirm part 3 of 3 (fetch failed); it may already have been posted. ` +
        `Parts 1 and 2 were sent (ids ${one}, ${two}). ` +
        `Retrying the identical text within 5 minutes is safe: frond-ear does not post parts 1 and 2 again ` +
        `and reuses part 3's nonce, so Discord returns the original instead of posting it twice.`,
    );
    h.clock.advance(4 * 60_000); // 8 minutes after the reply began, 4 after part 3
    const secondRetry = await h.call(shim, "reply", args);
    assert.equal(secondRetry.ok, true, secondRetry.text);
    assert.match(secondRetry.text, /parts 1 and 2 had gone out/u);
    assert.equal(posted(h), "abc");
  } finally {
    h.dispose();
  }
});

test("past the reuse window, a retry of a long reply is a new reply and posts every part (#55)", async () => {
  const h = harness();
  try {
    loseResponsesTo(h, 1, 3); // part 1; then part 2 on the first retry
    const shim = h.attach("scribe");
    const args = { chat_id: CHANNEL, text: LONG };
    const first = await h.call(shim, "reply", args);
    assert.equal(
      first.text,
      `Discord did not confirm part 1 of 3 (fetch failed); it may already have been posted. ` +
        `Parts 2 and 3 were not sent. ` +
        `Retrying the identical text within 5 minutes is safe: frond-ear reuses part 1's nonce, ` +
        `so Discord returns the original instead of posting it twice.`,
    );
    assert.match((await h.call(shim, "reply", args)).text, /part 2 of 3/u);
    assert.equal(posted(h), "ab");
    h.clock.advance(WINDOW_MS + 1_000);
    const late = await h.call(shim, "reply", args);
    assert.equal(late.ok, true, late.text);
    assert.doesNotMatch(late.text, /earlier try/u);
    assert.equal(
      posted(h),
      "ababc",
      "every part posts again, as the error warned",
    );
  } finally {
    h.dispose();
  }
});

test("a finished long reply is never resumed: a deliberate repeat posts every part (#55)", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe");
    const args = { chat_id: CHANNEL, text: LONG };
    assert.equal((await h.call(shim, "reply", args)).ok, true);
    const again = await h.call(shim, "reply", args);
    assert.equal(again.ok, true, again.text);
    assert.doesNotMatch(again.text, /earlier try/u);
    assert.equal(posted(h), "abcabc");
  } finally {
    h.dispose();
  }
});

test("another reply never takes over an unfinished one's parts: another chat, reply_to or text (#55)", async () => {
  const h = harness();
  try {
    loseResponsesTo(h, 2);
    const shim = h.attach("scribe");
    await h.call(shim, "reply", { chat_id: CHANNEL, text: LONG });
    assert.equal(posted(h), "ab");
    // The same text in another chat, or quoting a message, is another reply.
    await h.call(shim, "reply", { chat_id: ROOM, text: LONG });
    assert.equal(posted(h), "ababc");
    assert.equal(h.rest.calls[2]?.channelId, ROOM);
    await h.call(shim, "reply", {
      chat_id: CHANNEL,
      text: LONG,
      reply_to: "43",
    });
    assert.equal(posted(h), "ababcabc");
    assert.equal(h.rest.calls[5]?.replyTo, "43");
    // Part 2 of this reply is the same text at the same index as part 2 of the
    // first, which is still unconfirmed; it posts in its own place all the same.
    const other = `${"z".repeat(1_500)}\n\n${"b".repeat(1_500)}`;
    const result = await h.call(shim, "reply", {
      chat_id: CHANNEL,
      text: other,
    });
    assert.equal(result.ok, true, result.text);
    assert.equal(posted(h), "ababcabczb");
  } finally {
    h.dispose();
  }
});

test("the send_check notice names the part of a long reply, and only of a long one (#55)", () => {
  const notice = renderAmbiguousSends([
    { chatId: "1", preview: "a short reply", part: 0, parts: 1 },
    { chatId: "2", preview: "the middle of a long one", part: 1, parts: 3 },
    { chatId: "3", preview: "from before #55", part: null, parts: null },
  ]);
  assert.match(
    notice.content,
    /\(chat 1: "a short reply"; chat 2: part 2 of 3, "the middle of a long one"; chat 3: "from before #55"\)/u,
  );
  assert.equal(notice.meta.count, "3");
});

test("a long reply cut off by a daemon kill is listed by part, and its retry posts only the rest (#55)", async () => {
  const h = harness();
  const path = join(h.directory, "kill-long.db");
  try {
    const before = harness(testConfig(), { path });
    const discordSend = before.rest.sendMessage.bind(before.rest);
    let count = 0;
    before.rest.sendMessage = async (...args) => {
      const sent = await discordSend(...args); // Discord accepts each post...
      count += 1;
      if (count === 2) {
        return new Promise<never>(() => undefined); // ...and the daemon dies before hearing back about part 2
      }
      return sent;
    };
    const shimBefore = before.attach("scribe");
    void shimBefore.send({
      type: "call",
      id: 1,
      tool: "reply",
      args: { chat_id: CHANNEL, text: LONG },
    });
    for (let tick = 0; tick < 100 && count < 2; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(posted(before), "ab");
    // SIGKILL: no shutdown, no store close, nothing else runs.

    const after = harness(testConfig(), { path });
    after.rest.sendMessage = discordSend; // same Discord on the other side
    const shim = after.attach("scribe");
    const checks = sendChecks(shim);
    assert.equal(checks.length, 1);
    assert.match(
      checks[0]?.content ?? "",
      new RegExp(`\\(chat ${CHANNEL}: part 2 of 3, "b{64}"\\)`, "u"),
    );
    assert.match(
      checks[0]?.content ?? "",
      /Re-sending a whole reply, with the identical text and reply_to, within 5 minutes of its unconfirmed send posts only what did not go out/u,
    );
    const retry = await after.call(shim, "reply", {
      chat_id: CHANNEL,
      text: LONG,
    });
    assert.equal(retry.ok, true, retry.text);
    assert.match(retry.text, /part 1 had gone out on an earlier try/u);
    assert.equal(posted(before), "abc", "no part is posted twice");
    after.daemon.shutdown();
    after.store.close();
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
