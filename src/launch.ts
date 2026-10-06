import { readFileSync } from "node:fs";
import { basename } from "node:path";

import type { LaunchInfo } from "./protocol.ts";

/**
 * Finding out, from inside a process Claude Code spawned (the shim, or a hook),
 * whether that Claude process was launched with frond-ear's channel enabled.
 *
 * Claude Code reads the channel flags only at launch and nothing persists them,
 * so a resumed session without the flag is deaf: tools work and pushed events are
 * dropped. The attach canary proves hearing after the fact; this lets the daemon
 * say "deaf" the moment a session attaches instead of two minutes later. Linux
 * only (it reads /proc); elsewhere it answers null and the canary decides.
 */

const CHANNEL_FLAGS = new Set([
  "--dangerously-load-development-channels",
  "--channels",
]);

export interface ProcessReader {
  /** argv of a process, or undefined when it cannot be read. */
  argv(pid: number): string[] | undefined;
  parent(pid: number): number | undefined;
}

export const procReader: ProcessReader = {
  argv(pid) {
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      return raw.split("\0").filter((part) => part.length > 0);
    } catch {
      return undefined;
    }
  },
  parent(pid) {
    try {
      // The command name is parenthesised and may itself contain spaces or ")".
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(fields[1]);
      return Number.isInteger(ppid) && ppid > 1 ? ppid : undefined;
    } catch {
      return undefined;
    }
  },
};

/**
 * Whether argv looks like a Claude Code CLI process: the native `claude`
 * binary, or the npm package run by node.
 */
export function isClaude(argv: string[]): boolean {
  return argv
    .slice(0, 2)
    .some(
      (part) =>
        /^claude(?:\.exe)?$/u.test(basename(part)) ||
        /[/\\]@anthropic-ai[/\\]claude-code[/\\]/u.test(part),
    );
}

/** Every channel entry named on a command line, from either flag. */
export function channelEntries(argv: string[]): string[] {
  const entries: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    const equals = arg.indexOf("=");
    const flag = equals > 0 ? arg.slice(0, equals) : arg;
    if (!CHANNEL_FLAGS.has(flag)) {
      continue;
    }
    if (equals > 0) {
      entries.push(...arg.slice(equals + 1).split(/[\s,]+/u));
      continue;
    }
    // Variadic: values run until the next option.
    while (index + 1 < argv.length && !argv[index + 1]?.startsWith("-")) {
      index += 1;
      entries.push(...(argv[index] as string).split(/[\s,]+/u));
    }
  }
  return entries.filter((entry) => entry.length > 0);
}

/** The value of `--resume <id>` / `-r <id>` / `--resume=<id>`, if present. */
export function resumedSession(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg.startsWith("--resume=")) {
      return arg.slice("--resume=".length) || undefined;
    }
    if (
      (arg === "--resume" || arg === "-r") &&
      argv[index + 1] &&
      !argv[index + 1]?.startsWith("-")
    ) {
      return argv[index + 1];
    }
  }
  return undefined;
}

/** Whether a channel entry enables the given MCP server or a plugin of that name. */
export function entryEnables(entry: string, serverName: string): boolean {
  if (entry === `server:${serverName}`) {
    return true;
  }
  const plugin = /^plugin:([^@]+)(?:@.*)?$/u.exec(entry);
  return plugin?.[1] === serverName;
}

/**
 * Walks up from `start` (at most a few generations: Claude may sit behind a
 * shell or a version-manager shim) to the nearest Claude process.
 */
export function detectLaunch(
  start: number,
  serverName: string,
  reader: ProcessReader = procReader,
): LaunchInfo {
  let pid: number | undefined = start;
  for (let depth = 0; pid !== undefined && depth < 6; depth += 1) {
    const argv = reader.argv(pid);
    if (argv === undefined) {
      return { channels: null };
    }
    if (isClaude(argv)) {
      const resumed = resumedSession(argv);
      return {
        pid,
        channels: channelEntries(argv).some((entry) =>
          entryEnables(entry, serverName),
        ),
        ...(resumed ? { resumed } : {}),
      };
    }
    pid = reader.parent(pid);
  }
  return { channels: null };
}

/**
 * Launch detection for this process, unless FROND_EAR_LAUNCH_DETECT=off (for
 * harnesses that themselves run under a Claude session, whose flags are not
 * the ones under test).
 */
export function detectOwnLaunch(env: NodeJS.ProcessEnv): LaunchInfo {
  return env.FROND_EAR_LAUNCH_DETECT === "off"
    ? { channels: null }
    : detectLaunch(process.ppid, serverName(env));
}

/** The MCP server name frond-ear is registered under in Claude Code. */
export function serverName(env: NodeJS.ProcessEnv): string {
  return env.FROND_EAR_SERVER_NAME || "frond-ear";
}
