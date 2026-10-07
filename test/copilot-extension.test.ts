// End-to-end for the Copilot CLI target: a real dry-run daemon and unix socket, the real
// installer, and the installed core.mjs driven by a fake `joinSession` standing in for
// the Copilot CLI. Nothing touches Discord or Copilot.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { targetAdvice } from "../src/advice.ts";
import { detachedNotice } from "../src/render.ts";
import { BOT, CHANNEL, GUILD, PRINCIPAL } from "./helpers.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

interface Sent {
  prompt: string;
  source?: string;
  mode?: string;
}
interface ToolFailure {
  textResultForLlm: string;
  resultType: "failure" | "timeout";
  error: string;
}
interface Tool {
  name: string;
  parameters: unknown;
  handler: (args: Record<string, unknown>) => Promise<string | ToolFailure>;
}

/** A successful tool call returns plain text; anything else is a failure. */
function text(result: string | ToolFailure): string {
  assert.equal(typeof result, "string", JSON.stringify(result));
  return result as string;
}

async function waitFor<T>(
  probe: () => T | undefined,
  what: string,
  ms = 10_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function run(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

test("copilot extension: install, attach, canary, <channel> push via session.send, tools, offered→seen", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-copilot-"));
  const socket = join(directory, "run", "daemon.sock");
  const configPath = join(directory, "frond-ear.json");
  const extDir = join(directory, "copilot-home", "extensions", "frond-ear");
  writeFileSync(
    configPath,
    JSON.stringify({
      botUserId: BOT,
      principals: [PRINCIPAL],
      labels: { [PRINCIPAL]: "figs" },
      ears: {
        walker: {
          target: "copilot-extension",
          attachCanary: true,
          channels: { [CHANNEL]: "mentions" },
        },
      },
      defaults: { quietWindowMs: 300, maxDelayMs: 2_000, priorityQuietMs: 100 },
    }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FROND_EAR_CONFIG: configPath,
    FROND_EAR_DATABASE: join(directory, "state", "ear.db"),
    FROND_EAR_SOCKET: socket,
    FROND_EAR_BOT_USER_ID: BOT,
    COPILOT_HOME: join(directory, "copilot-home"),
  };
  delete env.DISCORD_BOT_TOKEN;
  delete env.DISCORD_BOT_TOKEN_FILE;

  const daemon: ChildProcess = spawn(
    process.execPath,
    [CLI, "daemon", "--dry-run"],
    { env, stdio: ["ignore", "ignore", "inherit"] },
  );
  let ext: { stop(): void; settled(): Promise<void> } | undefined;
  t.after(async () => {
    ext?.stop();
    daemon.kill("SIGTERM");
    await new Promise((resolve) => daemon.once("close", resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  await waitFor(() => (existsSync(socket) ? true : undefined), "daemon socket");

  // The installer writes both modules and a 0600 config with the shim's tools.
  const installed = await run(["copilot-extension", "--ear", "walker"], env);
  assert.equal(installed.code, 0);
  assert.match(installed.stdout, /installed frond-ear Copilot extension/u);
  for (const file of ["core.mjs", "extension.mjs", "config.json"]) {
    assert.ok(existsSync(join(extDir, file)), file);
  }
  assert.equal(statSync(join(extDir, "config.json")).mode & 0o777, 0o600);
  const config = JSON.parse(
    readFileSync(join(extDir, "config.json"), "utf8"),
  ) as { ear: string; socket: string; tools: Array<{ name: string }> };
  assert.equal(config.ear, "walker");
  assert.equal(config.socket, socket);
  assert.ok(config.tools.some((tool) => tool.name === "reply"));

  // The installed core, with a fake Copilot session.
  const sent: Sent[] = [];
  let tools: Tool[] = [];
  const { start } = (await import(
    pathToFileURL(join(extDir, "core.mjs")).href
  )) as {
    start: (
      join: (o: { tools: Tool[] }) => Promise<unknown>,
      config: unknown,
    ) => Promise<{ stop(): void; settled(): Promise<void> }>;
  };
  ext = await start(async (options) => {
    tools = options.tools;
    return {
      sessionId: "copilot-session-1",
      send: async (message: Sent) => {
        sent.push(message);
        return "msg-id";
      },
      log: async () => undefined,
    };
  }, config);
  const tool = (name: string) => tools.find((item) => item.name === name)!;
  assert.deepEqual(
    tools.map((item) => item.name).sort(),
    config.tools.map((item) => item.name).sort(),
  );

  // First push: instructions preamble, then the canary as a <channel> element.
  const canary = await waitFor(
    () => sent.find((item) => item.prompt.includes('kind="attach"')),
    "attach canary",
  );
  assert.equal(canary.source, "system");
  assert.equal(canary.mode, "enqueue");
  assert.match(
    canary.prompt,
    /^frond-ear is your own ear on Discord \(this session is ear "walker"\)[\s\S]*\n\n<channel source="frond-ear" kind="attach"/u,
  );
  const nonce = /nonce="([^"]+)"/u.exec(canary.prompt)?.[1];
  assert.ok(nonce);
  text(await tool("ack").handler({ nonce }));
  const status = JSON.parse(text(await tool("ear_status").handler({}))) as {
    ears: Array<{ registered: boolean; sessionId: string }>;
  };
  assert.equal(status.ears[0]?.registered, true);
  assert.equal(status.ears[0]?.sessionId, "copilot-session-1");

  // A principal mention arrives as a pushed <channel> element; no second preamble.
  const injected = await run(
    [
      "inject",
      "--chat",
      CHANNEL,
      "--guild",
      GUILD,
      "--author",
      PRINCIPAL,
      "--name",
      "figs",
      "--mention",
      "walker, status please",
    ],
    env,
  );
  assert.equal(injected.code, 0);
  const mention = await waitFor(
    () => sent.find((item) => item.prompt.includes('kind="mention"')),
    "mention",
  );
  assert.match(
    mention.prompt,
    /^<channel source="frond-ear" [^>]*chat_id="700000000000000007"[^>]*trust="principal"[^>]*>\n[\s\S]*> <@100000000000000001> walker, status please\n<\/channel>$/u,
  );
  // passed back exactly as shown: the pushed id carries the daemon's delivery token (#30)
  const batchId = /batch_id="(\d+-[0-9a-f]+)"/u.exec(mention.prompt)?.[1];
  assert.ok(batchId);

  // Replying goes out through the daemon (dry-run records it) and marks the batch seen.
  const reply = text(
    await tool("reply").handler({
      chat_id: CHANNEL,
      batch_id: batchId,
      text: "green.",
    }),
  );
  assert.doesNotMatch(reply, /^error/u);
  const inbox = text(await tool("inbox").handler({}));
  assert.doesNotMatch(inbox, /walker, status please/u);
});

test("copilot extension: a send the session refuses is never marked offered", async () => {
  const { EventEmitter } = await import("node:events");
  const { start } = (await import("../copilot-extension/core.mjs")) as {
    start: (
      ...args: unknown[]
    ) => Promise<{ stop(): void; settled(): Promise<void> }>;
  };
  const written: Array<Record<string, unknown>> = [];
  const fake = Object.assign(new EventEmitter(), {
    setEncoding: () => undefined,
    destroy: () => undefined,
    write: (line: string) => written.push(JSON.parse(line)),
  });
  let fail = true;
  const ext = await start(
    async () => ({
      send: async () => {
        if (fail) throw new Error("session busy");
      },
      log: async () => undefined,
    }),
    { ear: "walker", tools: [] },
    { connect: () => fake },
  );
  fake.emit("connect");
  const line = (m: object) => fake.emit("data", `${JSON.stringify(m)}\n`);
  line({ type: "welcome", protocol: 1, attached: true, instructions: "hi" });
  line({ type: "event", batchId: 7, content: "x", meta: { kind: "mention" } });
  await ext.settled();
  fail = false;
  line({ type: "event", batchId: 8, content: "y", meta: { kind: "mention" } });
  await ext.settled();
  assert.deepEqual(
    written.filter((m) => m.type === "offered").map((m) => m.batchId),
    [8],
  );
  ext.stop();
});

type Start = (...args: unknown[]) => Promise<{
  stop(): void;
  settled(): Promise<void>;
  status(): { preambleSent: boolean };
}>;

function fakeSocket() {
  return import("node:events").then(({ EventEmitter }) => {
    const written: Array<Record<string, unknown>> = [];
    const socket = Object.assign(new EventEmitter(), {
      written,
      setEncoding: () => undefined,
      destroy: () => undefined,
      write: (line: string) => written.push(JSON.parse(line)),
      line: (m: object) => socket.emit("data", `${JSON.stringify(m)}\n`),
    });
    return socket;
  });
}

test("copilot extension: each new attach generation gets its own instructions preamble, once", async () => {
  const { start } = (await import("../copilot-extension/core.mjs")) as {
    start: Start;
  };
  const sockets: Array<Awaited<ReturnType<typeof fakeSocket>>> = [];
  const pending = [await fakeSocket(), await fakeSocket()];
  const prompts: string[] = [];
  const ext = await start(
    async () => ({
      send: async ({ prompt }: Sent) => {
        prompts.push(prompt);
      },
      log: async () => undefined,
    }),
    { ear: "walker", tools: [] },
    {
      connect: () => {
        const next = pending.shift();
        assert.ok(next, "a third connection was not expected");
        sockets.push(next);
        return next;
      },
      reconnectMs: 1,
    },
  );
  const event = (batchId: number) => ({
    type: "event",
    batchId,
    content: `event ${batchId}`,
    meta: { kind: "mention" },
  });

  // Generation 1.
  const first = sockets[0]!;
  first.emit("connect");
  first.line({
    type: "welcome",
    protocol: 1,
    attached: true,
    generation: 1,
    instructions: "instructions A",
  });
  first.line(event(1));
  first.line(event(2));
  await ext.settled();
  assert.equal(ext.status().preambleSent, true);

  // The daemon restarts: the socket closes and the extension reconnects.
  first.emit("close");
  const second = await waitFor(() => sockets[1], "reconnect");
  second.emit("connect");
  second.line({
    type: "welcome",
    protocol: 1,
    attached: true,
    generation: 2,
    instructions: "instructions B",
  });
  second.line(event(3));
  second.line(event(4));
  await ext.settled();

  assert.deepEqual(
    prompts.map((prompt) => prompt.split("\n")[0]),
    [
      "instructions A",
      '<channel source="frond-ear" kind="mention">',
      "instructions B",
      '<channel source="frond-ear" kind="mention">',
    ],
  );
  assert.equal(prompts.filter((p) => p.includes("instructions A")).length, 1);
  assert.equal(prompts.filter((p) => p.includes("instructions B")).length, 1);
  assert.match(prompts[2]!, /^instructions B\n\n<channel [^>]*>\nevent 3\n/u);
  assert.equal(ext.status().preambleSent, true);
  assert.deepEqual(
    second.written.filter((m) => m.type === "offered").map((m) => m.batchId),
    [3, 4],
  );
  ext.stop();
});

test("copilot extension: an event pending across a reconnect keeps its own attach's preamble", async () => {
  const { start } = (await import("../copilot-extension/core.mjs")) as {
    start: Start;
  };
  const sockets: Array<Awaited<ReturnType<typeof fakeSocket>>> = [];
  const pending = [await fakeSocket(), await fakeSocket()];
  const prompts: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ext = await start(
    async () => ({
      send: async ({ prompt }: Sent) => {
        prompts.push(prompt);
        if (prompts.length === 1) await gate; // A's first send is still pending at the reconnect
      },
      log: async () => undefined,
    }),
    { ear: "walker", tools: [] },
    {
      connect: () => {
        const next = pending.shift();
        assert.ok(next, "a third connection was not expected");
        sockets.push(next);
        return next;
      },
      reconnectMs: 1,
    },
  );
  const event = (batchId: number) => ({
    type: "event",
    batchId,
    content: `event ${batchId}`,
    meta: { kind: "mention" },
  });
  const welcome = (generation: number, instructions: string) => ({
    type: "welcome",
    protocol: 1,
    attached: true,
    generation,
    instructions,
  });

  const first = sockets[0]!;
  first.emit("connect");
  first.line(welcome(1, "instructions A"));
  first.line(event(1));
  first.line(event(2)); // queued behind the pending send
  first.emit("close");
  const second = await waitFor(() => sockets[1], "reconnect");
  second.emit("connect");
  second.line(welcome(2, "instructions B"));
  second.line(event(3));
  release();
  await ext.settled();

  assert.deepEqual(
    prompts.map((prompt) => prompt.split("\n")[0]),
    [
      "instructions A",
      '<channel source="frond-ear" kind="mention">',
      "instructions B",
    ],
  );
  assert.match(prompts[1]!, /\nevent 2\n/u);
  assert.match(prompts[2]!, /^instructions B\n\n<channel [^>]*>\nevent 3\n/u);
  // A's events are never offered on B's socket; the daemon re-offers them as a digest
  assert.deepEqual(
    second.written.filter((m) => m.type === "offered").map((m) => m.batchId),
    [3],
  );
  ext.stop();
});

test("copilot extension: a failed tool call is an SDK failure result, not success text", async () => {
  const { start } = (await import("../copilot-extension/core.mjs")) as {
    start: Start;
  };
  const socket = await fakeSocket();
  let tools: Tool[] = [];
  const ext = await start(
    async (options: { tools: Tool[] }) => {
      tools = options.tools;
      return { send: async () => undefined, log: async () => undefined };
    },
    {
      ear: "walker",
      tools: [{ name: "reply", description: "reply", inputSchema: {} }],
    },
    { connect: () => socket, reconnectMs: 60_000 },
  );
  const reply = tools[0]!;

  // Not connected yet: the daemon is unreachable.
  const unreachable = await reply.handler({});
  assert.equal(typeof unreachable, "object");
  assert.equal((unreachable as ToolFailure).resultType, "failure");
  assert.match((unreachable as ToolFailure).error, /not reachable/u);
  assert.match((unreachable as ToolFailure).textResultForLlm, /^error: /u);

  socket.emit("connect");
  const answer = (ok: boolean, text: string) => {
    const call = socket.written.findLast((m) => m.type === "call")!;
    socket.line({ type: "result", id: call.id, ok, text });
  };

  // The daemon refuses the call.
  const refused = reply.handler({ chat_id: "1", text: "x" });
  answer(false, "chat 1 is not allowed");
  assert.deepEqual(await refused, {
    textResultForLlm: "error: chat 1 is not allowed",
    resultType: "failure",
    error: "chat 1 is not allowed",
  });

  // A successful call stays plain text.
  const sent = reply.handler({ chat_id: "1", text: "x" });
  answer(true, "sent");
  assert.equal(await sent, "sent");
  ext.stop();
});

test("copilot extension: a refused push is logged with the text the deaf advice names (#39)", async () => {
  const { start } = (await import("../copilot-extension/core.mjs")) as {
    start: Start;
  };
  const socket = await fakeSocket();
  const logged: string[] = [];
  const ext = await start(
    async () => ({
      send: async () => {
        throw new Error("session busy");
      },
      log: async (message: string) => {
        logged.push(message);
      },
    }),
    { ear: "walker", tools: [] },
    { connect: () => socket, reconnectMs: 60_000 },
  );
  socket.emit("connect");
  socket.line({
    type: "welcome",
    protocol: 1,
    attached: true,
    instructions: "hi",
  });
  socket.line({
    type: "event",
    batchId: 7,
    content: "x",
    meta: { kind: "mention" },
  });
  await ext.settled();
  // doctor and the daemon's delivery warning tell a deaf Copilot session to look for it.
  const deaf =
    targetAdvice({ name: "walker", target: "copilot-extension" }, {})?.deaf ??
    "";
  const named = /"(frond-ear: could not deliver batch)"/u.exec(deaf)?.[1];
  assert.ok(named, deaf);
  assert.ok(
    logged.some((message) => message.startsWith(`${named} 7: session busy`)),
    JSON.stringify(logged),
  );
  ext.stop();
});

test("copilot extension: reinstall tightens an existing 0644 config.json to 0600", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-copilot-reinstall-"));
  try {
    const extDir = join(directory, "ext");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: directory,
      COPILOT_HOME: join(directory, "copilot-home"),
      FROND_EAR_SOCKET: join(directory, "daemon.sock"),
    };
    const first = await run(
      ["copilot-extension", "--ear", "walker", "--dir", extDir],
      env,
    );
    assert.equal(first.code, 0);
    const configFile = join(extDir, "config.json");
    chmodSync(configFile, 0o644);
    assert.equal(statSync(configFile).mode & 0o777, 0o644);

    const again = await run(
      ["copilot-extension", "--ear", "walker", "--dir", extDir],
      env,
    );
    assert.equal(again.code, 0);
    assert.equal(statSync(configFile).mode & 0o777, 0o600);
    assert.equal(
      (JSON.parse(readFileSync(configFile, "utf8")) as { ear: string }).ear,
      "walker",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("copilot extension: its detached notice is the shim's text", () => {
  // core.mjs cannot import render.ts, so it keeps a copy of detachedNotice.
  const core = readFileSync(
    join(import.meta.dirname, "..", "copilot-extension", "core.mjs"),
    "utf8",
  );
  assert.ok(
    core.includes(`\`${detachedNotice("${message.reason}")}\``),
    "copilot-extension/core.mjs must carry detachedNotice's text verbatim",
  );
});
