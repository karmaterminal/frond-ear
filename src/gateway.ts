import type { EventStore } from "./store.js";
import type { DiscordMessage, GatewayPayload } from "./types.js";
import type { StructuredLogger } from "./logger.js";

const GATEWAY_VERSION = 10;
const MESSAGE_CONTENT_INTENT = 1 << 15;
const GUILD_MESSAGES_INTENT = 1 << 9;

export interface GatewaySocket {
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: string }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  send(data: string): void;
  close(code?: number): void;
}

export type GatewaySocketFactory = (url: string) => GatewaySocket;

export interface GatewayStatus {
  state: "stopped" | "connecting" | "connected" | "resuming" | "backoff";
  lastSequence: number | null;
  lastEventTime: number | null;
  sessionId: string | null;
}

export class DiscordGateway {
  private socket: GatewaySocket | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = true;
  private statusValue: GatewayStatus = {
    state: "stopped",
    lastSequence: null,
    lastEventTime: null,
    sessionId: null,
  };

  public constructor(
    private readonly options: {
      token: string;
      gatewayUrl: string;
      store: EventStore;
      onMessage: (message: DiscordMessage) => void;
      logger: StructuredLogger;
      socketFactory?: GatewaySocketFactory;
      setTimeout?: typeof globalThis.setTimeout;
      clearTimeout?: typeof globalThis.clearTimeout;
      random?: () => number;
    },
  ) {}

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
    this.statusValue.state = "stopped";
    this.clearTimers();
    this.socket?.close(1_000);
    this.socket = undefined;
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }
    const persisted = this.options.store.gatewayState();
    const baseUrl = persisted.resumeGatewayUrl ?? this.options.gatewayUrl;
    const url = `${baseUrl.replace(/\/+$/u, "")}/?v=${GATEWAY_VERSION}&encoding=json`;
    this.statusValue = {
      ...this.statusValue,
      state: persisted.sessionId ? "resuming" : "connecting",
      lastSequence: persisted.sequence,
      sessionId: persisted.sessionId,
    };
    const factory =
      this.options.socketFactory ??
      ((target) => new WebSocket(target) as unknown as GatewaySocket);
    const socket = factory(url);
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      this.handleRawPayload(event.data);
    });
    socket.addEventListener("close", () => {
      this.clearHeartbeat();
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
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
    if (typeof payload.s === "number") {
      const current = this.options.store.gatewayState();
      this.options.store.saveGatewayState({
        sessionId: current.sessionId,
        sequence: payload.s,
        resumeGatewayUrl: current.resumeGatewayUrl,
      });
      this.statusValue.lastSequence = payload.s;
    }
    switch (payload.op) {
      case 0:
        this.handleDispatch(payload);
        break;
      case 1:
        this.sendHeartbeat();
        break;
      case 7:
        this.reconnectNow();
        break;
      case 9:
        if (payload.d === false) {
          this.options.store.clearGatewaySession();
        }
        this.reconnectNow();
        break;
      case 10:
        this.handleHello(payload.d);
        break;
      case 11:
        this.options.store.setRuntimeState("last_gateway_heartbeat_ack", String(Date.now()));
        break;
      default:
        break;
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
    this.statusValue.state = "connected";
    const jitter = this.options.random?.() ?? Math.random();
    this.heartbeatTimer = (this.options.setTimeout ?? globalThis.setTimeout)(() => {
      this.sendHeartbeat();
      this.startHeartbeatLoop(data.heartbeat_interval);
    }, Math.floor(data.heartbeat_interval * jitter));
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
          intents: GUILD_MESSAGES_INTENT | MESSAGE_CONTENT_INTENT,
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
    this.heartbeatTimer = (this.options.setTimeout ?? globalThis.setTimeout)(() => {
      this.sendHeartbeat();
      this.startHeartbeatLoop(interval);
    }, interval);
  }

  private sendHeartbeat(): void {
    this.send({ op: 1, d: this.options.store.gatewayState().sequence });
  }

  private handleDispatch(payload: GatewayPayload): void {
    this.statusValue.lastEventTime = Date.now();
    if (payload.t === "READY") {
      const ready = payload.d as {
        session_id?: unknown;
        resume_gateway_url?: unknown;
      };
      if (typeof ready.session_id === "string" && typeof ready.resume_gateway_url === "string") {
        this.options.store.saveGatewayState({
          sessionId: ready.session_id,
          sequence: typeof payload.s === "number" ? payload.s : null,
          resumeGatewayUrl: ready.resume_gateway_url,
        });
        this.statusValue.sessionId = ready.session_id;
      }
      return;
    }
    if (payload.t === "RESUMED") {
      this.statusValue.state = "connected";
      return;
    }
    if (payload.t === "MESSAGE_CREATE") {
      this.options.onMessage(payload.d as DiscordMessage);
    }
  }

  private send(payload: GatewayPayload): void {
    this.socket?.send(JSON.stringify(payload));
  }

  private reconnectNow(): void {
    this.clearHeartbeat();
    this.socket?.close(4_000);
    this.socket = undefined;
    this.scheduleReconnect(0);
  }

  private scheduleReconnect(delayMs = 1_000): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    this.statusValue.state = "backoff";
    this.reconnectTimer = (this.options.setTimeout ?? globalThis.setTimeout)(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delayMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      (this.options.clearTimeout ?? globalThis.clearTimeout)(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      (this.options.clearTimeout ?? globalThis.clearTimeout)(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}
