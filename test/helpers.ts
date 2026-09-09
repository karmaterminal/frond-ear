import { EventEmitter } from "node:events";

import type { GatewaySocket } from "../src/gateway.js";
import type { Clock, DiscordMessage, Policy } from "../src/types.js";
import { defaultPolicy } from "../src/policy.js";

export class FakeClock implements Clock {
  public constructor(private value: number) {}

  public now(): number {
    return this.value;
  }

  public advance(milliseconds: number): void {
    this.value += milliseconds;
  }
}

export function testPolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    ...defaultPolicy,
    allowedGuildIds: ["guild-1"],
    allowedChannelIds: ["channel-1"],
    botUserId: "bot-1",
    quietWindowMs: 100,
    maxQueueCount: 10,
    maxQueueWeight: 10_000,
    ...overrides,
  };
}

export function message(
  id: string,
  overrides: Partial<DiscordMessage> = {},
): DiscordMessage {
  return {
    id,
    guild_id: "guild-1",
    channel_id: "channel-1",
    author: { id: "author-1" },
    content: `message ${id}`,
    timestamp: "2026-01-01T00:00:00.000Z",
    mentions: [],
    type: 0,
    ...overrides,
  };
}

export class FakeSocket extends EventEmitter implements GatewaySocket {
  public readonly sent: Array<Record<string, unknown>> = [];
  public closed = false;

  public override addListener(
    eventName: string | symbol,
    listener: (...args: unknown[]) => void,
  ): this {
    return super.addListener(eventName, listener);
  }

  public addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (...args: never[]) => void,
  ): void {
    this.on(type, listener);
  }

  public send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  public close(): void {
    this.closed = true;
  }
}
