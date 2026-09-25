import type { ChannelConfig, Config } from "./config.ts";
import type { BatchKind, DiscordMessage, Trust } from "./types.ts";

export interface Route {
  ear: string;
  /** Where replies go: the channel, thread or DM the message arrived in. */
  chatId: string;
  /** The configured channel (a thread resolves to its parent), or null for DMs. */
  boundChannelId: string | null;
  channel: ChannelConfig;
  kind: BatchKind;
}

export type Classification =
  | { accept: false; reason: string }
  | {
      accept: true;
      route: Route;
      trust: Trust;
      isBot: boolean;
      mentioned: boolean;
      /** Priority triggers use the short quiet window and always wake in mentions mode. */
      priority: boolean;
      wake: boolean;
      state: "queued" | "context" | "stored";
      reason: string;
    };

export interface PolicyContext {
  threadParent(channelId: string): string | undefined;
  /** Returns true when the bot-loop limiter says this bot event must not wake. */
  botLoopLimited(chatId: string, now: number): boolean;
  now: number;
}

export function trustOf(config: Config, authorId: string): Trust {
  if (config.principals.includes(authorId)) {
    return "principal";
  }
  if (config.peerAgents.includes(authorId)) {
    return "peer_agent";
  }
  return "ambient";
}

export function routeFor(
  config: Config,
  message: Pick<DiscordMessage, "guild_id" | "channel_id">,
  threadParent: (channelId: string) => string | undefined,
): Route | undefined {
  if (!message.guild_id) {
    for (const [ear, earConfig] of Object.entries(config.ears)) {
      if (earConfig.dms) {
        return {
          ear,
          chatId: message.channel_id,
          boundChannelId: null,
          channel: { mode: "mentions" },
          kind: "dm",
        };
      }
    }
    return undefined;
  }
  const candidates = [message.channel_id];
  const parent = threadParent(message.channel_id);
  if (parent) {
    candidates.push(parent);
  }
  for (const channelId of candidates) {
    for (const [ear, earConfig] of Object.entries(config.ears)) {
      const channel = earConfig.channels[channelId];
      if (channel) {
        return {
          ear,
          chatId: message.channel_id,
          boundChannelId: channelId,
          channel,
          kind: channel.mode === "room" ? "room" : "mention",
        };
      }
    }
  }
  return undefined;
}

export function isMentioned(config: Config, message: DiscordMessage): boolean {
  const bot = config.botUserId;
  if (message.mentions?.some((mention) => mention.id === bot)) {
    return true;
  }
  if (
    message.content.includes(`<@${bot}>`) ||
    message.content.includes(`<@!${bot}>`)
  ) {
    return true;
  }
  if (message.referenced_message?.author.id === bot) {
    return true;
  }
  return config.mentionPatterns.some((pattern) =>
    new RegExp(pattern, "iu").test(message.content),
  );
}

export function classify(
  config: Config,
  message: DiscordMessage,
  context: PolicyContext,
): Classification {
  if (message.author.id === config.botUserId) {
    return { accept: false, reason: "self_message" };
  }
  const route = routeFor(config, message, context.threadParent);
  if (!route) {
    return {
      accept: false,
      reason: message.guild_id ? "channel_not_bound" : "dm_not_routed",
    };
  }
  const trust = trustOf(config, message.author.id);
  const isBot = message.author.bot === true || message.webhook_id !== undefined;
  if (isBot && trust !== "peer_agent" && trust !== "principal") {
    return { accept: false, reason: "bot_not_allowed" };
  }
  if (route.kind === "dm" && trust === "ambient") {
    return { accept: false, reason: "dm_sender_not_allowed" };
  }
  const mentioned = isMentioned(config, message);
  const priority = mentioned || trust === "principal" || route.kind === "dm";

  let wake: boolean;
  let reason: string;
  switch (route.channel.mode) {
    case "silent":
      wake = false;
      reason = "silent";
      break;
    case "room":
      wake = true;
      reason = priority ? "priority" : "room";
      break;
    default:
      wake = priority;
      reason = priority ? "priority" : "context";
      break;
  }
  if (wake && isBot && context.botLoopLimited(route.chatId, context.now)) {
    wake = false;
    reason = "bot_loop_cooldown";
  }
  const state =
    route.channel.mode === "silent" ? "stored" : wake ? "queued" : "context";
  return {
    accept: true,
    route,
    trust,
    isBot,
    mentioned,
    priority,
    wake,
    state,
    reason,
  };
}

/**
 * OpenClaw-style bot-loop protection: more than `maxEvents` wake-worthy bot
 * events in `windowMs` puts the chat in cooldown, during which bot messages
 * are kept as context instead of waking the session.
 */
export class BotLoopLimiter {
  private readonly events = new Map<string, number[]>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly settings: Config["botLoop"];

  public constructor(settings: Config["botLoop"]) {
    this.settings = settings;
  }

  public limited(chatId: string, now: number): boolean {
    const until = this.cooldownUntil.get(chatId);
    if (until !== undefined) {
      if (now < until) {
        return true;
      }
      this.cooldownUntil.delete(chatId);
      this.events.delete(chatId);
    }
    const recent = (this.events.get(chatId) ?? []).filter(
      (time) => now - time < this.settings.windowMs,
    );
    recent.push(now);
    this.events.set(chatId, recent);
    if (recent.length > this.settings.maxEvents) {
      this.cooldownUntil.set(chatId, now + this.settings.cooldownMs);
      return true;
    }
    return false;
  }

  public cooling(now: number): string[] {
    return [...this.cooldownUntil.entries()]
      .filter(([, until]) => now < until)
      .map(([chatId]) => chatId);
  }
}
