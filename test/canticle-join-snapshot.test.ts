// RFC-0001 §14.18.3 "Join snapshot" (amendment BC-1b, D36, binary-canticle#81): the
// binding side of proof case (5)(a)–(h) of §14.18.2, frond-ear#44.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { renderHear } from "../src/canticle/hear.ts";
import { RecordClient } from "../src/canticle/record-client.ts";
import {
  JOIN_SNAPSHOT_REQUEST,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_ENTRIES,
  RECORD_V,
  RecordConsumer,
} from "../src/canticle/records.ts";
import { StructuredLogger } from "../src/logger.ts";

const NOW = 1_790_000_100_000;
const RUN = "a1b2";
const TUNE = ["*:ops.fleet"];
const logger = new StructuredLogger(() => {});

type R = Record<string, unknown>;

/** A record at an exact rec_seq. */
const R = (type: string, recSeq: number, extra: R = {}, run = RUN): R => ({
  v: RECORD_V,
  type,
  rec_seq: recSeq,
  run,
  ...extra,
});
const idem = (item: number) => `canticle:f6eecf2f43082a97:7:1:${item}`;
/** A deliverable `frame` record for item `item`, at `recSeq`. */
const frame = (recSeq: number, item: number, extra: R = {}): R =>
  R("frame", recSeq, {
    frame: {
      key_id: "f6eecf2f43082a97",
      epoch: 7,
      stream_id: 1,
      seq: item,
      kind: "item",
      sha256: "00",
      bytes: 100,
    },
    idem: idem(item),
    station: { name: "ops", principal: null },
    stream: "ops.fleet",
    class: "advisory",
    scope: "lan",
    hop: 0,
    times: {
      issued_at: NOW - 5_000,
      expires_at: NOW + 300_000,
      heard_at: NOW - 4_000,
      local_expiry_at: NOW + 295_000,
      age_ms: 5_000,
    },
    admission: "verified",
    disposition: "surface",
    dedup: "first",
    versions: { manifest_sha256: "00", manifest_label: "test" },
    body: { ctype: 1, text: `item ${item}`, size: 6 },
    ...extra,
  });
const landing = (recSeq: number, extra: R = {}) =>
  R("landing_state", recSeq, { mute: null, breaker: "closed", ...extra });
const presence = (recSeq: number, name: string, state: string) =>
  R("presence", recSeq, {
    station: { name, principal: null },
    key_id: "f6eecf2f43082a97",
    state,
  });
const retract = (recSeq: number, item: number) =>
  R("retract", recSeq, {
    target: { key_id: "f6eecf2f43082a97", epoch: 7, stream_id: 1, seq: item },
    idem: idem(item),
    reason: "plucked",
    by: null,
  });
/** A record's fields without `v`, `type`, `rec_seq` and `run`: a snapshot entry. */
const entryOf = (r: R): R => {
  const { v: _v, type: _t, rec_seq: _s, run: _r, ...rest } = r;
  return rest;
};
const snapFrame = (w: number, k: number, item: number, extra: R = {}) =>
  R("snapshot", w, { snap_seq: k, entry: entryOf(frame(0, item, extra)) });
const snapPresence = (w: number, k: number, name: string, state: string) =>
  R("snapshot", w, { snap_seq: k, entry: entryOf(presence(0, name, state)) });
const snapEnd = (w: number, count: number, omitted?: number) =>
  R("snapshot_end", w, {
    watermark: w,
    count,
    truncated: omitted !== undefined,
    ...(omitted !== undefined ? { omitted } : {}),
  });

const feed = (c: RecordConsumer, ...recs: R[]) => {
  for (const r of recs) c.feed(r, NOW);
};
/** A connection: `hello` (1) and `landing_state` (`baseline`). */
function bootstrap(
  c: RecordConsumer,
  baseline: number,
  { ask = true, offer = true } = {},
): void {
  c.reconnected({ joinSnapshot: ask });
  feed(
    c,
    R("hello", 1, offer ? { join_snapshot: true } : {}),
    landing(baseline),
  );
}
const seqs = (c: RecordConsumer) =>
  c
    .hearView(TUNE, NOW, true)
    .items.map((i) => Number(i.seq))
    .sort((a, b) => a - b);
const stations = (c: RecordConsumer) => Object.fromEntries(c.presence);
const hear = (c: RecordConsumer) =>
  renderHear(c.hearView(TUNE, NOW, true), { limit: 10, maxChars: 8_000 });

test("join snapshot: the request line is the RFC's", () => {
  assert.deepEqual(JSON.parse(JOIN_SNAPSHOT_REQUEST), {
    op: "join_snapshot",
    v: "canticle-receptor-record/1",
  });
  assert.ok(JOIN_SNAPSHOT_REQUEST.endsWith("\n"));
  assert.equal(
    JOIN_SNAPSHOT_REQUEST.indexOf("\n"),
    JOIN_SNAPSHOT_REQUEST.length - 1,
  );
});

test("(5)(a) content: hello 1, landing 50, I1 + S presence, snapshot_end 99, live from 100; joined_late until snapshot_end and not after", () => {
  const c = new RecordConsumer();
  bootstrap(c, 50);
  assert.equal(c.health, "degraded");
  assert.deepEqual(c.healthReasons, ["joined_late"]);
  assert.equal(c.snapshotState, "pending");
  assert.match(hear(c), /joined_late/u);
  assert.match(hear(c), /hasn't completed yet/u);
  feed(c, snapPresence(99, 1, "S", "on_air"), snapFrame(99, 2, 60));
  // Held, not applied, until snapshot_end.
  assert.deepEqual(seqs(c), []);
  assert.deepEqual(stations(c), {});
  assert.equal(c.snapshotState, "open");
  assert.ok(c.joinedLate);
  feed(c, snapEnd(99, 2));
  assert.equal(c.connectionLost, false);
  assert.deepEqual(seqs(c), [60], "I1 renders before any later record");
  assert.deepEqual(stations(c), { S: "on_air" });
  assert.equal(c.health, "ok");
  assert.deepEqual(c.healthReasons, []);
  assert.equal(c.joinedLate, false);
  assert.equal(c.snapshotState, "complete");
  feed(c, R("health", 100, { last_datagram_at: NOW - 500, reasons: [] }));
  assert.doesNotMatch(hear(c), /joined_late/u);
  assert.match(hear(c), /item 60/u);
  assert.match(hear(c), /on air: S=on_air/u);
  // Live records from W + 1 under the ordinary rules: 100 was no gap.
  feed(c, frame(101, 101));
  assert.equal(c.counts.records_lost ?? 0, 0);
  assert.equal(c.counts.malformed_record ?? 0, 0);
  assert.deepEqual(seqs(c), [60, 101]);
});

test("(5)(b) the cut: an item and I1's retract after snapshot_end apply as live records above W", () => {
  const c = new RecordConsumer();
  bootstrap(c, 50);
  feed(c, snapFrame(99, 1, 60), snapEnd(99, 1));
  assert.deepEqual(seqs(c), [60], "I1 from the snapshot");
  assert.equal(c.joinedLate, false);
  feed(c, frame(100, 100), retract(101, 60));
  assert.deepEqual(seqs(c), [100], "the retract is honoured");
  assert.equal(c.counts.records_lost ?? 0, 0);
  // A skip right after W is a gap.
  const d = new RecordConsumer();
  bootstrap(d, 50);
  feed(d, snapFrame(99, 1, 60), snapEnd(99, 1), frame(101, 101));
  assert.equal(d.counts.records_lost, 1, "99 → 101 is a gap");
  assert.ok(d.healthReasons.includes("records_lost"));
});

test("(5)(c) budgets and keys: snapshot frames take the live deliverability check and count toward nothing", () => {
  const c = new RecordConsumer();
  bootstrap(c, 50);
  feed(
    c,
    snapFrame(99, 1, 60, { dedup: "resurfaced" }),
    // Expired in transit: skipped, not malformed.
    snapFrame(99, 2, 61, {
      times: {
        issued_at: NOW - 5_000,
        expires_at: NOW + 300_000,
        heard_at: NOW - 4_000,
        local_expiry_at: NOW - 1,
        age_ms: 5_000,
      },
    }),
    // Not deliverable: reaches nothing.
    snapFrame(99, 3, 62, { disposition: "ringbuffer_only" }),
    snapFrame(99, 4, 63),
    snapEnd(99, 4),
  );
  assert.equal(c.connectionLost, false);
  assert.deepEqual(seqs(c), [60, 63]);
  // Only diagnostics: this binding keeps no §14.6 rate, budget or salience
  // quantity, holds no frame keys, and `hear` is pull-only (wakes nothing).
  assert.deepEqual(
    { ...c.counts },
    {
      joined_late: 1, // the bootstrap's, as every health reason counts (frond-ear#59)
      snapshot_frames: 2,
      expired_on_arrival: 1,
      not_deliverable_verified: 1,
    },
  );
  // The same entries as live frames would count the same, bar snapshot_frames.
  const live = new RecordConsumer();
  bootstrap(live, 50, { ask: false });
  feed(live, frame(51, 60, { dedup: "resurfaced" }), frame(52, 63));
  assert.deepEqual(seqs(live), [60, 63]);
});

test("(5)(d) capacity on a rejoin: a truncated snapshot is merge only; an omitted held item is still held; only a retract removes it", () => {
  const c = new RecordConsumer();
  bootstrap(c, 50);
  feed(c, snapEnd(50, 0));
  feed(c, frame(51, 51), frame(52, 52), presence(53, "S", "on_air"));
  assert.deepEqual(seqs(c), [51, 52]);
  // Connection lost; same run, new connection; the cap leaves 52 out.
  c.closed(NOW);
  bootstrap(c, 150);
  assert.deepEqual(seqs(c), [], "carried items are hidden until the snapshot");
  feed(
    c,
    snapPresence(160, 1, "T", "on_air"),
    snapFrame(160, 2, 51),
    snapFrame(160, 3, 155),
    snapEnd(160, 3, 1),
  );
  assert.equal(c.connectionLost, false);
  assert.deepEqual(seqs(c), [51, 52, 155], "52 is still held");
  assert.deepEqual(stations(c), { S: "on_air", T: "on_air" }, "merged");
  assert.equal(c.snapshotState, "truncated");
  assert.equal(c.snapshotOmitted, 1);
  assert.ok(c.joinedLate, "a truncated snapshot is never complete");
  assert.equal(c.health, "degraded");
  assert.match(hear(c), /truncated \(1 omitted\)/u);
  assert.equal(c.counts.records_lost, 1, "the rejoin is a loss, reported once");
  feed(c, retract(161, 52));
  assert.deepEqual(seqs(c), [51, 155]);
  assert.equal(c.counts.records_lost, 1);
});

test("(5)(d′) missed retract on rejoin, complete snapshot: F's absence removes it from the local view only", () => {
  const c = new RecordConsumer();
  bootstrap(c, 50);
  feed(c, snapEnd(50, 0));
  feed(c, frame(51, 70), frame(52, 71), presence(53, "S", "on_air"));
  assert.deepEqual(seqs(c), [70, 71]);
  // F (70)'s retract is emitted while away; S went off air too (no presence entry).
  c.closed(NOW);
  bootstrap(c, 150);
  feed(c, snapFrame(160, 1, 71), snapEnd(160, 1));
  assert.deepEqual(seqs(c), [71], "F left the local view");
  assert.deepEqual(stations(c), {}, "the presence table is the snapshot's");
  assert.equal(c.counts.records_lost, 1, "records_lost reported once");
  assert.deepEqual(
    c.healthReasons,
    ["records_lost"],
    "joined_late cleared, records_lost kept",
  );
  assert.equal(c.health, "degraded");
  // The snapshot isn't a retract: nothing counted as one, and live goes on from W + 1.
  feed(c, frame(161, 161));
  assert.deepEqual(seqs(c), [71, 161]);
  assert.equal(c.counts.records_lost, 1);
});

test("(5)(e) an interrupted snapshot is never applied; the next connection asks again", () => {
  const c = new RecordConsumer();
  bootstrap(c, 50);
  feed(c, snapEnd(50, 0), frame(51, 51));
  c.closed(NOW);
  bootstrap(c, 150);
  feed(c, snapFrame(160, 1, 155), snapPresence(160, 2, "S", "on_air"));
  c.closed(NOW); // connection lost before snapshot_end
  assert.deepEqual(seqs(c), []);
  assert.deepEqual(stations(c), {});
  // Next connection: the held entries are gone; only this snapshot applies.
  bootstrap(c, 170);
  assert.equal(c.snapshotState, "pending");
  feed(c, snapFrame(180, 1, 51), snapEnd(180, 1));
  assert.deepEqual(seqs(c), [51]);
  assert.deepEqual(stations(c), {});
  assert.equal(c.joinedLate, false);
});

test("(5)(f) convergence: bindings that join at different points agree after snapshot_end", () => {
  // The run, contiguous for A: I60, S on air, I80, I80 plucked, I95.
  const history: R[] = [
    frame(51, 60),
    presence(52, "S", "on_air"),
    frame(53, 80),
    retract(54, 80),
    frame(55, 95),
  ];
  const a = new RecordConsumer();
  bootstrap(a, 50);
  feed(a, snapEnd(50, 0), ...history);
  const b = new RecordConsumer();
  bootstrap(b, 50);
  feed(
    b,
    snapPresence(55, 1, "S", "on_air"),
    snapFrame(55, 2, 95),
    snapFrame(55, 3, 60),
    snapEnd(55, 3),
  );
  assert.equal(a.counts.records_lost ?? 0, 0);
  assert.deepEqual(seqs(a), seqs(b));
  assert.deepEqual(stations(a), stations(b));
  assert.deepEqual(seqs(b), [60, 95], "no plucked item in a snapshot");
  for (const c of [a, b]) {
    feed(c, frame(56, 100));
    assert.equal(c.joinedLate, false);
  }
  assert.deepEqual(seqs(a), seqs(b));
});

test("(5)(g) no early-join shortcut: without a snapshot, joined_late for the life of the connection", () => {
  // Not asked; the first live record is baseline + 1.
  const c = new RecordConsumer();
  bootstrap(c, 50, { ask: false });
  feed(c, presence(51, "S", "on_air"));
  for (let n = 52; n < 400; n++)
    feed(c, R("health", n, { last_datagram_at: NOW - 500, reasons: [] }));
  assert.equal(c.snapshotState, "not_asked");
  assert.ok(c.joinedLate);
  assert.equal(c.health, "degraded");
  assert.equal(c.counts.records_lost ?? 0, 0);
  assert.match(hear(c), /joined_late.*asked for no join snapshot/u);
  // Asked, but the daemon doesn't offer: the same.
  const d = new RecordConsumer();
  bootstrap(d, 50, { offer: false });
  feed(d, frame(51, 51));
  assert.equal(d.snapshotState, "unsupported");
  assert.ok(d.joinedLate);
  assert.match(hear(d), /doesn't serve a join snapshot/u);
  // The same join with a snapshot shows the earlier item and presence.
  const e = new RecordConsumer();
  bootstrap(e, 50);
  feed(
    e,
    snapPresence(50, 1, "S", "on_air"),
    snapFrame(50, 2, 40),
    snapEnd(50, 2),
  );
  assert.deepEqual(seqs(e), [40]);
  assert.deepEqual(stations(e), { S: "on_air" });
  assert.equal(e.joinedLate, false);
  // A new run clears it (a live hello of another run).
  feed(
    c,
    R("hello", 1, {}, "b0b0"),
    R("landing_state", 2, { mute: null, breaker: "closed" }, "b0b0"),
  );
  assert.equal(c.joinedLate, false);
});

test("(5)(h) live records queued before the cut: W ≥ the last live rec_seq is accepted; boundaries", () => {
  const c = new RecordConsumer();
  bootstrap(c, 50);
  feed(c, frame(51, 51), frame(52, 52));
  feed(
    c,
    snapFrame(52, 1, 51),
    snapFrame(52, 2, 52),
    snapFrame(52, 3, 10),
    snapEnd(52, 3),
  );
  assert.equal(c.connectionLost, false);
  assert.deepEqual(seqs(c), [10, 51, 52]);
  feed(c, frame(53, 53));
  assert.equal(c.counts.records_lost ?? 0, 0);
  // W behind the last live record read: malformed.
  const d = new RecordConsumer();
  bootstrap(d, 50);
  feed(d, frame(51, 51), frame(52, 52), snapFrame(51, 1, 51));
  assert.equal(d.connectionLost, true);
  assert.equal(d.counts.snapshot_watermark_behind, 1);
  // count 0, truncated: only snapshot_end; still joined_late, nothing removed.
  const e = new RecordConsumer();
  bootstrap(e, 50);
  feed(e, frame(51, 51), snapEnd(51, 0, 600));
  assert.equal(e.connectionLost, false);
  assert.deepEqual(seqs(e), [51]);
  assert.ok(e.joinedLate);
  // Exactly the cap: 511 entries are accepted.
  const f = new RecordConsumer();
  bootstrap(f, 50);
  for (let k = 1; k <= MAX_SNAPSHOT_ENTRIES; k++)
    feed(f, snapFrame(99, k, 1_000 + k));
  feed(f, snapEnd(99, MAX_SNAPSHOT_ENTRIES, 4));
  assert.equal(f.connectionLost, false);
  assert.equal(seqs(f).length, MAX_SNAPSHOT_ENTRIES);
});

test("join snapshot: malformed snapshots are malformed_record, lose the connection, and apply nothing", () => {
  const cases: [string, string, (c: RecordConsumer) => void][] = [
    [
      "not asked",
      "snapshot_unsolicited",
      (c) => {
        bootstrap(c, 50, { ask: false });
        feed(c, snapFrame(99, 1, 60), snapEnd(99, 1));
      },
    ],
    [
      "snapshot_end not asked",
      "snapshot_unsolicited",
      (c) => {
        bootstrap(c, 50, { ask: false });
        feed(c, snapEnd(99, 0));
      },
    ],
    [
      "snap_seq starts at 2",
      "snapshot_seq",
      (c) => {
        bootstrap(c, 50);
        feed(c, snapFrame(99, 2, 60), snapEnd(99, 1));
      },
    ],
    [
      "snap_seq skips",
      "snapshot_seq",
      (c) => {
        bootstrap(c, 50);
        feed(c, snapFrame(99, 1, 60), snapFrame(99, 3, 61), snapEnd(99, 2));
      },
    ],
    [
      "snap_seq repeats",
      "snapshot_seq",
      (c) => {
        bootstrap(c, 50);
        feed(c, snapFrame(99, 1, 60), snapFrame(99, 1, 61), snapEnd(99, 2));
      },
    ],
    [
      "rec_seq changes",
      "snapshot_watermark_changed",
      (c) => {
        bootstrap(c, 50);
        feed(c, snapFrame(99, 1, 60), snapFrame(100, 2, 61), snapEnd(99, 2));
      },
    ],
    [
      "W below the baseline",
      "snapshot_watermark_behind",
      (c) => {
        bootstrap(c, 50);
        feed(c, snapFrame(49, 1, 60), snapEnd(49, 1));
      },
    ],
    [
      "snapshot_end below the baseline",
      "snapshot_watermark_behind",
      (c) => {
        bootstrap(c, 50);
        feed(c, snapEnd(49, 0));
      },
    ],
    [
      "snapshot_end's rec_seq differs from W",
      "snapshot_watermark_changed",
      (c) => {
        bootstrap(c, 50);
        feed(c, snapFrame(99, 1, 60), snapEnd(100, 1));
      },
    ],
    [
      "watermark differs from rec_seq",
      "snapshot_end_mismatch",
      (c) => {
        bootstrap(c, 50);
        feed(c, snapFrame(99, 1, 60), { ...snapEnd(99, 1), watermark: 98 });
      },
    ],
    [
      "count too high",
      "snapshot_end_mismatch",
      (c) => {
        bootstrap(c, 50);
        feed(c, snapFrame(99, 1, 60), snapEnd(99, 2));
      },
    ],
    [
      "count too low",
      "snapshot_end_mismatch",
      (c) => {
        bootstrap(c, 50);
        feed(c, snapFrame(99, 1, 60), snapFrame(99, 2, 61), snapEnd(99, 1));
      },
    ],
    [
      "truncated missing",
      "snapshot_end_mismatch",
      (c) => {
        bootstrap(c, 50);
        const end = snapEnd(99, 1);
        delete end.truncated;
        feed(c, snapFrame(99, 1, 60), end);
      },
    ],
    [
      "truncated without omitted",
      "snapshot_end_mismatch",
      (c) => {
        bootstrap(c, 50);
        feed(c, snapFrame(99, 1, 60), { ...snapEnd(99, 1), truncated: true });
      },
    ],
    [
      "a second snapshot_end",
      "snapshot_after_end",
      (c) => {
        bootstrap(c, 50);
        feed(c, snapEnd(99, 0), snapEnd(99, 0));
      },
    ],
    [
      "a snapshot after snapshot_end",
      "snapshot_after_end",
      (c) => {
        bootstrap(c, 50);
        feed(c, snapEnd(99, 0), snapFrame(99, 1, 60));
      },
    ],
    [
      "another run",
      "snapshot_run_mismatch",
      (c) => {
        bootstrap(c, 50);
        feed(c, { ...snapFrame(99, 1, 60), run: "f00d" }, snapEnd(99, 1));
      },
    ],
    [
      "entry not an object",
      "snapshot_entry",
      (c) => {
        bootstrap(c, 50);
        feed(c, { ...snapFrame(99, 1, 60), entry: "frame" }, snapEnd(99, 1));
      },
    ],
    [
      "frame entry missing fields",
      "snapshot_entry",
      (c) => {
        bootstrap(c, 50);
        const s = snapFrame(99, 1, 60);
        delete (s.entry as R).station;
        feed(c, s, snapEnd(99, 1));
      },
    ],
    [
      "presence entry without a state",
      "snapshot_entry",
      (c) => {
        bootstrap(c, 50);
        feed(
          c,
          R("snapshot", 99, {
            snap_seq: 1,
            entry: { presence: { station: "S" } },
          }),
          snapEnd(99, 1),
        );
      },
    ],
    [
      "a live record between entries",
      "snapshot_interrupted",
      (c) => {
        bootstrap(c, 50);
        feed(c, snapFrame(99, 1, 60), frame(100, 100), snapEnd(99, 1));
      },
    ],
    [
      "over the cap",
      "snapshot_over_cap",
      (c) => {
        bootstrap(c, 50);
        for (let k = 1; k <= MAX_SNAPSHOT_ENTRIES + 1; k++)
          feed(c, snapFrame(99, k, k));
        feed(c, snapEnd(99, MAX_SNAPSHOT_ENTRIES + 1));
      },
    ],
  ];
  for (const [name, reason, run] of cases) {
    const c = new RecordConsumer();
    run(c);
    assert.equal(c.connectionLost, true, name);
    assert.ok((c.counts.malformed_record ?? 0) >= 1, name);
    assert.equal(c.counts[reason], 1, `${name}: ${reason}`);
    assert.equal(c.health, "failed", name);
    assert.deepEqual(seqs(c), [], `${name}: nothing applied`);
    assert.deepEqual(stations(c), {}, name);
    // The next connection recovers, and asks again.
    bootstrap(c, 200);
    feed(c, snapFrame(210, 1, 7), snapEnd(210, 1));
    assert.equal(c.connectionLost, false, name);
    assert.deepEqual(seqs(c), [7], name);
    assert.equal(c.joinedLate, false, name);
  }
  // A line lost mid-snapshot is an entry lost.
  const d = new RecordConsumer();
  bootstrap(d, 50);
  feed(d, snapFrame(99, 1, 60));
  d.feedLine("{not json", NOW);
  assert.equal(d.connectionLost, true);
  // Without a per-connection bootstrap (one reader per run) nobody asked: counted only.
  const e = new RecordConsumer();
  feed(e, R("hello", 1), landing(2), snapFrame(2, 1, 60));
  assert.equal(e.connectionLost, false);
  assert.equal(e.counts.snapshot_unsolicited, 1);
  assert.deepEqual(seqs(e), []);
});

test("join snapshot: entries wrapped one level ({frame} / {presence}) read the same", () => {
  const c = new RecordConsumer();
  bootstrap(c, 50);
  feed(
    c,
    R("snapshot", 99, {
      snap_seq: 1,
      entry: { presence: entryOf(presence(0, "S", "on_air")) },
    }),
    R("snapshot", 99, { snap_seq: 2, entry: { frame: entryOf(frame(0, 60)) } }),
    snapEnd(99, 2),
  );
  assert.equal(c.connectionLost, false);
  assert.deepEqual(seqs(c), [60]);
  assert.deepEqual(stations(c), { S: "on_air" });
});

test("record client: real socket — asks first, an interrupted snapshot applies nothing, a complete one clears joined_late", async () => {
  const dir = mkdtempSync(join(tmpdir(), "canticle-snap-"));
  const path = join(dir, "daemon.sock");
  const peers: { socket: Socket; lines: string[] }[] = [];
  const server = createServer((socket) => {
    const peer = { socket, lines: [] as string[] };
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        peer.lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    peers.push(peer);
  });
  await new Promise<void>((r) => server.listen(path, r));
  const client = new RecordClient({
    socketPath: path,
    tune: { gloss: TUNE },
    logger,
    clock: { now: () => NOW },
    timers: {
      setTimeout: (fn: () => void) => setTimeout(fn, 1),
      clearTimeout: (t: unknown) => clearTimeout(t as NodeJS.Timeout),
    } as never,
  });
  const peerAt = async (n: number) => {
    const deadline = Date.now() + 2_000;
    while (peers.length < n || peers[n - 1]!.lines.length === 0) {
      assert.ok(Date.now() < deadline, `connection ${n} never asked`);
      await new Promise((r) => setTimeout(r, 5));
    }
    return peers[n - 1]!;
  };
  // Like the daemon: the request is read before anything is written.
  const send = async (peer: Socket, ...recs: R[]) => {
    peer.write(recs.map((r) => `${JSON.stringify(r)}\n`).join(""));
    await new Promise((r) => setTimeout(r, 30));
  };
  const view = () => client.hearView("gloss");
  const status = () =>
    client.status() as {
      receiveHealth: string;
      reasons: string[];
      joinSnapshot: string;
    };
  try {
    client.start();
    const p1 = await peerAt(1);
    assert.deepEqual(
      p1.lines,
      [JOIN_SNAPSHOT_REQUEST.trimEnd()],
      "the first line",
    );
    await send(
      p1.socket,
      R("hello", 1, { join_snapshot: true }),
      landing(50),
      R("health", 51, { last_datagram_at: NOW - 500, reasons: [] }),
    );
    // health 51 was a live record, so W ≥ 51.
    await send(
      p1.socket,
      snapFrame(60, 1, 55),
      snapPresence(60, 2, "S", "on_air"),
    );
    assert.deepEqual(status().reasons, ["joined_late"]);
    assert.equal(status().joinSnapshot, "open");
    assert.equal(view().items.length, 0, "held, not applied");
    p1.socket.destroy(); // lost before snapshot_end
    const p2 = await peerAt(2);
    assert.deepEqual(p2.lines, [JOIN_SNAPSHOT_REQUEST.trimEnd()], "asks again");
    assert.equal(
      view().items.length,
      0,
      "the interrupted snapshot applied nothing",
    );
    assert.deepEqual(view().stations, []);
    await send(
      p2.socket,
      R("hello", 1, { join_snapshot: true }),
      landing(70),
      snapFrame(70, 1, 55),
      snapPresence(70, 2, "S", "on_air"),
    );
    assert.match(
      renderHear(view(), { limit: 10, maxChars: 8_000 }),
      /joined_late/u,
    );
    await send(
      p2.socket,
      snapEnd(70, 2),
      R("health", 71, { last_datagram_at: NOW - 500, reasons: [] }),
      frame(72, 72),
    );
    assert.deepEqual(
      view()
        .items.map((i) => i.seq)
        .sort(),
      ["55", "72"],
    );
    assert.deepEqual(view().stations, [{ name: "S", presence: "on_air" }]);
    assert.equal(status().joinSnapshot, "complete");
    // The rejoin of p1's run still reports its loss, once; joined_late is gone.
    assert.deepEqual(status().reasons, ["records_lost"]);
    assert.doesNotMatch(
      renderHear(view(), { limit: 10, maxChars: 8_000 }),
      /joined_late/u,
    );
    // A malformed snapshot drops the connection; the client reconnects and asks again.
    await send(p2.socket, snapFrame(72, 1, 99));
    const p3 = await peerAt(3);
    assert.equal(client.consumer.counts.snapshot_after_end, 1);
    assert.deepEqual(p3.lines, [JOIN_SNAPSHOT_REQUEST.trimEnd()]);
    // A daemon that doesn't offer snapshots: blind, but saying so.
    await send(p3.socket, R("hello", 1), landing(80), frame(81, 81));
    assert.equal(status().joinSnapshot, "unsupported");
    assert.ok(status().reasons.includes("joined_late"));
    assert.equal(status().receiveHealth, "degraded");
  } finally {
    client.stop();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("join snapshot: held entries are bounded by bytes as well as count", () => {
  const c = new RecordConsumer();
  bootstrap(c, 50);
  const big = "x".repeat(60 * 1024);
  let k = 0;
  while (!c.connectionLost && k < 40)
    feed(
      c,
      snapFrame(99, ++k, k, {
        body: { ctype: 1, text: big, size: big.length },
      }),
    );
  assert.equal(c.connectionLost, true);
  assert.equal(c.counts.snapshot_over_cap, 1);
  // MAX_SNAPSHOT_BYTES / ~61 KiB per entry: the 17th entry crosses it.
  assert.equal(MAX_SNAPSHOT_BYTES, 1024 * 1024);
  assert.equal(k, 17);
  assert.deepEqual(seqs(c), []);
});

test("join snapshot: binary-canticle#85's daemon output reads with nothing malformed (interop fixture)", () => {
  const lines = readFileSync(
    new URL("./fixtures/canticle/join-snapshot-sample.jsonl", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((l) => l !== "");
  assert.equal(lines.length, 7);
  const recs = lines.map((l) => JSON.parse(l) as R);
  // The entry form the daemon settled on: wrapped one level.
  assert.deepEqual(
    recs
      .filter((r) => r.type === "snapshot")
      .map((r) => Object.keys(r.entry as R)),
    [["presence"], ["frame"], ["frame"]],
  );
  // Between the capture's received_at and every item's local expiry.
  const now = 1_790_966_923_260;
  const tune = ["*:alarms", "*:chatter"];
  const texts = (c: RecordConsumer) =>
    c
      .hearView(tune, now, true)
      .items.map((i) => `${i.stream}#${i.seq}`)
      .sort();
  const c = new RecordConsumer();
  c.reconnected({ joinSnapshot: true }); // a host-socket connection that asked
  for (const l of lines.slice(0, 2)) c.feedLine(l, now);
  assert.equal(c.snapshotState, "pending");
  assert.ok(c.joinedLate);
  for (const l of lines.slice(2, 5)) c.feedLine(l, now);
  assert.equal(c.snapshotState, "open");
  assert.deepEqual(texts(c), [], "held until snapshot_end");
  c.feedLine(lines[5]!, now); // snapshot_end W=7 count=3, untruncated
  assert.equal(c.connectionLost, false);
  assert.equal(c.snapshotState, "complete");
  assert.equal(c.joinedLate, false);
  assert.deepEqual(stations(c), { cael: "ROOT_UNKNOWN" });
  assert.deepEqual(
    texts(c),
    ["alarms#1", "chatter#1"],
    "both surfaced frames before the live record",
  );
  c.feedLine(lines[6]!, now); // live frame at W + 1
  assert.deepEqual(texts(c), ["alarms#1", "chatter#1", "chatter#4"]);
  const view = c.hearView(tune, now, true);
  assert.deepEqual(view.items.map((i) => i.text).sort(), [
    "live after the snapshot",
    "smoke in the east wing",
    "the kettle is on",
  ]);
  assert.equal(c.counts.malformed_record ?? 0, 0);
  assert.equal(c.counts.records_lost ?? 0, 0);
  assert.equal(c.counts.snapshot_frames, 2);
  assert.ok(!c.healthReasons.includes("joined_late"));
  assert.ok(!c.healthReasons.includes("records_lost"));
});

test("join snapshot: joinSnapshotFrames is this connection's; counts.snapshot_frames adds them up over the process (frond-ear#59)", () => {
  // fe#24's D36 proof: a join whose snapshot carries 3 items, then a graceful host
  // daemon restart whose new run has nothing live yet.
  const c = new RecordConsumer();
  bootstrap(c, 50);
  assert.equal(c.snapshotFrames, undefined, "nothing applied yet");
  feed(
    c,
    snapPresence(99, 1, "S", "on_air"),
    snapFrame(99, 2, 60),
    snapFrame(99, 3, 61),
    snapFrame(99, 4, 62),
    snapEnd(99, 4),
  );
  assert.equal(c.snapshotFrames, 3);
  assert.equal(c.counts.snapshot_frames, 3);
  feed(c, R("bye", 100));
  c.closed(NOW);
  const run = "f7f8";
  const onRun = (r: R): R => ({ ...r, run });
  c.reconnected({ joinSnapshot: true });
  assert.equal(c.snapshotFrames, undefined, "a new connection has none yet");
  feed(
    c,
    R("hello", 1, { join_snapshot: true }, run),
    onRun(landing(2)),
    onRun(snapEnd(2, 0)),
  );
  assert.equal(c.snapshotState, "complete");
  assert.equal(c.snapshotFrames, 0, "the new run's snapshot was empty");
  assert.equal(c.counts.snapshot_frames, 3, "the process's, across runs");
  // A truncated snapshot counts what it applied.
  c.closed(NOW);
  c.reconnected({ joinSnapshot: true });
  feed(
    c,
    R("hello", 1, { join_snapshot: true }, run),
    onRun(landing(5)),
    onRun(snapFrame(9, 1, 70)),
    onRun(snapEnd(9, 1, 6)),
  );
  assert.equal(c.snapshotState, "truncated");
  assert.equal(c.snapshotFrames, 1);
  assert.equal(c.snapshotOmitted, 6);
  assert.equal(c.counts.snapshot_frames, 4);
  // One cut off before snapshot_end applied nothing, so it counts nothing.
  c.closed(NOW);
  c.reconnected({ joinSnapshot: true });
  feed(
    c,
    R("hello", 1, { join_snapshot: true }, run),
    onRun(landing(12)),
    onRun(snapFrame(15, 1, 71)),
  );
  c.closed(NOW);
  assert.equal(c.snapshotFrames, undefined);
  assert.equal(c.counts.snapshot_frames, 4);
});
