// `frond-ear pressure` (figs, 11-14): a Claude Code session's context size, read
// from its own transcript, as one line of added context on crossing into a new band.
// Pure parts in-process; the hook itself through the real CLI with a temp
// transcript and state dir.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_BANDS,
  latestContextTokens,
  latestReading,
  parseBands,
  pressureLine,
  step,
} from "../src/pressure.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

function assistant(usage: Record<string, number>): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", usage },
  });
}

function turn(tokens: number): string {
  return assistant({
    input_tokens: 10,
    cache_read_input_tokens: tokens - 110,
    cache_creation_input_tokens: 50,
    output_tokens: 50,
  });
}

test("latest usage: the last assistant turn, all input kinds plus output", () => {
  const transcript = [
    '{"type":"assistant","message":{"usage":{"input_tokens":5}}', // a cut first line
    turn(120_000),
    JSON.stringify({ type: "user", message: { usage: { input_tokens: 9 } } }),
    turn(210_000),
    JSON.stringify({ type: "system", subtype: "x" }),
    "",
  ].join("\n");
  assert.equal(latestContextTokens(transcript), 210_000);
  assert.equal(latestContextTokens('{"type":"user"}\n'), undefined);
  assert.equal(
    latestContextTokens(assistant({ input_tokens: 0, output_tokens: 0 })),
    undefined,
  );
});

test("bands: announce once per band, the highest crossed, and again after a compaction", () => {
  const bands = [100, 200, 300];
  let r = step(undefined, 50, bands);
  assert.equal(r.announce, undefined);
  r = step(r.state, 150, bands);
  assert.equal(r.announce, 0);
  r = step(r.state, 180, bands);
  assert.equal(r.announce, undefined, "same band: quiet");
  r = step(r.state, 320, bands);
  assert.equal(r.announce, 2, "skipped band 1: announce the highest");
  r = step(r.state, 350, bands);
  assert.equal(r.announce, undefined);
  r = step(r.state, 120, bands);
  assert.equal(r.announce, 0, "a drop to under half starts the bands again");
  r = step(r.state, 110, bands);
  assert.equal(r.announce, undefined);
});

test("bands: a drop that isn't a compaction keeps the announced band", () => {
  const bands = [100, 200];
  let r = step(undefined, 250, bands);
  assert.equal(r.announce, 1);
  r = step(r.state, 190, bands);
  assert.equal(r.announce, undefined);
  r = step(r.state, 210, bands);
  assert.equal(r.announce, undefined);
});

function marker(uuid: string): string {
  return JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    uuid,
    compactMetadata: { trigger: "auto" },
  });
}

test("reading: only usage after the latest compaction marker counts", () => {
  assert.deepEqual(latestReading(`${turn(90_000)}\n${turn(160_000)}\n`), {
    tokens: 160_000,
    boundary: null,
  });
  assert.deepEqual(
    latestReading(`${turn(400_000)}\n${marker("m-1")}\n`),
    { boundary: "m-1" },
    "compacted, no turn since: nothing to read",
  );
  assert.deepEqual(
    latestReading(
      `${marker("m-0")}\n${turn(400_000)}\n${marker("m-1")}\n${turn(30_000)}\n${turn(31_000)}\n`,
    ),
    { tokens: 31_000, boundary: "m-1" },
  );
  // A marker with no uuid or timestamp gets an id from its own bytes, so it stays
  // the same as the tail slides (🌿's review on #96).
  const bare = JSON.stringify({ type: "system", subtype: "compact_boundary" });
  const a = latestReading(`${bare}\n${turn(20_000)}\n`).boundary;
  const b = latestReading(
    `${turn(1)}\n${turn(2)}\n${bare}\n${turn(20_000)}\n${turn(21_000)}\n`,
  ).boundary;
  assert.match(a ?? "", /^sha256:[0-9a-f]{16}$/u);
  assert.equal(a, b);
});

test("bands: a new compaction marker starts them again, even when over half is kept", () => {
  const bands = [100, 200, 300];
  let r = step(undefined, 250, bands, null);
  assert.equal(r.announce, 1);
  assert.equal(r.state.boundary, null);
  r = step(r.state, 210, bands, "m-1");
  assert.equal(r.announce, 1, "a marker the state hadn't seen: announce again");
  r = step(r.state, 220, bands, "m-1");
  assert.equal(r.announce, undefined, "same marker: quiet");
  r = step(r.state, 230, bands, null);
  assert.equal(
    r.announce,
    undefined,
    "marker slid out of the tail: still quiet",
  );
  assert.equal(r.state.boundary, "m-1", "and still the latest seen");
  r = step(r.state, 240, bands, "m-2");
  assert.equal(r.announce, 1);
});

test("bands: state from before markers were read takes the first marker as known", () => {
  const legacy = { band: 1, tokens: 250 };
  const r = step(legacy, 260, [100, 200, 300], "m-old");
  assert.equal(r.announce, undefined);
  assert.equal(r.state.boundary, "m-old");
});

test("--bands parses k and M, and refuses bands that don't rise", () => {
  assert.deepEqual(
    parseBands("150k,1.5M,2000000"),
    [150_000, 1_500_000, 2_000_000],
  );
  assert.deepEqual(parseBands(undefined), DEFAULT_BANDS);
  assert.throws(() => parseBands("200k,150k"), /must rise/u);
  assert.throws(() => parseBands("lots"), /not a token count/u);
});

test("the line names the size, the no-warning fact and leave_letter", () => {
  const line = pressureLine(236_000, 1, [150_000, 200_000]);
  assert.match(line, /~236k tokens/u);
  assert.match(line, /past the 200k band, the last one/u);
  assert.match(line, /no warning/u);
  assert.match(line, /leave_letter\(reason, body, assumed\)/u);
});

function run(
  argv: string[],
  stdin: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Node 22 prints an ExperimentalWarning for node:sqlite on import; the
    // stderr assertions are about the CLI's own output, so drop that one kind.
    const child = spawn(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", CLI, "pressure", ...argv],
      {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.end(stdin);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("--hook: added-context JSON on a new band, quiet after, state per session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fe-pressure-"));
  try {
    const transcript = join(dir, "s.jsonl");
    writeFileSync(transcript, `${turn(90_000)}\n${turn(160_000)}\n`);
    const env = { XDG_STATE_HOME: join(dir, "state") };
    const input = JSON.stringify({
      session_id: "s-1",
      transcript_path: transcript,
      hook_event_name: "PostToolUse",
      tool_response: { stdout: "x".repeat(200_000) },
    });
    const first = await run(["--hook"], input, env);
    assert.equal(first.code, 0);
    const out = JSON.parse(first.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(out.hookSpecificOutput.additionalContext, /~160k tokens/u);
    const again = await run(["--hook"], input, env);
    assert.equal(again.code, 0);
    assert.equal(again.stdout, "", "same band: nothing");
    const state = JSON.parse(
      readFileSync(
        join(dir, "state", "frond-ear", "pressure", "s-1.json"),
        "utf8",
      ),
    ) as { band: number };
    assert.equal(state.band, 0);
    const other = await run(
      ["--hook"],
      JSON.stringify({
        session_id: "s-2",
        transcript_path: transcript,
        hook_event_name: "UserPromptSubmit",
      }),
      env,
    );
    assert.match(other.stdout, /"hookEventName":"UserPromptSubmit"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--hook never blocks: bad stdin, a missing transcript, bad bands all print nothing and exit 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fe-pressure-"));
  try {
    const env = { XDG_STATE_HOME: join(dir, "state") };
    for (const [argv, stdin] of [
      [["--hook"], "not json"],
      [["--hook"], "{}"],
      [
        ["--hook"],
        JSON.stringify({ session_id: "s", transcript_path: join(dir, "nope") }),
      ],
      [["--hook", "--bands", "nonsense"], "{}"],
      // argument-parse failures (🌫's review on #95): a missing value, an
      // unknown flag, a value given to the boolean
      [["--hook", "--bands"], "{}"],
      [["--bands", "--hook"], "{}"],
      [["--hook", "--nope"], "{}"],
      [["--hook=yes"], "{}"],
    ] as const) {
      const result = await run([...argv], stdin, env);
      assert.equal(result.code, 0, `${argv.join(" ")} / ${stdin}`);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "", `${argv.join(" ")}: quiet`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without --hook, a bad flag is still a usage error", async () => {
  for (const argv of [
    ["--bands"],
    ["--nope"],
    ["--transcript", "x", "--bands", "1k,1k"],
    [],
  ]) {
    const result = await run(argv, "", {});
    assert.equal(result.code, 2, argv.join(" "));
    assert.notEqual(result.stderr, "", `${argv.join(" ")}: says why`);
  }
});

test("--hook across a compaction that keeps over half: announces again, quiet before the first turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fe-pressure-"));
  try {
    const transcript = join(dir, "s.jsonl");
    const env = { XDG_STATE_HOME: join(dir, "state") };
    const input = JSON.stringify({
      session_id: "s-m",
      transcript_path: transcript,
      hook_event_name: "PostToolUse",
    });
    writeFileSync(transcript, `${marker("m-0")}\n${turn(320_000)}\n`);
    assert.match((await run(["--hook"], input, env)).stdout, /~320k tokens/u);
    writeFileSync(
      transcript,
      `${marker("m-0")}\n${turn(320_000)}\n${marker("m-1")}\n`,
    );
    assert.equal(
      (await run(["--hook"], input, env)).stdout,
      "",
      "compacted, no turn yet: the old size is not read as the new one",
    );
    writeFileSync(
      transcript,
      `${marker("m-0")}\n${turn(320_000)}\n${marker("m-1")}\n${turn(310_000)}\n`,
    );
    assert.match(
      (await run(["--hook"], input, env)).stdout,
      /~310k tokens \(past the 300k band/u,
      "kept over half, but a new marker: the bands start again",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--transcript prints the reading for a person", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fe-pressure-"));
  try {
    const transcript = join(dir, "s.jsonl");
    writeFileSync(transcript, `${turn(236_000)}\n`);
    const result = await run(["--transcript", transcript], "", {});
    assert.equal(result.code, 0);
    assert.equal(
      result.stdout,
      "~236k tokens in context, past the 200k band\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
