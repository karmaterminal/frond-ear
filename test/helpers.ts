import type { HearView } from "../src/canticle/receptor.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig, type Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";
import type { GatewaySocket } from "../src/gateway.ts";
import { StructuredLogger } from "../src/logger.ts";
import type {
  ClientMessage,
  Connection,
  DaemonMessage,
} from "../src/protocol.ts";
import { RecordingRest } from "../src/rest.ts";
import { EventStore } from "../src/store.ts";
import type { Clock, DiscordMessage, Timers } from "../src/types.ts";

export const BOT = "100000000000000001";
export const PRINCIPAL = "200000000000000002";
export const PEER_BOT = "300000000000000003";
export const AMBIENT = "400000000000000004";
export const OTHER_BOT = "500000000000000005";
export const GUILD = "600000000000000006";
export const CHANNEL = "700000000000000007";
export const ROOM = "700000000000000008";
export const SILENT = "700000000000000009";
export const THREAD = "800000000000000010";
export const DM = "900000000000000011";

export class FakeClock implements Clock {
  public value: number;

  public constructor(value = 1_000_000) {
    this.value = value;
  }

  public now(): number {
    return this.value;
  }

  public advance(milliseconds: number): void {
    this.value += milliseconds;
  }
}

/** Manual timers driven by FakeClock: `runDue` fires everything whose time has come. */
export class FakeTimers implements Timers {
  private readonly clock: FakeClock;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { at: number; callback: () => void }
  >();

  public constructor(clock: FakeClock) {
    this.clock = clock;
  }

  public setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.pending.set(id, { at: this.clock.now() + ms, callback });
    return id;
  }

  public clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  public advance(ms: number): void {
    const target = this.clock.now() + ms;
    for (;;) {
      const due = [...this.pending.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) {
        break;
      }
      this.pending.delete(due[0]);
      this.clock.value = Math.max(this.clock.value, due[1].at);
      due[1].callback();
    }
    this.clock.value = target;
  }

  public get count(): number {
    return this.pending.size;
  }
}

export function testConfig(overrides: Record<string, unknown> = {}): Config {
  return parseConfig({
    botUserId: BOT,
    principals: [PRINCIPAL],
    peerAgents: [PEER_BOT],
    labels: { [PRINCIPAL]: "figs" },
    mentionPatterns: ["\\bscribe\\b"],
    ears: {
      scribe: {
        target: "claude-channel",
        dms: true,
        attachCanary: false,
        channels: {
          [CHANNEL]: { mode: "mentions" },
          [ROOM]: { mode: "room" },
          [SILENT]: { mode: "silent" },
        },
      },
    },
    defaults: {
      quietWindowMs: 4_000,
      maxDelayMs: 20_000,
      priorityQuietMs: 1_000,
      historyLimit: 5,
    },
    ...overrides,
  });
}

let sequence = 0;

export function message(
  overrides: Partial<DiscordMessage> = {},
): DiscordMessage {
  sequence += 1;
  return {
    id: String(1_000_000_000_000_000n + BigInt(sequence)),
    guild_id: GUILD,
    channel_id: CHANNEL,
    author: { id: AMBIENT, username: "someone" },
    content: `hello ${sequence}`,
    timestamp: "2026-09-25T12:00:00.000Z",
    mentions: [],
    ...overrides,
  };
}

export class MemoryConnection implements Connection {
  public readonly received: DaemonMessage[] = [];
  public closed = false;

  public send(message: DaemonMessage | ClientMessage): void {
    this.received.push(message as DaemonMessage);
  }

  public close(): void {
    this.closed = true;
  }

  public events(): Array<Extract<DaemonMessage, { type: "event" }>> {
    return this.received.filter(
      (item): item is Extract<DaemonMessage, { type: "event" }> =>
        item.type === "event",
    );
  }

  public results(): Array<Extract<DaemonMessage, { type: "result" }>> {
    return this.received.filter(
      (item): item is Extract<DaemonMessage, { type: "result" }> =>
        item.type === "result",
    );
  }
}

export interface Harness {
  clock: FakeClock;
  timers: FakeTimers;
  store: EventStore;
  rest: RecordingRest;
  daemon: Daemon;
  logs: string[];
  directory: string;
  attach(
    ear?: string,
    extra?: Partial<Extract<ClientMessage, { type: "hello" }>>,
  ): {
    connection: MemoryConnection;
    send: (message: ClientMessage) => Promise<void>;
    close: () => void;
  };
  call(
    client: {
      connection: MemoryConnection;
      send: (message: ClientMessage) => Promise<void>;
    },
    tool: string,
    args?: Record<string, unknown>,
  ): Promise<Extract<DaemonMessage, { type: "result" }>>;
  dispose(): void;
}

export function harness(
  config: Config = testConfig(),
  options: {
    nonce?: string;
    path?: string;
    canticleHear?: (ear: string) => HearView;
    gatewayStatus?: () => { state: string; closeCode?: number };
    env?: NodeJS.ProcessEnv;
    /** The TCP shared token, for a test that serves this daemon over listenTcp. */
    token?: string;
    /** Channel history, newest first, for fetch_messages and the read-back. */
    history?: (channelId: string, limit: number) => DiscordMessage[];
  } = {},
): Harness {
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-test-"));
  const store = new EventStore(
    options.path ?? join(directory, "ear.db"),
    clock,
  );
  const rest = new RecordingRest(options.history);
  const logs: string[] = [];
  const daemon = new Daemon({
    config,
    store,
    rest,
    logger: new StructuredLogger((line) => logs.push(line)),
    clock,
    timers,
    allowInject: true,
    nonce: () => options.nonce ?? "nonce-1",
    ...(options.canticleHear ? { canticleHear: options.canticleHear } : {}),
    ...(options.gatewayStatus ? { gatewayStatus: options.gatewayStatus } : {}),
    attachmentsDir: join(directory, "attachments"),
    ...(options.env ? { env: options.env } : {}),
    ...(options.token ? { token: options.token } : {}),
  });
  let callId = 0;
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    clock,
    timers,
    store,
    rest,
    daemon,
    logs,
    directory,
    attach(ear, extra = {}) {
      const connection = new MemoryConnection();
      const handlers = daemon.connect(connection, { requireToken: false });
      const send = async (item: ClientMessage) => {
        handlers.onMessage(item);
        await flush();
      };
      handlers.onMessage({
        type: "hello",
        role: "shim",
        protocol: 1,
        ...(ear ? { ear } : {}),
        ...extra,
      });
      return { connection, send, close: () => handlers.onClose() };
    },
    async call(client, tool, args = {}) {
      const id = ++callId;
      await client.send({ type: "call", id, tool, args });
      const result = client.connection.results().find((item) => item.id === id);
      if (!result) {
        throw new Error(`no result for ${tool}`);
      }
      return result;
    },
    dispose() {
      daemon.shutdown();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

// Salvaged from codeagent/frond-ear-live-canary-v2 (test/helpers.ts).
export class FakeSocket implements GatewaySocket {
  public readonly sent: Array<Record<string, unknown>> = [];
  public closed = false;
  public closeCode: number | undefined;
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

  public close(code?: number): void {
    this.closed = true;
    this.closeCode = code;
  }

  public emitMessage(payload: object): void {
    for (const listener of this.listeners.message) {
      listener({ data: JSON.stringify(payload) });
    }
  }

  public emitClose(code: number, reason?: string): void {
    const event = reason === undefined ? { code } : { code, reason };
    for (const listener of this.listeners.close) {
      listener(event);
    }
  }
}
