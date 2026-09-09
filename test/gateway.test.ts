import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DiscordGateway } from "../src/gateway.js";
import { StructuredLogger } from "../src/logger.js";
import { EventStore } from "../src/store.js";
import { FakeClock, FakeSocket } from "./helpers.js";

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
    restartedGateway.handlePayload({ op: 10, d: { heartbeat_interval: 60_000 } });
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
