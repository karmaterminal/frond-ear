/**
 * Subscription quota for a Claude Code seat (figs, 2026-11-26): "if you can rig quota check to talk to
 * frond-ear … and to send you quota bands". A seat that runs out mid-run goes silent, and silence reads
 * the same as a quiet room. A seat with most of its week unused near a reset is wasting it.
 *
 * The pressure hook (opt-in: FROND_EAR_QUOTA=claude) reads the seat's usage at most once per
 * QUOTA_TTL_MS, from the same endpoint Claude Code's own usage view reads
 * (GET https://api.anthropic.com/api/oauth/usage, with the seat's OAuth access token from
 * $CLAUDE_CONFIG_DIR/.credentials.json). It says so in the session's context once per change of level.
 *
 * The token is only ever sent to api.anthropic.com. It is never printed, logged or stored. The refresh
 * token is never used: refreshing would rotate it under the live session. An expired access token reads
 * as `unknown` until Claude Code renews it.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const QUOTA_URL = "https://api.anthropic.com/api/oauth/usage";
export const QUOTA_TTL_MS = 30 * 60_000;
export const QUOTA_FETCH_TIMEOUT_MS = 2_000;
/** Percent used at which long lanes may hit the wall mid-run. */
export const NEAR_PERCENT = 85;
/** A weekly reset this close … */
export const BURN_DAYS = 2;
/** … with at most this much used: most of the week is going unspent. */
export const BURN_PERCENT = 50;

export type QuotaLevel = "ok" | "burn" | "near" | "exhausted" | "unknown";

export interface QuotaReading {
  level: QuotaLevel;
  weeklyPercent?: number;
  weeklyResetsAt?: string;
  fiveHourPercent?: number;
  /** Why the level is unknown: never the token or the response body. */
  problem?: string;
}

export interface QuotaCache {
  /** When the reading was taken (epoch ms). */
  at: number;
  reading: QuotaReading;
  /**
   * The level last said in each session's context, by session id (🌫 on #129: one config can serve
   * several sessions, and each must hear its own first warning). Bounded to MAX_SESSIONS, the most
   * recently written kept.
   */
  announced?: Record<string, QuotaLevel>;
}

/** Sessions whose last-said level is kept per Claude config. */
export const MAX_SESSIONS = 32;

const percent = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

/** The level of one usage response, read defensively: unknown shapes give `unknown`, never a throw. */
export function quotaReading(body: unknown, now: number): QuotaReading {
  if (!body || typeof body !== "object") {
    return { level: "unknown", problem: "unreadable usage response" };
  }
  const b = body as Record<string, unknown>;
  const weekly = (b.seven_day ?? undefined) as
    | Record<string, unknown>
    | undefined;
  const fiveHour = (b.five_hour ?? undefined) as
    | Record<string, unknown>
    | undefined;
  const weeklyPercent = percent(weekly?.utilization);
  const fiveHourPercent = percent(fiveHour?.utilization);
  const resets =
    typeof weekly?.resets_at === "string" ? weekly.resets_at : undefined;
  const out: QuotaReading = {
    level: "ok",
    ...(weeklyPercent !== undefined ? { weeklyPercent } : {}),
    ...(resets ? { weeklyResetsAt: resets } : {}),
    ...(fiveHourPercent !== undefined ? { fiveHourPercent } : {}),
  };
  const used = [weeklyPercent, fiveHourPercent].filter(
    (v): v is number => v !== undefined,
  );
  if (used.length === 0) {
    return { level: "unknown", problem: "no usage window in the response" };
  }
  const locked =
    typeof weekly?.locked_reason === "string" &&
    weekly.locked_reason.length > 0;
  if (locked || used.some((v) => v >= 100)) {
    out.level = "exhausted";
  } else if (used.some((v) => v >= NEAR_PERCENT)) {
    out.level = "near";
  } else if (weeklyPercent !== undefined && resets) {
    const days = (Date.parse(resets) - now) / 86_400_000;
    if (
      Number.isFinite(days) &&
      days <= BURN_DAYS &&
      weeklyPercent <= BURN_PERCENT
    ) {
      out.level = "burn";
    }
  }
  return out;
}

/** The numbers alone: what `frond-ear quota` prints, and the head of the hook's line. */
export function quotaSummary(reading: QuotaReading, now: number): string {
  const bits: string[] = [];
  if (reading.weeklyPercent !== undefined) {
    let weekly = `weekly ${reading.weeklyPercent}% used`;
    if (reading.weeklyResetsAt) {
      const days = (Date.parse(reading.weeklyResetsAt) - now) / 86_400_000;
      weekly += `, resets ${reading.weeklyResetsAt.slice(0, 16)}Z`;
      if (Number.isFinite(days)) weekly += ` (${days.toFixed(1)} d)`;
    }
    bits.push(weekly);
  }
  if (reading.fiveHourPercent !== undefined) {
    bits.push(`5-hour ${reading.fiveHourPercent}%`);
  }
  return bits.join("; ");
}

/** The line said in the session's context on a change of level. */
export function quotaLine(reading: QuotaReading, now: number): string {
  const summary = quotaSummary(reading, now);
  const what: Record<QuotaLevel, string> = {
    ok: "back to ok.",
    burn: "burn: the reset is close and most of the week is unused. Spend it on something you want.",
    near: "near a limit: a long lane may stop mid-run. Push your work and leave a letter.",
    exhausted:
      "exhausted: no turns until the reset. Push what you have and leave a letter.",
    unknown: `unknown (${reading.problem ?? "the check failed"}). It is retried every 30 min.`,
  };
  return `frond-ear quota: ${summary ? `${summary}; ` : ""}${what[reading.level]}`;
}

/**
 * Whether this reading is said now. The first reading says nothing when it is ok; after that, every
 * change of level is said once.
 */
export function quotaStep(
  cache: QuotaCache,
  sessionId = "",
): {
  cache: QuotaCache;
  announce: boolean;
} {
  const level = cache.reading.level;
  const said = cache.announced?.[sessionId];
  const announce = level !== said && !(said === undefined && level === "ok");
  const others = Object.entries(cache.announced ?? {}).filter(
    ([id]) => id !== sessionId,
  );
  const announced = Object.fromEntries([
    ...others.slice(-(MAX_SESSIONS - 1)),
    [sessionId, level],
  ]) as Record<string, QuotaLevel>;
  return { cache: { ...cache, announced }, announce };
}

export function quotaConfigDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function quotaCacheFile(env: NodeJS.ProcessEnv): string {
  const stateHome = env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const key = createHash("sha256")
    .update(quotaConfigDir(env))
    .digest("hex")
    .slice(0, 16);
  return join(stateHome, "frond-ear", "quota", `${key}.json`);
}

export function loadQuotaCache(file: string): QuotaCache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as QuotaCache;
    if (
      typeof parsed.at === "number" &&
      parsed.reading &&
      typeof parsed.reading.level === "string"
    ) {
      // A per-session map only; anything else (an older single level) starts the sessions again.
      const announced =
        parsed.announced &&
        typeof parsed.announced === "object" &&
        !Array.isArray(parsed.announced)
          ? parsed.announced
          : undefined;
      return {
        at: parsed.at,
        reading: parsed.reading,
        ...(announced ? { announced } : {}),
      };
    }
  } catch {
    // None yet, or unreadable: read again.
  }
  return undefined;
}

export function saveQuotaCache(file: string, cache: QuotaCache): void {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(cache), { mode: 0o600 });
  renameSync(temp, file);
}

export type QuotaFetch = (url: string, init: RequestInit) => Promise<Response>;

/** One usage read. Never throws: every failure is an `unknown` reading with a short reason. */
export async function readQuota(
  env: NodeJS.ProcessEnv,
  now: number,
  fetchImpl: QuotaFetch = fetch,
): Promise<QuotaReading> {
  let token: string;
  try {
    const credentials = JSON.parse(
      readFileSync(join(quotaConfigDir(env), ".credentials.json"), "utf8"),
    ) as { claudeAiOauth?: { accessToken?: unknown } };
    const value = credentials.claudeAiOauth?.accessToken;
    if (typeof value !== "string" || value === "") {
      return { level: "unknown", problem: "no OAuth access token" };
    }
    token = value;
  } catch {
    return { level: "unknown", problem: "no readable .credentials.json" };
  }
  try {
    const response = await fetchImpl(QUOTA_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "frond-ear-quota",
      },
      signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS),
    });
    if (response.status === 401) {
      return {
        level: "unknown",
        problem:
          "access token expired; Claude Code renews it on its next request",
      };
    }
    if (!response.ok) {
      return { level: "unknown", problem: `HTTP ${response.status}` };
    }
    return quotaReading(await response.json(), now);
  } catch {
    return { level: "unknown", problem: "usage request failed or timed out" };
  }
}

/**
 * The pressure hook's quota notice, if one is due: reads (at most once per QUOTA_TTL_MS), keeps
 * the cache, and returns the line to add, or undefined. Opt-in by FROND_EAR_QUOTA=claude; never
 * throws.
 */
export async function quotaNotice(
  env: NodeJS.ProcessEnv,
  now: number,
  fetchImpl: QuotaFetch = fetch,
  sessionId = "",
): Promise<string | undefined> {
  if (env.FROND_EAR_QUOTA !== "claude") return undefined;
  try {
    const file = quotaCacheFile(env);
    const kept = loadQuotaCache(file);
    const fresh = kept && now - kept.at < QUOTA_TTL_MS && now >= kept.at;
    let cache: QuotaCache;
    if (fresh) {
      cache = kept;
    } else {
      const reading = await readQuota(env, now, fetchImpl);
      // Another hook may have written while this one waited (🌫 on #129): a reading taken earlier
      // than the one now on disk never replaces it. Announcements always merge from the latest file.
      const latest = loadQuotaCache(file);
      cache =
        latest && latest.at > now
          ? latest
          : {
              at: now,
              reading,
              ...(latest?.announced ? { announced: latest.announced } : {}),
            };
    }
    const { cache: next, announce } = quotaStep(cache, sessionId);
    if (!fresh || announce) saveQuotaCache(file, next);
    return announce ? quotaLine(next.reading, now) : undefined;
  } catch {
    return undefined;
  }
}
