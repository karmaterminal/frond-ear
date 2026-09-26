// Ported from codeagent/frond-ear-live-canary-v2 (test/gateway.test.ts) and
// extended for the v1 fixes: 4007/4009, contained ingest failures, fatal
// callback, GUILDS intent and thread-parent tracking.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DiscordGateway,
  GATEWAY_INTENTS,
  type GatewayOptions,
} from "../src/gateway.ts";
import { StructuredLogger } from "../src/logger.ts";
import { EventStore } from "../src/store.ts";
import {
  FakeClock,
  FakeSocket,
  harness,
  message,
  THREAD,
  CHANNEL,
} from "./helpers.ts";

const TOKEN = "fixture-token";

function gatewayWith(
  store: EventStore,
  overrides: Partial<GatewayOptions> = {},
): {
  gateway: DiscordGateway;
  sockets: FakeSocket[];
  timers: Array<{ callback: () => void; delay: number }>;
} {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const gateway = new DiscordGateway({
    token: TOKEN,
    gatewayUrl: "wss://gateway.example",
    store,
    logger: new StructuredLogger(() => undefined, [TOKEN]),
    onMessage: () => undefined,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    random: () => 0,
    setTimeout: ((callback: () => void, delay?: number) => {
      timers.push({ callback, delay: delay ?? 0 });
      return {} as NodeJS.Timeout;
    }) as typeof globalThis.setTimeout,
    clearTimeout: (() => undefined) as typeof globalThis.clearTimeout,
    ...overrides,
  });
  return { gateway, sockets, timers };
}

test("disconnect/restart persists sequence and resumes the durable session", () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-gateway-"));
  const path = join(directory, "gateway.db");
  try {
    const firstStore = new EventStore(path, new FakeClock());
    const first = gatewayWith(firstStore);
    first.gateway.start();
    first.gateway.handlePayload({
      op: 0,
      t: "READY",
      s: 42,
      d: {
        session_id: "session-1",
        resume_gateway_url: "wss://resume.example",
      },
    });
    first.gateway.stop();
    firstStore.close();

    const store = new EventStore(path, new FakeClock());
    const urls: string[] = [];
    const restarted = gatewayWith(store, {
      socketFactory: (url) => {
        urls.push(url);
        return new FakeSocket();
      },
    });
    const socket = new FakeSocket();
    restarted.gateway.start();
    assert.match(urls[0] ?? "", /^wss:\/\/resume\.example\/\?v=10/u);
    // Re-create with a captured socket to inspect the RESUME payload.
    restarted.gateway.stop();
    const captured = gatewayWith(store, { socketFactory: () => socket });
    captured.gateway.start();
    captured.gateway.handlePayload({
      op: 10,
      d: { heartbeat_interval: 60_000 },
    });
    assert.deepEqual(
      socket.sent.find((payload) => payload.op === 6),
      { op: 6, d: { token: TOKEN, session_id: "session-1", seq: 42 } },
    );
    captured.gateway.handlePayload({ op: 0, t: "RESUMED", s: 43, d: {} });
    assert.equal(store.gatewayState().sequence, 43);
    captured.gateway.stop();
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("identify requests GUILDS, guild messages, DMs and message content", () => {
  const store = new EventStore(":memory:", new FakeClock());
  const { gateway, sockets } = gatewayWith(store);
  gateway.start();
  gateway.handlePayload({ op: 10, d: { heartbeat_interval: 60_000 } });
  const identify = sockets[0]?.sent.find((payload) => payload.op === 2) as {
    d: { intents: number };
  };
  assert.equal(identify.d.intents, GATEWAY_INTENTS);
  assert.equal(GATEWAY_INTENTS, 1 | (1 << 9) | (1 << 12) | (1 << 15));
  gateway.stop();
  store.close();
});

test("fatal close codes stop reconnecting, surface failure and call onFatal", () => {
  const store = new EventStore(":memory:", new FakeClock());
  const fatal: number[] = [];
  const { gateway, sockets, timers } = gatewayWith(store, {
    onFatal: (code) => fatal.push(code),
  });
  gateway.start();
  sockets[0]?.emitClose(4_014);
  assert.equal(gateway.status().state, "failed");
  assert.equal(gateway.status().lastError, "gateway_closed_4014");
  assert.equal(timers.length, 0);
  assert.deepEqual(fatal, [4_014]);
  gateway.stop();
  store.close();
});

for (const code of [4_007, 4_009]) {
  test(`close ${code} clears the session so the next connect identifies`, () => {
    const store = new EventStore(":memory:", new FakeClock());
    store.saveGatewayState({
      sessionId: "stale",
      sequence: 9,
      resumeGatewayUrl: "wss://resume.example",
    });
    const { gateway, sockets, timers } = gatewayWith(store);
    gateway.start();
    sockets[0]?.emitClose(code);
    assert.equal(store.gatewayState().sessionId, null);
    timers.shift()?.callback();
    gateway.handlePayload({ op: 10, d: { heartbeat_interval: 60_000 } });
    assert.ok(
      sockets[1]?.sent.some((payload) => payload.op === 2),
      "identify, not resume",
    );
    assert.ok(!sockets[1]?.sent.some((payload) => payload.op === 6));
    gateway.stop();
    store.close();
  });
}

test("heartbeat without an ACK closes the stale connection and schedules resume", () => {
  const store = new EventStore(":memory:", new FakeClock());
  const { gateway, sockets, timers } = gatewayWith(store);
  gateway.start();
  gateway.handlePayload({ op: 10, d: { heartbeat_interval: 100 } });
  timers.shift()?.callback();
  assert.equal(
    sockets[0]?.sent.filter((payload) => payload.op === 1).length,
    1,
  );
  timers.shift()?.callback();
  assert.equal(sockets[0]?.closed, true);
  assert.equal(gateway.status().lastError, "gateway_heartbeat_ack_timeout");
  assert.equal(gateway.status().state, "backoff");
  gateway.stop();
  store.close();
});

test("a stale socket close cannot schedule another connection", () => {
  const store = new EventStore(":memory:", new FakeClock());
  const { gateway, sockets, timers } = gatewayWith(store);
  gateway.start();
  sockets[0]?.emitClose(1_006);
  timers.shift()?.callback();
  assert.equal(sockets.length, 2);
  sockets[0]?.emitClose(1_006);
  assert.equal(timers.length, 0);
  gateway.stop();
  store.close();
});

test("non-resumable invalid session clears identity and waits before reconnect", () => {
  const store = new EventStore(":memory:", new FakeClock());
  store.saveGatewayState({
    sessionId: "old",
    sequence: 12,
    resumeGatewayUrl: "wss://resume.example",
  });
  const { gateway, timers } = gatewayWith(store, { random: () => 0.5 });
  gateway.start();
  gateway.handlePayload({ op: 9, d: false });
  assert.equal(store.gatewayState().sessionId, null);
  assert.deepEqual(
    timers.map((timer) => timer.delay),
    [3_000],
  );
  gateway.stop();
  store.close();
});

test("a failed ingest fences the stream and the event is replayed on resume", () => {
  const store = new EventStore(":memory:", new FakeClock());
  store.saveGatewayState({
    sessionId: "session",
    sequence: 20,
    resumeGatewayUrl: "wss://resume.example",
  });
  let failNext = true;
  const ingested: string[] = [];
  const { gateway, sockets, timers } = gatewayWith(store, {
    onMessage: (event) => {
      if (failNext) {
        failNext = false;
        throw new Error("simulated persistence failure");
      }
      ingested.push(event.id);
    },
  });
  const lost = message();
  gateway.start();
  assert.doesNotThrow(() =>
    sockets[0]?.emitMessage({ op: 0, t: "MESSAGE_CREATE", s: 21, d: lost }),
  );
  assert.equal(store.gatewayState().sequence, 20);
  assert.equal(gateway.status().lastError, "ingest_failed");
  assert.equal(sockets[0]?.closed, true, "the connection is dropped");

  // Later sequenced dispatches that were already in flight on the old
  // socket, or handed in directly, cannot advance the cursor past 20.
  sockets[0]?.emitMessage({ op: 0, t: "TYPING_START", s: 22, d: {} });
  gateway.handlePayload({ op: 0, t: "MESSAGE_CREATE", s: 23, d: message() });
  assert.equal(store.gatewayState().sequence, 20);
  assert.deepEqual(ingested, []);

  // Reconnect resumes from the last durable sequence; Discord replays 21.
  assert.equal(timers.length, 1);
  timers.shift()?.callback();
  gateway.handlePayload({ op: 10, d: { heartbeat_interval: 60_000 } });
  assert.deepEqual(
    sockets[1]?.sent.find((payload) => payload.op === 6),
    { op: 6, d: { token: TOKEN, session_id: "session", seq: 20 } },
  );
  sockets[1]?.emitMessage({ op: 0, t: "MESSAGE_CREATE", s: 21, d: lost });
  sockets[1]?.emitMessage({ op: 0, t: "TYPING_START", s: 22, d: {} });
  sockets[1]?.emitMessage({ op: 0, t: "RESUMED", s: 23, d: {} });
  assert.deepEqual(ingested, [lost.id]);
  assert.equal(store.gatewayState().sequence, 23);
  gateway.stop();
  store.close();
});

test("thread parents are learned from GUILD_CREATE, THREAD_CREATE and THREAD_LIST_SYNC", () => {
  const store = new EventStore(":memory:", new FakeClock());
  const seen: Array<[string, string]> = [];
  const { gateway } = gatewayWith(store, {
    onThread: (thread, parent) => seen.push([thread, parent]),
  });
  gateway.handlePayload({
    op: 0,
    t: "GUILD_CREATE",
    s: 1,
    d: { threads: [{ id: "t1", parent_id: "p1" }] },
  });
  gateway.handlePayload({
    op: 0,
    t: "THREAD_CREATE",
    s: 2,
    d: { id: "t2", parent_id: "p2" },
  });
  gateway.handlePayload({
    op: 0,
    t: "THREAD_LIST_SYNC",
    s: 3,
    d: { threads: [{ id: "t3", parent_id: "p3" }, { id: 4 }] },
  });
  assert.deepEqual(seen, [
    ["t1", "p1"],
    ["t2", "p2"],
    ["t3", "p3"],
  ]);
  store.close();
});

test("Gateway replay flows through the daemon and remains idempotent", () => {
  const h = harness();
  try {
    const { gateway } = gatewayWith(
      new EventStore(":memory:", new FakeClock()),
      {
        onMessage: (event) => {
          h.daemon.ingest(event);
        },
      },
    );
    const event = message({ content: "<@100000000000000001> hi" });
    gateway.handlePayload({ op: 0, t: "MESSAGE_CREATE", s: 10, d: event });
    gateway.handlePayload({ op: 0, t: "RESUMED", s: 11, d: {} });
    gateway.handlePayload({ op: 0, t: "MESSAGE_CREATE", s: 12, d: event });
    assert.equal(h.store.stateCounts("scribe").queued, 1);
    assert.equal(h.store.counters().duplicates, 1);
  } finally {
    h.dispose();
  }
});

test("thread messages route through the learned parent", () => {
  const h = harness();
  try {
    h.daemon.recordThread(THREAD, CHANNEL);
    assert.equal(
      h.daemon.ingest(
        message({
          channel_id: THREAD,
          content: "<@100000000000000001> in a thread",
        }),
      ),
      "inserted",
    );
    assert.equal(h.store.unseen("scribe", THREAD, 10).length, 1);
  } finally {
    h.dispose();
  }
});
