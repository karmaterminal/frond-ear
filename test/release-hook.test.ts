// `frond-ear release --hook` (#88): the line a SessionStart hook adds to the
// session's context. A fake daemon on a real unix socket answers the release, so the
// CLI's own output is what's checked: the result line, then the letter reminder
// (which must arrive even when no letter does), and no reminder without --hook or
// when the daemon is down.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LETTER_HINT } from "../src/letters.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

function fakeDaemon(
  socketPath: string,
  text: string,
  ok = true,
): Promise<Server> {
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        const message = JSON.parse(line) as { type: string; id?: number };
        if (message.type === "hello") {
          socket.write(
            `${JSON.stringify({ type: "welcome", protocol: 1, attached: false, instructions: "" })}\n`,
          );
        } else if (message.type === "release") {
          socket.write(
            `${JSON.stringify({ type: "result", id: message.id, ok, text })}\n`,
          );
        }
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(socketPath, () => resolve(server)),
  );
}

function run(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stdin.end("{}");
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

test("release --hook adds the letter reminder after the result, even with no letters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fe-release-hook-"));
  const socketPath = join(dir, "daemon.sock");
  const server = await fakeDaemon(socketPath, "no letters for ear t");
  try {
    const { code, stdout } = await run(["release", "--ear", "t", "--hook"], {
      FROND_EAR_SOCKET: socketPath,
      FROND_EAR_TCP: "",
    });
    assert.equal(code, 0);
    assert.deepEqual(stdout.trimEnd().split("\n"), [
      "frond-ear: no letters for ear t",
      `frond-ear: ${LETTER_HINT}`,
    ]);
    assert.match(LETTER_HINT, /leave_letter/u);
    assert.match(LETTER_HINT, /no warning/u);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release without --hook prints only the result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fe-release-hook-"));
  const socketPath = join(dir, "daemon.sock");
  const server = await fakeDaemon(socketPath, "no letters for ear t");
  try {
    const { code, stdout } = await run(["release", "--ear", "t"], {
      FROND_EAR_SOCKET: socketPath,
      FROND_EAR_TCP: "",
    });
    assert.equal(code, 0);
    assert.equal(stdout, "frond-ear: no letters for ear t\n");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release --hook with the daemon down reports it and offers no letter it can't take", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fe-release-hook-"));
  try {
    const { code, stdout } = await run(["release", "--ear", "t", "--hook"], {
      FROND_EAR_SOCKET: join(dir, "absent.sock"),
      FROND_EAR_TCP: "",
    });
    assert.equal(code, 0);
    assert.match(stdout, /^frond-ear: letters not released \(/u);
    assert.doesNotMatch(stdout, /leave_letter/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release --hook when the daemon refuses (ok:false) prints its answer and no reminder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fe-release-hook-"));
  const socketPath = join(dir, "d.sock");
  const server = await fakeDaemon(socketPath, "unknown ear t", false);
  try {
    const { code, stdout } = await run(["release", "--ear", "t", "--hook"], {
      FROND_EAR_SOCKET: socketPath,
      FROND_EAR_TCP: "",
    });
    assert.equal(code, 0);
    assert.equal(stdout, "frond-ear: unknown ear t\n");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
