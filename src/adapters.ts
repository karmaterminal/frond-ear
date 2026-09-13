import { spawn } from "node:child_process";

import type { LeasedBatch, SessionBinding } from "./types.js";

export type CopilotSendSource = "system" | "user";

export interface CopilotCanaryConfig {
  readonly enabled: boolean;
  readonly sessionPrefix: string;
  readonly allowlist: readonly string[];
  readonly primarySessionIds: readonly string[];
  readonly maxPayloadBytes: number;
}

export function parseCanaryConfig(
  env: NodeJS.ProcessEnv = process.env,
): CopilotCanaryConfig {
  const enabled =
    env.FROND_EAR_CANARY_LIVE === "1" ||
    env.FROND_EAR_CANARY_LIVE === "true" ||
    env.FROND_EAR_LIVE_CANARY === "1" ||
    env.FROND_EAR_LIVE_CANARY === "true" ||
    env.FROND_EAR_CANARY_MODE === "live" ||
    env.FROND_EAR_CANARY_MODE === "enabled";
  const readList = (...keys: string[]): string[] => {
    for (const key of keys) {
      const raw = env[key];
      if (!raw) {
        continue;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          const values = parsed.filter(
            (item): item is string => typeof item === "string",
          );
          if (values.length > 0) {
            return values;
          }
        }
      } catch {
        // Fall back to a comma-separated string below.
      }
      return raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }
    return [];
  };
  const allowlist = readList(
    "FROND_EAR_CANARY_SESSION_ALLOWLIST",
    "FROND_EAR_CANARY_ALLOWLIST",
    "FROND_EAR_CANARY_ALLOWED_SESSIONS",
    "FROND_EAR_CANARY_SESSION_IDS",
  );
  const primarySessionIds = readList(
    "FROND_EAR_PRIMARY_SESSION_ID",
    "FROND_EAR_PRIMARY_SESSION_IDS",
    "FROND_EAR_CANARY_FORBIDDEN_SESSIONS",
    "FROND_EAR_CANARY_PRIMARY_SESSION_IDS",
    "frond-scribe",
  );
  return {
    enabled,
    sessionPrefix:
      env.FROND_EAR_CANARY_SESSION_PREFIX ??
      env.FROND_EAR_CANARY_PREFIX ??
      "frond-ear-canary",
    allowlist,
    primarySessionIds:
      primarySessionIds.length > 0 ? primarySessionIds : ["frond-scribe"],
    maxPayloadBytes: Number(
      env.FROND_EAR_CANARY_MAX_BYTES ??
        env.FROND_EAR_ADAPTER_MAX_BYTES ??
        64 * 1024,
    ),
  };
}

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
    source: CopilotSendSource;
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
    userSource: boolean;
    enqueueMode: boolean;
    sourceMode: CopilotSendSource | "none";
    reason: string | null;
  };
  createClient(): CopilotSdkClient;
}

export class ReleasedCopilotSdkFactory implements CopilotSdkFactory {
  public readonly capability = (() => {
    const canary = parseCanaryConfig();
    const liveUserSource = canary.enabled && canary.allowlist.length > 0;
    return {
      available: liveUserSource,
      sdkVersion: "1.0.13",
      cliVersion: "1.0.83",
      systemSource: false,
      userSource: liveUserSource,
      enqueueMode: true,
      sourceMode: liveUserSource ? "user" : "none",
      reason: liveUserSource
        ? null
        : "Live Copilot canary must be opt-in via FROND_EAR_CANARY_LIVE and explicit FROND_EAR_CANARY_SESSION_ALLOWLIST entries",
    } as const;
  })();

  public createClient(): CopilotSdkClient {
    if (!this.capability.available) {
      throw new Error(
        this.capability.reason ?? "Copilot SDK delivery is unavailable",
      );
    }
    throw new Error(
      "Live canary is opt-in only; attach a real Copilot SDK client in the dedicated test session runtime",
    );
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
      maxPayloadBytes?: number;
      sourceMode?: CopilotSendSource | "none";
      canary?: CopilotCanaryConfig;
      isLeaseActive: (
        claimToken: string,
        bindingId: number,
        generation: number,
        minimumRemainingMs: number,
      ) => boolean;
    },
  ) {}

  public available(): boolean {
    const capability = this.options.factory.capability;
    return (
      capability.available &&
      capability.enqueueMode &&
      (capability.systemSource || capability.userSource)
    );
  }

  public resolveSessionId(binding: SessionBinding): string {
    const canary = this.options.canary;
    if (!canary || !canary.enabled) {
      return binding.sessionId;
    }
    const denyPrimary =
      binding.sessionId === "frond-scribe" ||
      canary.primarySessionIds.includes(binding.sessionId);
    if (denyPrimary) {
      throw new DeliveryError(
        `canary refused to target primary session ${binding.sessionId}`,
        "dead_letter",
      );
    }
    if (canary.allowlist.length > 0) {
      const allowed =
        canary.allowlist.includes(binding.sessionId) ||
        canary.allowlist.includes(binding.conversation.key) ||
        canary.allowlist.includes(
          `${canary.sessionPrefix}:${binding.conversation.key}`,
        );
      if (!allowed) {
        throw new DeliveryError(
          `canary session ${binding.sessionId} is not in the explicit allowlist`,
          "dead_letter",
        );
      }
    }
    return `${canary.sessionPrefix}:${binding.conversation.key}:${binding.generation}:${binding.sessionId}`;
  }

  public async deliver(batch: LeasedBatch): Promise<void> {
    if (!this.available()) {
      throw new DeliveryError(
        this.options.factory.capability.reason ??
          "Copilot SDK enqueue capability is unavailable",
        "retry",
      );
    }
    let timeout: NodeJS.Timeout | undefined;
    let active = true;
    let sendStarted = false;
    const deadlineAt = Date.now() + this.options.timeoutMs;
    const sourceMode =
      this.options.sourceMode ?? this.options.factory.capability.sourceMode;
    const effectiveSource: CopilotSendSource =
      sourceMode === "system" && this.options.factory.capability.systemSource
        ? "system"
        : "user";
    const assertActive = (): void => {
      if (!active) {
        throw new DeliveryError(
          "Copilot SDK delivery deadline elapsed before enqueue",
          "retry",
        );
      }
    };
    const operation = async (): Promise<string> => {
      const session = await this.sessionFor(batch, assertActive);
      assertActive();
      if (
        !this.options.isLeaseActive(
          batch.claimToken,
          batch.binding.id,
          batch.binding.generation,
          Math.max(1, deadlineAt - Date.now()),
        )
      ) {
        throw new DeliveryError(
          "queue lease or binding generation is no longer active",
          "retry",
        );
      }
      const prompt = this.promptFor(batch, effectiveSource);
      sendStarted = true;
      return session.send({
        prompt,
        source: effectiveSource,
        mode: "enqueue",
      });
    };
    try {
      const accepted = await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            active = false;
            reject(
              new DeliveryError(
                sendStarted
                  ? "Copilot SDK enqueue acceptance timed out; outcome is ambiguous"
                  : "Copilot SDK setup timed out before enqueue",
                sendStarted ? "dead_letter" : "retry",
              ),
            );
          }, this.options.timeoutMs);
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
      active = false;
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private promptFor(batch: LeasedBatch, source: CopilotSendSource): string {
    const prefix =
      source === "user"
        ? "[UNTRUSTED DISCORD EVENT SUMMARY; provenance explicit and not trusted by the receiver]\n"
        : "";
    const prompt = `${prefix}${batch.summary}`;
    const maxBytes = this.options.maxPayloadBytes ?? 64 * 1024;
    if (Buffer.byteLength(prompt, "utf8") > maxBytes) {
      throw new DeliveryError(
        `Copilot SDK prompt exceeds the ${maxBytes} byte payload bound`,
        "retry",
      );
    }
    return prompt;
  }

  private async sessionFor(
    batch: LeasedBatch,
    assertActive: () => void,
  ): Promise<CopilotSdkSession> {
    assertActive();
    const cached = this.sessions.get(batch.binding.id);
    if (cached) {
      this.sessions.delete(batch.binding.id);
      this.sessions.set(batch.binding.id, cached);
      return cached;
    }
    const client = await this.clientInstance(assertActive);
    assertActive();
    const sessionId = this.resolveSessionId(batch.binding);
    const metadata = await client.getSessionMetadata(sessionId);
    assertActive();
    const session = metadata
      ? await client.resumeSession(sessionId, {
          suppressResumeEvent: true,
          continuePendingWork: false,
        })
      : await client.createSession({ sessionId });
    try {
      assertActive();
    } catch (error) {
      await this.settleWithin(session.disconnect());
      throw error;
    }
    this.sessions.set(batch.binding.id, session);
    this.evictIfNeeded();
    return session;
  }

  private async clientInstance(
    assertActive: () => void,
  ): Promise<CopilotSdkClient> {
    assertActive();
    if (this.client) {
      return this.client;
    }
    const client = this.options.factory.createClient();
    await client.start();
    try {
      assertActive();
    } catch (error) {
      await this.settleWithin(client.stop());
      throw error;
    }
    this.client = client;
    return client;
  }

  private evictIfNeeded(): void {
    while (this.sessions.size > this.options.maxCachedSessions) {
      const oldest = this.sessions.entries().next().value as
        | [number, CopilotSdkSession]
        | undefined;
      if (!oldest) {
        return;
      }
      this.sessions.delete(oldest[0]);
      void this.settleWithin(oldest[1].disconnect());
    }
  }

  public async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(
      sessions.map(async (session) => this.settleWithin(session.disconnect())),
    );
    if (this.client) {
      await this.settleWithin(this.client.stop());
      this.client = undefined;
    }
  }

  private async settleWithin(operation: Promise<unknown>): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        operation,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, this.options.timeoutMs);
        }),
      ]);
    } catch {
      // Cleanup is best-effort and bounded; delivery state is decided separately.
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
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
