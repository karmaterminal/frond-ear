// The trainboard's first slice (binary-canticle RFC-0002 §3.3, "Searching the guide"):
// `canticle_guide` lists what is on air now, one row per station:stream, from what the
// listener already holds. It searches metadata only, never a payload; a look is not an
// arrival, so it wakes nothing, tunes or mutes nothing, and marks nothing heard (§3.1);
// a withdrawn or expired item never counts as live, and a PLUCK the listener knows of
// shows as withdrawn (§2.2). Records go in through the real record v1 consumer.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { guideView } from "../src/canticle/guide.ts";
import type { HearView, LiveItem } from "../src/canticle/receptor.ts";
import { ALPHA, confirm, OPS, pushes, setup, STRAY } from "./canticle-host.ts";
import { harness, type Harness } from "./helpers.ts";

interface Row {
  station: string;
  stream: string;
  classes: string[];
  live: number;
  newestHeardAt: string | null;
  newestAgeS: number | null;
  freshness: string;
  liveUntil: string | null;
  keys: string[];
  verification: string;
  presence: string;
  delivery: string;
  muted: boolean;
  withdrawn?: { count: number; lastAt: string; reasons: string[] };
  expired?: number;
  localOmissions?: { reason: string; count: number };
  coverageUnknown?: { tunedAt: string; dropped: number; until: string };
}

interface Guide {
  ear: string;
  at: string;
  look: string;
  listener: string;
  delivery: string;
  query?: string;
  streams: number;
  rows: Row[];
  nextCursor?: string;
  gaps?: string[];
}

type Client = ReturnType<Harness["attach"]>;

async function guide(
  h: Harness,
  client: Client,
  args: Record<string, unknown> = {},
): Promise<{ raw: string; view: Guide }> {
  const result = await h.call(client, "canticle_guide", args);
  assert.equal(result.ok, true, result.text);
  return { raw: result.text, view: JSON.parse(result.text) as Guide };
}

const row = (view: Guide, station: string, stream: string) => {
  const found = view.rows.find(
    (r) => r.station === station && r.stream === stream,
  );
  assert.ok(found, `the guide has a row for ${station}:${stream}`);
  return found;
};

/** Every row of every table in the daemon's store, read beside it: what a call wrote. */
function dump(h: Harness): string {
  const db = new DatabaseSync(join(h.directory, "ear.db"), { readOnly: true });
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((r) => String(r.name));
    return JSON.stringify(
      tables.map((name) => [
        name,
        db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
      ]),
    );
  } finally {
    db.close();
  }
}

const PAYLOAD = "needle-in-the-payload";

test("guide: one row per station:stream, with classes, live count, freshness, key, verification, horizon, mute and delivery", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    const shim = h.attach("scribe");
    host.presence("alpha", "ROOT_UNKNOWN");
    host.sing(1, { text: PAYLOAD, ttlMs: 300_000 });
    h.clock.advance(2_000);
    host.sing(2, { class: "live-state", ttlMs: 600_000 });
    host.sing(3, { station: "alpha", stream: "ops.deploy", class: "alarm" });
    await h.call(shim, "set_canticle_delivery", {
      mode: "mute",
      station: "alpha",
    });
    const { raw, view } = await guide(h, shim);
    assert.equal(view.ear, "scribe");
    assert.equal(view.listener, "listening");
    assert.equal(view.delivery, "immediate");
    assert.equal(view.streams, 2);
    assert.match(view.look, /metadata only/u);
    assert.match(view.look, /not an arrival/u);
    assert.deepEqual(
      view.rows.map((r) => `${r.station}:${r.stream}`),
      ["alpha:ops.deploy", "ops:ops.fleet"],
      "sorted by station, then stream",
    );
    const ops = row(view, "ops", "ops.fleet");
    assert.deepEqual(ops.classes, ["advisory", "live-state"]);
    assert.equal(ops.live, 2);
    assert.deepEqual(ops.keys, [OPS]);
    assert.equal(ops.verification, "verified");
    assert.equal(ops.presence, "EQUIPPED_SPEAKING");
    assert.equal(ops.delivery, "immediate");
    assert.equal(ops.muted, false);
    assert.equal(ops.freshness, "fresh");
    assert.equal(ops.newestAgeS, 1);
    // The newest heard (2, sung 2 s later) and the last to leave (2's 600 s life).
    assert.equal(
      ops.newestHeardAt,
      new Date(1_001_500).toISOString().replace(/\.\d{3}Z$/u, "Z"),
    );
    assert.equal(
      ops.liveUntil,
      new Date(1_602_000).toISOString().replace(/\.\d{3}Z$/u, "Z"),
    );
    const alpha = row(view, "alpha", "ops.deploy");
    assert.deepEqual(alpha.classes, ["alarm"]);
    assert.equal(alpha.live, 1);
    assert.deepEqual(alpha.keys, [ALPHA]);
    assert.equal(alpha.verification, "ROOT_UNKNOWN");
    assert.equal(alpha.muted, true);
    assert.equal(alpha.delivery, "mute");
    assert.doesNotMatch(raw, new RegExp(PAYLOAD, "u"), "no payload text");
    assert.doesNotMatch(raw, /deploy\.started/u, "no payload text at all");
  } finally {
    h.dispose();
  }
});

test("guide: an item older than its class's stale limit reads aged; a blind listener says so", async () => {
  const { h, host } = setup(undefined);
  try {
    const shim = h.attach("scribe");
    host.sing(1, { class: "live-state", age: 90_000 });
    const aged = row((await guide(h, shim)).view, "ops", "ops.fleet");
    assert.equal(aged.freshness, "aged");
    assert.equal(aged.delivery, "off", "no canticle.delivery entry: off");
    host.health(["no_datagrams"]);
    const blind = (await guide(h, shim)).view;
    assert.equal(blind.listener, "blind");
    assert.equal(row(blind, "ops", "ops.fleet").presence, "unknown");
    assert.ok(
      blind.gaps?.some((gap) => /unknown, not offline/u.test(gap)),
      JSON.stringify(blind.gaps),
    );
  } finally {
    h.dispose();
  }
});

test("guide: query is a case-insensitive filter over station, stream and class, and never matches payload text", async () => {
  const { h, host } = setup(undefined);
  try {
    const shim = h.attach("scribe");
    host.sing(1, {
      text: `${PAYLOAD} alpha ops.deploy alarm`,
      extra: { purpose: "needle purpose" },
    });
    host.sing(2, { station: "alpha", stream: "ops.deploy", class: "alarm" });
    const names = async (query: string) =>
      (await guide(h, shim, { query })).view.rows.map(
        (r) => `${r.station}:${r.stream}`,
      );
    assert.deepEqual(await names("ALPHA"), ["alpha:ops.deploy"]);
    assert.deepEqual(await names("Deploy"), ["alpha:ops.deploy"]);
    assert.deepEqual(await names("advisory"), ["ops:ops.fleet"]);
    assert.deepEqual(await names("ops"), ["alpha:ops.deploy", "ops:ops.fleet"]);
    assert.deepEqual(await names("needle"), [], "payload and purpose: never");
    assert.deepEqual(await names("started"), [], "payload: never");
    const filtered = (await guide(h, shim, { query: "alarm" })).view;
    assert.equal(filtered.query, "alarm");
    assert.equal(filtered.streams, 1);
    const long = await h.call(shim, "canticle_guide", {
      query: "x".repeat(201),
    });
    assert.equal(long.ok, false);
    assert.match(long.text, /query/u);
  } finally {
    h.dispose();
  }
});

test("guide: never reads a payload, its purpose, state key, body ref or provenance", () => {
  const touched: string[] = [];
  const trap = (over: Partial<LiveItem>): LiveItem => {
    const base: Record<string, unknown> = {
      station: "silas",
      key: "21fe31dfa154a261",
      stream: "ops.fleet",
      seq: "7",
      epoch: 1,
      class: "advisory",
      scope: "lan",
      hop: 0,
      issuedAt: 1_000_000,
      heardAt: 1_000_500,
      expiresAt: 1_900_000,
      bodyBytes: undefined,
      ctype: 1,
      ageMs: 1_000,
      expiresInMs: 800_000,
      copies: 1,
      ...over,
    };
    for (const field of [
      "text",
      "purpose",
      "stateKey",
      "bodyRef",
      "bodyDigest",
      "provenance",
    ]) {
      Object.defineProperty(base, field, {
        enumerable: true,
        get() {
          touched.push(field);
          return field === "provenance" ? () => ({}) : PAYLOAD;
        },
      });
    }
    return base as unknown as LiveItem;
  };
  const view: HearView = {
    now: 1_001_000,
    tuned: true,
    listening: true,
    blind: false,
    lastDatagramAt: 1_000_900,
    stations: [{ name: "silas", presence: "EQUIPPED_SPEAKING" }],
    items: [trap({}), trap({ seq: "8", stream: "ops.deploy" })],
  };
  const out = guideView(view, {
    ear: "scribe",
    query: "needle",
    limit: 20,
    mode: () => "off",
  });
  const all = guideView(view, { ear: "scribe", limit: 20, mode: () => "off" });
  assert.deepEqual(touched, [], "the guide reads metadata fields only");
  assert.equal(out.streams, 0);
  assert.equal(all.streams, 2);
  assert.doesNotMatch(JSON.stringify(all), new RegExp(PAYLOAD, "u"));
});

test("guide: a look, not an arrival: no wake, no custody echo, no exposure, no seen mark, no tune or mute, no network", async () => {
  const { h, host } = setup({ mode: "immediate" });
  const realFetch = globalThis.fetch;
  try {
    const shim = h.attach("scribe", {
      sessionId: "11111111-aaaa-4aaa-8aaa-000000000001",
    });
    host.sing(1);
    h.timers.advance(6_000);
    await confirm(shim); // a push, offered: custody holds a claimed and offered row
    host.sing(2, { station: "stray", key: STRAY }); // hear-only: never pushed
    h.timers.advance(6_000);
    const before = {
      db: dump(h),
      received: shim.connection.received.length,
      pushes: pushes(shim).length,
      rest: h.rest.calls.length,
      tune: host.tune.join(","),
      logs: h.logs.filter((line) => /canticle\.(heard|echoed)/u.test(line))
        .length,
    };
    let fetched = 0;
    globalThis.fetch = (() => {
      fetched += 1;
      throw new Error("the guide reaches no network");
    }) as typeof fetch;
    // A tool call naming a push's batch id is the session's word it heard it (§0.5): the
    // guide takes no batch id, so passing one echoes nothing.
    const batchId = pushes(shim)[0]!.meta.batch_id;
    assert.match(
      String(batchId),
      /^\d+-[0-9a-f]+$/u,
      "the whole id, token and all",
    );
    for (const args of [
      {},
      { query: "ops" },
      { limit: 1 },
      { ear: "scribe" },
      { batch_id: batchId },
    ]) {
      await guide(h, shim, args);
    }
    globalThis.fetch = realFetch;
    assert.equal(fetched, 0, "no fetch");
    assert.equal(
      shim.connection.received.length,
      before.received + 5,
      "five results, and nothing else sent to the session: no event, no wake",
    );
    assert.equal(h.rest.calls.length, before.rest, "no Discord call");
    assert.equal(dump(h), before.db, "the store is byte for byte unchanged");
    assert.equal(host.tune.join(","), before.tune, "nothing tuned");
    assert.equal(
      h.logs.filter((line) => /canticle\.(heard|echoed)/u.test(line)).length,
      before.logs,
    );
    h.timers.advance(30_000);
    assert.equal(pushes(shim).length, before.pushes, "nothing pushed after it");
    // The controls: the same batch id, passed to ack, does echo the push (§0.5); and hear,
    // which shows payload text, writes custody (#161). The same read beside the store sees
    // both, so the guide's unchanged store is no blind spot.
    const acked = await h.call(shim, "ack", { batch_id: batchId });
    assert.match(acked.text, /^1 canticle record echoed as heard$/u);
    assert.notEqual(dump(h), before.db, "ack's echo is visible to dump()");
    const heard = dump(h);
    await h.call(shim, "hear", {});
    assert.notEqual(
      dump(h),
      heard,
      "hear's custody write is visible to dump()",
    );
  } finally {
    globalThis.fetch = realFetch;
    h.dispose();
  }
});

test("guide: a PLUCKed item shows as withdrawn, never live; an expired one leaves; marks last until the item would have expired", async () => {
  const { h, host } = setup(undefined);
  try {
    const shim = h.attach("scribe");
    host.sing(1, { ttlMs: 60_000 });
    host.sing(2, { ttlMs: 120_000 });
    host.sing(3, { stream: "ops.deploy", ttlMs: 10_000 });
    host.pluck(1);
    let view = (await guide(h, shim)).view;
    let fleet = row(view, "ops", "ops.fleet");
    assert.equal(fleet.live, 1, "1 was plucked: never live");
    assert.equal(fleet.withdrawn?.count, 1);
    assert.deepEqual(fleet.withdrawn?.reasons, ["plucked"]);
    host.pluck(2);
    view = (await guide(h, shim)).view;
    fleet = row(view, "ops", "ops.fleet");
    assert.equal(
      fleet.live,
      0,
      "a row with only withdrawn items stays, marked",
    );
    assert.equal(fleet.withdrawn?.count, 2);
    assert.equal(fleet.freshness, "none live");
    assert.equal(fleet.newestHeardAt, null);
    assert.equal(fleet.liveUntil, null);
    assert.equal(row(view, "ops", "ops.deploy").live, 1);
    h.clock.advance(11_000); // 3's 10 s life is over
    view = (await guide(h, shim)).view;
    assert.equal(
      view.rows.some((r) => r.stream === "ops.deploy"),
      false,
      "an expired item leaves the guide",
    );
    assert.equal(row(view, "ops", "ops.fleet").withdrawn?.count, 2);
    h.clock.advance(50_000); // 1 would have left at 60 s
    assert.equal(
      row((await guide(h, shim)).view, "ops", "ops.fleet").withdrawn?.count,
      1,
    );
    h.clock.advance(60_000); // and 2 at 120 s
    assert.equal((await guide(h, shim)).view.streams, 0);
    // A supersession is a newer value, not a withdrawal.
    host.sing(4, { stateKey: "silas" });
    host.supersede(4, 5, { stateKey: "silas" });
    const superseded = row((await guide(h, shim)).view, "ops", "ops.fleet");
    assert.equal(superseded.live, 1);
    assert.equal(superseded.withdrawn, undefined);
  } finally {
    h.dispose();
  }
});

test("guide: what the listener holds past its life, or against a withdrawal it knows of, never counts as live", () => {
  const item = (over: Partial<LiveItem>): LiveItem =>
    ({
      station: "silas",
      key: "21fe31dfa154a261",
      stream: "ops.fleet",
      seq: "7",
      epoch: 1,
      class: "advisory",
      scope: "lan",
      hop: 0,
      issuedAt: 1_000_000,
      heardAt: 1_000_500,
      expiresAt: 1_900_000,
      ageMs: 1_000,
      expiresInMs: 800_000,
      copies: 1,
      ...over,
    }) as LiveItem;
  const view: HearView = {
    now: 1_001_000,
    tuned: true,
    listening: true,
    blind: false,
    lastDatagramAt: 1_000_900,
    stations: [],
    items: [
      item({ seq: "1" }),
      item({ seq: "2", expiresInMs: 0 }),
      item({ seq: "3" }),
    ],
    withdrawn: [
      {
        station: "silas",
        stream: "ops.fleet",
        key: "21fe31dfa154a261",
        class: "advisory",
        identity: "21fe31dfa154a261:1:ops.fleet:3",
        reason: "plucked",
        at: 1_000_800,
        until: 1_800_000,
      },
    ],
  };
  const out = guideView(view, { ear: "scribe", limit: 20, mode: () => "off" });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0]!.live, 1, "only seq 1 is live");
  assert.equal(out.rows[0]!.expired, 1);
  assert.equal(out.rows[0]!.withdrawn?.count, 1);
});

test("guide: paginated with limit and an opaque cursor; every row once; a bad cursor is refused", async () => {
  const { h, host } = setup(undefined);
  try {
    const shim = h.attach("scribe");
    let seq = 0;
    for (const station of ["ops", "alpha", "stray"]) {
      for (const stream of ["ops.fleet", "ops.deploy"]) {
        seq += 1;
        // alpha's records leave first: they show the cursor is a key, not an offset.
        host.sing(seq, {
          station,
          stream,
          ttlMs: station === "alpha" ? 5_000 : 300_000,
        });
      }
    }
    const all = (await guide(h, shim)).view;
    assert.equal(all.streams, 6);
    assert.equal(all.nextCursor, undefined);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = (
        await guide(h, shim, { limit: 4, ...(cursor ? { cursor } : {}) })
      ).view;
      pages += 1;
      assert.ok(page.rows.length <= 4);
      assert.equal(page.streams, 6, "streams counts every match, not the page");
      seen.push(...page.rows.map((r) => `${r.station}:${r.stream}`));
      cursor = page.nextCursor;
    } while (cursor !== undefined && pages < 10);
    assert.equal(pages, 2);
    assert.deepEqual(
      seen,
      all.rows.map((r) => `${r.station}:${r.stream}`),
    );
    // Keyset, not offset: rows that leave between pages move nothing past the cursor.
    const first = (await guide(h, shim, { limit: 2 })).view;
    assert.deepEqual(
      first.rows.map((r) => r.station),
      ["alpha", "alpha"],
    );
    h.clock.advance(6_000); // alpha's two rows expire and leave
    const second = (
      await guide(h, shim, { limit: 2, cursor: first.nextCursor })
    ).view;
    assert.deepEqual(
      second.rows.map((r) => `${r.station}:${r.stream}`),
      ["ops:ops.deploy", "ops:ops.fleet"],
    );
    const bad = await h.call(shim, "canticle_guide", { cursor: "nope" });
    assert.equal(bad.ok, false);
    assert.match(bad.text, /cursor/u);
    const capped = (await guide(h, shim, { limit: 1_000 })).view;
    assert.equal(
      capped.rows.length,
      4,
      "a limit past 100 is capped, not refused",
    );
  } finally {
    h.dispose();
  }
});

test("guide tool: canticle off, or an ear that tunes nothing, says so", async () => {
  const off = harness();
  try {
    const shim = off.attach("scribe");
    const result = await off.call(shim, "canticle_guide", {});
    assert.equal(result.ok, true);
    assert.match(result.text, /canticle is not enabled/u);
  } finally {
    off.dispose();
  }
  const { h, host } = setup(undefined);
  try {
    host.tune = [];
    const shim = h.attach("scribe");
    const result = await h.call(shim, "canticle_guide", {});
    assert.equal(result.ok, true);
    assert.match(result.text, /tunes no station:stream/u);
  } finally {
    h.dispose();
  }
});

// ---- known gaps stay known (🌫 on #133): a stream frond-ear itself dropped is never absent

/** The record v1 live set's bound (records.ts MAX_LIVE). */
const FULL = 4_096;

/** Fills the live set with one tuned record each on FULL stations' ops.fleet. */
function fill(host: { sing(seq: number, o: Record<string, unknown>): void }) {
  for (let i = 0; i < FULL; i += 1) host.sing(i + 1, { station: `s${i}` });
}

test("guide: a stream known only by its local omission gets a row (live 0) and matches query; hear and the guide agree", async () => {
  const { h, host } = setup(undefined);
  try {
    const shim = h.attach("scribe");
    fill(host);
    host.sing(9_000, { station: "quiet" }); // refused: 4,096 tuned streams hold one each
    const heard = await h.call(shim, "hear", { stream: "quiet:ops.fleet" });
    assert.match(
      heard.text,
      /^local omission \(live_overflow\): quiet:ops\.fleet: 1 record dropped/mu,
      "hear names the known local omission",
    );
    const { view } = await guide(h, shim, { query: "quiet" });
    assert.equal(view.streams, 1, "the dropped stream is not absent");
    const quiet = row(view, "quiet", "ops.fleet");
    assert.equal(quiet.live, 0);
    assert.deepEqual(quiet.localOmissions, {
      reason: "live_overflow",
      count: 1,
    });
    assert.deepEqual(quiet.keys, [OPS]);
    assert.equal(quiet.freshness, "none live");
    assert.equal((await guide(h, shim)).view.streams, FULL + 1);
  } finally {
    h.dispose();
  }
});

test("guide: drops past the streams counted one by one (the shared count) are a gap, whatever the query", async () => {
  const { h, host } = setup(undefined);
  try {
    const shim = h.attach("scribe");
    fill(host);
    for (let i = 0; i < 300; i += 1) {
      host.sing(10_000 + i, { station: `late${i}` }); // each refused, a stream of its own
    }
    const heard = await h.call(shim, "hear", {});
    assert.match(heard.text, /other tuned streams: \d+ records? dropped/u);
    for (const query of [undefined, "late299", "nothing-matches-this"]) {
      const { view } = await guide(h, shim, query ? { query } : {});
      assert.ok(
        view.gaps?.some((gap) =>
          /^local omission \(live_overflow\): other tuned streams: \d+ records? dropped .*which streams is unknown/u.test(
            gap,
          ),
        ),
        `query ${query}: ${JSON.stringify(view.gaps)}`,
      );
    }
  } finally {
    h.dispose();
  }
});

test("guide: a pattern tuned while untuned records were being dropped reads coverage unknown, on its rows and as a gap", async () => {
  const { h, host } = setup(undefined);
  try {
    const shim = h.attach("scribe");
    for (let i = 0; i < FULL + 1; i += 1) {
      host.sing(i + 1, { stream: "town.square" }); // untuned: the last is refused
    }
    host.tune = [...host.tune, "ops:town.square"];
    const heard = await h.call(shim, "hear", { limit: 1 });
    assert.match(
      heard.text,
      /^coverage unknown: ops:town\.square was tuned at /mu,
    );
    const { view } = await guide(h, shim, { query: "square" });
    const square = row(view, "ops", "town.square");
    assert.equal(square.live, FULL);
    assert.equal(square.coverageUnknown?.dropped, 1);
    assert.ok(
      view.gaps?.some((gap) =>
        /^coverage unknown: ops:town\.square was tuned at .*how many unknown/u.test(
          gap,
        ),
      ),
      JSON.stringify(view.gaps),
    );
    assert.ok(
      view.gaps?.some((gap) =>
        /^local omission \(live_overflow\): untuned streams: 1 record dropped/u.test(
          gap,
        ),
      ),
      JSON.stringify(view.gaps),
    );
  } finally {
    h.dispose();
  }
});
