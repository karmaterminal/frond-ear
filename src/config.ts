import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";

import { parseCanaryConfig, type CopilotSendSource } from "./adapters.js";
import { validatePolicy } from "./policy.js";
import type { Policy } from "./types.js";

export interface AppConfig {
  databasePath: string;
  policyPath: string;
  host: string;
  port: number;
  discordToken: string;
  gatewayUrl: string;
  leaseMs: number;
  adapter:
    | { kind: "manual" }
    | {
        kind: "copilot";
        timeoutMs: number;
        maxCachedSessions: number;
        maxPayloadBytes: number;
        sourceMode: CopilotSendSource | "none";
        canary: ReturnType<typeof parseCanaryConfig>;
      }
    | {
        kind: "command";
        executable: string;
        args: string[];
        timeoutMs: number;
        maxPayloadBytes: number;
      };
}

function integerFromEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "::1") {
    return true;
  }
  if (isIP(host) === 4) {
    return host.startsWith("127.");
  }
  return false;
}

export function loadPolicy(path: string): Policy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `unable to read policy file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validatePolicy(parsed);
}

export function loadConfig(): AppConfig {
  const host = process.env.FROND_EAR_HOST ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error(
      "FROND_EAR_HOST must resolve to an explicit loopback address",
    );
  }
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is required");
  }
  const adapterExecutable = process.env.FROND_EAR_ADAPTER_COMMAND;
  const adapterKind =
    process.env.FROND_EAR_ADAPTER ?? (adapterExecutable ? "command" : "manual");
  if (!["manual", "command", "copilot"].includes(adapterKind)) {
    throw new Error("FROND_EAR_ADAPTER must be manual, command, or copilot");
  }
  if (adapterKind === "command" && !adapterExecutable) {
    throw new Error(
      "FROND_EAR_ADAPTER_COMMAND is required for the command adapter",
    );
  }
  const canary = parseCanaryConfig();
  const desiredSourceMode =
    (process.env.FROND_EAR_COPILOT_SOURCE_MODE as CopilotSendSource | "none") ??
    (canary.enabled ? "user" : "system");
  if (!["system", "user", "none"].includes(desiredSourceMode)) {
    throw new Error(
      "FROND_EAR_COPILOT_SOURCE_MODE must be system, user, or none",
    );
  }
  const leaseMs = integerFromEnvironment("FROND_EAR_LEASE_MS", 60_000);
  const adapterTimeoutMs = integerFromEnvironment(
    "FROND_EAR_ADAPTER_TIMEOUT_MS",
    30_000,
  );
  const parsedAdapterArgs = JSON.parse(
    process.env.FROND_EAR_ADAPTER_ARGS ?? "[]",
  ) as unknown;
  if (
    !Array.isArray(parsedAdapterArgs) ||
    parsedAdapterArgs.some((argument) => typeof argument !== "string")
  ) {
    throw new Error("FROND_EAR_ADAPTER_ARGS must be a JSON array of strings");
  }
  if (adapterKind !== "manual" && adapterTimeoutMs >= leaseMs) {
    throw new Error(
      "FROND_EAR_ADAPTER_TIMEOUT_MS must be less than FROND_EAR_LEASE_MS",
    );
  }
  return {
    databasePath: resolve(
      process.env.FROND_EAR_DATABASE ?? "./data/frond-ear.db",
    ),
    policyPath: resolve(process.env.FROND_EAR_POLICY ?? "./policy.json"),
    host,
    port: integerFromEnvironment("FROND_EAR_PORT", 8791),
    discordToken: token,
    gatewayUrl: process.env.FROND_EAR_GATEWAY_URL ?? "wss://gateway.discord.gg",
    leaseMs,
    adapter:
      adapterKind === "command" && adapterExecutable
        ? {
            kind: "command",
            executable: adapterExecutable,
            args: parsedAdapterArgs,
            timeoutMs: adapterTimeoutMs,
            maxPayloadBytes: integerFromEnvironment(
              "FROND_EAR_ADAPTER_MAX_BYTES",
              64 * 1_024,
            ),
          }
        : adapterKind === "copilot"
          ? {
              kind: "copilot",
              timeoutMs: adapterTimeoutMs,
              maxCachedSessions: integerFromEnvironment(
                "FROND_EAR_COPILOT_MAX_SESSIONS",
                16,
              ),
              maxPayloadBytes: integerFromEnvironment(
                "FROND_EAR_ADAPTER_MAX_BYTES",
                64 * 1_024,
              ),
              sourceMode: desiredSourceMode,
              canary,
            }
          : { kind: "manual" },
  };
}
