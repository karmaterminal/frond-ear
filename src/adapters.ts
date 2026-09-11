import { spawn } from "node:child_process";

import type { LeasedBatch } from "./types.js";

export interface WakeAdapter {
  readonly name: string;
  readonly automaticDelivery: boolean;
  available(): boolean;
  deliver(batch: LeasedBatch): Promise<void>;
  status(): Record<string, unknown>;
  close?(): Promise<void>;
}

export class DeliveryError extends Error {
  public constructor(
    message: string,
    public readonly disposition: "retry" | "dead_letter",
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}

export class ManualAdapter implements WakeAdapter {
  public readonly name = "manual";
  public readonly automaticDelivery = false;

  public available(): boolean {
    return false;
  }

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
  public readonly automaticDelivery = true;
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

  public available(): boolean {
    return true;
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

export interface CopilotSdkSession {
  readonly sessionId: string;
  send(options: {
    prompt: string;
    source: "system";
    mode: "enqueue";
  }): Promise<string>;
  disconnect(): Promise<void>;
}

export interface CopilotSdkClient {
  start(): Promise<void>;
  stop(): Promise<readonly Error[]>;
  getSessionMetadata(
    sessionId: string,
  ): Promise<{ sessionId: string } | undefined>;
  createSession(config: { sessionId: string }): Promise<CopilotSdkSession>;
  resumeSession(
    sessionId: string,
    config: { suppressResumeEvent: boolean; continuePendingWork: boolean },
  ): Promise<CopilotSdkSession>;
}

export interface CopilotSdkFactory {
  readonly capability: {
    available: boolean;
    sdkVersion: string;
    cliVersion: string;
    systemSource: boolean;
    enqueueMode: boolean;
    reason: string | null;
  };
  createClient(): CopilotSdkClient;
}

export class ReleasedCopilotSdkFactory implements CopilotSdkFactory {
  public readonly capability = {
    available: false,
    sdkVersion: "1.0.13",
    cliVersion: "1.0.83",
    systemSource: false,
    enqueueMode: true,
    reason:
      "@github/copilot-sdk@1.0.13 MessageOptions does not expose source; refusing unsupported system delivery",
  } as const;

  public createClient(): CopilotSdkClient {
    throw new Error(this.capability.reason);
  }
}

export class CopilotSdkAdapter implements WakeAdapter {
  public readonly name = "copilot-sdk";
  public readonly automaticDelivery = true;
  private client: CopilotSdkClient | undefined;
  private readonly sessions = new Map<number, CopilotSdkSession>();
  private lastSuccessAt: number | null = null;
  private lastError: string | null = null;

  public constructor(
    private readonly options: {
      factory: CopilotSdkFactory;
      timeoutMs: number;
      maxCachedSessions: number;
    },
  ) {}

  public available(): boolean {
    const capability = this.options.factory.capability;
    return (
      capability.available && capability.systemSource && capability.enqueueMode
    );
  }

  public async deliver(batch: LeasedBatch): Promise<void> {
    if (!this.available()) {
      throw new DeliveryError(
        this.options.factory.capability.reason ??
          "Copilot SDK system enqueue capability is unavailable",
        "retry",
      );
    }
    const session = await this.sessionFor(batch);
    let timeout: NodeJS.Timeout | undefined;
    try {
      const accepted = await Promise.race([
        session.send({
          prompt: batch.summary,
          source: "system",
          mode: "enqueue",
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new DeliveryError(
                  "Copilot SDK enqueue acceptance timed out; outcome is ambiguous",
                  "dead_letter",
                ),
              ),
            this.options.timeoutMs,
          );
        }),
      ]);
      if (typeof accepted !== "string" || accepted.length === 0) {
        throw new DeliveryError(
          "Copilot SDK did not return an accepted message identifier",
          "retry",
        );
      }
      this.lastSuccessAt = Date.now();
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async sessionFor(batch: LeasedBatch): Promise<CopilotSdkSession> {
    const cached = this.sessions.get(batch.binding.id);
    if (cached) {
      this.sessions.delete(batch.binding.id);
      this.sessions.set(batch.binding.id, cached);
      return cached;
    }
    const client = await this.clientInstance();
    const metadata = await client.getSessionMetadata(batch.binding.sessionId);
    const session = metadata
      ? await client.resumeSession(batch.binding.sessionId, {
          suppressResumeEvent: true,
          continuePendingWork: false,
        })
      : await client.createSession({ sessionId: batch.binding.sessionId });
    this.sessions.set(batch.binding.id, session);
    await this.evictIfNeeded();
    return session;
  }

  private async clientInstance(): Promise<CopilotSdkClient> {
    if (this.client) {
      return this.client;
    }
    const client = this.options.factory.createClient();
    await client.start();
    this.client = client;
    return client;
  }

  private async evictIfNeeded(): Promise<void> {
    while (this.sessions.size > this.options.maxCachedSessions) {
      const oldest = this.sessions.entries().next().value as
        | [number, CopilotSdkSession]
        | undefined;
      if (!oldest) {
        return;
      }
      this.sessions.delete(oldest[0]);
      await oldest[1].disconnect();
    }
  }

  public async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(
      sessions.map(async (session) => session.disconnect()),
    );
    if (this.client) {
      await this.client.stop();
      this.client = undefined;
    }
  }

  public status(): Record<string, unknown> {
    return {
      name: this.name,
      automaticDelivery: true,
      available: this.available(),
      capability: this.options.factory.capability,
      cachedSessions: this.sessions.size,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
    };
  }
}
