// End-to-end: real processes, real unix socket, and the official MCP SDK
// client standing in for Claude Code. Nothing touches Discord or Claude.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { LineConnection } from "../src/protocol.ts";
import { BOT, CHANNEL, GUILD, PRINCIPAL, ROOM } from "./helpers.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

interface ChannelNotification {
  content: string;
  meta: Record<string, string>;
}

async function waitFor<T>(
  probe: () => T | undefined,
  what: string,
  ms = 10_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function run(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

/** Sends several inject requests on a single CLI connection, in order. */
function injectOverOneConnection(
  socketPath: string,
  messages: object[],
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const results: string[] = [];
    const socket = connect(socketPath);
    const connection = new LineConnection(
      socket,
      (raw) => {
        const reply = raw as { type: string; text?: string };
        if (reply.type === "welcome") {
          messages.forEach((message, index) =>
            connection.send({ type: "inject", id: index + 1, message }),
          );
        } else if (reply.type === "result") {
          results.push(reply.text ?? "");
          if (results.length === messages.length) {
            connection.close();
            resolve(results);
          }
        }
      },
      () => {
        if (results.length < messages.length) {
          reject(new Error("daemon closed the inject connection early"));
        }
      },
    );
    socket.once("connect", () =>
      connection.send({ type: "hello", role: "cli", protocol: 1 }),
    );
    socket.once("error", reject);
  });
}

test("dry-run daemon + channel shim + MCP client: inject → <channel> notification → reply", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-e2e-"));
  const socket = join(directory, "run", "daemon.sock");
  const configPath = join(directory, "frond-ear.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      botUserId: BOT,
      principals: [PRINCIPAL],
      labels: { [PRINCIPAL]: "figs" },
      ears: {
        scribe: {
          target: "claude-channel",
          attachCanary: true,
          channels: {
            [CHANNEL]: "mentions",
            [ROOM]: { mode: "room", quietWindowMs: 300, maxDelayMs: 2_000 },
          },
        },
      },
      defaults: { quietWindowMs: 300, maxDelayMs: 2_000, priorityQuietMs: 100 },
    }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FROND_EAR_CONFIG: configPath,
    FROND_EAR_DATABASE: join(directory, "state", "ear.db"),
    FROND_EAR_SOCKET: socket,
    FROND_EAR_BOT_USER_ID: BOT,
  };
  delete env.DISCORD_BOT_TOKEN;
  delete env.DISCORD_BOT_TOKEN_FILE;

  let daemonStderr = "";
  const daemon: ChildProcess = spawn(
    process.execPath,
    [CLI, "daemon", "--dry-run"],
    {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  daemon.stderr?.on("data", (chunk: Buffer) => {
    daemonStderr += chunk.toString();
  });
  const client = new Client(
    { name: "fake-claude-code", version: "0.0.0" },
    { capabilities: {} },
  );
  t.after(async () => {
    await client.close().catch(() => undefined);
    daemon.kill("SIGTERM");
    await new Promise((resolve) => daemon.once("close", resolve));
    rmSync(directory, { recursive: true, force: true });
  });

  await waitFor(() => (existsSync(socket) ? true : undefined), "daemon socket");
  assert.equal(statSync(socket).mode & 0o777, 0o600);
  assert.equal(statSync(join(directory, "run")).mode & 0o777, 0o700);

  const notifications: ChannelNotification[] = [];
  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method === "notifications/claude/channel") {
      notifications.push(notification.params as unknown as ChannelNotification);
    }
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "shim"],
    env: {
      ...(env as Record<string, string>),
      FROND_EAR_EAR: "scribe",
      CLAUDE_CODE_SESSION_ID: "session-e2e",
    },
    stderr: "inherit",
  });
  await client.connect(transport);

  // Handshake: channel capability, pinned protocol, operator instructions.
  assert.deepEqual(client.getServerCapabilities()?.experimental, {
    "claude/channel": {},
  });
  assert.match(
    client.getInstructions() ?? "",
    /frond-ear is your own ear on Discord[\s\S]*figs \(200000000000000002\)/u,
  );
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "ack",
    "ear_status",
    "edit_message",
    "fetch_messages",
    "inbox",
    "react",
    "reply",
  ]);

  // Attach canary arrives; acking it registers the ear.
  const canary = await waitFor(
    () => notifications.find((item) => item.meta.kind === "attach"),
    "attach canary",
  );
  const nonce = canary.meta.nonce as string;
  const ack = await client.callTool({ name: "ack", arguments: { nonce } });
  assert.notEqual(ack.isError, true);
  const status = JSON.parse(
    (
      (await client.callTool({ name: "ear_status", arguments: {} }))
        .content as Array<{ text: string }>
    )[0]?.text ?? "{}",
  ) as {
    ears: Array<{ registered: boolean; sessionId: string; attached: boolean }>;
  };
  assert.deepEqual(
    {
      attached: status.ears[0]?.attached,
      registered: status.ears[0]?.registered,
      sessionId: status.ears[0]?.sessionId,
    },
    { attached: true, registered: true, sessionId: "session-e2e" },
  );

  // A principal @mention injected through the CLI becomes a channel notification.
  const injected = await run(
    [
      "inject",
      "--chat",
      CHANNEL,
      "--guild",
      GUILD,
      "--author",
      PRINCIPAL,
      "--name",
      "figs",
      "--mention",
      "scribe, status report please",
    ],
    env,
  );
  assert.equal(injected.code, 0, injected.stdout);
  assert.equal(injected.stdout.trim(), "inserted");
  const mention = await waitFor(
    () => notifications.find((item) => item.meta.kind === "mention"),
    "mention event",
  );
  assert.equal(mention.meta.chat_id, CHANNEL);
  assert.equal(mention.meta.trust, "principal");
  assert.match(
    mention.content,
    /figs \/ figs \(id 200000000000000002, principal\)[\s\S]*> <@100000000000000001> scribe, status report please/u,
  );

  // Replying goes out through the daemon (recorded in dry-run) and marks it seen.
  const reply = await client.callTool({
    name: "reply",
    arguments: {
      chat_id: CHANNEL,
      text: "All green here.",
      reply_to: mention.meta.message_id,
    },
  });
  assert.notEqual(reply.isError, true);
  await waitFor(
    () => (daemonStderr.includes("All green here.") ? true : undefined),
    "dry-run outbound",
  );
  const inbox = await client.callTool({ name: "inbox", arguments: {} });
  assert.match(
    (inbox.content as Array<{ text: string }>)[0]?.text ?? "",
    /inbox empty/u,
  );

  // Room chatter is debounced into a single notification. The three messages
  // are injected back-to-back over one daemon connection, so the assertion is
  // about debounce semantics, not about how fast three CLI processes start.
  const results = await injectOverOneConnection(
    socket,
    ["one", "two", "three"].map((text, index) => ({
      id: String(1_500_000_000_000_000_000n + BigInt(index)),
      channel_id: ROOM,
      guild_id: GUILD,
      author: { id: "400000000000000004", username: "ambient" },
      content: text,
      timestamp: new Date().toISOString(),
    })),
  );
  assert.deepEqual(results, ["inserted", "inserted", "inserted"]);
  const room = await waitFor(
    () => notifications.find((item) => item.meta.kind === "room"),
    "room batch",
  );
  assert.equal(room.meta.count, "3");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(
    notifications.filter((item) => item.meta.kind === "room").length,
    1,
  );
});
