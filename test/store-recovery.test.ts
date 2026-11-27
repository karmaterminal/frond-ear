import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { EventStore } from "../src/store.ts";
import { probeStore, setStoreAside } from "../src/store-recovery.ts";
import { FakeClock, harness, testConfig } from "./helpers.ts";

// #115: a corrupt ledger store is set aside whole (never deleted) and a fresh one starts,
// said in ear_status. Anything that is not corruption (locked, busy, unreadable, a
// directory that can't be made) refuses as before and never moves a file.

/** 2026-11-26T14:30:05.123Z: the stamp a quarantine at this time takes. */
const AT = Date.UTC(2026, 10, 26, 14, 30, 5, 123);
const STAMP = "20261126T143005.123Z";
const ROOT = process.getuid?.() === 0;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "frond-ear-recovery-"));
}

function letter(store: EventStore, body = "owed: finish the review") {
  return store.leaveLetter({
    ear: "scribe",
    sessionId: null,
    reason: "compaction",
    body,
    bytes: body.length,
    assumed: [],
    leftAt: AT - 60_000,
    expiresAt: AT + 86_400_000,
    releasesAtLeave: 0,
  });
}

/** A real store holding one letter, closed cleanly (its WAL folded in). */
function healthyStore(path: string): void {
  const store = new EventStore(path, new FakeClock(AT - 120_000));
  letter(store);
  store.close();
}

function names(directory: string): string[] {
  return readdirSync(directory).sort();
}

function quarantined(directory: string): string[] {
  return names(directory).filter((name) => name.includes(".corrupt-"));
}

test("a garbage store file is set aside whole with its -wal and -shm, never deleted, and a fresh store starts in its place", () => {
  const directory = scratch();
  const path = join(directory, "ear.db");
  const garbage = Buffer.from("this is not a sqlite database ".repeat(300));
  const wal = Buffer.from("old wal bytes ".repeat(50));
  const shm = Buffer.from("old shm bytes ".repeat(50));
  try {
    writeFileSync(path, garbage);
    writeFileSync(`${path}-wal`, wal);
    writeFileSync(`${path}-shm`, shm);
    // #130's lock sidecar: not the store's, never moved.
    writeFileSync(`${path}.lock`, "");
    const store = new EventStore(path, new FakeClock(AT));
    try {
      const kept = `${path}.corrupt-${STAMP}`;
      assert.deepEqual(
        readFileSync(kept),
        garbage,
        "the store kept byte for byte",
      );
      assert.deepEqual(
        readFileSync(`${kept}-wal`),
        wal,
        "its WAL moved with it",
      );
      // The shm is SQLite's shared-memory WAL index, rebuilt from the WAL by any
      // reader (the read-only probe included): it moves with the store, but holds no data.
      assert.ok(existsSync(`${kept}-shm`), "its shm moved with it");
      assert.ok(existsSync(`${path}.lock`), "the .lock sidecar stays");
      assert.equal(statSync(`${path}.lock`).size, 0);
      assert.deepEqual(store.storeResets(), [
        {
          at: AT,
          keptAt: kept,
          moved: [`${kept}-wal`, `${kept}-shm`, kept],
          error: "file is not a database",
        },
      ]);
      // The fresh store works, and is a real SQLite database now.
      letter(store, "new");
      assert.deepEqual(
        store.letters("scribe").map((item) => item.body),
        ["new"],
      );
      assert.notDeepEqual(
        readFileSync(path).subarray(0, 15),
        garbage.subarray(0, 15),
      );
      assert.equal(
        readFileSync(path).subarray(0, 15).toString(),
        "SQLite format 3",
      );
    } finally {
      store.close();
    }
    // Durable: a restart on the fresh store keeps reporting the reset, and moves nothing.
    const again = new EventStore(path, new FakeClock(AT + 1_000));
    try {
      assert.equal(again.storeResets().length, 1);
      assert.deepEqual(quarantined(directory), [
        `ear.db.corrupt-${STAMP}`,
        `ear.db.corrupt-${STAMP}-shm`,
        `ear.db.corrupt-${STAMP}-wal`,
      ]);
      assert.deepEqual(
        again.letters("scribe").map((item) => item.body),
        ["new"],
      );
    } finally {
      again.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a truncated store is set aside: its owed letter is not in the live store, custody reads unknown before the reset, and the reset says so", () => {
  const directory = scratch();
  const path = join(directory, "ear.db");
  try {
    healthyStore(path);
    const whole = readFileSync(path);
    truncateSync(path, Math.floor(whole.length / 2));
    const cut = readFileSync(path);
    const store = new EventStore(path, new FakeClock(AT));
    try {
      const kept = `${path}.corrupt-${STAMP}`;
      assert.deepEqual(
        readFileSync(kept),
        cut,
        "the truncated file kept as it was",
      );
      assert.deepEqual(
        store.letters("scribe"),
        [],
        "the old letter is not here",
      );
      const [reset] = store.storeResets();
      assert.equal(reset?.keptAt, kept);
      assert.match(reset?.error ?? "", /malformed/);
      // A fresh store usually reads "nothing was ever exposed": not after a reset.
      assert.equal(store.canticleCustodySince(), AT);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("damage open never notices (header intact, b-tree pages garbage) is caught by quick_check and set aside", () => {
  const directory = scratch();
  const path = join(directory, "ear.db");
  try {
    healthyStore(path);
    const bytes = readFileSync(path);
    const pageSize = bytes.readUInt16BE(16);
    // Page 1 (the header and schema) stays; every page after it is garbage.
    for (let i = pageSize; i < bytes.length; i++) {
      bytes[i] = (i * 31 + 7) & 0xff;
    }
    writeFileSync(path, bytes);
    const store = new EventStore(path, new FakeClock(AT));
    try {
      assert.deepEqual(readFileSync(`${path}.corrupt-${STAMP}`), bytes);
      const [reset] = store.storeResets();
      // quick_check reads every page: it throws, or lists what it found.
      assert.match(reset?.error ?? "", /malformed|^quick_check: /);
      assert.deepEqual(store.letters("scribe"), []);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("damage only in the letters table, which opening never reads, is caught at start by quick_check, not later by the first letter read", () => {
  const directory = scratch();
  const path = join(directory, "ear.db");
  try {
    healthyStore(path);
    const probe = new DatabaseSync(path, { readOnly: true });
    const { rootpage } = probe
      .prepare(
        "SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'letters'",
      )
      .get() as { rootpage: number };
    probe.close();
    const bytes = readFileSync(path);
    const pageSize = bytes.readUInt16BE(16);
    for (let i = (rootpage - 1) * pageSize; i < rootpage * pageSize; i++) {
      bytes[i] = 0xff;
    }
    writeFileSync(path, bytes);
    const store = new EventStore(path, new FakeClock(AT));
    try {
      assert.ok(existsSync(`${path}.corrupt-${STAMP}`));
      assert.match(
        store.storeResets()[0]?.error ?? "",
        /malformed|^quick_check: /,
      );
      assert.deepEqual(store.letters("scribe"), [], "reads, not throws");
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a healthy store is never moved: closed cleanly, or crash-shaped with a live WAL, it reopens as it was", () => {
  const directory = scratch();
  const path = join(directory, "ear.db");
  const crashed = join(directory, "crashed.db");
  try {
    healthyStore(path);
    const before = names(directory);
    const store = new EventStore(path, new FakeClock(AT));
    try {
      assert.equal(store.letters("scribe").length, 1);
      assert.deepEqual(store.storeResets(), []);
      // Copied while open: the db, its WAL and its shm as a crash leaves them.
      letter(store, "only in the WAL");
      for (const suffix of ["", "-wal", "-shm"]) {
        copyFileSync(`${path}${suffix}`, `${crashed}${suffix}`);
      }
    } finally {
      store.close();
    }
    assert.deepEqual(quarantined(directory), []);
    assert.ok(before.every((name) => existsSync(join(directory, name))));
    const copy = new EventStore(crashed, new FakeClock(AT));
    try {
      assert.deepEqual(
        copy.letters("scribe").map((item) => item.body),
        ["owed: finish the review", "only in the WAL"],
      );
      assert.deepEqual(copy.storeResets(), []);
    } finally {
      copy.close();
    }
    assert.deepEqual(quarantined(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a first start (no file, no directory yet) is a fresh store, not a reset", () => {
  const directory = scratch();
  const path = join(directory, "state", "nested", "ear.db");
  try {
    const store = new EventStore(path, new FakeClock(AT));
    try {
      assert.deepEqual(store.storeResets(), []);
    } finally {
      store.close();
    }
    assert.deepEqual(quarantined(join(directory, "state", "nested")), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const [label, hold] of [
  [
    "held exclusively (locking_mode EXCLUSIVE: even reads are BUSY)",
    "PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; INSERT INTO counters (name, value) VALUES ('held', 1);",
  ],
  [
    "write-locked (another writer mid-transaction: reads pass, the first write is BUSY)",
    "BEGIN IMMEDIATE; INSERT INTO counters (name, value) VALUES ('held', 1);",
  ],
] as const) {
  test(`a store ${label} refuses to open and is never moved`, () => {
    const directory = scratch();
    const path = join(directory, "ear.db");
    try {
      healthyStore(path);
      const holder = new DatabaseSync(path);
      try {
        holder.exec(hold);
        assert.throws(
          () => new EventStore(path, new FakeClock(AT)),
          (error: { errcode?: number }) => (error.errcode ?? 0) % 256 === 5,
        );
        assert.deepEqual(quarantined(directory), []);
        assert.ok(existsSync(path));
        holder.exec("ROLLBACK");
      } finally {
        holder.close();
      }
      const store = new EventStore(path, new FakeClock(AT));
      try {
        assert.equal(
          store.letters("scribe").length,
          1,
          "the letter is still there",
        );
        assert.deepEqual(store.storeResets(), []);
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test(
  "an unreadable store (mode 000) refuses to open and is never moved",
  { skip: ROOT ? "root reads a mode-000 file" : false },
  () => {
    const directory = scratch();
    const path = join(directory, "ear.db");
    try {
      healthyStore(path);
      chmodSync(path, 0o000);
      try {
        assert.throws(
          () => new EventStore(path, new FakeClock(AT)),
          /unable to open database file/,
        );
        assert.deepEqual(quarantined(directory), []);
        assert.ok(existsSync(path));
      } finally {
        chmodSync(path, 0o600);
      }
      const store = new EventStore(path, new FakeClock(AT));
      try {
        assert.equal(store.letters("scribe").length, 1);
        assert.deepEqual(store.storeResets(), []);
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("a store whose directory can't be made refuses, and nothing is moved", () => {
  const directory = scratch();
  try {
    writeFileSync(join(directory, "not-a-dir"), "x");
    assert.throws(
      () => new EventStore(join(directory, "not-a-dir", "ear.db")),
      /ENOTDIR|EEXIST/,
    );
    assert.deepEqual(names(directory), ["not-a-dir"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "a corrupt store that can't be moved aside refuses to start, naming the path, and stays where it was",
  { skip: ROOT ? "root renames in a read-only directory" : false },
  () => {
    const directory = scratch();
    const path = join(directory, "ear.db");
    const garbage = Buffer.from("not a database ".repeat(300));
    try {
      writeFileSync(path, garbage);
      chmodSync(directory, 0o500);
      try {
        assert.throws(
          () => new EventStore(path, new FakeClock(AT)),
          (error: Error) =>
            error.message.includes(path) &&
            error.message.includes("refusing to start") &&
            error.message.includes("nothing was deleted") &&
            // The marker is the first write, before any rename (Deep Dive No. 2 §08).
            error.message.includes(
              `could not be moved aside to ${path}.reset-${STAMP}.json (the reset marker`,
            ),
        );
      } finally {
        chmodSync(directory, 0o700);
      }
      assert.deepEqual(readFileSync(path), garbage);
      assert.deepEqual(quarantined(directory), []);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("a quarantine never overwrites an earlier one with the same stamp", () => {
  const directory = scratch();
  const path = join(directory, "ear.db");
  try {
    writeFileSync(`${path}.corrupt-${STAMP}`, "earlier quarantine");
    writeFileSync(path, "garbage ".repeat(600));
    const store = new EventStore(path, new FakeClock(AT));
    try {
      assert.equal(
        readFileSync(`${path}.corrupt-${STAMP}`, "utf8"),
        "earlier quarantine",
      );
      assert.equal(
        readFileSync(`${path}.corrupt-${STAMP}-1`, "utf8"),
        "garbage ".repeat(600),
      );
      assert.equal(
        store.storeResets()[0]?.keptAt,
        `${path}.corrupt-${STAMP}-1`,
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ear_status says plainly that owed letters and wakes from before the reset are not in the live store, and where the old file is kept", async () => {
  const directory = scratch();
  const path = join(directory, "ear.db");
  writeFileSync(path, "garbage ".repeat(600));
  const h = harness(testConfig(), { path });
  try {
    const kept = `${path}.corrupt-19700101T001640.000Z`;
    assert.ok(existsSync(kept));
    const status = h.daemon.status() as {
      storeReset?: { said: string; resets: Array<{ keptAt: string }> };
    };
    assert.ok(status.storeReset, "ear_status carries the reset");
    assert.equal(
      status.storeReset.said,
      `the ledger store was corrupt at start and was set aside at 1970-01-01T00:16:40.000Z; frond-ear started a fresh store then. Owed letters and wakes from before 1970-01-01T00:16:40.000Z (and everything else the store held: queued events, schedules, canticle custody) are not in the live store. The old file is kept, never deleted, at ${kept}; an owner can read it by hand (sqlite3 .recover, docs/recovery.md).`,
    );
    assert.deepEqual(
      status.storeReset.resets.map((reset) => reset.keptAt),
      [kept],
    );
    // The session's own ear_status (one ear) carries it too.
    const shim = h.attach("scribe", { sessionId: "s-1" });
    const result = await h.call(shim, "ear_status");
    assert.ok(result.ok);
    assert.match(
      result.text,
      /Owed letters and wakes from before 1970-01-01T00:16:40.000Z/,
    );
  } finally {
    h.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ear_status on a store that was never reset carries no storeReset", () => {
  const h = harness();
  try {
    assert.equal("storeReset" in (h.daemon.status() as object), false);
  } finally {
    h.dispose();
  }
});

// Deep Dive No. 2 §08: a reset whose fresh store fails right after the rename must not
// vanish. A small marker is written beside the quarantine before anything moves; a later
// start that finds it with no record in the live store records it, so ear_status says it.

const STORE_URL = new URL("../src/store.ts", import.meta.url).href;
const LINUX = process.platform === "linux";

/** The reset marker a quarantine at `stamp` leaves beside `path`, before and after it is recorded. */
function marker(path: string, stamp = STAMP) {
  return {
    pending: `${path}.reset-${stamp}.json`,
    recorded: `${path}.reset-${stamp}.recorded.json`,
  };
}

test(
  "the fresh store fails just after the corrupt one is set aside (the real constructor, a file-size limit): the next start still says the reset in ear_status",
  { skip: LINUX ? false : "ulimit -f is the Linux shape of a full disk here" },
  () => {
    const directory = scratch();
    const path = join(directory, "ear.db");
    const garbage = Buffer.from("not a database at all ".repeat(400));
    try {
      writeFileSync(path, garbage);
      // 2 KiB per file: the marker and the renames fit, the fresh store's first page does not.
      const child = spawnSync(
        "bash",
        [
          "-c",
          'ulimit -f 2; exec "$0" --input-type=module -e "$1"',
          process.execPath,
          `import { EventStore } from ${JSON.stringify(STORE_URL)}; new EventStore(process.env.FROND_EAR_TEST_DB);`,
        ],
        {
          env: { ...process.env, FROND_EAR_TEST_DB: path },
          encoding: "utf8",
        },
      );
      assert.notEqual(child.status, 0, "the fresh store failed in the child");
      assert.match(
        `${child.stderr}${child.signal ?? ""}`,
        /disk I\/O error|SIGXFSZ|EFBIG|File too large/,
      );
      const kept = quarantined(directory).filter((name) =>
        /^ear\.db\.corrupt-[0-9T.Z]+$/u.test(name),
      );
      assert.equal(kept.length, 1, "the corrupt store was set aside");
      const keptAt = join(directory, kept[0]!);
      assert.deepEqual(readFileSync(keptAt), garbage);
      // What a start then finds where the store was: no store, or an empty one that reads ok.
      assert.ok(!existsSync(path) || statSync(path).size === 0);

      const h = harness(testConfig(), { path });
      try {
        const status = h.daemon.status() as {
          storeReset?: {
            said: string;
            resets: Array<{ keptAt: string; error: string }>;
          };
        };
        assert.ok(status.storeReset, "ear_status carries the reset");
        assert.deepEqual(
          status.storeReset.resets.map((reset) => [reset.keptAt, reset.error]),
          [[keptAt, "file is not a database"]],
        );
        assert.match(status.storeReset.said, /did not complete/);
        assert.ok(status.storeReset.said.includes(keptAt));
      } finally {
        h.dispose();
      }
      // Recorded once: the marker is kept as recorded, and a later start adds nothing.
      const stamp = kept[0]!.slice("ear.db.corrupt-".length);
      assert.ok(existsSync(marker(path, stamp).recorded));
      assert.ok(!existsSync(marker(path, stamp).pending));
      const again = new EventStore(path, new FakeClock(AT));
      try {
        assert.equal(again.storeResets().length, 1);
      } finally {
        again.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("a start that dies right after the set-aside (no fresh store at all) is reported by the next start, once, and clearing the record clears it", () => {
  const directory = scratch();
  const path = join(directory, "ear.db");
  try {
    writeFileSync(path, "garbage ".repeat(600));
    writeFileSync(`${path}-wal`, "old wal ".repeat(60));
    // The constructor's first two steps, then the process is gone.
    const damage = probeStore(path);
    assert.ok(damage !== undefined);
    const reset = setStoreAside(path, damage, AT);
    assert.ok(!existsSync(path));
    assert.ok(existsSync(marker(path).pending), "the marker came first");

    const next = new EventStore(path, new FakeClock(AT + 5_000));
    try {
      const resets = next.storeResets();
      assert.equal(resets.length, 1);
      assert.equal(resets[0]?.keptAt, `${path}.corrupt-${STAMP}`);
      assert.equal(resets[0]?.at, AT);
      assert.deepEqual(resets[0]?.moved, reset.moved);
      assert.equal(resets[0]?.error, "file is not a database");
      assert.equal(resets[0]?.recoveredFrom, marker(path).pending);
      assert.equal(resets[0]?.recoveredAt, AT + 5_000);
      assert.deepEqual(next.recovered, resets, "said in the journal too");
      assert.equal(next.reset, undefined, "this start set nothing aside");
      // Custody before the reset is unknown, as on the ordinary path.
      assert.equal(next.canticleCustodySince(), AT);
    } finally {
      next.close();
    }
    assert.ok(existsSync(marker(path).recorded));
    // The runbook's clear is a real clear: the recorded marker is never read again.
    const owner = new DatabaseSync(path);
    owner.exec("DELETE FROM store_resets");
    owner.close();
    const cleared = new EventStore(path, new FakeClock(AT + 10_000));
    try {
      assert.deepEqual(cleared.storeResets(), []);
    } finally {
      cleared.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const [label, damage] of [
  [
    "a truncated store",
    (path: string) => truncateSync(path, statSync(path).size >> 1),
  ],
  [
    "damage only in the letters table (quick_check's findings)",
    (path: string) => {
      const probe = new DatabaseSync(path, { readOnly: true });
      const { rootpage } = probe
        .prepare(
          "SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'letters'",
        )
        .get() as { rootpage: number };
      probe.close();
      const bytes = readFileSync(path);
      const pageSize = bytes.readUInt16BE(16);
      for (let i = (rootpage - 1) * pageSize; i < rootpage * pageSize; i++) {
        if (i % 7 !== 0) bytes[i] = 0x2a;
      }
      writeFileSync(path, bytes);
    },
  ],
] as const) {
  test(`the reset marker never holds ledger content: ${label}`, () => {
    const directory = scratch();
    const path = join(directory, "ear.db");
    const secret = "LEDGER-SECRET-owed-letter-9f4c2e71";
    try {
      const store = new EventStore(path, new FakeClock(AT - 120_000));
      letter(store, `${secret} ${secret}`);
      store.close();
      damage(path);
      const found = probeStore(path);
      assert.ok(found !== undefined, "the damage is seen");
      const kept = `${path}.corrupt-${STAMP}`;
      const moving = ["-wal", "-shm", "-journal", ""]
        .filter((suffix) => existsSync(`${path}${suffix}`))
        .map((suffix) => `${kept}${suffix}`);
      setStoreAside(path, found, AT);
      const bytes = readFileSync(marker(path).pending);
      assert.ok(bytes.length < 2048, "small");
      const text = bytes.toString("utf8");
      assert.ok(!text.includes("LEDGER-SECRET"), "no letter text");
      assert.ok(!text.includes("owed-letter"), "no letter text");
      assert.ok(!text.includes("SQLite format"), "no store bytes");
      const parsed = JSON.parse(text) as Record<string, unknown>;
      assert.deepEqual(Object.keys(parsed).sort(), [
        "at",
        "atIso",
        "error",
        "frondEar",
        "keptAt",
        "moving",
        "store",
        "version",
      ]);
      assert.equal(parsed.frondEar, "store-reset-marker");
      assert.equal(parsed.store, path);
      assert.equal(parsed.keptAt, `${path}.corrupt-${STAMP}`);
      assert.equal(parsed.at, AT);
      assert.equal(parsed.atIso, new Date(AT).toISOString());
      assert.deepEqual(parsed.moving, moving, "paths only");
      assert.equal(moving.at(-1), kept, "the database last");
      // Why: SQLite's own words or quick_check's page findings, the same the record keeps.
      assert.equal(
        parsed.error,
        found instanceof Error ? found.message : String(found),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
