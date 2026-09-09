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

export class FakeSocket implements GatewaySocket {
  public readonly sent: Array<Record<string, unknown>> = [];
  public closed = false;
  private readonly listeners = {
    open: [] as Array<() => void>,
    message: [] as Array<(event: { data: string }) => void>,
    close: [] as Array<(event: { code: number; reason?: string }) => void>,
    error: [] as Array<(event: unknown) => void>,
  };

  public addEventListener(type: "open", listener: () => void): void;
  public addEventListener(
    type: "message",
    listener: (event: { data: string }) => void,
  ): void;
  public addEventListener(
    type: "close",
    listener: (event: { code: number; reason?: string }) => void,
  ): void;
  public addEventListener(
    type: "error",
    listener: (event: unknown) => void,
  ): void;
  public addEventListener(
    type: "open" | "message" | "close" | "error",
    listener:
      | (() => void)
      | ((event: { data: string }) => void)
      | ((event: { code: number; reason?: string }) => void)
      | ((event: unknown) => void),
  ): void {
    if (type === "message") {
      this.listeners.message.push(
        listener as (event: { data: string }) => void,
      );
    } else if (type === "error") {
      this.listeners.error.push(listener as (event: unknown) => void);
    } else if (type === "close") {
      this.listeners.close.push(
        listener as (event: { code: number; reason?: string }) => void,
      );
    } else {
      this.listeners.open.push(listener as () => void);
    }
  }

  public send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  public close(): void {
    this.closed = true;
  }

  public emitClose(code: number, reason?: string): void {
    const event = reason === undefined ? { code } : { code, reason };
    for (const listener of this.listeners.close) {
      listener(event);
    }
  }
}
