export type QueueState = "pending" | "leased" | "delivered" | "dead_letter";

export interface DiscordMessage {
  id: string;
  guild_id?: string;
  channel_id: string;
  author: {
    id: string;
    bot?: boolean;
  };
  content: string;
  timestamp: string;
  mentions?: Array<{ id: string }>;
  type?: number;
}

export interface GatewayPayload {
  op: number;
  d: unknown;
  s?: number | null;
  t?: string | null;
}

export interface Policy {
  allowedGuildIds: string[];
  allowedChannelIds: string[];
  priorityAuthorIds: string[];
  ignoredAuthorIds: string[];
  ignoredPatterns: string[];
  ignoredEventClasses: number[];
  botUserId: string;
  quietWindowMs: number;
  maxCoalesceWindowMs: number;
  maxSummaryChars: number;
  maxQueueCount: number;
  maxQueueWeight: number;
  maxMessageChars: number;
  retentionMs: number;
  maxDeliveryAttempts: number;
  gatewayEnabled: boolean;
  wakeDeliveryPaused: boolean;
}

export type ConversationKind = "guild_channel_or_thread" | "dm";

export interface ConversationIdentity {
  key: string;
  kind: ConversationKind;
  guildId: string | null;
  channelId: string;
}

export interface SessionBinding {
  id: number;
  conversation: ConversationIdentity;
  generation: number;
  sessionId: string;
  state: "active" | "retired";
  paused: boolean;
  createdAt: number;
  createdBy: string;
  rotationReason: string;
  predecessorId: number | null;
  retiredAt: number | null;
}

export interface Classification {
  accepted: boolean;
  priority: boolean;
  reason: string;
  weight: number;
}

export interface QueueEvent {
  id: number;
  messageId: string;
  guildId: string;
  channelId: string;
  authorId: string;
  content: string;
  discordTimestamp: string;
  messageLink: string;
  priority: boolean;
  state: QueueState;
  weight: number;
  attempts: number;
  claimToken: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  quietUntil: number;
  bindingId: number;
  bindingGeneration: number;
}

export interface LeasedBatch {
  claimToken: string;
  leaseExpiresAt: number;
  priority: boolean;
  eventIds: number[];
  summary: string;
  binding: SessionBinding;
  events: Array<{
    messageId: string;
    guildId: string;
    channelId: string;
    authorId: string;
    timestamp: string;
    link: string;
  }>;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};
