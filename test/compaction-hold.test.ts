// frond-ear#107: a session can hold off its own auto compaction while it waits
// mid-task. The PreCompact hook blocks (exit 2) only for an auto compaction of the
// holding session, before the hold expires, with a fresh transcript reading under the
// seat's own ceiling. Everything else allows: the compaction goes ahead as stock.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HOLD_LIMITS } from "../src/daemon.ts";
import {
  holdReading,
  pendingTokens,
  strictUsageTokens,
  withNotice,
} from "../src/pressure.ts";
import { TOOLS } from "../src/shim.ts";
import { watchdogOutcome } from "../src/watchdog.ts";
import { listenUnix } from "../src/server.ts";
import { harness, testConfig } from "./helpers.ts";

const SESSION = "aaaaaaaa-1111-2222-3333-444444444444";
const OTHER = "bbbbbbbb-1111-2222-3333-444444444444";
const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const CEILING = 600_000;

type H = ReturnType<typeof harness>;
type Shim = ReturnType<H["attach"]>;

async function precompact(
  h: H,
  fields: Record<string, unknown>,
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

/** An auto compaction of SESSION under the ceiling: blocks whenever a hold stands. */
const auto = (h: H, extra: Record<string, unknown> = {}) =>
  precompact(h, {
    sessionId: SESSION,
    trigger: "auto",
    tokens: 250_000,
    ceiling: CEILING,
    ...extra,
  });

async function pressure(
  h: H,
  fields: Record<string, unknown>,
): Promise<{ ok: boolean; text: string; notice?: string }> {
  const client = h.attach(undefined, { role: "cli" });
  const id = 8_000 + Math.floor(Math.random() * 1_000);
  await client.send({
    type: "pressure",
    id,
    ear: "scribe",
    sessionId: SESSION,
    tokens: 250_000,
    band: 1,
    boundary: null,
    at: h.clock.now(),
    ...(fields as Record<string, never>),
  });
  const result = client.connection.results().find((item) => item.id === id);
  assert.ok(result, "pressure answered");
  return result;
}

async function holdView(
  h: H,
  shim: Shim,
): Promise<{
  reason: string;
  setAt: number;
  expiresAt: number;
  blocksAnswered: number;
} | null> {
  const status = await h.call(shim, "ear_status", {});
  const parsed = JSON.parse(status.text) as {
    ears: Array<{ name: string; hold: unknown }>;
  };
  const ear = parsed.ears.find((item) => item.name === "scribe");
  assert.ok(ear, "scribe in ear_status");
  return ear.hold as never;
}

test("a hold blocks an auto compaction of its own session under the seat's ceiling, says why, and counts it", async () => {
  const h = harness(testConfig(), { nonce: "hold01" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await h.call(shim, "leave_letter", { reason: "r", body: "carry me" });
    assert.equal((await auto(h)).block, undefined, "no hold: stock");
    const set = await h.call(shim, "hold_compaction", {
      reason: "waiting on CI run 42",
      ttl_seconds: 3_600,
    });
    assert.equal(set.ok, true, set.text);
    assert.match(set.text, /compaction held until \S+Z, then allowed again/u);
    assert.deepEqual(await holdView(h, shim), {
      reason: "waiting on CI run 42",
      setAt: h.clock.now(),
      expiresAt: h.clock.now() + 3_600_000,
      blocksAnswered: 0,
    });

    const held = await auto(h);
    assert.equal(held.ok, true, held.text);
    assert.match(held.block ?? "", /waiting on CI run 42/u);
    assert.match(held.block ?? "", /about 250000 tokens, under its 600000/u);
    assert.match(held.text, /carry me/u, "letters still answer");
    assert.equal((await holdView(h, shim))?.blocksAnswered, 1);
    const line = h.logs.find((item) => item.includes("compaction.held"));
    assert.ok(line, "a block is logged");
    for (const field of ["aaaaaaaa", "250000", "600000", "expiresAt"]) {
      assert.ok(line.includes(field), `log carries ${field}: ${line}`);
    }

    // Just under blocks; at the ceiling allows; status reads count nothing.
    assert.ok((await auto(h, { tokens: CEILING - 1 })).block);
    assert.equal((await auto(h, { tokens: CEILING })).block, undefined);
    await holdView(h, shim);
    await holdView(h, shim);
    assert.equal((await holdView(h, shim))?.blocksAnswered, 2);
    // Repeated blocks never extend the lease.
    assert.equal(
      (await holdView(h, shim))?.expiresAt,
      h.clock.now() + 3_600_000,
    );
  } finally {
    h.dispose();
  }
});

test("a hold never blocks manual, an unknown trigger, unknown pressure, or an unusable ceiling", async () => {
  const h = harness(testConfig(), { nonce: "hold02" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await h.call(shim, "hold_compaction", { reason: "wait" });
    const cases: Array<Record<string, unknown>> = [
      { trigger: "manual" },
      { trigger: "AUTO" },
      { trigger: undefined },
      { tokens: undefined },
      { tokens: "1000" },
      { tokens: 1.5 },
      { tokens: -1 },
      { tokens: Number.NaN },
      { tokens: null },
      { ceiling: undefined },
      { ceiling: 0 },
      { ceiling: -5 },
      { ceiling: 1.5 },
      { ceiling: "600000" },
      { ceiling: null },
      { ceiling: HOLD_LIMITS.maxCeiling + 1 },
    ];
    for (const fields of cases) {
      const result = await auto(h, fields);
      assert.equal(result.ok, true, JSON.stringify(fields));
      assert.equal(result.block, undefined, JSON.stringify(fields));
    }
    assert.equal((await holdView(h, shim))?.blocksAnswered, 0);
    // The control: the same hold does block a plain auto reading.
    assert.ok((await auto(h)).block);
    assert.ok((await auto(h, { ceiling: HOLD_LIMITS.maxCeiling })).block);
  } finally {
    h.dispose();
  }
});

test("a hold lapses at its expiry and owes the session one notice; its own release owes none", async () => {
  const h = harness(testConfig(), { nonce: "hold04" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await h.call(shim, "hold_compaction", { reason: "wait", ttl_seconds: 60 });
    h.clock.advance(59_999);
    assert.ok((await auto(h)).block, "still held a millisecond before expiry");
    h.clock.advance(1);
    assert.equal((await auto(h)).block, undefined, "lapsed at expiry");
    assert.equal(await holdView(h, shim), null);

    // The notice waits for an event that can show it, then comes once.
    assert.equal((await pressure(h, { event: "Stop" })).notice, undefined);
    assert.equal(
      (await pressure(h, { event: "PostCompact" })).notice,
      undefined,
    );
    const shown = await pressure(h, { event: "PostToolUse" });
    assert.match(shown.notice ?? "", /hold \(wait\) has ended: it expired at/u);
    assert.equal(
      (await pressure(h, { event: "UserPromptSubmit" })).notice,
      undefined,
      "once only",
    );

    // Expiry noticed by a pressure report alone (no compaction attempt).
    await h.call(shim, "hold_compaction", { reason: "quiet", ttl_seconds: 60 });
    h.clock.advance(60_000);
    const quiet = await pressure(h, { event: "UserPromptSubmit" });
    assert.match(quiet.notice ?? "", /hold \(quiet\) has ended: it expired/u);

    // A new hold voids a notice still owed for the old one.
    await h.call(shim, "hold_compaction", { reason: "stale", ttl_seconds: 60 });
    h.clock.advance(60_000);
    assert.equal((await auto(h)).block, undefined, "stale lapsed");
    await h.call(shim, "hold_compaction", {
      reason: "fresh",
      ttl_seconds: 600,
    });
    assert.equal(
      (await pressure(h, { event: "PostToolUse" })).notice,
      undefined,
      "no 'ended' notice while the fresh hold stands",
    );
    await h.call(shim, "hold_compaction", { release: true });

    // Default TTL is 2 h; release drops it and owes nothing.
    await h.call(shim, "hold_compaction", { reason: "again" });
    assert.equal(
      (await holdView(h, shim))?.expiresAt,
      h.clock.now() + HOLD_LIMITS.defaultTtlS * 1_000,
    );
    const released = await h.call(shim, "hold_compaction", { release: true });
    assert.match(released.text, /hold released/u);
    assert.equal(await holdView(h, shim), null);
    assert.equal((await auto(h)).block, undefined);
    assert.equal(
      (await pressure(h, { event: "PostToolUse" })).notice,
      undefined,
    );
    const again = await h.call(shim, "hold_compaction", { release: true });
    assert.match(again.text, /no hold to release/u);
  } finally {
    h.dispose();
  }
});

test("a compaction after the hold ends it even when the marker-only report is missed; one from before never does (#108 F3/F4)", async () => {
  const h = harness(testConfig(), { nonce: "hold08" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const before = h.clock.now();
    h.clock.advance(1_000);
    await h.call(shim, "hold_compaction", { reason: "ci" });
    const setAt = h.clock.now();

    // F4: a marker from before the hold, arriving late, never ends it: with or
    // without boundaryAt, as a marker-only report or with usage, and twice over.
    for (const report of [
      { tokens: null, band: null, boundary: "m0", at: before },
      {
        tokens: null,
        band: null,
        boundary: "m0",
        at: before,
        boundaryAt: before,
      },
      { boundary: "m0", boundaryAt: before, at: setAt + 1 },
      { boundary: "m0", boundaryAt: setAt, at: setAt + 2 },
    ]) {
      h.clock.advance(10);
      await pressure(h, { ...report, event: "PostToolUse" });
      assert.ok(await holdView(h, shim), JSON.stringify(report));
    }
    assert.ok((await auto(h)).block, "still held");

    // F3: the marker-only PostCompact report never came; the next report has
    // usage and the new marker's time, and that ends the hold.
    h.clock.advance(60_000);
    const after = await pressure(h, {
      tokens: 90_000,
      boundary: "m1",
      boundaryAt: h.clock.now() - 5_000,
      at: h.clock.now(),
      event: "PostToolUse",
    });
    assert.equal(await holdView(h, shim), null);
    assert.equal((await auto(h)).block, undefined);
    assert.match(after.notice ?? "", /has ended: a compaction ran/u);
  } finally {
    h.dispose();
  }
});

test("the advertised tool contract says what the hook does (#108 F5)", () => {
  const tool = TOOLS.find((item) => item.name === "hold_compaction");
  assert.ok(tool);
  const text = tool.description;
  for (const needed of [
    "FROND_EAR_HOLD_CEILING",
    "blocks nothing",
    "makes the request fail",
    "after any compaction",
    "manual /compact always runs",
    "blocksAnswered",
  ]) {
    assert.ok(text.includes(needed), `says ${needed}`);
  }
  for (const withdrawn of ["can't be blocked", "600,000", "600000"]) {
    assert.ok(!text.includes(withdrawn), `no longer says ${withdrawn}`);
  }
  const status = TOOLS.find((item) => item.name === "ear_status");
  assert.ok(status?.description.includes("blocksAnswered"));
});

test("a compaction ends the hold: a marker-only reading clears it, whatever kind of compaction ran", async () => {
  const h = harness(testConfig(), { nonce: "hold07" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await h.call(shim, "hold_compaction", { reason: "ci" });
    // A reading with tokens and an old boundary leaves it.
    await pressure(h, { boundary: "old-marker", event: "PostToolUse" });
    assert.ok(await holdView(h, shim));
    h.clock.advance(1_000);
    // The marker-only PostCompact reading ends it (manual /compact included).
    await pressure(h, {
      tokens: null,
      band: null,
      boundary: "new-marker",
      event: "PostCompact",
    });
    assert.equal(await holdView(h, shim), null);
    assert.equal((await auto(h)).block, undefined);
    h.clock.advance(1_000);
    const next = await pressure(h, {
      boundary: "new-marker",
      event: "UserPromptSubmit",
    });
    assert.match(next.notice ?? "", /has ended: a compaction ran/u);
  } finally {
    h.dispose();
  }
});

test("a hold is its session's alone: turnover, A→B→A and a late release never carry or erase it", async () => {
  const h = harness(testConfig(), { nonce: "hold05" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await h.call(shim, "hold_compaction", { reason: "mine" });
    // Another session's hook is refused outright (#102's fail-closed), so no block.
    const other = await precompact(h, {
      sessionId: OTHER,
      trigger: "auto",
      tokens: 1_000,
      ceiling: CEILING,
    });
    assert.equal(other.ok, false);
    assert.equal(other.block, undefined);

    // A→B→A by attach, with nothing set in between: the hold is not resurrected.
    h.attach("scribe", { sessionId: OTHER });
    const home = h.attach("scribe", { sessionId: SESSION });
    assert.equal(await holdView(h, home), null, "A→B→A by attach");
    assert.equal((await auto(h)).block, undefined);
    await h.call(home, "hold_compaction", { reason: "mine again" });

    // Another session takes the ear: the hold goes with the old one.
    const taker = h.attach("scribe", { sessionId: OTHER });
    assert.equal(await holdView(h, taker), null);
    // The superseded shim's late release can't touch the taker's hold.
    await h.call(taker, "hold_compaction", { reason: "taker's" });
    const late = await h.call(shim, "hold_compaction", { release: true });
    assert.equal(late.ok, false, "a detached shim is not the holder");
    assert.equal((await holdView(h, taker))?.reason, "taker's");

    const back = h.attach("scribe", { sessionId: SESSION });
    assert.equal(await holdView(h, back), null, "not restored by coming back");
    assert.equal((await auto(h)).block, undefined);

    // The same session re-attaching (a resume) keeps its hold.
    await h.call(back, "hold_compaction", { reason: "kept" });
    const resumed = h.attach("scribe", { sessionId: SESSION });
    assert.equal((await holdView(h, resumed))?.reason, "kept");

    // An in-place rename A→B drops it, and B→A does not bring it back.
    await resumed.send({ type: "session", sessionId: OTHER });
    assert.equal(await holdView(h, resumed), null);
    await resumed.send({ type: "session", sessionId: SESSION });
    assert.equal(await holdView(h, resumed), null);
    assert.equal((await auto(h)).block, undefined);
  } finally {
    h.dispose();
  }
});

test("hold_compaction checks its arguments and its caller, and a refused set keeps the standing hold", async () => {
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
      [{ reason: "x", ttl_seconds: Number.POSITIVE_INFINITY }, /ttl_seconds/u],
      [{ release: true, reason: "x" }, /release takes no reason/u],
      [{ release: "yes", reason: "x" }, /release must be true/u],
    ];
    for (const [args, pattern] of bad) {
      const result = await h.call(shim, "hold_compaction", args);
      assert.equal(result.ok, false, JSON.stringify(args));
      assert.match(result.text, pattern, JSON.stringify(args));
    }
    assert.equal(await holdView(h, shim), null, "nothing held after refusals");

    await h.call(shim, "hold_compaction", {
      reason: "standing",
      ttl_seconds: 600,
    });
    const standing = await holdView(h, shim);
    for (const [args] of bad) {
      await h.call(shim, "hold_compaction", args);
    }
    assert.deepEqual(
      await holdView(h, shim),
      standing,
      "refusals change nothing",
    );

    for (const ttl of [60, 21_600]) {
      const ok = await h.call(shim, "hold_compaction", {
        reason: "edge",
        ttl_seconds: ttl,
      });
      assert.equal(ok.ok, true, ok.text);
    }

    // A shim with no session id.
    const anon = h.attach("scribe");
    const noId = await h.call(anon, "hold_compaction", { reason: "x" });
    assert.equal(noId.ok, false);
    assert.match(noId.text, /does not know this session's id/u);
  } finally {
    h.dispose();
  }
});

// ---- the reading at PreCompact ------------------------------------------------------

function turn(tokens: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-11-18T20:00:00.000Z",
    message: {
      role: "assistant",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: tokens - 110,
        cache_creation_input_tokens: 50,
        output_tokens: 50,
      },
    },
    ...extra,
  });
}

const marker = JSON.stringify({
  type: "system",
  subtype: "compact_boundary",
  uuid: "m1",
  timestamp: "2026-11-18T20:10:00.000Z",
});

test("holdReading: invalid newest usage is unknown, never a small number or a fall back (#108 F1)", () => {
  const row = (usage: string) =>
    `{"type":"assistant","message":{"role":"assistant","usage":${usage}}}`;
  const big = turn(700_000);
  for (const usage of [
    '{"input_tokens":null,"output_tokens":1}',
    '{"output_tokens":1}',
    '{"input_tokens":1,"output_tokens":null}',
    '{"input_tokens":1}',
    '{"input_tokens":700000,"output_tokens":1,"cache_read_input_tokens":-699999}',
    '{"input_tokens":1e999,"output_tokens":1}',
    '{"input_tokens":1.5,"output_tokens":1}',
    '{"input_tokens":"700000","output_tokens":1}',
    '{"input_tokens":0,"output_tokens":0}',
    '{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":null}',
    "null",
    "[]",
    '"lots"',
  ]) {
    assert.equal(
      holdReading(`${big}\n${row(usage)}\n`).tokens,
      undefined,
      usage,
    );
  }
  // Valid controls: cache counters optional, then summed.
  assert.equal(
    holdReading(`${big}\n${row('{"input_tokens":3,"output_tokens":4}')}\n`)
      .tokens,
    7,
  );
  assert.equal(
    strictUsageTokens({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 0,
    }),
    115,
  );
  // An assistant row with no usage at all is passed over, its bytes pending.
  const bare = '{"type":"assistant","message":{"role":"assistant"}}';
  const passed = holdReading(`${big}\n${bare}\n`);
  assert.equal(passed.tokens, 700_000);
  assert.ok(passed.pendingBytes > Buffer.byteLength(bare));
});

test("holdReading: the latest main usage plus the bytes after it; a newer marker or none means unknown", () => {
  const tool = JSON.stringify({
    type: "user",
    message: { content: "x".repeat(3_000) },
  });
  assert.deepEqual(holdReading(`${turn(250_000)}\n`), {
    tokens: 250_000,
    pendingBytes: 1,
  });
  const after = holdReading(`${turn(250_000)}\n${tool}\n`);
  assert.equal(after.tokens, 250_000);
  assert.equal(after.pendingBytes, Buffer.byteLength(tool) + 2);
  assert.ok(pendingTokens(after.pendingBytes) >= 1_000, "3 bytes a token");

  // A newer sidechain row never supplies tokens, but its bytes count.
  const side = turn(10_000, { isSidechain: true });
  const sided = holdReading(`${turn(250_000)}\n${side}\n`);
  assert.equal(sided.tokens, 250_000);
  assert.ok(sided.pendingBytes > Buffer.byteLength(side));
  // A subagent's own compaction marker is not this session's.
  const sideMarker = JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    uuid: "s1",
    isSidechain: true,
  });
  assert.equal(
    holdReading(`${turn(250_000)}\n${sideMarker}\n`).tokens,
    250_000,
  );
  // An older high main row behind a newer low one: the newer wins.
  assert.equal(
    holdReading(`${turn(900_000)}\n${turn(100_000)}\n`).tokens,
    100_000,
  );
  // A marker newer than every usage row, or no usage at all: unknown.
  assert.equal(holdReading(`${turn(250_000)}\n${marker}\n`).tokens, undefined);
  assert.equal(holdReading(`${tool}\n`).tokens, undefined);
  assert.equal(holdReading("").tokens, undefined);
  // Usage after the marker counts again.
  assert.equal(holdReading(`${marker}\n${turn(40_000)}\n`).tokens, 40_000);
});

test("withNotice: added once to PostToolUse or UserPromptSubmit output, beside any band line", () => {
  const notice = "frond-ear: your compaction hold (x) has ended";
  const band = `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "band line" } })}\n`;
  const merged = JSON.parse(withNotice(band, "PostToolUse", notice)) as {
    hookSpecificOutput: { additionalContext: string };
  };
  assert.equal(
    merged.hookSpecificOutput.additionalContext,
    `band line\n${notice}`,
  );
  const alone = JSON.parse(withNotice("", "UserPromptSubmit", notice)) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  assert.deepEqual(alone.hookSpecificOutput, {
    hookEventName: "UserPromptSubmit",
    additionalContext: notice,
  });
  const stop = '{"decision":"block","reason":"r"}\n';
  assert.equal(withNotice(stop, "Stop", notice), stop);
  assert.equal(withNotice("", "Stop", notice), "");
  assert.equal(withNotice("", "PostCompact", notice), "");
  assert.equal(withNotice(band, "PostToolUse", undefined), band);
});

// ---- the hook, through the real CLI --------------------------------------------------

function run(
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin: string | null,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (code) =>
      resolve({ code, stdout, stderr, ms: Date.now() - started }),
    );
    if (stdin === null) {
      // stdin left open: a hook whose input never ends.
      child.stdin.write('{"session_id":');
    } else {
      child.stdin.end(stdin);
    }
  });
}

test("frond-ear precompact --hook exits 2 only for a held auto compaction under the ceiling; every other path exits 0", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-hold-"));
  const socketPath = join(directory, "d.sock");
  const transcript = join(directory, "t.jsonl");
  const big = join(directory, "big.jsonl");
  const pending = join(directory, "pending.jsonl");
  const compacted = join(directory, "compacted.jsonl");
  writeFileSync(transcript, `${turn(250_000)}\n`);
  writeFileSync(big, `${turn(700_000)}\n`);
  // A low reading, then a tool result big enough to cross the ceiling.
  writeFileSync(
    pending,
    `${turn(250_000)}\n${JSON.stringify({ type: "user", message: { content: "y".repeat(1_200_000) } })}\n`,
  );
  writeFileSync(compacted, `${turn(250_000)}\n${marker}\n`);
  const h = harness();
  const server = await listenUnix(h.daemon, socketPath);
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await h.call(shim, "leave_letter", { reason: "r", body: "the thread" });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FROND_EAR_SOCKET: socketPath,
      FROND_EAR_HOLD_CEILING: String(CEILING),
    };
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

    // No hold yet: stock behavior, letters on stdout.
    const none = await run(args, env, hook({}));
    assert.equal(none.code, 0, none.stderr);
    assert.match(none.stdout, /the thread/u);

    await h.call(shim, "hold_compaction", { reason: "waiting on review" });
    const held = await run(args, env, hook({}));
    assert.equal(held.code, 2, held.stderr);
    assert.equal(held.stdout, "", "nothing for a summary that isn't written");
    assert.match(held.stderr, /held by this session \(waiting on review\)/u);
    assert.match(held.stderr, /about 250001 tokens/u);
    // Node 22 prints its own type-stripping warning; ours is one line.
    assert.equal(
      held.stderr.split("\n").filter((line) => line.startsWith("frond-ear"))
        .length,
      1,
      `one line of ours: ${held.stderr}`,
    );

    const noCeiling = { ...env };
    delete noCeiling.FROND_EAR_HOLD_CEILING;
    const cases: Array<[string, NodeJS.ProcessEnv, string]> = [
      ["manual", env, hook({ trigger: "manual" })],
      ["no trigger", env, hook({ trigger: undefined })],
      ["over the ceiling", env, hook({ transcript_path: big })],
      [
        "pending bytes cross the ceiling",
        env,
        hook({ transcript_path: pending }),
      ],
      ["marker newer than usage", env, hook({ transcript_path: compacted })],
      [
        "missing transcript",
        env,
        hook({ transcript_path: join(directory, "gone.jsonl") }),
      ],
      ["no transcript path", env, hook({ transcript_path: undefined })],
      ["another session", env, hook({ session_id: OTHER })],
      ["no ceiling set", noCeiling, hook({})],
      ["junk ceiling", { ...env, FROND_EAR_HOLD_CEILING: "lots" }, hook({})],
      ["zero ceiling", { ...env, FROND_EAR_HOLD_CEILING: "0" }, hook({})],
      ["lower ceiling", { ...env, FROND_EAR_HOLD_CEILING: "200000" }, hook({})],
      [
        "daemon down",
        { ...env, FROND_EAR_SOCKET: join(directory, "nobody.sock") },
        hook({}),
      ],
      ["garbage stdin", env, "not json"],
      ["oversized stdin", env, `{"x":"${"z".repeat(70 * 1024)}"}`],
    ];
    for (const [name, caseEnv, stdin] of cases) {
      const result = await run(args, caseEnv, stdin);
      assert.equal(result.code, 0, `${name}: ${result.stderr}`);
    }
    // Where letters can be read, an allow still prints them.
    const manual = await run(args, env, hook({ trigger: "manual" }));
    assert.match(manual.stdout, /the thread/u);

    // A hook whose stdin never ends still finishes, and allows.
    const hung = await run(args, env, null);
    assert.equal(hung.code, 0, hung.stderr);
    assert.ok(hung.ms < 6_000, `bounded: ${hung.ms} ms`);

    // Released: back to exit 0, letters on stdout.
    await h.call(shim, "hold_compaction", { release: true });
    const after = await run(args, env, hook({}));
    assert.equal(after.code, 0, after.stderr);
    assert.match(after.stdout, /the thread/u);
  } finally {
    server.close();
    h.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a transcript read that blocks (a FIFO with no writer) still ends by the deadline, and allows (#108 F2)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-fifo-"));
  const socketPath = join(directory, "d.sock");
  const fifo = join(directory, "t.fifo");
  execFileSync("mkfifo", [fifo]);
  const h = harness();
  const server = await listenUnix(h.daemon, socketPath);
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await h.call(shim, "hold_compaction", { reason: "wait" });
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [CLI, "precompact", "--ear", "scribe", "--hook"],
      {
        env: {
          ...process.env,
          FROND_EAR_SOCKET: socketPath,
          FROND_EAR_HOLD_CEILING: String(CEILING),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdin.end(
      JSON.stringify({
        session_id: SESSION,
        hook_event_name: "PreCompact",
        trigger: "auto",
        transcript_path: fifo,
      }),
    );
    // A hard watchdog outside the hook: if it has to fire, the bound failed.
    let killed = false;
    const watchdog = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, 9_000);
    const code = await new Promise<number | null>((resolve) =>
      child.on("close", (value) => resolve(value)),
    );
    clearTimeout(watchdog);
    const ms = Date.now() - started;
    assert.equal(killed, false, `the hook outlived 9 s: ${stderr}`);
    assert.equal(code, 0, stderr);
    assert.equal(stdout, "");
    assert.match(stderr, /deadline \(4000 ms\) passed/u);
    assert.ok(ms >= 3_900 && ms < 7_000, `bounded near 4 s: ${ms} ms`);
  } finally {
    server.close();
    h.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("watchdogOutcome: only a worker's own exit 2 blocks, only its own exit 0 prints letters (#108 F2)", () => {
  const base = { signal: null, overflow: false, out: "letters", err: "why\n" };
  assert.deepEqual(watchdogOutcome({ ...base, code: 2 }), {
    code: 2,
    stdout: "",
    stderr: "why\n",
  });
  assert.deepEqual(watchdogOutcome({ ...base, code: 0 }), {
    code: 0,
    stdout: "letters",
    stderr: "why\n",
  });
  for (const code of [1, 3, 137, null]) {
    assert.deepEqual(
      watchdogOutcome({ ...base, code }),
      { code: 0, stdout: "", stderr: "why\n" },
      `code ${String(code)}`,
    );
  }
  for (const ended of [
    { ...base, code: 2, signal: "SIGTERM" },
    { ...base, code: 0, signal: "SIGKILL" },
    { ...base, code: 2, overflow: true },
    { ...base, code: 0, overflow: true },
  ]) {
    const outcome = watchdogOutcome(ended);
    assert.equal(outcome.code, 0, JSON.stringify(ended));
    assert.equal(outcome.stdout, "", JSON.stringify(ended));
    assert.match(outcome.stderr, /the compaction goes ahead/u);
  }
});
