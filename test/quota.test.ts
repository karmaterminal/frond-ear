// Quota bands for a Claude seat (figs, 2026-11-26): the pressure hook says the level once per change.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runPressureCommand } from "../src/pressure.ts";
import {
  QUOTA_TTL_MS,
  latestSample,
  loadAnnounced,
  quotaDir,
  saveAnnounced,
  saveSample,
  quotaNotice,
  quotaReading,
  quotaStep,
  readQuota,
  type QuotaFetch,
} from "../src/quota.ts";

const NOW = Date.parse("2026-11-26T09:00:00Z");
const TOKEN = "sk-ant-oat01-NEVER-PRINT-ME";
const inDays = (d: number) => new Date(NOW + d * 86_400_000).toISOString();
const body = (weekly: number | null, resetDays = 4, extra: object = {}) => ({
  five_hour: null,
  seven_day:
    weekly === null
      ? null
      : { utilization: weekly, resets_at: inDays(resetDays), ...extra },
});

function seat(): NodeJS.ProcessEnv {
  const config = mkdtempSync(join(tmpdir(), "quota-config-"));
  writeFileSync(
    join(config, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: { accessToken: TOKEN, refreshToken: "REFRESH-NEVER-USED" },
    }),
  );
  return {
    CLAUDE_CONFIG_DIR: config,
    XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "quota-state-")),
    FROND_EAR_QUOTA: "claude",
  };
}

function server(responses: Array<object | number>) {
  const calls: RequestInit[] = [];
  const impl: QuotaFetch = async (_url, init) => {
    calls.push(init);
    const next = responses.length > 1 ? responses.shift()! : responses[0]!;
    return typeof next === "number"
      ? new Response("{}", { status: next })
      : new Response(JSON.stringify(next), { status: 200 });
  };
  return { impl, calls };
}

test("levels: ok, burn near a reset, near, exhausted by percent or lock, unknown", () => {
  assert.equal(quotaReading(body(16, 4.9), NOW).level, "ok");
  assert.equal(quotaReading(body(2, 1.1), NOW).level, "burn");
  assert.equal(quotaReading(body(60, 1.1), NOW).level, "ok"); // over half used: not burn
  assert.equal(quotaReading(body(90), NOW).level, "near");
  assert.equal(quotaReading(body(100), NOW).level, "exhausted");
  assert.equal(
    quotaReading(body(40, 4, { locked_reason: "weekly_limit" }), NOW).level,
    "exhausted",
  );
  assert.equal(
    quotaReading({ five_hour: { utilization: 97 }, seven_day: null }, NOW)
      .level,
    "near",
  );
  assert.equal(quotaReading(body(null), NOW).level, "unknown");
  assert.equal(quotaReading("nonsense", NOW).level, "unknown");
});

test("step: a first ok is silent, a first non-ok is said, each change is said once", () => {
  assert.equal(quotaStep("ok", undefined), false);
  assert.equal(quotaStep("burn", undefined), true);
  assert.equal(quotaStep("burn", "burn"), false);
  assert.equal(quotaStep("ok", "burn"), true);
});

test("the notice is opt-in, reads at most once per TTL, and says each change once", async () => {
  const env = seat();
  const api = server([body(2, 1.1)]);
  assert.equal(
    await quotaNotice({ ...env, FROND_EAR_QUOTA: undefined }, NOW, api.impl),
    undefined,
  );
  assert.equal(api.calls.length, 0, "off unless FROND_EAR_QUOTA=claude");

  const first = await quotaNotice(env, NOW, api.impl);
  assert.match(first ?? "", /weekly 2% used.*burn/u);
  assert.equal(await quotaNotice(env, NOW + 60_000, api.impl), undefined);
  assert.equal(api.calls.length, 1, "cached within the TTL");

  const later = server([body(90)]);
  const near = await quotaNotice(env, NOW + QUOTA_TTL_MS + 1, later.impl);
  assert.match(near ?? "", /near a limit/u);
  assert.equal(later.calls.length, 1);
});

test("the token goes only in the request header: never in a line, the cache, or the CLI JSON", async () => {
  const env = seat();
  const api = server([body(100)]);
  const line = await quotaNotice(env, NOW, api.impl);
  assert.match(line ?? "", /exhausted/u);
  assert.ok(!(line ?? "").includes(TOKEN));
  const headers = api.calls[0]!.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
  const dir = quotaDir(env);
  for (const name of readdirSync(dir)) {
    const text = readFileSync(`${dir}/${name}`, "utf8");
    assert.ok(!text.includes(TOKEN) && !text.includes("REFRESH"), name);
  }
  const reading = JSON.stringify(await readQuota(env, NOW, api.impl));
  assert.ok(!reading.includes(TOKEN));
});

test("an expired token or a failed request is unknown, said once, and never throws", async () => {
  const env = seat();
  const expired = server([401]);
  assert.match(
    (await quotaNotice(env, NOW, expired.impl)) ?? "",
    /unknown \(access token expired/u,
  );
  const failing: QuotaFetch = async () => {
    throw new Error("network down");
  };
  assert.equal(
    await quotaNotice(env, NOW + QUOTA_TTL_MS + 1, failing),
    undefined,
    "still unknown: not said again",
  );
  const noCreds = { ...seat(), CLAUDE_CONFIG_DIR: "/nonexistent" };
  assert.equal((await readQuota(noCreds, NOW)).level, "unknown");
});

test("the pressure hook adds the quota line as added context on PostToolUse", async (t) => {
  const env = seat();
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body(2, 1.1)), {
      status: 200,
    })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let out = "";
  const code = await runPressureCommand(["--hook"], {
    stdin: JSON.stringify({ hook_event_name: "PostToolUse" }),
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: () => true },
    env,
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(out) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(
    parsed.hookSpecificOutput.additionalContext,
    /frond-ear quota: weekly 2% used/u,
  );
  out = "";
  await runPressureCommand(["--hook"], {
    stdin: JSON.stringify({ hook_event_name: "Stop" }),
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: () => true },
    env: { ...seat() },
  });
  assert.equal(out, "", "never on Stop");
});

test("🌫 #129: each session hears its own first warning; one session can't consume another's", async () => {
  const env = seat();
  const api = server([body(2, 1.1)]);
  assert.match(
    (await quotaNotice(env, NOW, api.impl, "session-a")) ?? "",
    /burn/u,
  );
  assert.match(
    (await quotaNotice(env, NOW + 1_000, api.impl, "session-b")) ?? "",
    /burn/u,
    "session b still hears burn",
  );
  assert.equal(
    await quotaNotice(env, NOW + 2_000, api.impl, "session-a"),
    undefined,
  );
  assert.equal(api.calls.length, 1, "the reading itself stays shared");
});

test("🌫 #129: a slower, older read never overwrites a newer one", async () => {
  const env = seat();
  let releaseOld!: () => void;
  const oldGate = new Promise<void>((resolve) => (releaseOld = resolve));
  const slowNear: QuotaFetch = async () => {
    await oldGate;
    return new Response(JSON.stringify(body(90)), { status: 200 });
  };
  const fastExhausted = server([body(100)]);
  const older = quotaNotice(env, NOW, slowNear, "session-a"); // starts first, answers last
  const newer = await quotaNotice(
    env,
    NOW + 5_000,
    fastExhausted.impl,
    "session-b",
  );
  assert.match(newer ?? "", /exhausted/u);
  releaseOld();
  await older;
  assert.equal(
    latestSample(quotaDir(env))?.reading.level,
    "exhausted",
    "the older near did not replace it",
  );
});

test("🪨 #129: an older save after a newer one, and two sessions at once, lose nothing", () => {
  const env = seat();
  const dir = quotaDir(env);
  saveSample(dir, { at: NOW + 5_000, reading: { level: "exhausted" } });
  saveSample(dir, { at: NOW, reading: { level: "near" } }); // renamed last, taken first
  assert.equal(latestSample(dir)?.reading.level, "exhausted");
  saveAnnounced(dir, "session-a", "near", NOW);
  saveAnnounced(dir, "session-b", "exhausted", NOW);
  assert.equal(loadAnnounced(dir, "session-a"), "near");
  assert.equal(loadAnnounced(dir, "session-b"), "exhausted");
  for (let n = 0; n < 10; n += 1)
    saveSample(dir, { at: NOW + 10_000 + n, reading: { level: "ok" } });
  assert.ok(
    readdirSync(dir).filter((f) => f.startsWith("r-")).length <= 4,
    "readings pruned",
  );
  assert.equal(latestSample(dir)?.at, NOW + 10_009);
});

test("🪨 #129: two hooks of the same session racing: the newer level survives; a raced change is said at most twice", () => {
  const env = seat();
  const dir = quotaDir(env);
  // Hook X (newer) and hook Y (older) of one session, Y's write landing last.
  assert.equal(saveAnnounced(dir, "session-a", "exhausted", NOW + 5_000), true);
  assert.equal(
    saveAnnounced(dir, "session-a", "near", NOW),
    false,
    "the older write is not the newest",
  );
  assert.equal(loadAnnounced(dir, "session-a"), "exhausted");
  // The same change raced by two hooks: no atomic claim, so both may say it (the documented bound is
  // at most twice); what never happens is an older level after a newer one.
  const first = saveAnnounced(dir, "session-b", "burn", NOW);
  const second = saveAnnounced(dir, "session-b", "burn", NOW);
  assert.ok(first || second, "at least one says it");
  assert.equal(loadAnnounced(dir, "session-b"), "burn");
  assert.ok(
    readdirSync(dir).filter((f) => f.startsWith("a-session-a~")).length <= 2,
    "pruned",
  );
});
