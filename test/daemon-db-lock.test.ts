// One daemon per database: a second `frond-ear daemon` pointed at a database another
// daemon already holds must refuse before it writes anything (figs's 11-26 review, F1).
// Real processes, temp dirs, dry-run, placeholder ids; nothing touches Discord.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import {
  DatabaseHeldError,
  DatabaseLinkedError,
  lockDatabase,
} from "../src/db-lock.ts";
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
  // Nothing from the host's own ear reaches these daemons: every state path a daemon
  // touches at start (its attachments sweep included) is pinned inside `directory`.
  const base: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("FROND_EAR_") && !key.startsWith("DISCORD_")) {
      base[key] = value;
    }
  }
  Object.assign(base, {
    XDG_STATE_HOME: join(directory, "state"),
    XDG_RUNTIME_DIR: directory,
    FROND_EAR_ATTACHMENTS: join(directory, "attachments"),
    FROND_EAR_DATABASE: databasePath,
    FROND_EAR_BOT_USER_ID: BOT,
  });
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
    () =>
      existsSync(setup.envB.FROND_EAR_SOCKET!)
        ? true
        : next.child.exitCode !== null
          ? (() => {
              throw new Error(
                `the next daemon exited ${next.child.exitCode}: ${next.stderr()}`,
              );
            })()
          : undefined,
    "the next daemon's socket",
  );
  // It serves (the socket appears before the daemon installs its signal handlers, so
  // its exit code on a kill this early proves nothing).
  assert.equal((await run(["status"], setup.envB)).code, 0);
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
  assert.equal((await run(["status"], setup.envB)).code, 0);
});

// 🌫's and 🕯's review of 3461655: the lock was named by the spelling of the database
// path, so a second name for the same file took a different lock. A file symlink and a
// hard link both let daemon B start on A's ledger and drop A's queued mention.

async function refusesOnAlias(
  t: TestContext,
  setup: Fixture,
  alias: string,
  refusal: RegExp,
): Promise<void> {
  const before = readLedger(setup.databasePath);
  assert.deepEqual(before.states, ["queued"]);
  const second = spawnDaemon(t, { ...setup.envB, FROND_EAR_DATABASE: alias });
  const code = await exitWithin(second, 8_000);
  const after = readLedger(setup.databasePath);
  assert.deepEqual(after.states, ["queued"], "A's queued mention was touched");
  assert.equal(after.revoked, 0);
  assert.equal(after.content, before.content, "B wrote to A's database");
  assert.doesNotMatch(second.stderr(), /ear\.routing_revoked/u);
  assert.notEqual(code, undefined, "daemon B is still running on A's database");
  assert.notEqual(code, 0);
  assert.match(second.stderr(), refusal);
  assert.doesNotMatch(second.stderr(), /daemon\.listening/u);
  assert.equal(existsSync(setup.envB.FROND_EAR_SOCKET!), false);
}

test("the database guard follows a symlink to the database file itself: B on alias.db -> ear.db refuses (🌫's two-daemon reproduction)", async (t) => {
  const setup = fixture(t);
  await startA(t, setup);
  const alias = join(setup.directory, "state", "alias.db");
  symlinkSync("ear.db", alias, "file");
  await refusesOnAlias(
    t,
    setup,
    alias,
    /another frond-ear daemon already holds the database/u,
  );
});

test("a hard-linked database (two names, one device and inode) is refused before the store opens", async (t) => {
  const setup = fixture(t);
  await startA(t, setup);
  const hard = join(setup.directory, "hard.db");
  linkSync(setup.databasePath, hard);
  const [one, two] = [statSync(setup.databasePath), statSync(hard)];
  assert.notEqual(hard, setup.databasePath, "two distinct names");
  assert.equal(one.dev, two.dev, "the same device");
  assert.equal(one.ino, two.ino, "the same inode");
  await refusesOnAlias(t, setup, hard, /has 2 hard links/u);
  assert.equal(existsSync(`${hard}.lock`), false, "B wrote no lock sidecar");
});

test("lockDatabase: every name for one database takes the one lock, and a multiply-linked one is refused", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-dblock-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const real = join(directory, "state", "ear.db");
  mkdirSync(join(directory, "state"), { mode: 0o700 });

  // Not yet created: a dangling symlink names the file SQLite would create through it.
  const early = join(directory, "early.db");
  symlinkSync(real, early, "file");
  const first = lockDatabase(early);
  t.after(() => first?.release());
  assert.equal(first?.path, `${real}.lock`);
  assert.equal(first?.database, real);
  assert.throws(() => lockDatabase(real), DatabaseHeldError);
  first?.release();

  new DatabaseSync(real).close();
  const held = lockDatabase(real);
  t.after(() => held?.release());
  const fileLink = join(directory, "file-link.db");
  symlinkSync(join("state", "ear.db"), fileLink, "file");
  const directoryLink = join(directory, "dir-link");
  symlinkSync(join(directory, "state"), directoryLink, "dir");
  for (const alias of [fileLink, join(directoryLink, "ear.db")]) {
    assert.throws(() => lockDatabase(alias), DatabaseHeldError, alias);
  }
  held?.release();

  const hard = join(directory, "hard.db");
  linkSync(real, hard);
  for (const name of [real, hard, fileLink]) {
    assert.throws(
      () => lockDatabase(name),
      (error: Error) =>
        error instanceof DatabaseLinkedError &&
        error.message.includes("has 2 hard links") &&
        error.message.includes("refusing to start, nothing was written"),
      name,
    );
  }
  assert.equal(existsSync(`${hard}.lock`), false);
});
