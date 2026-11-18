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
  | { type: "session"; sessionId: string; source?: string }
  /** A seat's SessionStart hook: release the ear's letters (#88). */
  | {
      type: "release";
      id: number;
      ear: string;
      source?: string;
      sessionId?: string;
    }
  /**
   * A seat's PreCompact hook: the letters to carry into the summary (#102), and
   * whether the session's compaction hold (#107) blocks this compaction. `trigger`
   * is the hook's own ("auto" or "manual"); `tokens` the transcript's latest context
   * reading; `ceiling` the seat's lower ceiling, if it set one.
   */
  | {
      type: "precompact";
      id: number;
      ear: string;
      sessionId?: string;
      trigger?: string;
      tokens?: number;
      ceiling?: number;
    }
  /**
   * A seat's pressure hook: its latest context reading, for ear_status (#98).
   * `tokens` is null right after a compaction with no usage since; `band` the
   * highest band reached (null under the first); `boundary` the latest compaction
   * marker the hook read; `at` when that evidence was written (epoch ms);
   * `idleFloor` the seat's CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS, when set.
   */
  | {
      type: "pressure";
      id: number;
      ear: string;
      sessionId: string;
      tokens: number | null;
      band: number | null;
      boundary: string | null;
      at: number;
      /** The boundary marker's own time, when known (#108). */
      boundaryAt?: number;
      idleFloor?: number;
      /** The hook event that read it; only PostToolUse and UserPromptSubmit can show a notice (#107). */
      event?: string;
    };

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
      /** precompact only (#107): why the session's hold blocks this compaction. */
      block?: string;
      /** pressure only (#107): a one-time line for the session, e.g. its hold ended. */
      notice?: string;
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
