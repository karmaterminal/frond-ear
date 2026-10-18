// Discord Gateway v10 client. Salvaged from codeagent/frond-ear-live-canary-v2
// (src/gateway.ts) and extended: 4007/4009 re-identify, contained ingest
// failures, fatal-close callback, GUILDS intent with thread-parent tracking.
import type { StructuredLogger } from "./logger.ts";
import type { GatewayCursor } from "./store.ts";
import type { DiscordMessage, GatewayPayload } from "./types.ts";

const GATEWAY_VERSION = 10;
const GUILDS_INTENT = 1 << 0;
const GUILD_MESSAGES_INTENT = 1 << 9;
const DIRECT_MESSAGES_INTENT = 1 << 12;
const MESSAGE_CONTENT_INTENT = 1 << 15;
export const GATEWAY_INTENTS =
  GUILDS_INTENT |
  GUILD_MESSAGES_INTENT |
  DIRECT_MESSAGES_INTENT |
  MESSAGE_CONTENT_INTENT;
/** Authentication failed, bad shard/intents: reconnecting cannot help. */
const FATAL_CLOSE_CODES = new Set([4_004, 4_010, 4_011, 4_012, 4_013, 4_014]);
/** Invalid seq / session timed out: the session is gone, identify afresh. */
const SESSION_INVALID_CLOSE_CODES = new Set([4_007, 4_009]);

export interface GatewaySocket {
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: { data: string }) => void,
  ): void;
  addEventListener(
    type: "close",
    listener: (event: { code: number; reason?: string }) => void,
  ): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  send(data: string): void;
  close(code?: number): void;
}

export type GatewaySocketFactory = (url: string) => GatewaySocket;

export interface GatewayStore {
  gatewayState(): GatewayCursor;
  saveGatewayState(state: GatewayCursor): void;
  clearGatewaySession(): void;
  setRuntimeState(name: string, value: string): void;
}

export interface GatewayStatus {
  state:
    | "stopped"
    | "connecting"
    | "connected"
    | "resuming"
    | "backoff"
    | "failed";
  lastSequence: number | null;
  lastEventTime: number | null;
  sessionId: string | null;
  lastError: string | null;
}

export interface GatewayOptions {
  token: string;
  gatewayUrl: string;
  store: GatewayStore;
  logger: StructuredLogger;
  onMessage: (message: DiscordMessage) => void;
  /**
   * A session started afresh (READY after IDENTIFY): Discord replays nothing sent before it.
   * Runs before the session is stored and before any of its dispatches; a throw fences the
   * stream, so the next connection identifies afresh and calls it again.
   */
  onReady?: () => void;
  /** A session resumed (RESUMED): Discord has replayed what was missed. */
  onResumed?: () => void;
  onThread?: (threadId: string, parentId: string) => void;
  onFatal?: (closeCode: number) => void;
  socketFactory?: GatewaySocketFactory;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  random?: () => number;
}

interface ThreadLike {
  id?: unknown;
  parent_id?: unknown;
}

export class DiscordGateway {
  private readonly options: GatewayOptions;
  private socket: GatewaySocket | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = true;
  private generation = 0;
  private reconnectAttempt = 0;
  private awaitingHeartbeatAck = false;
  private fenced = false;
  private statusValue: GatewayStatus = {
    state: "stopped",
    lastSequence: null,
    lastEventTime: null,
    sessionId: null,
    lastError: null,
  };

  public constructor(options: GatewayOptions) {
    this.options = options;
  }

  public status(): GatewayStatus {
    return { ...this.statusValue };
  }

  public start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.connect();
  }

  public stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.statusValue.state = "stopped";
    this.clearTimers();
    // Not 1000 or 1001: Discord invalidates a session closed with either, so a restarted
    // daemon could not resume it and would never get what was sent while it was down (#70).
    this.socket?.close(4_000);
    this.socket = undefined;
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }
    this.clearHeartbeat();
    this.awaitingHeartbeatAck = false;
    this.fenced = false;
    const generation = ++this.generation;
    const persisted = this.options.store.gatewayState();
    const baseUrl = persisted.resumeGatewayUrl ?? this.options.gatewayUrl;
    const url = `${baseUrl.replace(/\/+$/u, "")}/?v=${GATEWAY_VERSION}&encoding=json`;
    this.statusValue = {
      ...this.statusValue,
      state: persisted.sessionId ? "resuming" : "connecting",
      lastSequence: persisted.sequence,
      sessionId: persisted.sessionId,
      lastError: null,
    };
    const factory =
      this.options.socketFactory ??
      ((target) => new WebSocket(target) as unknown as GatewaySocket);
    const socket = factory(url);
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      if (generation !== this.generation || socket !== this.socket) {
        return;
      }
      this.handleRawPayload(event.data);
    });
    socket.addEventListener("close", (event) => {
      if (generation !== this.generation || socket !== this.socket) {
        return;
      }
      this.socket = undefined;
      this.clearHeartbeat();
      this.awaitingHeartbeatAck = false;
      if (FATAL_CLOSE_CODES.has(event.code)) {
        this.stopped = true;
        this.statusValue.state = "failed";
        this.statusValue.lastError = `gateway_closed_${event.code}`;
        this.options.logger.log("error", "gateway.fatal_close", {
          closeCode: event.code,
        });
        this.options.onFatal?.(event.code);
        return;
      }
      if (SESSION_INVALID_CLOSE_CODES.has(event.code)) {
        this.options.logger.log("warn", "gateway.session_invalidated", {
          closeCode: event.code,
        });
        this.options.store.clearGatewaySession();
      }
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      if (generation !== this.generation || socket !== this.socket) {
        return;
      }
      this.options.logger.log("warn", "gateway.socket_error", {
        state: this.statusValue.state,
      });
    });
  }

  private handleRawPayload(data: string): void {
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(data) as GatewayPayload;
    } catch {
      this.options.logger.log("warn", "gateway.invalid_json");
      return;
    }
    this.handlePayload(payload);
  }

  public handlePayload(payload: GatewayPayload): void {
    // After a non-durable dispatch the stream is fenced: nothing else from
    // this connection may be processed (or advance the cursor) until we have
    // reconnected and resumed from the last durable sequence, which makes
    // Discord replay the failed event.
    if (this.fenced) {
      return;
    }
    let durable = true;
    switch (payload.op) {
      case 0:
        durable = this.handleDispatch(payload);
        break;
      case 1:
        this.sendHeartbeat(false);
        break;
      case 7:
        this.reconnectNow();
        break;
      case 9:
        if (payload.d === false) {
          this.options.store.clearGatewaySession();
        }
        this.reconnectNow(
          1_000 +
            Math.floor((this.options.random?.() ?? Math.random()) * 4_000),
        );
        break;
      case 10:
        this.handleHello(payload.d);
        break;
      case 11:
        this.awaitingHeartbeatAck = false;
        this.options.store.setRuntimeState(
          "last_gateway_heartbeat_ack",
          String(Date.now()),
        );
        break;
      default:
        break;
    }
    if (!durable) {
      this.fenced = true;
      this.options.logger.log("warn", "gateway.fenced_for_replay", {
        durableSequence: this.options.store.gatewayState().sequence,
      });
      this.reconnectAfterFailure();
      return;
    }
    if (typeof payload.s === "number") {
      const current = this.options.store.gatewayState();
      this.options.store.saveGatewayState({
        sessionId: current.sessionId,
        sequence: payload.s,
        resumeGatewayUrl: current.resumeGatewayUrl,
      });
      this.statusValue.lastSequence = payload.s;
    }
  }

  private handleHello(data: unknown): void {
    if (
      !data ||
      typeof data !== "object" ||
      !("heartbeat_interval" in data) ||
      typeof data.heartbeat_interval !== "number"
    ) {
      this.options.logger.log("error", "gateway.invalid_hello");
      this.reconnectNow();
      return;
    }
    const heartbeatInterval = data.heartbeat_interval;
    this.clearHeartbeat();
    this.awaitingHeartbeatAck = false;
    this.statusValue.state = "connected";
    const jitter = this.options.random?.() ?? Math.random();
    this.heartbeatTimer = (this.options.setTimeout ?? globalThis.setTimeout)(
      () => {
        if (!this.sendHeartbeat(true)) {
          return;
        }
        this.startHeartbeatLoop(heartbeatInterval);
      },
      Math.floor(heartbeatInterval * jitter),
    );
    const state = this.options.store.gatewayState();
    if (state.sessionId && state.sequence !== null) {
      this.send({
        op: 6,
        d: {
          token: this.options.token,
          session_id: state.sessionId,
          seq: state.sequence,
        },
      });
    } else {
      this.send({
        op: 2,
        d: {
          token: this.options.token,
          intents: GATEWAY_INTENTS,
          properties: {
            os: process.platform,
            browser: "frond-ear",
            device: "frond-ear",
          },
        },
      });
    }
  }

  private startHeartbeatLoop(interval: number): void {
    this.heartbeatTimer = (this.options.setTimeout ?? globalThis.setTimeout)(
      () => {
        if (!this.sendHeartbeat(true)) {
          return;
        }
        this.startHeartbeatLoop(interval);
      },
      interval,
    );
  }

  private sendHeartbeat(checkAck: boolean): boolean {
    if (checkAck && this.awaitingHeartbeatAck) {
      this.statusValue.lastError = "gateway_heartbeat_ack_timeout";
      this.options.logger.log("warn", "gateway.heartbeat_ack_timeout");
      this.reconnectNow();
      return false;
    }
    this.send({ op: 1, d: this.options.store.gatewayState().sequence });
    this.awaitingHeartbeatAck = true;
    return true;
  }

  /** Returns false when the dispatch could not be durably handled. */
  private handleDispatch(payload: GatewayPayload): boolean {
    this.statusValue.lastEventTime = Date.now();
    switch (payload.t) {
      case "READY": {
        const ready = payload.d as {
          session_id?: unknown;
          resume_gateway_url?: unknown;
        };
        if (
          typeof ready.session_id === "string" &&
          typeof ready.resume_gateway_url === "string"
        ) {
          try {
            this.options.onReady?.();
          } catch (error) {
            this.statusValue.lastError = "ready_failed";
            this.options.logger.log("error", "gateway.ready_failed", {
              reason: error instanceof Error ? error.name : "unknown",
            });
            return false;
          }
          this.options.store.saveGatewayState({
            sessionId: ready.session_id,
            sequence: typeof payload.s === "number" ? payload.s : null,
            resumeGatewayUrl: ready.resume_gateway_url,
          });
          this.statusValue.sessionId = ready.session_id;
          this.reconnectAttempt = 0;
          this.statusValue.lastError = null;
        }
        return true;
      }
      case "RESUMED":
        this.statusValue.state = "connected";
        this.reconnectAttempt = 0;
        this.statusValue.lastError = null;
        try {
          this.options.onResumed?.();
        } catch (error) {
          this.options.logger.log("error", "gateway.resumed_failed", {
            reason: error instanceof Error ? error.name : "unknown",
          });
        }
        return true;
      case "GUILD_CREATE":
        this.recordThreads((payload.d as { threads?: unknown }).threads);
        return true;
      case "THREAD_CREATE":
      case "THREAD_UPDATE":
        this.recordThreads([payload.d]);
        return true;
      case "THREAD_LIST_SYNC":
        this.recordThreads((payload.d as { threads?: unknown }).threads);
        return true;
      case "MESSAGE_CREATE":
        try {
          this.options.onMessage(payload.d as DiscordMessage);
          return true;
        } catch (error) {
          this.statusValue.lastError = "ingest_failed";
          this.options.logger.log("error", "gateway.ingest_failed", {
            sequence: payload.s ?? null,
            reason: error instanceof Error ? error.name : "unknown",
          });
          return false;
        }
      default:
        return true;
    }
  }

  private recordThreads(threads: unknown): void {
    if (!Array.isArray(threads) || !this.options.onThread) {
      return;
    }
    for (const thread of threads as ThreadLike[]) {
      if (
        typeof thread?.id === "string" &&
        typeof thread.parent_id === "string"
      ) {
        this.options.onThread(thread.id, thread.parent_id);
      }
    }
  }

  private send(payload: GatewayPayload): void {
    this.socket?.send(JSON.stringify(payload));
  }

  /**
   * Drops the connection and resumes with exponential backoff, so a failure
   * that persists (e.g. storage trouble) does not hot-loop reconnects.
   */
  private reconnectAfterFailure(): void {
    this.clearHeartbeat();
    this.awaitingHeartbeatAck = false;
    const socket = this.socket;
    this.socket = undefined;
    this.generation += 1;
    socket?.close(4_000);
    this.scheduleReconnect();
  }

  private reconnectNow(delayMs = 0): void {
    this.clearHeartbeat();
    this.awaitingHeartbeatAck = false;
    const socket = this.socket;
    this.socket = undefined;
    this.generation += 1;
    socket?.close(4_000);
    this.scheduleReconnect(delayMs);
  }

  private scheduleReconnect(delayMs?: number): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    this.statusValue.state = "backoff";
    const backoff =
      delayMs ??
      Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt++, 5)) +
        Math.floor((this.options.random?.() ?? Math.random()) * 1_000);
    this.reconnectTimer = (this.options.setTimeout ?? globalThis.setTimeout)(
      () => {
        this.reconnectTimer = undefined;
        this.connect();
      },
      backoff,
    );
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      (this.options.clearTimeout ?? globalThis.clearTimeout)(
        this.heartbeatTimer,
      );
      this.heartbeatTimer = undefined;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      (this.options.clearTimeout ?? globalThis.clearTimeout)(
        this.reconnectTimer,
      );
      this.reconnectTimer = undefined;
    }
  }
}
