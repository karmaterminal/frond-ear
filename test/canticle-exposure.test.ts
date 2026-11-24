// frond-ear#117: an exposure ledger fed from custody, in binary-canticle#162's shape
// (`canticle-payload-exposure/1`). Each canticle push that carries records is fenced in the
// ledger before it is handed to the session (custody's claim), offered on the host's word,
// and echoed when the session names its whole batch_id; a fence is never cleared, only
// reconciled to unknown. frond-ear only records: no key, no signing, no issuer call. Records
// go in through the real record v1 consumer; what comes out is what the attached session is
// sent, and what the ledger, ear_status and `frond-ear exposure` say about it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { runExposure } from "../src/canticle/exposure-cli.ts";
import { conformant, type ExposureEntry } from "../src/canticle/exposure.ts";
import type {
  HeardFrameFlags,
  HeardFrameTimes,
  PayloadExposure,
  PayloadSource,
  Tuple,
} from "../src/canticle/exposure-v1.ts";
import type { DaemonMessage } from "../src/protocol.ts";
import { EventStore } from "../src/store.ts";
import {
  canticleConfig,
  offered,
  OPS,
  order,
  pushes,
  SESSION,
  setup,
} from "./canticle-host.ts";
import type { Harness, MemoryConnection } from "./helpers.ts";

const OTHER_SESSION = "22222222-bbbb-4bbb-8bbb-000000000002";
const ON = { exposure: { enabled: true } };

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

const ledger = (h: Harness): ExposureEntry[] =>
  h.store.canticleExposures("scribe", 0);

/** ear_status's exposure summary for scribe. */
function summary(h: Harness): Record<string, unknown> | undefined {
  return (
    h.daemon.status("scribe") as {
      ears: Array<{ canticleExposure?: Record<string, unknown> }>;
    }
  ).ears[0]?.canticleExposure;
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
    return deliver(message);
  };
}

/**
 * Each record's rendered entry in a push, in the order the text carries them: its banner
 * through its payload, up to the blank line before the next entry. Read from the pushed
 * text itself, independently of how frond-ear built it.
 */
const entries = (content: string) =>
  content.split("\n\n").filter((part) => part.startsWith("[canticle:heard]"));

// ---- the conformance check against #162's PayloadExposure ---------------------------

// Every key of the vendored types, and only those: `satisfies` fails to compile if the
// vendored type gains or loses one, so the runtime check below can't drift from it.
const EXPOSURE_KEYS = {
  version: 1,
  binding: 1,
  reader: 1,
  toolCallId: 1,
  resultSha256: 1,
  resultBytes: 1,
  sources: 1,
} as const satisfies Record<keyof PayloadExposure, 1>;
const READER_KEYS = {
  sessionKey: 1,
  sessionId: 1,
  lifecycleRevision: 1,
} as const satisfies Record<keyof PayloadExposure["reader"], 1>;
const SOURCE_KEYS = {
  item: 1,
  idem: 1,
  root: 1,
  hop: 1,
  class: 1,
  scope: 1,
  lens: 1,
  station: 1,
  principal: 1,
  stream: 1,
  stateKey: 1,
  flags: 1,
  times: 1,
  sourceBody: 1,
  bodyRef: 1,
  renderedSha256: 1,
  renderedBytes: 1,
  receiver: 1,
} as const satisfies Record<keyof PayloadSource, 1>;
const TUPLE_KEYS = {
  key_id: 1,
  epoch: 1,
  stream_id: 1,
  seq: 1,
} as const satisfies Record<keyof Tuple, 1>;
const FLAG_KEYS = {
  refresh: 1,
  wake_derived: 1,
  exercise: 1,
} as const satisfies Record<keyof HeardFrameFlags, 1>;
const TIME_KEYS = {
  issued_at: 1,
  expires_at: 1,
  received_at: 1,
  heard_at: 1,
  offset_ms: 1,
  local_expiry_at: 1,
} as const satisfies Record<keyof HeardFrameTimes, 1>;
const BODY_KEYS = { ctype: 1, size: 1, sha256: 1, textSha256: 1 } as const;
const REF_KEYS = { url: 1, sha256: 1, size: 1 } as const;
const RECEIVER_KEYS = {
  run: 1,
  source: 1,
  journalSequence: 1,
  recordSequence: 1,
} as const satisfies Record<keyof PayloadSource["receiver"], 1>;

const HEX64 = /^[0-9a-f]{64}$/u;

function keys(value: unknown, expected: object, where: string) {
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${where} is an object`,
  );
  assert.deepEqual(
    Object.keys(value).sort(),
    Object.keys(expected).sort(),
    `${where} has exactly #162's keys`,
  );
  return value as Record<string, unknown>;
}

const isInt = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v);
const isStr = (v: unknown) => typeof v === "string";
const orNull = (check: (v: unknown) => boolean) => (v: unknown) =>
  v === null || check(v);

function tuple(value: unknown, where: string) {
  const t = keys(value, TUPLE_KEYS, where);
  assert.ok(isStr(t.key_id), `${where}.key_id`);
  assert.ok(isInt(t.epoch), `${where}.epoch`);
  assert.ok(isInt(t.stream_id), `${where}.stream_id`);
  assert.ok(isInt(t.seq) || isStr(t.seq), `${where}.seq`);
}

/** A structural check that `value` is a `PayloadExposure` as #162 types it, field by field. */
function assertPayloadExposure(value: unknown): void {
  const x = keys(value, EXPOSURE_KEYS, "exposure");
  assert.equal(x.version, "canticle-payload-exposure/1");
  assert.ok(isStr(x.binding) && x.binding !== "", "binding");
  assert.ok(isStr(x.toolCallId) && x.toolCallId !== "", "toolCallId");
  assert.match(String(x.resultSha256), HEX64);
  assert.ok(isInt(x.resultBytes), "resultBytes");
  const reader = keys(x.reader, READER_KEYS, "reader");
  for (const field of Object.keys(READER_KEYS)) {
    assert.ok(isStr(reader[field]), `reader.${field} is a string`);
  }
  assert.ok(Array.isArray(x.sources), "sources");
  (x.sources as unknown[]).forEach((source, i) => {
    const where = `sources[${i}]`;
    const s = keys(source, SOURCE_KEYS, where);
    tuple(s.item, `${where}.item`);
    if (s.root !== null) tuple(s.root, `${where}.root`);
    assert.ok(isStr(s.idem), `${where}.idem`);
    assert.ok(isInt(s.hop), `${where}.hop`);
    assert.ok(isStr(s.class), `${where}.class`);
    assert.ok(orNull(isStr)(s.scope), `${where}.scope`);
    assert.ok(orNull(isInt)(s.lens), `${where}.lens`);
    assert.ok(isStr(s.station), `${where}.station`);
    assert.ok(orNull(isStr)(s.principal), `${where}.principal`);
    assert.ok(isStr(s.stream), `${where}.stream`);
    assert.ok(orNull(isStr)(s.stateKey), `${where}.stateKey`);
    const flags = keys(s.flags, FLAG_KEYS, `${where}.flags`);
    assert.equal(typeof flags.refresh, "boolean");
    assert.ok(orNull((v) => typeof v === "boolean")(flags.wake_derived));
    assert.equal(typeof flags.exercise, "boolean");
    const times = keys(s.times, TIME_KEYS, `${where}.times`);
    for (const field of Object.keys(TIME_KEYS)) {
      assert.ok(
        (field === "received_at" ? orNull(isInt) : isInt)(times[field]),
        `${where}.times.${field}`,
      );
    }
    if (s.sourceBody !== null) {
      const body = keys(s.sourceBody, BODY_KEYS, `${where}.sourceBody`);
      assert.ok(isStr(body.ctype) || isInt(body.ctype));
      assert.ok(isInt(body.size));
      assert.match(String(body.sha256), HEX64);
      assert.ok(orNull(isStr)(body.textSha256));
    }
    if (s.bodyRef !== null) {
      const ref = keys(s.bodyRef, REF_KEYS, `${where}.bodyRef`);
      assert.ok(isStr(ref.url) && isStr(ref.sha256) && isInt(ref.size));
    }
    assert.match(String(s.renderedSha256), HEX64);
    assert.ok(isInt(s.renderedBytes), `${where}.renderedBytes`);
    const receiver = keys(s.receiver, RECEIVER_KEYS, `${where}.receiver`);
    assert.ok(isStr(receiver.run));
    assert.ok(receiver.source === "live" || receiver.source === "snapshot");
    assert.ok(orNull(isInt)(receiver.journalSequence));
    assert.ok(orNull(isInt)(receiver.recordSequence));
  });
}

// ---- proofs -----------------------------------------------------------------------

test("fence then offer: one canticle push is fenced in the ledger before the session gets it, then offered on the host's word: one record, its sources in output order, its hashes the pushed bytes", async () => {
  const { h, host } = setup({ mode: "immediate" }, ON);
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const atHandover: ExposureEntry[][] = [];
    onCanticle(shim.connection, () => atHandover.push(ledger(h)));
    // Sung fleet first, then deploy; a push carries them by station:stream, deploy first.
    host.sing(1);
    host.sing(2, { stream: "ops.deploy" });
    host.sing(3);
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1);
    const push = pushes(shim)[0]!;
    assert.deepEqual(order(push.content), [
      "ops:ops.deploy/2",
      "ops:ops.fleet/1",
      "ops:ops.fleet/3",
    ]);
    // Fenced, durably, before the connection took the push.
    assert.equal(atHandover.length, 1);
    assert.equal(atHandover[0]!.length, 1, "exactly one record, fenced");
    const fenced = atHandover[0]![0]!;
    assert.equal(fenced.phase, "fenced");
    assert.equal(fenced.batchId, push.batchId);
    assert.equal(fenced.offered, null);
    assert.equal(fenced.echoed, null);
    assert.equal(fenced.unknown, null);

    await shim.send({ type: "offered", batchId: push.batchId! });
    const rows = ledger(h);
    assert.equal(rows.length, 1, "offering adds no record");
    const row = rows[0]!;
    assert.equal(row.phase, "offered");
    assert.equal(row.pendingId, fenced.pendingId, "the pendingId is stable");
    assert.deepEqual(row.offered, { at: h.clock.now(), sessionId: SESSION });
    assert.deepEqual(row.record, fenced.record, "the record is as fenced");

    const record = row.record;
    assert.equal(record.version, "canticle-payload-exposure/1");
    assert.equal(record.binding, "frond-ear:scribe");
    assert.deepEqual(record.reader, {
      sessionKey: "frond-ear:scribe",
      sessionId: SESSION,
      lifecycleRevision: "attach:1",
    });
    assert.equal(row.holder, "known");
    // The bare id: the delivery token is the session's to echo, never kept.
    assert.equal(record.toolCallId, `push:${push.batchId}`);
    assert.ok(
      !JSON.stringify(row).includes(push.meta.batch_id!.split("-")[1]!),
    );
    // The whole pushed event text.
    assert.equal(record.resultSha256, sha256(push.content));
    assert.equal(record.resultBytes, Buffer.byteLength(push.content));
    // Sources in actual output order, each hashing its own rendered entry.
    assert.deepEqual(
      record.sources.map((s) => `${s.station}:${s.stream}/${s.item.seq}`),
      ["ops:ops.deploy/2", "ops:ops.fleet/1", "ops:ops.fleet/3"],
    );
    const shown = entries(push.content);
    assert.equal(shown.length, 3);
    record.sources.forEach((source, i) => {
      assert.equal(source.renderedSha256, sha256(shown[i]!), `entry ${i}`);
      assert.equal(source.renderedBytes, Buffer.byteLength(shown[i]!));
    });
    // Provenance from the verified record, never from the rendered text.
    const first = record.sources[0]!;
    assert.deepEqual(first.item, {
      key_id: OPS,
      epoch: 7,
      stream_id: first.item.stream_id,
      seq: 2,
    });
    assert.equal(first.idem, `canticle:${OPS}:7:ops.deploy:2`);
    assert.equal(first.receiver?.run, "a1b2");
    assert.equal(first.receiver?.source, "live");
    assert.equal(first.receiver?.journalSequence, null);
    assert.equal(typeof first.receiver?.recordSequence, "number");
    assert.deepEqual(first.sourceBody, {
      ctype: 1,
      size: Buffer.byteLength("deploy.started 2"),
      sha256: sha256("deploy.started 2"),
      textSha256: sha256("deploy.started 2"),
    });
  } finally {
    h.dispose();
  }
});

test("idempotent: fencing the same exposure again, or a duplicate offered, keeps one record under the same pendingId; another record for the same push is refused", async () => {
  const { h, host } = setup({ mode: "immediate" }, ON);
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const push = await offered(h, host, shim, 1);
    const [row] = ledger(h);
    assert.ok(row);
    const offeredAt = row.offered!.at;
    // The host says it again, later: nothing moves.
    h.clock.advance(5_000);
    await shim.send({ type: "offered", batchId: push.batchId! });
    assert.deepEqual(ledger(h), [row]);
    assert.equal(ledger(h)[0]!.offered!.at, offeredAt);
    // A retried fence of the same exposure: same pendingId, no second record, phase kept.
    const again = h.store.fenceCanticleExposure("scribe", push.batchId!, {
      record: row.record,
      holder: row.holder,
    });
    assert.equal(again, row.pendingId);
    assert.deepEqual(ledger(h), [row]);
    // A different record under the same push is not the same exposure: refused, nothing kept.
    assert.throws(
      () =>
        h.store.fenceCanticleExposure("scribe", push.batchId!, {
          record: { ...row.record, resultSha256: sha256("something else") },
          holder: row.holder,
        }),
      /already fenced/u,
    );
    assert.deepEqual(ledger(h), [row]);
  } finally {
    h.dispose();
  }
});

test("echo: naming the whole batch_id upgrades the record to echoed, its offered receipt kept; a foreign session's echo is refused", async () => {
  const { h, host } = setup({ mode: "immediate" }, ON);
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const one = await offered(h, host, shim, 1);
    const offeredAt = h.clock.now();
    h.clock.advance(2_000);
    await h.call(shim, "ack", { batch_id: one.meta.batch_id });
    let row = ledger(h)[0]!;
    assert.equal(row.phase, "echoed");
    assert.deepEqual(row.offered, { at: offeredAt, sessionId: SESSION });
    assert.deepEqual(row.echoed, {
      at: h.clock.now(),
      sessionId: SESSION,
      by: "ack",
    });

    // The same shim now speaks for another session (a /clear in one process). That
    // session was never shown push two, so naming it, token and all, echoes nothing.
    const two = await offered(h, host, shim, 2);
    await shim.send({ type: "session", sessionId: OTHER_SESSION });
    const foreign = await h.call(shim, "ack", { batch_id: two.meta.batch_id });
    assert.match(foreign.text, /0 canticle records echoed/u);
    row = ledger(h).find((r) => r.batchId === two.batchId)!;
    assert.equal(row.phase, "offered", "a foreign session's echo is refused");
    assert.equal(row.echoed, null);
    // The ledger refuses it on its own terms too, whatever custody said.
    assert.equal(
      h.store.echoCanticleExposure("scribe", two.batchId!, {
        at: h.clock.now(),
        kind: "ack",
        sessionId: OTHER_SESSION,
        generation: 1,
      }),
      0,
    );
    assert.equal(
      ledger(h).find((r) => r.batchId === two.batchId)!.phase,
      "offered",
    );
  } finally {
    h.dispose();
  }
});

test("echo is atomic: a failure between the ledger's echo and custody's leaves the two agreeing, neither echoed", async () => {
  const { h, host } = setup({ mode: "immediate" }, ON);
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const push = await offered(h, host, shim, 1);
    // Custody's own echo fails after the ledger's has run: a fault injected between them.
    const database = (h.store as unknown as { database: DatabaseSync })
      .database;
    database.exec(`CREATE TEMP TRIGGER exposure_test_fault
      BEFORE UPDATE OF echoed_at ON canticle_custody
      BEGIN SELECT RAISE(ABORT, 'injected between the two echoes'); END`);
    const echo = {
      at: h.clock.now(),
      kind: "ack",
      sessionId: SESSION,
      generation: 1,
      boundary: undefined,
    };
    assert.throws(
      () => h.store.echoCanticleCustody("scribe", push.batchId!, echo),
      /injected between the two echoes/u,
    );
    assert.equal(
      ledger(h)[0]!.phase,
      "offered",
      "the ledger's echo rolled back",
    );
    assert.equal(ledger(h)[0]!.echoed, null);
    assert.ok(
      h.store.canticleCustody("scribe", 0).every((r) => r.echoedAt === null),
      "custody's echo never happened",
    );
    // Without the fault the same echo lands in both, whole.
    database.exec("DROP TRIGGER exposure_test_fault");
    assert.equal(h.store.echoCanticleCustody("scribe", push.batchId!, echo), 1);
    assert.equal(ledger(h)[0]!.phase, "echoed");
    assert.ok(
      h.store.canticleCustody("scribe", 0).every((r) => r.echoedAt !== null),
    );
  } finally {
    h.dispose();
  }
});

test("offer is atomic: a failure after the ledger's offer, in a push of several records, leaves the claim, the ledger and every custody row as they were, alone or inside a caller's transaction", async () => {
  const { h, host } = setup({ mode: "immediate" }, ON);
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1);
    host.sing(2);
    host.sing(3, { stream: "ops.deploy" });
    h.timers.advance(6_000);
    const push = pushes(shim)[0]!;
    const batchId = push.batchId!;
    const database = (h.store as unknown as { database: DatabaseSync })
      .database;
    const claims = () =>
      (
        database
          .prepare(
            "SELECT COUNT(*) AS n FROM canticle_claims WHERE batch_id = ?",
          )
          .get(batchId) as { n: number }
      ).n;
    const custody = () =>
      h.store.canticleCustody("scribe", 0).filter((r) => r.batchId === batchId);
    assert.equal(custody().length, 3, "one custody row per record");
    const untouched = () => {
      assert.equal(claims(), 1, "the claim is still there");
      assert.equal(
        ledger(h)[0]!.phase,
        "fenced",
        "the ledger's offer rolled back",
      );
      assert.equal(ledger(h)[0]!.offered, null);
      assert.ok(
        custody().every((r) => r.offeredAt === null),
        "no custody row was offered",
      );
    };
    // A fault in JS between the writes: after the ledger's offer, before custody's.
    const store = h.store as unknown as {
      offerCanticleExposure: (...args: unknown[]) => number;
    };
    const offerExposure = store.offerCanticleExposure;
    store.offerCanticleExposure = function (...args: unknown[]) {
      offerExposure.apply(this, args);
      throw new Error("injected after the ledger's offer");
    };
    const offer = {
      at: h.clock.now(),
      sessionId: SESSION,
      boundary: null,
    };
    // On its own: its own transaction.
    assert.throws(
      () => h.store.offerCanticleCustody("scribe", batchId, offer),
      /injected after the ledger's offer/u,
    );
    untouched();
    // Inside a caller's transaction that catches the failure and commits: still whole.
    h.store.atomically(() => {
      assert.throws(
        () => h.store.offerCanticleCustody("scribe", batchId, offer),
        /injected after the ledger's offer/u,
      );
    });
    untouched();
    // Without the fault, the real push path offers it whole, inside the daemon's own
    // transaction (confirmBatch with the offer), with no nested BEGIN.
    store.offerCanticleExposure = offerExposure;
    await shim.send({ type: "offered", batchId });
    assert.equal(claims(), 0);
    assert.equal(ledger(h)[0]!.phase, "offered");
    assert.deepEqual(ledger(h)[0]!.offered, {
      at: h.clock.now(),
      sessionId: SESSION,
    });
    assert.ok(custody().every((r) => r.offeredAt === h.clock.now()));
  } finally {
    h.dispose();
  }
});

test("crash: the fence is durable on disk at the moment of handover: a copy of the store taken then has the push fenced, reconciles to unknown at the next attach, and is never cleared", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-exposure-"));
  const path = join(directory, "ear.db");
  // The process dies the instant the push is handed over: what is on disk then is
  // everything a restart has. The database, its WAL and its shared memory are copied
  // at that moment, while the store is still open, and never closed cleanly.
  const crashed = join(directory, "crashed");
  mkdirSync(crashed);
  const copy = join(crashed, "ear.db");
  try {
    const first = setup({ mode: "immediate" }, ON, {}, { path });
    let pushed: number | null = null;
    let at = 0;
    try {
      const shim = first.h.attach("scribe", { sessionId: SESSION });
      onCanticle(shim.connection, (event) => {
        pushed = event.batchId;
        at = first.h.clock.now();
        for (const suffix of ["", "-wal", "-shm"]) {
          if (existsSync(`${path}${suffix}`)) {
            copyFileSync(`${path}${suffix}`, `${copy}${suffix}`);
          }
        }
      });
      first.host.sing(1);
      first.h.timers.advance(6_000);
      assert.equal(pushes(shim).length, 1);
      assert.ok(existsSync(copy), "the store was copied at handover");
    } finally {
      first.h.dispose();
    }

    // The store as the crash left it, reopened: the fence is there, still fenced.
    const reopened = new EventStore(copy);
    const kept = reopened.canticleExposures("scribe", 0);
    reopened.close();
    assert.equal(kept.length, 1, "the fence was on disk before the handover");
    assert.equal(kept[0]!.phase, "fenced");
    assert.equal(kept[0]!.batchId, pushed);

    const second = setup({ mode: "immediate" }, ON, {}, { path: copy });
    try {
      second.h.clock.value = at + 10_000;
      const next = second.h.attach("scribe", { sessionId: SESSION });
      let rows = ledger(second.h);
      assert.equal(rows.length, 1, "the revert cleared nothing");
      assert.equal(rows[0]!.phase, "unknown");
      assert.equal(rows[0]!.pendingId, kept[0]!.pendingId);
      assert.deepEqual(rows[0]!.unknown, {
        at: second.h.clock.now(),
        reason: "reverted",
      });
      assert.deepEqual(rows[0]!.record, kept[0]!.record);
      // Its record goes out again under a new push: a second exposure, its own record.
      second.host.sing(1);
      second.h.timers.advance(6_000);
      assert.equal(pushes(next).length, 1);
      await next.send({ type: "offered", batchId: pushes(next)[0]!.batchId! });
      rows = ledger(second.h);
      assert.deepEqual(
        rows.map((r) => r.phase),
        ["unknown", "offered"],
      );
      // A prune, however tight, never evicts an unknown.
      second.h.store.pruneCanticleExposure({ maxAgeMs: 0, maxRecords: 0 });
      assert.deepEqual(
        ledger(second.h).map((r) => r.phase),
        ["unknown"],
      );
    } finally {
      second.h.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unsent: a push no session's connection took is fenced, then unknown; the fence is never cleared", async () => {
  const { h, host } = setup({ mode: "immediate" }, ON);
  try {
    const broken = h.attach("scribe", { sessionId: SESSION });
    const deliver = broken.connection.send.bind(broken.connection);
    let fencedThen: string[] | undefined;
    broken.connection.send = (message) => {
      const event = message as DaemonMessage;
      if (event.type === "event" && event.meta.kind === "canticle") {
        fencedThen = ledger(h).map((r) => r.phase);
        throw new Error("the socket refused the write");
      }
      return deliver(message);
    };
    host.sing(1);
    h.timers.advance(6_000);
    assert.deepEqual(fencedThen, ["fenced"]);
    const rows = ledger(h);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.phase, "unknown");
    assert.deepEqual(rows[0]!.unknown, { at: h.clock.now(), reason: "unsent" });
  } finally {
    h.dispose();
  }
});

test("scope: each source carries its record's scope exactly as heard, never widened", async () => {
  const { h, host } = setup({ mode: "immediate" }, ON);
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1, { scope: "host" });
    host.sing(2, { scope: "fleet" });
    host.sing(3, { scope: "lan", stream: "ops.deploy" });
    host.sing(4, { scope: "host", stream: "ops.deploy" });
    h.timers.advance(6_000);
    await shim.send({ type: "offered", batchId: pushes(shim)[0]!.batchId! });
    const { record } = ledger(h)[0]!;
    assert.deepEqual(
      record.sources.map((s) => [`${s.stream}/${s.item.seq}`, s.scope]),
      [
        ["ops.deploy/3", "lan"],
        ["ops.deploy/4", "host"],
        ["ops.fleet/1", "host"],
        ["ops.fleet/2", "fleet"],
      ],
    );
    // Nothing anywhere in the record names a scope wider than its own source's.
    assert.ok(!("scope" in record), "no exposure-wide scope is made up");
  } finally {
    h.dispose();
  }
});

test("flag off: canticle.exposure is off by default, and off no row is written and behaviour and ear_status are as without the ledger (its empty table and index are in the schema)", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    assert.deepEqual(canticleConfig({ mode: "immediate" }).canticle!.exposure, {
      enabled: false,
      maxAgeMs: 7 * 24 * 3_600_000,
      maxRecords: 10_000,
    });
    const shim = h.attach("scribe", { sessionId: SESSION });
    const push = await offered(h, host, shim, 1);
    await h.call(shim, "ack", { batch_id: push.meta.batch_id });
    host.sing(2);
    h.timers.advance(6_000);
    shim.close();
    assert.deepEqual(ledger(h), []);
    // ear_status is as it was before the ledger: no canticleExposure at all.
    assert.equal(summary(h), undefined);
    assert.ok(
      !(
        "canticleExposure" in
        (h.daemon.status("scribe") as { ears: object[] }).ears[0]!
      ),
      "ear_status gains nothing with the flag off",
    );
    const db = new DatabaseSync(join(h.directory, "ear.db"), {
      readOnly: true,
    });
    try {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM canticle_exposure")
        .get() as { n: number };
      assert.equal(row.n, 0, "zero rows");
      // Not byte for byte the same database: the table and its index are there, empty.
      const schema = db
        .prepare(
          "SELECT type, name FROM sqlite_master WHERE name LIKE 'canticle_exposure%' ORDER BY name",
        )
        .all()
        .map((r) => `${r.type}:${r.name}`);
      assert.deepEqual(schema, [
        "table:canticle_exposure",
        "index:canticle_exposure_ear",
      ]);
    } finally {
      db.close();
    }
    // Custody went on as before: push 1 kept, push 2 given back at the close.
    assert.equal(h.store.canticleCustody("scribe", 0).length, 1);
  } finally {
    h.dispose();
  }
});

test("conformance: the stored record satisfies #162's PayloadExposure, structurally and as a type", async () => {
  const { h, host } = setup({ mode: "immediate" }, ON);
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    // Streams by number, as record v1 carries them (§14.18.3).
    host.sing(1, { streamId: 1 });
    host.sing(2, { binary: true, stream: "ops.deploy", streamId: 2 });
    host.sing(3, {
      streamId: 1,
      stateKey: "fleet.health",
      digest: sha256("deploy.started 3"),
    });
    h.timers.advance(6_000);
    await shim.send({ type: "offered", batchId: pushes(shim)[0]!.batchId! });
    const [row] = ledger(h);
    assert.ok(row);
    // Read back from SQLite as stored, not from memory.
    const typed: PayloadExposure | null = conformant(row.record);
    assert.ok(
      typed,
      "a record-v1 push to a known session is a PayloadExposure",
    );
    assertPayloadExposure(typed);
    assertPayloadExposure(JSON.parse(JSON.stringify(row.record)));
    assert.equal(typed.sources.length, 3);
    // A binary body with no digest and no text has no body to vouch for.
    const binary = typed.sources.find((s) => s.stream === "ops.deploy")!;
    assert.equal(binary.sourceBody, null);
    const keyed = typed.sources.find((s) => s.stateKey === "fleet.health")!;
    assert.equal(keyed.sourceBody?.sha256, sha256("deploy.started 3"));
    assert.deepEqual(
      typed.sources.map((s) => s.item.stream_id),
      [2, 1, 1],
    );
    // A stream record v1 named by something other than its number is never made one.
    host.sing(4);
    h.timers.advance(6_000);
    const named = ledger(h).at(-1)!;
    assert.equal(named.record.sources[0]!.item.stream_id, null);
    assert.equal(conformant(named.record), null);
  } finally {
    h.dispose();
  }
});

test("conformance: a reader frond-ear can't name (no session id) is kept, but is not passed off as a PayloadExposure", async () => {
  const { h, host } = setup({ mode: "immediate" }, ON);
  try {
    const shim = h.attach("scribe");
    host.sing(1);
    h.timers.advance(6_000);
    const [row] = ledger(h);
    assert.ok(row);
    assert.equal(row.phase, "fenced");
    assert.equal(row.record.reader.sessionId, null);
    assert.equal(row.holder, "unknown");
    assert.equal(conformant(row.record), null);
    shim.close();
  } finally {
    h.dispose();
  }
});

test("bounds: retention by age and count evicts only the oldest confirmed records, counted; fenced and unknown records are never evicted", async () => {
  const { h, host } = setup(
    { mode: "immediate" },
    {
      exposure: { enabled: true, maxAgeMs: 3_600_000, maxRecords: 2 },
    },
  );
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await offered(h, host, shim, 1);
    const two = await offered(h, host, shim, 2);
    await h.call(shim, "ack", { batch_id: two.meta.batch_id });
    await offered(h, host, shim, 3);
    // Four: one more, pushed and never offered (fenced), then given back (unknown).
    host.sing(4);
    h.timers.advance(6_000);
    shim.close();
    assert.deepEqual(
      ledger(h).map((r) => r.phase),
      ["offered", "echoed", "offered", "unknown"],
    );
    // Count: four records over a bound of two. Only confirmed ones go, oldest first,
    // until the bound holds: one and two go, three and the unknown four stay.
    const [, , three, four] = ledger(h);
    h.daemon.prune();
    assert.deepEqual(
      ledger(h).map((r) => r.pendingId),
      [three!.pendingId, four!.pendingId],
    );
    assert.equal(h.store.counters()["canticle_exposure_evicted.scribe"], 2);
    // Age: past an hour, every confirmed one goes; the unknown one stays.
    h.clock.advance(3_600_001);
    h.daemon.prune();
    assert.deepEqual(
      ledger(h).map((r) => r.phase),
      ["unknown"],
    );
    assert.equal(h.store.counters()["canticle_exposure_evicted.scribe"], 3);
    assert.equal(summary(h)!.evicted, 3);
  } finally {
    h.dispose();
  }
});

test("status: ear_status counts the ledger by phase", async () => {
  const { h, host } = setup({ mode: "immediate" }, ON);
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const one = await offered(h, host, shim, 1);
    await h.call(shim, "ack", { batch_id: one.meta.batch_id });
    await offered(h, host, shim, 2);
    host.sing(3);
    h.timers.advance(6_000);
    assert.deepEqual(summary(h), {
      enabled: true,
      records: 3,
      fenced: 1,
      offered: 1,
      echoed: 1,
      unknown: 0,
      evicted: 0,
      overBound: 0,
      reasons: [],
    });
    shim.close();
    assert.equal(summary(h)!.fenced, 0);
    assert.equal(summary(h)!.unknown, 1);
  } finally {
    h.dispose();
  }
});

test("cli: frond-ear exposure reads the ledger read-only, as JSON or lines, from --since; it writes no rows and creates no database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-exposure-"));
  const path = join(directory, "ear.db");
  try {
    const { h, host } = setup({ mode: "immediate" }, ON, {}, { path });
    let between: number;
    try {
      const shim = h.attach("scribe", { sessionId: SESSION });
      await offered(h, host, shim, 1);
      h.clock.advance(60_000);
      between = h.clock.now();
      h.clock.advance(60_000);
      await offered(h, host, shim, 2);
    } finally {
      h.dispose();
    }
    const run = async (argv: string[]) => {
      let out = "";
      let err = "";
      const code = await runExposure(argv, {
        stdout: { write: (s: string) => ((out += s), true) },
        stderr: { write: (s: string) => ((err += s), true) },
        env: { FROND_EAR_DATABASE: path },
      });
      return { code, out, err };
    };
    const all = await run(["--ear", "scribe", "--json"]);
    assert.equal(all.code, 0, all.err);
    const parsed = JSON.parse(all.out) as ExposureEntry[];
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]!.record.version, "canticle-payload-exposure/1");
    const since = await run([
      "--ear",
      "scribe",
      "--json",
      "--since",
      new Date(between).toISOString(),
    ]);
    assert.equal((JSON.parse(since.out) as ExposureEntry[]).length, 1);
    const lines = await run(["--ear", "scribe"]);
    assert.equal(lines.code, 0, lines.err);
    assert.equal(lines.out.trim().split("\n").length, 2);
    assert.match(lines.out, /offered/u);
    assert.doesNotMatch(
      lines.out,
      /deploy\.started/u,
      "never the payload text",
    );
    const other = await run(["--ear", "nobody", "--json"]);
    assert.deepEqual(JSON.parse(other.out), []);
    assert.equal((await run([])).code, 1, "--ear is required");
    assert.equal((await run(["--ear", "scribe", "--since", "soon"])).code, 1);
    // No store there: it says so, and creates no database.
    const none = join(directory, "none.db");
    let err = "";
    const code = await runExposure(["--ear", "scribe"], {
      stdout: { write: () => true },
      stderr: { write: (s: string) => ((err += s), true) },
      env: { FROND_EAR_DATABASE: none },
    });
    assert.equal(code, 1);
    assert.match(err, /no frond-ear database/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("config: canticle.exposure takes enabled, maxAgeMs and maxRecords, and refuses anything else", () => {
  const parse = (exposure: unknown) =>
    canticleConfig(undefined, { exposure }).canticle!.exposure;
  assert.equal(parse(undefined).enabled, false);
  assert.equal(parse({}).enabled, false);
  assert.equal(parse({ enabled: true }).enabled, true);
  assert.equal(parse({ maxRecords: 5 }).maxRecords, 5);
  assert.throws(
    () => parse({ enabled: "yes" }),
    /canticle\.exposure\.enabled/u,
  );
  assert.throws(
    () => parse({ maxRecords: 0 }),
    /canticle\.exposure\.maxRecords/u,
  );
  assert.throws(() => parse({ maxAgeMs: -1 }), /canticle\.exposure\.maxAgeMs/u);
  assert.throws(() => parse({ issuer: "x" }), /canticle\.exposure/u);
  assert.throws(() => parse("on"), /canticle\.exposure/u);
});

test("ctype: a body whose record v1 names no ctype keeps a null ctype, never a made-up 1, and is not passed off as a PayloadExposure", async () => {
  const { h, host } = setup({ mode: "immediate" }, ON);
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1, { streamId: 1, ctype: null });
    h.timers.advance(6_000);
    await shim.send({ type: "offered", batchId: pushes(shim)[0]!.batchId! });
    const [row] = ledger(h);
    assert.ok(row);
    // The body's hash is still the body's: only the ctype record v1 left out is unknown.
    assert.deepEqual(row.record.sources[0]!.sourceBody, {
      ctype: null,
      size: Buffer.byteLength("deploy.started 1"),
      sha256: sha256("deploy.started 1"),
      textSha256: sha256("deploy.started 1"),
    });
    // #162 takes no body without a ctype (its bodyOf refuses one), so neither does this.
    assert.equal(conformant(row.record), null);
    // The same record with its ctype said is conformant: the ctype is all that differs.
    host.sing(2, { streamId: 1 });
    h.timers.advance(6_000);
    await shim.send({ type: "offered", batchId: pushes(shim)[1]!.batchId! });
    const said = ledger(h).at(-1)!;
    assert.equal(said.record.sources[0]!.sourceBody?.ctype, 1);
    assert.ok(conformant(said.record));
  } finally {
    h.dispose();
  }
});

test("over bound: fenced and unknown records alone past maxRecords are never evicted, but each prune that finds them so warns, counted, and ear_status names it", async () => {
  const { h, host } = setup(
    { mode: "immediate" },
    { exposure: { enabled: true, maxAgeMs: 3_600_000, maxRecords: 1 } },
  );
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    // Two pushes never offered, given back at the close: two unknown, over a bound of one.
    host.sing(1);
    h.timers.advance(6_000);
    host.sing(2);
    h.timers.advance(6_000);
    shim.close();
    assert.deepEqual(
      ledger(h).map((r) => r.phase),
      ["unknown", "unknown"],
    );
    assert.deepEqual(summary(h)!.reasons, [
      "2 fenced or unknown records over maxRecords 1; they are never evicted",
    ]);
    h.daemon.prune();
    assert.equal(ledger(h).length, 2, "nothing evicted");
    assert.equal(h.store.counters()["canticle_exposure_over_bound.scribe"], 1);
    const warned = h.logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.event === "canticle.exposure_over_bound");
    assert.equal(warned.length, 1);
    assert.equal(warned[0]!.level, "warn");
    assert.equal(warned[0]!.ear, "scribe");
    assert.equal(warned[0]!.held, 2);
    assert.equal(warned[0]!.maxRecords, 1);
    h.daemon.prune();
    assert.equal(h.store.counters()["canticle_exposure_over_bound.scribe"], 2);
    assert.equal(summary(h)!.overBound, 2);
    // Under the bound again, no reason and no further warning.
    const roomy = setup(
      { mode: "immediate" },
      { exposure: { enabled: true, maxRecords: 5 } },
    );
    try {
      roomy.h.attach("scribe", { sessionId: SESSION });
      roomy.h.daemon.prune();
      assert.deepEqual(summary(roomy.h)!.reasons, []);
      assert.equal(summary(roomy.h)!.overBound, 0);
    } finally {
      roomy.h.dispose();
    }
  } finally {
    h.dispose();
  }
});
