import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { StructuredLogger } from "../src/logger.js";
import { classifyMessage } from "../src/policy.js";
import { EventStore } from "../src/store.js";
import { FakeClock, message, testPolicy } from "./helpers.js";

function withDatabase(
  run: (context: { path: string; store: EventStore; clock: FakeClock }) => void,
): void {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-test-"));
  const path = join(directory, "queue.db");
  const clock = new FakeClock(1_000);
  const store = new EventStore(path, clock);
  try {
    run({ path, store, clock });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("duplicate Discord message replay remains idempotent across restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-restart-"));
  const path = join(directory, "queue.db");
  const policy = testPolicy();
  const first = new EventStore(path, new FakeClock(1_000));
  assert.equal(first.enqueue(message("same"), policy, false, 12), "inserted");
  first.close();
  const restarted = new EventStore(path, new FakeClock(2_000));
  try {
    assert.equal(restarted.enqueue(message("same"), policy, false, 12), "duplicate");
    assert.equal(restarted.listEvents().length, 1);
  } finally {
    restarted.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("priority authors and direct mentions override suppressions inside allowlists", () => {
  const policy = testPolicy({
    priorityAuthorIds: ["figs"],
    ignoredAuthorIds: ["figs", "noisy"],
    ignoredPatterns: ["ignore me"],
  });
  assert.deepEqual(
    classifyMessage(message("figs", { author: { id: "figs" }, content: "ignore me" }), policy),
    { accepted: true, priority: true, reason: "priority", weight: 9 },
  );
  assert.equal(
    classifyMessage(
      message("mention", {
        author: { id: "noisy" },
        content: "ignore me",
        mentions: [{ id: "bot-1" }],
      }),
      policy,
    ).priority,
    true,
  );
});

test("ignored authors, patterns, event classes, guilds, channels, and self are rejected", () => {
  const policy = testPolicy({
    ignoredAuthorIds: ["ignored"],
    ignoredPatterns: ["heartbeat"],
    ignoredEventClasses: [19],
  });
  assert.equal(
    classifyMessage(message("a", { author: { id: "ignored" } }), policy).reason,
    "ignored_author",
  );
  assert.equal(
    classifyMessage(message("b", { content: "HEARTBEAT pulse" }), policy).reason,
    "ignored_pattern",
  );
  assert.equal(classifyMessage(message("c", { type: 19 }), policy).reason, "ignored_event_class");
  assert.equal(
    classifyMessage(message("d", { guild_id: "other" }), policy).reason,
    "guild_not_allowed",
  );
  assert.equal(
    classifyMessage(message("e", { channel_id: "other" }), policy).reason,
    "channel_not_allowed",
  );
  assert.equal(
    classifyMessage(message("f", { author: { id: "bot-1", bot: true } }), policy).reason,
    "self_message",
  );
});

test("noisy burst coalesces while priority remains an independent first lease", () => {
  withDatabase(({ store, clock }) => {
    const policy = testPolicy({ priorityAuthorIds: ["figs"] });
    assert.equal(store.enqueue(message("normal-1"), policy, false, 10), "inserted");
    assert.equal(store.enqueue(message("normal-2"), policy, false, 10), "inserted");
    assert.equal(
      store.enqueue(message("priority", { author: { id: "figs" } }), policy, true, 10),
      "inserted",
    );
    const priority = store.leaseNext(policy, 500);
    assert.equal(priority?.priority, true);
    assert.deepEqual(priority?.events.map((event) => event.messageId), ["priority"]);
    assert.equal(store.ack(priority?.claimToken ?? ""), 1);
    clock.advance(101);
    const burst = store.leaseNext(policy, 500);
    assert.equal(burst?.priority, false);
    assert.deepEqual(
      burst?.events.map((event) => event.messageId),
      ["normal-1", "normal-2"],
    );
    assert.match(burst?.summary ?? "", /Untrusted Discord event data/u);
    assert.equal(store.counters().coalesced_events, 1);
  });
});

test("overflow explicitly dead-letters noise and preserves admitted priority", () => {
  withDatabase(({ store }) => {
    const policy = testPolicy({ maxQueueCount: 2, maxQueueWeight: 30 });
    assert.equal(store.enqueue(message("normal-1"), policy, false, 15), "inserted");
    assert.equal(store.enqueue(message("normal-2"), policy, false, 15), "inserted");
    assert.equal(store.enqueue(message("normal-3"), policy, false, 15), "overflow");
    assert.equal(store.enqueue(message("priority"), policy, true, 15), "inserted");
    const states = Object.fromEntries(
      store.listEvents().map((event) => [event.messageId, event.state]),
    );
    assert.equal(states["normal-1"], "dead_letter");
    assert.equal(states["normal-3"], "dead_letter");
    assert.equal(states.priority, "pending");
  });
});

test("lease expiry recovers a crash before ack", () => {
  withDatabase(({ store, clock }) => {
    const policy = testPolicy({ quietWindowMs: 0 });
    store.enqueue(message("leased"), policy, false, 10);
    const first = store.leaseNext(policy, 50);
    assert.ok(first);
    clock.advance(51);
    const recovered = store.leaseNext(policy, 50);
    assert.equal(recovered?.events[0]?.messageId, "leased");
    assert.notEqual(recovered?.claimToken, first.claimToken);
  });
});

test("delivery failures release then dead-letter at the configured attempt bound", () => {
  withDatabase(({ store }) => {
    const policy = testPolicy({ quietWindowMs: 0, maxDeliveryAttempts: 2 });
    store.enqueue(message("failure"), policy, false, 10);
    const first = store.leaseNext(policy, 50);
    assert.equal(store.release(first?.claimToken ?? "", "first failure", 2), 1);
    assert.equal(store.listEvents()[0]?.state, "pending");
    const second = store.leaseNext(policy, 50);
    assert.equal(store.release(second?.claimToken ?? "", "second failure", 2), 1);
    assert.equal(store.listEvents()[0]?.state, "dead_letter");
  });
});

test("Gateway kill switch rejects new ingestion and wake pause preserves queued work", () => {
  withDatabase(({ store }) => {
    const stopped = testPolicy({ gatewayEnabled: false });
    assert.equal(classifyMessage(message("stopped"), stopped).reason, "gateway_disabled");
    assert.equal(store.listEvents().length, 0);

    const active = testPolicy({ quietWindowMs: 0 });
    store.enqueue(message("queued"), active, false, 10);
    const paused = testPolicy({ quietWindowMs: 0, wakeDeliveryPaused: true });
    assert.equal(store.leaseNext(paused, 50), undefined);
    assert.equal(store.listEvents()[0]?.state, "pending");
  });
});

test("structured logs redact token values and content fields", () => {
  const token = "token-fixture-value";
  const lines: string[] = [];
  const logger = new StructuredLogger((line) => lines.push(line), [token]);
  logger.log("info", "fixture", {
    token,
    nested: { content: "untrusted words", message: `prefix ${token} suffix` },
  });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0] ?? "", new RegExp(token, "u"));
  assert.doesNotMatch(lines[0] ?? "", /untrusted words/u);
  assert.match(lines[0] ?? "", /\[REDACTED\]/u);
});
