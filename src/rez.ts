import { isClaude } from "./launch.ts";

/**
 * `frond-ear rez`: bring an ear's bound Claude session back, hearing, in a named
 * tmux session. Idempotent, so a timer can run it: it does nothing while the
 * session is live, and refuses (never guesses) when something that looks like
 * the session exists but is not attached.
 */

export interface EarView {
  name: string;
  attached: boolean;
  launchedWithChannel: boolean | null;
  delivery: string;
  binding: { sessionId: string; cwd: string | null } | null;
}

export interface RezOptions {
  ear: string;
  tmuxSession: string;
  claudeBin: string;
  serverName: string;
  timeoutMs: number;
  /** Answer Claude Code's development-channel confirmation, and nothing else. */
  confirmChannelPrompt: boolean;
}

export interface RezDeps {
  ear(name: string): Promise<EarView | undefined>;
  run(command: string, args: string[]): { code: number; stdout: string };
  processes(): Array<{ pid: number; argv: string[] }>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
}

export interface RezResult {
  /** 0 live or brought back; 2 unknown ear; 3 nothing to resume; 4 refused; 5 failed. */
  code: number;
  message: string;
}

/** True when the pane shows the development-channel dialog with an accepting choice selected. */
export function channelPromptAwaitingYes(pane: string): boolean {
  if (!/development channel/iu.test(pane)) {
    return false;
  }
  const selected = pane.split("\n").find((line) => line.includes("❯"));
  return (
    selected !== undefined &&
    /\b(yes|continue|i understand|local development|accept)\b/iu.test(
      selected,
    ) &&
    !/\b(no|exit|cancel|quit)\b/iu.test(selected)
  );
}

export async function rez(
  options: RezOptions,
  deps: RezDeps,
): Promise<RezResult> {
  const { ear, tmuxSession } = options;
  const view = await deps.ear(ear);
  if (!view) {
    return { code: 2, message: `unknown ear ${ear}` };
  }
  const binding = view.binding;
  if (!binding) {
    return {
      code: 3,
      message: `ear ${ear} is not bound to a session; nothing to resume (a session claims it by attaching, or: frond-ear bind)`,
    };
  }
  if (view.attached) {
    if (view.launchedWithChannel === false) {
      return {
        code: 4,
        message: `session ${binding.sessionId} holds ear ${ear} but was launched without the channel flag; exit it, then run rez again`,
      };
    }
    return {
      code: 0,
      message: `ear ${ear} is live (session ${binding.sessionId}, delivery ${view.delivery})`,
    };
  }
  const running = deps
    .processes()
    .find(
      (process) =>
        isClaude(process.argv) && process.argv.includes(binding.sessionId),
    );
  if (running) {
    return {
      code: 4,
      message: `session ${binding.sessionId} is already running (pid ${running.pid}) but not attached to ear ${ear}; refusing to start a second copy`,
    };
  }
  if (deps.run("tmux", ["has-session", "-t", `=${tmuxSession}`]).code === 0) {
    return {
      code: 4,
      message: `tmux session ${tmuxSession} already exists but ear ${ear} is not attached; look with: tmux attach -t ${tmuxSession}`,
    };
  }
  if (!binding.cwd) {
    return {
      code: 3,
      message: `ear ${ear}'s binding has no working directory, and claude --resume needs one; set it with: frond-ear bind --ear ${ear} --session ${binding.sessionId} --cwd <dir>`,
    };
  }
  const started = deps.run("tmux", [
    "new-session",
    "-d",
    "-s",
    tmuxSession,
    "-c",
    binding.cwd,
    "--",
    options.claudeBin,
    "--resume",
    binding.sessionId,
    "--dangerously-load-development-channels",
    `server:${options.serverName}`,
  ]);
  if (started.code !== 0) {
    return {
      code: 5,
      message: `tmux could not start ${tmuxSession}: ${started.stdout.trim() || `exit ${started.code}`}`,
    };
  }
  deps.log(
    `resuming session ${binding.sessionId} in tmux session ${tmuxSession} (${binding.cwd})`,
  );
  const deadline = deps.now() + options.timeoutMs;
  let confirmed = false;
  while (deps.now() < deadline) {
    await deps.sleep(1_000);
    const current = await deps.ear(ear).catch(() => undefined);
    if (current?.attached) {
      return {
        code: 0,
        message: `ear ${ear} is back: session ${binding.sessionId} attached in tmux session ${tmuxSession}`,
      };
    }
    if (deps.run("tmux", ["has-session", "-t", `=${tmuxSession}`]).code !== 0) {
      return {
        code: 5,
        message: `claude exited before attaching; try by hand: cd ${binding.cwd} && ${options.claudeBin} --resume ${binding.sessionId} --dangerously-load-development-channels server:${options.serverName}`,
      };
    }
    if (options.confirmChannelPrompt && !confirmed) {
      const pane = deps.run("tmux", [
        "capture-pane",
        "-p",
        "-t",
        `=${tmuxSession}:`,
      ]).stdout;
      if (channelPromptAwaitingYes(pane)) {
        confirmed = true;
        deps.run("tmux", ["send-keys", "-t", `=${tmuxSession}:`, "Enter"]);
        deps.log("confirmed the development-channel prompt");
      }
    }
  }
  return {
    code: 5,
    message: `started tmux session ${tmuxSession}, but ear ${ear} did not attach within ${Math.round(options.timeoutMs / 1_000)}s; it may be waiting at a prompt: tmux attach -t ${tmuxSession}`,
  };
}
