import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CommandAdapter } from "../src/adapters.js";
import { isLoopbackHost } from "../src/config.js";
import type { LeasedBatch } from "../src/types.js";

test("loopback binding accepts only explicit local addresses", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("127.42.0.9"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("192.168.1.2"), false);
});

test("command adapter writes bounded JSON to stdin without shell interpolation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-adapter-"));
  const output = join(directory, "stdin.json");
  const adapter = new CommandAdapter({
    executable: process.execPath,
    args: [
      "-e",
      "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>require('fs').writeFileSync(process.argv[1],d))",
      output,
    ],
    timeoutMs: 2_000,
    maxPayloadBytes: 10_000,
  });
  const batch: LeasedBatch = {
    claimToken: "claim",
    leaseExpiresAt: 1,
    priority: true,
    eventIds: [1],
    summary: "$(touch should-not-run); untrusted",
    events: [
      {
        messageId: "m",
        guildId: "g",
        channelId: "c",
        authorId: "a",
        timestamp: "t",
        link: "https://discord.com/channels/g/c/m",
      },
    ],
  };
  try {
    await adapter.deliver(batch);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")) as unknown, batch);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
