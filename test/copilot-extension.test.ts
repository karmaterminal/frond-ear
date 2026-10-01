// End-to-end for the Copilot CLI target: a real dry-run daemon and unix socket, the real
// installer, and the installed core.mjs driven by a fake `joinSession` standing in for
// the Copilot CLI. Nothing touches Discord or Copilot.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
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

import { BOT, CHANNEL, GUILD, PRINCIPAL } from "./helpers.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

interface Sent {
  prompt: string;
  source?: string;
  mode?: string;
}
interface Tool {
  name: string;
  parameters: unknown;
  handler: (args: Record<string, unknown>) => Promise<string>;
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
    /^frond-ear is your own ear on Discord, run by your operator \(this session is ear "walker"\)[\s\S]*\n\n<channel source="frond-ear" kind="attach"/u,
  );
  const nonce = /nonce="([^"]+)"/u.exec(canary.prompt)?.[1];
  assert.ok(nonce);
  assert.doesNotMatch(await tool("ack").handler({ nonce }), /^error/u);
  const status = JSON.parse(await tool("ear_status").handler({})) as {
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
  const batchId = Number(/batch_id="(\d+)"/u.exec(mention.prompt)?.[1]);
  assert.ok(batchId > 0);

  // Replying goes out through the daemon (dry-run records it) and marks the batch seen.
  const reply = await tool("reply").handler({
    chat_id: CHANNEL,
    batch_id: batchId,
    text: "green.",
  });
  assert.doesNotMatch(reply, /^error/u);
  const inbox = await tool("inbox").handler({});
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
