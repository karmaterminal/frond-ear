/**
 * `wake_on` GitHub (#111): the daemon polls one exact target with conditional requests
 * and writes one wake when its trigger is observed, then retires the watch.
 *
 * Bounded and read-only: GET only, to the configured API origin only, never following a
 * redirect (so the token never goes elsewhere), bodies capped, and only repositories the
 * ear's config allows. Every attempt counts against the ear's own request budget, a 304
 * included; a rate limit backs every watch off until GitHub says, and that backoff is
 * persisted. External text (review and comment bodies, check names) is untrusted
 * evidence: it is quoted in the wake, never part of the setter's note.
 */
import type { WakeFacts } from "./wakes.ts";

export const GITHUB_LIMITS = {
  maxBodyBytes: 1024 * 1024,
  requestTimeoutMs: 15_000,
  /** Pages one poll may read of a review or comment list (100 items each). */
  maxPages: 5,
  /** Pages of reviews a watch reads in full, every poll; a PR with more is refused. */
  maxReviewPages: 10,
  /** Consecutive retryable failures (network, 5xx) before the watch gives up. */
  maxFailures: 8,
  /** How long a watch may keep failing, rate limits included, before it gives up. */
  maxFailingMs: 24 * 60 * 60_000,
  /** Backoff ceiling for a failing watch. */
  maxBackoffMs: 60 * 60_000,
  /** A rate limit with no Retry-After or reset waits this long. */
  defaultRateWaitMs: 60_000,
  /** External text kept per quoted item. */
  maxQuoteChars: 600,
  /** Items named per wake (reviews, comments, checks). */
  maxItems: 5,
} as const;

export type GithubTargetKind = "pr" | "issue" | "run";
export type GithubTrigger = "review" | "merged" | "ci_done" | "comment";

/** Which triggers each kind of target can watch. */
export const TRIGGERS: Record<GithubTargetKind, GithubTrigger[]> = {
  pr: ["review", "merged", "ci_done", "comment"],
  issue: ["comment"],
  run: ["ci_done"],
};

export interface GithubTarget {
  repo: string;
  kind: GithubTargetKind;
  /** A PR or issue number, or a workflow run id. */
  number: number;
  on: GithubTrigger;
  /** ci_done on a PR: the exact head SHA whose checks are watched. */
  head?: string;
  /** ci_done on a run: the exact attempt watched. */
  attempt?: number;
}

export interface GithubCursor {
  /** Review or comment ids up to this one existed at registration: never a trigger. */
  baseline?: number;
  /** The list page the newest items are on. */
  page?: number;
  /** ETags by request path, for If-None-Match. */
  etags: Record<string, string>;
  /** ci_done on a PR: the PR's head when last read (it may have moved off the bound one). */
  currentHead?: string;
  /**
   * review: the submitted (non-pending) review ids seen so far. A review begun before the
   * watch has a lower id and only shows once submitted, so "highest id" can't be the
   * baseline (🍃 on #114).
   */
  seen?: number[];
  /** review: each list page's ETag and item count when last read. */
  pages?: Record<string, { etag?: string; count: number }>;
  /**
   * comment: polls list comments updated since this time (shortly before registration)
   * and count only ids above `baseline`, so no page cursor can go stale (🍃 on #114).
   */
  since?: string;
  /**
   * ci_done on a PR: what the last poll read when it found everything complete. Done is
   * that reading again on the next poll, so a second wave of checks between them holds
   * it open (🍃 on #114).
   */
  settled?: string;
}

export type GithubFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface GithubResponse {
  status: number;
  etag?: string;
  body?: unknown;
  retryAfterMs?: number;
  pollIntervalMs?: number;
  rateLimited: boolean;
  hasNext: boolean;
  /** The page Link's rel="last" names, when it names one. */
  lastPage?: number;
  /** Network failure or an unreadable body: no HTTP answer to go by. */
  error?: string;
}

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const SHA = /^[0-9a-f]{40}$/u;

/** One GET to the API origin, counted by the caller before it is made. */
export class GithubClient {
  private readonly apiBase: string;
  private readonly token: string | undefined;
  private readonly fetch: GithubFetch;
  private readonly now: () => number;

  public constructor(options: {
    apiBase: string;
    token?: string | undefined;
    fetch: GithubFetch;
    now: () => number;
  }) {
    this.apiBase = options.apiBase.replace(/\/+$/u, "");
    this.token = options.token;
    this.fetch = options.fetch;
    this.now = options.now;
  }

  /** The origin this client reads; a reload that moves it pauses the client's pass. */
  public get origin(): string {
    return this.apiBase;
  }

  public get hasToken(): boolean {
    return this.token !== undefined;
  }

  public async get(path: string, etag?: string): Promise<GithubResponse> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "frond-ear",
    };
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    if (etag) {
      headers["if-none-match"] = etag;
    }
    let response: Response;
    try {
      response = await this.fetch(`${this.apiBase}${path}`, {
        method: "GET",
        headers,
        // Never follow: a redirect could carry the token to another origin.
        redirect: "manual",
        signal: AbortSignal.timeout(GITHUB_LIMITS.requestTimeoutMs),
      });
    } catch {
      return {
        status: 0,
        rateLimited: false,
        hasNext: false,
        error: "network",
      };
    }
    const header = (name: string): string | undefined =>
      response.headers.get(name) ?? undefined;
    const retryAfter = Number(header("retry-after"));
    const reset = Number(header("x-ratelimit-reset"));
    const remaining = header("x-ratelimit-remaining");
    const pollInterval = Number(header("x-poll-interval"));
    const rateLimited =
      response.status === 429 ||
      (response.status === 403 &&
        (remaining === "0" || header("retry-after") !== undefined));
    const retryAfterMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1_000
        : rateLimited && Number.isFinite(reset) && reset > 0
          ? Math.max(0, reset * 1_000 - this.now())
          : undefined;
    const last = /<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/u.exec(
      header("link") ?? "",
    )?.[1];
    const result: GithubResponse = {
      status: response.status,
      rateLimited,
      hasNext: /<[^>]+>;\s*rel="next"/u.test(header("link") ?? ""),
      ...(last !== undefined && Number(last) > 0
        ? { lastPage: Number(last) }
        : {}),
      ...(header("etag") ? { etag: header("etag")! } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(Number.isFinite(pollInterval) && pollInterval > 0
        ? { pollIntervalMs: pollInterval * 1_000 }
        : {}),
    };
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return result;
    }
    try {
      const text = await readCapped(response, GITHUB_LIMITS.maxBodyBytes);
      return { ...result, body: JSON.parse(text) as unknown };
    } catch (error) {
      return {
        ...result,
        status: 0,
        error: error instanceof Error ? error.message : "unreadable body",
      };
    }
  }
}

async function readCapped(response: Response, cap: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      throw new Error(`response over ${cap} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Validates the wake_on tool's target arguments (the note is the caller's). */
export function parseTarget(args: Record<string, unknown>): GithubTarget {
  if (args.source !== "github") {
    throw new Error('source must be "github" (the only source wake_on has)');
  }
  const repo = typeof args.repo === "string" ? args.repo.trim() : "";
  if (!REPO.test(repo)) {
    throw new Error("repo must be owner/name");
  }
  const kind = args.target;
  if (kind !== "pr" && kind !== "issue" && kind !== "run") {
    throw new Error(
      'target must be "pr", "issue" or "run": say which the number names',
    );
  }
  const number = Number(args.number);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(
      kind === "run"
        ? "number must be the workflow run id"
        : `number must be the ${kind === "pr" ? "pull request" : "issue"} number`,
    );
  }
  const on = args.on;
  if (typeof on !== "string" || !TRIGGERS[kind].includes(on as GithubTrigger)) {
    throw new Error(
      `on must be one of ${TRIGGERS[kind].join(", ")} for target ${kind}`,
    );
  }
  const target: GithubTarget = { repo, kind, number, on: on as GithubTrigger };
  if (args.head_sha !== undefined && args.head_sha !== null) {
    if (kind !== "pr" || on !== "ci_done") {
      throw new Error("head_sha is only for target pr with on ci_done");
    }
    const head = String(args.head_sha).toLowerCase();
    if (!SHA.test(head)) {
      throw new Error("head_sha must be a full 40-character commit SHA");
    }
    target.head = head;
  }
  if (args.attempt !== undefined && args.attempt !== null) {
    if (kind !== "run") {
      throw new Error("attempt is only for target run");
    }
    const attempt = Number(args.attempt);
    if (!Number.isSafeInteger(attempt) || attempt < 1) {
      throw new Error("attempt must be a positive integer");
    }
    target.attempt = attempt;
  }
  return target;
}

/** The target as its setter reads it: exact, never shown to another session. */
export function describeTarget(target: GithubTarget): string {
  const what =
    target.kind === "run"
      ? `run ${target.number}${target.attempt !== undefined ? ` attempt ${target.attempt}` : ""}`
      : `${target.kind === "pr" ? "PR" : "issue"} #${target.number}`;
  const head = target.head ? ` at head ${target.head.slice(0, 12)}` : "";
  return `github ${target.repo} ${what} on ${target.on}${head}`;
}

function segment(value: string | number): string {
  return encodeURIComponent(String(value));
}

function repoPath(repo: string): string {
  const [owner, name] = repo.split("/");
  return `/repos/${segment(owner!)}/${segment(name!)}`;
}

export function htmlUrl(target: GithubTarget): string {
  const base = `https://github.com/${target.repo}`;
  return target.kind === "run"
    ? `${base}/actions/runs/${target.number}${target.attempt !== undefined ? `/attempts/${target.attempt}` : ""}`
    : `${base}/${target.kind === "pr" ? "pull" : "issues"}/${target.number}`;
}

/** What one poll (or the registration's first look) concluded. */
export type PollOutcome =
  | { kind: "unchanged"; cursor: GithubCursor; pollAfterMs?: number }
  | { kind: "fire"; facts: WakeFacts; cursor: GithubCursor }
  | { kind: "retry"; reason: string; rate: boolean; retryAfterMs?: number }
  | { kind: "terminal"; reason: string }
  | { kind: "deferred" };

/** The registration's answer: a cursor to start from, or the trigger already holding. */
export type Baseline =
  | { kind: "ready"; target: GithubTarget; cursor: GithubCursor }
  | {
      kind: "fire";
      target: GithubTarget;
      cursor: GithubCursor;
      facts: WakeFacts;
    }
  | { kind: "refused"; reason: string; retryAfterMs?: number; rate?: boolean };

/** Whether one more request may go now, and if not, why. */
export type Admission = "ok" | "budget" | "paused" | "rate" | "revoked";

/**
 * The daemon's gate on every single request, registration and each poll continuation
 * alike, after every await (🌫 on #114): GitHub on, the same origin, the repo still
 * allowed for the ear, no standing backoff, and one attempt from the ear's budget (every
 * attempt counts, 304s and failures included). `after` sees each answer, so a rate limit
 * or a poll interval is taken in whatever becomes of the watch.
 */
export interface Admit {
  before(): Admission;
  after(response: GithubResponse): void;
}

class Stop extends Error {
  public readonly outcome: PollOutcome;

  public constructor(outcome: PollOutcome) {
    super("stop");
    this.outcome = outcome;
  }
}

async function fetchOk(
  client: GithubClient,
  admit: Admit,
  path: string,
  etag?: string,
): Promise<GithubResponse> {
  const gate = admit.before();
  if (gate === "budget" || gate === "paused") {
    throw new Stop({ kind: "deferred" });
  }
  if (gate === "rate") {
    throw new Stop({
      kind: "retry",
      rate: true,
      reason: "GitHub asked frond-ear to wait (a rate limit)",
    });
  }
  if (gate === "revoked") {
    throw new Stop({
      kind: "terminal",
      reason:
        "the repo is no longer in this ear's github.repos (the daemon's config), so frond-ear reads it no more",
    });
  }
  const response = await client.get(path, etag);
  admit.after(response);
  if (response.status === 200 || response.status === 304) {
    return response;
  }
  throw new Stop(failure(response));
}

/** A non-200, non-304 answer: retryable, rate-limited, or the end of the watch. */
export function failure(response: GithubResponse): PollOutcome {
  if (response.rateLimited) {
    return {
      kind: "retry",
      rate: true,
      reason: `rate limited (HTTP ${response.status})`,
      ...(response.retryAfterMs !== undefined
        ? { retryAfterMs: response.retryAfterMs }
        : {}),
    };
  }
  if (response.status === 0 || response.status >= 500) {
    return {
      kind: "retry",
      rate: false,
      reason:
        response.status === 0
          ? `no answer (${response.error ?? "network"})`
          : `HTTP ${response.status}`,
    };
  }
  if (response.status >= 300 && response.status < 400) {
    return {
      kind: "terminal",
      reason: `GitHub answered HTTP ${response.status}, a redirect (a renamed or transferred repository?); frond-ear never follows one, so the token never leaves the API origin`,
    };
  }
  const why: Record<number, string> = {
    401: "the daemon's GitHub token was refused (HTTP 401)",
    403: "access forbidden (HTTP 403): the token cannot read this repository",
    404: "not found (HTTP 404): no such target, or the token cannot see it",
    410: "gone (HTTP 410)",
    422: "GitHub refused the request (HTTP 422)",
  };
  return {
    kind: "terminal",
    reason: why[response.status] ?? `HTTP ${response.status}`,
  };
}

interface ListItem {
  id: number;
  created_at?: string;
  submitted_at?: string;
  state?: string;
  html_url?: string;
  body?: string | null;
  user?: { login?: string } | null;
}

/** How far before registration a comment watch's `since` reaches (clock skew). */
const SINCE_SLACK_MS = 10 * 60_000;

/**
 * A comment watch's baseline: the highest comment id when it is set. Comments list by id,
 * so it is on the last page: page 1, then the page Link's rel="last" names. Two requests
 * however long the list.
 */
async function commentBaseline(
  client: GithubClient,
  admit: Admit,
  listPath: string,
  now: number,
): Promise<GithubCursor> {
  let highest = 0;
  const take = (response: GithubResponse): void => {
    for (const item of Array.isArray(response.body)
      ? (response.body as ListItem[])
      : []) {
      const id = itemId(item.id);
      if (id !== undefined && id > highest) {
        highest = id;
      }
    }
  };
  const first = await fetchOk(client, admit, `${listPath}?per_page=100&page=1`);
  take(first);
  if (first.lastPage !== undefined && first.lastPage > 1) {
    take(
      await fetchOk(
        client,
        admit,
        `${listPath}?per_page=100&page=${first.lastPage}`,
      ),
    );
  }
  return {
    etags: {},
    baseline: highest,
    since: new Date(now - SINCE_SLACK_MS).toISOString(),
  };
}

/**
 * Comments above the baseline among those updated since `cursor.since`. Page 1 is asked
 * with its ETag while it was not full; later pages, rare, unconditionally.
 */
async function newComments(
  client: GithubClient,
  admit: Admit,
  listPath: string,
  cursor: GithubCursor,
): Promise<{ items: ListItem[]; cursor: GithubCursor; pollAfterMs?: number }> {
  const since = cursor.since ?? new Date(0).toISOString();
  const etags: Record<string, string> = {};
  const found: ListItem[] = [];
  let pollAfterMs: number | undefined;
  for (let page = 1; page <= GITHUB_LIMITS.maxPages; page += 1) {
    const path = `${listPath}?since=${encodeURIComponent(since)}&per_page=100&page=${page}`;
    const response = await fetchOk(
      client,
      admit,
      path,
      page === 1 ? cursor.etags[path] : undefined,
    );
    pollAfterMs = response.pollIntervalMs ?? pollAfterMs;
    if (response.status === 304) {
      etags[path] = cursor.etags[path]!;
      break;
    }
    const items = Array.isArray(response.body)
      ? (response.body as ListItem[])
      : [];
    for (const item of items) {
      const id = itemId(item.id);
      if (id !== undefined && id > (cursor.baseline ?? 0)) {
        found.push(item);
      }
    }
    if (page === 1 && items.length < 100 && response.etag) {
      etags[path] = response.etag;
    }
    if (items.length < 100 || !response.hasNext) {
      break;
    }
  }
  return {
    items: found,
    cursor: { ...cursor, since, etags },
    ...(pollAfterMs !== undefined ? { pollAfterMs } : {}),
  };
}

/**
 * Submitted reviews not yet seen. Every poll walks the list from page 1, each page asked
 * with its ETag: a 304 page is unchanged, and a page that was full goes on to the next,
 * since a new review can land there. Pending reviews are never "seen", so one begun
 * before the watch fires when it is submitted. Registering only fills `seen`.
 */
async function newReviews(
  client: GithubClient,
  admit: Admit,
  listPath: string,
  cursor: GithubCursor,
  registering: boolean,
): Promise<{ items: ListItem[]; cursor: GithubCursor; pollAfterMs?: number }> {
  const seen = new Set(cursor.seen ?? []);
  const pages: Record<string, { etag?: string; count: number }> = {};
  const found: ListItem[] = [];
  let pollAfterMs: number | undefined;
  for (let page = 1; ; page += 1) {
    if (page > GITHUB_LIMITS.maxReviewPages) {
      throw new Stop({
        kind: "terminal",
        reason: `the PR has more than ${GITHUB_LIMITS.maxReviewPages * 100} reviews, more than frond-ear reads in full`,
      });
    }
    const kept = cursor.pages?.[String(page)];
    const response = await fetchOk(
      client,
      admit,
      `${listPath}?per_page=100&page=${page}`,
      kept?.etag,
    );
    pollAfterMs = response.pollIntervalMs ?? pollAfterMs;
    let count: number;
    if (response.status === 304 && kept) {
      count = kept.count;
      pages[String(page)] = kept;
    } else {
      const items = Array.isArray(response.body)
        ? (response.body as ListItem[])
        : [];
      count = items.length;
      pages[String(page)] = {
        count,
        ...(response.etag ? { etag: response.etag } : {}),
      };
      for (const item of items) {
        const id = itemId(item.id);
        if (
          id === undefined ||
          word(item.state) === "PENDING" ||
          seen.has(id)
        ) {
          continue;
        }
        seen.add(id);
        if (!registering) {
          found.push(item);
        }
      }
      if (count >= 100 && !response.hasNext) {
        break;
      }
    }
    if (count < 100) {
      break;
    }
  }
  return {
    items: found,
    cursor: { ...cursor, seen: [...seen].sort((a, b) => a - b), pages },
    ...(pollAfterMs !== undefined ? { pollAfterMs } : {}),
  };
}

interface Pull {
  state?: string;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  merged_by?: { login?: string } | null;
  html_url?: string;
  head?: { sha?: string };
  pull_request?: unknown;
}

interface CheckRuns {
  total_count?: number;
  check_runs?: Array<{
    name?: string;
    status?: string;
    conclusion?: string | null;
  }>;
}

interface RunAttempt {
  id?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  run_attempt?: number;
  head_sha?: string;
  html_url?: string;
}

// GitHub's strings reach the daemon's own fact lines only in these shapes; anything else
// reads "unknown". Free text goes in `quoted`, never here.
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/u;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

function login(user: { login?: string } | null | undefined): string {
  return typeof user?.login === "string" && LOGIN.test(user.login)
    ? user.login
    : "unknown";
}

function time(value: unknown): string {
  return typeof value === "string" && TIME.test(value) ? value : "unknown";
}

function sha(value: unknown): string {
  return typeof value === "string" && SHA.test(value) ? value : "unknown";
}

function itemId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function excerpt(text: string | null | undefined): string {
  const body = typeof text === "string" ? text : "";
  return body.length > GITHUB_LIMITS.maxQuoteChars
    ? `${body.slice(0, GITHUB_LIMITS.maxQuoteChars)}… (cut at ${GITHUB_LIMITS.maxQuoteChars} characters)`
    : body || "(empty)";
}

function word(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z_]{1,32}$/u.test(value)
    ? value
    : "unknown";
}

function stamp(now: number): string {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

async function pullRequest(
  client: GithubClient,
  admit: Admit,
  target: GithubTarget,
  cursor: GithubCursor,
): Promise<{
  pull: Pull | undefined;
  cursor: GithubCursor;
  pollAfterMs?: number;
}> {
  const path = `${repoPath(target.repo)}/pulls/${segment(target.number)}`;
  const response = await fetchOk(client, admit, path, cursor.etags[path]);
  if (response.status === 304) {
    return {
      pull: undefined,
      cursor,
      ...(response.pollIntervalMs !== undefined
        ? { pollAfterMs: response.pollIntervalMs }
        : {}),
    };
  }
  const etags = { ...cursor.etags };
  if (response.etag) {
    etags[path] = response.etag;
  }
  return {
    pull: response.body as Pull,
    cursor: { ...cursor, etags },
    ...(response.pollIntervalMs !== undefined
      ? { pollAfterMs: response.pollIntervalMs }
      : {}),
  };
}

/** Checks on one exact commit: complete only when there are some and all completed. */
interface CombinedStatus {
  state?: string;
  total_count?: number;
  statuses?: Array<{ context?: string; state?: string }>;
}

interface Checks {
  complete: boolean;
  total: number;
  runs: NonNullable<CheckRuns["check_runs"]>;
  statuses: NonNullable<CombinedStatus["statuses"]>;
  /** What was read, for the two-poll rule. */
  signature: string;
}

/**
 * Check runs and commit statuses on one exact commit. Complete only when there are some,
 * every check run has completed and no commit status is pending.
 */
async function checksOn(
  client: GithubClient,
  admit: Admit,
  target: GithubTarget,
  sha: string,
): Promise<Checks> {
  const runs: NonNullable<CheckRuns["check_runs"]> = [];
  let total = 0;
  for (let page = 1; page <= GITHUB_LIMITS.maxPages; page += 1) {
    const response = await fetchOk(
      client,
      admit,
      `${repoPath(target.repo)}/commits/${segment(sha)}/check-runs?per_page=100&page=${page}`,
    );
    const body = (response.body ?? {}) as CheckRuns;
    total = typeof body.total_count === "number" ? body.total_count : 0;
    runs.push(...(Array.isArray(body.check_runs) ? body.check_runs : []));
    if (!response.hasNext || runs.length >= total) {
      break;
    }
  }
  const combined = (
    await fetchOk(
      client,
      admit,
      `${repoPath(target.repo)}/commits/${segment(sha)}/status`,
    )
  ).body as CombinedStatus | undefined;
  // With no statuses GitHub's combined state reads "pending": only real ones count.
  const statuses = Array.isArray(combined?.statuses) ? combined.statuses : [];
  const complete =
    total + statuses.length > 0 &&
    runs.length >= total &&
    runs.every((run) => run.status === "completed") &&
    statuses.every((status) => word(status.state) !== "pending");
  const signature = [
    ...runs.map(
      (run) =>
        `run:${String(run.name ?? "")}:${word(run.status)}:${word(run.conclusion)}`,
    ),
    ...statuses.map(
      (status) =>
        `status:${String(status.context ?? "")}:${word(status.state)}`,
    ),
  ]
    .sort()
    .join("|");
  return { complete, total, runs, statuses, signature };
}

function checkFacts(
  target: GithubTarget,
  sha: string,
  checks: Checks,
  now: number,
  currentHead: string | undefined,
): WakeFacts {
  const { runs, statuses } = checks;
  const counts = new Map<string, number>();
  for (const outcome of [
    ...runs.map((run) => word(run.conclusion)),
    ...statuses.map((status) => word(status.state)),
  ]) {
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .map(([outcome, count]) => `${count} ${outcome}`)
    .join(", ");
  const what = `${runs.length} check run${runs.length === 1 ? "" : "s"}${
    statuses.length > 0
      ? ` and ${statuses.length} commit status${statuses.length === 1 ? "" : "es"}`
      : ""
  }`;
  const lines = [
    `${describeTarget(target)}: all ${what} on ${sha} completed (${summary}), the same on two polls in a row; observed ${stamp(now)}. Completed is not success: read each conclusion.`,
  ];
  if (currentHead !== undefined && currentHead !== sha) {
    lines.push(
      `the PR's head is now ${currentHead}, not ${sha}: this result is for ${sha} only, not for the current head.`,
    );
  }
  const quoted = [
    {
      label: "check runs (names as GitHub gave them)",
      text: runs
        .slice(0, 20)
        .map(
          (run) =>
            `${String(run.name ?? "unnamed").slice(0, 100)}: ${word(run.conclusion)}`,
        )
        .join("\n"),
    },
  ];
  if (statuses.length > 0) {
    quoted.push({
      label: "commit statuses (contexts as GitHub gave them)",
      text: statuses
        .slice(0, 20)
        .map(
          (status) =>
            `${String(status.context ?? "unnamed").slice(0, 100)}: ${word(status.state)}`,
        )
        .join("\n"),
    });
  }
  return { lines, url: htmlUrl(target), quoted };
}

function itemFacts(
  target: GithubTarget,
  items: ListItem[],
  now: number,
): WakeFacts {
  const noun = target.on === "review" ? "review" : "comment";
  const shown = items.slice(0, GITHUB_LIMITS.maxItems);
  const lines = [
    `${describeTarget(target)}: ${items.length} new ${noun}${items.length === 1 ? "" : "s"} since the watch was set; observed ${stamp(now)}.`,
    ...shown.map(
      (item) =>
        `${noun} ${item.id} by ${login(item.user)}${target.on === "review" ? `, state ${word(item.state)}` : ""} at ${time(item.submitted_at ?? item.created_at)}`,
    ),
  ];
  if (target.on === "review") {
    lines.push(
      "a review is not an approval: only state APPROVED is one, and it says nothing about CI.",
    );
  }
  if (items.length > shown.length) {
    lines.push(`and ${items.length - shown.length} more not shown here.`);
  }
  return {
    lines,
    // frond-ear's own URL for the first item, never one GitHub's body supplied.
    url:
      shown[0] !== undefined
        ? `${htmlUrl(target)}#${target.on === "review" ? "pullrequestreview" : "issuecomment"}-${shown[0].id}`
        : htmlUrl(target),
    quoted: shown.map((item) => ({
      label: `${noun} ${item.id} by ${login(item.user)}`,
      text: excerpt(item.body),
    })),
  };
}

function runFacts(
  target: GithubTarget,
  attempt: RunAttempt,
  now: number,
  already: boolean,
): WakeFacts {
  return {
    lines: [
      `${describeTarget(target)}: completed with conclusion ${word(attempt.conclusion)} (completed is not success); head ${sha(attempt.head_sha)}; observed ${stamp(now)}${already ? ", already complete when the watch was set" : ""}.`,
    ],
    url: htmlUrl(target),
    quoted: [
      {
        label: "workflow name (as GitHub gave it)",
        text: String(attempt.name ?? "unnamed").slice(0, 200),
      },
    ],
  };
}

function mergedFacts(
  target: GithubTarget,
  pull: Pull,
  now: number,
  already: boolean,
): WakeFacts {
  const suffix = already ? ", already so when the watch was set" : "";
  return {
    lines: pull.merged
      ? [
          `${describeTarget(target)}: merged at ${time(pull.merged_at)} by ${login(pull.merged_by)}, merge commit ${sha(pull.merge_commit_sha)}; observed ${stamp(now)}${suffix}.`,
        ]
      : [
          `${describeTarget(target)}: closed without merging; observed ${stamp(now)}${suffix}. The watch retires: it can no longer merge as watched.`,
        ],
    url: htmlUrl(target),
  };
}

/**
 * The registration's first look: exact target, baseline, and whether a state trigger
 * (merged, ci_done) already holds, which fires at once. Event triggers (review,
 * comment) only fire for what comes after.
 */
export async function baseline(
  client: GithubClient,
  admit: Admit,
  target: GithubTarget,
  now: number,
): Promise<Baseline> {
  const cursor: GithubCursor = { etags: {} };
  try {
    if (target.kind === "run") {
      const run = await fetchOk(
        client,
        admit,
        `${repoPath(target.repo)}/actions/runs/${segment(target.number)}`,
      );
      const current = (run.body as RunAttempt | undefined)?.run_attempt;
      const attempt =
        target.attempt ?? (typeof current === "number" ? current : 1);
      if (typeof current === "number" && attempt > current) {
        return {
          kind: "refused",
          reason: `run ${target.number} is on attempt ${current}; attempt ${attempt} doesn't exist yet`,
        };
      }
      const bound = { ...target, attempt };
      const state = await fetchOk(
        client,
        admit,
        `${repoPath(target.repo)}/actions/runs/${segment(target.number)}/attempts/${segment(attempt)}`,
      );
      const body = state.body as RunAttempt;
      if (body.status === "completed") {
        return {
          kind: "fire",
          target: bound,
          cursor,
          facts: runFacts(bound, body, now, true),
        };
      }
      return { kind: "ready", target: bound, cursor };
    }
    if (target.kind === "issue") {
      const issue = await fetchOk(
        client,
        admit,
        `${repoPath(target.repo)}/issues/${segment(target.number)}`,
      );
      if ((issue.body as Pull | undefined)?.pull_request !== undefined) {
        return {
          kind: "refused",
          reason: `#${target.number} in ${target.repo} is a pull request: use target "pr"`,
        };
      }
    }
    if (target.kind === "pr") {
      const read = await pullRequest(client, admit, target, cursor);
      const pull = read.pull;
      const head = pull?.head?.sha;
      if (target.on === "merged") {
        if (pull && (pull.merged || pull.state === "closed")) {
          return {
            kind: "fire",
            target,
            cursor,
            facts: mergedFacts(target, pull, now, true),
          };
        }
        return { kind: "ready", target, cursor: read.cursor };
      }
      if (target.on === "ci_done") {
        if (typeof head !== "string") {
          return {
            kind: "refused",
            reason: "GitHub gave no head SHA for that PR",
          };
        }
        if (target.head !== undefined && target.head !== head) {
          return {
            kind: "refused",
            reason: `the PR's head is ${head}, not ${target.head}: a ci_done watch binds the head it is set on`,
          };
        }
        const bound = { ...target, head };
        const checks = await checksOn(client, admit, bound, head);
        // Complete already: the first poll confirms it, as any other done.
        const watching: GithubCursor = {
          ...read.cursor,
          currentHead: head,
          ...(checks.complete ? { settled: checks.signature } : {}),
        };
        return { kind: "ready", target: bound, cursor: watching };
      }
    }
    if (target.on === "review") {
      const listed = await newReviews(
        client,
        admit,
        listPath(target),
        { etags: {} },
        true,
      );
      return { kind: "ready", target, cursor: listed.cursor };
    }
    if (target.on === "comment") {
      return {
        kind: "ready",
        target,
        cursor: await commentBaseline(client, admit, listPath(target), now),
      };
    }
    return { kind: "ready", target, cursor };
  } catch (error) {
    if (error instanceof Stop) {
      const outcome = error.outcome;
      return {
        kind: "refused",
        ...(outcome.kind === "retry" && outcome.rate
          ? {
              rate: true,
              ...(outcome.retryAfterMs !== undefined
                ? { retryAfterMs: outcome.retryAfterMs }
                : {}),
            }
          : {}),
        reason:
          outcome.kind === "deferred"
            ? "this ear's GitHub request budget for the hour is spent"
            : outcome.kind === "retry" || outcome.kind === "terminal"
              ? outcome.reason
              : "GitHub could not be read",
      };
    }
    throw error;
  }
}

function listPath(target: GithubTarget): string {
  return target.on === "review"
    ? `${repoPath(target.repo)}/pulls/${segment(target.number)}/reviews`
    : `${repoPath(target.repo)}/issues/${segment(target.number)}/comments`;
}

/** One poll of a registered watch. */
export async function poll(
  client: GithubClient,
  admit: Admit,
  target: GithubTarget,
  cursor: GithubCursor,
  now: number,
): Promise<PollOutcome> {
  try {
    if (target.kind === "run") {
      const response = await fetchOk(
        client,
        admit,
        `${repoPath(target.repo)}/actions/runs/${segment(target.number)}/attempts/${segment(target.attempt ?? 1)}`,
        cursor.etags.attempt,
      );
      if (response.status === 304) {
        return unchanged(cursor, response.pollIntervalMs);
      }
      const body = response.body as RunAttempt;
      const etags = { ...cursor.etags };
      if (response.etag) {
        etags.attempt = response.etag;
      }
      // Only the bound attempt: a rerun is another attempt, never this one finishing.
      if (
        body.status === "completed" &&
        (body.run_attempt ?? target.attempt) === target.attempt
      ) {
        return {
          kind: "fire",
          facts: runFacts(target, body, now, false),
          cursor: { ...cursor, etags },
        };
      }
      return unchanged({ ...cursor, etags }, response.pollIntervalMs);
    }
    if (target.on === "review" || target.on === "comment") {
      const listed =
        target.on === "review"
          ? await newReviews(client, admit, listPath(target), cursor, false)
          : await newComments(client, admit, listPath(target), cursor);
      const items = listed.items;
      if (items.length > 0) {
        return {
          kind: "fire",
          facts: itemFacts(target, items, now),
          cursor: listed.cursor,
        };
      }
      return unchanged(listed.cursor, listed.pollAfterMs);
    }
    const read = await pullRequest(client, admit, target, cursor);
    if (target.on === "merged") {
      if (read.pull && (read.pull.merged || read.pull.state === "closed")) {
        return {
          kind: "fire",
          facts: mergedFacts(target, read.pull, now, false),
          cursor: read.cursor,
        };
      }
      return unchanged(read.cursor, read.pollAfterMs);
    }
    // ci_done on a PR: the bound head's checks, whatever the PR's head is now.
    const head = target.head!;
    const current =
      typeof read.pull?.head?.sha === "string"
        ? read.pull.head.sha
        : (cursor.currentHead ?? head);
    const next: GithubCursor = { ...read.cursor, currentHead: current };
    const checks = await checksOn(client, admit, target, head);
    delete next.settled;
    if (checks.complete && cursor.settled === checks.signature) {
      return {
        kind: "fire",
        facts: checkFacts(target, head, checks, now, current),
        cursor: next,
      };
    }
    if (checks.complete) {
      next.settled = checks.signature;
    }
    if (current !== head) {
      return {
        kind: "fire",
        facts: {
          lines: [
            `${describeTarget(target)}: the PR's head moved to ${current} before the checks on ${head} completed (${checks.total === 0 ? "no check runs on it" : `${checks.runs.filter((run) => run.status === "completed").length} of ${checks.total} completed`}); observed ${stamp(now)}. This is not a CI result: the watch retires, set a new one on the new head if you still want it.`,
          ],
          url: htmlUrl(target),
        },
        cursor: next,
      };
    }
    return unchanged(next, read.pollAfterMs);
  } catch (error) {
    if (error instanceof Stop) {
      return error.outcome;
    }
    throw error;
  }
}

function unchanged(cursor: GithubCursor, pollAfterMs?: number): PollOutcome {
  return {
    kind: "unchanged",
    cursor,
    ...(pollAfterMs !== undefined ? { pollAfterMs } : {}),
  };
}
