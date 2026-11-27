// The guide reads a metadata-only view through each source adapter (🌫 on #133): a guide
// call touches no payload, body, purpose, state key, body ref or provenance on either the
// host-daemon path (record v1) or the embedded receptor, a query matching nothing included.
// And a board that is empty because something holds it (a host MUTE, records lost, no
// landing state yet) says so in `gaps`, as does an ear that is muted (🌿 S3 on #133).
// The production adapters too (#138): a source built by `createCanticleSource`, as cli.ts
// builds it, and read through `canticleViews`, as cli.ts wires it, with only the peers
// played here: a host daemon on a real unix socket, and a station on real loopback UDP.
// And tsc itself refuses a `hearView` where a guide view goes.
import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import { createSocket } from "node:dgram";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as cbor from "../src/canticle/cbor.ts";
import { streamId } from "../src/canticle/ids.ts";
import { Manifest } from "../src/canticle/manifest.ts";
import { RECORD_V } from "../src/canticle/records.ts";
import {
  CanticleReceptor,
  type GuideItem,
  type GuideSourceView,
  type HearView,
  type LiveItem,
} from "../src/canticle/receptor.ts";
import {
  canticleViews,
  createCanticleSource,
  type CanticleSource,
} from "../src/canticle/source.ts";
import { KIND_ITEM, SIGN_DOMAIN } from "../src/canticle/wire.ts";
import type { Config } from "../src/config.ts";
import type { DaemonOptions } from "../src/daemon.ts";
import { StructuredLogger } from "../src/logger.ts";
import type { EventStore } from "../src/store.ts";
import { canticleConfig, Host, OPS, setup, type R } from "./canticle-host.ts";
import { harness, type Harness } from "./helpers.ts";

type Client = ReturnType<Harness["attach"]>;

/**
 * Runs `admit` while catching every value put into a Map, and keeps those `pick` names:
 * the objects a source holds its records in, which are not reachable otherwise. `admit`
 * may wait for records to come in over a socket.
 */
async function captured(
  pick: (value: unknown) => object | undefined,
  admit: () => void | Promise<void>,
): Promise<object[]> {
  const held: object[] = [];
  const set = Map.prototype.set;
  Map.prototype.set = function (this: Map<unknown, unknown>, key, value) {
    const found = pick(value);
    if (found !== undefined) held.push(found);
    return set.call(this, key, value);
  };
  try {
    await admit();
  } finally {
    Map.prototype.set = set;
  }
  return held;
}

/** Polls until `done`, for what comes in over a real socket. */
async function until(done: () => boolean, what: string, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Turns each named field of each held object into a getter that counts its reads. Each must
 * be the object's own: one held anywhere else would go unwatched, so it fails instead.
 */
function poison(held: object[], fields: readonly string[]) {
  const reads: string[] = [];
  for (const object of held) {
    for (const field of fields) {
      assert.ok(Object.hasOwn(object, field), `a held record's own ${field}`);
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
    const held = await captured(heldRecordItem, () => {
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

/** A signed ITEM from test1 on `chatter`, issued at `at`; `extra` sets more fields. */
function signed(
  seq: number,
  extra: Record<number, cbor.CborValue | number> = {},
  at = T0,
) {
  const m: cbor.CborMap = new Map();
  const fields: Record<number, cbor.CborValue | number> = {
    1: 1, // epoch
    2: streamId("chatter"),
    3: seq,
    4: at,
    5: at + 60_000,
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
    const held = await captured(heldListenerItem, () => {
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

// ---- #138: through the production adapters, not the record holders under them (🌿 SF1 on
// #133). Each source comes from `createCanticleSource`, the way cli.ts builds it, on the
// daemon's own store, and the daemon reads it through `canticleViews`, the way cli.ts wires
// it; the counter sits on the records the real source holds. Pointing any adapter on the
// guide's path back at `hearView` reads them.

/** The source cli.ts builds for this config, on the daemon's store. */
const source =
  (config: Config) =>
  (store: EventStore): CanticleSource =>
    createCanticleSource(config.canticle!, {
      manifest: () => Manifest.fromJson(vectors.manifest),
      store,
      logger: new StructuredLogger(() => {}),
    });

/**
 * A canticle host daemon's record v1 side on a real unix socket (RFC-0001 §14.18.3): it
 * answers a connection's `join_snapshot` request with `hello`, `landing_state`, a complete
 * join snapshot of `snapshot`, then `live` as live records. Host only spells the fields.
 */
async function hostDaemon(
  path: string,
  snapshot: R[],
  live: Array<[type: string, fields: R]>,
) {
  const run = "a1b2";
  const line = (type: string, recSeq: number, extra: R) =>
    `${JSON.stringify({ v: RECORD_V, type, rec_seq: recSeq, run, ...extra })}\n`;
  const sockets = new Set<Socket>();
  const asked: string[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl === -1 || asked.length > 0) return;
      asked.push(buffer.slice(0, nl));
      const w = 2; // the landing_state is the baseline, and the snapshot's W
      socket.write(
        [
          line("hello", 1, { join_snapshot: true }),
          line("landing_state", w, { mute: null, breaker: "closed" }),
          ...snapshot.map((entry, i) =>
            line("snapshot", w, { snap_seq: i + 1, entry }),
          ),
          line("snapshot_end", w, {
            watermark: w,
            count: snapshot.length,
            truncated: false,
          }),
          ...live.map(([type, fields], i) => line(type, w + 1 + i, fields)),
        ].join(""),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    asked,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

test("adapters (#138): through the production host-daemon adapter (a RecordClient on a real host socket, read as cli.ts wires it), a guide call reads no payload; hear does", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-guide-"));
  const hostSocket = join(directory, "canticle.sock");
  const at = new Host({ now: () => Date.now() });
  const daemon = await hostDaemon(
    hostSocket,
    [
      at.fields(1, {
        text: "payload one",
        stateKey: "silas",
        extra: { purpose: "p" },
      }),
    ],
    [
      ["health", { last_datagram_at: Date.now(), reasons: [] }],
      [
        "presence",
        {
          station: { name: "ops", principal: null },
          key_id: OPS,
          state: "EQUIPPED_SPEAKING",
        },
      ],
      ["frame", at.fields(2, { stream: "ops.deploy", text: "payload two" })],
    ],
  );
  const config = canticleConfig(undefined, { hostSocket });
  const h = harness(config, { canticleSource: source(config) });
  try {
    const shim = h.attach("scribe");
    const onAir = () =>
      (h.canticle!.status() as { liveSet?: { size: number } }).liveSet?.size;
    const held = await captured(heldRecordItem, async () => {
      h.canticle!.start();
      await until(() => onAir() === 2, "both records on the live set");
    });
    assert.deepEqual(
      daemon.asked.map((l) => (JSON.parse(l) as { op: string }).op),
      ["join_snapshot"],
      "the real client asked for a join snapshot",
    );
    assert.equal(new Set(held).size, 2, "both records are held");
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
    ) as { streams: number; gaps?: string[] };
    assert.equal(view.streams, 2, "the guide still lists both");
    assert.equal(view.gaps, undefined, "a complete join, nothing held back");
    await h.call(shim, "hear", {});
    assert.ok(reads.includes("text"), "the control: hear reads the payload");
  } finally {
    h.dispose();
    await daemon.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A UDP port nothing on loopback holds right now. */
async function freePort(): Promise<number> {
  const probe = createSocket("udp4");
  await new Promise<void>((resolve) => probe.bind(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise<void>((resolve) => probe.close(resolve));
  return port;
}

test("adapters (#138): through the production embedded adapter (GuardedEmbedded on real loopback UDP, read as cli.ts wires it), a guide call reads no body; hear does", async () => {
  const port = await freePort();
  const config = canticleConfig(undefined, {
    source: "embedded",
    manifestPath: "unused",
    bindHost: "127.0.0.1",
    port,
    tune: { scribe: ["*:chatter"] },
  });
  const h = harness(config, { canticleSource: source(config) });
  const station = createSocket("udp4");
  try {
    const shim = h.attach("scribe");
    const status = () =>
      h.canticle!.status() as {
        source: string;
        state?: string;
        onAir?: number;
      };
    h.canticle!.start(); // probes the host socket first: nothing answers, so it binds
    await until(() => status().state === "listening", "the listener bound");
    assert.equal(status().source, "embedded");
    const issued = Date.now() - 1_000; // the real receptor's clock is the system's
    const held = await captured(heldListenerItem, async () => {
      station.send(signed(1, {}, issued), port, "127.0.0.1");
      // keyed: hear hashes its body
      station.send(signed(2, { 10: "silas" }, issued), port, "127.0.0.1");
      await until(() => status().onAir === 2, "both items on air");
    });
    assert.equal(new Set(held).size, 2, "both items are held");
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
    station.close();
    h.dispose();
  }
});

/** `true` when every `From` is a `To`: tsc decides it, so a check below is a compile check. */
type Is<From, To> = [From] extends [To] ? true : false;

test("types (#138): a hear view is no guide view, so an adapter pointed back at hearView fails tsc", () => {
  // Each line is checked by tsc, not here: it stops compiling once the left side is
  // assignable where the guide reads (node only strips the types and runs the assert).
  const checks: { [check: string]: false } = {
    "a LiveItem is no GuideItem": false satisfies Is<LiveItem, GuideItem>,
    "a HearView is no GuideSourceView": false satisfies Is<
      HearView,
      GuideSourceView
    >,
    // `{ ...source.hearView(ear), items }`: the hear view is still built, payload and all
    "a HearView with guide items is no GuideSourceView": false satisfies Is<
      Omit<HearView, "items"> & { items: GuideItem[] },
      GuideSourceView
    >,
    "a source's hearView is no guideView": false satisfies Is<
      CanticleSource["hearView"],
      CanticleSource["guideView"]
    >,
    "canticleViews' canticleHear is no daemon canticleGuide":
      false satisfies Is<
        ReturnType<typeof canticleViews>["canticleHear"],
        NonNullable<DaemonOptions["canticleGuide"]>
      >,
  };
  // The guide's own views still are guide views.
  const guide: { [check: string]: true } = {
    "canticleViews' canticleGuide is the daemon's": true satisfies Is<
      ReturnType<typeof canticleViews>["canticleGuide"],
      NonNullable<DaemonOptions["canticleGuide"]>
    >,
  };
  assert.ok(Object.values(checks).every((v) => v === false));
  assert.ok(Object.values(guide).every((v) => v === true));
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
