// frond-ear#102: a PreCompact hook prints the compacting session's own unsettled
// letters as instructions for the compaction summary. Read-only, fails closed on
// the session, never blocks the compaction.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { summaryLetters } from "../src/letters.ts";
import { listenUnix } from "../src/server.ts";
import { harness, testConfig } from "./helpers.ts";

const SESSION = "aaaaaaaa-1111-2222-3333-444444444444";
const OTHER = "bbbbbbbb-1111-2222-3333-444444444444";
const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

type H = ReturnType<typeof harness>;

async function precompact(
  h: H,
  fields: { ear?: string; sessionId?: string; role?: "cli" | "tap" } = {},
): Promise<{ ok: boolean; text: string }> {
  const client = h.attach(undefined, { role: fields.role ?? "cli" });
  const id = 7_000 + Math.floor(Math.random() * 1_000);
  await client.send({
    type: "precompact",
    id,
    ear: fields.ear ?? "scribe",
    ...(fields.sessionId ? { sessionId: fields.sessionId } : {}),
  });
  const result = client.connection.results().find((item) => item.id === id);
  assert.ok(result, "precompact answered");
  return result;
}

test("precompact prints the session's unsettled letters, newest first, framed for the summary; nothing is delivered", async () => {
  const h = harness(testConfig(), { nonce: "pc01" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await h.call(shim, "leave_letter", {
      reason: "older thread",
      body: "first body",
      assumed: ["pr:1 open"],
    });
    h.clock.advance(1_000);
    await h.call(shim, "leave_letter", {
      reason: "newer thread",
      body: "second body",
    });
    const result = await precompact(h, { sessionId: SESSION });
    assert.equal(result.ok, true, result.text);
    assert.match(
      result.text,
      /^frond-ear: this session left itself 2 unsettled letters/u,
    );
    assert.match(result.text, /"Letters from before this compaction"/u);
    assert.match(result.text, /evidence and never permission/u);
    assert.ok(
      !result.text.trimStart().startsWith("{"),
      "could be read as a JSON decision",
    );
    const newer = result.text.indexOf("second body");
    const older = result.text.indexOf("first body");
    assert.ok(newer > 0 && older > newer, "newest first");
    assert.match(result.text, /> - pr:1 open/u);

    // Read-only: the release after the compaction still delivers both.
    const listed = await h.call(shim, "letters", {});
    assert.match(listed.text, /waiting/u);
    const cli = h.attach(undefined, { role: "cli" });
    await cli.send({
      type: "release",
      id: 1,
      ear: "scribe",
      source: "compact",
      sessionId: SESSION,
    });
    const letters = shim.connection
      .events()
      .filter((event) => event.meta.kind === "letter");
    assert.equal(letters.length, 2);
  } finally {
    h.dispose();
  }
});

test("precompact carries nothing settled, expired or left by another session; empty when nothing is due", async () => {
  const h = harness(testConfig(), { nonce: "pc02" });
  try {
    const old = h.attach("scribe", { sessionId: OTHER });
    await h.call(old, "leave_letter", {
      reason: "other session's",
      body: "not mine",
    });
    const shim = h.attach("scribe", { sessionId: SESSION });
    assert.equal((await precompact(h, { sessionId: SESSION })).text, "");

    await h.call(shim, "leave_letter", {
      reason: "short",
      body: "lapses",
      expires_in_seconds: 60,
    });
    h.clock.advance(61_000);
    await h.call(shim, "leave_letter", {
      reason: "settled",
      body: "acked already",
    });
    const cli = h.attach(undefined, { role: "cli" });
    await cli.send({
      type: "release",
      id: 2,
      ear: "scribe",
      source: "compact",
      sessionId: SESSION,
    });
    await h.call(shim, "ack", { nonce: "pc02" });

    const result = await precompact(h, { sessionId: SESSION });
    assert.equal(result.ok, true, result.text);
    assert.equal(result.text, "");
  } finally {
    h.dispose();
  }
});

test("precompact fails closed: no session, another session, an unknown ear, a non-CLI client", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await h.call(shim, "leave_letter", { reason: "r", body: "secret-ish" });
    const cases: Array<[Parameters<typeof precompact>[1], RegExp]> = [
      [{}, /named no session/u],
      [{ sessionId: OTHER }, /not held by session bbbbbbbb/u],
      [{ ear: "nope", sessionId: SESSION }, /unknown ear nope/u],
      [{ sessionId: SESSION, role: "tap" }, /only a CLI client/u],
    ];
    for (const [fields, pattern] of cases) {
      const result = await precompact(h, fields);
      assert.equal(result.ok, false, JSON.stringify(fields));
      assert.match(result.text, pattern);
      assert.doesNotMatch(result.text, /secret-ish/u);
    }
    shim.close();
    const detached = await precompact(h, { sessionId: SESSION });
    assert.equal(detached.ok, false);
    assert.doesNotMatch(detached.text, /secret-ish/u);
  } finally {
    h.dispose();
  }
});

test("summaryLetters stays under its cap: the newest whole, older ones named as not fitting", async () => {
  const h = harness(testConfig(), { nonce: "pc03" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    for (const n of [1, 2, 3]) {
      await h.call(shim, "leave_letter", {
        reason: `thread ${n}`,
        body: `${n}`.repeat(1_500),
      });
      h.clock.advance(1_000);
    }
    const text = summaryLetters(
      h.store,
      "scribe",
      SESSION,
      h.clock.now(),
      2_500,
    );
    assert.ok(text.length <= 2_500, `${text.length} > cap`);
    assert.ok(text.includes("3".repeat(1_500)), "the newest letter whole");
    assert.match(
      text,
      /\[letters \d+, \d+ did not fit this hook's 2500-character budget/u,
    );
    assert.ok(!text.includes("1".repeat(1_500)));
  } finally {
    h.dispose();
  }
});

function run(
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

test("frond-ear precompact --hook: stdout is the letters or nothing, and the exit code is always 0", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-pc-"));
  const socketPath = join(directory, "d.sock");
  const h = harness();
  const server = await listenUnix(h.daemon, socketPath);
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await h.call(shim, "leave_letter", {
      reason: "carry me",
      body: "the thread",
    });
    const env = { ...process.env, FROND_EAR_SOCKET: socketPath };
    const hookJson = (session: string) =>
      JSON.stringify({
        session_id: session,
        hook_event_name: "PreCompact",
        trigger: "auto",
        custom_instructions: null,
      });

    const ok = await run(
      ["precompact", "--ear", "scribe", "--hook"],
      env,
      hookJson(SESSION),
    );
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(
      ok.stdout,
      /^frond-ear: this session left itself 1 unsettled letter/u,
    );
    assert.match(ok.stdout, /the thread/u);

    const wrong = await run(
      ["precompact", "--ear", "scribe", "--hook"],
      env,
      hookJson(OTHER),
    );
    assert.equal(wrong.code, 0);
    assert.equal(wrong.stdout, "", "a refusal must not land in the summary");
    assert.match(wrong.stderr, /not held by session/u);

    const garbage = await run(
      ["precompact", "--ear", "scribe", "--hook"],
      env,
      "not json",
    );
    assert.equal(garbage.code, 0);
    assert.equal(garbage.stdout, "");

    const down = await run(
      ["precompact", "--ear", "scribe", "--hook"],
      { ...process.env, FROND_EAR_SOCKET: join(directory, "nobody.sock") },
      hookJson(SESSION),
    );
    assert.equal(down.code, 0, "a down daemon must not block the compaction");
    assert.equal(down.stdout, "");
    assert.notEqual(down.stderr, "");

    // Without --hook a refusal is an error exit.
    const manual = await run(
      ["precompact", "--ear", "scribe", "--session", OTHER],
      env,
      "",
    );
    assert.equal(manual.code, 1);
  } finally {
    server.close();
    h.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("precompact leaves out a letter that has just expired, with no release in between", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await h.call(shim, "leave_letter", {
      reason: "brief",
      body: "gone in a minute",
      expires_in_seconds: 60,
    });
    assert.match(
      (await precompact(h, { sessionId: SESSION })).text,
      /gone in a minute/u,
    );
    h.clock.advance(61_000);
    const result = await precompact(h, { sessionId: SESSION });
    assert.equal(result.ok, true);
    assert.equal(result.text, "");
  } finally {
    h.dispose();
  }
});

test("summaryLetters names every letter it leaves out, whatever the sizes near the cap (#103 review)", async () => {
  for (let size = 600; size <= 2_300; size += 85) {
    const h = harness(testConfig(), { nonce: `pc-sz-${size}` });
    try {
      const shim = h.attach("scribe", { sessionId: SESSION });
      const ids: number[] = [];
      for (const body of [
        `a${"x".repeat(300)}`,
        `b${"y".repeat(300)}`,
        `c${"z".repeat(size)}`,
      ]) {
        const left = await h.call(shim, "leave_letter", {
          reason: `r-${body[0]}`,
          body,
        });
        ids.push(Number(/letter (\d+) left/u.exec(left.text)?.[1]));
        h.clock.advance(1_000);
      }
      const text = summaryLetters(
        h.store,
        "scribe",
        SESSION,
        h.clock.now(),
        2_500,
      );
      assert.ok(text.length <= 2_500, `size ${size}: ${text.length} > cap`);
      const note = /\[letters? ([\d, ]+) did not fit/u.exec(text)?.[1] ?? "";
      const named = note.split(", ").filter(Boolean).map(Number);
      for (const id of ids) {
        const whole = text.includes(`[letter ${id} · left`);
        assert.ok(
          whole !== named.includes(id),
          `size ${size}: letter ${id} whole=${whole} named=${named.includes(id)}`,
        );
      }
    } finally {
      h.dispose();
    }
  }
});

test("precompact --hook ignores --session (stdin names the compacting session) and exits 0 on bad arguments", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-pc2-"));
  const socketPath = join(directory, "d.sock");
  const h = harness();
  const server = await listenUnix(h.daemon, socketPath);
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await h.call(shim, "leave_letter", {
      reason: "mine",
      body: "holder's letter",
    });
    const env = { ...process.env, FROND_EAR_SOCKET: socketPath };
    // stdin names OTHER (being compacted); --session names the holder. Nothing prints.
    const spoof = await run(
      ["precompact", "--ear", "scribe", "--hook", "--session", SESSION],
      env,
      JSON.stringify({ session_id: OTHER, hook_event_name: "PreCompact" }),
    );
    assert.equal(spoof.code, 0);
    assert.equal(spoof.stdout, "");
    assert.match(spoof.stderr, /--session is ignored under --hook/u);

    const bad = await run(["precompact", "--hook", "--bogus"], env, "{}");
    assert.equal(
      bad.code,
      0,
      "bad hook arguments must not fail the compaction",
    );
    assert.equal(bad.stdout, "");
    assert.notEqual(bad.stderr, "");
    const badManual = await run(["precompact", "--bogus"], env, "");
    assert.equal(
      badManual.code,
      1,
      "never exit 2: that code blocks a compaction",
    );
  } finally {
    server.close();
    h.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
