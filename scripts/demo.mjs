import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ManualAdapter } from "../dist/src/adapters.js";
import { DiscordGateway } from "../dist/src/gateway.js";
import { StructuredLogger } from "../dist/src/logger.js";
import { defaultPolicy } from "../dist/src/policy.js";
import { EarService } from "../dist/src/service.js";
import { EventStore } from "../dist/src/store.js";

class DemoClock {
  value = 1_000;
  now() {
    return this.value;
  }
  advance(milliseconds) {
    this.value += milliseconds;
  }
}

class InertSocket {
  addEventListener() {}
  send() {}
  close() {}
}

const directory = mkdtempSync(join(tmpdir(), "frond-ear-demo-"));
const databasePath = join(directory, "demo.db");
const clock = new DemoClock();
const policy = {
  ...defaultPolicy,
  allowedGuildIds: ["demo-guild"],
  allowedChannelIds: ["demo-channel"],
  priorityAuthorIds: ["figs"],
  ignoredPatterns: ["^routine noise$"],
  botUserId: "frond-scribe",
  quietWindowMs: 100,
  maxCoalesceWindowMs: 500,
};
const logger = new StructuredLogger(() => undefined, ["demo-credential"]);

function event(id, authorId, content, mentions = []) {
  return {
    id,
    guild_id: "demo-guild",
    channel_id: "demo-channel",
    author: { id: authorId },
    content,
    timestamp: new Date(clock.now()).toISOString(),
    mentions,
    type: 0,
  };
}

function createRuntime(store) {
  let service;
  const gateway = new DiscordGateway({
    token: "demo-credential",
    gatewayUrl: "wss://demo.invalid",
    store,
    logger,
    onMessage: (message) => service.ingest(message),
    socketFactory: () => new InertSocket(),
  });
  service = new EarService({
    store,
    policy: () => policy,
    gateway,
    adapter: new ManualAdapter(),
    leaseMs: 50,
    logger,
  });
  return { gateway, service };
}

try {
  let store = new EventStore(databasePath, clock);
  let runtime = createRuntime(store);
  runtime.gateway.handlePayload({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 1,
    d: event("noise", "routine-bot", "routine noise"),
  });
  runtime.gateway.handlePayload({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 2,
    d: event("normal-1", "person", "first"),
  });
  clock.advance(20);
  runtime.gateway.handlePayload({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 3,
    d: event("normal-2", "person", "second"),
  });
  runtime.gateway.handlePayload({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 4,
    d: event("priority", "figs", "please inspect"),
  });

  const priority = store.leaseNext(policy, 50);
  store.ack(priority.claimToken);
  runtime.gateway.handlePayload({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 5,
    d: event("priority", "figs", "please inspect"),
  });

  clock.advance(101);
  const beforeCrash = store.leaseNext(policy, 50);
  store.close();
  clock.advance(51);

  store = new EventStore(databasePath, clock);
  runtime = createRuntime(store);
  const recovered = store.leaseNext(policy, 50);
  store.ack(recovered.claimToken);
  const result = {
    boundedPriorityNotification:
      priority.priority &&
      priority.events.length === 1 &&
      priority.summary.length <= policy.maxSummaryChars,
    durableRestartRecovery:
      recovered.events.length === 2 &&
      recovered.claimToken !== beforeCrash.claimToken,
    duplicateSuppressed:
      store.listEvents().filter((row) => row.messageId === "priority")
        .length === 1,
    routineNoiseSuppressed: !store
      .listEvents()
      .some((row) => row.messageId === "noise"),
    recoveredBurstMessageIds: recovered.events.map((item) => item.messageId),
  };
  if (Object.values(result).some((value) => value === false)) {
    throw new Error(`demo proof failed: ${JSON.stringify(result)}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  store.close();
} finally {
  rmSync(directory, { recursive: true, force: true });
}
