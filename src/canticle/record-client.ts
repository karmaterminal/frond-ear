// Reads record v1 from the canticle host daemon over its host socket (RFC-0001 §11.1,
// §14.18.2) for `canticle.source: "host-daemon"`.
//
// Framing is §14.18.2's JSON lines (the same framing as the child's stdout), over a
// stream unix socket: Node's `net` has no SOCK_SEQPACKET (noted on binary-canticle#65).
// Lines over 64 KiB are discarded up to their newline and counted. Reconnects back off
// on the same curve as the Discord gateway (1 s·2^n ≤ 30 s + jitter). Silent, like the
// embedded receptor: nothing here wakes a session.
//
// Every connection's first line asks for a join snapshot (§14.18.3 "Join snapshot",
// D36): the bootstrap alone leaves a late joiner blind to what surfaced before it, and
// receive health says `joined_late` until a complete snapshot arrives.

import { connect, type Socket } from "node:net";

import type { StructuredLogger } from "../logger.ts";
import type { Clock, Timers } from "../types.ts";
import { systemClock, systemTimers } from "../types.ts";
import {
  JOIN_SNAPSHOT_REQUEST,
  MAX_LINE_BYTES,
  RecordConsumer,
} from "./records.ts";
import type { HearView } from "./receptor.ts";

export interface RecordClientOptions {
  socketPath: string;
  tune: Record<string, string[]>;
  logger: StructuredLogger;
  clock?: Clock;
  timers?: Timers;
  connect?: (path: string) => Socket;
}

export class RecordClient {
  readonly consumer = new RecordConsumer();
  readonly #options: RecordClientOptions;
  readonly #clock: Clock;
  readonly #timers: Timers;
  #socket: Socket | undefined;
  #state: "connecting" | "connected" | "backoff" | "stopped" = "connecting";
  #attempt = 0;
  #retry: unknown;
  #buffer = "";
  #discarding = false;
  #lastError: string | undefined;

  constructor(options: RecordClientOptions) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    this.#timers = options.timers ?? systemTimers;
  }

  start(): void {
    this.#connect();
  }

  stop(): void {
    this.#state = "stopped";
    this.#timers.clearTimeout(this.#retry);
    this.#socket?.destroy();
    this.#socket = undefined;
  }

  #connect(): void {
    this.#state = "connecting";
    // Line state belongs to one connection: a partial or over-long line from the
    // last one must not swallow this one's first record.
    this.#buffer = "";
    this.#discarding = false;
    const socket = (this.#options.connect ?? ((p) => connect(p)))(
      this.#options.socketPath,
    );
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      this.#state = "connected";
      this.#attempt = 0;
      // The request goes first, before anything is read (§14.18.3: it need not wait
      // for `hello`). A daemon that doesn't serve snapshots ignores it.
      socket.write(JOIN_SNAPSHOT_REQUEST);
      this.consumer.reconnected({ joinSnapshot: true });
      this.#lastError = undefined;
      this.#options.logger.log("info", "canticle.host_daemon_connected", {
        socket: this.#options.socketPath,
      });
    });
    socket.on("data", (chunk: string) => this.#onData(chunk));
    socket.on("error", (error) => {
      this.#lastError = error.message;
    });
    socket.on("close", () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.consumer.closed();
      if (this.#state === "stopped") return;
      this.#state = "backoff";
      const delay =
        Math.min(30_000, 1_000 * 2 ** Math.min(this.#attempt, 5)) +
        Math.floor(Math.random() * 1_000);
      this.#attempt += 1;
      this.#retry = this.#timers.setTimeout(() => {
        if (this.#state !== "stopped") this.#connect();
      }, delay);
    });
  }

  /** Split into lines, discarding any line over 64 KiB up to its newline. */
  #onData(chunk: string): void {
    let rest = chunk;
    while (rest.length > 0) {
      const nl = rest.indexOf("\n");
      const piece = nl === -1 ? rest : rest.slice(0, nl);
      rest = nl === -1 ? "" : rest.slice(nl + 1);
      if (this.#discarding) {
        if (nl !== -1) this.#discarding = false;
        continue;
      }
      this.#buffer += piece;
      if (Buffer.byteLength(this.#buffer) > MAX_LINE_BYTES) {
        this.consumer.dropLine("line_too_long");
        this.#buffer = "";
        this.#discarding = nl === -1;
        if (this.consumer.connectionLost) {
          // an over-long line in the bootstrap is a malformed bootstrap too
          this.#socket?.destroy();
          return;
        }
        continue;
      }
      if (nl !== -1) {
        const line = this.#buffer;
        this.#buffer = "";
        this.consumer.feedLine(line, this.#clock.now());
        if (this.consumer.connectionLost) {
          // A malformed bootstrap (§14.18.3): drop this connection and reconnect.
          this.#socket?.destroy();
          return;
        }
      }
    }
  }

  hearView(ear: string): HearView {
    return this.consumer.hearView(
      this.#options.tune[ear] ?? [],
      this.#clock.now(),
      this.#state === "connected",
    );
  }

  status(): object {
    return {
      source: "host-daemon",
      state: this.#state,
      socket: this.#options.socketPath,
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
      receiveHealth: this.consumer.health,
      reasons: this.consumer.healthReasons,
      joinSnapshot: this.consumer.snapshotState,
      ...(this.consumer.snapshotOmitted !== undefined
        ? { joinSnapshotOmitted: this.consumer.snapshotOmitted }
        : {}),
      run: this.consumer.run ?? null,
      mute: this.consumer.mute,
      counts: { ...this.consumer.counts },
      stations: Object.fromEntries(this.consumer.presence),
    };
  }
}
