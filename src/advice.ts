// What frond-ear tells a person to run for an ear's session, per target. `doctor` prints
// it as fix lines, and the daemon appends it to the tool results of a session that has
// not confirmed delivery (#39), so the two give the same fix for the same ear.
import { join } from "node:path";

/** This checkout's CLI, as the printed commands spell it. */
export const CLI = join(import.meta.dirname, "cli.ts");
export const LAUNCH_FLAG =
  "--dangerously-load-development-channels server:frond-ear";
/**
 * Since #30 either of these confirms delivery: the canary ack, or a tool call that
 * passes a pushed batch_id in its token form (N-<token>). `status` does not say which.
 */
export const DELIVERY_PROOF =
  "ack the attach canary's nonce, or act on a pushed batch_id exactly as the <channel> element shows it (N-<token>)";

export function shellWord(value: string): string {
  return /^[\w./:@=+-]+$/u.test(value)
    ? value
    : `'${value.replace(/'/gu, `'\\''`)}'`;
}

/** What the advice reads from an ear: doctor has it from `status`, the daemon live. */
export interface AdviceEar {
  name: string;
  /** Absent from a daemon older than #36, which only had claude-channel. */
  target?: string | undefined;
  sessionId?: string | null | undefined;
}

/**
 * Per-target advice for an ear's session. The daemon treats both targets alike; only
 * the session side differs (#36).
 */
export interface TargetAdvice {
  /** How to attach a session to this ear. */
  attach: string;
  /** What to check when no `<channel>` events reach the session at all. */
  deaf: string;
}

/** `undefined` for a target this build does not know (in doctor, a mismatched daemon's). */
export function targetAdvice(
  ear: AdviceEar,
  env: NodeJS.ProcessEnv,
): TargetAdvice | undefined {
  const target = ear.target ?? "claude-channel";
  if (target === "claude-channel") {
    // Attaching may start a fresh session. A deaf session is relaunched with its history,
    // so that advice always resumes, with a placeholder when no session id is known.
    const launch = `claude${ear.sessionId ? ` --resume ${ear.sessionId}` : ""} ${LAUNCH_FLAG}`;
    const relaunch = `claude --resume ${ear.sessionId || "<session-id>"} ${LAUNCH_FLAG}`;
    const socketEnv = env.FROND_EAR_SOCKET
      ? ` -e FROND_EAR_SOCKET=${shellWord(env.FROND_EAR_SOCKET)}`
      : "";
    return {
      attach: `in the project that owns this ear: claude mcp add -s local frond-ear -e FROND_EAR_EAR=${ear.name}${socketEnv} -- ${shellWord(process.execPath)} ${shellWord(CLI)} shim; then ${launch}`,
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
