import { spawn } from "node:child_process";

import type { LeasedBatch } from "./types.js";

export interface WakeAdapter {
  readonly name: string;
  deliver(batch: LeasedBatch): Promise<void>;
  status(): Record<string, unknown>;
}

export class ManualAdapter implements WakeAdapter {
  public readonly name = "manual";

  public async deliver(): Promise<void> {
    throw new Error(
      "manual adapter requires explicit lease/ack through the local API",
    );
  }

  public status(): Record<string, unknown> {
    return { name: this.name, automaticDelivery: false };
  }
}

export class CommandAdapter implements WakeAdapter {
  public readonly name = "command";
  private lastSuccessAt: number | null = null;
  private lastError: string | null = null;

  public constructor(
    private readonly options: {
      executable: string;
      args: string[];
      timeoutMs: number;
      maxPayloadBytes: number;
    },
  ) {
    if (
      !Array.isArray(options.args) ||
      options.args.some((value) => typeof value !== "string")
    ) {
      throw new Error("command adapter args must be an array of strings");
    }
  }

  public deliver(batch: LeasedBatch): Promise<void> {
    const payload = JSON.stringify(batch);
    if (Buffer.byteLength(payload, "utf8") > this.options.maxPayloadBytes) {
      return Promise.reject(
        new Error("adapter payload exceeds configured bound"),
      );
    }
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.executable, this.options.args, {
        shell: false,
        stdio: ["pipe", "ignore", "pipe"],
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: process.env.LANG,
        },
      });
      child.stderr.resume();
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;
      const fail = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.lastError = error.message;
        reject(error);
      };
      const timer = setTimeout(() => {
        fail(new Error("adapter timed out"));
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
        killTimer.unref();
      }, this.options.timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        if (killTimer) {
          clearTimeout(killTimer);
        }
        fail(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (killTimer) {
          clearTimeout(killTimer);
        }
        if (settled) {
          return;
        }
        if (code === 0) {
          settled = true;
          this.lastSuccessAt = Date.now();
          this.lastError = null;
          resolve();
          return;
        }
        const error = new Error(
          `adapter exited unsuccessfully (${signal ? `signal ${signal}` : `code ${String(code)}`})`,
        );
        fail(error);
      });
      child.stdin.end(payload);
    });
  }

  public status(): Record<string, unknown> {
    return {
      name: this.name,
      automaticDelivery: true,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
    };
  }
}
