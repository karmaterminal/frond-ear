// The published onboarding flows, run literally. Each test lifts a ```sh block out of the docs,
// runs it in bash from a fresh "checkout" (a temp directory whose src/ links to this one) with a
// fresh HOME, and asserts doctor's config and token checks pass. A doc that drifts from what the
// daemon and doctor actually read fails here, not in a fresh user's terminal.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { BOT, CHANNEL, PRINCIPAL } from "./helpers.ts";

const REPO = join(import.meta.dirname, "..");
const TOKEN = "not-a-real-token-456";

/** The first ```sh block after the line `heading` (or the first in the file when null). */
function shBlock(file: string, heading: string | null): string {
  const lines = readFileSync(join(REPO, file), "utf8").split("\n");
  let index = heading === null ? 0 : lines.indexOf(heading);
  assert.ok(index >= 0, `${file}: no heading ${JSON.stringify(heading)}`);
  while (index < lines.length && lines[index] !== "```sh") {
    index += 1;
  }
  const end = lines.indexOf("```", index + 1);
  assert.ok(index < lines.length && end > index, `${file}: no sh block`);
  return lines
    .slice(index + 1, end)
    .filter((line) => !line.startsWith("git clone "))
    .join("\n");
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  home: string;
  checkout: string;
}

/** Runs `script` in bash from a fresh checkout and a fresh HOME, with no frond-ear env set. */
function runFresh(script: string, input = ""): Run {
  const root = mkdtempSync(join(tmpdir(), "fe-qs-"));
  const home = join(root, "home");
  const checkout = join(root, "frond-ear");
  const bin = join(root, "bin");
  const run = join(root, "run");
  for (const directory of [home, checkout, bin, run]) {
    mkdirSync(directory, { mode: 0o700 });
  }
  symlinkSync(join(REPO, "src"), join(checkout, "src"));
  // $EDITOR for the "human writes the token" step: writes the token, as a human would.
  const editor = join(bin, "fake-editor");
  writeFileSync(editor, `#!/bin/sh\nprintf '%s\\n' '${TOKEN}' > "$1"\n`);
  chmodSync(editor, 0o755);
  const result = spawnSync("bash", ["-e", "-c", script], {
    cwd: checkout,
    input,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      HOME: home,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      EDITOR: editor,
      XDG_RUNTIME_DIR: run,
      XDG_STATE_HOME: join(root, "state"),
    },
  });
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    home,
    checkout,
  };
}

function assertConfigAndTokenPass(run: Run): void {
  const where = `\n--- stdout\n${run.stdout}\n--- stderr\n${run.stderr}`;
  assert.match(
    run.stdout,
    /^frond-ear doctor$/mu,
    `doctor did not run${where}`,
  );
  assert.match(run.stdout, /^ {2}✓ config: /mu, `config check failed${where}`);
  assert.match(run.stdout, /^ {2}✓ token: /mu, `token check failed${where}`);
  assert.ok(
    !existsSync(join(run.checkout, "frond-ear.json")),
    "the flow must not need a config in the checkout",
  );
  assert.ok(!run.stdout.includes(TOKEN), "the token must never print");
  // The daemon is not started by these flows, so doctor exits 1 on the socket/daemon checks.
  assert.match(run.stdout, /^ {2}✗ daemon: /mu, where);
}

// Interactive init over a pipe: bot, one principal, no peers, no patterns, ear, one channel
// (default mode), DMs on, paste the token.
const INTERACTIVE = [
  BOT,
  PRINCIPAL,
  "figs",
  "",
  "",
  "",
  "scribe",
  CHANNEL,
  "",
  "",
  "y",
  "1",
  TOKEN,
]
  .map((line) => `${line}\n`)
  .join("");

test("README quick start, run literally, passes doctor's config and token checks", () => {
  const run = runFresh(shBlock("README.md", "## Quick start"), INTERACTIVE);
  try {
    assertConfigAndTokenPass(run);
  } finally {
    rmSync(dirname(run.home), { recursive: true, force: true });
  }
});

test("docs/onboarding.md opening example, run literally, passes config and token", () => {
  const run = runFresh(shBlock("docs/onboarding.md", null), INTERACTIVE);
  try {
    assertConfigAndTokenPass(run);
  } finally {
    rmSync(dirname(run.home), { recursive: true, force: true });
  }
});

test("docs/onboarding.md §6 agent onboarding, run literally, passes config and token", () => {
  const run = runFresh(shBlock("docs/onboarding.md", "## 6. Agent onboarding"));
  try {
    assertConfigAndTokenPass(run);
  } finally {
    rmSync(dirname(run.home), { recursive: true, force: true });
  }
});

test("docs/runbook.md §1 init then doctor, run literally, passes config and token", () => {
  const script = `node src/cli.ts init\n${shBlock("docs/runbook.md", "## 1. Configure")}`;
  const run = runFresh(script, INTERACTIVE);
  try {
    assertConfigAndTokenPass(run);
  } finally {
    rmSync(dirname(run.home), { recursive: true, force: true });
  }
});

test("the doctor command init prints, run as printed, passes config and token", () => {
  const first = runFresh("node src/cli.ts init", INTERACTIVE);
  try {
    assert.equal(first.code, 0, first.stderr);
    const lines = first.stdout.split("\n");
    const step = lines.findIndex((line) =>
      line.includes("2. check the result"),
    );
    const printed = lines[step + 1]?.trim() ?? "";
    assert.match(
      printed,
      /^FROND_EAR_CONFIG=.* DISCORD_BOT_TOKEN_FILE=.* doctor$/u,
    );
    // Same HOME, a different directory: what init printed must not depend on the cwd.
    const second = spawnSync("bash", ["-c", printed], {
      cwd: dirname(first.home),
      encoding: "utf8",
      timeout: 30_000,
      env: {
        HOME: first.home,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        XDG_RUNTIME_DIR: join(dirname(first.home), "run"),
      },
    });
    assertConfigAndTokenPass({
      code: second.status,
      stdout: second.stdout,
      stderr: second.stderr,
      home: first.home,
      checkout: first.checkout,
    });
  } finally {
    rmSync(dirname(first.home), { recursive: true, force: true });
  }
});
