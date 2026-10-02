import { join } from "node:path";

/**
 * Per-target session advice shared by `doctor` and the daemon's delivery warning, so the
 * two cannot drift (#39). The daemon treats both targets alike; only the session side
 * differs (#36).
 */

/** This package's CLI entry point. */
export const CLI = join(import.meta.dirname, "cli.ts");

/** The flag without which Claude Code never delivers channel events. */
export const LAUNCH_FLAG =
  "--dangerously-load-development-channels server:frond-ear";

/**
 * Since #30 two things confirm delivery: the canary ack, or a tool call that passes a
 * pushed batch_id in its token form (N-<token>).
 */
export const PROVE_DELIVERY =
  "ack the attach canary's nonce, or act on a pushed batch_id exactly as the <channel> element shows it (N-<token>)";

/** Why an attached session past its grace period is still unconfirmed (#30). */
export const UNCONFIRMED_DETAIL =
  "delivery unconfirmed: the session has neither acked the attach canary nor used a pushed batch_id in its token form (N-<token>). A bare id from tap or inbox marks a batch seen but proves nothing, so a session that has only used those stays unconfirmed while it may still hear";

/** Quote a word for a shell command line, only when it needs it. */
export function shellWord(value: string): string {
  return /^[\w./:@=+-]+$/u.test(value)
    ? value
    : `'${value.replace(/'/gu, `'\\''`)}'`;
}

export interface TargetAdvice {
  /** How to attach a session to this ear. */
  attach: string;
  /** What to check when no `<channel>` events reach the session at all. */
  deaf: string;
}

export interface AdviceEar {
  name: string;
  /** Absent from a daemon older than #36, which only had claude-channel. */
  target?: string | undefined;
  sessionId?: string | null;
}

/** `undefined` for a target this frond-ear does not know (reserved or newer). */
export function targetAdvice(
  ear: AdviceEar,
  env: NodeJS.ProcessEnv,
): TargetAdvice | undefined {
  const target = ear.target ?? "claude-channel";
  if (target === "claude-channel") {
    const relaunch = `claude${ear.sessionId ? ` --resume ${ear.sessionId}` : ""} ${LAUNCH_FLAG}`;
    const socketEnv = env.FROND_EAR_SOCKET
      ? ` -e FROND_EAR_SOCKET=${shellWord(env.FROND_EAR_SOCKET)}`
      : "";
    return {
      attach: `in the project that owns this ear: claude mcp add -s local frond-ear -e FROND_EAR_EAR=${ear.name}${socketEnv} -- ${shellWord(process.execPath)} ${shellWord(CLI)} shim; then ${relaunch}`,
      deaf: `Claude Code delivers channel events only to a session launched with the development-channel flag: ${relaunch}`,
    };
  }
  if (target === "copilot-extension") {
    // The installer reads the same socket env as the daemon, and copies the shim's tool
    // schemas into config.json, so an upgrade needs a reinstall.
    const socketEnv = env.FROND_EAR_SOCKET
      ? `FROND_EAR_SOCKET=${shellWord(env.FROND_EAR_SOCKET)} `
      : "";
    const install = `${socketEnv}${shellWord(process.execPath)} ${shellWord(CLI)} copilot-extension --ear ${ear.name}`;
    return {
      attach: `install the Copilot extension for this ear: ${install}; then start Copilot with extensions enabled: copilot --experimental. Re-run the install after upgrading frond-ear: it copies the tool schemas`,
      deaf: `the extension must be installed for this ear (${install}; re-run it after upgrading frond-ear) and Copilot started with copilot --experimental`,
    };
  }
  return undefined;
}

/**
 * The daemon's "delivery unconfirmed" warning, appended to tool results and reported by
 * status: #30's proofs, then the target's own advice, or a neutral note for a target
 * this frond-ear has no advice for.
 */
export function unconfirmedWarning(
  ear: AdviceEar,
  env: NodeJS.ProcessEnv,
): string {
  const advice = targetAdvice(ear, env);
  const deaf = advice
    ? `If no <channel> events arrive at all: ${advice.deaf}.`
    : `No setup advice for target ${String(ear.target)}: check that its session receives <channel> events.`;
  return `${UNCONFIRMED_DETAIL}. To confirm: ${PROVE_DELIVERY}. ${deaf} Tools still work; until then, read new messages with inbox.`;
}
