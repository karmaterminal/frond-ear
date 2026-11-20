/**
 * Context pressure for a Claude Code session (figs, 11-14): a compaction lands with
 * no warning, and stock Claude Code shows its gauge (`/context`) only to whoever is
 * at the keyboard. Every hook is handed the session's transcript path, and each
 * assistant turn there records its token usage, so a hook can read the gauge
 * deterministically and say so in the session's own context.
 *
 * Bands are absolute token counts, not a share of a compaction point: one long
 * session (the gloss, 87 compactions by 11-14) was auto-compacted anywhere from
 * 200k to 970k tokens, so no fixed point exists to take a percentage of. A line is
 * printed only on crossing up into a new band. A compaction starts the bands again:
 * seen as a new compaction marker in the transcript (a `system` row with subtype
 * `compact_boundary`), or as a drop to under half the last reading (also a /clear).
 * Only usage written after the latest marker counts, so the turn that compacted is
 * never read as the size after it.
 */
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, fstatSync } from "node:fs";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { request } from "./client.ts";

export const DEFAULT_BANDS = [150_000, 200_000, 300_000, 450_000, 650_000];

/**
 * How long the hook waits on the daemon for its pressure report (#98). Best
 * effort: a slow or absent daemon costs the hook at most this, and nothing else.
 */
export const REPORT_TIMEOUT_MS = 1_000;

/** How much of the transcript's end to read for the latest usage. */
const TAIL_BYTES = 4 * 1024 * 1024;

export interface PressureState {
  /** The highest band index announced since the last reset; -1 for none. */
  band: number;
  /** The last reading, to see a compaction as a drop. */
  tokens: number;
  /**
   * The latest compaction marker seen (its uuid), null when the transcript's tail
   * held none. Absent in state written before markers were read: the first marker
   * then is only recorded, not taken as a compaction.
   */
  boundary?: string | null;
  /**
   * The highest band a Stop hook has nudged at since the last reset; absent for
   * none. Kept apart from `band`, so a nudge at the end of a turn never swallows
   * the added-context line the next prompt or tool call would print.
   */
  stopBand?: number;
}

export interface PressureReading {
  /** Tokens at the latest assistant turn after the latest marker, if any. */
  tokens?: number;
  /** The latest compaction marker's id in the tail, or null for none. */
  boundary: string | null;
  /** That marker's own time (epoch ms), when it has one (#108 F3/F4). */
  /** The newest main usage row was invalid: the size is unknown, and `at` is that row's time (#109). */
  unknown?: true;
  boundaryAt?: number;
  /**
   * When that evidence was written (epoch ms, from the row's `timestamp`): the
   * usage row's time when there is one, else the marker's. Absent when the row
   * carries no readable time.
   */
  at?: number;
}

function rowTime(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Tokens in context at the latest assistant turn: its input (cached or not) plus its output. */
export function latestContextTokens(transcript: string): number | undefined {
  return latestReading(transcript).tokens;
}

/**
 * The latest compaction marker in the transcript's tail, and the latest assistant
 * usage written after it (none yet right after a compaction). Sidechain rows (a
 * subagent's turns, `isSidechain: true`) are another context's usage and never count.
 */
export function latestReading(transcript: string): PressureReading {
  const lines = transcript.split("\n");
  let tokens: number | undefined;
  let at: number | undefined;
  // Set once the newest usage row is read: a valid one gives tokens, an invalid one
  // leaves them unknown. Either way no older row is consulted (#109: the gauge and the
  // hold agree on unknown). An all-zero synthetic row carries no reading and is passed.
  let decided = false;
  let unknown = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) {
      continue;
    }
    const marker = line.includes('"compact_boundary"');
    if (!marker && (decided || !line.includes('"usage"'))) {
      continue;
    }
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      // The tail's first line may be cut in half.
      continue;
    }
    if (typeof row !== "object" || row === null) {
      continue;
    }
    const record = row as {
      type?: unknown;
      subtype?: unknown;
      uuid?: unknown;
      timestamp?: unknown;
      message?: unknown;
      isSidechain?: unknown;
    };
    if (record.isSidechain === true) {
      continue;
    }
    if (record.type === "system" && record.subtype === "compact_boundary") {
      const id =
        typeof record.uuid === "string" && record.uuid
          ? record.uuid
          : typeof record.timestamp === "string" && record.timestamp
            ? record.timestamp
            : `sha256:${createHash("sha256").update(line).digest("hex").slice(0, 16)}`;
      const markedAt = rowTime(record.timestamp);
      const when = tokens !== undefined || unknown ? at : markedAt;
      return {
        ...(tokens !== undefined ? { tokens } : {}),
        ...(unknown ? { unknown: true as const } : {}),
        boundary: id,
        ...(markedAt !== undefined ? { boundaryAt: markedAt } : {}),
        ...(when !== undefined ? { at: when } : {}),
      };
    }
    if (decided || record.type !== "assistant") {
      continue;
    }
    const usage = (record.message as { usage?: unknown } | undefined)?.usage;
    if (usage === undefined) {
      continue;
    }
    const verdict = usageVerdict(usage);
    if (verdict.kind === "zero") {
      continue;
    }
    decided = true;
    at = rowTime(record.timestamp);
    if (verdict.kind === "ok") {
      tokens = verdict.tokens;
    } else {
      unknown = true;
    }
  }
  return {
    ...(tokens !== undefined ? { tokens } : {}),
    ...(unknown ? { unknown: true as const } : {}),
    boundary: null,
    ...(at !== undefined ? { at } : {}),
  };
}

/**
 * What a PreCompact hook knows about the context being compacted (#107): the latest
 * main-session usage row's tokens, plus the bytes written after that row (tool
 * results, prompts) that no usage row has counted yet. No tokens when the tail has a
 * compaction marker newer than any usage row, or no usage row at all: unknown.
 * Sidechain rows never supply the tokens, but their bytes count as pending, which
 * can only overstate the context.
 */
export function holdReading(transcript: string): {
  tokens?: number;
  pendingBytes: number;
} {
  const lines = transcript.split("\n");
  let pendingBytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed) {
      let row: unknown;
      try {
        row = JSON.parse(trimmed);
      } catch {
        row = undefined;
      }
      if (typeof row === "object" && row !== null) {
        const record = row as {
          type?: unknown;
          subtype?: unknown;
          message?: unknown;
          isSidechain?: unknown;
        };
        if (record.isSidechain !== true) {
          if (
            record.type === "system" &&
            record.subtype === "compact_boundary"
          ) {
            return { pendingBytes };
          }
          if (record.type === "assistant") {
            const usage = (record.message as { usage?: unknown } | undefined)
              ?.usage;
            if (usage !== undefined) {
              // The newest main usage decides: invalid is unknown, never a
              // small number, and never a fall back to an older row (#108 F1).
              // Anything but a valid total is unknown, and unknown allows: an
              // all-zero synthetic row too (unchanged from #108; 🌫 on #110).
              const tokens = strictUsageTokens(usage);
              return tokens === undefined
                ? { pendingBytes }
                : { tokens, pendingBytes };
            }
          }
        }
      }
    }
    pendingBytes += Buffer.byteLength(line) + 1;
  }
  return { pendingBytes };
}

/**
 * A usage object's context size for a blocking decision (#108 F1): input and output
 * must be whole numbers ≥ 0, the cache counters absent or the same, and the total
 * above 0. Anything else is undefined (unknown), never coerced to 0.
 */
export function strictUsageTokens(usage: unknown): number | undefined {
  const verdict = usageVerdict(usage);
  return verdict.kind === "ok" ? verdict.tokens : undefined;
}

/**
 * How a usage object reads (frond-ear#109): `invalid` (a required counter missing or
 * not a whole number ≥ 0, or a cache counter present and not one), `zero` (all
 * valid, total 0: a synthetic row, such as the one written after an API error, that
 * carries no reading), or `ok` with the total.
 */
export function usageVerdict(
  usage: unknown,
): { kind: "invalid" } | { kind: "zero" } | { kind: "ok"; tokens: number } {
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
    return { kind: "invalid" };
  }
  const u = usage as Record<string, unknown>;
  const whole = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (!whole(u.input_tokens) || !whole(u.output_tokens)) {
    return { kind: "invalid" };
  }
  let total = (u.input_tokens as number) + (u.output_tokens as number);
  for (const key of [
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ]) {
    if (u[key] === undefined) {
      continue;
    }
    if (!whole(u[key])) {
      return { kind: "invalid" };
    }
    total += u[key] as number;
  }
  return total > 0 ? { kind: "ok", tokens: total } : { kind: "zero" };
}

/**
 * Pending bytes as tokens, rounded up at 3 bytes a token: transcript JSON runs nearer
 * 4, so this overstates, and an overstated context lets a held compaction go ahead.
 */
export function pendingTokens(pendingBytes: number): number {
  return Math.ceil(pendingBytes / 3);
}

export function readTail(path: string, maxBytes = TAIL_BYTES): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Whether the bands start again: a new compaction marker, or a drop under half. */
export function isReset(
  previous: PressureState | undefined,
  tokens: number,
  boundary?: string | null,
): boolean {
  const newMarker =
    typeof boundary === "string" &&
    previous?.boundary !== undefined &&
    previous.boundary !== boundary;
  return previous !== undefined && (newMarker || tokens < previous.tokens / 2);
}

/** The highest band index `tokens` has reached, -1 for under the first. */
export function reachedBand(tokens: number, bands: readonly number[]): number {
  let reached = -1;
  for (let i = 0; i < bands.length; i++) {
    if (tokens >= (bands[i] ?? Infinity)) {
      reached = i;
    }
  }
  return reached;
}

function keepBoundary(
  previous: PressureState | undefined,
  boundary?: string | null,
): { boundary?: string | null } {
  // A marker that slid out of the tail is still the latest one seen; null records
  // that the tail was read and held none (so the first marker is a compaction).
  const seen =
    typeof boundary === "string"
      ? boundary
      : previous?.boundary !== undefined
        ? previous.boundary
        : boundary;
  return seen !== undefined ? { boundary: seen } : {};
}

/**
 * The band crossed by this reading, if it is a new one. Returns the next state and,
 * when a line is due, the band index it announces.
 */
export function step(
  previous: PressureState | undefined,
  tokens: number,
  bands: readonly number[],
  boundary?: string | null,
): { state: PressureState; announce?: number } {
  const reset = isReset(previous, tokens, boundary);
  const band = reset ? -1 : (previous?.band ?? -1);
  const stopBand = reset ? undefined : previous?.stopBand;
  const keep = {
    ...keepBoundary(previous, boundary),
    ...(stopBand !== undefined ? { stopBand } : {}),
  };
  const reached = reachedBand(tokens, bands);
  if (reached > band) {
    return { state: { band: reached, tokens, ...keep }, announce: reached };
  }
  return { state: { band, tokens, ...keep } };
}

/**
 * The end of a turn (Claude Code's Stop hook, figs + 🌿, 11-17). Most compactions
 * land idle, about 55 minutes after the last request once the context is large,
 * so the turn that ends a stretch is the last chance to leave a letter. Nudges at
 * most once per band from the second band up (200k by default), and resets with
 * the bands on a compaction. It never advances `band`: the prompt and tool-call
 * line for a band stays owed.
 */
export function stopStep(
  previous: PressureState | undefined,
  tokens: number,
  bands: readonly number[],
  boundary?: string | null,
): { state: PressureState; nudge?: number } {
  const reset = isReset(previous, tokens, boundary);
  const band = reset ? -1 : (previous?.band ?? -1);
  const stopBand = reset ? -1 : (previous?.stopBand ?? -1);
  const from = Math.min(1, bands.length - 1);
  const reached = reachedBand(tokens, bands);
  const base = { band, tokens, ...keepBoundary(previous, boundary) };
  if (reached >= from && reached > stopBand) {
    return { state: { ...base, stopBand: reached }, nudge: reached };
  }
  return {
    state: { ...base, ...(stopBand >= 0 ? { stopBand } : {}) },
  };
}

export function formatTokens(tokens: number): string {
  return tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(2)}M`
    : `${Math.round(tokens / 1000)}k`;
}

export function pressureLine(
  tokens: number,
  band: number,
  bands: readonly number[],
): string {
  const top = band === bands.length - 1;
  return (
    `frond-ear pressure: context is ~${formatTokens(tokens)} tokens (past the ${formatTokens(bands[band] ?? 0)} band` +
    `${top ? ", the last one" : ""}). A compaction can land at any size, with no warning. ` +
    "If your threads changed since your last letter, leave one now: leave_letter(reason, body, assumed)."
  );
}

/** The Stop hook's reason: why this turn goes on for one more step. */
export function stopLine(
  tokens: number,
  band: number,
  bands: readonly number[],
): string {
  return (
    `frond-ear pressure: this turn is ending at ~${formatTokens(tokens)} tokens (past the ${formatTokens(bands[band] ?? 0)} band). ` +
    "Compactions at this size mostly land idle, about 55 minutes after the last request, with no warning. " +
    "If your threads changed since your last letter, leave one now (leave_letter: reason, body, assumed); otherwise just stop. " +
    "This nudge comes once per band."
  );
}

export function parseBands(value: string | undefined): number[] {
  if (!value) {
    return [...DEFAULT_BANDS];
  }
  const bands = value.split(",").map((part) => {
    const match = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/u.exec(part);
    if (!match) {
      throw new Error(`--bands: "${part}" is not a token count (e.g. 150k)`);
    }
    const scale =
      match[2]?.toLowerCase() === "m"
        ? 1_000_000
        : match[2]?.toLowerCase() === "k"
          ? 1000
          : 1;
    return Math.round(Number(match[1]) * scale);
  });
  for (let i = 1; i < bands.length; i++) {
    if ((bands[i] ?? 0) <= (bands[i - 1] ?? 0)) {
      throw new Error("--bands must rise");
    }
  }
  return bands;
}

export function stateDir(env: NodeJS.ProcessEnv): string {
  const stateHome = env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(stateHome, "frond-ear", "pressure");
}

function safeSessionFile(sessionId: string): string {
  return `${sessionId.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 128)}.json`;
}

export function loadState(
  dir: string,
  sessionId: string,
): PressureState | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(join(dir, safeSessionFile(sessionId)), "utf8"),
    ) as Partial<PressureState>;
    if (typeof parsed.band === "number" && typeof parsed.tokens === "number") {
      const boundary =
        typeof parsed.boundary === "string" || parsed.boundary === null
          ? { boundary: parsed.boundary }
          : {};
      const stopBand =
        typeof parsed.stopBand === "number"
          ? { stopBand: parsed.stopBand }
          : {};
      return {
        band: parsed.band,
        tokens: parsed.tokens,
        ...boundary,
        ...stopBand,
      };
    }
  } catch {
    // No state yet, or unreadable: start the bands again.
  }
  return undefined;
}

export function saveState(
  dir: string,
  sessionId: string,
  state: PressureState,
): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, safeSessionFile(sessionId));
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  renameSync(temp, file);
}

/** What the hook prints: Claude Code's JSON for added context, or nothing. */
export function hookOutput(event: string, line: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: line },
  });
}

/** The hook's stdin: the session, its transcript and the event. */
export function pressureHookInput(raw: string): {
  sessionId?: string;
  transcriptPath?: string;
  event?: string;
  stopHookActive?: boolean;
} {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }
  const input = parsed as Record<string, unknown>;
  const str = (value: unknown) =>
    typeof value === "string" && value ? value : undefined;
  const sessionId = str(input.session_id);
  const transcriptPath = str(input.transcript_path);
  const event = str(input.hook_event_name);
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(event ? { event } : {}),
    ...(input.stop_hook_active === true ? { stopHookActive: true } : {}),
  };
}

/** What the Stop hook prints to continue the turn once: Claude Code's block JSON. */
export function stopHookOutput(reason: string): string {
  return JSON.stringify({ decision: "block", reason });
}

export interface PressureIo {
  stdin?: string;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  env: NodeJS.ProcessEnv;
  /** Handed each hook reading, when an ear is named (#98). */
  onReading?: (report: PressureReport) => void;
}

/** What the hook tells the daemon (#98): one reading of one session, for one ear. */
export interface PressureReport {
  ear: string;
  sessionId: string;
  /** null: compacted, with no usage written since (a marker-only PostCompact). */
  tokens: number | null;
  /** The highest band reached, null under the first (and for no tokens). */
  band: number | null;
  boundary: string | null;
  /** The boundary marker's own time, when known: a hold ends on a newer one (#107). */
  boundaryAt?: number;
  /** When the evidence was written: the usage (or marker) row's time, else the hook's. */
  at: number;
  /** CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS, when the seat sets it. */
  idleFloor?: number;
  /** The hook event that read it (#107: only some can show the daemon's notice). */
  event?: string;
  /** The newest usage row was invalid: tokens are null because unknown, not because compacted (#109). */
  unknown?: true;
}

/** The seat's idle-compaction floor, when its environment sets one. */
export function idleFloorFrom(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS;
  if (!raw || !/^\d{1,8}$/u.test(raw.trim())) {
    return undefined;
  }
  return Number(raw.trim());
}

/**
 * Whether argv asks for hook mode, read off the raw words so it holds even when
 * the rest of the line doesn't parse. Only hook mode reads stdin.
 */
export function pressureHookRequested(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === "--hook" || arg.startsWith("--hook="));
}

/**
 * `frond-ear pressure`. Under --hook (PostToolUse or UserPromptSubmit), reads the
 * hook's JSON on stdin and prints Claude Code's added-context JSON only on crossing
 * into a new band; under --hook on Stop, prints a block decision once per band from
 * the second band up, so the ending turn takes one more step to leave a letter.
 * Anything it can't read prints nothing, and it always exits 0 (never 2), so a gauge
 * never blocks a tool call, a prompt or a turn by its exit code. Without --hook, prints the reading
 * of --transcript <path> for a person to check.
 */
export function runPressure(argv: string[], io: PressureIo): number {
  let values: {
    hook?: boolean;
    bands?: string;
    transcript?: string;
    ear?: string;
  };
  try {
    values = parseArgs({
      args: argv,
      options: {
        hook: { type: "boolean" },
        bands: { type: "string" },
        transcript: { type: "string" },
        ear: { type: "string" },
      },
    }).values;
  } catch (error) {
    // A hook line with a bad flag must still never block: exit 2 from a
    // UserPromptSubmit hook would refuse the prompt.
    if (pressureHookRequested(argv)) {
      return 0;
    }
    io.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    // 1, never 2, even without --hook: exit 2 is Claude Code's blocking code in
    // every hook event, so a misconfigured hook line must not be able to block.
    return 1;
  }
  let bands: number[];
  try {
    bands = parseBands(values.bands);
  } catch (error) {
    if (values.hook) {
      return 0;
    }
    io.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  if (!values.hook) {
    if (!values.transcript) {
      io.stderr.write(
        "usage: frond-ear pressure --transcript <path> [--bands 150k,200k,…]\n",
      );
      return 1;
    }
    const tokens = latestContextTokens(readTail(values.transcript));
    if (tokens === undefined) {
      io.stdout.write(
        "no assistant turn with usage in that transcript (since its last compaction)\n",
      );
      return 1;
    }
    const { announce } = step(undefined, tokens, bands);
    io.stdout.write(
      `~${formatTokens(tokens)} tokens in context${announce === undefined ? ", under the first band" : `, past the ${formatTokens(bands[announce] ?? 0)} band`}\n`,
    );
    return 0;
  }
  try {
    const input = pressureHookInput(io.stdin ?? "");
    if (!input.sessionId || !input.transcriptPath) {
      return 0;
    }
    const reading = latestReading(readTail(input.transcriptPath));
    const tokens = reading.tokens;
    // The report comes before every gate below: a continued Stop's final usage
    // or a marker-only PostCompact is exactly what the outside view must not miss.
    const ear = values.ear || io.env.FROND_EAR_EAR || undefined;
    if (
      ear &&
      io.onReading &&
      (tokens !== undefined || reading.boundary !== null || reading.unknown)
    ) {
      const reached = tokens !== undefined ? reachedBand(tokens, bands) : -1;
      const idleFloor = idleFloorFrom(io.env);
      io.onReading({
        ear,
        sessionId: input.sessionId,
        tokens: tokens ?? null,
        band: reached >= 0 ? reached : null,
        boundary: reading.boundary,
        ...(reading.boundaryAt !== undefined
          ? { boundaryAt: reading.boundaryAt }
          : {}),
        at: reading.at ?? Date.now(),
        ...(idleFloor !== undefined ? { idleFloor } : {}),
        ...(input.event ? { event: input.event } : {}),
        ...(reading.unknown ? { unknown: true as const } : {}),
      });
    }
    // Already continuing because of a Stop hook: never ask again, or a turn
    // could be held open forever. PostCompact only reports: the next prompt or
    // tool call sees the new marker and starts the bands again.
    if (
      (input.event === "Stop" && input.stopHookActive) ||
      input.event === "PostCompact"
    ) {
      return 0;
    }
    if (tokens === undefined) {
      // Nothing read yet, or compacted with no turn since: the next call reads it.
      return 0;
    }
    const dir = stateDir(io.env);
    if (input.event === "Stop") {
      const { state, nudge } = stopStep(
        loadState(dir, input.sessionId),
        tokens,
        bands,
        reading.boundary,
      );
      saveState(dir, input.sessionId, state);
      if (nudge !== undefined) {
        io.stdout.write(`${stopHookOutput(stopLine(tokens, nudge, bands))}\n`);
      }
      return 0;
    }
    const { state, announce } = step(
      loadState(dir, input.sessionId),
      tokens,
      bands,
      reading.boundary,
    );
    saveState(dir, input.sessionId, state);
    if (announce !== undefined) {
      io.stdout.write(
        `${hookOutput(input.event ?? "PostToolUse", pressureLine(tokens, announce, bands))}\n`,
      );
    }
  } catch {
    // A gauge that can't read says nothing rather than block the session.
  }
  return 0;
}

/**
 * `frond-ear pressure` from the command line: runPressure, then, under --hook with an
 * ear named (--ear or FROND_EAR_EAR), the reading goes to the daemon so ear_status
 * can show it (#98). Every hook run with a reading sends, so its age stays honest.
 * The send is best effort within REPORT_TIMEOUT_MS: no daemon, a refusal or a
 * timeout changes nothing the hook prints and never its exit code.
 */
export async function runPressureCommand(
  argv: string[],
  io: PressureIo,
): Promise<number> {
  let report: PressureReport | undefined;
  let printed = "";
  const code = runPressure(argv, {
    ...io,
    // Held until the daemon answers, so a notice can join the same hook output.
    stdout: { write: (text: string) => (printed += text) },
    onReading: (reading) => {
      report = reading;
    },
  });
  let notice: string | undefined;
  if (report) {
    try {
      const result = await request(
        { type: "pressure", ...report },
        io.env,
        REPORT_TIMEOUT_MS,
      );
      notice = typeof result.notice === "string" ? result.notice : undefined;
    } catch {
      // Best effort: the gauge in the session's own context is unchanged.
    }
  }
  io.stdout.write(withNotice(printed, report?.event, notice));
  return code;
}

/**
 * A daemon notice (#107) added to what the hook already prints: on PostToolUse and
 * UserPromptSubmit only, as added context, beside a band line when there is one.
 * Anything else, or output it can't read, prints unchanged.
 */
export function withNotice(
  printed: string,
  event: string | undefined,
  notice: string | undefined,
): string {
  if (!notice || (event !== "PostToolUse" && event !== "UserPromptSubmit")) {
    return printed;
  }
  if (printed.trim() === "") {
    return `${hookOutput(event, notice)}\n`;
  }
  try {
    const parsed = JSON.parse(printed) as {
      hookSpecificOutput?: {
        hookEventName?: unknown;
        additionalContext?: unknown;
      };
    };
    const line = parsed.hookSpecificOutput?.additionalContext;
    if (
      typeof line === "string" &&
      parsed.hookSpecificOutput?.hookEventName === event
    ) {
      return `${hookOutput(event, `${line}\n${notice}`)}\n`;
    }
  } catch {
    // Not the shape we print: leave it alone.
  }
  return printed;
}
