// A SIGTERM that reaches the daemon at any point after its control socket can
// be seen must take the shutdown path: exit 0, socket file removed, store
// closed (its -wal checkpointed away), daemon.stopped logged. Real processes;
// test/signal-seam.ts sends the signal at an exact point, so nothing races.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BOT, CHANNEL, PRINCIPAL } from "./helpers.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const SEAM = join(import.meta.dirname, "signal-seam.ts");

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  socketLeft: boolean;
  walLeft: boolean;
}

async function startAndSignal(
  at: "bind" | "probe",
  t: test.TestContext,
): Promise<Exit> {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-signals-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runDir = join(directory, "run");
  const socket = join(runDir, "daemon.sock");
  const database = join(directory, "state", "ear.db");
  const configPath = join(directory, "frond-ear.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      botUserId: BOT,
      principals: [PRINCIPAL],
      ears: {
        scribe: {
          target: "claude-channel",
          channels: { [CHANNEL]: "mentions" },
        },
      },
    }),
  );
  if (at === "probe") {
    // What a killed daemon leaves behind: a file at the socket path.
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    writeFileSync(socket, "");
  }
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("FROND_EAR_") && !key.startsWith("DISCORD_")) {
      env[key] = value;
    }
  }
  Object.assign(env, {
    XDG_STATE_HOME: join(directory, "state"),
    XDG_RUNTIME_DIR: directory,
    FROND_EAR_CONFIG: configPath,
    FROND_EAR_DATABASE: database,
    FROND_EAR_ATTACHMENTS: join(directory, "attachments"),
    FROND_EAR_SOCKET: socket,
    FROND_EAR_TEST_SIGTERM_AT: at,
  });
  const child = spawn(
    process.execPath,
    ["--import", SEAM, CLI, "daemon", "--dry-run"],
    { env, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const [code, signal] = await new Promise<
    [number | null, NodeJS.Signals | null]
  >((resolve) => child.once("close", (c, s) => resolve([c, s])));
  clearTimeout(timer);
  return {
    code,
    signal,
    stderr,
    socketLeft: existsSync(socket),
    walLeft: existsSync(`${database}-wal`),
  };
}

function assertShutdownPathRan(exit: Exit): void {
  assert.deepEqual(
    { code: exit.code, signal: exit.signal },
    { code: 0, signal: null },
    `the daemon died instead of shutting down; stderr:\n${exit.stderr}`,
  );
  assert.match(exit.stderr, /daemon\.stopped/);
  assert.equal(exit.socketLeft, false, "a stale socket was left behind");
  assert.equal(exit.walLeft, false, "the store was not closed");
}

test("SIGTERM the moment the control socket is bound takes the shutdown path", async (t) => {
  assertShutdownPathRan(await startAndSignal("bind", t));
});

test("SIGTERM while probing a leftover socket is held until startup, then shuts down", async (t) => {
  assertShutdownPathRan(await startAndSignal("probe", t));
});
