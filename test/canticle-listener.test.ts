// Listener behaviour beyond the spike's vectors: bounded state (binary-canticle#60),
// refusals that leave state untouched, scope / hop / warm-up / beacon paths.
import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as cbor from "../src/canticle/cbor.ts";
import { streamId } from "../src/canticle/ids.ts";
import { Listener, SKEW_MS } from "../src/canticle/listener.ts";
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
  manifest: unknown;
};
const manifest = Manifest.fromJson(vectors.manifest);
const T0 = 1_790_000_000_000;
const CHATTER = streamId("chatter");
const THREAT = streamId("lens.threat");

const sk = createPrivateKey({
  key: Buffer.from(
    "302e020100300506032b657004220420" + vectors.keys.test1!.secret,
    "hex",
  ),
  format: "der",
  type: "pkcs8",
});
const kid = Buffer.from(vectors.keys.test1!.key_id, "hex");

function frame(
  kind: number,
  fields: Record<number, cbor.CborValue | number>,
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
  return frame(KIND_ITEM, f);
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
  const l = new Listener(manifest, {
    ephemeral: true,
    warmup: false,
    perKeyQuota: 10,
  });
  for (let i = 0; i < 50; i++)
    l.hear(item({ seq: i + 1, stream: 1000 + i }), T0);
  assert.equal(l.stations.get(kid.toString("hex"))!.lastStreamItem.size, 10);
});

test("beacon loop maps are capped and reset on epoch advance (#60 item 2)", () => {
  const l = listener();
  for (let b = 1; b <= 20; b++) {
    const entries = Array.from({ length: 32 }, (_, i) => [
      b * 100 + i,
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
    beacon(2, 1, [[CHATTER, 1, 1, 10_000, 10_000, 60, 300, 4_000]]),
    T0 + 100,
  );
  assert.equal(st.streamLoops.size, 1);
  assert.equal(st.streamLoopMax.size, 1);
  assert.equal(st.bseq, 1n);
});

test("a repeated or older beacon is ignored", () => {
  const l = listener();
  const e = [[CHATTER, 1, 1, 10_000, 10_000, 60, 300, 4_000]];
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
    beacon(1, 1, [[THREAT, 1, 1, 5_000, 5_000, 180, 900, 4_000]]),
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
