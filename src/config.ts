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
    /**
     * Messages read back per chat when a Gateway session could not be resumed (one REST page,
     * so at most 100); 0 turns the read-back off.
     */
    catchUpMessages: number;
    /** Chats read back then, the most recently active first. */
    catchUpChats: number;
  };
  /** Kill switch: keep ingesting, stop pushing. */
  paused: boolean;
  /** Optional binary-canticle receptor. Absent or disabled: no socket, nothing heard or pushed. */
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
  /**
   * Station key ids (16 hex digits) whose records may be pushed to a session at all
   * (frond-ear#65, 🍃's boundary). Every other station stays readable with `hear` only.
   */
  wakeKeys: string[];
  /** Global mute: no canticle push to any ear, whatever its delivery says. */
  muted: boolean;
  /** Per ear, what reaches its session unasked. An ear left out is `off`. */
  delivery: Record<string, CanticleEarDelivery>;
}

/** `off`: `hear` only. `digest`: a radio report per window. `immediate`: each new record. */
export type CanticleMode = "off" | "digest" | "immediate";

export interface CanticleEarDelivery {
  /** The ceiling for every station this ear hears; the session can only narrow it. */
  mode: CanticleMode;
  /**
   * Per-station ceilings, instead of `mode`, by station name or key id (lowercase hex).
   * A key id outlasts a manifest rename; where a station's key id and name both have an
   * entry, the narrower holds.
   */
  stations: Record<string, CanticleMode>;
  /** How often a digest report goes out, at most. */
  windowMs: number;
  /** How long immediate waits to coalesce a burst into one push. */
  debounceMs: number;
  /**
   * Immediate's freshness bound (RFC-0001 §14.10 item 9): a record heard longer ago than
   * this, or already older than this when first heard, goes into the next report instead,
   * marked late. More than `debounceMs`, and at most item 9's 120 s.
   */
  maxAgeMs: number;
  /** A report carries the records (`records`) or only counts, gaps and repeats per stream. */
  style: "records" | "counts";
  /** Records per push, at most; the rest wait for the next one. */
  maxItems: number;
  /** Records waiting per station:stream, at most; the oldest go first. */
  bufferPerStream: number;
  /**
   * Pushes per rolling hour, at most; past it, records wait. By default 60, or one per
   * window when `windowMs` is under a minute (at most 360), so a busy band's reports fit.
   */
  maxPushesPerHour: number;
}

/** RFC-0001 §14.10: wakes are coalesced over at least 5 s. */
export const CANTICLE_MIN_COALESCE_MS = 5_000;

/** The most pushes an ear may get in an hour, from `immediate` and reports together. */
const CANTICLE_MAX_PUSHES_PER_HOUR = 360;

/** Whether this ear has any canticle delivery other than `off` in its config. */
export function canticleDelivers(
  canticle: CanticleConfig | undefined,
  ear: string,
): boolean {
  const delivery =
    canticle?.enabled && Object.hasOwn(canticle.delivery, ear)
      ? canticle.delivery[ear]
      : undefined;
  return (
    delivery !== undefined &&
    (delivery.mode !== "off" ||
      Object.values(delivery.stations).some((mode) => mode !== "off"))
  );
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
  const wakeKeys = [
    ...new Set(
      stringArray(value.wakeKeys, "canticle.wakeKeys").map((key) => {
        if (!KEY_ID.test(key)) {
          throw new Error(
            `canticle.wakeKeys: ${JSON.stringify(key)} must be a station key id (16 hex digits)`,
          );
        }
        return key.toLowerCase();
      }),
    ),
  ];
  if (value.muted !== undefined && typeof value.muted !== "boolean") {
    throw new Error("canticle.muted must be true or false");
  }
  const deliveryInput = value.delivery ?? {};
  if (!isObject(deliveryInput)) {
    throw new Error("canticle.delivery must be an object of ear -> delivery");
  }
  const delivery: Record<string, CanticleEarDelivery> = {};
  for (const [ear, input] of Object.entries(deliveryInput)) {
    if (!Object.hasOwn(ears, ear)) {
      throw new Error(`canticle.delivery.${ear}: no such ear`);
    }
    delivery[ear] = parseDelivery(input, `canticle.delivery.${ear}`);
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
    wakeKeys,
    muted: value.muted === true,
    delivery,
  };
}

/** A station key id: SHA-256(public key)[0:8] in hex, the `key=` of a banner (§5.1). */
export const CANTICLE_KEY_ID = /^[0-9a-f]{16}$/iu;
const KEY_ID = CANTICLE_KEY_ID;
/** A station name a tune can name on its own (the station half of `TUNE`). */
export const CANTICLE_STATION = /^[a-z][a-z0-9-]{0,30}$/u;

function canticleMode(value: unknown, name: string): CanticleMode {
  if (value !== "off" && value !== "digest" && value !== "immediate") {
    throw new Error(`${name} must be off, digest or immediate`);
  }
  return value;
}

/** One ear's `canticle.delivery` entry; a bare string is its `mode`. */
function parseDelivery(value: unknown, name: string): CanticleEarDelivery {
  const input = isObject(value) ? value : { mode: value };
  const stationsInput = input.stations ?? {};
  if (!isObject(stationsInput)) {
    throw new Error(`${name}.stations must be an object of station -> mode`);
  }
  const stations: Record<string, CanticleMode> = {};
  for (const [station, mode] of Object.entries(stationsInput)) {
    if (!CANTICLE_STATION.test(station) && !KEY_ID.test(station)) {
      throw new Error(
        `${name}.stations: ${JSON.stringify(station)} must be a station name (lowercase letters, digits and -) or key id (16 hex digits)`,
      );
    }
    const scope = KEY_ID.test(station) ? station.toLowerCase() : station;
    if (Object.hasOwn(stations, scope)) {
      throw new Error(
        `${name}.stations: ${JSON.stringify(scope)} appears twice (key ids ignore case)`,
      );
    }
    stations[scope] = canticleMode(mode, `${name}.stations.${station}`);
  }
  const style = input.style ?? "records";
  if (style !== "records" && style !== "counts") {
    throw new Error(`${name}.style must be records or counts`);
  }
  const bounded = (key: string, fallback: number, min: number, max: number) => {
    const number = integer(input[key], fallback, `${name}.${key}`, min);
    if (number > max) {
      throw new Error(`${name}.${key} must be at most ${max}`);
    }
    return number;
  };
  const debounceMs = bounded(
    "debounceMs",
    CANTICLE_MIN_COALESCE_MS,
    CANTICLE_MIN_COALESCE_MS,
    60_000,
  );
  // At most RFC-0001 §14.10 item 9's bound on age at first hearing (stale_after[alarm]).
  const maxAgeMs = bounded("maxAgeMs", 30_000, 10_000, 120_000);
  if (maxAgeMs <= debounceMs) {
    throw new Error(
      `${name}.maxAgeMs must be more than debounceMs: a burst's first record waits debounceMs, so it would be too old for immediate`,
    );
  }
  const windowMs = bounded(
    "windowMs",
    60_000,
    CANTICLE_MIN_COALESCE_MS,
    3_600_000,
  );
  return {
    mode: canticleMode(input.mode ?? "off", `${name}.mode`),
    stations,
    windowMs,
    debounceMs,
    maxAgeMs,
    style,
    // RFC-0001 §14.6.5's dose by default (5 items per turn), and at most twice it; each
    // push's size is capped by limits.maxNotificationChars as well.
    maxItems: bounded("maxItems", 5, 1, 10),
    bufferPerStream: bounded("bufferPerStream", 32, 1, 256),
    // A report per window must fit the hour on a busy band, as far as the cap allows
    // (ear_status warns when it can't).
    maxPushesPerHour: bounded(
      "maxPushesPerHour",
      Math.min(
        CANTICLE_MAX_PUSHES_PER_HOUR,
        Math.max(60, Math.ceil(3_600_000 / windowMs)),
      ),
      1,
      CANTICLE_MAX_PUSHES_PER_HOUR,
    ),
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
  // Discord returns at most 100 messages per history request, and a read-back is one request
  // per chat.
  const catchUpMessages = integer(
    limitsInput.catchUpMessages,
    50,
    "limits.catchUpMessages",
  );
  if (catchUpMessages > 100) {
    throw new Error("limits.catchUpMessages must be at most 100");
  }
  const catchUpChats = integer(
    limitsInput.catchUpChats,
    25,
    "limits.catchUpChats",
    1,
  );
  if (catchUpChats > 100) {
    throw new Error("limits.catchUpChats must be at most 100");
  }
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
      catchUpMessages,
      catchUpChats,
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
  return join(base, "daemon.sock");
}

/**
 * The config path the daemon loads: FROND_EAR_CONFIG, else `frond-ear.json` relative to its
 * working directory. No fallback to ~/.config/frond-ear. `doctor` resolves through this too,
 * so the two cannot drift.
 */
export function daemonConfigPath(env: NodeJS.ProcessEnv): string {
  return env.FROND_EAR_CONFIG ?? "frond-ear.json";
}

export function runtimeOptions(
  env: NodeJS.ProcessEnv,
  flags: { dryRun: boolean },
): RuntimeOptions {
  const stateHome = env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const dryRun = flags.dryRun || env.FROND_EAR_DRY_RUN === "1";
  return {
    configPath: daemonConfigPath(env),
    databasePath:
      env.FROND_EAR_DATABASE ?? join(stateHome, "frond-ear", "frond-ear.db"),
    attachmentsPath:
      env.FROND_EAR_ATTACHMENTS ?? join(stateHome, "frond-ear", "attachments"),
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
