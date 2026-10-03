// `frond-ear send` (#47): a script posts one message through the daemon's `reply` tool.
// In-process against a real daemon on a real unix socket (and TCP) with the recording REST
// double; then the CLI itself against a dry-run daemon, for its wiring and the help line
// seat-pulse looks for.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { Config } from "../src/config.ts";
import { runSend } from "../src/send.ts";
import { listenTcp, listenUnix } from "../src/server.ts";
import {
  BOT,
  CHANNEL,
  PRINCIPAL,
  ROOM,
  harness,
  message,
  testConfig,
} from "./helpers.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const UNBOUND = "123456789012345678";
const USAGE_LINE = /usage: frond-ear send --chat <id> \[--\] <text…>/u;

interface Sent {
  code: number;
  stdout: string;
  stderr: string;
}

async function send(argv: string[], env: NodeJS.ProcessEnv): Promise<Sent> {
  let stdout = "";
  let stderr = "";
  const out = new PassThrough();
  out.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  const err = new PassThrough();
  err.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const code = await runSend(argv, { stdout: out, stderr: err, env });
  return { code, stdout, stderr };
}

function temp(): string {
  // Short on purpose: unix socket paths are capped at 107 bytes.
  return mkdtempSync(join(tmpdir(), "frond-ear-send-"));
}

/** A real daemon (harness: recording REST, fake clock) on a temp unix socket. */
async function withDaemon(
  body: (
    h: ReturnType<typeof harness>,
    env: NodeJS.ProcessEnv,
  ) => Promise<void>,
  config: Config = testConfig(),
): Promise<void> {
  const directory = temp();
  const socketPath = join(directory, "daemon.sock");
  const h = harness(config);
  const server = await listenUnix(h.daemon, socketPath);
  try {
    await body(h, { FROND_EAR_SOCKET: socketPath });
  } finally {
    server.close();
    h.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("send posts the text to a chat an ear serves, as one reply, and prints the receipt", async () => {
  await withDaemon(async (h, env) => {
    const sent = await send(
      ["--chat", CHANNEL, "⚠️ frond-gloss@silas:", "tmux session gone"],
      env,
    );
    assert.equal(sent.code, 0, sent.stderr);
    assert.equal(sent.stderr, "");
    assert.deepEqual(h.rest.calls, [
      {
        method: "send",
        channelId: CHANNEL,
        messageId: h.rest.calls[0]?.messageId,
        content: "⚠️ frond-gloss@silas: tmux session gone",
      },
    ]);
    assert.equal(
      sent.stdout,
      `sent 1 message to ${CHANNEL} (id ${h.rest.calls[0]?.messageId})\n`,
    );

    // Text that starts with a dash goes after `--`, and is posted as written.
    const dashed = await send(["--chat", ROOM, "--", "-5 min idle"], env);
    assert.equal(dashed.code, 0, dashed.stderr);
    assert.equal(h.rest.calls[1]?.channelId, ROOM);
    assert.equal(h.rest.calls[1]?.content, "-5 min idle");
  });
});

test("send refuses a chat no ear serves, and a chat that is not a Discord ID; nothing is posted", async () => {
  await withDaemon(async (h, env) => {
    const unbound = await send(["--chat", UNBOUND, "hello"], env);
    assert.equal(unbound.code, 1);
    assert.equal(unbound.stdout, "");
    assert.match(
      unbound.stderr,
      new RegExp(
        `^frond-ear send: chat ${UNBOUND} is not bound to any frond-ear ear`,
        "u",
      ),
    );
    const traversal = await send(["--chat", "../../users/@me", "hello"], env);
    assert.equal(traversal.code, 1);
    assert.equal(traversal.stdout, "");
    assert.match(
      traversal.stderr,
      /^frond-ear send: chat_id must be a Discord ID/u,
    );
    assert.deepEqual(h.rest.calls, []);
  });
});

test("send: bad usage exits 2 without contacting the daemon", async () => {
  const directory = temp();
  try {
    // Nothing listens here: a send that tried to connect would exit 1, not 2.
    const env = { FROND_EAR_SOCKET: join(directory, "nobody.sock") };
    for (const argv of [
      [],
      ["hello"],
      ["--chat", CHANNEL],
      ["--chat", CHANNEL, "  ", ""],
      ["--chat"],
      ["--chat", CHANNEL, "--reply-to", CHANNEL, "hello"],
      ["--chat", CHANNEL, "-5 min idle"],
    ]) {
      const sent = await send(argv, env);
      assert.equal(sent.code, 2, `${JSON.stringify(argv)}: ${sent.stderr}`);
      assert.equal(sent.stdout, "");
      assert.match(sent.stderr, /^frond-ear send: /u);
      assert.match(sent.stderr, USAGE_LINE);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("send with no daemon listening exits 1 and says why on stderr", async () => {
  const directory = temp();
  try {
    const sent = await send(["--chat", CHANNEL, "anyone?"], {
      FROND_EAR_SOCKET: join(directory, "nobody.sock"),
    });
    assert.equal(sent.code, 1);
    assert.equal(sent.stdout, "");
    assert.match(
      sent.stderr,
      /^frond-ear send: no answer from the daemon \(connect ENOENT .*nobody\.sock\)\n$/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a send from the CLI marks nothing seen and carries no session delivery warning", async () => {
  const config = testConfig({
    ears: {
      scribe: { attachCanary: true, channels: { [CHANNEL]: "mentions" } },
    },
  });
  await withDaemon(async (h, env) => {
    const shim = h.attach("scribe");
    h.daemon.ingest(
      message({
        author: { id: PRINCIPAL },
        mentions: [{ id: BOT }],
        content: "status?",
      }),
    );
    h.timers.advance(60_000);
    const pushed = shim.connection.events().at(-1);
    assert.ok(pushed && pushed.batchId !== null, "an event was pushed");
    await shim.send({ type: "offered", batchId: pushed.batchId });
    // Past the delivery grace with the canary never acked: the session's own tool results
    // now warn that its pushes may not arrive.
    h.clock.advance(2 * 60 * 1_000);
    assert.equal(h.store.unseen("scribe", CHANNEL, 10).length, 1);

    const sent = await send(["--chat", CHANNEL, "seat alert"], env);
    assert.equal(sent.code, 0, sent.stderr);
    assert.equal(
      sent.stdout,
      `sent 1 message to ${CHANNEL} (id ${h.rest.calls.at(-1)?.messageId})\n`,
    );
    assert.equal(
      h.store.unseen("scribe", CHANNEL, 10).length,
      1,
      "the event still waits on the session",
    );

    // Control: the session's own reply in that chat does acknowledge it.
    const reply = await h.call(shim, "reply", {
      chat_id: CHANNEL,
      text: "on it",
    });
    assert.equal(reply.ok, true, reply.text);
    assert.match(reply.text, /⚠️ frond-ear/u);
    assert.equal(h.store.unseen("scribe", CHANNEL, 10).length, 0);
  }, config);
});

test("send over TCP presents the shared token; a wrong token gets no answer and posts nothing", async () => {
  const directory = temp();
  const h = harness(undefined, { token: "tcp-shared-secret" });
  const server = await listenTcp(h.daemon, "127.0.0.1", 0);
  try {
    const { port } = server.address() as AddressInfo;
    const tokenFile = join(directory, "tcp-token");
    const wrongFile = join(directory, "wrong-token");
    writeFileSync(tokenFile, "tcp-shared-secret\n", { mode: 0o600 });
    writeFileSync(wrongFile, "not-the-secret\n", { mode: 0o600 });
    const env = {
      FROND_EAR_TCP: `127.0.0.1:${port}`,
      FROND_EAR_TOKEN_FILE: tokenFile,
    };
    const sent = await send(["--chat", CHANNEL, "over tcp"], env);
    assert.equal(sent.code, 0, sent.stderr);
    const refused = await send(["--chat", CHANNEL, "wrong token"], {
      ...env,
      FROND_EAR_TOKEN_FILE: wrongFile,
    });
    assert.equal(refused.code, 1);
    assert.match(
      refused.stderr,
      /^frond-ear send: no answer from the daemon \(daemon closed the connection\)/u,
    );
    assert.deepEqual(
      h.rest.calls.map((call) => call.content),
      ["over tcp"],
    );
  } finally {
    server.close();
    h.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("send: Discord not confirming exits 1 and says so; the identical retry posts once", async () => {
  await withDaemon(async (h, env) => {
    const sendMessage = h.rest.sendMessage.bind(h.rest);
    h.rest.sendMessage = async () => {
      throw new Error("socket hang up");
    };
    const lost = await send(["--chat", CHANNEL, "seat gone"], env);
    assert.equal(lost.code, 1);
    assert.equal(lost.stdout, "");
    assert.match(
      lost.stderr,
      /^frond-ear send: Discord did not confirm this send \(socket hang up\)\. The message may already have been posted\. Retrying the identical text within 5 minutes is safe/u,
    );

    h.rest.sendMessage = sendMessage;
    const retried = await send(["--chat", CHANNEL, "seat gone"], env);
    assert.equal(retried.code, 0, retried.stderr);
    assert.deepEqual(
      h.rest.calls.map((call) => call.content),
      ["seat gone"],
    );
  });
});

function run(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitFor(probe: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!probe()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("the CLI lists send where seat-pulse looks for it, and posts through a dry-run daemon", async (t) => {
  const directory = temp();
  const socket = join(directory, "daemon.sock");
  const configPath = join(directory, "frond-ear.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      botUserId: BOT,
      principals: [PRINCIPAL],
      ears: { scribe: { channels: { [CHANNEL]: "mentions" } } },
    }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FROND_EAR_CONFIG: configPath,
    FROND_EAR_DATABASE: join(directory, "ear.db"),
    FROND_EAR_SOCKET: socket,
  };
  delete env.DISCORD_BOT_TOKEN;
  delete env.DISCORD_BOT_TOKEN_FILE;
  delete env.FROND_EAR_TCP;

  // seat-pulse (scribe-prince-shared, frond-fleet:scribe-seat-survival) detects the command
  // with exactly this pattern on `help`.
  const help = await run(["help"], env);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^ {2}frond-ear send( |$)/mu);

  let daemonStderr = "";
  const daemon: ChildProcess = spawn(
    process.execPath,
    [CLI, "daemon", "--dry-run"],
    { env, stdio: ["ignore", "ignore", "pipe"] },
  );
  daemon.stderr?.on("data", (chunk: Buffer) => {
    daemonStderr += chunk.toString();
  });
  t.after(async () => {
    daemon.kill("SIGTERM");
    await new Promise((resolve) => daemon.once("close", resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  await waitFor(() => existsSync(socket), "daemon socket");

  const sent = await run(
    ["send", "--chat", CHANNEL, "⚠️ frond-gloss@silas: tmux session gone"],
    env,
  );
  assert.equal(sent.code, 0, sent.stderr);
  assert.match(
    sent.stdout,
    new RegExp(`^sent 1 message to ${CHANNEL} \\(id \\d+\\)\\n$`, "u"),
  );
  await waitFor(
    () =>
      daemonStderr.includes(
        `dry-run send → ${CHANNEL}:\n⚠️ frond-gloss@silas: tmux session gone\n`,
      ),
    "the dry-run send",
  );

  // The exit code reaches the shell: 1 refused, 2 bad usage.
  const refused = await run(["send", "--chat", UNBOUND, "hello"], env);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /is not bound to any frond-ear ear/u);
  const usage = await run(["send", "--chat", CHANNEL], env);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, USAGE_LINE);
});
