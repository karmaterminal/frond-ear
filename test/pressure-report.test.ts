// frond-ear#98: the pressure hook hands its reading to the daemon, and ear_status
// shows it. The daemon keeps it only for the session holding the ear, in bounds,
// from a CLI client; the hook's own output and exit code never change because of
// the send.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ClientMessage } from "../src/protocol.ts";
import { listenUnix } from "../src/server.ts";
import { harness } from "./helpers.ts";

const SESSION = "aaaaaaaa-1111-2222-3333-444444444444";
const OTHER = "bbbbbbbb-1111-2222-3333-444444444444";
const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

type H = ReturnType<typeof harness>;
type Report = Omit<Extract<ClientMessage, { type: "pressure" }>, "id">;

function earPressure(h: H, ear = "scribe"): unknown {
  const status = h.daemon.status(ear) as {
    ears: Array<{ name: string; pressure: unknown }>;
  };
  return status.ears.find((entry) => entry.name === ear)?.pressure;
}

function good(h: H, fields: Partial<Report> = {}): Report {
  return {
    type: "pressure",
    ear: "scribe",
    sessionId: SESSION,
    tokens: 212_345,
    band: 1,
    boundary: "c0ffee00-0000-4000-8000-000000000000",
    at: h.clock.now(),
    ...fields,
  };
}

async function report(
  h: H,
  message: Record<string, unknown>,
  role: "cli" | "shim" | "tap" = "cli",
): Promise<{ ok: boolean; text: string }> {
  const client =
    role === "tap"
      ? h.attach(undefined, { role: "tap", ear: "scribe" })
      : h.attach(undefined, { role });
  const id = 9_000 + Math.floor(Math.random() * 1_000);
  await client.send({ ...message, id } as ClientMessage);
  const result = client.connection.results().find((item) => item.id === id);
  assert.ok(result, "pressure answered");
  return result;
}

test("daemon: a report from the session holding the ear shows in ear_status, aging with the clock", async () => {
  const h = harness();
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    assert.equal(earPressure(h), null, "no reading yet");
    const sent = good(h);
    const result = await report(h, sent);
    assert.equal(result.ok, true, result.text);
    assert.deepEqual(earPressure(h), {
      tokens: 212_345,
      band: 1,
      boundary: sent.boundary,
      at: sent.at,
      ageMs: 0,
    });
    h.clock.advance(42_000);
    assert.equal((earPressure(h) as { ageMs: number }).ageMs, 42_000);
    // Never an event: nothing pushed to the session, nothing in the ledger.
    const events = shim.connection.events().length;
    const counts = JSON.stringify(h.store.stateCounts("scribe"));
    await report(h, good(h, { tokens: 300_001, band: 2 }));
    assert.equal(shim.connection.events().length, events);
    assert.equal(JSON.stringify(h.store.stateCounts("scribe")), counts);
    assert.equal((earPressure(h) as { tokens: number }).tokens, 300_001);
    // A reading under the first band carries band null.
    assert.equal(
      (await report(h, good(h, { tokens: 1_000, band: null, boundary: null })))
        .ok,
      true,
    );
    assert.deepEqual(
      (earPressure(h) as { band: unknown; boundary: unknown }).band,
      null,
    );
  } finally {
    h.dispose();
  }
});

test("daemon: refusals leave the reading unchanged (session, ear, role, every bound)", async () => {
  const h = harness();
  try {
    h.attach("scribe", { sessionId: SESSION });
    assert.equal((await report(h, good(h))).ok, true);
    const before = JSON.stringify(earPressure(h));
    const now = h.clock.now();
    const cases: Array<
      [string, Record<string, unknown>, "cli" | "shim" | "tap"]
    > = [
      ["another session", good(h, { sessionId: OTHER }), "cli"],
      ["no session", { ...good(h), sessionId: "" }, "cli"],
      ["unknown ear", good(h, { ear: "nope" }), "cli"],
      ["a shim", good(h), "shim"],
      ["a tap", good(h), "tap"],
      ["tokens negative", good(h, { tokens: -1 }), "cli"],
      ["tokens fractional", good(h, { tokens: 1.5 }), "cli"],
      ["tokens too big", good(h, { tokens: 10_000_001 }), "cli"],
      ["tokens a string", { ...good(h), tokens: "5" }, "cli"],
      ["band negative", good(h, { band: -1 }), "cli"],
      ["band too big", good(h, { band: 32 }), "cli"],
      ["band fractional", good(h, { band: 0.5 }), "cli"],
      ["band a string", { ...good(h), band: "1" }, "cli"],
      ["boundary too long", good(h, { boundary: "x".repeat(81) }), "cli"],
      ["boundary a number", { ...good(h), boundary: 7 }, "cli"],
      ["at too early", good(h, { at: now - 600_001 }), "cli"],
      ["at too late", good(h, { at: now + 600_001 }), "cli"],
      ["at a string", { ...good(h), at: String(now) }, "cli"],
      ["at missing", { ...good(h), at: undefined }, "cli"],
    ];
    for (const [name, message, role] of cases) {
      const result = await report(h, message, role);
      assert.equal(result.ok, false, name);
      assert.equal(JSON.stringify(earPressure(h)), before, name);
    }
    // The edges themselves are in bounds.
    for (const fields of [
      { tokens: 0 },
      { tokens: 10_000_000 },
      { band: 0 },
      { band: 31 },
      { boundary: "x".repeat(80) },
      { at: now - 600_000 },
      { at: now + 600_000 },
    ]) {
      assert.equal(
        (await report(h, good(h, fields))).ok,
        true,
        JSON.stringify(fields),
      );
    }
  } finally {
    h.dispose();
  }
});

test("daemon: a different session attaching clears the reading; the same session keeps it", async () => {
  const h = harness();
  try {
    const first = h.attach("scribe", { sessionId: SESSION });
    assert.equal((await report(h, good(h))).ok, true);
    first.close();
    assert.equal(earPressure(h), null, "detached: no session to show");
    h.attach("scribe", { sessionId: SESSION });
    assert.notEqual(earPressure(h), null, "the same session re-attached");
    h.attach("scribe", { sessionId: OTHER });
    assert.equal(earPressure(h), null);
    h.attach("scribe", { sessionId: SESSION });
    assert.equal(earPressure(h), null, "cleared, not just hidden");
  } finally {
    h.dispose();
  }
});

// ---- the hook, through the real CLI --------------------------------------------------

function turn(tokens: number): string {
  return JSON.stringify({
    type: "assistant",
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
  argv: string[],
  stdin: string,
  env: NodeJS.ProcessEnv,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}> {
  const started = Date.now();
  return new Promise((resolve) => {
    const base = { ...process.env };
    delete base.FROND_EAR_EAR;
    delete base.FROND_EAR_TCP;
    const child = spawn(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", CLI, "pressure", ...argv],
      { env: { ...base, ...env }, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
    child.stdin.end(stdin);
  });
}

/**
 * A fake daemon that records every message. `answer`: "ok" or "refuse" answers a
 * pressure report; "never" welcomes and then never answers.
 */
function fakeDaemon(
  socketPath: string,
  answer: "ok" | "refuse" | "never",
): Promise<{
  server: Server;
  seen: Array<Record<string, unknown>>;
  connections: () => number;
}> {
  const seen: Array<Record<string, unknown>> = [];
  let connections = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
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
        const message = JSON.parse(line) as Record<string, unknown>;
        seen.push(message);
        if (message.type === "hello") {
          socket.write(
            `${JSON.stringify({ type: "welcome", protocol: 1, attached: false, instructions: "" })}\n`,
          );
        } else if (message.type === "pressure" && answer !== "never") {
          socket.write(
            `${JSON.stringify({ type: "result", id: message.id, ok: answer === "ok", text: answer })}\n`,
          );
        }
      }
    });
  });
  const close = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => {
    for (const socket of sockets) socket.destroy();
    return close(cb);
  }) as typeof server.close;
  return new Promise((resolve) =>
    server.listen(socketPath, () =>
      resolve({ server, seen, connections: () => connections }),
    ),
  );
}

function hookFixture(): { dir: string; input: string; transcript: string } {
  const dir = mkdtempSync(join(tmpdir(), "fe-pressure-report-"));
  const transcript = join(dir, "s.jsonl");
  writeFileSync(transcript, `${turn(90_000)}\n${turn(212_345)}\n`);
  const input = JSON.stringify({
    session_id: SESSION,
    transcript_path: transcript,
    hook_event_name: "PostToolUse",
  });
  return { dir, input, transcript };
}

test("hook → daemon: one pressure message with the reading; stdout and exit code unchanged", async () => {
  const { dir, input } = hookFixture();
  const socket = join(dir, "d.sock");
  const fake = await fakeDaemon(socket, "ok");
  try {
    // Today's output: no ear named, its own state dir.
    const baseline = await run(["--hook"], input, {
      XDG_STATE_HOME: join(dir, "state-a"),
      FROND_EAR_SOCKET: socket,
    });
    assert.equal(fake.connections(), 0, "no ear: no connection");
    const before = Date.now();
    const sent = await run(["--hook", "--ear", "scribe"], input, {
      XDG_STATE_HOME: join(dir, "state-b"),
      FROND_EAR_SOCKET: socket,
    });
    assert.equal(sent.code, 0);
    assert.equal(sent.stderr, "");
    assert.notEqual(baseline.stdout, "", "the 200k band is announced");
    assert.equal(sent.stdout, baseline.stdout);
    const reports = fake.seen.filter((m) => m.type === "pressure");
    assert.equal(reports.length, 1);
    const [message] = reports as Array<Record<string, unknown>>;
    assert.equal(fake.seen[0]?.role, "cli", "hello as a CLI client");
    assert.deepEqual(
      { ...message, at: undefined, id: undefined },
      {
        type: "pressure",
        id: undefined,
        ear: "scribe",
        sessionId: SESSION,
        tokens: 212_345,
        band: 1,
        boundary: null,
        at: undefined,
      },
    );
    assert.ok(
      typeof message?.at === "number" &&
        message.at >= before - 1_000 &&
        message.at <= Date.now(),
    );
    // FROND_EAR_EAR names the ear too; a same-band run still sends (fresh `at`).
    const again = await run(["--hook"], input, {
      XDG_STATE_HOME: join(dir, "state-b"),
      FROND_EAR_SOCKET: socket,
      FROND_EAR_EAR: "scribe",
    });
    assert.equal(again.stdout, "", "same band: no line");
    assert.equal(fake.seen.filter((m) => m.type === "pressure").length, 2);
  } finally {
    fake.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook: a down or refusing daemon changes nothing; stderr stays empty, exit 0", async () => {
  const { dir, input } = hookFixture();
  const socket = join(dir, "d.sock");
  try {
    const baseline = await run(["--hook"], input, {
      XDG_STATE_HOME: join(dir, "state-a"),
    });
    const down = await run(["--hook", "--ear", "scribe"], input, {
      XDG_STATE_HOME: join(dir, "state-b"),
      FROND_EAR_SOCKET: join(dir, "nobody.sock"),
    });
    assert.deepEqual(
      [down.code, down.stdout, down.stderr],
      [0, baseline.stdout, ""],
    );
    const fake = await fakeDaemon(socket, "refuse");
    try {
      const refused = await run(["--hook", "--ear", "scribe"], input, {
        XDG_STATE_HOME: join(dir, "state-c"),
        FROND_EAR_SOCKET: socket,
      });
      assert.deepEqual(
        [refused.code, refused.stdout, refused.stderr],
        [0, baseline.stdout, ""],
      );
      assert.equal(fake.seen.filter((m) => m.type === "pressure").length, 1);
    } finally {
      fake.server.close();
    }
    // A malformed FROND_EAR_TCP is a send failure too, not a hook failure.
    const badTcp = await run(["--hook", "--ear", "scribe"], input, {
      XDG_STATE_HOME: join(dir, "state-d"),
      FROND_EAR_TCP: "no-port",
    });
    assert.deepEqual(
      [badTcp.code, badTcp.stdout, badTcp.stderr],
      [0, baseline.stdout, ""],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook: a daemon that never answers is abandoned within the timeout", async () => {
  const { dir, input } = hookFixture();
  const socket = join(dir, "d.sock");
  const fake = await fakeDaemon(socket, "never");
  try {
    const quick = await run(["--hook"], input, {
      XDG_STATE_HOME: join(dir, "state-a"),
    });
    const slow = await run(["--hook", "--ear", "scribe"], input, {
      XDG_STATE_HOME: join(dir, "state-b"),
      FROND_EAR_SOCKET: socket,
    });
    assert.equal(slow.code, 0);
    assert.equal(slow.stdout, quick.stdout);
    assert.equal(slow.stderr, "");
    assert.equal(fake.seen.filter((m) => m.type === "pressure").length, 1);
    // The send's budget is 1 s; node's own start-up is measured by the quick run.
    assert.ok(
      slow.ms - quick.ms < 1_500,
      `slow ${slow.ms}ms vs quick ${quick.ms}ms`,
    );
  } finally {
    fake.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook → real daemon: ear_status shows the hook's reading", async () => {
  const { dir, input } = hookFixture();
  const socketPath = join(dir, "d.sock");
  const h = harness();
  h.clock.value = Date.now();
  const server = await listenUnix(h.daemon, socketPath);
  try {
    h.attach("scribe", { sessionId: SESSION });
    const result = await run(["--hook", "--ear", "scribe"], input, {
      XDG_STATE_HOME: join(dir, "state"),
      FROND_EAR_SOCKET: socketPath,
    });
    assert.equal(result.code, 0);
    const pressure = earPressure(h) as { tokens: number; band: number };
    assert.equal(pressure.tokens, 212_345);
    assert.equal(pressure.band, 1);
    // Another session's hook is refused by the real daemon, and still exits 0.
    const other = await run(
      ["--hook", "--ear", "scribe"],
      input.replace(SESSION, OTHER),
      { XDG_STATE_HOME: join(dir, "state"), FROND_EAR_SOCKET: socketPath },
    );
    assert.deepEqual([other.code, other.stderr], [0, ""]);
    assert.equal((earPressure(h) as { tokens: number }).tokens, 212_345);
  } finally {
    server.close();
    h.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
