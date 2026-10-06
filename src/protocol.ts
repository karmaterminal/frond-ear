import type { Socket } from "node:net";

export const EAR_PROTOCOL_VERSION = 1;
const MAX_LINE_BYTES = 4 * 1024 * 1024;

/** Messages from a shim or CLI client to the daemon. */
export type ClientMessage =
  | {
      type: "hello";
      role: "shim" | "cli" | "tap";
      protocol: number;
      ear?: string;
      pid?: number;
      sessionId?: string;
      /** The Claude process's working directory, so re-entry can resume there. */
      cwd?: string;
      /** What the shim could learn about the Claude process that launched it. */
      launch?: LaunchInfo;
      client?: { name: string; version: string };
      token?: string;
    }
  | { type: "offered"; batchId: number }
  | { type: "call"; id: number; tool: string; args: Record<string, unknown> }
  | { type: "status"; id: number }
  | { type: "inject"; id: number; message: unknown }
  | { type: "session"; sessionId: string; source?: string }
  /** Operator: bind an ear to a session, or release it (sessionId null). */
  | {
      type: "bind";
      id: number;
      ear: string;
      sessionId: string | null;
      cwd?: string;
    }
  /** A SessionStart hook reporting a (re-)entry: startup, resume, clear, compact. */
  | {
      type: "reentry";
      id: number;
      sessionId: string;
      source: string;
      ear?: string;
      launch?: LaunchInfo;
    };

export interface LaunchInfo {
  /** The Claude Code process, when it could be found. */
  pid?: number;
  /**
   * Whether that process was launched with a channel entry for this server
   * (`--dangerously-load-development-channels server:frond-ear` or `--channels`).
   * null when the command line could not be read.
   */
  channels: boolean | null;
  /** The session id the process was started to resume (`--resume <id>`), if any. */
  resumed?: string;
}

/** Messages from the daemon to a client. */
export type DaemonMessage =
  | {
      type: "welcome";
      protocol: number;
      attached: boolean;
      ear?: string;
      generation?: number;
      /** The ear belongs to another session; this one serves tools only. */
      standby?: boolean;
      instructions: string;
      error?: string;
    }
  | {
      type: "event";
      batchId: number | null;
      content: string;
      meta: Record<string, string>;
    }
  | {
      type: "result";
      id: number;
      ok: boolean;
      text: string;
    }
  | { type: "detached"; reason: string };

export interface Connection {
  send(message: DaemonMessage | ClientMessage): void;
  close(): void;
}

/**
 * Newline-delimited JSON over a stream socket. Oversized or malformed lines
 * close the connection rather than being partially parsed.
 */
export class LineConnection implements Connection {
  private readonly socket: Socket;
  private buffer = "";
  private closed = false;

  public constructor(
    socket: Socket,
    onMessage: (message: unknown) => void,
    onClose: () => void,
  ) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES) {
        this.close();
        return;
      }
      let newline = this.buffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            this.close();
            return;
          }
          onMessage(parsed);
        }
        newline = this.buffer.indexOf("\n");
      }
    });
    socket.on("close", () => {
      this.closed = true;
      onClose();
    });
    socket.on("error", () => {
      this.close();
    });
  }

  public send(message: DaemonMessage | ClientMessage): void {
    if (!this.closed) {
      this.socket.write(`${JSON.stringify(message)}\n`);
    }
  }

  public close(): void {
    if (!this.closed) {
      this.closed = true;
      this.socket.destroy();
    }
  }
}
