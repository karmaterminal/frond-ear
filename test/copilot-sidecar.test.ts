import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CopilotSdkAdapter,
  type CopilotSdkClient,
  type CopilotSdkFactory,
  type CopilotSdkSession,
  ReleasedCopilotSdkFactory,
} from "../src/adapters.js";
import { DiscordGateway } from "../src/gateway.js";
import { StructuredLogger } from "../src/logger.js";
import { EarService } from "../src/service.js";
import { conversationIdentity, EventStore } from "../src/store.js";
import type { Policy } from "../src/types.js";
import { FakeClock, FakeSocket, message, testPolicy } from "./helpers.js";

class FakeSdkSession implements CopilotSdkSession {
  public readonly sends: Array<{
    prompt: string;
    source: "system";
    mode: "enqueue";
  }> = [];
  public busy = false;
  public rejection: Error | undefined;
  public neverSettles = false;

  public constructor(public readonly sessionId: string) {}

  public async send(options: {
    prompt: string;
    source: "system";
    mode: "enqueue";
  }): Promise<string> {
    this.sends.push(options);
    if (this.rejection) {
      throw this.rejection;
    }
    if (this.neverSettles) {
      return new Promise<string>(() => undefined);
    }
    return `${this.sessionId}:${String(this.sends.length)}`;
  }

  public async disconnect(): Promise<void> {}
}

class FakeSdkClient implements CopilotSdkClient {
  public starts = 0;
  public creates = 0;
  public resumes = 0;

  public constructor(
    public readonly sessions: Map<string, FakeSdkSession> = new Map(),
  ) {}

  public async start(): Promise<void> {
    this.starts += 1;
  }

  public async stop(): Promise<readonly Error[]> {
    return [];
  }

  public async getSessionMetadata(
    sessionId: string,
  ): Promise<{ sessionId: string } | undefined> {
    return this.sessions.has(sessionId) ? { sessionId } : undefined;
  }

  public async createSession(config: {
    sessionId: string;
  }): Promise<CopilotSdkSession> {
    this.creates += 1;
    const session = new FakeSdkSession(config.sessionId);
    this.sessions.set(config.sessionId, session);
    return session;
  }

  public async resumeSession(sessionId: string): Promise<CopilotSdkSession> {
    this.resumes += 1;
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("session not found");
    }
    return session;
  }
}

class FakeSdkFactory implements CopilotSdkFactory {
  public readonly capability = {
    available: true,
    sdkVersion: "future-test",
    cliVersion: "future-test",
    systemSource: true,
    enqueueMode: true,
    reason: null,
  };

  public constructor(public readonly client: FakeSdkClient) {}

  public createClient(): CopilotSdkClient {
    return this.client;
  }
}

function sdkAdapter(
  client: FakeSdkClient,
  overrides: Partial<{ timeoutMs: number; maxCachedSessions: number }> = {},
): CopilotSdkAdapter {
  return new CopilotSdkAdapter({
    factory: new FakeSdkFactory(client),
    timeoutMs: overrides.timeoutMs ?? 100,
    maxCachedSessions: overrides.maxCachedSessions ?? 4,
  });
}

function serviceFixture(options: {
  store: EventStore;
  policy: Policy;
  adapter: CopilotSdkAdapter;
  logs?: string[];
}): EarService {
  const logger = new StructuredLogger(
    (line) => options.logs?.push(line),
    ["fixture-token"],
  );
  const gateway = new DiscordGateway({
    token: "fixture-token",
    gatewayUrl: "wss://gateway.example",
    store: options.store,
    logger,
    onMessage: () => undefined,
    socketFactory: () => new FakeSocket(),
  });
  return new EarService({
    store: options.store,
    policy: () => options.policy,
    gateway,
    adapter: options.adapter,
    leaseMs: 1_000,
    logger,
  });
}

test("first binding persists and a restarted adapter resumes its dedicated session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-binding-restart-"));
  const path = join(directory, "queue.db");
  const policy = testPolicy({ quietWindowMs: 0 });
  const client = new FakeSdkClient();
  let sessionId = "";
  try {
    const firstStore = new EventStore(path, new FakeClock(1_000));
    firstStore.enqueue(message("first"), policy, false, 10);
    const firstBatch = firstStore.leaseNext(policy, 1_000);
    assert.ok(firstBatch);
    sessionId = firstBatch.binding.sessionId;
    const firstAdapter = sdkAdapter(client);
    await firstAdapter.deliver(firstBatch);
    assert.equal(client.creates, 1);
    assert.deepEqual(client.sessions.get(sessionId)?.sends[0], {
      prompt: firstBatch.summary,
      source: "system",
      mode: "enqueue",
    });
    firstStore.ack(firstBatch.claimToken);
    await firstAdapter.close();
    firstStore.close();

    const restartedStore = new EventStore(path, new FakeClock(2_000));
    assert.equal(
      restartedStore.getBinding(firstBatch.binding.conversation.key)?.sessionId,
      sessionId,
    );
    restartedStore.enqueue(message("after-restart"), policy, false, 10);
    const resumedBatch = restartedStore.leaseNext(policy, 1_000);
    assert.ok(resumedBatch);
    const restartedAdapter = sdkAdapter(client);
    await restartedAdapter.deliver(resumedBatch);
    assert.equal(client.resumes, 1);
    await restartedAdapter.close();
    restartedStore.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("two Discord conversations use isolated Copilot sessions", async () => {
  const store = new EventStore(":memory:", new FakeClock(1_000));
  const policy = testPolicy({
    quietWindowMs: 0,
    allowedChannelIds: ["channel-1", "channel-2"],
  });
  const client = new FakeSdkClient();
  const adapter = sdkAdapter(client);
  store.enqueue(message("one"), policy, false, 10);
  store.enqueue(message("two", { channel_id: "channel-2" }), policy, false, 10);
  const first = store.leaseNext(policy, 1_000);
  assert.ok(first);
  await adapter.deliver(first);
  store.ack(first.claimToken);
  const second = store.leaseNext(policy, 1_000);
  assert.ok(second);
  await adapter.deliver(second);
  assert.notEqual(first.binding.sessionId, second.binding.sessionId);
  assert.equal(client.sessions.size, 2);
  await adapter.close();
  store.close();
});

test("authorized new rotates once while unauthorized new remains untrusted content", () => {
  const store = new EventStore(":memory:", new FakeClock(1_000));
  const policy = testPolicy({ quietWindowMs: 0, priorityAuthorIds: ["figs"] });
  const service = serviceFixture({
    store,
    policy,
    adapter: sdkAdapter(new FakeSdkClient()),
  });
  service.ingest(message("before"));
  const first = store.getBinding("guild:guild-1:channel:channel-1");
  assert.equal(first?.generation, 1);

  assert.equal(
    service.ingest(
      message("rotate", {
        author: { id: "figs" },
        content: "/new",
      }),
    ),
    "binding_rotated",
  );
  const second = store.getBinding("guild:guild-1:channel:channel-1");
  assert.equal(second?.generation, 2);
  assert.notEqual(second?.sessionId, first?.sessionId);
  assert.equal(store.listEvents()[0]?.state, "dead_letter");
  assert.equal(
    service.ingest(
      message("rotate", {
        author: { id: "figs" },
        content: "/new",
      }),
    ),
    "duplicate_control",
  );
  assert.equal(
    store.getBinding("guild:guild-1:channel:channel-1")?.generation,
    2,
  );

  assert.equal(
    service.ingest(message("unauthorized", { content: "/new" })),
    "inserted",
  );
  assert.equal(
    store.getBinding("guild:guild-1:channel:channel-1")?.generation,
    2,
  );
  assert.equal(
    store.listEvents().find((event) => event.messageId === "unauthorized")
      ?.content,
    "/new",
  );
  store.close();
});

test("rotation fences queued and leased predecessor events from successor delivery", () => {
  const store = new EventStore(":memory:", new FakeClock(1_000));
  const policy = testPolicy({ quietWindowMs: 0 });
  store.enqueue(message("leased-old"), policy, false, 10);
  store.enqueue(message("pending-old"), policy, false, 10);
  const oldLease = store.leaseNext(policy, 1_000, 1);
  assert.ok(oldLease);
  const rotated = store.rotate(
    conversationIdentity(message("identity")),
    "rotation-request",
    "operator",
    "test",
  );
  assert.equal(rotated.binding.generation, 2);
  assert.equal(rotated.fencedEvents, 2);
  assert.equal(store.ack(oldLease.claimToken), 0);
  assert.deepEqual(
    store.listEvents().map((event) => event.state),
    ["dead_letter", "dead_letter"],
  );

  store.enqueue(message("successor"), policy, false, 10);
  const successor = store.leaseNext(policy, 1_000);
  assert.ok(successor);
  assert.equal(successor.binding.generation, 2);
  assert.deepEqual(
    successor.events.map((event) => event.messageId),
    ["successor"],
  );
  store.close();
});

test("busy sessions accept enqueue mode and SDK rejection releases the lease", async () => {
  const store = new EventStore(":memory:", new FakeClock(1_000));
  const policy = testPolicy({ quietWindowMs: 0 });
  const client = new FakeSdkClient();
  const adapter = sdkAdapter(client);
  const service = serviceFixture({ store, policy, adapter });
  store.enqueue(message("busy"), policy, false, 10);
  const binding = store.getBinding("guild:guild-1:channel:channel-1");
  assert.ok(binding);
  const session = new FakeSdkSession(binding.sessionId);
  session.busy = true;
  client.sessions.set(binding.sessionId, session);
  await service.deliverOnce();
  assert.equal(store.listEvents()[0]?.state, "delivered");
  assert.equal(session.sends[0]?.mode, "enqueue");

  store.enqueue(message("rejected"), policy, false, 10);
  session.rejection = new Error("synthetic rejection");
  await service.deliverOnce();
  assert.equal(
    store.listEvents().find((event) => event.messageId === "rejected")?.state,
    "pending",
  );
  await service.stop();
  store.close();
});

test("ambiguous SDK timeout dead-letters rather than risking duplicate retry", async () => {
  const store = new EventStore(":memory:", new FakeClock(1_000));
  const policy = testPolicy({ quietWindowMs: 0 });
  const client = new FakeSdkClient();
  const adapter = sdkAdapter(client, { timeoutMs: 5 });
  const service = serviceFixture({ store, policy, adapter });
  store.enqueue(message("timeout"), policy, false, 10);
  const binding = store.getBinding("guild:guild-1:channel:channel-1");
  assert.ok(binding);
  const session = new FakeSdkSession(binding.sessionId);
  session.neverSettles = true;
  client.sessions.set(binding.sessionId, session);
  await service.deliverOnce();
  assert.equal(store.listEvents()[0]?.state, "dead_letter");
  assert.equal(
    store.listEvents()[0]?.deadLetterReason,
    "delivery_outcome_ambiguous",
  );
  await service.stop();
  store.close();
});

test("binding pause and unavailable SDK capability preserve pending queue rows", async () => {
  const store = new EventStore(":memory:", new FakeClock(1_000));
  const policy = testPolicy({ quietWindowMs: 0 });
  store.enqueue(message("paused"), policy, false, 10);
  const key = "guild:guild-1:channel:channel-1";
  store.setBindingPaused(key, true);
  assert.equal(store.leaseNext(policy, 1_000), undefined);
  store.setBindingPaused(key, false);

  const unavailable = new CopilotSdkAdapter({
    factory: new ReleasedCopilotSdkFactory(),
    timeoutMs: 100,
    maxCachedSessions: 1,
  });
  const service = serviceFixture({ store, policy, adapter: unavailable });
  await service.deliverOnce();
  const event = store.listEvents()[0];
  assert.equal(event?.state, "pending");
  assert.equal(event?.attempts, 0);
  assert.equal(unavailable.status().available, false);
  await service.stop();
  store.close();
});

test("delivery errors and untrusted content remain redacted in structured logs", async () => {
  const store = new EventStore(":memory:", new FakeClock(1_000));
  const policy = testPolicy({ quietWindowMs: 0 });
  const client = new FakeSdkClient();
  const adapter = sdkAdapter(client);
  const logs: string[] = [];
  const service = serviceFixture({ store, policy, adapter, logs });
  store.enqueue(
    message("redacted", { content: "sensitive untrusted payload" }),
    policy,
    false,
    10,
  );
  const binding = store.getBinding("guild:guild-1:channel:channel-1");
  assert.ok(binding);
  const session = new FakeSdkSession(binding.sessionId);
  session.rejection = new Error("sensitive untrusted payload");
  client.sessions.set(binding.sessionId, session);
  await service.deliverOnce();
  const output = logs.join("\n");
  assert.doesNotMatch(output, /sensitive untrusted payload/u);
  assert.match(output, /\[REDACTED\]/u);
  await service.stop();
  store.close();
});
