// Chaos controller for frond-ear proof rows.
//
// Stands up everything around a *real* frond-ear daemon process so k6 rows
// (tools/chaos/scenarios/*.js) can drive crash/restart and delivery scenarios
// over plain HTTP, the way the karmaterminal k6 proof harness drives a gateway:
//
//   - fake Discord: a WebSocket Gateway with a sequenced dispatch log that
//     replays on RESUME, plus REST endpoints with fault injection (hold a send,
//     drop the connection after Discord accepted it) and enforce_nonce dedupe;
//   - daemon supervisor: start / SIGTERM / SIGKILL of `node src/cli.ts daemon`;
//   - fake Claude session: the real shim spawned under the official MCP SDK
//     client, recording every <channel> notification;
//   - ledger: accepted events, notifications, acknowledgements, sent-message
//     receipts and what Discord actually received, with each outbound post
//     classified as receipted or ambiguous.
//
// Nothing here touches real Discord or a real Claude session.
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketServer, type WebSocket } from "ws";

const REPO = resolve(import.meta.dirname, "..", "..");
const CLI = join(REPO, "src", "cli.ts");

export const IDS = {
  bot: "100000000000000001",
  principal: "200000000000000002",
  ambient: "400000000000000004",
  guild: "600000000000000006",
  channel: "700000000000000007",
  room: "700000000000000008",
} as const;

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

// ---- fake Discord ------------------------------------------------------------

interface Dispatch {
  op: 0;
  t: string;
  s: number;
  d: unknown;
}

interface Post {
  id: string;
  channelId: string;
  content: string;
  replyTo: string | null;
  nonce: string | null;
  acceptedAt: number;
}

class FakeDiscord {
  public seq = 0;
  public readonly dispatches: Dispatch[] = [];
  public readonly posts: Post[] = [];
  public readonly reactions: Array<{
    channelId: string;
    messageId: string;
    emoji: string;
  }> = [];
  public resumeOverride: number | undefined;
  public holdSends = 0;
  public dropAfterAccept = 0;
  public nonceDedupe = true;
  public gatewayConnections = 0;
  public resumes: number[] = [];
  /** Completed IDENTIFY/RESUME handshakes; a barrier for "gateway ready". */
  public handshakes = 0;
  private readonly held: Array<() => void> = [];
  private readonly sockets = new Set<WebSocket>();
  private nextMessageId = 1_300_000_000_000_000_000n;

  public attach(socket: WebSocket): void {
    this.sockets.add(socket);
    this.gatewayConnections += 1;
    socket.on("close", () => this.sockets.delete(socket));
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
    socket.on("message", (raw) => {
      const payload = JSON.parse(String(raw)) as { op: number; d: unknown };
      if (payload.op === 1) {
        socket.send(JSON.stringify({ op: 11 }));
      } else if (payload.op === 2) {
        socket.send(
          JSON.stringify({
            op: 0,
            t: "READY",
            s: this.seq,
            d: { session_id: "fake-session", resume_gateway_url: this.url },
          }),
        );
        this.handshakes += 1;
      } else if (payload.op === 6) {
        const requested = (payload.d as { seq: number }).seq;
        const from = this.resumeOverride ?? requested;
        this.resumeOverride = undefined;
        this.resumes.push(requested);
        for (const dispatch of this.dispatches.filter(
          (item) => item.s > from,
        )) {
          socket.send(JSON.stringify(dispatch));
        }
        socket.send(
          JSON.stringify({ op: 0, t: "RESUMED", s: this.seq, d: {} }),
        );
        this.handshakes += 1;
      }
    });
  }

  public url = "";

  public postInbound(input: {
    channel: string;
    author: string;
    content: string;
    mention?: boolean;
    bot?: boolean;
  }): string {
    const id = String(this.nextMessageId++);
    const content = input.mention
      ? `<@${IDS.bot}> ${input.content}`
      : input.content;
    const dispatch: Dispatch = {
      op: 0,
      t: "MESSAGE_CREATE",
      s: ++this.seq,
      d: {
        id,
        channel_id: input.channel,
        guild_id: IDS.guild,
        author: {
          id: input.author,
          username: `user-${input.author.slice(-3)}`,
          ...(input.bot ? { bot: true } : {}),
        },
        content,
        timestamp: new Date().toISOString(),
        mentions: input.mention ? [{ id: IDS.bot }] : [],
      },
    };
    this.dispatches.push(dispatch);
    for (const socket of this.sockets) {
      socket.send(JSON.stringify(dispatch));
    }
    return id;
  }

  /** Asks every connected client to reconnect (op 7); they resume. */
  public requestReconnect(resumeFrom?: number): void {
    this.resumeOverride = resumeFrom;
    for (const socket of this.sockets) {
      socket.send(JSON.stringify({ op: 7, d: null }));
    }
  }

  public release(): number {
    const count = this.held.length;
    for (const resume of this.held.splice(0)) {
      resume();
    }
    return count;
  }

  public get heldCount(): number {
    return this.held.length;
  }

  public async rest(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const reply = (status: number, value?: unknown) => {
      if (response.destroyed) {
        return;
      }
      response.writeHead(status, { "content-type": "application/json" });
      response.end(value === undefined ? undefined : JSON.stringify(value));
    };
    const messages = /^\/channels\/(\d+)\/messages$/u.exec(path);
    if (messages && request.method === "POST") {
      const channelId = messages[1] as string;
      const nonce = typeof body.nonce === "string" ? body.nonce : null;
      if (this.holdSends > 0) {
        this.holdSends -= 1;
        await new Promise<void>((done) => this.held.push(done));
      }
      // Discord's enforce_nonce: the same nonce from the same author within a
      // few minutes returns the original message instead of creating one.
      if (nonce && body.enforce_nonce === true && this.nonceDedupe) {
        const existing = this.posts.find(
          (post) => post.nonce === nonce && post.channelId === channelId,
        );
        if (existing) {
          reply(200, {
            id: existing.id,
            channel_id: channelId,
            content: existing.content,
            nonce,
          });
          return;
        }
      }
      const post: Post = {
        id: String(this.nextMessageId++),
        channelId,
        content: String(body.content ?? ""),
        replyTo:
          (body.message_reference as { message_id?: string } | undefined)
            ?.message_id ?? null,
        nonce,
        acceptedAt: Date.now(),
      };
      this.posts.push(post); // accepted by "Discord", whatever happens to the response
      if (this.dropAfterAccept > 0) {
        this.dropAfterAccept -= 1;
        response.socket?.destroy();
        return;
      }
      reply(200, {
        id: post.id,
        channel_id: channelId,
        content: post.content,
        nonce,
      });
      return;
    }
    if (messages && request.method === "GET") {
      const channelId = messages[1] as string;
      const inbound = this.dispatches
        .filter(
          (item) =>
            item.t === "MESSAGE_CREATE" &&
            (item.d as { channel_id: string }).channel_id === channelId,
        )
        .map((item) => item.d);
      const outbound = this.posts
        .filter((post) => post.channelId === channelId)
        .map((post) => ({
          id: post.id,
          channel_id: channelId,
          author: { id: IDS.bot, username: "frond-ear", bot: true },
          content: post.content,
          timestamp: new Date(post.acceptedAt).toISOString(),
        }));
      reply(200, [...inbound, ...outbound]);
      return;
    }
    const reaction =
      /^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)\/@me$/u.exec(
        path,
      );
    if (reaction && request.method === "PUT") {
      this.reactions.push({
        channelId: reaction[1] as string,
        messageId: reaction[2] as string,
        emoji: decodeURIComponent(reaction[3] as string),
      });
      reply(204);
      return;
    }
    const edit = /^\/channels\/(\d+)\/messages\/(\d+)$/u.exec(path);
    if (edit && request.method === "PATCH") {
      const post = this.posts.find((item) => item.id === edit[2]);
      if (post) {
        post.content = String(body.content ?? post.content);
      }
      reply(
        post ? 200 : 404,
        post ? { id: post.id } : { code: 10008, message: "Unknown Message" },
      );
      return;
    }
    reply(404, {
      code: 0,
      message: `fake discord: no route ${request.method} ${path}`,
    });
  }
}

// ---- daemon supervisor --------------------------------------------------------------

class Supervisor {
  public process: ChildProcess | undefined;
  public exits: Array<{ code: number | null; signal: string | null }> = [];
  public stderr = "";
  public readonly directory: string;
  public readonly socket: string;
  public readonly database: string;
  public readonly config: string;
  private readonly port: number;

  public constructor(directory: string, port: number) {
    this.directory = directory;
    this.socket = join(directory, "run", "daemon.sock");
    this.database = join(directory, "state", "ear.db");
    this.config = join(directory, "frond-ear.json");
    this.port = port;
  }

  public writeConfig(channels: Record<string, unknown>): void {
    writeFileSync(
      this.config,
      JSON.stringify({
        botUserId: IDS.bot,
        principals: [IDS.principal],
        labels: { [IDS.principal]: "figs" },
        ears: {
          scribe: { target: "claude-channel", attachCanary: true, channels },
        },
        defaults: {
          quietWindowMs: 1_500,
          maxDelayMs: 5_000,
          priorityQuietMs: 300,
        },
      }),
    );
  }

  public env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      FROND_EAR_CONFIG: this.config,
      FROND_EAR_DATABASE: this.database,
      FROND_EAR_SOCKET: this.socket,
      DISCORD_BOT_TOKEN: "fixture-token",
      DISCORD_GATEWAY_URL: `ws://127.0.0.1:${this.port}/gateway`,
      DISCORD_API_BASE: `http://127.0.0.1:${this.port}/api/v10`,
    };
  }

  public async start(): Promise<void> {
    if (this.process) {
      throw new Error("daemon already running");
    }
    const child = spawn(process.execPath, [CLI, "daemon"], {
      env: this.env(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    child.on("exit", (code, signal) => {
      this.exits.push({ code, signal });
      if (this.process === child) {
        this.process = undefined;
      }
    });
    this.process = child;
    const deadline = Date.now() + 10_000;
    while (!this.stderr.includes('"daemon.listening"')) {
      if (Date.now() > deadline || !this.process) {
        throw new Error(`daemon did not start:\n${this.stderr.slice(-2_000)}`);
      }
      await sleep(25);
    }
  }

  public async stop(
    signal: NodeJS.Signals,
  ): Promise<{ code: number | null; signal: string | null }> {
    const child = this.process;
    if (!child) {
      throw new Error("daemon not running");
    }
    const exited = new Promise<{ code: number | null; signal: string | null }>(
      (done) => child.once("exit", (code, sig) => done({ code, signal: sig })),
    );
    child.kill(signal);
    return exited;
  }
}

// ---- fake Claude session -----------------------------------------------------------

interface Notification {
  at: number;
  content: string;
  meta: Record<string, string>;
  messageIds: string[];
}

class FakeSession {
  public client: Client | undefined;
  public readonly notifications: Notification[] = [];
  public readonly calls = new Map<
    number,
    { tool: string; done: boolean; ok?: boolean; text?: string }
  >();
  private nextCall = 1;

  public async attach(
    env: NodeJS.ProcessEnv,
    sessionId: string,
  ): Promise<void> {
    const client = new Client(
      { name: "chaos-claude", version: "0.0.0" },
      { capabilities: {} },
    );
    client.fallbackNotificationHandler = async (notification) => {
      if (notification.method !== "notifications/claude/channel") {
        return;
      }
      const params = notification.params as unknown as {
        content: string;
        meta: Record<string, string>;
      };
      this.notifications.push({
        at: Date.now(),
        content: params.content,
        meta: params.meta,
        messageIds: [...params.content.matchAll(/msg (\d+)/gu)].map(
          (match) => match[1] as string,
        ),
      });
      // Behave like a well-configured session: confirm the attach canary.
      if (params.meta.kind === "attach" && params.meta.nonce) {
        await client
          .callTool({ name: "ack", arguments: { nonce: params.meta.nonce } })
          .catch(() => undefined);
      }
    };
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI, "shim"],
        env: {
          ...(env as Record<string, string>),
          FROND_EAR_EAR: "scribe",
          CLAUDE_CODE_SESSION_ID: sessionId,
        },
        stderr: "ignore",
      }),
    );
    this.client = client;
  }

  public async detach(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
  }

  public start(tool: string, args: Record<string, unknown>): number {
    const id = this.nextCall++;
    const record: { tool: string; done: boolean; ok?: boolean; text?: string } =
      { tool, done: false };
    this.calls.set(id, record);
    const client = this.client;
    if (!client) {
      Object.assign(record, {
        done: true,
        ok: false,
        text: "no session attached",
      });
      return id;
    }
    client
      .callTool({ name: tool, arguments: args }, undefined, {
        timeout: 120_000,
      })
      .then((result) => {
        const text =
          (result.content as Array<{ text?: string }>)[0]?.text ?? "";
        Object.assign(record, {
          done: true,
          ok: result.isError !== true,
          text,
        });
      })
      .catch((error: unknown) => {
        Object.assign(record, {
          done: true,
          ok: false,
          text: error instanceof Error ? error.message : String(error),
        });
      });
    return id;
  }
}

// ---- ledger ---------------------------------------------------------------------------------

function readLedgerDb(path: string): {
  events: Array<{
    message_id: string;
    chat_id: string;
    state: string;
    batch_id: number | null;
  }>;
  sent: Array<{ message_id: string; channel_id: string }>;
  intents: Array<Record<string, unknown>>;
  batches: Array<{ id: number; chat_id: string; offered_at: number | null }>;
  counters: Record<string, number>;
} {
  if (!existsSync(path)) {
    return { events: [], sent: [], intents: [], batches: [], counters: {} };
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    );
    return {
      events: db
        .prepare(
          "SELECT message_id, chat_id, state, batch_id FROM events ORDER BY id",
        )
        .all() as Array<{
        message_id: string;
        chat_id: string;
        state: string;
        batch_id: number | null;
      }>,
      sent: tables.has("sent_messages")
        ? (db
            .prepare("SELECT message_id, channel_id FROM sent_messages")
            .all() as Array<{
            message_id: string;
            channel_id: string;
          }>)
        : [],
      batches: db
        .prepare("SELECT id, chat_id, offered_at FROM batches ORDER BY id")
        .all() as Array<{
        id: number;
        chat_id: string;
        offered_at: number | null;
      }>,
      counters: Object.fromEntries(
        (
          db.prepare("SELECT name, value FROM counters").all() as Array<{
            name: string;
            value: number;
          }>
        ).map((row) => [row.name, row.value]),
      ),
      intents: tables.has("outbound_intents")
        ? (db
            .prepare("SELECT * FROM outbound_intents ORDER BY created_at")
            .all() as Array<Record<string, unknown>>)
        : [],
    };
  } finally {
    db.close();
  }
}

// ---- controller ------------------------------------------------------------------------------

class Controller {
  public discord = new FakeDiscord();
  public supervisor: Supervisor;
  public session = new FakeSession();
  public inbound: string[] = [];
  private readonly port: number;
  private directory: string;

  public constructor(port: number) {
    this.port = port;
    this.directory = mkdtempSync(join(tmpdir(), "frond-ear-chaos-"));
    this.supervisor = new Supervisor(this.directory, port);
    this.discord.url = `ws://127.0.0.1:${port}/gateway`;
  }

  public async reset(channels?: Record<string, unknown>): Promise<void> {
    await this.session.detach();
    if (this.supervisor.process) {
      await this.supervisor.stop("SIGKILL");
    }
    rmSync(this.directory, { recursive: true, force: true });
    this.directory = mkdtempSync(join(tmpdir(), "frond-ear-chaos-"));
    this.discord = new FakeDiscord();
    this.discord.url = `ws://127.0.0.1:${this.port}/gateway`;
    this.supervisor = new Supervisor(this.directory, this.port);
    this.supervisor.writeConfig(
      channels ?? {
        [IDS.channel]: { mode: "mentions" },
        [IDS.room]: { mode: "room" },
      },
    );
    this.session = new FakeSession();
    this.inbound = [];
  }

  public ledger(): object {
    const db = readLedgerDb(this.supervisor.database);
    const receipted = new Set(db.sent.map((row) => row.message_id));
    const posts = this.discord.posts.map((post) => ({
      ...post,
      receipted: receipted.has(post.id),
    }));
    const byText = new Map<string, number>();
    for (const post of posts) {
      const key = `${post.channelId}\u0000${post.content}`;
      byText.set(key, (byText.get(key) ?? 0) + 1);
    }
    const inbound = this.inbound.map((id) => {
      const rows = db.events.filter((row) => row.message_id === id);
      const notified = this.session.notifications.filter((item) =>
        item.messageIds.includes(id),
      ).length;
      return {
        id,
        acceptedRows: rows.length,
        state: rows[0]?.state ?? null,
        batch: rows[0]?.batch_id ?? null,
        notified,
        notifiedIn: this.session.notifications
          .filter((item) => item.messageIds.includes(id))
          .map((item) => ({ kind: item.meta.kind, batch: item.meta.batch_id })),
      };
    });
    return {
      inbound,
      notifications: this.session.notifications.map(
        ({ meta, messageIds, at }) => ({ at, meta, messageIds }),
      ),
      outbound: {
        posts: posts.map((post) => ({
          ...post,
          classification: post.receipted
            ? "receipted"
            : "ambiguous-unreceipted",
          duplicates:
            (byText.get(`${post.channelId}\u0000${post.content}`) ?? 1) - 1,
        })),
        receipts: db.sent,
        intents: db.intents,
        reactions: this.discord.reactions,
      },
      counters: db.counters,
      gateway: {
        connections: this.discord.gatewayConnections,
        resumes: this.discord.resumes,
        seq: this.discord.seq,
      },
      daemon: {
        running: this.supervisor.process !== undefined,
        exits: this.supervisor.exits,
      },
      summary: {
        acceptedUnique: inbound.every((item) => item.acceptedRows <= 1),
        maxNotificationsPerEvent: Math.max(
          0,
          ...inbound.map((item) => item.notified),
        ),
        posts: posts.length,
        receipted: posts.filter((post) => post.receipted).length,
        ambiguous: posts.filter((post) => !post.receipted).length,
        duplicatePosts: [...byText.values()].reduce(
          (sum, count) => sum + (count - 1),
          0,
        ),
      },
    };
  }

  private async until(
    condition: () => boolean,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) {
        return false;
      }
      await sleep(10);
    }
    return true;
  }

  /**
   * Deterministic barriers: block until an observable state is reached (a
   * ledger row, a held send, quiescence), never for a fixed time. Returns
   * reached=false on timeout so the row fails rather than guessing.
   */
  private async barrier(query: URLSearchParams): Promise<object> {
    const cond = query.get("cond");
    const timeoutMs = Number(query.get("timeoutMs") ?? 10_000);
    const started = Date.now();
    const db = () => readLedgerDb(this.supervisor.database);
    let condition: () => boolean;
    switch (cond) {
      case "event-state": {
        const id = query.get("messageId");
        const states = (query.get("state") ?? "").split(",");
        condition = () =>
          db().events.some(
            (row) => row.message_id === id && states.includes(row.state),
          );
        break;
      }
      case "batch-confirmed": {
        const id = query.get("messageId");
        condition = () => {
          const ledger = db();
          const event = ledger.events.find((row) => row.message_id === id);
          return (
            event?.batch_id !== undefined &&
            event.batch_id !== null &&
            ledger.batches.some(
              (batch) =>
                batch.id === event.batch_id && batch.offered_at !== null,
            )
          );
        };
        break;
      }
      case "counter": {
        const name = query.get("name") ?? "";
        const min = Number(query.get("min") ?? 1);
        condition = () => (db().counters[name] ?? 0) >= min;
        break;
      }
      case "held": {
        const count = Number(query.get("count") ?? 1);
        condition = () => this.discord.heldCount >= count;
        break;
      }
      case "posts": {
        const count = Number(query.get("count") ?? 1);
        condition = () => this.discord.posts.length >= count;
        break;
      }
      case "quiescent": {
        // Nothing waiting to flush, every batch confirmed by the shim, and
        // every confirmed batch observed by the session.
        condition = () => {
          const ledger = db();
          const seen = new Set(
            // A pushed batch_id is `<id>-<delivery token>`.
            this.session.notifications.map(
              (item) => item.meta.batch_id?.split("-")[0],
            ),
          );
          return (
            !ledger.events.some((row) => row.state === "queued") &&
            ledger.batches.every(
              (batch) =>
                batch.offered_at !== null && seen.has(String(batch.id)),
            )
          );
        };
        break;
      }
      default:
        throw Object.assign(new Error(`unknown barrier ${cond}`), {
          status: 400,
        });
    }
    const reached = await this.until(condition, timeoutMs);
    return { reached, cond, waitedMs: Date.now() - started };
  }

  public async handle(
    method: string,
    path: string,
    query: URLSearchParams,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    switch (`${method} ${path}`) {
      case "POST /reset":
        await this.reset(body.channels as Record<string, unknown> | undefined);
        return { ok: true, directory: this.directory };
      case "POST /daemon/start": {
        // Barrier: the daemon is listening AND its gateway has completed an
        // IDENTIFY or RESUME, so Discord would now deliver to it.
        const before = this.discord.handshakes;
        await this.supervisor.start();
        const ready = await this.until(
          () => this.discord.handshakes > before,
          10_000,
        );
        if (!ready) {
          throw new Error(
            "daemon started but its gateway never identified/resumed",
          );
        }
        return { ok: true };
      }
      case "POST /daemon/stop": {
        // releaseOnDraining: hold Discord sends until the daemon has logged
        // that it is draining, then release them. This orders "SIGTERM seen,
        // drain started" strictly before "Discord answers" without sleeps.
        const releaseOnDraining = body.releaseOnDraining === true;
        const mark = this.supervisor.stderr.length;
        const stopping = this.supervisor.stop(
          (body.signal as NodeJS.Signals) ?? "SIGTERM",
        );
        let releasedAfterDrainStarted = false;
        if (releaseOnDraining) {
          const reached = await this.until(
            () =>
              this.supervisor.stderr.slice(mark).includes('"daemon.draining"'),
            10_000,
          );
          releasedAfterDrainStarted = reached;
          this.discord.release();
        }
        return { ok: true, releasedAfterDrainStarted, exit: await stopping };
      }
      case "GET /barrier":
        return this.barrier(query);
      case "POST /config":
        this.supervisor.writeConfig(body.channels as Record<string, unknown>);
        return { ok: true };
      case "POST /session/attach":
        await this.session.attach(
          this.supervisor.env(),
          String(body.sessionId ?? "chaos-session"),
        );
        return { ok: true };
      case "POST /session/detach":
        await this.session.detach();
        return { ok: true };
      case "POST /session/call": {
        const id = this.session.start(
          String(body.tool),
          (body.args as Record<string, unknown>) ?? {},
        );
        if (body.async === true) {
          return { callId: id };
        }
        const deadline = Date.now() + Number(body.timeoutMs ?? 20_000);
        for (;;) {
          const record = this.session.calls.get(id);
          if (record?.done || Date.now() > deadline) {
            return { callId: id, ...record };
          }
          await sleep(20);
        }
      }
      case "GET /session/call": {
        return (
          this.session.calls.get(Number(query.get("id"))) ?? {
            done: false,
            missing: true,
          }
        );
      }
      case "GET /session/wait": {
        const kind = query.get("kind");
        const contains = query.get("contains");
        const after = Number(query.get("after") ?? 0);
        const deadline = Date.now() + Number(query.get("timeoutMs") ?? 10_000);
        for (;;) {
          const match = this.session.notifications.find(
            (item) =>
              item.at >= after &&
              (!kind || item.meta.kind === kind) &&
              (!contains || item.content.includes(contains)),
          );
          if (match) {
            return { found: true, notification: match };
          }
          if (Date.now() > deadline) {
            return { found: false };
          }
          await sleep(20);
        }
      }
      case "POST /discord/post": {
        const id = this.discord.postInbound(
          body as { channel: string; author: string; content: string },
        );
        this.inbound.push(id);
        return { id, seq: this.discord.seq };
      }
      case "POST /discord/reconnect":
        this.discord.requestReconnect(
          body.resumeFrom === undefined ? undefined : Number(body.resumeFrom),
        );
        return { ok: true };
      case "POST /discord/fault":
        if (body.holdSends !== undefined)
          this.discord.holdSends = Number(body.holdSends);
        if (body.dropAfterAccept !== undefined)
          this.discord.dropAfterAccept = Number(body.dropAfterAccept);
        if (body.nonceDedupe !== undefined)
          this.discord.nonceDedupe = body.nonceDedupe === true;
        return { ok: true };
      case "GET /discord/held":
        return { held: this.discord.heldCount };
      case "POST /discord/release":
        return { released: this.discord.release() };
      case "GET /ledger": {
        const ledger = this.ledger();
        const save = query.get("save");
        if (save) {
          mkdirSync(dirname(save), { recursive: true });
          writeFileSync(save, `${JSON.stringify(ledger, null, 2)}\n`);
        }
        return ledger;
      }
      case "GET /daemon/stderr":
        return { stderr: this.supervisor.stderr.slice(-8_000) };
      default:
        throw Object.assign(new Error(`no route ${method} ${path}`), {
          status: 404,
        });
    }
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { port: { type: "string", default: "7788" } },
  });
  const port = Number(values.port);
  const controller = new Controller(port);
  await controller.reset();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    request.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (url.pathname.startsWith("/api/v10/")) {
        void controller.discord.rest(
          request,
          response,
          url.pathname.slice("/api/v10".length),
          body,
        );
        return;
      }
      controller
        .handle(request.method ?? "GET", url.pathname, url.searchParams, body)
        .then((result) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(result));
        })
        .catch((error: Error & { status?: number }) => {
          response.writeHead(error.status ?? 500, {
            "content-type": "application/json",
          });
          response.end(JSON.stringify({ error: error.message }));
        });
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => controller.discord.attach(socket));
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  process.stdout.write(
    `chaos controller listening on http://127.0.0.1:${port}\n`,
  );
  const stop = async () => {
    await controller.session.detach();
    if (controller.supervisor.process) {
      await controller.supervisor.stop("SIGKILL");
    }
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

await main();
