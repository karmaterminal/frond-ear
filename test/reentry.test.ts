import assert from "node:assert/strict";
import test from "node:test";

import { defaultSocketPath, runtimeOptions } from "../src/config.ts";
import {
  channelEntries,
  detectLaunch,
  entryEnables,
  isClaude,
} from "../src/launch.ts";
import type { ProcessReader } from "../src/launch.ts";
import {
  channelPromptAwaitingYes,
  rez,
  settingsPermissionMode,
} from "../src/rez.ts";
import type { EarView, RezDeps, RezOptions } from "../src/rez.ts";

// ---- launch detection -------------------------------------------------------------------

test("channel entries are read from either flag, in any of the forms the CLI accepts", () => {
  assert.deepEqual(
    channelEntries([
      "claude",
      "--resume",
      "abc",
      "--dangerously-load-development-channels",
      "server:frond-ear",
      "plugin:other@mkt",
      "--verbose",
    ]),
    ["server:frond-ear", "plugin:other@mkt"],
  );
  assert.deepEqual(
    channelEntries(["claude", "--channels=plugin:frond-ear@karmaterminal"]),
    ["plugin:frond-ear@karmaterminal"],
  );
  assert.deepEqual(channelEntries(["claude", "--resume", "abc"]), []);
  assert.equal(entryEnables("server:frond-ear", "frond-ear"), true);
  assert.equal(entryEnables("plugin:frond-ear@mkt", "frond-ear"), true);
  assert.equal(entryEnables("server:frond-ear-2", "frond-ear"), false);
  assert.equal(entryEnables("server:telegram", "frond-ear"), false);
});

function reader(
  table: Record<number, { argv: string[]; parent?: number }>,
): ProcessReader {
  return {
    argv: (pid) => table[pid]?.argv,
    parent: (pid) => table[pid]?.parent,
  };
}

test("detectLaunch walks up past shells to the Claude process and reads its flags", () => {
  const table = {
    300: { argv: ["/bin/sh", "-c", "node cli.ts shim"], parent: 200 },
    200: {
      argv: [
        "/usr/bin/node",
        "/home/u/.local/bin/claude",
        "--resume",
        "s1",
        "--dangerously-load-development-channels",
        "server:frond-ear",
      ],
      parent: 1,
    },
  };
  assert.deepEqual(detectLaunch(300, "frond-ear", reader(table)), {
    pid: 200,
    channels: true,
    resumed: "s1",
  });
  assert.deepEqual(detectLaunch(300, "other", reader(table)), {
    pid: 200,
    channels: false,
    resumed: "s1",
  });
  const noFlag = { 10: { argv: ["claude", "--resume=s2"], parent: 1 } };
  assert.deepEqual(detectLaunch(10, "frond-ear", reader(noFlag)), {
    pid: 10,
    channels: false,
    resumed: "s2",
  });
  const fresh = { 11: { argv: ["claude", "-r"], parent: 1 } };
  assert.deepEqual(detectLaunch(11, "frond-ear", reader(fresh)), {
    pid: 11,
    channels: false,
  });
  // No /proc (macOS) or no Claude ancestor: unknown, and the canary decides.
  assert.deepEqual(detectLaunch(10, "frond-ear", reader({})), {
    channels: null,
  });
  assert.deepEqual(
    detectLaunch(5, "frond-ear", reader({ 5: { argv: ["node", "test.ts"] } })),
    { channels: null },
  );
  assert.equal(isClaude(["node", "/x/claude-code/cli.js"]), false);
  assert.equal(isClaude(["/opt/claude/bin/claude"]), true);
  assert.equal(
    isClaude([
      "node",
      "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    ]),
    true,
  );
});

// ---- instances (R7) ---------------------------------------------------------------------

test("FROND_EAR_INSTANCE gives each daemon of one Unix user its own socket, database and config", () => {
  const base = {
    XDG_RUNTIME_DIR: "/run/user/1000",
    XDG_STATE_HOME: "/s",
    XDG_CONFIG_HOME: "/c",
  };
  assert.equal(defaultSocketPath(base), "/run/user/1000/frond-ear/daemon.sock");
  const single = runtimeOptions(base, { dryRun: false });
  assert.equal(single.databasePath, "/s/frond-ear/frond-ear.db");
  assert.equal(single.configPath, "frond-ear.json");

  const gloss = { ...base, FROND_EAR_INSTANCE: "gloss" };
  assert.equal(defaultSocketPath(gloss), "/run/user/1000/frond-ear/gloss.sock");
  const options = runtimeOptions(gloss, { dryRun: false });
  assert.equal(options.databasePath, "/s/frond-ear/gloss.db");
  assert.equal(options.configPath, "/c/frond-ear/gloss/frond-ear.json");
  assert.throws(() => defaultSocketPath({ FROND_EAR_INSTANCE: "../x" }));
});

// ---- rez (R5) -------------------------------------------------------------------------

const OPTIONS: RezOptions = {
  ear: "scribe",
  tmuxSession: "frond-scribe",
  claudeBin: "/usr/local/bin/claude",
  serverName: "frond-ear",
  timeoutMs: 10_000,
  confirmChannelPrompt: true,
};

function fakeDeps(
  views: Array<EarView | undefined>,
  options: {
    tmuxExists?: boolean;
    processes?: Array<{ pid: number; argv: string[] }>;
    pane?: string;
    settingsMode?: string;
  } = {},
): RezDeps & { commands: string[][]; logs: string[] } {
  let clock = 0;
  let index = 0;
  let tmux = options.tmuxExists ?? false;
  const commands: string[][] = [];
  const logs: string[] = [];
  return {
    commands,
    logs,
    ear: async () => views[Math.min(index++, views.length - 1)],
    run: (command, args) => {
      commands.push([command, ...args]);
      if (args[0] === "has-session") {
        return { code: tmux ? 0 : 1, stdout: "" };
      }
      if (args[0] === "new-session") {
        tmux = true;
      }
      if (args[0] === "capture-pane") {
        return { code: 0, stdout: options.pane ?? "" };
      }
      return { code: 0, stdout: "" };
    },
    processes: () => options.processes ?? [],
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    log: (line) => logs.push(line),
    settingsPermissionMode: () => options.settingsMode,
  };
}

const bound = (overrides: Partial<EarView> = {}): EarView => ({
  name: "scribe",
  attached: false,
  launchedWithChannel: null,
  delivery: "detached",
  binding: { sessionId: "s-123", cwd: "/home/figs/scribe" },
  ...overrides,
});

test("rez is a no-op while the bound session is live, and never starts anything", async () => {
  const deps = fakeDeps([bound({ attached: true, delivery: "confirmed" })]);
  const result = await rez(OPTIONS, deps);
  assert.equal(result.code, 0);
  assert.match(result.message, /live/u);
  assert.deepEqual(deps.commands, []);
});

test("rez refuses rather than guessing: unbound, deaf-but-attached, already running, tmux name taken, no cwd", async () => {
  assert.equal((await rez(OPTIONS, fakeDeps([undefined]))).code, 2);
  assert.equal(
    (await rez(OPTIONS, fakeDeps([bound({ binding: null })]))).code,
    3,
  );
  const deaf = await rez(
    OPTIONS,
    fakeDeps([bound({ attached: true, launchedWithChannel: false })]),
  );
  assert.equal(deaf.code, 4);
  assert.match(deaf.message, /without the channel flag/u);

  const running = fakeDeps([bound()], {
    processes: [{ pid: 77, argv: ["claude", "--resume", "s-123"] }],
  });
  const second = await rez(OPTIONS, running);
  assert.equal(second.code, 4);
  assert.match(second.message, /already running \(pid 77\)/u);
  assert.equal(
    running.commands.some((command) => command[1] === "new-session"),
    false,
  );

  const taken = fakeDeps([bound()], { tmuxExists: true });
  assert.equal((await rez(OPTIONS, taken)).code, 4);
  assert.equal(
    taken.commands.some((command) => command[1] === "new-session"),
    false,
  );

  const noCwd = await rez(
    OPTIONS,
    fakeDeps([bound({ binding: { sessionId: "s-123", cwd: null } })]),
  );
  assert.equal(noCwd.code, 3);
  assert.match(noCwd.message, /--cwd/u);
});

test("rez resumes the bound session with the channel flag in the named tmux session, and waits for it to attach", async () => {
  const deps = fakeDeps([bound(), bound(), bound({ attached: true })]);
  const result = await rez(OPTIONS, deps);
  assert.equal(result.code, 0, result.message);
  const started = deps.commands.find((command) => command[1] === "new-session");
  assert.deepEqual(started, [
    "tmux",
    "new-session",
    "-d",
    "-s",
    "frond-scribe",
    "-c",
    "/home/figs/scribe",
    "--",
    "/usr/local/bin/claude",
    "--resume",
    "s-123",
    "--dangerously-load-development-channels",
    "server:frond-ear",
  ]);
});

test("rez answers the development-channel prompt once, and only that prompt", async () => {
  const pane =
    "WARNING: Loading development channels\n  ❯ 1. I am using this for local development\n    2. Exit\n";
  const deps = fakeDeps(
    [bound(), bound(), bound(), bound({ attached: true })],
    {
      pane,
    },
  );
  assert.equal((await rez(OPTIONS, deps)).code, 0);
  const enters = deps.commands.filter((command) => command[1] === "send-keys");
  assert.equal(enters.length, 1);

  assert.equal(channelPromptAwaitingYes(pane), true);
  assert.equal(
    channelPromptAwaitingYes("Loading development channels\n ❯ 2. No, exit\n"),
    false,
  );
  assert.equal(
    channelPromptAwaitingYes(
      "Do you trust the files in this folder?\n ❯ 1. Yes, proceed\n",
    ),
    false,
    "any other dialog is left for a human",
  );

  const off = fakeDeps([bound(), bound(), bound({ attached: true })], { pane });
  await rez({ ...OPTIONS, confirmChannelPrompt: false }, off);
  assert.equal(
    off.commands.some((command) => command[1] === "send-keys"),
    false,
  );
});

test("rez reports a session that never attaches, pointing at the tmux session", async () => {
  const deps = fakeDeps([bound()]);
  const result = await rez({ ...OPTIONS, timeoutMs: 3_000 }, deps);
  assert.equal(result.code, 5);
  assert.match(result.message, /tmux attach -t frond-scribe/u);
});

test("rez re-applies the permission mode the session's settings name, since --resume drops it", async () => {
  const fromSettings = fakeDeps([bound(), bound({ attached: true })], {
    settingsMode: "bypassPermissions",
  });
  assert.equal((await rez(OPTIONS, fromSettings)).code, 0);
  const started = fromSettings.commands.find(
    (command) => command[1] === "new-session",
  );
  assert.deepEqual(started?.slice(-2), [
    "--permission-mode",
    "bypassPermissions",
  ]);
  assert.match(
    fromSettings.logs.join("\n"),
    /permission mode bypassPermissions/u,
  );

  const explicit = fakeDeps([bound(), bound({ attached: true })], {
    settingsMode: "bypassPermissions",
  });
  await rez({ ...OPTIONS, permissionMode: "acceptEdits" }, explicit);
  assert.deepEqual(
    explicit.commands
      .find((command) => command[1] === "new-session")
      ?.slice(-2),
    ["--permission-mode", "acceptEdits"],
    "an explicit --permission-mode wins over settings",
  );

  const none = fakeDeps([bound(), bound({ attached: true })]);
  await rez(OPTIONS, none);
  assert.equal(
    none.commands
      .find((command) => command[1] === "new-session")
      ?.includes("--permission-mode"),
    false,
    "no mode named anywhere: rez picks none",
  );
});

test("settingsPermissionMode layers local project, project, then user settings, and ignores junk", () => {
  const files: Record<string, string> = {
    "/w/.claude/settings.json": '{"permissions":{"defaultMode":"acceptEdits"}}',
    "/home/u/.claude/settings.json":
      '{"permissions":{"defaultMode":"bypassPermissions"}}',
  };
  const read = (path: string) => files[path];
  assert.equal(
    settingsPermissionMode("/w", "/home/u/.claude", read),
    "acceptEdits",
  );
  files["/w/.claude/settings.local.json"] =
    '{"permissions":{"defaultMode":"plan"}}';
  assert.equal(settingsPermissionMode("/w", "/home/u/.claude", read), "plan");
  assert.equal(
    settingsPermissionMode("/elsewhere", "/home/u/.claude", read),
    "bypassPermissions",
  );
  files["/x/.claude/settings.local.json"] = "{not json";
  files["/x/.claude/settings.json"] =
    '{"permissions":{"defaultMode":"--dangerously-anything"}}';
  assert.equal(
    settingsPermissionMode("/x", "/home/u/.claude", read),
    "bypassPermissions",
    "malformed files and unknown modes fall through to the next layer",
  );
  assert.equal(settingsPermissionMode("/x", "/nowhere", read), undefined);
});
