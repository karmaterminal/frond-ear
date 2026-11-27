// The guide reads a metadata-only view through each source adapter (🌫 on #133): a guide
// call touches no payload, body, purpose, state key, body ref or provenance on either the
// host-daemon path (record v1) or the embedded receptor, a query matching nothing included.
// And a board that is empty because something holds it (a host MUTE, records lost, no
// landing state yet) says so in `gaps`, as does an ear that is muted (🌿 S3 on #133).
import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as cbor from "../src/canticle/cbor.ts";
import { streamId } from "../src/canticle/ids.ts";
import { Manifest } from "../src/canticle/manifest.ts";
import { RECORD_V } from "../src/canticle/records.ts";
import { CanticleReceptor } from "../src/canticle/receptor.ts";
import { KIND_ITEM, SIGN_DOMAIN } from "../src/canticle/wire.ts";
import { StructuredLogger } from "../src/logger.ts";
import { canticleConfig, setup } from "./canticle-host.ts";
import { harness, type Harness } from "./helpers.ts";

type Client = ReturnType<Harness["attach"]>;

/**
 * Runs `admit` while catching every value put into a Map, and keeps those `pick` names:
 * the objects a source holds its records in, which are not reachable otherwise.
 */
function captured(
  pick: (value: unknown) => object | undefined,
  admit: () => void,
): object[] {
  const held: object[] = [];
  const set = Map.prototype.set;
  Map.prototype.set = function (this: Map<unknown, unknown>, key, value) {
    const found = pick(value);
    if (found !== undefined) held.push(found);
    return set.call(this, key, value);
  };
  try {
    admit();
  } finally {
    Map.prototype.set = set;
  }
  return held;
}

/** Turns each named field of each held object into a getter that counts its reads. */
function poison(held: object[], fields: readonly string[]) {
  const reads: string[] = [];
  for (const object of held) {
    for (const field of fields) {
      if (!Object.hasOwn(object, field)) continue;
      const value = (object as Record<string, unknown>)[field];
      Object.defineProperty(object, field, {
        enumerable: true,
        configurable: true,
        get() {
          reads.push(field);
          return value;
        },
      });
    }
  }
  return reads;
}

/** What a record v1 consumer's live set holds: `{record: {idem, item}, share}`. */
const heldRecordItem = (value: unknown) => {
  const v = value as {
    record?: { idem?: unknown; item?: object };
    share?: unknown;
  };
  return v &&
    typeof v === "object" &&
    v.record?.item &&
    typeof v.share === "string"
    ? v.record.item
    : undefined;
};

/** What the embedded listener holds: a Heard, `{item, ident, kid, firstHeard, …}`. */
const heldListenerItem = (value: unknown) => {
  const v = value as { item?: object; ident?: unknown; firstHeard?: unknown };
  return v &&
    typeof v === "object" &&
    v.item &&
    typeof v.ident === "string" &&
    typeof v.firstHeard === "number"
    ? v.item
    : undefined;
};

const GUIDE_CALLS: Array<Record<string, unknown>> = [
  {},
  { query: "ops" },
  { query: "chatter" },
  { query: "matches-nothing-at-all" },
  { limit: 1 },
];

async function guideCalls(h: Harness, shim: Client) {
  for (const args of GUIDE_CALLS) {
    const result = await h.call(shim, "canticle_guide", args);
    assert.equal(result.ok, true, result.text);
  }
}

test("adapters: a guide call reads no payload from the host daemon's records (record v1); hear does", async () => {
  const { h, host } = setup(undefined);
  try {
    const shim = h.attach("scribe");
    const held = captured(heldRecordItem, () => {
      host.sing(1, {
        text: "payload one",
        stateKey: "silas",
        extra: { purpose: "p" },
      });
      host.sing(2, { stream: "ops.deploy", text: "payload two" });
    });
    assert.equal(held.length, 2, "both records are held");
    const reads = poison(held, [
      "text",
      "purpose",
      "stateKey",
      "bodyRef",
      "bodyDigest",
      "provenance",
    ]);
    await guideCalls(h, shim);
    assert.equal(reads.length, 0, `payload-bearing reads: ${reads.join(", ")}`);
    const view = JSON.parse(
      (await h.call(shim, "canticle_guide", {})).text,
    ) as { streams: number };
    assert.equal(view.streams, 2, "the guide still lists both");
    await h.call(shim, "hear", {});
    assert.ok(reads.includes("text"), "the control: hear reads the payload");
  } finally {
    h.dispose();
  }
});

// The embedded receptor: signed datagrams in, through the listener.
const vectors = JSON.parse(
  readFileSync(
    new URL("./fixtures/canticle/frame-v2-candidates.json", import.meta.url),
    "utf8",
  ),
) as {
  keys: Record<string, { secret: string; key_id: string }>;
  manifest: unknown;
};
const T0 = 1_790_000_000_000;
const test1 = vectors.keys.test1!;
const secret = createPrivateKey({
  key: Buffer.from("302e020100300506032b657004220420" + test1.secret, "hex"),
  format: "der",
  type: "pkcs8",
});

/** A signed ITEM from test1 on `chatter`, issued at T0; `extra` sets more fields. */
function signed(
  seq: number,
  extra: Record<number, cbor.CborValue | number> = {},
) {
  const m: cbor.CborMap = new Map();
  const fields: Record<number, cbor.CborValue | number> = {
    1: 1, // epoch
    2: streamId("chatter"),
    3: seq,
    4: T0,
    5: T0 + 60_000,
    6: 1, // chatter
    7: 1, // lan
    8: new TextEncoder().encode(`item ${seq}`),
    11: 0, // hop
    13: 1, // text
    ...extra,
  };
  for (const [k, v] of Object.entries(fields))
    m.set(BigInt(k), typeof v === "number" ? BigInt(v) : v);
  const unsigned = Buffer.concat([
    Buffer.from([0x42, 0x43, 2, KIND_ITEM]),
    Buffer.from(test1.key_id, "hex"),
    cbor.encode(m),
  ]);
  const signature = sign(null, Buffer.concat([SIGN_DOMAIN, unsigned]), secret);
  return new Uint8Array(Buffer.concat([unsigned, signature]));
}

test("adapters: a guide call reads no body from the embedded listener; hear does", async () => {
  const config = canticleConfig(undefined, {
    source: "embedded",
    manifestPath: "unused",
    tune: { scribe: ["*:chatter"] },
  });
  let receptor: CanticleReceptor | undefined;
  const h = harness(config, {
    canticleHear: (ear) => receptor!.hearView(ear),
    canticleGuide: (ear) => receptor!.guideView(ear),
  });
  try {
    h.clock.value = T0 + 10_000;
    receptor = new CanticleReceptor({
      config: config.canticle!,
      manifest: Manifest.fromJson(vectors.manifest),
      store: h.store,
      logger: new StructuredLogger(() => {}),
      clock: h.clock,
      timers: h.timers,
      socket: () =>
        ({
          on: () => {},
          bind: (_port: number, _host: string, bound: () => void) => bound(),
          close: () => {},
        }) as never,
    });
    receptor.start();
    const shim = h.attach("scribe");
    const held = captured(heldListenerItem, () => {
      receptor!.receive(signed(1));
      receptor!.receive(signed(2, { 10: "silas" })); // keyed: hear hashes its body
    });
    assert.ok(held.length >= 2, `held ${held.length}`);
    const reads = poison(held, ["body", "purpose", "stateKey", "bodyRef"]);
    await guideCalls(h, shim);
    assert.equal(reads.length, 0, `body reads: ${reads.join(", ")}`);
    const view = JSON.parse(
      (await h.call(shim, "canticle_guide", {})).text,
    ) as { rows: Array<{ station: string; stream: string; live: number }> };
    assert.deepEqual(
      view.rows.map((r) => `${r.station}:${r.stream}:${r.live}`),
      ["test1:chatter:2"],
    );
    await h.call(shim, "hear", {});
    assert.ok(reads.includes("body"), "the control: hear decodes the body");
  } finally {
    receptor?.stop();
    h.dispose();
  }
});

interface Board {
  listener: string;
  delivery: string;
  streams: number;
  rows: Array<{ station: string; stream: string; muted: boolean }>;
  gaps?: string[];
}

const board = async (h: Harness, shim: Client, args = {}) =>
  JSON.parse((await h.call(shim, "canticle_guide", args)).text) as Board;

const gapMatching = (view: Board, pattern: RegExp) =>
  view.gaps?.some((gap) => pattern.test(gap)) ?? false;

test("held boards: a host MUTE empties the board and says so, whatever the query; it lifts with the mute", async () => {
  const { h, host } = setup(undefined);
  try {
    const shim = h.attach("scribe");
    host.sing(1);
    host.landing({ mute: { until: null, by: "operator" } });
    for (const args of [{}, { query: "matches-nothing" }]) {
      const view = await board(h, shim, args);
      assert.equal(view.streams, 0);
      assert.ok(
        gapMatching(
          view,
          /^the host daemon's receptor is muted \(MUTE by operator, until it is lifted\)/u,
        ),
        JSON.stringify(view.gaps),
      );
    }
    host.landing({ mute: null });
    const lifted = await board(h, shim);
    assert.equal(lifted.streams, 1);
    assert.equal(gapMatching(lifted, /muted/u), false);
  } finally {
    h.dispose();
  }
});

test("held boards: records lost on the host socket clear the live set and say so until the next run", async () => {
  const { h, host } = setup(undefined);
  try {
    const shim = h.attach("scribe");
    host.sing(1);
    // A rec_seq gap: the records between may have held a retract.
    host.consumer.feed(
      {
        v: RECORD_V,
        type: "health",
        rec_seq: 999,
        run: host.run,
        last_datagram_at: host.now,
        reasons: [],
      },
      host.now,
    );
    const view = await board(h, shim);
    assert.equal(view.streams, 0);
    assert.ok(
      gapMatching(
        view,
        /^records were lost on the host daemon's socket \(records_lost\)/u,
      ),
      JSON.stringify(view.gaps),
    );
  } finally {
    h.dispose();
  }
});

test("held boards: an ear-wide mute is a gap line and on every row, and the rows stay listed", async () => {
  const { h, host } = setup({ mode: "immediate" });
  try {
    const shim = h.attach("scribe");
    host.sing(1);
    await h.call(shim, "set_canticle_delivery", { mode: "mute" });
    const view = await board(h, shim);
    assert.equal(view.delivery, "mute");
    assert.equal(view.streams, 1);
    assert.ok(view.rows.every((r) => r.muted));
    assert.ok(
      gapMatching(view, /^this ear is muted: nothing is pushed to it/u),
      JSON.stringify(view.gaps),
    );
  } finally {
    h.dispose();
  }
});

test("held boards: a connection that has had no landing_state yet says the board is empty, not quiet", async () => {
  const { h, host } = setup(undefined);
  try {
    const shim = h.attach("scribe");
    host.sing(1);
    host.consumer.reconnected();
    host.consumer.feed(
      { v: RECORD_V, type: "hello", rec_seq: 1, run: host.run },
      host.now,
    );
    const view = await board(h, shim);
    assert.equal(view.streams, 0);
    assert.ok(
      gapMatching(
        view,
        /^this connection to the host daemon has had no landing_state yet/u,
      ),
      JSON.stringify(view.gaps),
    );
  } finally {
    h.dispose();
  }
});
