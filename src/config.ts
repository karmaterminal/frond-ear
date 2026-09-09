import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";

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
    throw new Error("FROND_EAR_HOST must resolve to an explicit loopback address");
  }
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is required");
  }
  const adapterExecutable = process.env.FROND_EAR_ADAPTER_COMMAND;
  return {
    databasePath: resolve(process.env.FROND_EAR_DATABASE ?? "./data/frond-ear.db"),
    policyPath: resolve(process.env.FROND_EAR_POLICY ?? "./policy.json"),
    host,
    port: integerFromEnvironment("FROND_EAR_PORT", 8791),
    discordToken: token,
    gatewayUrl: process.env.FROND_EAR_GATEWAY_URL ?? "wss://gateway.discord.gg",
    leaseMs: integerFromEnvironment("FROND_EAR_LEASE_MS", 60_000),
    adapter: adapterExecutable
      ? {
          kind: "command",
          executable: adapterExecutable,
          args: JSON.parse(process.env.FROND_EAR_ADAPTER_ARGS ?? "[]") as string[],
          timeoutMs: integerFromEnvironment("FROND_EAR_ADAPTER_TIMEOUT_MS", 30_000),
          maxPayloadBytes: integerFromEnvironment("FROND_EAR_ADAPTER_MAX_BYTES", 64 * 1_024),
        }
      : { kind: "manual" },
  };
}
