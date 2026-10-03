import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Mode } from "./types.ts";

export interface ChannelConfig {
  mode: Mode;
  quietWindowMs?: number;
  maxDelayMs?: number;
  historyLimit?: number;
}

export interface EarConfig {
  /**
   * How the attached session hears: `claude-channel` (Claude Code channel shim) or
   * `copilot-extension` (a Copilot CLI extension, copilot-extension/). Both speak the
   * same ear protocol; the daemon treats them alike. Other targets are reserved.
   */
  target: EarTarget;
  channels: Record<string, ChannelConfig>;
  /** Whether DMs from principals and peer agents route to this ear. */
  dms: boolean;
  /** Delivery mode for DMs routed to this ear (`mentions` wakes on every DM). */
  dmMode: "mentions" | "silent";
  /** Ask Claude to ack a nonce on attach, proving the channel is registered. */
  attachCanary: boolean;
  /** Operator-authored text appended to the channel instructions. */
  instructions: string;
}

export interface Config {
  botUserId: string;
  principals: string[];
  peerAgents: string[];
  /** Optional human labels for author IDs, shown in instructions and headers. */
  labels: Record<string, string>;
  mentionPatterns: string[];
  /** `mentionPatterns`, compiled once at load. */
  mentionMatchers: RegExp[];
  ears: Record<string, EarConfig>;
  /** The single ear that owns DMs, if any. */
  dmEar: string | undefined;
  defaults: {
    quietWindowMs: number;
    maxDelayMs: number;
    priorityQuietMs: number;
    historyLimit: number;
  };
  botLoop: WakeBudget;
  /** Per-chat budget for wakes caused by ambient (non-principal, non-peer) humans. */
  ambientWake: WakeBudget;
  limits: {
    maxMessageChars: number;
    maxNotificationChars: number;
    /** Largest attachment `fetch_attachment` will download. */
    maxAttachmentBytes: number;
    maxPendingPerEar: number;
    retentionMs: number;
  };
  /** Kill switch: keep ingesting, stop pushing. */
  paused: boolean;
  /** Optional binary-canticle receptor (listen-only). Absent or disabled: no socket. */
  canticle?: CanticleConfig;
}

export interface CanticleConfig {
  enabled: boolean;
  /** Local fleet manifest (unsigned in v0; the ear never fetches one). */
  manifestPath: string;
  bindHost: string;
  port: number;
  /** Where frames reach this listener (RFC-0001 §4.3): narrower-scoped frames are refused. */
  binding: "host" | "lan" | "fleet" | "public";
  /** Per ear, the `station:stream` pairs it hears; `*` matches any station. */
  tune: Record<string, string[]>;
  /**
   * `embedded` (default): frond-ear runs its own listener, only where it is the host's
   * one listener (RFC-0001 §14). `host-daemon`: frond-ear binds nothing and reads
   * record v1 from the host daemon's socket (§11.1, §14.18; binary-canticle#65).
   */
  source: "embedded" | "host-daemon";
  /** The host daemon's socket (default $XDG_RUNTIME_DIR/canticle/daemon.sock). */
  hostSocket: string;
}

export interface WakeBudget {
  maxEvents: number;
  windowMs: number;
  cooldownMs: number;
}

export type EarTarget = "claude-channel" | "copilot-extension";
const TARGETS: ReadonlySet<string> = new Set([
  "claude-channel",
  "copilot-extension",
]);
const RESERVED_TARGETS = new Set(["copilot-sdk", "claude-monitor"]);
export const EAR_NAME = /^[A-Za-z0-9_-]{1,64}$/u;
export const SNOWFLAKE = /^\d{1,25}$/u;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
  return [...value] as string[];
}

function snowflakes(value: unknown, name: string): string[] {
  const values = stringArray(value, name);
  for (const item of values) {
    if (!SNOWFLAKE.test(item)) {
      throw new Error(`${name} entries must be Discord snowflake IDs`);
    }
  }
  return values;
}

function integer(
  value: unknown,
  fallback: number,
  name: string,
  minimum = 0,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

const TUNE =
  /^(\*|[a-z][a-z0-9-]{0,30}):[a-z][a-z0-9-]{0,30}(\.[a-z][a-z0-9-]{0,30}){0,3}$/u;

function parseCanticle(
  value: unknown,
  ears: Record<string, EarConfig>,
): CanticleConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isObject(value)) {
    throw new Error("canticle must be an object");
  }
  const enabled = value.enabled === true;
  if (typeof value.manifestPath !== "string" || value.manifestPath === "") {
    if (enabled && value.source !== "host-daemon") {
      throw new Error("canticle.manifestPath is required when enabled");
    }
  }
  const bindHost = value.bindHost ?? "0.0.0.0";
  if (typeof bindHost !== "string") {
    throw new Error("canticle.bindHost must be a string");
  }
  const port = integer(value.port, 9999, "canticle.port", 1);
  if (port > 65_535) {
    throw new Error("canticle.port must be at most 65535");
  }
  const binding = value.binding ?? "lan";
  if (
    binding !== "host" &&
    binding !== "lan" &&
    binding !== "fleet" &&
    binding !== "public"
  ) {
    throw new Error("canticle.binding must be host, lan, fleet or public");
  }
  const tune: Record<string, string[]> = {};
  const tuneInput = value.tune ?? {};
  if (!isObject(tuneInput)) {
    throw new Error(
      "canticle.tune must be an object of ear -> [station:stream]",
    );
  }
  for (const [ear, pairs] of Object.entries(tuneInput)) {
    if (!Object.hasOwn(ears, ear)) {
      throw new Error(`canticle.tune.${ear}: no such ear`);
    }
    const list = stringArray(pairs, `canticle.tune.${ear}`);
    for (const pair of list) {
      if (!TUNE.test(pair)) {
        throw new Error(
          `canticle.tune.${ear}: ${JSON.stringify(pair)} must be station:stream (station may be *)`,
        );
      }
    }
    tune[ear] = list;
  }
  const source = value.source ?? "embedded";
  if (source !== "embedded" && source !== "host-daemon") {
    throw new Error("canticle.source must be embedded or host-daemon");
  }
  const hostSocket =
    value.hostSocket ??
    join(
      process.env.XDG_RUNTIME_DIR ?? join(homedir(), ".cache"),
      "canticle",
      "daemon.sock",
    );
  if (typeof hostSocket !== "string" || hostSocket === "") {
    throw new Error("canticle.hostSocket must be a path");
  }
  return {
    enabled,
    manifestPath:
      typeof value.manifestPath === "string" ? value.manifestPath : "",
    bindHost,
    port,
    binding,
    tune,
    source,
    hostSocket,
  };
}

function parseChannel(value: unknown, name: string): ChannelConfig {
  const candidate = isObject(value) ? value : { mode: value };
  const mode = candidate.mode ?? "mentions";
  if (mode !== "silent" && mode !== "mentions" && mode !== "room") {
    throw new Error(`${name}.mode must be silent, mentions or room`);
  }
  const channel: ChannelConfig = { mode };
  for (const key of ["quietWindowMs", "maxDelayMs", "historyLimit"] as const) {
    if (candidate[key] !== undefined) {
      channel[key] = integer(candidate[key], 0, `${name}.${key}`);
    }
  }
  return channel;
}

export function parseConfig(candidate: unknown): Config {
  if (!isObject(candidate)) {
    throw new Error("config must be a JSON object");
  }
  if (
    typeof candidate.botUserId !== "string" ||
    !SNOWFLAKE.test(candidate.botUserId)
  ) {
    throw new Error("botUserId must be the bot's Discord user ID");
  }
  const labels: Record<string, string> = {};
  if (candidate.labels !== undefined) {
    if (!isObject(candidate.labels)) {
      throw new Error("labels must be an object of id -> label");
    }
    for (const [id, label] of Object.entries(candidate.labels)) {
      if (typeof label !== "string") {
        throw new Error("labels values must be strings");
      }
      labels[id] = label;
    }
  }
  const mentionPatterns = stringArray(
    candidate.mentionPatterns,
    "mentionPatterns",
  );
  const mentionMatchers = mentionPatterns.map((pattern) => {
    try {
      return new RegExp(pattern, "iu");
    } catch {
      throw new Error(`invalid mention pattern: ${pattern}`);
    }
  });

  const defaultsInput = isObject(candidate.defaults) ? candidate.defaults : {};
  const defaults = {
    quietWindowMs: integer(
      defaultsInput.quietWindowMs,
      4_000,
      "defaults.quietWindowMs",
    ),
    maxDelayMs: integer(
      defaultsInput.maxDelayMs,
      30_000,
      "defaults.maxDelayMs",
    ),
    priorityQuietMs: integer(
      defaultsInput.priorityQuietMs,
      1_500,
      "defaults.priorityQuietMs",
    ),
    historyLimit: integer(
      defaultsInput.historyLimit,
      20,
      "defaults.historyLimit",
    ),
  };
  if (defaults.maxDelayMs < defaults.quietWindowMs) {
    throw new Error("defaults.maxDelayMs must be at least quietWindowMs");
  }

  if (!isObject(candidate.ears) || Object.keys(candidate.ears).length === 0) {
    throw new Error("ears must define at least one ear");
  }
  const ears: Record<string, EarConfig> = {};
  const channelOwner = new Map<string, string>();
  let dmOwner: string | undefined;
  for (const [name, value] of Object.entries(candidate.ears)) {
    if (!EAR_NAME.test(name)) {
      throw new Error(
        `ear name ${JSON.stringify(name)} must match ${EAR_NAME}`,
      );
    }
    if (!isObject(value)) {
      throw new Error(`ears.${name} must be an object`);
    }
    const target = value.target ?? "claude-channel";
    if (typeof target === "string" && RESERVED_TARGETS.has(target)) {
      throw new Error(
        `ears.${name}.target ${target} is reserved, not built yet`,
      );
    }
    if (typeof target !== "string" || !TARGETS.has(target)) {
      throw new Error(
        `ears.${name}.target must be claude-channel or copilot-extension`,
      );
    }
    const channels: Record<string, ChannelConfig> = {};
    const channelInput = value.channels ?? {};
    if (!isObject(channelInput)) {
      throw new Error(`ears.${name}.channels must be an object`);
    }
    for (const [channelId, channelValue] of Object.entries(channelInput)) {
      if (!SNOWFLAKE.test(channelId)) {
        throw new Error(`ears.${name}.channels keys must be channel IDs`);
      }
      const owner = channelOwner.get(channelId);
      if (owner) {
        throw new Error(
          `channel ${channelId} is bound to both ${owner} and ${name}`,
        );
      }
      channelOwner.set(channelId, name);
      channels[channelId] = parseChannel(
        channelValue,
        `ears.${name}.channels.${channelId}`,
      );
    }
    const dms = value.dms === true;
    if (dms) {
      if (dmOwner) {
        throw new Error(`only one ear may own DMs (${dmOwner}, ${name})`);
      }
      dmOwner = name;
    }
    if (
      value.instructions !== undefined &&
      typeof value.instructions !== "string"
    ) {
      throw new Error(`ears.${name}.instructions must be a string`);
    }
    const dmMode = value.dmMode ?? "mentions";
    if (dmMode !== "mentions" && dmMode !== "silent") {
      throw new Error(`ears.${name}.dmMode must be mentions or silent`);
    }
    ears[name] = {
      target: target as EarTarget,
      channels,
      dms,
      dmMode,
      attachCanary: value.attachCanary !== false,
      instructions: (value.instructions as string | undefined) ?? "",
    };
  }

  const budget = (
    input: unknown,
    name: string,
    fallback: WakeBudget,
  ): WakeBudget => {
    const values = isObject(input) ? input : {};
    return {
      maxEvents: integer(
        values.maxEvents,
        fallback.maxEvents,
        `${name}.maxEvents`,
        1,
      ),
      windowMs: integer(
        values.windowMs,
        fallback.windowMs,
        `${name}.windowMs`,
        1,
      ),
      cooldownMs: integer(
        values.cooldownMs,
        fallback.cooldownMs,
        `${name}.cooldownMs`,
      ),
    };
  };
  const limitsInput = isObject(candidate.limits) ? candidate.limits : {};
  return {
    botUserId: candidate.botUserId,
    principals: snowflakes(candidate.principals, "principals"),
    peerAgents: snowflakes(candidate.peerAgents, "peerAgents"),
    labels,
    mentionPatterns,
    mentionMatchers,
    ears,
    dmEar: dmOwner,
    defaults,
    botLoop: budget(candidate.botLoop, "botLoop", {
      maxEvents: 20,
      windowMs: 60_000,
      cooldownMs: 60_000,
    }),
    ambientWake: budget(candidate.ambientWake, "ambientWake", {
      maxEvents: 6,
      windowMs: 60_000,
      cooldownMs: 300_000,
    }),
    limits: {
      maxMessageChars: integer(
        limitsInput.maxMessageChars,
        4_000,
        "limits.maxMessageChars",
        1,
      ),
      maxNotificationChars: integer(
        limitsInput.maxNotificationChars,
        6_000,
        "limits.maxNotificationChars",
        500,
      ),
      maxAttachmentBytes: integer(
        limitsInput.maxAttachmentBytes,
        8 * 1024 * 1024,
        "limits.maxAttachmentBytes",
        1,
      ),
      maxPendingPerEar: integer(
        limitsInput.maxPendingPerEar,
        500,
        "limits.maxPendingPerEar",
        1,
      ),
      retentionMs: integer(
        limitsInput.retentionMs,
        14 * 24 * 60 * 60 * 1_000,
        "limits.retentionMs",
        1,
      ),
    },
    paused: candidate.paused === true,
    ...canticleField(parseCanticle(candidate.canticle, ears)),
  };
}

function canticleField(canticle: CanticleConfig | undefined): {
  canticle?: CanticleConfig;
} {
  return canticle ? { canticle } : {};
}

export function loadConfigFile(path: string): Config {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export interface RuntimeOptions {
  configPath: string;
  databasePath: string;
  /** Where `fetch_attachment` saves files, one subdirectory per ear. */
  attachmentsPath: string;
  socketPath: string;
  gatewayUrl: string;
  apiBase: string;
  dryRun: boolean;
  allowInject: boolean;
}

export function defaultSocketPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.FROND_EAR_SOCKET) {
    return env.FROND_EAR_SOCKET;
  }
  const base = env.XDG_RUNTIME_DIR
    ? join(env.XDG_RUNTIME_DIR, "frond-ear")
    : join(homedir(), ".frond-ear");
  const instance = instanceName(env);
  return join(base, instance ? `${instance}.sock` : "daemon.sock");
}

/**
 * FROND_EAR_INSTANCE names one of several daemons run by the same Unix user
 * (one per bot). It only changes defaults: socket, database and config paths.
 * Unset keeps the single-daemon paths unchanged.
 */
export function instanceName(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.FROND_EAR_INSTANCE;
  if (!value) {
    return undefined;
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value)) {
    throw new Error(
      "FROND_EAR_INSTANCE must be lowercase letters, digits, - or _",
    );
  }
  return value;
}

/**
 * The config path the daemon loads: FROND_EAR_CONFIG, else `frond-ear.json` relative to its
 * working directory (or, under FROND_EAR_INSTANCE, ~/.config/frond-ear/<instance>/). `doctor` resolves through this too,
 * so the two cannot drift.
 */
export function daemonConfigPath(env: NodeJS.ProcessEnv): string {
  if (env.FROND_EAR_CONFIG) {
    return env.FROND_EAR_CONFIG;
  }
  const instance = instanceName(env);
  if (!instance) {
    return "frond-ear.json";
  }
  const configHome = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configHome, "frond-ear", instance, "frond-ear.json");
}

export function runtimeOptions(
  env: NodeJS.ProcessEnv,
  flags: { dryRun: boolean },
): RuntimeOptions {
  const stateHome = env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const dryRun = flags.dryRun || env.FROND_EAR_DRY_RUN === "1";
  const instance = instanceName(env);
  return {
    configPath: daemonConfigPath(env),
    databasePath:
      env.FROND_EAR_DATABASE ??
      join(stateHome, "frond-ear", `${instance ?? "frond-ear"}.db`),
    attachmentsPath:
      env.FROND_EAR_ATTACHMENTS ??
      join(
        stateHome,
        "frond-ear",
        instance ? `${instance}-attachments` : "attachments",
      ),
    socketPath: defaultSocketPath(env),
    gatewayUrl: env.DISCORD_GATEWAY_URL ?? "wss://gateway.discord.gg",
    apiBase: env.DISCORD_API_BASE ?? "https://discord.com/api/v10",
    dryRun,
    allowInject: dryRun || env.FROND_EAR_ALLOW_INJECT === "1",
  };
}

/** Reads the bot token from DISCORD_BOT_TOKEN_FILE or DISCORD_BOT_TOKEN. */
export function readBotToken(env: NodeJS.ProcessEnv): string {
  const file = env.DISCORD_BOT_TOKEN_FILE;
  const token = file
    ? readFileSync(file, "utf8").trim()
    : (env.DISCORD_BOT_TOKEN ?? "").trim();
  if (!token) {
    throw new Error(
      "set DISCORD_BOT_TOKEN_FILE or DISCORD_BOT_TOKEN (or run with --dry-run)",
    );
  }
  return token;
}
