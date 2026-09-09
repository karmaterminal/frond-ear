import type { Classification, DiscordMessage, Policy } from "./types.js";

export const defaultPolicy: Policy = {
  allowedGuildIds: [],
  allowedChannelIds: [],
  priorityAuthorIds: [],
  ignoredAuthorIds: [],
  ignoredPatterns: [],
  ignoredEventClasses: [],
  botUserId: "",
  quietWindowMs: 5_000,
  maxSummaryChars: 4_000,
  maxQueueCount: 1_000,
  maxQueueWeight: 2_000_000,
  maxMessageChars: 4_000,
  retentionMs: 7 * 24 * 60 * 60 * 1_000,
  maxDeliveryAttempts: 5,
  gatewayEnabled: true,
  wakeDeliveryPaused: false,
};

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validatePolicy(candidate: unknown): Policy {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("policy must be a JSON object");
  }
  const merged = { ...defaultPolicy, ...candidate } as Policy;
  const stringArrays: Array<keyof Policy> = [
    "allowedGuildIds",
    "allowedChannelIds",
    "priorityAuthorIds",
    "ignoredAuthorIds",
    "ignoredPatterns",
  ];
  for (const key of stringArrays) {
    const value = merged[key];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new Error(`${key} must be an array of strings`);
    }
  }
  if (
    !Array.isArray(merged.ignoredEventClasses) ||
    merged.ignoredEventClasses.some((item) => !isNonNegativeInteger(item))
  ) {
    throw new Error("ignoredEventClasses must be an array of non-negative integers");
  }
  if (typeof merged.botUserId !== "string") {
    throw new Error("botUserId must be a string");
  }
  const positiveIntegers: Array<keyof Policy> = [
    "maxSummaryChars",
    "maxQueueCount",
    "maxQueueWeight",
    "maxMessageChars",
    "retentionMs",
    "maxDeliveryAttempts",
  ];
  for (const key of positiveIntegers) {
    const value = merged[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${key} must be a positive integer`);
    }
  }
  if (!isNonNegativeInteger(merged.quietWindowMs)) {
    throw new Error("quietWindowMs must be a non-negative integer");
  }
  if (
    typeof merged.gatewayEnabled !== "boolean" ||
    typeof merged.wakeDeliveryPaused !== "boolean"
  ) {
    throw new Error("gatewayEnabled and wakeDeliveryPaused must be booleans");
  }
  for (const pattern of merged.ignoredPatterns) {
    try {
      new RegExp(pattern, "iu");
    } catch {
      throw new Error(`invalid ignored pattern: ${pattern}`);
    }
  }
  return structuredClone(merged);
}

export function classifyMessage(message: DiscordMessage, policy: Policy): Classification {
  if (!policy.gatewayEnabled) {
    return { accepted: false, priority: false, reason: "gateway_disabled", weight: 0 };
  }
  if (!message.guild_id || !policy.allowedGuildIds.includes(message.guild_id)) {
    return { accepted: false, priority: false, reason: "guild_not_allowed", weight: 0 };
  }
  if (!policy.allowedChannelIds.includes(message.channel_id)) {
    return { accepted: false, priority: false, reason: "channel_not_allowed", weight: 0 };
  }
  if (
    message.author.id === policy.botUserId ||
    (message.author.bot === true && message.author.id === policy.botUserId)
  ) {
    return { accepted: false, priority: false, reason: "self_message", weight: 0 };
  }

  const priority =
    policy.priorityAuthorIds.includes(message.author.id) ||
    message.mentions?.some((mention) => mention.id === policy.botUserId) === true;
  const eventClass = message.type ?? 0;
  if (!priority && policy.ignoredEventClasses.includes(eventClass)) {
    return { accepted: false, priority, reason: "ignored_event_class", weight: 0 };
  }
  if (!priority && policy.ignoredAuthorIds.includes(message.author.id)) {
    return { accepted: false, priority, reason: "ignored_author", weight: 0 };
  }
  if (
    !priority &&
    policy.ignoredPatterns.some((pattern) => new RegExp(pattern, "iu").test(message.content))
  ) {
    return { accepted: false, priority, reason: "ignored_pattern", weight: 0 };
  }
  const content = message.content.slice(0, policy.maxMessageChars);
  return {
    accepted: true,
    priority,
    reason: priority ? "priority" : "accepted",
    weight: Buffer.byteLength(content, "utf8"),
  };
}
