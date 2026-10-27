// Listener behaviour beyond the spike's vectors: bounded state (binary-canticle#60),
// refusals that leave state untouched, scope / hop / warm-up / beacon paths.
import assert from "node:assert/strict";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as cbor from "../src/canticle/cbor.ts";
import { CLASSES, CLASS_BY_NAME, streamId } from "../src/canticle/ids.ts";
import {
  Listener,
  SKEW_MS,
  type SafetyState,
} from "../src/canticle/listener.ts";
import { Manifest } from "../src/canticle/manifest.ts";
import {
  KIND_BEACON,
  KIND_ITEM,
  KIND_PLUCK,
  SIGN_DOMAIN,
} from "../src/canticle/wire.ts";

const vectors = JSON.parse(
  readFileSync(
    new URL("./fixtures/canticle/frame-v2-candidates.json", import.meta.url),
    "utf8",
  ),
) as {
  keys: Record<string, { secret: string; key_id: string }>;
  manifest: { stations: Array<Record<string, unknown> & { name: string }> };
};
const manifest = Manifest.fromJson(vectors.manifest);
const T0 = 1_790_000_000_000;
const CHATTER = streamId("chatter");
const THREAT = streamId("lens.threat");

interface Signer {
  sk: KeyObject;
  kid: Buffer;
}

function signer(name: string): Signer {
  return {
    sk: createPrivateKey({
      key: Buffer.from(
        "302e020100300506032b657004220420" + vectors.keys[name]!.secret,
        "hex",
      ),
      format: "der",
      type: "pkcs8",
    }),
    kid: Buffer.from(vectors.keys[name]!.key_id, "hex"),
  };
}

const TEST1 = signer("test1");
const { kid } = TEST1;

function frame(
  kind: number,
  fields: Record<number, cbor.CborValue | number>,
  { sk, kid }: Signer = TEST1,
): Uint8Array {
  const m: cbor.CborMap = new Map();
  for (const [k, v] of Object.entries(fields))
    m.set(BigInt(k), typeof v === "number" ? BigInt(v) : v);
  const unsigned = Buffer.concat([
    Buffer.from([0x42, 0x43, 2, kind]),
    kid,
    cbor.encode(m),
  ]);
  const sig = sign(null, Buffer.concat([SIGN_DOMAIN, unsigned]), sk);
  return new Uint8Array(Buffer.concat([unsigned, sig]));
}

interface ItemOpts {
  epoch?: number;
  stream?: number;
  seq: number;
  issued?: number;
  ttlMs?: number;
  cls?: number;
  stateKey?: string;
  hop?: number;
  scope?: number;
  text?: string;
  as?: Signer;
}

function item(o: ItemOpts): Uint8Array {
  const issued = o.issued ?? T0;
  const f: Record<number, cbor.CborValue | number> = {
    1: o.epoch ?? 1,
    2: o.stream ?? CHATTER,
    3: o.seq,
    4: issued,
    5: issued + (o.ttlMs ?? 60_000),
    6: o.cls ?? 1,
    7: 1,
    8: new TextEncoder().encode(o.text ?? `item ${o.seq}`),
    11: o.hop ?? 0,
    13: o.scope ?? 1,
  };
  if (o.stateKey !== undefined) f[10] = o.stateKey;
  return frame(KIND_ITEM, f, o.as);
}

function beacon(
  epoch: number,
  bseq: number,
  streams: number[][],
  wallclock = T0,
): Uint8Array {
  return frame(KIND_BEACON, {
    1: epoch,
    2: bseq,
    3: wallclock,
    4: 1_000,
    5: "canticle-regulation/1",
    6: streams.map((e) => e.map((v) => BigInt(v))),
    8: 16_000,
  });
}

const kinds = (evs: { event: string; data: Record<string, unknown> }[]) =>
  evs
    .filter((e) => e.event !== "presence")
    .map((e) =>
      e.event === "evidence" ? `evidence:${String(e.data.reason)}` : e.event,
    );

// quota = floor(capacity / 3 stations)
const listener = (capacity = 100_000, warmup = false) =>
  new Listener(manifest, { ephemeral: true, warmup, dedupCapacity: capacity });

test("dedup over-quota refuses new tuples, and the refusal moves no state", () => {
  const l = listener(6); // quota 2
  assert.deepEqual(kinds(l.hear(item({ seq: 1 }), T0)), ["item"]);
  assert.deepEqual(kinds(l.hear(item({ seq: 2 }), T0)), ["item"]);
  assert.deepEqual(kinds(l.hear(item({ seq: 3, epoch: 5 }), T0)), [
    "evidence:over-quota",
  ]);
  assert.equal(
    l.stations.get(kid.toString("hex"))!.epochHwm,
    1,
    "refused frame must not advance the epoch",
  );
  assert.equal(l.dedup.size, 2);
});

test("supersession marks have their own per-key limit, apart from dedup (#60 item 3)", () => {
  const l = new Listener(manifest, {
    ephemeral: true,
    warmup: false,
    perKeyQuota: 2,
    perKeyMarkQuota: 2,
  });
  const live = (seq: number, sk: string, at: number) =>
    l.hear(
      item({
        seq,
        cls: 3,
        stateKey: sk,
        stream: THREAT,
        issued: at,
        ttlMs: 60_000,
      }),
      at,
    );
  assert.deepEqual(kinds(live(1, "a", T0)), ["item"]);
  assert.deepEqual(kinds(live(2, "b", T0)), ["item"]);
  const later = T0 + 60_000 + SKEW_MS + 2_000; // dedup slots purged, marks kept for the class max TTL
  l.tick(later);
  assert.equal(l.dedup.size, 0);
  assert.equal(l.hwm.size, 2);
  assert.deepEqual(kinds(live(3, "c", later)), ["evidence:over-quota"]);
  assert.equal(l.dedup.size, 0, "a mark refusal takes no dedup slot");
  assert.deepEqual(
    kinds(live(4, "a", later)),
    ["item"],
    "an existing state_key still updates",
  );
});

test("the default mark limit lets an honest key churn state_keys within its share", () => {
  // quota 2; live-state factor ⌈((180 + 900) s + 5 s) / 180 s⌉ = 7, so 14 marks
  const l = new Listener(manifest, {
    ephemeral: true,
    warmup: false,
    perKeyQuota: 2,
  });
  let at = T0;
  for (let i = 0; i < 14; i++) {
    const out = kinds(
      l.hear(
        item({
          seq: i + 1,
          cls: 3,
          stateKey: `k${i}`,
          stream: THREAT,
          issued: at,
          ttlMs: 60_000,
        }),
        at,
      ),
    );
    assert.deepEqual(out, ["item"], `state_key k${i}`);
    at += 70_000; // past the previous dedup slot
    l.tick(at);
  }
});

// ---- binary-canticle#67 / #117: the derived mark limit's factor is capped at the keyed classes' largest

/** The vector manifest's stations, granted `classes` instead (none revoked). */
const granted = (classes: string[], names = ["test1"]) =>
  Manifest.fromJson({
    stations: vectors.manifest.stations
      .filter((s) => names.includes(s.name))
      .map((s) => ({ ...s, classes, revoked: false })),
  });
const FINDING_REF = CLASS_BY_NAME.get("finding-ref")!.code;
const ADVISORY = CLASS_BY_NAME.get("advisory")!.code;
// A 1 s item's dedup slot is gone after its expiry + skew (6 s); its mark lasts that + the class max TTL.
const STEP_MS = 7_000;
const shortLived = (
  seq: number,
  at: number,
  stateKey: string,
  cls = FINDING_REF,
  as: Signer = TEST1,
  text?: string,
) =>
  item({
    seq,
    cls,
    stateKey,
    issued: at,
    ttlMs: 1_000,
    as,
    ...(text === undefined ? {} : { text }),
  });
// The three vector stations' keys; `granted(…, THREE_STATIONS)` lists test3 unrevoked.
const THREE_STATIONS = ["test1", "test2", "test3"];
const signers = ["test1", "test2", "test3-revoked"].map(signer);
// How many dedup lifetimes a mark of each class lasts, ⌈(default TTL + max TTL + skew) / default TTL⌉,
// from the class table; the cap is the largest among keyed classes (state_key required, §6.2).
const factorOf = new Map(
  [...CLASSES.values()].map((c) => [
    c.name,
    Math.ceil(
      ((c.defaultTtlS + c.maxTtlS) * 1000 + SKEW_MS) / (c.defaultTtlS * 1000),
    ),
  ]),
);
const CAP = Math.max(
  ...[...CLASSES.values()]
    .filter((c) => c.keyed)
    .map((c) => factorOf.get(c.name)!),
);
const overQuota = (evs: { event: string; data: Record<string, unknown> }[]) =>
  evs.filter((e) => e.event === "evidence" && e.data.reason === "over-quota")
    .length;

test("the mark limit's factor is capped at the keyed classes' largest, derived from the class table (#67)", () => {
  assert.deepEqual(Object.fromEntries(factorOf), {
    chatter: 7,
    ambient: 14,
    "live-state": 7,
    advisory: 6,
    "finding-ref": 98,
    regulatory: 8,
    alarm: 6,
    control: 8,
    root: 3,
  });
  assert.equal(CAP, 8); // regulatory, control
  // At a dedup quota of 1 the limit is the factor itself. Classes at or under the cap keep theirs;
  // finding-ref (98) and ambient (14) stop at 8. The factor is still the largest over every granted
  // class, keyed or not, so advisory (unkeyed, 6) beside finding-ref gets 8, not 6.
  for (const [classes, factor] of [
    [["finding-ref"], 8], // main: 98
    [["ambient"], 8], // main: 14
    [["chatter", "finding-ref"], 8], // main: 98
    [["advisory", "finding-ref"], 8], // main: 98 (the binary-canticle#115 profile)
    [["regulatory"], 8],
    [["control"], 8],
    [["chatter", "live-state", "root"], 7],
    [["advisory"], 6],
    [["alarm"], 6],
    [["root"], 3],
  ] as const) {
    const l = new Listener(granted([...classes]), {
      ephemeral: true,
      warmup: false,
      perKeyQuota: 1,
    });
    const cls = CLASS_BY_NAME.get(classes[0])!.code;
    let admitted = 0;
    let refused = 0;
    for (let i = 0; i <= CAP; i++) {
      const at = T0 + i * STEP_MS;
      l.tick(at);
      const evs = l.hear(shortLived(i + 1, at, `k${i}`, cls), at);
      admitted += kinds(evs).filter((k) => k === "item").length;
      refused += overQuota(evs);
    }
    assert.deepEqual(
      [admitted, refused, l.hwm.size],
      [factor, CAP + 1 - factor, factor],
      classes.join("+"),
    );
  }
});

test("a key granted finding-ref churning state_keys holds at most quota × 8 marks (#67)", () => {
  const l = new Listener(granted(["finding-ref"]), {
    ephemeral: true,
    warmup: false,
    perKeyQuota: 2,
  });
  let admitted = 0;
  let refused = 0;
  for (let i = 0; i < 60; i++) {
    const at = T0 + i * STEP_MS;
    l.tick(at);
    for (let j = 0; j < 2; j++) {
      const evs = l.hear(shortLived(2 * i + j + 1, at, `f${i}.${j}`), at);
      admitted += kinds(evs).filter((k) => k === "item").length;
      refused += overQuota(evs);
    }
    assert.ok(l.hwm.size <= 16, `round ${i}: ${l.hwm.size} marks`);
  }
  assert.deepEqual(
    [admitted, refused, l.hwm.size, l.hwmPerKey.get(kid.toString("hex"))],
    [16, 104, 16, 16], // main: 120 admitted, 0 refused
  );
  const at = T0 + 60 * STEP_MS;
  assert.deepEqual(
    kinds(l.hear(shortLived(200, at, "f0.0"), at)),
    ["item"],
    "a marked state_key needs no new mark",
  );
});

test("the mark cap holds per key when several keys saturate together (#67)", () => {
  // Equal shares (no per-key quota, capacity ≥ keys): each key holds its own quota × 8 and none
  // locks another out. 30 / 3 leaves no remainder, so the sum is exactly 8 × the dedup capacity.
  const l = new Listener(granted(["finding-ref"], THREE_STATIONS), {
    ephemeral: true,
    warmup: false,
    dedupCapacity: 30,
  });
  for (let i = 0; i < 12; i++) {
    const at = T0 + i * STEP_MS;
    l.tick(at);
    for (const as of signers) {
      for (let j = 0; j < 10; j++) {
        l.hear(
          shortLived(10 * i + j + 1, at, `f${i}.${j}`, FINDING_REF, as),
          at,
        );
      }
    }
  }
  assert.deepEqual(
    signers.map((s) => l.hwmPerKey.get(s.kid.toString("hex"))),
    [80, 80, 80], // main: 120 each
  );
  assert.equal(l.hwm.size, 8 * 30);
});

test("the 8 × capacity sum over keys holds only for equal shares (#67)", () => {
  // The cap is per key: the sum is 8 × the per-key dedup quotas. An explicit per-key quota, or the
  // floor of 1 with more keys than capacity, takes it past 8 × the dedup capacity.
  const saturate = (l: Listener, quota: number) => {
    for (let i = 0; i <= CAP; i++) {
      const at = T0 + i * STEP_MS;
      l.tick(at);
      for (const as of signers) {
        for (let j = 0; j < quota; j++) {
          l.hear(
            shortLived(quota * i + j + 1, at, `f${i}.${j}`, FINDING_REF, as),
            at,
          );
        }
      }
    }
    return l.hwm.size;
  };
  const three = granted(["finding-ref"], THREE_STATIONS);
  const opts = { ephemeral: true, warmup: false } as const;
  assert.equal(
    saturate(
      new Listener(three, { ...opts, dedupCapacity: 30, perKeyQuota: 20 }),
      20,
    ),
    3 * 20 * 8, // not 8 × 30 = 240
  );
  assert.equal(
    saturate(new Listener(three, { ...opts, dedupCapacity: 2 }), 1),
    3 * 8, // quota floored at 1 each; not 8 × 2 = 16
  );
});

test("a full mark limit refuses a new incident's open, never a marked incident's close (#67, binary-canticle#115)", () => {
  // advisory (unkeyed, state_key optional) + finding-ref: the keyed advisories make the marks and
  // count against the key's limit. A resolve for an incident already marked needs no new mark.
  const l = new Listener(granted(["advisory", "finding-ref"]), {
    ephemeral: true,
    warmup: false,
    perKeyQuota: 1,
  });
  const adv = (seq: number, at: number, inc: string, text: string) =>
    l.hear(shortLived(seq, at, inc, ADVISORY, TEST1, text), at);
  for (let i = 0; i < 8; i++) {
    const at = T0 + i * STEP_MS;
    l.tick(at);
    assert.deepEqual(kinds(adv(i + 1, at, `inc-${i}`, "open")), ["item"]);
  }
  assert.equal(l.hwmPerKey.get(kid.toString("hex")), 8);
  assert.deepEqual(
    new Set([...l.hwm.values()].map((v) => v.cls)),
    new Set([ADVISORY]),
  );
  let at = T0 + 8 * STEP_MS;
  l.tick(at);
  assert.deepEqual(kinds(adv(9, at, "inc-8", "open")), ["evidence:over-quota"]); // main: admitted (limit 98)
  at += STEP_MS;
  l.tick(at);
  assert.deepEqual(kinds(adv(10, at, "inc-3", "resolved")), ["item"]);
  assert.equal(
    l.hwm.get(`${kid.toString("hex")}:${CHATTER}:inc-3`)!.order[2],
    10n,
    "the mark moved",
  );
  assert.equal(l.hwm.size, 8, "and none was added");
});

test("marks round-trip a restart at the cap, and state saved over it loads whole (#67)", () => {
  const m = granted(["finding-ref"]);
  const k = kid.toString("hex");
  const restore = (state: SafetyState) =>
    new Listener(m, {
      warmup: false,
      perKeyQuota: 1,
      restore: JSON.parse(JSON.stringify(state)),
    });
  const l = new Listener(m, { warmup: false, perKeyQuota: 1, restore: null });
  for (let i = 0; i < 10; i++) {
    const at = T0 + i * STEP_MS;
    l.tick(at);
    l.hear(shortLived(i + 1, at, `f${i}`), at);
  }
  assert.equal(l.hwmPerKey.get(k), 8); // main: 10
  const at = T0 + 10 * STEP_MS;
  const fresh = restore(l.snapshot());
  assert.deepEqual(fresh.hwm, l.hwm);
  assert.deepEqual(fresh.hwmPerKey, new Map([[k, 8]]));
  assert.deepEqual(kinds(fresh.hear(shortLived(20, at, "new"), at)), [
    "evidence:over-quota",
  ]);
  // State saved under the old, looser limit may hold more marks than the cap. Marks are never
  // evicted early (§7.4): all of them load, and new ones wait until the key is under its limit.
  const state = l.snapshot();
  const row = state.hwm[0]!;
  const prefix = row[0].slice(0, row[0].lastIndexOf(":") + 1);
  for (let i = 0; i < 20; i++) {
    state.hwm.push([
      `${prefix}old${i}`,
      row[1],
      row[2],
      row[3],
      row[4],
      row[5] ?? null,
    ]);
  }
  const old = restore(state);
  assert.deepEqual(old.hwmPerKey, new Map([[k, 28]]));
  assert.deepEqual(kinds(old.hear(shortLived(21, at, "new"), at)), [
    "evidence:over-quota",
  ]);
  assert.equal(old.hwm.size, 28);
  assert.deepEqual(
    kinds(old.hear(shortLived(22, at, "f3"), at)),
    ["item"],
    "a marked state_key still updates",
  );
});

test("a mark's horizon never shrinks when a shorter-lived newer value arrives", () => {
  const l = new Listener(manifest, { ephemeral: true, warmup: false });
  const hkey = `${kid.toString("hex")}:${THREAT}:s`;
  const live = (seq: number, issued: number, ttlMs: number) =>
    l.hear(
      item({ seq, cls: 3, stateKey: "s", stream: THREAT, issued, ttlMs }),
      issued,
    );
  live(1, T0, 600_000);
  const before = l.hwm.get(hkey)!.retain;
  live(2, T0 + 1_000, 10_000);
  assert.ok(l.hwm.get(hkey)!.retain >= before);
});

test("stream hearing times are capped at the key's share (#60 item 1)", () => {
  // Admitted over time (short TTL, ticks between batches), so the dedup quota alone can't
  // bound the map: only the cap does (🌿 #27 B2: this failed to catch the cap's removal).
  const l = new Listener(manifest, {
    ephemeral: true,
    warmup: false,
    perKeyQuota: 10,
  });
  let at = T0;
  for (let batch = 0; batch < 20; batch++) {
    for (let i = 0; i < 10; i++) {
      const n = batch * 10 + i;
      l.hear(
        item({ seq: n + 1, stream: 1000 + n, issued: at, ttlMs: 1_000 }),
        at,
      );
    }
    at += 1_000 + SKEW_MS + 1_000; // past the batch's dedup retention
    l.tick(at);
  }
  assert.equal(l.dedup.size, 0, "every batch was admitted and then purged");
  assert.ok(l.stations.get(kid.toString("hex"))!.lastStreamItem.size <= 10);
});

test("beacon loop maps are capped and reset on epoch advance (#60 item 2)", () => {
  const l = listener();
  for (let b = 1; b <= 20; b++) {
    const entries = Array.from({ length: 32 }, (_, i) => [
      b * 100 + i,
      1,
      1,
      1,
      10_000,
      10_000,
      60,
      300,
      4_000,
    ]);
    l.hear(beacon(1, b, entries), T0 + b);
  }
  const st = l.stations.get(kid.toString("hex"))!;
  assert.equal(
    st.streamLoops.size,
    32,
    "one advertised catalog: the latest page 0 of 1",
  );
  assert.equal(st.streamLoopMax.size, 32);
  l.hear(
    beacon(2, 1, [[CHATTER, 1, 1, 1, 10_000, 10_000, 60, 300, 4_000]]),
    T0 + 100,
  );
  assert.equal(st.streamLoops.size, 1);
  assert.equal(st.streamLoopMax.size, 1);
  assert.equal(st.bseq, 1n);
});

test("stream-entry is the post-A1 9/10-element shape, bounded per the §9.8 CDDL (binary-canticle#70)", () => {
  const l = listener();
  const st = () => l.stations.get(kid.toString("hex"))!;
  const entry = [CHATTER, 9, 4, 3, 5_000, 5_000, 60, 300, 4_000];
  assert.deepEqual(kinds(l.hear(beacon(1, 1, [entry]), T0)), []);
  const e = st().streamEntries.get(CHATTER)!;
  assert.deepEqual(
    [e.headSeq, e.trailSeq, e.live, e.lens],
    [9n, 4n, 3, undefined],
  );
  l.hear(beacon(1, 2, [[...entry, 7]]), T0);
  assert.equal(st().streamEntries.get(CHATTER)!.lens, 7);
  // nothing on air: trail_seq = head_seq + 1 (§9.8). The listener only holds it (no §7.10 wait or repair).
  l.hear(beacon(1, 3, [[CHATTER, 10, 11, 0, 0, 0, 60, 300, 4_000]]), T0);
  assert.equal(st().streamEntries.get(CHATTER)!.trailSeq, 11n);
  // head_seq and trail_seq are u64 (bigint on this port)
  const u64 = 2n ** 64n - 1n;
  l.hear(
    frame(KIND_BEACON, {
      1: 1,
      2: 4,
      3: T0,
      4: 1_000,
      5: "p",
      6: [[BigInt(CHATTER), u64, u64, 0n, 0n, 0n, 60n, 300n, 4_000n]],
      8: 16_000,
    }),
    T0,
  );
  assert.equal(st().streamEntries.get(CHATTER)!.trailSeq, u64);
  const bad: Record<string, number[]> = {
    "pre-A1 8 elements (would read shifted)": [
      CHATTER,
      12,
      0,
      5_000,
      5_000,
      60,
      300,
      4_000,
    ],
    "7 elements": entry.slice(0, 7),
    "11 elements": [...entry, 7, 8],
    "stream_id > u32": [2 ** 32, ...entry.slice(1)],
    "live > u32": [...entry.slice(0, 3), 2 ** 32, ...entry.slice(4)],
    "b_stream > u32": [...entry.slice(0, 8), 2 ** 32],
    "b_stream 2^60 (#66 case 4)": [...entry.slice(0, 8), 2 ** 60],
    "lens > u32": [...entry, 2 ** 32],
  };
  for (const [label, b] of Object.entries(bad)) {
    assert.deepEqual(
      kinds(l.hear(beacon(1, 5, [b]), T0)),
      ["evidence:bad-field"],
      label,
    );
  }
  assert.equal(
    st().streamEntries.get(CHATTER)!.trailSeq,
    u64,
    "a refused beacon changes nothing",
  );
  // next_beacon_ms and b_station are u32 (§9.8 key table)
  for (const [k, label] of [
    [4, "next_beacon_ms"],
    [8, "b_station"],
  ] as const) {
    const over = frame(KIND_BEACON, {
      1: 1,
      2: 5,
      3: T0,
      4: 1_000,
      5: "p",
      6: [],
      8: 16_000,
      [k]: 2 ** 32,
    });
    assert.deepEqual(kinds(l.hear(over, T0)), ["evidence:bad-field"], label);
  }
});

test("a repeated or older beacon is ignored", () => {
  const l = listener();
  const e = [[CHATTER, 1, 1, 1, 10_000, 10_000, 60, 300, 4_000]];
  l.hear(beacon(1, 5, e, T0), T0);
  const st = l.stations.get(kid.toString("hex"))!;
  l.hear(beacon(1, 4, e, T0 - 50_000), T0 + 10);
  assert.equal(st.bseq, 5n);
  assert.equal(st.offsets.length, 1);
});

test("PLUCK expiry is clamped (#60 item 4)", () => {
  const l = listener();
  const pluck = frame(KIND_PLUCK, {
    1: 1,
    2: CHATTER,
    3: 2,
    4: T0,
    5: T0 + 31 * 365 * 86_400_000,
    13: 1,
    20: 1,
  });
  assert.deepEqual(kinds(l.hear(pluck, T0)), []);
  const [retain] = [...l.stickyPluck.values()];
  assert.ok(
    retain! <= T0 + 86_400_000 + SKEW_MS,
    `sticky until ${retain! - T0} ms`,
  );
});

test("scope: narrower than the binding, or not granted, is refused", () => {
  const l = listener();
  assert.deepEqual(kinds(l.hear(item({ seq: 1, scope: 0 }), T0)), [
    "evidence:scope-violation",
  ]);
  assert.deepEqual(kinds(l.hear(item({ seq: 2, scope: 2 }), T0)), [
    "evidence:scope-violation",
  ]);
  assert.equal(l.dedup.size, 0);
});

test("hop above the class limit is refused", () => {
  const l = listener();
  assert.deepEqual(kinds(l.hear(item({ seq: 1, hop: 3 }), T0)), [
    "evidence:hop-limit",
  ]);
});

test("warm-up holds live-state until a beacon and one loop period, then releases it", () => {
  const l = listener(100_000, true);
  const live = item({
    seq: 1,
    cls: 3,
    stateKey: "threat",
    stream: THREAT,
    ttlMs: 120_000,
  });
  assert.deepEqual(kinds(l.hear(live, T0)), []);
  assert.equal(l.held.size, 1);
  l.hear(
    beacon(1, 1, [[THREAT, 1, 1, 1, 5_000, 5_000, 180, 900, 4_000]]),
    T0 + 1_000,
  );
  assert.deepEqual(kinds(l.tick(T0 + 2_000)), []); // still inside the loop period
  assert.deepEqual(kinds(l.tick(T0 + 6_500)), ["item"]);
  assert.equal(l.held.size, 0);
});

test("a manifest refuses small-order station keys", () => {
  assert.throws(
    () =>
      Manifest.fromJson({
        stations: [
          {
            name: "bad",
            public_key: "01" + "00".repeat(31),
            classes: ["chatter"],
          },
        ],
      }),
    /small-order/,
  );
});

// ---- restart safety: snapshot → JSON → restore (§5.2, §7.4, §7.7, §7.8)

function restarted(l: Listener): Listener {
  const json = JSON.parse(JSON.stringify(l.snapshot()));
  return new Listener(manifest, { warmup: false, restore: json });
}

test("restart: an item accepted before is surfaced once more, then repeats are no-ops", () => {
  const l = new Listener(manifest, { warmup: false, restore: null });
  const it = item({ seq: 1 });
  assert.deepEqual(kinds(l.hear(it, T0)), ["item"]);
  assert.equal(l.dirty, true);
  const r = restarted(l);
  assert.equal(r.dirty, false);
  assert.deepEqual(kinds(r.hear(it, T0 + 1_000)), ["item"]);
  assert.deepEqual(kinds(r.hear(it, T0 + 2_000)), []);
});

test("restart: a PLUCK survives, so the original can't come back", () => {
  const l = new Listener(manifest, { warmup: false, restore: null });
  l.hear(
    frame(KIND_PLUCK, {
      1: 1,
      2: CHATTER,
      3: 2,
      4: T0,
      5: T0 + 60_000,
      13: 1,
      20: 1,
    }),
    T0,
  );
  const r = restarted(l);
  assert.deepEqual(kinds(r.hear(item({ seq: 1 }), T0 + 1_000)), [
    "evidence:plucked",
  ]);
});

test("restart: supersession survives, so an older value is refused", () => {
  const l = new Listener(manifest, { warmup: false, restore: null });
  const live = (seq: number, issued: number) =>
    item({
      seq,
      cls: 3,
      stateKey: "threat",
      stream: THREAT,
      issued,
      ttlMs: 120_000,
    });
  assert.deepEqual(kinds(l.hear(live(2, T0 + 5_000), T0 + 5_000)), ["item"]);
  const r = restarted(l);
  assert.deepEqual(kinds(r.hear(live(1, T0), T0 + 6_000)), [
    "evidence:superseded",
  ]);
  assert.deepEqual(
    kinds(r.hear(live(2, T0 + 5_000), T0 + 6_000)),
    ["item"],
    "the newest value resurfaces once",
  );
});

test("restart: the epoch high-water mark survives", () => {
  const l = new Listener(manifest, { warmup: false, restore: null });
  l.hear(item({ seq: 1, epoch: 3 }), T0);
  const r = restarted(l);
  assert.deepEqual(kinds(r.hear(item({ seq: 9, epoch: 2 }), T0 + 1_000)), [
    "evidence:epoch-regression",
  ]);
});

test("restart: a snapshot from another version is refused", () => {
  assert.throws(
    () =>
      new Listener(manifest, {
        restore: {
          version: 99,
          epochs: {},
          dedup: [],
          stickyPluck: [],
          hwm: [],
        },
      }),
    /unsupported version/,
  );
});

test("restart: the §9.7 PLUCK check survives (state v2 keeps expires_at and scope)", () => {
  const l = new Listener(manifest, { warmup: false, restore: null });
  l.hear(item({ seq: 1 }), T0); // expires T0 + 60 s, scope lan
  const r = restarted(l);
  const wrong = frame(KIND_PLUCK, {
    1: 1,
    2: CHATTER,
    3: 2,
    4: T0,
    5: T0 + 30_000,
    13: 1,
    20: 1,
  });
  assert.deepEqual(kinds(r.hear(wrong, T0 + 1_000)), [
    "evidence:pluck-mismatch",
  ]);
});

test("restart: a v1 snapshot (no PLUCK metadata) still loads", () => {
  const v1 = {
    version: 1,
    epochs: {},
    dedup: [["x:1:1:1", "00", T0 + 60_000]],
    stickyPluck: [],
    hwm: [],
  };
  const r = new Listener(manifest, { warmup: false, restore: v1 as never });
  assert.equal(r.dedup.size, 1);
});

test("q21: a class change for a state_key in the mark's epoch is dropped; the mark keeps its class", () => {
  const l = new Listener(manifest, { ephemeral: true, warmup: false });
  const hkey = `${kid.toString("hex")}:${THREAT}:s`;
  assert.deepEqual(
    kinds(l.hear(item({ seq: 1, cls: 3, stateKey: "s", stream: THREAT }), T0)),
    ["item"],
  );
  assert.deepEqual(
    kinds(
      l.hear(
        item({
          seq: 2,
          cls: 4,
          stateKey: "s",
          stream: THREAT,
          issued: T0 + 1_000,
        }),
        T0 + 1_000,
      ),
    ),
    ["evidence:class-change"],
  );
  assert.equal(l.hwm.get(hkey)!.cls, 3);
  assert.equal(l.hwm.get(hkey)!.order[2], 1n, "the mark did not move");
});

test("q21: state v3 keeps a mark's class; a v2 mark learns it when its own item resurfaces", () => {
  const l = new Listener(manifest, { warmup: false, restore: null });
  l.hear(
    item({ seq: 1, cls: 3, stateKey: "s", stream: THREAT, ttlMs: 120_000 }),
    T0,
  );
  const snap = l.snapshot();
  assert.equal(snap.version, 3);
  assert.equal(snap.hwm[0]![5], 3);
  // Downgrade the snapshot to v2 (marks without a class).
  const v2 = {
    ...snap,
    version: 2,
    hwm: snap.hwm.map((r) => r.slice(0, 5)),
  } as never;
  const r = new Listener(manifest, { warmup: false, restore: v2 });
  const hkey = `${kid.toString("hex")}:${THREAT}:s`;
  assert.equal(r.hwm.get(hkey)!.cls, undefined);
  r.hear(
    item({ seq: 1, cls: 3, stateKey: "s", stream: THREAT, ttlMs: 120_000 }),
    T0 + 1_000,
  );
  assert.equal(r.hwm.get(hkey)!.cls, 3, "learned on resurface");
});

test("q21 + journal: a v2 mark's learned class is journaled and survives a crash before the checkpoint (🕯 #32)", () => {
  const l = new Listener(manifest, { warmup: false, restore: null });
  l.hear(
    item({ seq: 1, cls: 3, stateKey: "s", stream: THREAT, ttlMs: 120_000 }),
    T0,
  );
  const snap = l.snapshot();
  const v2 = {
    ...snap,
    version: 2,
    hwm: snap.hwm.map((r) => r.slice(0, 5)),
  } as never;
  const hkey = `${kid.toString("hex")}:${THREAT}:s`;
  // Restore from v2: the mark has no class until its own item resurfaces.
  const r = new Listener(manifest, { warmup: false, restore: v2 });
  r.takeJournal();
  r.hear(
    item({ seq: 1, cls: 3, stateKey: "s", stream: THREAT, ttlMs: 120_000 }),
    T0 + 1_000,
  );
  assert.equal(r.hwm.get(hkey)!.cls, 3);
  assert.equal(r.urgent, true, "learning a class is a raised guard");
  const rec = r.takeJournal();
  assert.ok(rec, "and it is journaled");
  // Crash before any checkpoint: restart from the same v2 snapshot plus the journal.
  const after = new Listener(manifest, {
    warmup: false,
    restore: v2,
    journal: [rec],
  });
  assert.equal(after.hwm.get(hkey)!.cls, 3, "the learned class survived");
  // A different class later in the same epoch is still a class change, and dropped.
  assert.deepEqual(
    kinds(
      after.hear(
        item({
          seq: 2,
          cls: 4,
          stateKey: "s",
          stream: THREAT,
          issued: T0 + 2_000,
          ttlMs: 120_000,
        }),
        T0 + 2_000,
      ),
    ),
    ["evidence:class-change"],
  );
});

test("restart: journal records replay over the snapshot idempotently and monotonically", () => {
  const l = new Listener(manifest, { warmup: false, restore: null });
  l.hear(item({ seq: 1 }), T0); // epoch adopted
  const rec1 = l.takeJournal()!;
  assert.equal(l.takeJournal(), undefined, "taken once");
  l.hear(item({ seq: 2 }), T0); // a plain admission raises nothing
  assert.equal(l.takeJournal(), undefined);
  l.hear(item({ seq: 3, stateKey: "k", issued: T0 + 5_000 }), T0 + 5_000);
  const rec2 = l.takeJournal()!;
  assert.equal(rec2.hwm.length, 1);
  assert.equal(rec2.dedup.length, 1, "the frame that raised the mark");
  const once = new Listener(manifest, { restore: null, journal: [rec1, rec2] });
  const twice = new Listener(manifest, {
    restore: null,
    journal: [rec2, rec1, rec1, rec2],
  });
  const norm = (st: ReturnType<Listener["snapshot"]>) => ({
    ...st,
    dedup: [...st.dedup].sort((x, y) => x[0].localeCompare(y[0])),
  });
  assert.deepEqual(norm(twice.snapshot()), norm(once.snapshot()));
  // An older mark replayed after a newer one never lowers it.
  const stale = structuredClone(rec2);
  stale.hwm[0]![1] = T0;
  stale.hwm[0]![4] = 0;
  const r = new Listener(manifest, { restore: null, journal: [rec2, stale] });
  assert.deepEqual(r.snapshot().hwm, once.snapshot().hwm);
});

test("q21 + journal: a mark's journal record carries its class and replay keeps it", () => {
  const l = new Listener(manifest, { warmup: false, restore: null });
  const hkey = `${kid.toString("hex")}:${THREAT}:s`;
  l.hear(item({ seq: 1, cls: 3, stateKey: "s", stream: THREAT }), T0);
  const rec = l.takeJournal()!;
  assert.equal(rec.version, 3);
  assert.equal(rec.hwm.length, 1);
  assert.equal(rec.hwm[0]![5], 3, "the journaled mark carries its class");
  const r = new Listener(manifest, { restore: null, journal: [rec, rec] });
  assert.equal(r.hwm.get(hkey)!.cls, 3);
});

test("q21 + journal: replay is order-independent with classes and never downgrades a known class", () => {
  const l = new Listener(manifest, { warmup: false, restore: null });
  const hkey = `${kid.toString("hex")}:${THREAT}:s`;
  l.hear(item({ seq: 1, cls: 3, stateKey: "s", stream: THREAT }), T0);
  const rec1 = l.takeJournal()!;
  l.hear(
    item({ seq: 2, cls: 3, stateKey: "s", stream: THREAT, issued: T0 + 1_000 }),
    T0 + 1_000,
  );
  const rec2 = l.takeJournal()!;
  // The same marks as old-shape (v2) journal records: no class.
  const old = (rec: NonNullable<typeof rec1>) =>
    ({
      ...rec,
      version: 2,
      hwm: rec.hwm.map((row) => row.slice(0, 5)),
    }) as never;
  const orders = [
    [rec1, rec2],
    [rec2, rec1],
    [rec2, old(rec2), rec1],
    [old(rec2), rec2, old(rec1)],
    [old(rec1), rec1, old(rec2), rec2],
    [rec1, old(rec2), rec2, old(rec2)],
  ];
  const norm = (st: ReturnType<Listener["snapshot"]>) => ({
    ...st,
    dedup: [...st.dedup].sort((x, y) => x[0].localeCompare(y[0])),
  });
  const want = norm(
    new Listener(manifest, { restore: null, journal: [rec1, rec2] }).snapshot(),
  );
  assert.equal(want.hwm[0]![5], 3);
  for (const journal of orders) {
    const r = new Listener(manifest, { restore: null, journal });
    assert.equal(r.hwm.get(hkey)!.cls, 3, "a known class is never downgraded");
    assert.equal(r.hwm.get(hkey)!.order[2], 2n);
    assert.deepEqual(norm(r.snapshot()), want);
  }
  // A v3 snapshot with the class, then an old-shape record of the same mark: the class stays.
  const r = new Listener(manifest, {
    restore: l.snapshot(),
    journal: [old(rec2)],
  });
  assert.equal(r.hwm.get(hkey)!.cls, 3);
  // Old-shape records alone: the class is unknown, as for a v2 snapshot.
  const u = new Listener(manifest, {
    restore: null,
    journal: [old(rec1), old(rec2)],
  });
  assert.equal(u.hwm.get(hkey)!.cls, undefined);
});

test("q21 + journal: a class change is still dropped after a crash and journal replay", () => {
  const l = new Listener(manifest, { warmup: false, restore: null });
  const saved = l.snapshot(); // the last periodic save, before the mark
  const hkey = `${kid.toString("hex")}:${THREAT}:s`;
  l.hear(item({ seq: 1, cls: 3, stateKey: "s", stream: THREAT }), T0);
  assert.ok(l.urgent);
  const rec = l.takeJournal()!; // journaled before any tick or periodic save; then a crash
  const r = new Listener(manifest, {
    warmup: false,
    restore: saved,
    journal: [rec],
  });
  assert.equal(r.hwm.get(hkey)!.cls, 3);
  assert.deepEqual(
    kinds(
      r.hear(
        item({
          seq: 2,
          cls: 4,
          stateKey: "s",
          stream: THREAT,
          issued: T0 + 1_000,
        }),
        T0 + 1_000,
      ),
    ),
    ["evidence:class-change"],
  );
  assert.equal(r.hwm.get(hkey)!.order[2], 1n, "the mark did not move");
  assert.equal(r.hwm.get(hkey)!.cls, 3);
});
