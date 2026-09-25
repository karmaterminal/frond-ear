import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Config } from "./config.ts";
import type { StructuredLogger } from "./logger.ts";
import {
  WakeLimiter,
  classify,
  narrower,
  routeFor,
  trustOf,
} from "./policy.ts";
import type { ClientMessage, Connection } from "./protocol.ts";
import { EAR_PROTOCOL_VERSION } from "./protocol.ts";
import {
  channelInstructions,
  renderBatch,
  renderCanary,
  renderDigest,
  renderEvent,
} from "./render.ts";
import type { DiscordRest } from "./rest.ts";
import { chunkMessage } from "./rest.ts";
import type { EventStore } from "./store.ts";
import type {
  BatchKind,
  Clock,
  DiscordMessage,
  Mode,
  StoredEvent,
  Timers,
} from "./types.ts";
import { systemClock, systemTimers } from "./types.ts";

export interface DaemonOptions {
  config: Config;
  store: EventStore;
  rest: DiscordRest;
  logger: StructuredLogger;
  clock?: Clock;
  timers?: Timers;
  allowInject?: boolean;
  /** Required on TCP listeners; unix sockets rely on filesystem permissions. */
  token?: string;
  nonce?: () => string;
  gatewayStatus?: () => object;
}

interface Client {
  connection: Connection;
  requireToken: boolean;
  hello: boolean;
  role: "shim" | "cli" | undefined;
  ear: string | undefined;
  attachGeneration: number;
  sessionId: string | undefined;
  pid: number | undefined;
}

export type IngestOutcome = "inserted" | "duplicate" | "rejected";

function stringArg(
  args: Record<string, unknown>,
  name: string,
  required: true,
): string;
function stringArg(
  args: Record<string, unknown>,
  name: string,
  required?: false,
): string | undefined;
function stringArg(
  args: Record<string, unknown>,
  name: string,
  required = false,
): string | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new Error(`${name} is required`);
    }
    return undefined;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${name} must be a string`);
  }
  return String(value);
}

const SNOWFLAKE = /^\d{1,25}$/u;

/** Discord IDs must be snowflakes: anything else could steer a REST path. */
function snowflakeArg(
  args: Record<string, unknown>,
  name: string,
  required: true,
): string;
function snowflakeArg(
  args: Record<string, unknown>,
  name: string,
  required?: false,
): string | undefined;
function snowflakeArg(
  args: Record<string, unknown>,
  name: string,
  required = false,
): string | undefined {
  const value = required ? stringArg(args, name, true) : stringArg(args, name);
  if (value !== undefined && !SNOWFLAKE.test(value)) {
    throw new Error(`${name} must be a Discord ID (digits only)`);
  }
  return value;
}

function numberArg(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
  max: number,
): number {
  const value = args[name];
  if (value === undefined || value === null) {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Math.min(number, max);
}

function tokenMatches(
  presented: unknown,
  expected: string | undefined,
): boolean {
  if (typeof presented !== "string" || !expected) {
    return false;
  }
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

export function isDiscordMessage(value: unknown): value is DiscordMessage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const message = value as Partial<DiscordMessage>;
  return (
    typeof message.id === "string" &&
    typeof message.channel_id === "string" &&
    typeof message.content === "string" &&
    typeof message.timestamp === "string" &&
    typeof message.author?.id === "string" &&
    (message.guild_id === undefined || typeof message.guild_id === "string")
  );
}

function displayName(message: DiscordMessage): string {
  return (
    message.member?.nick ??
    message.author.global_name ??
    message.author.username ??
    message.author.id
  );
}

export class Daemon {
  private config: Config;
  private readonly store: EventStore;
  private readonly rest: DiscordRest;
  private readonly logger: StructuredLogger;
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly options: DaemonOptions;
  private readonly clients = new Set<Client>();
  private readonly attached = new Map<string, Client>();
  private botLimiter: WakeLimiter;
  private ambientLimiter: WakeLimiter;
  private timer: unknown;
  private timerDue: number | undefined;

  public constructor(options: DaemonOptions) {
    this.options = options;
    this.config = options.config;
    this.store = options.store;
    this.rest = options.rest;
    this.logger = options.logger;
    this.clock = options.clock ?? systemClock;
    this.timers = options.timers ?? systemTimers;
    this.botLimiter = new WakeLimiter(options.config.botLoop);
    this.ambientLimiter = new WakeLimiter(options.config.ambientWake);
    const repaired = this.store.repairUnscheduled(this.clock.now());
    if (repaired > 0) {
      this.logger.log("warn", "ear.repaired_unscheduled", { repaired });
    }
  }

  public reloadConfig(config: Config): void {
    this.config = config;
    this.botLimiter = new WakeLimiter(config.botLoop);
    this.ambientLimiter = new WakeLimiter(config.ambientWake);
    for (const [ear, client] of this.attached) {
      if (!config.ears[ear]) {
        client.connection.send({ type: "detached", reason: "ear_removed" });
        this.detach(client);
      }
    }
    this.reconcileRouting();
    this.tick();
  }

  /**
   * Re-validates undelivered events against the current routing. A chat that
   * is no longer bound to the ear holding its events is revoked (dropped, never
   * delivered to the old ear); a chat that became silent keeps its events as
   * inbox-only. Other mode changes do not reclassify rows already admitted.
   */
  private reconcileRouting(): void {
    for (const { ear, chatId } of this.store.pendingChats()) {
      if (this.earForChat(chatId) !== ear) {
        const revoked = this.store.revokeChat(ear, chatId);
        this.store.increment("routing_revoked", revoked);
        this.logger.log("warn", "ear.routing_revoked", {
          ear,
          chatId,
          revoked,
        });
      } else if (this.chatMode(chatId) === "silent") {
        this.store.silenceChat(ear, chatId);
      }
    }
  }

  private chatMode(chatId: string): Mode | undefined {
    if (this.store.isDmChannel(chatId)) {
      return this.config.dmEar
        ? this.config.ears[this.config.dmEar]?.dmMode
        : undefined;
    }
    return routeFor(
      this.config,
      { guild_id: "guild", channel_id: chatId },
      (id) => this.store.threadParent(id),
    )?.channel.mode;
  }

  // ---- ingest ------------------------------------------------------------------

  public recordThread(threadId: string, parentId: string): void {
    this.store.setThreadParent(threadId, parentId);
  }

  public ingest(message: unknown): IngestOutcome {
    if (!isDiscordMessage(message)) {
      this.store.increment("rejected_invalid_payload");
      return "rejected";
    }
    const now = this.clock.now();
    const classification = classify(this.config, message, {
      threadParent: (id) => this.store.threadParent(id),
      attention: (ear, chatId, time) =>
        this.store.attentionFor(ear, chatId, time),
      wakeBudgetExhausted: (kind, chatId, time) =>
        (kind === "bot" ? this.botLimiter : this.ambientLimiter).recordAndCheck(
          chatId,
          time,
        ),
      now,
    });
    if (!classification.accept) {
      this.store.increment(`rejected_${classification.reason}`);
      return "rejected";
    }
    const outcome = this.store.atomically(() =>
      this.admit(message, classification),
    );
    if (outcome === "duplicate") {
      this.store.increment("duplicates");
      // A crash between insert and scheduling is impossible now (one
      // transaction), but repair any row stranded by an older build.
      if (this.store.repairUnscheduled(this.clock.now()) > 0) {
        this.armTimer();
      }
      return "duplicate";
    }
    this.armTimer();
    return "inserted";
  }

  /**
   * Inserts the event and applies its initial ledger transitions (schedule,
   * history cap, pending cap) — the caller runs this in one transaction so a
   * crash can never leave an admitted row unscheduled.
   */
  private admit(
    message: DiscordMessage,
    classification: Extract<ReturnType<typeof classify>, { accept: true }>,
  ): "inserted" | "duplicate" {
    const { route } = classification;
    if (route.kind === "dm") {
      this.store.recordDmChannel(message.channel_id, message.author.id);
    }
    const outcome = this.store.insertEvent({
      messageId: message.id,
      ear: route.ear,
      chatId: route.chatId,
      guildId: message.guild_id ?? null,
      authorId: message.author.id,
      authorName: displayName(message),
      isBot: classification.isBot,
      trust: classification.trust,
      wake: classification.wake,
      priority: classification.priority,
      content: message.content.slice(0, this.config.limits.maxMessageChars),
      timestamp: message.timestamp,
      replyTo:
        message.message_reference?.message_id ??
        message.referenced_message?.id ??
        null,
      attachments: (message.attachments ?? []).map((file) => ({
        name: file.filename,
        type: file.content_type ?? "unknown",
        size: file.size,
      })),
      state: classification.state,
    });
    if (outcome === "duplicate") {
      return "duplicate";
    }
    this.store.increment(`accepted_${classification.state}`);
    if (classification.reason === "bot_loop_cooldown") {
      this.store.increment("bot_loop_suppressed");
    } else if (classification.reason === "ambient_wake_budget") {
      this.store.increment("ambient_wake_suppressed");
    }
    const defaults = this.config.defaults;
    if (classification.state === "queued") {
      const quiet = route.channel.quietWindowMs ?? defaults.quietWindowMs;
      this.store.scheduleChat(
        route.ear,
        route.chatId,
        classification.priority
          ? Math.min(defaults.priorityQuietMs, quiet)
          : quiet,
        route.channel.maxDelayMs ?? defaults.maxDelayMs,
        defaults.priorityQuietMs,
      );
    } else if (classification.state === "context") {
      const expired = this.store.expireContext(
        route.ear,
        route.chatId,
        route.channel.historyLimit ?? defaults.historyLimit,
      );
      if (expired > 0) {
        this.store.increment("context_expired", expired);
      }
    }
    const dropped = this.store.capPending(
      route.ear,
      this.config.limits.maxPendingPerEar,
    );
    if (dropped > 0) {
      this.store.increment("overflow_dropped", dropped);
      this.logger.log("warn", "ear.overflow", { ear: route.ear, dropped });
    }
    return "inserted";
  }

  // ---- scheduling ----------------------------------------------------------------

  /** Flushes every due chat for attached ears, then re-arms the timer. */
  public tick(): void {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
      this.timerDue = undefined;
    }
    if (!this.config.paused) {
      const now = this.clock.now();
      for (const [ear, client] of this.attached) {
        for (const chatId of this.store.dueChats(ear, now)) {
          // Defence in depth: never flush a chat this ear no longer owns.
          if (this.earForChat(chatId) !== ear) {
            this.store.increment(
              "routing_revoked",
              this.store.revokeChat(ear, chatId),
            );
            continue;
          }
          this.flush(ear, chatId, client);
        }
      }
    }
    this.armTimer();
  }

  private armTimer(): void {
    if (this.config.paused) {
      return;
    }
    let next: number | undefined;
    for (const ear of this.attached.keys()) {
      const due = this.store.nextDue(ear);
      if (due !== undefined && (next === undefined || due < next)) {
        next = due;
      }
    }
    if (
      next === undefined ||
      (this.timerDue !== undefined && this.timerDue <= next)
    ) {
      return;
    }
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
    }
    this.timerDue = next;
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = undefined;
        this.timerDue = undefined;
        this.tick();
      },
      Math.max(0, next - this.clock.now()),
    );
  }

  private chatKind(chatId: string): BatchKind {
    if (this.store.isDmChannel(chatId)) {
      return "dm";
    }
    const route = routeFor(
      this.config,
      { guild_id: "guild", channel_id: chatId },
      (id) => this.store.threadParent(id),
    );
    return route?.channel.mode === "room" ? "room" : "mention";
  }

  private flush(ear: string, chatId: string, client: Client): void {
    const batch = this.store.takeBatch(
      ear,
      chatId,
      this.chatKind(chatId),
      client.attachGeneration,
    );
    if (!batch) {
      return;
    }
    const notification = renderBatch(batch, this.config);
    client.connection.send({
      type: "event",
      batchId: batch.id,
      content: notification.content,
      meta: notification.meta,
    });
    this.store.increment("batches_sent");
    this.logger.log("info", "ear.batch_sent", {
      ear,
      chatId,
      batchId: batch.id,
      events: batch.events.length,
    });
  }

  // ---- connections -----------------------------------------------------------------

  /** Registers a connection; returns the handlers the transport should call. */
  public connect(
    connection: Connection,
    options: { requireToken: boolean },
  ): { onMessage: (message: unknown) => void; onClose: () => void } {
    const client: Client = {
      connection,
      requireToken: options.requireToken,
      hello: false,
      role: undefined,
      ear: undefined,
      attachGeneration: 0,
      sessionId: undefined,
      pid: undefined,
    };
    this.clients.add(client);
    return {
      onMessage: (message) => {
        this.handleMessage(client, message).catch((error: unknown) => {
          this.logger.log("error", "client.message_failed", {
            reason: error instanceof Error ? error.message : "unknown",
          });
        });
      },
      onClose: () => {
        this.clients.delete(client);
        this.detach(client);
      },
    };
  }

  private detach(client: Client): void {
    const ear = client.ear;
    if (ear && this.attached.get(ear) === client) {
      this.attached.delete(ear);
      const reverted = this.store.revertUnconfirmed(ear);
      this.logger.log("info", "ear.detached", { ear, reverted });
    }
    client.ear = undefined;
  }

  private async handleMessage(client: Client, raw: unknown): Promise<void> {
    if (
      !raw ||
      typeof raw !== "object" ||
      typeof (raw as { type?: unknown }).type !== "string"
    ) {
      client.connection.close();
      return;
    }
    const message = raw as ClientMessage;
    if (!client.hello && message.type !== "hello") {
      client.connection.close();
      return;
    }
    switch (message.type) {
      case "hello":
        this.hello(client, message);
        return;
      case "offered":
        this.store.confirmBatch(message.batchId);
        return;
      case "session":
        if (client.ear && typeof message.sessionId === "string") {
          client.sessionId = message.sessionId;
          this.store.updateEarSession(client.ear, message.sessionId);
        }
        return;
      case "status":
        client.connection.send({
          type: "result",
          id: message.id,
          ok: true,
          text: JSON.stringify(this.status(), null, 2),
        });
        return;
      case "inject":
        if (!this.options.allowInject) {
          client.connection.send({
            type: "result",
            id: message.id,
            ok: false,
            text: "inject is disabled; run the daemon with --dry-run or FROND_EAR_ALLOW_INJECT=1",
          });
          return;
        }
        client.connection.send({
          type: "result",
          id: message.id,
          ok: true,
          text: this.ingest(message.message),
        });
        return;
      case "call":
        try {
          const text = await this.callTool(
            client,
            message.tool,
            message.args ?? {},
          );
          client.connection.send({
            type: "result",
            id: message.id,
            ok: true,
            text,
          });
        } catch (error) {
          client.connection.send({
            type: "result",
            id: message.id,
            ok: false,
            text: error instanceof Error ? error.message : "tool failed",
          });
        }
        return;
      default:
        client.connection.close();
    }
  }

  private hello(
    client: Client,
    message: Extract<ClientMessage, { type: "hello" }>,
  ): void {
    if (message.protocol !== EAR_PROTOCOL_VERSION) {
      client.connection.send({
        type: "welcome",
        protocol: EAR_PROTOCOL_VERSION,
        attached: false,
        instructions: "",
        error: `unsupported ear protocol ${String(message.protocol)}`,
      });
      client.connection.close();
      return;
    }
    if (
      client.requireToken &&
      !tokenMatches(message.token, this.options.token)
    ) {
      client.connection.close();
      return;
    }
    client.hello = true;
    client.role = message.role;
    client.pid = message.pid;
    client.sessionId = message.sessionId;
    if (message.role === "cli" || !message.ear) {
      client.connection.send({
        type: "welcome",
        protocol: EAR_PROTOCOL_VERSION,
        attached: false,
        instructions: channelInstructions(this.config, undefined),
      });
      return;
    }
    const ear = message.ear;
    if (!this.config.ears[ear]) {
      client.connection.send({
        type: "welcome",
        protocol: EAR_PROTOCOL_VERSION,
        attached: false,
        instructions: channelInstructions(this.config, undefined),
        error: `unknown ear ${JSON.stringify(ear)}; configured: ${Object.keys(this.config.ears).join(", ")}`,
      });
      return;
    }
    const previous = this.attached.get(ear);
    if (previous && previous !== client) {
      previous.connection.send({ type: "detached", reason: "superseded" });
      this.detach(previous);
    }
    this.store.revertUnconfirmed(ear);
    const nonce = this.config.ears[ear]?.attachCanary
      ? (this.options.nonce ?? (() => randomBytes(6).toString("hex")))()
      : null;
    const record = this.store.attachEar(ear, message.sessionId ?? null, nonce);
    client.ear = ear;
    client.attachGeneration = record.generation;
    this.attached.set(ear, client);
    this.logger.log("info", "ear.attached", {
      ear,
      generation: record.generation,
      sessionId: message.sessionId ?? null,
    });
    client.connection.send({
      type: "welcome",
      protocol: EAR_PROTOCOL_VERSION,
      attached: true,
      ear,
      generation: record.generation,
      instructions: channelInstructions(this.config, ear),
    });
    const unseen = this.store.unseenFromEarlierAttaches(ear, record.generation);
    if (unseen.length > 0) {
      const digest = renderDigest(unseen);
      client.connection.send({ type: "event", batchId: null, ...digest });
    }
    if (nonce) {
      const canary = renderCanary(ear, record.generation, nonce);
      client.connection.send({ type: "event", batchId: null, ...canary });
    }
    this.tick();
  }

  // ---- tools -------------------------------------------------------------------------

  /** The ear a chat belongs to, or undefined when the chat is not routable. */
  private earForChat(chatId: string): string | undefined {
    if (this.store.isDmChannel(chatId)) {
      return this.config.dmEar;
    }
    return routeFor(
      this.config,
      { guild_id: "guild", channel_id: chatId },
      (id) => this.store.threadParent(id),
    )?.ear;
  }

  private requireChat(args: Record<string, unknown>): {
    chatId: string;
    ear: string;
  } {
    const chatId = snowflakeArg(args, "chat_id", true);
    const ear = this.earForChat(chatId);
    if (!ear) {
      throw new Error(
        `chat ${chatId} is not bound to any frond-ear ear (outbound is limited to configured channels, their threads, and known DMs)`,
      );
    }
    return { chatId, ear };
  }

  private isAttachedSession(client: Client, ear: string): boolean {
    return client.ear === ear && this.attached.get(ear) === client;
  }

  /**
   * The batch an action acknowledges, fixed *before* any awaited Discord call:
   * the batch_id the model passed (clamped to what was confirmed), else the
   * latest confirmed batch at call start. Anything offered later stays unseen.
   */
  private seenHorizon(
    client: Client,
    ear: string,
    chatId: string | undefined,
    args: Record<string, unknown>,
  ): number | undefined {
    if (!this.isAttachedSession(client, ear)) {
      return undefined;
    }
    const latest = this.store.latestConfirmedBatch(ear, chatId);
    const requested = args.batch_id;
    if (requested === undefined || requested === null || requested === "") {
      return latest;
    }
    const batch = Number(requested);
    if (!Number.isSafeInteger(batch) || batch < 1) {
      throw new Error("batch_id must be the positive integer from the event");
    }
    return Math.min(batch, latest);
  }

  private markSeenThrough(
    client: Client,
    ear: string,
    chatId: string | undefined,
    horizon: number | undefined,
  ): number {
    if (horizon === undefined || !this.isAttachedSession(client, ear)) {
      return 0;
    }
    return this.store.markSeenThrough(ear, chatId, horizon);
  }

  /** Marks specific events seen, only for the ear's attached session. */
  private markSeen(client: Client, ear: string, ids: number[]): number {
    if (!this.isAttachedSession(client, ear)) {
      return 0;
    }
    return this.store.markSeen(ear, undefined, ids);
  }

  private readableEar(client: Client, args: Record<string, unknown>): string {
    const requested = stringArg(args, "ear");
    if (requested) {
      if (!this.config.ears[requested]) {
        throw new Error(`unknown ear ${requested}`);
      }
      return requested;
    }
    if (client.ear) {
      return client.ear;
    }
    const names = Object.keys(this.config.ears);
    if (names.length === 1 && names[0]) {
      return names[0];
    }
    throw new Error(
      `this session is not attached to an ear; pass ear (one of ${names.join(", ")})`,
    );
  }

  private async callTool(
    client: Client,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    switch (tool) {
      case "reply": {
        const { chatId, ear } = this.requireChat(args);
        const text = stringArg(args, "text", true);
        const replyTo = snowflakeArg(args, "reply_to");
        const horizon = this.seenHorizon(client, ear, chatId, args);
        const ids: string[] = [];
        for (const [index, chunk] of chunkMessage(text).entries()) {
          const sent = await this.rest.sendMessage(
            chatId,
            chunk,
            index === 0 ? replyTo : undefined,
          );
          this.store.recordSent(sent.id, chatId);
          ids.push(sent.id);
        }
        this.markSeenThrough(client, ear, chatId, horizon);
        this.store.increment("replies_sent");
        return `sent ${ids.length} message${ids.length === 1 ? "" : "s"} to ${chatId} (id${ids.length === 1 ? "" : "s"} ${ids.join(", ")})`;
      }
      case "react": {
        const { chatId, ear } = this.requireChat(args);
        const messageId = snowflakeArg(args, "message_id", true);
        const emoji = stringArg(args, "emoji", true);
        const horizon = this.seenHorizon(client, ear, chatId, args);
        await this.rest.addReaction(chatId, messageId, emoji);
        this.markSeenThrough(client, ear, chatId, horizon);
        return "reacted";
      }
      case "edit_message": {
        const { chatId, ear } = this.requireChat(args);
        const text = stringArg(args, "text", true);
        if (text.length > 2_000) {
          throw new Error("edited text must be 2000 characters or fewer");
        }
        const messageId = snowflakeArg(args, "message_id", true);
        if (!this.store.sentIn(messageId, chatId)) {
          throw new Error(
            `message ${messageId} was not sent by frond-ear in chat ${chatId}; only those can be edited`,
          );
        }
        const horizon = this.seenHorizon(client, ear, chatId, args);
        await this.rest.editMessage(chatId, messageId, text);
        this.markSeenThrough(client, ear, chatId, horizon);
        return "edited";
      }
      case "fetch_messages": {
        const { chatId, ear } = this.requireChat(args);
        const limit = numberArg(args, "limit", 20, 100);
        const before = snowflakeArg(args, "before");
        const horizon = this.seenHorizon(client, ear, chatId, args);
        const messages = await this.rest.fetchMessages(
          chatId,
          before ? { limit, before } : { limit },
        );
        this.markSeenThrough(client, ear, chatId, horizon);
        if (messages.length === 0) {
          return "no messages";
        }
        const ordered = [...messages].sort((a, b) =>
          a.timestamp.localeCompare(b.timestamp),
        );
        return ordered
          .map((message) =>
            renderEvent(this.toDisplayEvent(message, ear), this.config),
          )
          .join("\n\n");
      }
      case "inbox": {
        const ear = this.readableEar(client, args);
        const chatId = snowflakeArg(args, "chat_id");
        const limit = numberArg(args, "limit", 30, 200);
        const events = this.store.unseen(ear, chatId, limit);
        const marked = this.markSeen(
          client,
          ear,
          events.map((event) => event.id),
        );
        if (events.length === 0) {
          return "inbox empty: nothing unseen";
        }
        const byChat = new Map<string, StoredEvent[]>();
        for (const event of events) {
          byChat.set(event.chatId, [
            ...(byChat.get(event.chatId) ?? []),
            event,
          ]);
        }
        const sections = [...byChat.entries()].map(
          ([chat, chatEvents]) =>
            `chat_id ${chat}:\n\n${chatEvents.map((event) => renderEvent(event, this.config)).join("\n\n")}`,
        );
        const note =
          marked > 0
            ? `(${marked} marked seen)`
            : "(read-only: this session is not the ear's attached session)";
        return `${sections.join("\n\n---\n\n")}\n\n${note}`;
      }
      case "ack": {
        const nonce = stringArg(args, "nonce");
        if (nonce) {
          if (!client.ear || !this.store.registerEar(client.ear, nonce)) {
            throw new Error("unknown or already-used nonce");
          }
          this.logger.log("info", "ear.registered", { ear: client.ear });
          return `ear ${client.ear} registered: channel delivery confirmed`;
        }
        const chatId = snowflakeArg(args, "chat_id");
        const ear = chatId
          ? this.requireChat(args).ear
          : this.readableEar(client, args);
        const marked = this.markSeenThrough(
          client,
          ear,
          chatId,
          this.seenHorizon(client, ear, chatId, args),
        );
        return `${marked} event${marked === 1 ? "" : "s"} marked seen`;
      }
      case "set_attention":
        return this.setAttention(client, args);
      case "ear_status":
        return JSON.stringify(
          this.status(client.ear ?? stringArg(args, "ear")),
          null,
          2,
        );
      default:
        throw new Error(`unknown tool ${tool}`);
    }
  }

  /**
   * The attached session chooses what it hears. The operator's configured
   * mode is a ceiling the session can narrow (down to silence) but never
   * widen; no trust level, principal included, pierces a narrowed mode.
   */
  private setAttention(client: Client, args: Record<string, unknown>): string {
    const ear = client.ear;
    if (!ear || !this.isAttachedSession(client, ear)) {
      throw new Error(
        "only the session attached to an ear can set its attention",
      );
    }
    const requested = stringArg(args, "mode", true);
    if (!["silent", "mentions", "room", "configured"].includes(requested)) {
      throw new Error("mode must be silent, mentions, room or configured");
    }
    const chatId = snowflakeArg(args, "chat_id");
    if (chatId && this.earForChat(chatId) !== ear) {
      throw new Error(`chat ${chatId} is not bound to ear ${ear}`);
    }
    const scope = chatId ?? "*";
    const now = this.clock.now();
    if (requested === "configured") {
      this.store.clearAttention(ear, chatId === undefined ? undefined : scope);
    } else {
      const ttl = args.ttl_seconds;
      let expiresAt: number | null = null;
      if (ttl !== undefined && ttl !== null) {
        const seconds = Number(ttl);
        if (!Number.isSafeInteger(seconds) || seconds < 1) {
          throw new Error("ttl_seconds must be a positive integer");
        }
        expiresAt = now + seconds * 1_000;
      }
      this.store.setAttention(ear, scope, requested as Mode, expiresAt);
    }
    // Rows already waiting are narrowed too, so the choice takes effect now.
    let narrowed = 0;
    for (const pending of this.store.pendingChats()) {
      if (pending.ear !== ear) {
        continue;
      }
      const effective = this.effectiveMode(ear, pending.chatId);
      if (effective) {
        narrowed += this.store.narrowPending(ear, pending.chatId, effective);
      }
    }
    this.store.increment("attention_changes");
    this.logger.log("info", "ear.attention", { ear, scope, mode: requested });
    this.tick();
    const view = this.attentionView(ear);
    const capped =
      requested !== "configured" &&
      chatId !== undefined &&
      view.chats[chatId] !== undefined &&
      view.chats[chatId].effective !== requested;
    return JSON.stringify(
      {
        ...view,
        note: capped
          ? `requested ${requested} exceeds the operator's ceiling for ${chatId}; effective mode is ${view.chats[chatId]?.effective}`
          : undefined,
        narrowedPending: narrowed,
      },
      null,
      2,
    );
  }

  /** Configured ceiling narrowed by the session's own choice. */
  private effectiveMode(ear: string, chatId: string): Mode | undefined {
    const ceiling = this.chatMode(chatId);
    return ceiling === undefined
      ? undefined
      : narrower(
          ceiling,
          this.store.attentionFor(ear, chatId, this.clock.now()),
        );
  }

  private attentionView(ear: string): {
    overrides: Array<{ scope: string; mode: Mode; expiresAt: number | null }>;
    chats: Record<string, { ceiling: Mode; effective: Mode }>;
  } {
    const earConfig = this.config.ears[ear];
    const now = this.clock.now();
    const chats: Record<string, { ceiling: Mode; effective: Mode }> = {};
    for (const [chatId, channel] of Object.entries(earConfig?.channels ?? {})) {
      chats[chatId] = {
        ceiling: channel.mode,
        effective: narrower(
          channel.mode,
          this.store.attentionFor(ear, chatId, now),
        ),
      };
    }
    if (earConfig?.dms) {
      const dmOverride = this.store
        .attentionOverrides(ear, now)
        .find((item) => item.scope === "*")?.mode;
      chats.dms = {
        ceiling: earConfig.dmMode,
        effective: narrower(earConfig.dmMode, dmOverride),
      };
    }
    return {
      overrides: this.store
        .attentionOverrides(ear, now)
        .map(({ scope, mode, expiresAt }) => ({ scope, mode, expiresAt })),
      chats,
    };
  }

  private toDisplayEvent(message: DiscordMessage, ear: string): StoredEvent {
    return {
      id: 0,
      messageId: message.id,
      ear,
      chatId: message.channel_id,
      guildId: message.guild_id ?? null,
      authorId: message.author.id,
      authorName:
        message.author.id === this.config.botUserId
          ? `${displayName(message)} (you)`
          : displayName(message),
      isBot: message.author.bot === true,
      trust: trustOf(this.config, message.author.id),
      wake: false,
      priority: false,
      content: message.content,
      timestamp: message.timestamp,
      replyTo: message.message_reference?.message_id ?? null,
      attachments: (message.attachments ?? []).map((file) => ({
        name: file.filename,
        type: file.content_type ?? "unknown",
        size: file.size,
      })),
      state: "seen",
      batchId: null,
      createdAt: 0,
    };
  }

  // ---- status --------------------------------------------------------------------------

  public status(onlyEar?: string): object {
    const ears = Object.entries(this.config.ears)
      .filter(([name]) => onlyEar === undefined || name === onlyEar)
      .map(([name, ear]) => {
        const record = this.store.ear(name);
        const client = this.attached.get(name);
        return {
          name,
          target: ear.target,
          attached: client !== undefined,
          registered: client !== undefined && record?.registered === true,
          generation: record?.generation ?? 0,
          sessionId: client?.sessionId ?? record?.sessionId ?? null,
          shimPid: client?.pid ?? null,
          channels: Object.fromEntries(
            Object.entries(ear.channels).map(([id, channel]) => [
              id,
              channel.mode,
            ]),
          ),
          dms: ear.dms,
          events: this.store.stateCounts(name),
          lastEventAt: this.store.lastEventAt(name),
          nextFlushAt: this.store.nextDue(name) ?? null,
          attention: this.attentionView(name),
        };
      });
    return {
      paused: this.config.paused,
      gateway: this.options.gatewayStatus?.() ?? { state: "disabled" },
      ears,
      botLoopCooling: this.botLimiter.cooling(this.clock.now()),
      ambientWakeCooling: this.ambientLimiter.cooling(this.clock.now()),
      counters: this.store.counters(),
    };
  }

  public shutdown(): void {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const client of this.clients) {
      client.connection.close();
    }
  }
}
