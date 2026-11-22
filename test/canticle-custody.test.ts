// binary-canticle#161 item 4: custody and honest confirmation for what canticle exposes to a
// session. A push is claimed (its dedup tombstone), offered once the host hands it to the
// session, and echoed only when the session names its batch_id; `hear` is an exposure echoed
// at its own return. Every exposure is stamped with the compaction boundary the session's
// pressure hook reported, so custody can say whether what was heard is still in context.
// Records go in through the real record v1 consumer; what comes out is what the attached
// session is sent, and what canticle_custody and ear_status say about it.
import assert from "node:assert/strict";
import test from "node:test";

import type { DaemonMessage } from "../src/protocol.ts";
import { order, pushes, setup, status } from "./canticle-host.ts";
import type { Harness, MemoryConnection } from "./helpers.ts";

const SESSION = "11111111-aaaa-4aaa-8aaa-000000000001";

type Client = ReturnType<Harness["attach"]>;

interface CustodyRecord {
  station: string;
  stream: string;
  item: string;
  key: string;
  state: string;
  path: string;
  mode: string;
  shown: string;
  digest: string | null;
  exposures: number;
  claimedAt: number;
  offeredAt: number | null;
  echoedAt: number | null;
  echo: string | null;
}

interface Custody {
  ear: string;
  history: "complete" | "incomplete" | "unknown";
  reasons: string[];
  counts: Record<string, number>;
  records: CustodyRecord[];
  publication: string;
}

async function custody(
  h: Harness,
  client: Client,
  args: Record<string, unknown> = {},
): Promise<Custody> {
  const result = await h.call(client, "canticle_custody", args);
  assert.equal(result.ok, true, result.text);
  return JSON.parse(result.text) as Custody;
}

/** ear_status's custody summary for scribe, read synchronously. */
function summary(h: Harness): Record<string, unknown> | undefined {
  const ears = (
    h.daemon.status("scribe") as {
      ears: Array<{ canticleCustody?: Record<string, unknown> }>;
    }
  ).ears;
  return ears[0]?.canticleCustody;
}

/** Runs `spy` on each canticle event before the connection takes it. */
function onCanticle(
  connection: MemoryConnection,
  spy: (event: Extract<DaemonMessage, { type: "event" }>) => void,
): void {
  const deliver = connection.send.bind(connection);
  connection.send = (message) => {
    const event = message as DaemonMessage;
    if (event.type === "event" && event.meta.kind === "canticle") spy(event);
    deliver(message);
  };
}

test("ordering: a canticle push is claimed, then offered only when the host hands it over; nothing reads as pushed, offered or heard before", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const atHandover: unknown[] = [];
    onCanticle(shim.connection, () => {
      atHandover.push({
        pushed: status(h).counts.records_pushed ?? 0,
        custody: (summary(h)?.counts as Record<string, number>) ?? null,
      });
    });
    host.sing(1);
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1);
    const push = pushes(shim)[0]!;
    // The push names its batch as a Discord batch does, so the host's return can reach it.
    assert.equal(
      typeof push.batchId,
      "number",
      "the push has a batch identity the host can confirm",
    );
    assert.match(
      push.meta.batch_id ?? "",
      new RegExp(`^${push.batchId}-[0-9a-f]{8}$`, "u"),
      "the session's copy carries the delivery token",
    );
    // At the moment of handover the record is only claimed: deduplicated, not yet pushed,
    // offered or heard.
    assert.deepEqual(atHandover, [
      {
        pushed: 0,
        custody: {
          records: 1,
          echoed: 0,
          echoedBeforeBoundary: 0,
          echoedBoundaryUnknown: 0,
          offered: 0,
          claimed: 1,
        },
      },
    ]);
    let record = (await custody(h, shim)).records[0]!;
    assert.equal(record.state, "claimed");
    assert.equal(record.offeredAt, null);
    // The shim writes the notification to Claude Code, then says so.
    await shim.send({ type: "offered", batchId: push.batchId! });
    record = (await custody(h, shim)).records[0]!;
    assert.equal(record.state, "offered");
    assert.equal(record.offeredAt, h.clock.now());
    assert.equal(record.echoedAt, null, "a push never reads as heard");
    assert.deepEqual(status(h).counts, { pushes: 1, records_pushed: 1 });
  } finally {
    h.dispose();
  }
});

test("ordering: a push no session took claims nothing; its record waits, and the next session gets it once", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    const broken = h.attach("scribe", { sessionId: SESSION });
    const deliver = broken.connection.send.bind(broken.connection);
    broken.connection.send = (message) => {
      const event = message as DaemonMessage;
      if (event.type === "event" && event.meta.kind === "canticle") {
        throw new Error("the socket refused the write");
      }
      deliver(message);
    };
    host.sing(1);
    h.timers.advance(6_000);
    assert.equal(pushes(broken).length, 0);
    assert.equal(
      status(h).counts.records_pushed ?? 0,
      0,
      "nothing counts as pushed",
    );
    assert.equal(status(h).waiting, 1, "the record still waits");
    // A working session takes the ear: the record goes to it, once.
    const shim = h.attach("scribe", { sessionId: SESSION });
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1);
    assert.deepEqual(order(pushes(shim)[0]!.content), ["ops:ops.fleet/1"]);
    h.timers.advance(60_000);
    assert.equal(pushes(shim).length, 1, "once");
    assert.deepEqual(status(h).counts, {
      pushes: 1,
      records_pushed: 1,
      unsent: 1,
    });
    const custodyNow = await custody(h, shim);
    assert.equal(custodyNow.records.length, 1, "one claim, the one that went");
    assert.equal(custodyNow.records[0]!.exposures, 1);
  } finally {
    h.dispose();
  }
});
