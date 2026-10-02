#!/usr/bin/env node
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  watch,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { connectToDaemon, request, tcpTarget, tcpToken } from "./client.ts";
import {
  defaultSocketPath,
  loadConfigFile,
  readBotToken,
  runtimeOptions,
} from "./config.ts";
import { CanticleReceptor } from "./canticle/receptor.ts";
import { Manifest } from "./canticle/manifest.ts";
import { Daemon } from "./daemon.ts";
import { DiscordGateway } from "./gateway.ts";
import { StructuredLogger } from "./logger.ts";
import { runDoctor, runInit } from "./onboard.ts";
import type { DaemonMessage } from "./protocol.ts";
import { EAR_PROTOCOL_VERSION, LineConnection } from "./protocol.ts";
import { HttpDiscordRest, RecordingRest } from "./rest.ts";
import { listenTcp, listenUnix } from "./server.ts";
import { ChannelShim, TOOLS } from "./shim.ts";
import { EventStore } from "./store.ts";
import type { DiscordMessage } from "./types.ts";

const USAGE = `frond-ear — Discord Gateway ear for long-running Claude Code sessions

usage:
  frond-ear init [--non-interactive …] write a config and a 0600 token file, then print the next steps
                                      (flags: --bot-user-id, --principal id[:label], --peer id[:label], --ear,
                                      --channel id[:mode], --mention-pattern, --no-dms, --token-file, --token-stdin,
                                      --config, --force)
  frond-ear doctor [--json]           read-only checks: config, token, socket, daemon, gateway, ears, node
                                      (reads what the daemon reads: FROND_EAR_CONFIG, DISCORD_BOT_TOKEN_FILE;
                                      or --config, --token-file; init prints the env to use)
  frond-ear daemon [--dry-run]        run the gateway daemon (config: FROND_EAR_CONFIG, default ./frond-ear.json)
  frond-ear shim                      run the Claude Code channel shim (stdio MCP; launched by Claude Code)
  frond-ear status                    print daemon status as JSON
  frond-ear copilot-extension --ear <name> [--dir <path>]
                                      install the Copilot CLI extension for an ear
                                      (default dir $COPILOT_HOME/extensions/frond-ear; run copilot --experimental)
  frond-ear tap --ear <name>          stream the batches pushed to an ear's attached session (read-only;\n                                      wakes a session without channel push; a shim must be attached)
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
  let canticle: CanticleReceptor | undefined;
  if (config.canticle?.enabled && !runtime.dryRun) {
    canticle = new CanticleReceptor({
      config: config.canticle,
      manifest: Manifest.fromJson(
        JSON.parse(readFileSync(config.canticle.manifestPath, "utf8")),
      ),
      store,
      logger,
    });
  }
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
    attachmentsDir: runtime.attachmentsPath,
    allowInject: runtime.allowInject,
    ...(sharedToken ? { token: sharedToken } : {}),
    gatewayStatus: () =>
      gateway?.status() ?? { state: runtime.dryRun ? "dry-run" : "disabled" },
    canticleStatus: () => canticle?.status() ?? { state: "disabled" },
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
  // Listen-only and silent: heard items stay in the receptor's live set; nothing
  // reaches a session until P3's `hear` tool. Canticle config changes need a restart.
  canticle?.start();

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
  const pruneTimer = setInterval(() => daemon.prune(), 60 * 60 * 1_000);
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
    canticle?.stop();
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

/**
 * Stream an ear's pushed batches to stdout as they are sent to the attached session.
 * Read-only: a tap never attaches, confirms or marks anything. Reconnects with backoff
 * across daemon restarts and says so, so a watcher is never silently dead.
 */
function runTap(argv: string[]): void {
  const index = argv.indexOf("--ear");
  const ear = index >= 0 ? argv[index + 1] : process.env.FROND_EAR_EAR;
  if (!ear) {
    process.stderr.write("frond-ear tap: --ear <name> is required\n");
    process.exitCode = 2;
    return;
  }
  const env = process.env;
  // stdout is the watcher's wake signal: only batches and state changes worth waking for go
  // there. Retry chatter goes to stderr.
  const MAX_UNWELCOMED = 10;
  let delay = 1_000;
  let unwelcomed = 0;
  let lost = false;
  const connect = (): void => {
    const socket = connectToDaemon(env)();
    let welcomed = false;
    const connection = new LineConnection(
      socket,
      (raw) => {
        const message = raw as DaemonMessage;
        if (message.type === "welcome") {
          if (message.error) {
            process.stdout.write(`[frond-ear] tap refused: ${message.error}\n`);
            process.exit(2);
          }
          welcomed = true;
          unwelcomed = 0;
          delay = 1_000;
          if (lost) {
            lost = false;
            process.stdout.write(`[frond-ear] tap reconnected to ear=${ear}\n`);
          }
          return;
        }
        if (message.type === "event" && message.batchId !== null) {
          const chat = message.meta.chat_id ?? "?";
          process.stdout.write(
            `[frond-ear] ear=${ear} batch_id=${message.batchId} chat_id=${chat}\n${message.content}\n`,
          );
        }
      },
      () => {
        if (!welcomed) {
          unwelcomed += 1;
          if (unwelcomed >= MAX_UNWELCOMED) {
            process.stdout.write(
              `[frond-ear] tap giving up: the daemon closed ${MAX_UNWELCOMED} connections without a welcome (down, or a bad token)\n`,
            );
            process.exit(1);
          }
        } else if (!lost) {
          lost = true;
          process.stdout.write(
            `[frond-ear] tap lost the daemon; reconnecting\n`,
          );
        }
        process.stderr.write(`frond-ear tap: retrying in ${delay / 1_000}s\n`);
        setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30_000);
      },
    );
    socket.once("connect", () => {
      const token = tcpTarget(env) ? tcpToken(env) : undefined;
      connection.send({
        type: "hello",
        role: "tap",
        protocol: EAR_PROTOCOL_VERSION,
        ear,
        ...(token ? { token } : {}),
      });
    });
    socket.on("error", () => undefined);
  };
  connect();
}

/**
 * Installs the Copilot CLI extension (copilot-extension/) for one ear: the two .mjs files
 * plus a config.json carrying the daemon address and the shim's own TOOLS, so the Claude
 * and Copilot targets expose the same tools from one definition.
 */
function runCopilotExtension(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: { ear: { type: "string" }, dir: { type: "string" } },
  });
  const env = process.env;
  const ear = values.ear ?? env.FROND_EAR_EAR;
  if (!ear) {
    process.stderr.write(
      "frond-ear copilot-extension: --ear <name> is required\n",
    );
    process.exitCode = 2;
    return;
  }
  const dir =
    values.dir ??
    join(
      env.COPILOT_HOME ?? join(homedir(), ".copilot"),
      "extensions",
      "frond-ear",
    );
  const source = join(import.meta.dirname, "..", "copilot-extension");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const file of ["core.mjs", "extension.mjs"]) {
    copyFileSync(join(source, file), join(dir, file));
  }
  const tcp = tcpTarget(env);
  const config = {
    ear,
    tools: TOOLS,
    ...(tcp
      ? {
          tcp,
          ...(env.FROND_EAR_TOKEN_FILE
            ? { tokenFile: env.FROND_EAR_TOKEN_FILE }
            : {}),
        }
      : { socket: defaultSocketPath(env) }),
  };
  const configFile = join(dir, "config.json");
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  // `mode` applies only when the file is created; a reinstall over an older, looser
  // config.json would keep its mode, so tighten it explicitly.
  chmodSync(configFile, 0o600);
  process.stdout.write(
    `installed frond-ear Copilot extension for ear "${ear}" in ${dir}\n` +
      `set ears.${ear}.target to "copilot-extension" in the daemon config, then start: copilot --experimental\n`,
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "init":
      process.exitCode = await runInit(rest, {
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        env: process.env,
      });
      return;
    case "doctor":
      process.exitCode = await runDoctor(rest, {
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        env: process.env,
      });
      return;
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
    case "tap":
      runTap(rest);
      return;
    case "copilot-extension":
      runCopilotExtension(rest);
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
