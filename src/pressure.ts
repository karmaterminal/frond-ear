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
 * printed only on crossing up into a new band; a drop to under half the last
 * reading (a compaction, or a /clear) starts the bands again.
 */
import { closeSync, openSync, readSync, fstatSync } from "node:fs";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

export const DEFAULT_BANDS = [150_000, 200_000, 300_000, 450_000, 650_000];

/** How much of the transcript's end to read for the latest usage. */
const TAIL_BYTES = 4 * 1024 * 1024;

export interface PressureState {
  /** The highest band index announced since the last reset; -1 for none. */
  band: number;
  /** The last reading, to see a compaction as a drop. */
  tokens: number;
}

/** Tokens in context at the latest assistant turn: its input (cached or not) plus its output. */
export function latestContextTokens(transcript: string): number | undefined {
  const lines = transcript.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line || !line.includes('"usage"')) {
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
    const record = row as { type?: unknown; message?: unknown };
    if (record.type !== "assistant") {
      continue;
    }
    const usage = (record.message as { usage?: unknown } | undefined)?.usage;
    if (typeof usage !== "object" || usage === null) {
      continue;
    }
    const u = usage as Record<string, unknown>;
    const n = (key: string) =>
      typeof u[key] === "number" && Number.isFinite(u[key]) ? u[key] : 0;
    const total =
      n("input_tokens") +
      n("cache_read_input_tokens") +
      n("cache_creation_input_tokens") +
      n("output_tokens");
    if (total > 0) {
      return total;
    }
  }
  return undefined;
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

/**
 * The band crossed by this reading, if it is a new one. Returns the next state and,
 * when a line is due, the band index it announces.
 */
export function step(
  previous: PressureState | undefined,
  tokens: number,
  bands: readonly number[],
): { state: PressureState; announce?: number } {
  let band = previous?.band ?? -1;
  if (previous && tokens < previous.tokens / 2) {
    band = -1;
  }
  let reached = -1;
  for (let i = 0; i < bands.length; i++) {
    if (tokens >= (bands[i] ?? Infinity)) {
      reached = i;
    }
  }
  if (reached > band) {
    return { state: { band: reached, tokens }, announce: reached };
  }
  return { state: { band, tokens } };
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
      return { band: parsed.band, tokens: parsed.tokens };
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
  };
}

export interface PressureIo {
  stdin?: string;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  env: NodeJS.ProcessEnv;
}

/**
 * `frond-ear pressure`. Under --hook (PostToolUse or UserPromptSubmit), reads the
 * hook's JSON on stdin and prints Claude Code's added-context JSON only on crossing
 * into a new band; anything it can't read prints nothing, and it always exits 0, so
 * a gauge never blocks a tool call or a turn. Without --hook, prints the reading
 * of --transcript <path> for a person to check.
 */
export function runPressure(argv: string[], io: PressureIo): number {
  let values: { hook?: boolean; bands?: string; transcript?: string };
  try {
    values = parseArgs({
      args: argv,
      options: {
        hook: { type: "boolean" },
        bands: { type: "string" },
        transcript: { type: "string" },
      },
    }).values;
  } catch (error) {
    // A hook line with a bad flag must still never block: exit 2 from a
    // UserPromptSubmit hook would refuse the prompt.
    if (argv.some((arg) => arg === "--hook" || arg.startsWith("--hook="))) {
      return 0;
    }
    io.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
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
    return 2;
  }
  if (!values.hook) {
    if (!values.transcript) {
      io.stderr.write(
        "usage: frond-ear pressure --transcript <path> [--bands 150k,200k,…]\n",
      );
      return 2;
    }
    const tokens = latestContextTokens(readTail(values.transcript));
    if (tokens === undefined) {
      io.stdout.write("no assistant turn with usage in that transcript\n");
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
    const tokens = latestContextTokens(readTail(input.transcriptPath));
    if (tokens === undefined) {
      return 0;
    }
    const dir = stateDir(io.env);
    const { state, announce } = step(
      loadState(dir, input.sessionId),
      tokens,
      bands,
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
