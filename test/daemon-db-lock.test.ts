// One daemon per database: a second `frond-ear daemon` pointed at a database another
// daemon already holds must refuse before it writes anything (figs's 11-26 review, F1).
// Real processes, temp dirs, dry-run, placeholder ids; nothing touches Discord.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { lockDatabase } from "../src/db-lock.ts";
import { BOT, CHANNEL, GUILD, PRINCIPAL, ROOM } from "./helpers.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

async function waitFor<T>(
  probe: () => T | undefined,
  what: string,
  ms = 10_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function run(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

interface Spawned {
  child: ChildProcess;
  stderr: () => string;
  exited: Promise<number | null>;
}

function spawnDaemon(t: TestContext, env: NodeJS.ProcessEnv): Spawned {
  const child = spawn(process.execPath, [CLI, "daemon", "--dry-run"], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("close", (code) => resolve(code)),
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await exited;
  });
  return { child, stderr: () => stderr, exited };
}

/** Resolves to the exit code, or undefined if the process is still running after `ms`. */
function exitWithin(
  spawned: Spawned,
  ms: number,
): Promise<number | null | undefined> {
  return Promise.race([
    spawned.exited,
    new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), ms),
    ),
  ]);
}

function writeConfig(path: string, channel: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      botUserId: BOT,
      principals: [PRINCIPAL],
      labels: { [PRINCIPAL]: "figs" },
      ears: {
        scribe: {
          target: "claude-channel",
          channels: { [channel]: "mentions" },
        },
      },
      defaults: { quietWindowMs: 300, maxDelayMs: 2_000, priorityQuietMs: 100 },
    }),
  );
}

interface Fixture {
  directory: string;
  databasePath: string;
  envA: NodeJS.ProcessEnv;
  /** Same database, a different socket and a config that no longer routes CHANNEL to scribe. */
  envB: NodeJS.ProcessEnv;
}

function fixture(t: TestContext): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-dblock-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "state", "ear.db");
  writeConfig(join(directory, "a.json"), CHANNEL);
  writeConfig(join(directory, "b.json"), ROOM);
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    FROND_EAR_DATABASE: databasePath,
    FROND_EAR_BOT_USER_ID: BOT,
  };
  delete base.DISCORD_BOT_TOKEN;
  delete base.DISCORD_BOT_TOKEN_FILE;
  delete base.FROND_EAR_TCP;
  return {
    directory,
    databasePath,
    envA: {
      ...base,
      FROND_EAR_CONFIG: join(directory, "a.json"),
      FROND_EAR_SOCKET: join(directory, "run-a", "daemon.sock"),
    },
    envB: {
      ...base,
      FROND_EAR_CONFIG: join(directory, "b.json"),
      FROND_EAR_SOCKET: join(directory, "run-b", "daemon.sock"),
    },
  };
}

async function startA(
  t: TestContext,
  setup: Fixture,
): Promise<{ daemon: Spawned }> {
  const daemon = spawnDaemon(t, setup.envA);
  await waitFor(
    () => (existsSync(setup.envA.FROND_EAR_SOCKET!) ? true : undefined),
    "daemon A's socket",
  );
  // A principal mention arrives while no session is attached: A holds it queued.
  const injected = await run(
    [
      "inject",
      "--chat",
      CHANNEL,
      "--guild",
      GUILD,
      "--author",
      PRINCIPAL,
      "--name",
      "figs",
      "--mention",
      "hold this for the scribe",
    ],
    setup.envA,
  );
  assert.equal(injected.stdout.trim(), "inserted");
  return { daemon };
}

function readLedger(databasePath: string): {
  states: string[];
  revoked: number;
  /** Every table's schema and rows: any write B made shows up here. */
  content: string;
} {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const states = (
      database.prepare("SELECT state FROM events ORDER BY id").all() as Array<{
        state: string;
      }>
    ).map((row) => row.state);
    const revoked =
      (
        database
          .prepare("SELECT value FROM counters WHERE name = 'routing_revoked'")
          .get() as { value: number } | undefined
      )?.value ?? 0;
    const objects = database
      .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
      .all() as Array<{ type: string; name: string; sql: string | null }>;
    const content = objects
      .map((object) => {
        const rows =
          object.type === "table"
            ? database
                .prepare(`SELECT * FROM "${object.name}" ORDER BY rowid`)
                .all()
            : [];
        return `${object.type} ${object.name} ${object.sql ?? ""}\n${JSON.stringify(rows)}`;
      })
      .join("\n");
    return { states, revoked, content };
  } finally {
    database.close();
  }
}

test("a second daemon on the same database refuses before it writes anything (F1)", async (t) => {
  const setup = fixture(t);
  await startA(t, setup);
  const before = readLedger(setup.databasePath);
  assert.deepEqual(before.states, ["queued"]);
  assert.equal(before.revoked, 0);

  // B's config no longer routes CHANNEL to scribe, and B has its own socket, so the
  // socket guard cannot stop it: only a guard keyed to the database can.
  const second = spawnDaemon(t, setup.envB);
  const code = await exitWithin(second, 8_000);

  const after = readLedger(setup.databasePath);
  assert.deepEqual(after.states, ["queued"], "A's queued mention was touched");
  assert.equal(after.revoked, 0);
  assert.equal(after.content, before.content, "B wrote to A's database");
  assert.doesNotMatch(second.stderr(), /ear\.routing_revoked/u);

  assert.notEqual(code, undefined, "daemon B is still running on A's database");
  assert.notEqual(code, 0);
  assert.match(
    second.stderr(),
    /another frond-ear daemon already holds the database/u,
  );
  assert.doesNotMatch(second.stderr(), /daemon\.listening/u);
  assert.equal(existsSync(setup.envB.FROND_EAR_SOCKET!), false);
});

test("a second daemon on the same database and socket refuses on the database, not after writing (F1 as reported)", async (t) => {
  const setup = fixture(t);
  await startA(t, setup);

  // The reported shape: B shares A's socket, so the socket guard refuses it, but only
  // after B has opened the store, reconciled routing and dropped A's queued mention.
  const second = spawnDaemon(t, {
    ...setup.envB,
    FROND_EAR_SOCKET: setup.envA.FROND_EAR_SOCKET,
  });
  const code = await exitWithin(second, 8_000);

  const after = readLedger(setup.databasePath);
  assert.deepEqual(after.states, ["queued"], "A's queued mention was touched");
  assert.equal(after.revoked, 0);
  assert.doesNotMatch(second.stderr(), /ear\.routing_revoked/u);

  assert.notEqual(code, undefined, "daemon B is still running on A's database");
  assert.notEqual(code, 0);
  assert.match(
    second.stderr(),
    /another frond-ear daemon already holds the database/u,
  );
});

test("the database guard comes before the store opens: a held lock and no database leaves no database", async (t) => {
  const setup = fixture(t);
  // This process holds the lock as a daemon would, before any database exists. A daemon
  // that opened (and so created and migrated) the store before taking the lock fails here.
  const lock = lockDatabase(setup.databasePath);
  t.after(() => lock?.release());

  const second = spawnDaemon(t, setup.envB);
  const code = await exitWithin(second, 8_000);
  for (const path of [
    setup.databasePath,
    `${setup.databasePath}-wal`,
    `${setup.databasePath}-shm`,
  ]) {
    assert.equal(existsSync(path), false, `${path} was created`);
  }
  assert.notEqual(code, undefined, "the daemon is running without the lock");
  assert.notEqual(code, 0);
  assert.match(
    second.stderr(),
    /another frond-ear daemon already holds the database/u,
  );

  // Released, the same database is free to the next daemon.
  lock?.release();
  const next = spawnDaemon(t, setup.envB);
  await waitFor(
    () => (existsSync(setup.envB.FROND_EAR_SOCKET!) ? true : undefined),
    "the next daemon's socket",
  );
  next.child.kill("SIGTERM");
  assert.equal(await next.exited, 0);
});

test("the database guard follows the real path: a symlinked state directory is the same database", async (t) => {
  const setup = fixture(t);
  await startA(t, setup);
  const alias = join(setup.directory, "alias");
  symlinkSync(join(setup.directory, "state"), alias, "dir");

  const second = spawnDaemon(t, {
    ...setup.envB,
    FROND_EAR_DATABASE: join(alias, "ear.db"),
  });
  const code = await exitWithin(second, 8_000);
  assert.deepEqual(readLedger(setup.databasePath).states, ["queued"]);
  assert.notEqual(code, undefined, "daemon B is still running on A's database");
  assert.notEqual(code, 0);
  assert.match(
    second.stderr(),
    /another frond-ear daemon already holds the database/u,
  );
});

test("the database guard is released by the OS: a SIGKILLed daemon leaves nothing that blocks a restart", async (t) => {
  const setup = fixture(t);
  const { daemon } = await startA(t, setup);
  daemon.child.kill("SIGKILL");
  await daemon.exited;

  // A different socket again: the restart must not depend on the old socket file either.
  mkdirSync(join(setup.directory, "run-b"), { recursive: true, mode: 0o700 });
  const restarted = spawnDaemon(t, setup.envB);
  await waitFor(
    () =>
      existsSync(setup.envB.FROND_EAR_SOCKET!)
        ? true
        : restarted.child.exitCode !== null
          ? (() => {
              throw new Error(
                `restart exited ${restarted.child.exitCode}: ${restarted.stderr()}`,
              );
            })()
          : undefined,
    "the restarted daemon's socket",
  );
  restarted.child.kill("SIGTERM");
  assert.equal(await restarted.exited, 0);
});
