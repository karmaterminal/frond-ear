import type { ChannelConfig, Config, WakeBudget } from "./config.ts";
import { messageText } from "./render.ts";
import type { BatchKind, DiscordMessage, Mode, Trust } from "./types.ts";

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
  /**
   * Records a would-be wake against the chat's budget for this class of
   * author and returns true when the budget is exhausted (the event must not
   * wake). Bots use the bot-loop budget; ambient humans the ambient budget.
   */
  wakeBudgetExhausted(
    kind: "bot" | "ambient",
    chatId: string,
    now: number,
  ): boolean;
  /**
   * The attached session's own attention choice for this chat, if any.
   * It can only narrow the operator's configured mode (see `narrower`).
   */
  attention?(ear: string, chatId: string, now: number): Mode | undefined;
  now: number;
}

const MODE_RANK: Record<Mode, number> = { silent: 0, mentions: 1, room: 2 };

/** The quieter of two modes: operator config is a ceiling, never widened. */
export function narrower(ceiling: Mode, requested: Mode | undefined): Mode {
  if (requested === undefined) {
    return ceiling;
  }
  return MODE_RANK[requested] < MODE_RANK[ceiling] ? requested : ceiling;
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
    // Config validation guarantees at most one DM ear, bound explicitly.
    const ear = config.dmEar;
    const earConfig = ear ? config.ears[ear] : undefined;
    if (!ear || !earConfig) {
      return undefined;
    }
    return {
      ear,
      chatId: message.channel_id,
      boundChannelId: null,
      channel: { mode: earConfig.dmMode },
      kind: "dm",
    };
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
  // What the author wrote, which a Components V2 message keeps in its components. Its buttons
  // and links are left out: a label or URL that names this ear does not address it.
  const text = messageText(message, false);
  if (text.includes(`<@${bot}>`) || text.includes(`<@!${bot}>`)) {
    return true;
  }
  if (message.referenced_message?.author.id === bot) {
    return true;
  }
  return config.mentionMatchers.some((matcher) => matcher.test(text));
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
  // Effective mode: the operator's configured mode narrowed by whatever the
  // attached session chose for itself. No trust level pierces that choice.
  const mode = narrower(
    route.channel.mode,
    context.attention?.(route.ear, route.chatId, context.now),
  );
  const mentioned = isMentioned(config, message);
  // Priority (the power to interrupt) comes only from addressing: a mention,
  // a reply to the bot, or a DM. Trust decides who may command and who is
  // admitted, not who may break into the session's attention; a principal's
  // unaddressed room message is context like anyone else's.
  let priority = mentioned || route.kind === "dm";
  let budgetReason: string | undefined;
  if (mode !== "silent") {
    if (isBot && (priority || mode === "room")) {
      if (context.wakeBudgetExhausted("bot", route.chatId, context.now)) {
        budgetReason = "bot_loop_cooldown";
      }
    } else if (trust === "ambient" && priority) {
      // Anyone can @mention or reply to the bot; without a budget an ambient
      // user could force priority wakes indefinitely. Room chatter is already
      // bounded by the debounce, so only mention-driven wakes are budgeted.
      if (context.wakeBudgetExhausted("ambient", route.chatId, context.now)) {
        budgetReason = "ambient_wake_budget";
      }
    }
  }
  if (budgetReason) {
    priority = false;
  }

  let wake: boolean;
  let reason: string;
  switch (mode) {
    case "silent":
      wake = false;
      reason = "silent";
      break;
    case "room":
      // Over budget, a room message loses its priority but is still ordinary,
      // debounced room traffic; bots over budget stop waking entirely.
      wake = budgetReason !== "bot_loop_cooldown";
      reason = budgetReason ?? (priority ? "priority" : "room");
      break;
    default:
      wake = priority;
      reason = budgetReason ?? (priority ? "priority" : "context");
      break;
  }
  const state = mode === "silent" ? "stored" : wake ? "queued" : "context";
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
 * Sliding-window wake budget per chat (OpenClaw-style loop protection): more
 * than `maxEvents` recorded wakes in `windowMs` puts the chat in cooldown,
 * during which further wakes are demoted to context.
 */
export class WakeLimiter {
  private readonly events = new Map<string, number[]>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly settings: WakeBudget;

  public constructor(settings: WakeBudget) {
    this.settings = settings;
  }

  /** Records one wake for `chatId` and reports whether the budget is exhausted. */
  public recordAndCheck(chatId: string, now: number): boolean {
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
