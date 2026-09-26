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
      client?: { name: string; version: string };
      token?: string;
    }
  | { type: "offered"; batchId: number }
  | { type: "call"; id: number; tool: string; args: Record<string, unknown> }
  | { type: "status"; id: number }
  | { type: "inject"; id: number; message: unknown }
  | { type: "session"; sessionId: string; source?: string };

/** Messages from the daemon to a client. */
export type DaemonMessage =
  | {
      type: "welcome";
      protocol: number;
      attached: boolean;
      ear?: string;
      generation?: number;
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
