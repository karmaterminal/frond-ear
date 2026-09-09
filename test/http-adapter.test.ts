import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CommandAdapter, ManualAdapter } from "../src/adapters.js";
import { isLoopbackHost, loadConfig } from "../src/config.js";
import { DiscordGateway } from "../src/gateway.js";
import { createHttpServer } from "../src/http.js";
import { StructuredLogger } from "../src/logger.js";
import { EarService } from "../src/service.js";
import { EventStore } from "../src/store.js";
import type { LeasedBatch } from "../src/types.js";
import { FakeClock, FakeSocket, message, testPolicy } from "./helpers.js";

function fixtureBatch(summary = "bounded"): LeasedBatch {
  return {
    claimToken: "claim",
    leaseExpiresAt: 1,
    priority: true,
    eventIds: [1],
    summary,
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
}

test("loopback binding accepts only explicit local addresses", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("127.42.0.9"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("192.168.1.2"), false);
});

test("command adapter timeout must remain shorter than the queue lease", () => {
  const previous = {
    token: process.env.DISCORD_BOT_TOKEN,
    command: process.env.FROND_EAR_ADAPTER_COMMAND,
    timeout: process.env.FROND_EAR_ADAPTER_TIMEOUT_MS,
    lease: process.env.FROND_EAR_LEASE_MS,
  };
  process.env.DISCORD_BOT_TOKEN = ["fixture", "credential"].join("-");
  process.env.FROND_EAR_ADAPTER_COMMAND = process.execPath;
  process.env.FROND_EAR_ADAPTER_TIMEOUT_MS = "100";
  process.env.FROND_EAR_LEASE_MS = "100";
  try {
    assert.throws(
      () => loadConfig(),
      /FROND_EAR_ADAPTER_TIMEOUT_MS must be less/u,
    );
  } finally {
    for (const [name, value] of [
      ["DISCORD_BOT_TOKEN", previous.token],
      ["FROND_EAR_ADAPTER_COMMAND", previous.command],
      ["FROND_EAR_ADAPTER_TIMEOUT_MS", previous.timeout],
      ["FROND_EAR_LEASE_MS", previous.lease],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
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
  const batch = fixtureBatch("$(touch should-not-run); untrusted");
  try {
    await adapter.deliver(batch);
    assert.deepEqual(
      JSON.parse(readFileSync(output, "utf8")) as unknown,
      batch,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("command adapter timeout rejects even when the child ignores SIGTERM", async () => {
  const adapter = new CommandAdapter({
    executable: process.execPath,
    args: [
      "-e",
      "process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000)",
    ],
    timeoutMs: 20,
    maxPayloadBytes: 10_000,
  });
  await assert.rejects(adapter.deliver(fixtureBatch()), /adapter timed out/u);
});

test("loopback API leases, acknowledges, and releases through the store boundary", async () => {
  const clock = new FakeClock(1_000);
  const store = new EventStore(":memory:", clock);
  const policy = testPolicy({ quietWindowMs: 0 });
  const logger = new StructuredLogger(() => undefined, ["fixture-token"]);
  const gateway = new DiscordGateway({
    token: "fixture-token",
    gatewayUrl: "wss://gateway.example",
    store,
    logger,
    onMessage: () => undefined,
    socketFactory: () => new FakeSocket(),
  });
  const service = new EarService({
    store,
    policy: () => policy,
    gateway,
    adapter: new ManualAdapter(),
    leaseMs: 100,
    logger,
  });
  store.enqueue(message("api-ack"), policy, false, 10);
  const server = createHttpServer({
    host: "127.0.0.1",
    port: 0,
    store,
    service,
    getPolicy: () => policy,
    reloadPolicy: () => policy,
    leaseMs: 100,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const leased = (await (
      await fetch(`${base}/queue/lease-next`, { method: "POST", body: "{}" })
    ).json()) as { batch: { claimToken: string } };
    const acknowledged = (await (
      await fetch(`${base}/queue/ack`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ claimToken: leased.batch.claimToken }),
      })
    ).json()) as { updated: number };
    assert.equal(acknowledged.updated, 1);

    store.enqueue(message("api-release"), policy, false, 10);
    const next = (await (
      await fetch(`${base}/queue/lease-next`, { method: "POST", body: "{}" })
    ).json()) as { batch: { claimToken: string } };
    const released = (await (
      await fetch(`${base}/queue/release`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          claimToken: next.batch.claimToken,
          error: "fixture failure",
        }),
      })
    ).json()) as { updated: number };
    assert.equal(released.updated, 1);
    assert.equal(
      store.listEvents().find((event) => event.messageId === "api-release")
        ?.state,
      "pending",
    );
    const status = await (await fetch(`${base}/health`)).text();
    assert.doesNotMatch(status, /fixture-token/u);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await service.stop();
    store.close();
  }
});
