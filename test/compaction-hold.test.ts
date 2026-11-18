// frond-ear#107: a session can hold off its own auto compaction while it waits
// mid-task. The PreCompact hook blocks (exit 2) only for an auto compaction of the
// holding session, before the hold expires, with a reading under the ceiling.
// Everything else fails open: the compaction goes ahead as stock.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HOLD_LIMITS } from "../src/daemon.ts";
import { listenUnix } from "../src/server.ts";
import { harness, testConfig } from "./helpers.ts";

const SESSION = "aaaaaaaa-1111-2222-3333-444444444444";
const OTHER = "bbbbbbbb-1111-2222-3333-444444444444";
const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

type H = ReturnType<typeof harness>;

async function precompact(
  h: H,
  fields: {
    sessionId?: string;
    trigger?: unknown;
    tokens?: unknown;
    ceiling?: unknown;
  },
): Promise<{ ok: boolean; text: string; block?: string }> {
  const client = h.attach(undefined, { role: "cli" });
  const id = 7_000 + Math.floor(Math.random() * 1_000);
  await client.send({
    type: "precompact",
    id,
    ear: "scribe",
    ...(fields as Record<string, never>),
  });
  const result = client.connection.results().find((item) => item.id === id);
  assert.ok(result, "precompact answered");
  return result;
}

async function holdView(
  h: H,
  shim: ReturnType<H["attach"]>,
): Promise<{
  reason: string;
  setAt: number;
  expiresAt: number;
  blocks: number;
} | null> {
  const status = await h.call(shim, "ear_status", {});
  const parsed = JSON.parse(status.text) as {
    ears: Array<{ name: string; hold: unknown }>;
  };
  const ear = parsed.ears.find((item) => item.name === "scribe");
  assert.ok(ear, "scribe in ear_status");
  return ear.hold as never;
}

test("a hold blocks an auto compaction of its own session under the ceiling, says why, and counts it", async () => {
  const h = harness(testConfig(), { nonce: "hold01" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await h.call(shim, "leave_letter", { reason: "r", body: "carry me" });
    const set = await h.call(shim, "hold_compaction", {
      reason: "waiting on CI run 42",
      ttl_seconds: 3_600,
    });
    assert.equal(set.ok, true, set.text);
    assert.match(set.text, /compaction held until/u);
    const view = await holdView(h, shim);
    assert.deepEqual(view, {
      reason: "waiting on CI run 42",
      setAt: h.clock.now(),
      expiresAt: h.clock.now() + 3_600_000,
      blocks: 0,
    });

    const held = await precompact(h, {
      sessionId: SESSION,
      trigger: "auto",
      tokens: 250_000,
    });
    assert.equal(held.ok, true, held.text);
    assert.match(held.block ?? "", /waiting on CI run 42/u);
    assert.match(held.block ?? "", /250000 tokens, under the 600000 ceiling/u);
    assert.match(held.text, /carry me/u, "letters still answer");
    assert.equal((await holdView(h, shim))?.blocks, 1);
    assert.ok(
      h.logs.some((line) => line.includes("compaction.held")),
      "a block is logged",
    );

    // A just-under reading still blocks; the ceiling itself does not.
    const under = await precompact(h, {
      sessionId: SESSION,
      trigger: "auto",
      tokens: HOLD_LIMITS.ceiling - 1,
    });
    assert.ok(under.block);
    const at = await precompact(h, {
      sessionId: SESSION,
      trigger: "auto",
      tokens: HOLD_LIMITS.ceiling,
    });
    assert.equal(at.ok, true);
    assert.equal(
      at.block,
      undefined,
      "at the ceiling the compaction goes ahead",
    );
    assert.equal((await holdView(h, shim))?.blocks, 2);
  } finally {
    h.dispose();
  }
});

test("a hold never blocks manual, an unknown trigger, or a missing or odd token reading", async () => {
  const h = harness(testConfig(), { nonce: "hold02" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await h.call(shim, "hold_compaction", { reason: "wait" });
    const cases: Array<Record<string, unknown>> = [
      { trigger: "manual", tokens: 1_000 },
      { trigger: "AUTO", tokens: 1_000 },
      { tokens: 1_000 },
      { trigger: "auto" },
      { trigger: "auto", tokens: "1000" },
      { trigger: "auto", tokens: 1.5 },
      { trigger: "auto", tokens: -1 },
      { trigger: "auto", tokens: Number.NaN },
      { trigger: "auto", tokens: null },
    ];
    for (const fields of cases) {
      const result = await precompact(h, { sessionId: SESSION, ...fields });
      assert.equal(result.ok, true, JSON.stringify(fields));
      assert.equal(result.block, undefined, JSON.stringify(fields));
    }
    assert.equal((await holdView(h, shim))?.blocks, 0);
    // The control: the same hold does block a plain auto reading.
    const control = await precompact(h, {
      sessionId: SESSION,
      trigger: "auto",
      tokens: 1_000,
    });
    assert.ok(control.block);
  } finally {
    h.dispose();
  }
});

test("a seat's ceiling can only lower the daemon's", async () => {
  const h = harness(testConfig(), { nonce: "hold03" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await h.call(shim, "hold_compaction", { reason: "wait" });
    const ask = (tokens: number, ceiling: unknown) =>
      precompact(h, { sessionId: SESSION, trigger: "auto", tokens, ceiling });
    assert.equal((await ask(300_000, 300_000)).block, undefined);
    assert.ok((await ask(299_999, 300_000)).block);
    // Higher than the daemon's, zero, negative or odd: the daemon's own applies.
    for (const ceiling of [900_000, 0, -5, 1.5, "100", null]) {
      assert.ok(
        (await ask(500_000, ceiling)).block,
        `ceiling ${String(ceiling)} must not lift or drop the default`,
      );
      assert.equal(
        (await ask(HOLD_LIMITS.ceiling, ceiling)).block,
        undefined,
        `ceiling ${String(ceiling)} must not raise the default`,
      );
    }
  } finally {
    h.dispose();
  }
});

test("a hold lapses at its expiry, and release drops it", async () => {
  const h = harness(testConfig(), { nonce: "hold04" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await h.call(shim, "hold_compaction", { reason: "wait", ttl_seconds: 60 });
    const auto = () =>
      precompact(h, { sessionId: SESSION, trigger: "auto", tokens: 1_000 });
    h.clock.advance(59_999);
    assert.ok((await auto()).block, "still held a millisecond before expiry");
    h.clock.advance(1);
    assert.equal((await auto()).block, undefined, "lapsed at expiry");
    assert.equal(await holdView(h, shim), null);

    // Default TTL is 2 h.
    await h.call(shim, "hold_compaction", { reason: "again" });
    assert.equal(
      (await holdView(h, shim))?.expiresAt,
      h.clock.now() + HOLD_LIMITS.defaultTtlS * 1_000,
    );
    const released = await h.call(shim, "hold_compaction", { release: true });
    assert.match(released.text, /hold released/u);
    assert.equal(await holdView(h, shim), null);
    assert.equal((await auto()).block, undefined);
    const again = await h.call(shim, "hold_compaction", { release: true });
    assert.match(again.text, /no hold to release/u);
  } finally {
    h.dispose();
  }
});

test("a hold is its session's alone: another session's compaction, a new attach, or a session change drops or ignores it", async () => {
  const h = harness(testConfig(), { nonce: "hold05" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await h.call(shim, "hold_compaction", { reason: "mine" });
    // Another session's hook is refused outright (#102's fail-closed), so no block.
    const other = await precompact(h, {
      sessionId: OTHER,
      trigger: "auto",
      tokens: 1_000,
    });
    assert.equal(other.ok, false);
    assert.equal(other.block, undefined);

    // Another session takes the ear: the hold goes with the old one.
    const taker = h.attach("scribe", { sessionId: OTHER });
    assert.equal(await holdView(h, taker), null);
    const back = h.attach("scribe", { sessionId: SESSION });
    assert.equal(await holdView(h, back), null, "not restored by coming back");
    assert.equal(
      (
        await precompact(h, {
          sessionId: SESSION,
          trigger: "auto",
          tokens: 1_000,
        })
      ).block,
      undefined,
    );

    // The same session re-attaching (a resume) keeps it.
    await h.call(back, "hold_compaction", { reason: "kept" });
    const resumed = h.attach("scribe", { sessionId: SESSION });
    assert.equal((await holdView(h, resumed))?.reason, "kept");

    // A session message naming a new id drops it.
    await resumed.send({ type: "session", sessionId: OTHER });
    assert.equal(await holdView(h, resumed), null);
  } finally {
    h.dispose();
  }
});

test("hold_compaction checks its arguments and its caller", async () => {
  const h = harness(testConfig(), { nonce: "hold06" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{}, /reason is required/u],
      [{ reason: "   " }, /reason must be 1 to 200/u],
      [{ reason: "x".repeat(201) }, /reason must be 1 to 200/u],
      [{ reason: "x", ttl_seconds: 59 }, /ttl_seconds must be/u],
      [{ reason: "x", ttl_seconds: 21_601 }, /ttl_seconds must be/u],
      [{ reason: "x", ttl_seconds: 90.5 }, /ttl_seconds must be/u],
      [{ reason: "x", ttl_seconds: "soon" }, /ttl_seconds must be/u],
      [{ release: true, reason: "x" }, /release takes no reason/u],
      [{ release: "yes", reason: "x" }, /release must be true/u],
    ];
    for (const [args, pattern] of bad) {
      const result = await h.call(shim, "hold_compaction", args);
      assert.equal(result.ok, false, JSON.stringify(args));
      assert.match(result.text, pattern, JSON.stringify(args));
    }
    assert.equal(await holdView(h, shim), null, "nothing held after refusals");
    for (const ttl of [60, 21_600]) {
      const ok = await h.call(shim, "hold_compaction", {
        reason: "edge",
        ttl_seconds: ttl,
      });
      assert.equal(ok.ok, true, ok.text);
    }

    // A shim that does not hold the ear, and one with no session id.
    const stranger = h.attach("scribe-two" as never, { sessionId: OTHER });
    const refused = await h.call(stranger, "hold_compaction", { reason: "x" });
    assert.equal(refused.ok, false);
    const anon = h.attach("scribe");
    const noId = await h.call(anon, "hold_compaction", { reason: "x" });
    assert.equal(noId.ok, false);
    assert.match(noId.text, /does not know this session's id/u);
  } finally {
    h.dispose();
  }
});

// ---- the hook, through the real CLI --------------------------------------------------

function turn(tokens: number): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: tokens - 110,
        cache_creation_input_tokens: 50,
        output_tokens: 50,
      },
    },
  });
}

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

test("frond-ear precompact --hook exits 2 only for a held auto compaction under the ceiling; every other path exits 0", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-hold-"));
  const socketPath = join(directory, "d.sock");
  const transcript = join(directory, "t.jsonl");
  const big = join(directory, "big.jsonl");
  writeFileSync(transcript, `${turn(250_000)}\n`);
  writeFileSync(big, `${turn(700_000)}\n`);
  const h = harness();
  const server = await listenUnix(h.daemon, socketPath);
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const env = { ...process.env, FROND_EAR_SOCKET: socketPath };
    delete env.FROND_EAR_HOLD_CEILING;
    const hook = (fields: Record<string, unknown>) =>
      JSON.stringify({
        session_id: SESSION,
        hook_event_name: "PreCompact",
        trigger: "auto",
        transcript_path: transcript,
        custom_instructions: null,
        ...fields,
      });
    const args = ["precompact", "--ear", "scribe", "--hook"];

    // No hold yet: stock behavior.
    const none = await run(args, env, hook({}));
    assert.equal(none.code, 0, none.stderr);

    await h.call(shim, "hold_compaction", { reason: "waiting on review" });
    const held = await run(args, env, hook({}));
    assert.equal(held.code, 2, held.stderr);
    assert.equal(held.stdout, "", "nothing for a summary that isn't written");
    assert.match(held.stderr, /held by this session \(waiting on review\)/u);
    assert.match(held.stderr, /250000 tokens/u);

    const cases: Array<[string, NodeJS.ProcessEnv, string]> = [
      ["manual", env, hook({ trigger: "manual" })],
      ["no trigger", env, hook({ trigger: undefined })],
      ["over the ceiling", env, hook({ transcript_path: big })],
      [
        "missing transcript",
        env,
        hook({ transcript_path: join(directory, "gone.jsonl") }),
      ],
      ["no transcript path", env, hook({ transcript_path: undefined })],
      ["another session", env, hook({ session_id: OTHER })],
      [
        "lower seat ceiling",
        { ...env, FROND_EAR_HOLD_CEILING: "200000" },
        hook({}),
      ],
      [
        "daemon down",
        { ...env, FROND_EAR_SOCKET: join(directory, "nobody.sock") },
        hook({}),
      ],
      ["garbage stdin", env, "not json"],
    ];
    for (const [name, caseEnv, stdin] of cases) {
      const result = await run(args, caseEnv, stdin);
      assert.equal(result.code, 0, `${name}: ${result.stderr}`);
    }
    // A seat ceiling that is junk or higher leaves the default, so this still blocks.
    for (const value of ["lots", "900000", "0", "-1"]) {
      const result = await run(
        args,
        { ...env, FROND_EAR_HOLD_CEILING: value },
        hook({}),
      );
      assert.equal(result.code, 2, `ceiling ${value}: ${result.stderr}`);
    }

    // Released: back to exit 0.
    await h.call(shim, "hold_compaction", { release: true });
    const after = await run(args, env, hook({}));
    assert.equal(after.code, 0, after.stderr);
  } finally {
    server.close();
    h.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
