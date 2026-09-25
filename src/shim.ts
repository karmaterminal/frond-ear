// Claude Code channel shim: a deliberately small, dependency-free MCP stdio
// server. Claude Code launches it; it relays daemon events as
// `notifications/claude/channel` and proxies tool calls to the daemon.
import type { Socket } from "node:net";
import type { Readable, Writable } from "node:stream";

import type { DaemonMessage } from "./protocol.ts";
import { EAR_PROTOCOL_VERSION, LineConnection } from "./protocol.ts";
import { channelInstructions } from "./render.ts";

/**
 * Pinned: revision 2026-07-28 negotiation stops Claude Code registering a
 * server as a channel, so the shim only ever agrees to these.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export const SHIM_VERSION = "0.1.0";

const chatId = {
  type: "string",
  description: "chat_id from the <channel> event (channel, thread or DM ID)",
};

export const TOOLS = [
  {
    name: "reply",
    description:
      "Send a message to a Discord chat. Long text is split into 2000-character messages. Your transcript never reaches Discord; this is the only way to answer.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: chatId,
        text: {
          type: "string",
          description: "Message text (Discord markdown)",
        },
        reply_to: {
          type: "string",
          description: "message_id to quote-reply; omit for a normal reply",
        },
      },
      required: ["chat_id", "text"],
    },
  },
  {
    name: "react",
    description: "Add an emoji reaction to a Discord message.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: chatId,
        message_id: { type: "string" },
        emoji: {
          type: "string",
          description: "Unicode emoji or name:id for custom emoji",
        },
      },
      required: ["chat_id", "message_id", "emoji"],
    },
  },
  {
    name: "edit_message",
    description: "Edit a message this bot sent (e.g. a progress update).",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: chatId,
        message_id: { type: "string" },
        text: { type: "string" },
      },
      required: ["chat_id", "message_id", "text"],
    },
  },
  {
    name: "fetch_messages",
    description: "Read recent Discord history for a chat (oldest first).",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: chatId,
        limit: { type: "number", description: "1-100, default 20" },
        before: {
          type: "string",
          description: "Only messages before this message_id",
        },
      },
      required: ["chat_id"],
    },
  },
  {
    name: "inbox",
    description:
      "List Discord events frond-ear holds that you have not acted on yet (including silent channels and anything omitted from a notification), and mark them seen.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { ...chatId, description: "Limit to one chat" },
        limit: { type: "number", description: "Default 30, max 200" },
        ear: {
          type: "string",
          description: "Ear name when this session is not attached",
        },
      },
    },
  },
  {
    name: "ack",
    description:
      "Mark delivered events as seen without replying (one chat or all), or confirm frond-ear's attach canary with its nonce.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: chatId,
        nonce: { type: "string", description: "Nonce from the attach event" },
      },
    },
  },
  {
    name: "ear_status",
    description: "frond-ear status: gateway, ear attachment, queue counts.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface ShimOptions {
  input: Readable;
  output: Writable;
  connect: () => Socket;
  ear?: string | undefined;
  sessionId?: string | undefined;
  token?: string | undefined;
  log?: (line: string) => void;
  reconnectMs?: number;
  initializeWaitMs?: number;
  callTimeoutMs?: number;
}

export class ChannelShim {
  private readonly options: ShimOptions;
  private daemon: LineConnection | undefined;
  private connected = false;
  private welcome: Extract<DaemonMessage, { type: "welcome" }> | undefined;
  private welcomeWaiters: Array<() => void> = [];
  private initialized = false;
  private readonly pendingEvents: Array<
    Extract<DaemonMessage, { type: "event" }>
  > = [];
  private readonly calls = new Map<
    number,
    (result: { ok: boolean; text: string }) => void
  >();
  private nextCallId = 1;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stdinBuffer = "";

  public constructor(options: ShimOptions) {
    this.options = options;
  }

  private log(message: string): void {
    (this.options.log ?? ((line) => process.stderr.write(`${line}\n`)))(
      `frond-ear shim: ${message}`,
    );
  }

  public start(): void {
    this.connectDaemon();
    this.options.input.setEncoding("utf8");
    this.options.input.on("data", (chunk: string) => {
      this.stdinBuffer += chunk;
      let newline = this.stdinBuffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.stdinBuffer.slice(0, newline).trim();
        this.stdinBuffer = this.stdinBuffer.slice(newline + 1);
        if (line) {
          this.handleLine(line);
        }
        newline = this.stdinBuffer.indexOf("\n");
      }
    });
    this.options.input.on("end", () => this.stop());
  }

  public stop(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.daemon?.close();
  }

  // ---- daemon side ---------------------------------------------------------------------

  private connectDaemon(): void {
    if (this.closed) {
      return;
    }
    const socket = this.options.connect();
    socket.once("connect", () => {
      this.connected = true;
      connection.send({
        type: "hello",
        role: "shim",
        protocol: EAR_PROTOCOL_VERSION,
        pid: process.pid,
        client: { name: "frond-ear-shim", version: SHIM_VERSION },
        ...(this.options.ear ? { ear: this.options.ear } : {}),
        ...(this.options.sessionId
          ? { sessionId: this.options.sessionId }
          : {}),
        ...(this.options.token ? { token: this.options.token } : {}),
      });
    });
    const connection = new LineConnection(
      socket,
      (message) => this.handleDaemonMessage(message as DaemonMessage),
      () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.daemon = undefined;
        for (const resolve of this.calls.values()) {
          resolve({ ok: false, text: "frond-ear daemon connection lost" });
        }
        this.calls.clear();
        if (wasConnected) {
          this.log("daemon connection lost; reconnecting");
        }
        if (!this.closed) {
          this.reconnectTimer = setTimeout(
            () => this.connectDaemon(),
            this.options.reconnectMs ?? 2_000,
          );
        }
      },
    );
    this.daemon = connection;
  }

  private handleDaemonMessage(message: DaemonMessage): void {
    switch (message.type) {
      case "welcome":
        this.welcome = message;
        if (message.error) {
          this.log(message.error);
        }
        for (const resolve of this.welcomeWaiters.splice(0)) {
          resolve();
        }
        return;
      case "event":
        if (this.initialized) {
          this.emitEvent(message);
        } else {
          this.pendingEvents.push(message);
        }
        return;
      case "result":
        this.calls.get(message.id)?.({ ok: message.ok, text: message.text });
        this.calls.delete(message.id);
        return;
      case "detached":
        this.log(`ear detached: ${message.reason}`);
        this.emitEvent({
          type: "event",
          batchId: null,
          content: `frond-ear: this session no longer receives Discord events for its ear (${message.reason}). Tools still work.`,
          meta: { kind: "detached", reason: message.reason },
        });
        return;
      default:
        return;
    }
  }

  private emitEvent(event: Extract<DaemonMessage, { type: "event" }>): void {
    this.write(
      {
        jsonrpc: "2.0",
        method: "notifications/claude/channel",
        params: { content: event.content, meta: event.meta },
      },
      () => {
        if (event.batchId !== null) {
          this.daemon?.send({ type: "offered", batchId: event.batchId });
        }
      },
    );
  }

  private callDaemon(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; text: string }> {
    if (!this.daemon || !this.connected) {
      return Promise.resolve({
        ok: false,
        text: "frond-ear daemon is not reachable; is `frond-ear daemon` running? (check FROND_EAR_SOCKET)",
      });
    }
    const id = this.nextCallId++;
    const daemon = this.daemon;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        resolve({
          ok: false,
          text: `frond-ear daemon did not answer ${tool} in time`,
        });
      }, this.options.callTimeoutMs ?? 60_000);
      this.calls.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      daemon.send({ type: "call", id, tool, args });
    });
  }

  private waitForWelcome(ms: number): Promise<void> {
    if (this.welcome) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.welcomeWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // ---- MCP side ---------------------------------------------------------------------

  private write(message: object, callback?: () => void): void {
    this.options.output.write(`${JSON.stringify(message)}\n`, callback);
  }

  private respond(id: string | number | null, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private fail(
    id: string | number | null,
    code: number,
    message: string,
  ): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private handleLine(line: string): void {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      this.fail(null, -32700, "parse error");
      return;
    }
    if (
      typeof request !== "object" ||
      request === null ||
      Array.isArray(request)
    ) {
      this.fail(null, -32600, "invalid request");
      return;
    }
    if (request.method === undefined) {
      return; // a response to something we never send
    }
    this.handleRequest(request).catch((error: unknown) => {
      if (request.id !== undefined) {
        this.fail(
          request.id,
          -32603,
          error instanceof Error ? error.message : "internal error",
        );
      }
    });
  }

  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    const id = request.id ?? null;
    const isNotification = request.id === undefined;
    switch (request.method) {
      case "initialize": {
        await this.waitForWelcome(this.options.initializeWaitMs ?? 1_500);
        const requested = request.params?.protocolVersion;
        const protocolVersion =
          typeof requested === "string" &&
          (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
            ? requested
            : SUPPORTED_PROTOCOL_VERSIONS[0];
        const instructions =
          this.welcome?.instructions ??
          `${channelInstructions(undefined, this.options.ear)}\n\n(frond-ear daemon was not reachable when this session started; events will flow once it is.)`;
        this.respond(id, {
          protocolVersion,
          capabilities: {
            experimental: { "claude/channel": {} },
            tools: {},
          },
          serverInfo: { name: "frond-ear", version: SHIM_VERSION },
          instructions,
        });
        return;
      }
      case "notifications/initialized":
        this.initialized = true;
        for (const event of this.pendingEvents.splice(0)) {
          this.emitEvent(event);
        }
        return;
      case "ping":
        this.respond(id, {});
        return;
      case "tools/list":
        this.respond(id, { tools: TOOLS });
        return;
      case "tools/call": {
        const name = request.params?.name;
        const args = request.params?.arguments;
        if (
          typeof name !== "string" ||
          !TOOLS.some((tool) => tool.name === name)
        ) {
          this.fail(id, -32602, `unknown tool ${String(name)}`);
          return;
        }
        const result = await this.callDaemon(
          name,
          args && typeof args === "object"
            ? (args as Record<string, unknown>)
            : {},
        );
        this.respond(id, {
          content: [{ type: "text", text: result.text }],
          ...(result.ok ? {} : { isError: true }),
        });
        return;
      }
      default:
        if (!isNotification) {
          this.fail(id, -32601, `method not found: ${request.method ?? ""}`);
        }
    }
  }
}
