#!/usr/bin/env node
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
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
import { watchConfigFile } from "./config-watch.ts";
import {
  createCanticleSource,
  type CanticleSource,
} from "./canticle/source.ts";
import { Manifest } from "./canticle/manifest.ts";
import { runConnectorEcho } from "./connector/echo.ts";
import { Daemon } from "./daemon.ts";
import { LETTER_HINT, hookInput } from "./letters.ts";
import { DiscordGateway } from "./gateway.ts";
import { watchdogOutcome } from "./watchdog.ts";
import { StructuredLogger } from "./logger.ts";
import { runDoctor, runInit } from "./onboard.ts";
import {
  holdReading,
  pendingTokens,
  pressureHookRequested,
  readTail,
  runPressureCommand,
} from "./pressure.ts";
import type { DaemonMessage } from "./protocol.ts";
import { EAR_PROTOCOL_VERSION, LineConnection } from "./protocol.ts";
import { HttpDiscordRest, RecordingRest } from "./rest.ts";
import { runSend } from "./send.ts";
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
  frond-ear send --chat <id> <text…>  post text as the daemon's bot, from a script (e.g. an alert); only to
                                      chats an ear serves; marks nothing seen; exit 0 once Discord confirmed it
  frond-ear copilot-extension --ear <name> [--dir <path>]
                                      install the Copilot CLI extension for an ear
                                      (default dir $COPILOT_HOME/extensions/frond-ear; run copilot --experimental)
  frond-ear tap --ear <name>          stream the batches pushed to an ear's attached session (read-only;\n                                      wakes a session without channel push; a shim must be attached)
  frond-ear release --ear <name> [--source <s>] [--session <id>] [--hook]
                                      release an ear's letters (#88) to its attached session; for a
                                      SessionStart hook (matcher startup|compact): --hook reads the hook's
                                      JSON on stdin (session_id, source) and always exits 0
  frond-ear precompact --ear <name> [--session <id>] [--hook]
                                      print the session's unsettled letters (#102) as compaction-summary
                                      instructions; for a PreCompact hook: --hook reads session_id on
                                      stdin, prints nothing on any failure and exits 0, except exit 2 when
                                      the session's hold_compaction blocks an auto compaction under
                                      FROND_EAR_HOLD_CEILING tokens (#107; unset: never blocks)
  frond-ear pressure --hook [--ear <name>] [--bands 150k,200k,300k,450k,650k]
                                      context pressure for a PostToolUse / UserPromptSubmit / Stop hook: reads
                                      the transcript's latest token usage and adds one line to the session's
                                      context on crossing into a new band; with --ear (or FROND_EAR_EAR) also
                                      reports the reading to the daemon for ear_status (best effort, ≤1 s;
                                      a PostCompact hook only reports); always exits 0
  frond-ear pressure --transcript <path>
                                      print a transcript's latest context size
  frond-ear inject --chat <id> --author <id> [--guild <id>] [--name <n>] [--bot] [--mention] <text…>
                                      push a synthetic MESSAGE_CREATE (dry-run or FROND_EAR_ALLOW_INJECT=1)
  frond-ear connector-echo [--public-url https://<host>] [--auth none|bearer|oauth] …
                                      read-only echo MCP server for a claude.ai custom connector (#53);
                                      loopback only, for Tailscale Funnel; no Discord access (docs/connector.md)

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
  let canticle: CanticleSource | undefined;
  if (config.canticle?.enabled && !runtime.dryRun) {
    const canticleConfig = config.canticle;
    canticle = createCanticleSource(canticleConfig, {
      manifest: () =>
        Manifest.fromJson(
          JSON.parse(readFileSync(canticleConfig.manifestPath, "utf8")),
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
            `dry-run ${call.method} → ${call.channelId}${call.replyTo ? ` (reply to ${call.replyTo})` : ""}${call.emoji ? ` ${call.emoji}` : ""}${call.files ? ` [files: ${call.files.map((file) => `${file.name} ${file.size} B`).join(", ")}]` : ""}${call.content ? `:\n${call.content}` : ""}\n`,
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
    protectedPaths: [
      runtime.configPath,
      runtime.databasePath,
      `${runtime.databasePath}-wal`,
      `${runtime.databasePath}-shm`,
      ...(env.DISCORD_BOT_TOKEN_FILE ? [env.DISCORD_BOT_TOKEN_FILE] : []),
      ...(env.FROND_EAR_TOKEN_FILE ? [env.FROND_EAR_TOKEN_FILE] : []),
    ],
    allowInject: runtime.allowInject,
    ...(sharedToken ? { token: sharedToken } : {}),
    gatewayStatus: () =>
      gateway?.status() ?? { state: runtime.dryRun ? "dry-run" : "disabled" },
    canticleStatus: () => canticle?.status() ?? { state: "disabled" },
    ...(canticle
      ? { canticleHear: (ear: string) => canticle!.hearView(ear) }
      : {}),
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
      onReady: () => daemon.gatewayReady(),
      onResumed: () => daemon.gatewayResumed(),
      onThread: (threadId, parentId) => daemon.recordThread(threadId, parentId),
      onFatal: (code) => {
        logger.log("error", "daemon.exit_gateway_fatal", { closeCode: code });
        shutdown(1);
      },
    });
    gateway.start();
  }
  // Heard items stay in the receptor's live set. `hear` reads them, and the daemon
  // pushes them only where canticle.delivery and canticle.wakeKeys allow (frond-ear#65).
  // Delivery settings reload with the config; the rest of canticle needs a restart.
  canticle?.start();

  let reloadTimer: NodeJS.Timeout | undefined;
  const watcher = watchConfigFile(runtime.configPath, () => {
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

/**
 * A SessionStart hook's knock (#88): ask the daemon to release an ear's letters.
 * Under --hook the hook's own JSON (stdin) names the session and the source,
 * every outcome is one line on stdout (which Claude Code adds to the session's
 * context), and the exit code is 0, so a down daemon never blocks a session start.
 */
async function runRelease(argv: string[]): Promise<void> {
  let values: {
    ear?: string;
    source?: string;
    session?: string;
    hook?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        ear: { type: "string" },
        source: { type: "string" },
        session: { type: "string" },
        hook: { type: "boolean" },
      },
    }));
  } catch (error) {
    // --hook always exits 0, bad arguments included; without it, 1 (never 2).
    process.stdout.write(
      `frond-ear: letters not released (${error instanceof Error ? error.message : String(error)})\n`,
    );
    process.exitCode = argv.includes("--hook") ? 0 : 1;
    return;
  }
  const hook = values.hook === true;
  let source = values.source;
  let sessionId = values.session;
  if (hook && !process.stdin.isTTY) {
    try {
      // Claude Code sends session_id, Copilot CLI sessionId (#92); either names it.
      const input = hookInput(await readStdin(64 * 1024));
      sessionId ??= input.sessionId;
      source ??= input.source;
    } catch {
      // Unreadable stdin names no session, and the daemon releases nothing without one.
    }
  }
  const ear = values.ear ?? process.env.FROND_EAR_EAR;
  try {
    if (!ear) {
      throw new Error("release needs --ear <name> (or FROND_EAR_EAR)");
    }
    const result = await request(
      {
        type: "release",
        ear,
        ...(source ? { source } : {}),
        ...(sessionId ? { sessionId } : {}),
      },
      process.env,
      5_000,
    );
    process.stdout.write(`frond-ear: ${result.text}\n`);
    if (hook && result.ok) {
      // Only when the daemon answered ok: a down daemon, or one that refused this
      // ear, can't take a letter either.
      process.stdout.write(`frond-ear: ${LETTER_HINT}\n`);
    }
    process.exitCode = result.ok || hook ? 0 : 1;
  } catch (error) {
    if (!hook) {
      throw error;
    }
    process.stdout.write(
      `frond-ear: letters not released (${error instanceof Error ? error.message : String(error)})\n`,
    );
    process.exitCode = 0;
  }
}

/**
 * A PreCompact hook (#102). Claude Code uses the hook's stdout as instructions for the
 * compaction summary, so stdout carries the letters or nothing at all: an error there
 * would land in the summary. Under --hook every failure goes to stderr and the exit
 * code is 0, since exit 2 blocks the compaction. Exit 2 comes from one path only: the
 * daemon answered that this session's hold blocks this compaction (#107).
 */
async function runPrecompact(argv: string[]): Promise<void> {
  const hookRequested = argv.includes("--hook");
  let values: { ear?: string; session?: string; hook?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        ear: { type: "string" },
        session: { type: "string" },
        hook: { type: "boolean" },
      },
    }));
  } catch (error) {
    // Bad arguments must never block a compaction: exit 2 is the code that does,
    // so a PreCompact entry misconfigured without --hook exits 1, never 2.
    process.stderr.write(
      `frond-ear precompact: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = hookRequested ? 0 : 1;
    return;
  }
  const hook = values.hook === true;
  // Under --hook only the hook's own stdin names the session being compacted: a
  // --session flag could otherwise print one session's letters into another's
  // summary (#103 review).
  let sessionId = hook ? undefined : values.session;
  if (hook && values.session !== undefined) {
    process.stderr.write(
      "frond-ear precompact: --session is ignored under --hook; the hook's stdin names the session\n",
    );
  }
  let trigger: string | undefined;
  let tokens: number | undefined;
  if (hook && process.env[PRECOMPACT_CHILD] !== "1") {
    // The whole hook is bounded (#107): the work runs in a child this process can
    // kill, since a timer can't fire while its own thread is stuck in a synchronous
    // read (a FIFO, a stalled filesystem, a token file; #108 F2).
    await precompactWatchdog(argv);
    return;
  }
  if (hook && !process.stdin.isTTY) {
    try {
      const input = hookInput(await readStdin(64 * 1024, PRECOMPACT_STDIN_MS));
      sessionId = input.sessionId;
      trigger = input.trigger;
      if (input.transcriptPath) {
        try {
          // Read now, at PreCompact: the daemon's last report can predate the tool
          // result that crossed the ceiling.
          const reading = holdReading(readTail(input.transcriptPath));
          if (reading.tokens !== undefined) {
            tokens = reading.tokens + pendingTokens(reading.pendingBytes);
          }
        } catch {
          // No reading: a hold never blocks without one (#107).
        }
      }
    } catch {
      // Unreadable stdin names no session; the daemon prints nothing without one.
    }
  }
  const ceiling = holdCeiling(process.env.FROND_EAR_HOLD_CEILING);
  const ear = values.ear ?? process.env.FROND_EAR_EAR;
  try {
    if (!ear) {
      throw new Error("precompact needs --ear <name> (or FROND_EAR_EAR)");
    }
    const result = await request(
      {
        type: "precompact",
        ear,
        ...(sessionId ? { sessionId } : {}),
        ...(trigger ? { trigger } : {}),
        ...(tokens !== undefined ? { tokens } : {}),
        ...(ceiling !== undefined ? { ceiling } : {}),
      },
      process.env,
      hook ? PRECOMPACT_DAEMON_MS : 5_000,
    );
    if (
      hook &&
      result.ok &&
      typeof result.block === "string" &&
      result.block !== ""
    ) {
      // The one blocking path (#107): the daemon answered that this session's own
      // hold blocks this auto compaction. stdout stays empty: no summary is written.
      process.stderr.write(`${oneLine(result.block, 400)}\n`);
      process.exitCode = 2;
      return;
    }
    if (result.ok && result.text !== "") {
      process.stdout.write(`${result.text}\n`);
    } else {
      process.stderr.write(
        `frond-ear precompact: ${result.ok ? "no unsettled letters to carry" : result.text}\n`,
      );
    }
    process.exitCode = result.ok || hook ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `frond-ear precompact: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = hook ? 0 : 1;
  }
}

/** The PreCompact hook's whole run, its stdin read and its daemon ask (#107). */
const PRECOMPACT_DEADLINE_MS = 4_000;
const PRECOMPACT_CHILD = "FROND_EAR_PRECOMPACT_CHILD";
/** Letters stay under 9,500 characters; anything past this is not ours to print. */
const PRECOMPACT_MAX_OUTPUT = 64 * 1024;

/**
 * Runs `precompact --hook` in a child with the same arguments and stdin, and kills it
 * at the deadline (#108 F2). Only a child that exits by itself is believed: exit 2
 * passes through with its stderr and an empty stdout, exit 0 with its stdout (the
 * letters). Killed, crashed, oversized or anything else: nothing on stdout, exit 0,
 * and the compaction goes ahead.
 */
function precompactWatchdog(argv: string[]): Promise<void> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let overflow = false;
    let settled = false;
    // Set once the worker exists: drops the signal and exit handlers below.
    let release = () => {};
    const finish = (code: number, stdout: string, stderr: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      release();
      if (stdout !== "") {
        process.stdout.write(stdout);
      }
      if (stderr !== "") {
        process.stderr.write(stderr);
      }
      process.exitCode = code;
      // Our own stdin may never end; nothing else is left to wait for.
      process.stdin.destroy();
      resolve();
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        process.execPath,
        [...process.execArgv, process.argv[1] ?? "", "precompact", ...argv],
        {
          env: {
            ...process.env,
            [PRECOMPACT_CHILD]: "1",
            NODE_NO_WARNINGS: "1",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch (error) {
      finish(
        0,
        "",
        `frond-ear precompact: ${error instanceof Error ? error.message : String(error)}; the compaction goes ahead\n`,
      );
      return;
    }
    // The worker is ours: if this process is told to stop (Claude Code cancelling
    // the hook, a hook timeout, ^C) or exits any other way, the worker goes with it,
    // even while it is stuck in a read no timer of its own could interrupt (#108 F6).
    const killWorker = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    };
    const onSignal = (signal: NodeJS.Signals) => {
      killWorker();
      process.stderr.write(
        `frond-ear precompact: ${signal}; the worker was stopped and the compaction goes ahead\n`,
      );
      process.exit(0);
    };
    const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
    for (const signal of signals) {
      process.on(signal, onSignal);
    }
    process.on("exit", killWorker);
    release = () => {
      for (const signal of signals) {
        process.off(signal, onSignal);
      }
      process.off("exit", killWorker);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        0,
        "",
        `frond-ear precompact: deadline (${PRECOMPACT_DEADLINE_MS} ms) passed; the compaction goes ahead\n`,
      );
    }, PRECOMPACT_DEADLINE_MS);
    const take = (chunk: Buffer, into: "out" | "err") => {
      if (into === "out") {
        out += chunk.toString();
      } else {
        err += chunk.toString();
      }
      if (out.length + err.length > PRECOMPACT_MAX_OUTPUT && !overflow) {
        overflow = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => take(chunk, "out"));
    child.stderr?.on("data", (chunk: Buffer) => take(chunk, "err"));
    child.stdin?.on("error", () => {
      // The child stopped reading (it timed out or exited): nothing to do.
    });
    if (!process.stdin.isTTY && child.stdin) {
      process.stdin.pipe(child.stdin);
    } else {
      child.stdin?.end();
    }
    child.on("error", (error) =>
      finish(
        0,
        "",
        `frond-ear precompact: ${error.message}; the compaction goes ahead\n`,
      ),
    );
    child.on("close", (code, signal) => {
      const outcome = watchdogOutcome({ code, signal, overflow, out, err });
      finish(outcome.code, outcome.stdout, outcome.stderr);
    });
  });
}
const PRECOMPACT_STDIN_MS = 1_000;
const PRECOMPACT_DAEMON_MS = 2_500;

/**
 * The seat's hold ceiling (#107) from FROND_EAR_HOLD_CEILING: a whole number of
 * tokens, about 60% of the model's window. Unset or unusable: undefined, and then a
 * hold never blocks.
 */
function holdCeiling(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,8}$/u.test(value.trim())) {
    return undefined;
  }
  const number = Number(value.trim());
  return number > 0 ? number : undefined;
}

/** One line, no control characters, at most `max` characters. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function readStdin(maxBytes: number, timeoutMs?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (timeoutMs !== undefined) {
      setTimeout(() => {
        reject(new Error("stdin did not end in time"));
        process.stdin.destroy();
      }, timeoutMs).unref();
    }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
      if (Buffer.byteLength(data) > maxBytes) {
        reject(new Error("stdin too large"));
        process.stdin.destroy();
      }
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
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
    case "send":
      process.exitCode = await runSend(rest, {
        stdout: process.stdout,
        stderr: process.stderr,
        env: process.env,
      });
      return;
    case "inject":
      await runInject(rest);
      return;
    case "release":
      await runRelease(rest);
      return;
    case "precompact":
      await runPrecompact(rest);
      return;
    case "pressure":
      process.exitCode = await runPressureCommand(rest, {
        // Only the hook reads stdin. A hand run from a shell whose stdin is a
        // pipe or socket that never ends (an agent's tool shell) would wait on it
        // forever. PostToolUse's JSON carries the whole tool response, so the cap
        // is wide; past it the gauge just stays quiet.
        stdin:
          pressureHookRequested(rest) && !process.stdin.isTTY
            ? await readStdin(32 * 1024 * 1024).catch(() => "")
            : "",
        stdout: process.stdout,
        stderr: process.stderr,
        env: process.env,
      });
      return;
    case "tap":
      runTap(rest);
      return;
    case "copilot-extension":
      runCopilotExtension(rest);
      return;
    case "connector-echo":
      process.exitCode = await runConnectorEcho(rest, {
        stdout: process.stdout,
        stderr: process.stderr,
      });
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return;
    default:
      process.stderr.write(`unknown command ${command}\n\n${USAGE}`);
      // 1, never 2: frond-ear runs inside Claude Code hooks, where exit 2 blocks
      // (refuses a prompt, blocks a compaction); a typo'd subcommand must not.
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `frond-ear: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
