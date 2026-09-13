import assert from "node:assert/strict";
import test from "node:test";

import type { WakeAdapter } from "../src/adapters.js";
import { DiscordGateway } from "../src/gateway.js";
import { StructuredLogger } from "../src/logger.js";
import { EarService } from "../src/service.js";
import { EventStore } from "../src/store.js";
import type { DiscordMessage, EventSource, LeasedBatch } from "../src/types.js";
import { FakeClock, FakeSocket, message, testPolicy } from "./helpers.js";

test("generic event-source boundary accepts non-Discord harness adapters", () => {
  const store = new EventStore(":memory:", new FakeClock(1_000));
  const policy = testPolicy({ quietWindowMs: 0 });
  const logger = new StructuredLogger(() => undefined, ["fixture-token"]);
  const gateway: EventSource<DiscordMessage> = {
    kind: "teams-harness",
    start: () => undefined,
    stop: () => undefined,
    status: () => ({ kind: "teams-harness", ready: true }),
  };
  const service = new EarService({
    store,
    policy: () => policy,
    gateway,
    adapter: {
      name: "manual",
      automaticDelivery: false,
      available: () => false,
      deliver: async () => undefined,
      status: () => ({ name: "manual" }),
    },
    leaseMs: 1_000,
    logger,
  });
  assert.deepEqual(service.status().gateway, {
    kind: "teams-harness",
    ready: true,
  });
  service.start();
  service.stop();
  store.close();
});

test("shutdown waits for in-flight delivery before the store can close", async () => {
  const store = new EventStore(":memory:", new FakeClock(1_000));
  const policy = testPolicy({ quietWindowMs: 0 });
  let finishDelivery: (() => void) | undefined;
  let deliveryStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    deliveryStarted = resolve;
  });
  const adapter: WakeAdapter = {
    name: "controlled",
    automaticDelivery: true,
    available: () => true,
    deliver: async (_batch: LeasedBatch) => {
      deliveryStarted?.();
      await new Promise<void>((resolve) => {
        finishDelivery = resolve;
      });
    },
    status: () => ({ name: "controlled" }),
  };
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
    adapter,
    leaseMs: 1_000,
    logger,
  });
  store.enqueue(message("in-flight"), policy, false, 10);
  service.start();
  await started;
  let stopped = false;
  const stopping = service.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  finishDelivery?.();
  await stopping;
  assert.equal(store.listEvents()[0]?.state, "delivered");
  store.close();
});

test("automatic delivery reports a lease lost before ack", async () => {
  const clock = new FakeClock(1_000);
  const store = new EventStore(":memory:", clock);
  const policy = testPolicy({ quietWindowMs: 0 });
  let deliveryFinished: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    deliveryFinished = resolve;
  });
  const adapter: WakeAdapter = {
    name: "lease-expirer",
    automaticDelivery: true,
    available: () => true,
    deliver: async () => {
      clock.advance(101);
      store.recoverExpiredLeases();
      deliveryFinished?.();
    },
    status: () => ({ name: "lease-expirer" }),
  };
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
    adapter,
    leaseMs: 100,
    logger,
  });
  store.enqueue(message("lease-lost"), policy, false, 10);
  service.start();
  await finished;
  await service.stop();
  assert.equal(store.counters().lease_lost, 1);
  assert.equal(store.listEvents()[0]?.state, "pending");
  store.close();
});
