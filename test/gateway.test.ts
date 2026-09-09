import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ManualAdapter } from "../src/adapters.js";
import { DiscordGateway } from "../src/gateway.js";
import { StructuredLogger } from "../src/logger.js";
import { EarService } from "../src/service.js";
import { EventStore } from "../src/store.js";
import { FakeClock, FakeSocket, message, testPolicy } from "./helpers.js";

test("disconnect/restart persists sequence and resumes the durable session", () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-gateway-"));
  const path = join(directory, "gateway.db");
  const firstStore = new EventStore(path, new FakeClock(1_000));
  const firstSocket = new FakeSocket();
  const logger = new StructuredLogger(() => undefined, ["fixture-token"]);
  const firstGateway = new DiscordGateway({
    token: "fixture-token",
    gatewayUrl: "wss://gateway.example",
    store: firstStore,
    logger,
    onMessage: () => undefined,
    socketFactory: () => firstSocket,
    random: () => 0,
  });
  firstGateway.start();
  firstGateway.handlePayload({
    op: 0,
    t: "READY",
    s: 42,
    d: {
      session_id: "session-1",
      resume_gateway_url: "wss://resume.example",
    },
  });
  firstGateway.stop();
  firstStore.close();

  const restartedStore = new EventStore(path, new FakeClock(2_000));
  const restartedSocket = new FakeSocket();
  const restartedGateway = new DiscordGateway({
    token: "fixture-token",
    gatewayUrl: "wss://gateway.example",
    store: restartedStore,
    logger,
    onMessage: () => undefined,
    socketFactory: (url) => {
      assert.match(url, /^wss:\/\/resume\.example/u);
      return restartedSocket;
    },
    random: () => 0,
  });
  try {
    restartedGateway.start();
    restartedGateway.handlePayload({
      op: 10,
      d: { heartbeat_interval: 60_000 },
    });
    const resume = restartedSocket.sent.find((payload) => payload.op === 6);
    assert.deepEqual(resume, {
      op: 6,
      d: {
        token: "fixture-token",
        session_id: "session-1",
        seq: 42,
      },
    });
    restartedGateway.handlePayload({ op: 0, t: "RESUMED", s: 43, d: {} });
    assert.equal(restartedStore.gatewayState().sequence, 43);
  } finally {
    restartedGateway.stop();
    restartedStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fatal close codes stop reconnecting and surface failure", () => {
  const store = new EventStore(":memory:", new FakeClock(1_000));
  const socket = new FakeSocket();
  const timers: Array<() => void> = [];
  const gateway = new DiscordGateway({
    token: "fixture-token",
    gatewayUrl: "wss://gateway.example",
    store,
    logger: new StructuredLogger(() => undefined, ["fixture-token"]),
    onMessage: () => undefined,
    socketFactory: () => socket,
    setTimeout: ((callback: () => void) => {
      timers.push(callback);
      return {} as NodeJS.Timeout;
    }) as typeof globalThis.setTimeout,
    clearTimeout: (() => undefined) as typeof globalThis.clearTimeout,
  });
  try {
    gateway.start();
    socket.emitClose(4_014);
    assert.equal(gateway.status().state, "failed");
    assert.equal(gateway.status().lastError, "gateway_closed_4014");
    assert.equal(timers.length, 0);
  } finally {
    gateway.stop();
    store.close();
  }
});

test("heartbeat without an ACK closes the stale connection and schedules resume", () => {
  const store = new EventStore(":memory:", new FakeClock(1_000));
  const socket = new FakeSocket();
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const gateway = new DiscordGateway({
    token: "fixture-token",
    gatewayUrl: "wss://gateway.example",
    store,
    logger: new StructuredLogger(() => undefined, ["fixture-token"]),
    onMessage: () => undefined,
    socketFactory: () => socket,
    random: () => 0,
    setTimeout: ((callback: () => void, delay?: number) => {
      timers.push({ callback, delay: delay ?? 0 });
      return {} as NodeJS.Timeout;
    }) as typeof globalThis.setTimeout,
    clearTimeout: (() => undefined) as typeof globalThis.clearTimeout,
  });

  try {
    gateway.start();
    gateway.handlePayload({ op: 10, d: { heartbeat_interval: 100 } });
    timers.shift()?.callback();
    assert.equal(socket.sent.filter((payload) => payload.op === 1).length, 1);
    timers.shift()?.callback();
    assert.equal(socket.closed, true);
    assert.equal(gateway.status().lastError, "gateway_heartbeat_ack_timeout");
    assert.equal(gateway.status().state, "backoff");
  } finally {
    gateway.stop();
    store.close();
  }
});

test("a stale socket close cannot schedule another connection", () => {
  const store = new EventStore(":memory:", new FakeClock(1_000));
  const sockets: FakeSocket[] = [];
  const timers: Array<() => void> = [];
  const gateway = new DiscordGateway({
    token: "fixture-token",
    gatewayUrl: "wss://gateway.example",
    store,
    logger: new StructuredLogger(() => undefined, ["fixture-token"]),
    onMessage: () => undefined,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    random: () => 0,
    setTimeout: ((callback: () => void) => {
      timers.push(callback);
      return {} as NodeJS.Timeout;
    }) as typeof globalThis.setTimeout,
    clearTimeout: (() => undefined) as typeof globalThis.clearTimeout,
  });
  try {
    gateway.start();
    sockets[0]?.emitClose(1_006);
    timers.shift()?.();
    assert.equal(sockets.length, 2);
    sockets[0]?.emitClose(1_006);
    assert.equal(timers.length, 0);
  } finally {
    gateway.stop();
    store.close();
  }
});

test("non-resumable invalid session clears identity and waits before reconnect", () => {
  const store = new EventStore(":memory:", new FakeClock(1_000));
  store.saveGatewayState({
    sessionId: "old-session",
    sequence: 12,
    resumeGatewayUrl: "wss://resume.example",
  });
  const socket = new FakeSocket();
  const delays: number[] = [];
  const gateway = new DiscordGateway({
    token: "fixture-token",
    gatewayUrl: "wss://gateway.example",
    store,
    logger: new StructuredLogger(() => undefined, ["fixture-token"]),
    onMessage: () => undefined,
    socketFactory: () => socket,
    random: () => 0.5,
    setTimeout: ((_callback: () => void, delay?: number) => {
      delays.push(delay ?? 0);
      return {} as NodeJS.Timeout;
    }) as typeof globalThis.setTimeout,
    clearTimeout: (() => undefined) as typeof globalThis.clearTimeout,
  });
  try {
    gateway.start();
    gateway.handlePayload({ op: 9, d: false });
    assert.equal(store.gatewayState().sessionId, null);
    assert.deepEqual(delays, [3_000]);
  } finally {
    gateway.stop();
    store.close();
  }
});

test("Gateway replay flows through service and remains idempotent", () => {
  const store = new EventStore(":memory:", new FakeClock(1_000));
  const policy = testPolicy({ quietWindowMs: 0 });
  let service: EarService;
  const gateway = new DiscordGateway({
    token: "fixture-token",
    gatewayUrl: "wss://gateway.example",
    store,
    logger: new StructuredLogger(() => undefined, ["fixture-token"]),
    onMessage: (event) => service.ingest(event),
    socketFactory: () => new FakeSocket(),
  });

  service = new EarService({
    store,
    policy: () => policy,
    gateway,
    adapter: new ManualAdapter(),
    leaseMs: 100,
    logger: new StructuredLogger(() => undefined, ["fixture-token"]),
  });
  try {
    const event = message("replayed");
    gateway.handlePayload({ op: 0, t: "MESSAGE_CREATE", s: 10, d: event });
    gateway.handlePayload({ op: 0, t: "RESUMED", s: 11, d: {} });
    gateway.handlePayload({ op: 0, t: "MESSAGE_CREATE", s: 12, d: event });
    assert.equal(store.listEvents().length, 1);
    assert.equal(store.counters().duplicates, 1);
  } finally {
    gateway.stop();
    store.close();
  }
});

test("failed event persistence does not advance the durable Gateway sequence", () => {
  const store = new EventStore(":memory:", new FakeClock(1_000));
  store.saveGatewayState({
    sessionId: "session",
    sequence: 20,
    resumeGatewayUrl: "wss://resume.example",
  });
  const gateway = new DiscordGateway({
    token: "fixture-token",
    gatewayUrl: "wss://gateway.example",
    store,
    logger: new StructuredLogger(() => undefined, ["fixture-token"]),
    onMessage: () => {
      throw new Error("simulated persistence failure");
    },
    socketFactory: () => new FakeSocket(),
  });
  try {
    assert.throws(
      () =>
        gateway.handlePayload({
          op: 0,
          t: "MESSAGE_CREATE",
          s: 21,
          d: message("not-persisted"),
        }),
      /simulated persistence failure/u,
    );
    assert.equal(store.gatewayState().sequence, 20);
  } finally {
    gateway.stop();
    store.close();
  }
});
