#!/usr/bin/env node
import { readFileSync, watch } from "node:fs";
import { connect, type Socket } from "node:net";
import { parseArgs } from "node:util";

import {
  defaultSocketPath,
  loadConfigFile,
  readBotToken,
  runtimeOptions,
} from "./config.ts";
import { Daemon } from "./daemon.ts";
import { DiscordGateway } from "./gateway.ts";
import { StructuredLogger } from "./logger.ts";
import type { DaemonMessage } from "./protocol.ts";
import { EAR_PROTOCOL_VERSION, LineConnection } from "./protocol.ts";
import { HttpDiscordRest, RecordingRest } from "./rest.ts";
import { listenTcp, listenUnix } from "./server.ts";
import { ChannelShim } from "./shim.ts";
import { EventStore } from "./store.ts";
import type { DiscordMessage } from "./types.ts";

const USAGE = `frond-ear — Discord Gateway ear for long-running Claude Code sessions

usage:
  frond-ear daemon [--dry-run]        run the gateway daemon (config: FROND_EAR_CONFIG, default ./frond-ear.json)
  frond-ear shim                      run the Claude Code channel shim (stdio MCP; launched by Claude Code)
  frond-ear status                    print daemon status as JSON
  frond-ear inject --chat <id> --author <id> [--guild <id>] [--name <n>] [--bot] [--mention] <text…>
                                      push a synthetic MESSAGE_CREATE (dry-run or FROND_EAR_ALLOW_INJECT=1)

environment:
  FROND_EAR_SOCKET        daemon socket (default $XDG_RUNTIME_DIR/frond-ear/daemon.sock)
  FROND_EAR_TCP           host:port — connect/listen over TCP instead (requires FROND_EAR_TOKEN_FILE)
  FROND_EAR_TOKEN_FILE    shared secret for TCP mode
  FROND_EAR_EAR           (shim) the ear this Claude session attaches to; unset = tools only
  FROND_EAR_DATABASE      SQLite path (default $XDG_STATE_HOME/frond-ear/frond-ear.db)
  DISCORD_BOT_TOKEN_FILE  bot token file (or DISCORD_BOT_TOKEN)
`;

function tcpTarget(
  env: NodeJS.ProcessEnv,
): { host: string; port: number } | undefined {
  const value = env.FROND_EAR_TCP;
  if (!value) {
    return undefined;
  }
  const index = value.lastIndexOf(":");
  const port = Number(value.slice(index + 1));
  if (index <= 0 || !Number.isInteger(port)) {
    throw new Error("FROND_EAR_TCP must be host:port");
  }
  return { host: value.slice(0, index), port };
}

function tcpToken(env: NodeJS.ProcessEnv): string | undefined {
  return env.FROND_EAR_TOKEN_FILE
    ? readFileSync(env.FROND_EAR_TOKEN_FILE, "utf8").trim()
    : undefined;
}

function connectToDaemon(env: NodeJS.ProcessEnv): () => Socket {
  const tcp = tcpTarget(env);
  return tcp
    ? () => connect(tcp.port, tcp.host)
    : () => connect(defaultSocketPath(env));
}

async function runDaemon(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { "dry-run": { type: "boolean" } },
  });
  const env = process.env;
  const runtime = runtimeOptions(env, { dryRun: values["dry-run"] === true });
  const config = loadConfigFile(runtime.configPath);
  const token = runtime.dryRun ? "" : readBotToken(env);
  const logger = new StructuredLogger(undefined, token ? [token] : []);
  const store = new EventStore(runtime.databasePath);
  const pruned = store.prune(config.limits.retentionMs);

  let gateway: DiscordGateway | undefined;
  const rest = runtime.dryRun
    ? new RecordingRest(
        (channelId, limit) =>
          store.recent(channelId, limit).map(
            (event): DiscordMessage => ({
              id: event.messageId,
              channel_id: event.chatId,
              ...(event.guildId ? { guild_id: event.guildId } : {}),
              author: {
                id: event.authorId,
                username: event.authorName,
                bot: event.isBot,
              },
              content: event.content,
              timestamp: event.timestamp,
            }),
          ),
        // Dry-run exists to show what Claude would post, so print it plainly
        // (the structured logger redacts message text by design).
        (call) =>
          process.stderr.write(
            `dry-run ${call.method} → ${call.channelId}${call.replyTo ? ` (reply to ${call.replyTo})` : ""}${call.emoji ? ` ${call.emoji}` : ""}${call.content ? `:\n${call.content}` : ""}\n`,
          ),
      )
    : new HttpDiscordRest({ token, apiBase: runtime.apiBase });
  const tcp = tcpTarget(env);
  const sharedToken = tcpToken(env);
  if (tcp && !sharedToken) {
    throw new Error("FROND_EAR_TCP requires FROND_EAR_TOKEN_FILE");
  }
  const daemon = new Daemon({
    config,
    store,
    rest,
    logger,
    allowInject: runtime.allowInject,
    ...(sharedToken ? { token: sharedToken } : {}),
    gatewayStatus: () =>
      gateway?.status() ?? { state: runtime.dryRun ? "dry-run" : "disabled" },
  });
  const server = tcp
    ? await listenTcp(daemon, tcp.host, tcp.port)
    : await listenUnix(daemon, runtime.socketPath);
  logger.log("info", "daemon.listening", {
    endpoint: tcp ? `${tcp.host}:${tcp.port}` : runtime.socketPath,
    dryRun: runtime.dryRun,
    ears: Object.keys(config.ears),
    pruned,
  });

  if (!runtime.dryRun) {
    gateway = new DiscordGateway({
      token,
      gatewayUrl: runtime.gatewayUrl,
      store,
      logger,
      onMessage: (message) => {
        daemon.ingest(message);
      },
      onThread: (threadId, parentId) => daemon.recordThread(threadId, parentId),
      onFatal: (code) => {
        logger.log("error", "daemon.exit_gateway_fatal", { closeCode: code });
        shutdown(1);
      },
    });
    gateway.start();
  }

  let reloadTimer: NodeJS.Timeout | undefined;
  const watcher = watch(runtime.configPath, () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      try {
        daemon.reloadConfig(loadConfigFile(runtime.configPath));
        logger.log("info", "config.reloaded");
      } catch (error) {
        logger.log("error", "config.reload_rejected", {
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
    }, 250);
  });
  const pruneTimer = setInterval(
    () => store.prune(config.limits.retentionMs),
    60 * 60 * 1_000,
  );
  pruneTimer.unref();

  let stopping = false;
  function shutdown(code: number): void {
    if (stopping) {
      return;
    }
    stopping = true;
    // Stop inputs first (no new Discord events, no new connections), then let
    // in-flight tool calls finish recording their side effects, and only then
    // close SQLite.
    watcher.close();
    gateway?.stop();
    server.close();
    void daemon.shutdown().then(({ drained }) => {
      store.close();
      logger.log("info", "daemon.stopped", { code, drained });
      process.exitCode = code;
      setTimeout(() => process.exit(code), 500).unref();
    });
  }
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}

function runShim(): void {
  const env = process.env;
  const shim = new ChannelShim({
    input: process.stdin,
    output: process.stdout,
    connect: connectToDaemon(env),
    ear: env.FROND_EAR_EAR || undefined,
    sessionId: env.CLAUDE_CODE_SESSION_ID || undefined,
    token: tcpTarget(env) ? tcpToken(env) : undefined,
  });
  shim.start();
  process.stdin.on("end", () => process.exit(0));
}

/** One request/response exchange with the daemon as a CLI client. */
function request(
  message: { type: "status" } | { type: "inject"; message: DiscordMessage },
): Promise<{ ok: boolean; text: string }> {
  const env = process.env;
  return new Promise((resolve, reject) => {
    const socket = connectToDaemon(env)();
    const connection = new LineConnection(
      socket,
      (raw) => {
        const reply = raw as DaemonMessage;
        if (reply.type === "welcome") {
          connection.send({ ...message, id: 1 });
        } else if (reply.type === "result") {
          connection.close();
          resolve({ ok: reply.ok, text: reply.text });
        }
      },
      () => reject(new Error("daemon closed the connection")),
    );
    socket.once("connect", () => {
      const token = tcpTarget(env) ? tcpToken(env) : undefined;
      connection.send({
        type: "hello",
        role: "cli",
        protocol: EAR_PROTOCOL_VERSION,
        ...(token ? { token } : {}),
      });
    });
    socket.once("error", (error) => reject(error));
  });
}

async function runInject(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      chat: { type: "string" },
      author: { type: "string" },
      guild: { type: "string" },
      name: { type: "string" },
      bot: { type: "boolean" },
      mention: { type: "boolean" },
      "bot-user": { type: "string" },
    },
  });
  if (!values.chat || !values.author || positionals.length === 0) {
    throw new Error("inject needs --chat, --author and message text");
  }
  let content = positionals.join(" ");
  const mentions: Array<{ id: string }> = [];
  if (values.mention) {
    const botUser = values["bot-user"] ?? process.env.FROND_EAR_BOT_USER_ID;
    if (!botUser) {
      throw new Error(
        "--mention needs --bot-user <id> (or FROND_EAR_BOT_USER_ID)",
      );
    }
    mentions.push({ id: botUser });
    content = `<@${botUser}> ${content}`;
  }
  const now = Date.now();
  const message: DiscordMessage = {
    id: String(
      (BigInt(now - 1_420_070_400_000) << 22n) |
        BigInt(Math.floor(Math.random() * 4_096)),
    ),
    channel_id: values.chat,
    ...(values.guild ? { guild_id: values.guild } : {}),
    author: {
      id: values.author,
      username: values.name ?? `user-${values.author}`,
      ...(values.bot ? { bot: true } : {}),
    },
    content,
    timestamp: new Date(now).toISOString(),
    mentions,
  };
  const result = await request({ type: "inject", message });
  process.stdout.write(`${result.text}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "daemon":
      await runDaemon(rest);
      return;
    case "shim":
      runShim();
      return;
    case "status": {
      const result = await request({ type: "status" });
      process.stdout.write(`${result.text}\n`);
      return;
    }
    case "inject":
      await runInject(rest);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return;
    default:
      process.stderr.write(`unknown command ${command}\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `frond-ear: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
