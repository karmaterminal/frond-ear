import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { watchConfigFile } from "../src/config-watch.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

// Runs each step after a settle; says, step by step, whether the watcher fired for it.
async function stepsSeen(
  arm: (onChange: () => void) => { close(): void },
  steps: Array<() => void>,
): Promise<boolean[]> {
  let fired = false;
  const watcher = arm(() => {
    fired = true;
  });
  const seen: boolean[] = [];
  try {
    for (const step of steps) {
      await settle();
      fired = false;
      step();
      await settle();
      seen.push(fired);
    }
  } finally {
    watcher.close();
  }
  return seen;
}

function replace(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

test("an edit after an atomic replace still reloads (frond-ear#89)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frond-ear-watch-"));
  try {
    const path = join(dir, "frond-ear.json");
    writeFileSync(path, "{}\n");
    const seen = await stepsSeen(
      (onChange) => watchConfigFile(path, onChange),
      [
        () => writeFileSync(path, '{"a":1}\n'),
        () => replace(path, '{"a":2}\n'),
        () => writeFileSync(path, '{"a":3}\n'),
        () => replace(path, '{"a":4}\n'),
        () => writeFileSync(path, '{"a":5}\n'),
      ],
    );
    assert.deepEqual(seen, [true, true, true, true, true]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("control: a watch on the file itself misses the edit after a replace", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "frond-ear-watch-"));
  try {
    const path = join(dir, "frond-ear.json");
    writeFileSync(path, "{}\n");
    const seen = await stepsSeen(
      (onChange) => watch(path, onChange),
      [
        () => replace(path, '{"a":1}\n'),
        () => writeFileSync(path, '{"a":2}\n'),
      ],
    );
    if (process.platform !== "linux") {
      t.skip("inode-bound file watches are the Linux behavior");
      return;
    }
    assert.deepEqual(seen, [true, false]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("other files in the directory do not reload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frond-ear-watch-"));
  try {
    const path = join(dir, "frond-ear.json");
    writeFileSync(path, "{}\n");
    const seen = await stepsSeen(
      (onChange) => watchConfigFile(path, onChange),
      [
        () => writeFileSync(join(dir, "frond-ear.json.bak-x"), "{}\n"),
        () => writeFileSync(join(dir, "token"), "x\n"),
      ],
    );
    assert.deepEqual(seen, [false, false]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a symlinked config reloads when its target changes, replaced or not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frond-ear-watch-"));
  try {
    mkdirSync(join(dir, "real"));
    const target = join(dir, "real", "ear.json");
    const path = join(dir, "frond-ear.json");
    writeFileSync(target, "{}\n");
    symlinkSync(target, path);
    const seen = await stepsSeen(
      (onChange) => watchConfigFile(path, onChange),
      [
        () => writeFileSync(target, '{"a":1}\n'),
        () => replace(target, '{"a":2}\n'),
        () => writeFileSync(target, '{"a":3}\n'),
      ],
    );
    assert.deepEqual(seen, [true, true, true]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
