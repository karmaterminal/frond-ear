// `frond-ear house-export` (ews-concept-new's house card, frond-house §3.C.1): one JSON
// document an ear's house card renders from: a reader profile from the ear's own config,
// and a deck of stations and streams from the daemon's existing local interface (`status`
// and `canticle_guide`, as a CLI client), the manifest and the tune. Names and state words
// only: the test records carry a sentinel in every payload-bearing field, and the config,
// manifest and status carry Discord ids, key ids and public keys, and none may reach it.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  identityIn,
  revisionWord,
  runHouseExport,
} from "../src/canticle/house-cli.ts";
import { guideView } from "../src/canticle/guide.ts";
import type { GuideItem, GuideSourceView } from "../src/canticle/receptor.ts";
import { RECORD_V } from "../src/canticle/records.ts";
import { tunes } from "../src/canticle/tune.ts";
import type { CliRequest } from "../src/client.ts";
import { parseConfig } from "../src/config.ts";
import { advisory, ALPHA, Host, OPS, type R } from "./canticle-host.ts";
import {
  BOT,
  CHANNEL,
  harness,
  PEER_BOT,
  PRINCIPAL,
  ROOM,
  type Harness,
} from "./helpers.ts";

const SENTINEL = "sentinel-payload-7f3a";
const TUNE = ["*:ops.fleet", "*:ops.deploy", "quiet:whisper"];

/** Every key the export may carry, at any depth. Anything else is a leak. */
const ALLOWED_KEYS = new Set([
  "kind",
  "source",
  "ear",
  "at",
  "now_ms",
  "look",
  "reader",
  "payload_text",
  "may_read",
  "basis",
  "canticle",
  "hear",
  "push",
  "mode",
  "style",
  "muted",
  "stations",
  "station",
  "deck",
  "view",
  "listener",
  "connected",
  "window_start_ms",
  "manifest",
  "name",
  "presence",
  "verification",
  "in_manifest",
  "streams_known",
  "streams",
  "stream",
  "tuned",
  "admitted",
  "live",
  "newest_age_ms",
  "left_out",
  "walk",
  "gaps",
  "untuned_more",
  "untuned_listed",
  "truncated",
  "may_read_complete",
  "may_read_withheld",
  "scope",
  "config_patterns",
  "may_read_configured",
  "withheld",
  "field",
  "reason",
  "count",
]);

function keysOf(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysOf(item, out);
  else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      out.add(key);
      keysOf(item, out);
    }
  }
  return out;
}

function publicKeyHex(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32).toString("hex");
}

interface Setup {
  h: Harness;
  host: Host;
  dir: string;
  env: NodeJS.ProcessEnv;
  publicKeys: string[];
  request: (message: CliRequest) => Promise<{ ok: boolean; text: string }>;
  dispose: () => void;
}

/** A config file and a manifest on disk, a daemon serving them, and a host daemon feeding it. */
function setup(
  canticle: R = {},
  status: (host: Host, ear: string) => object = (host, ear) => ({
    source: "host-daemon",
    state: "connected",
    socket: `/run/${SENTINEL}/canticle.sock`,
    lastError: `payload ${SENTINEL}`,
    stations: Object.fromEntries(host.consumer.presence),
    // The tune the running source applies: fixed at its start (RecordClient's options).
    appliedTune: { [ear]: host.tune },
  }),
  opts: {
    ear?: string;
    tune?: string[];
    manifestStations?: Array<{ name: string; streams: string[] }>;
    pushStations?: Record<string, string>;
  } = {},
): Setup {
  const ear = opts.ear ?? "scribe";
  const tune = opts.tune ?? TUNE;
  const dir = mkdtempSync(join(tmpdir(), "frond-ear-house-"));
  const publicKeys = [publicKeyHex(), publicKeyHex(), publicKeyHex()];
  const manifestPath = join(dir, "fleet.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      stations: [
        {
          name: "ops",
          public_key: publicKeys[0],
          classes: ["advisory"],
          streams: ["ops.fleet", "ops.deploy"],
        },
        {
          name: "alpha",
          public_key: publicKeys[1],
          classes: ["advisory"],
          streams: ["chatter"],
        },
        {
          name: "quiet",
          public_key: publicKeys[2],
          classes: ["advisory"],
          streams: ["chatter"],
        },
        ...(opts.manifestStations ?? []).map((st) => ({
          ...st,
          public_key: publicKeyHex(),
          classes: ["advisory"],
        })),
      ],
    }),
  );
  const raw = {
    botUserId: BOT,
    principals: [PRINCIPAL],
    peerAgents: [PEER_BOT],
    labels: { [PRINCIPAL]: "figs" },
    ears: {
      [ear]: {
        target: "claude-channel",
        channels: { [CHANNEL]: { mode: "mentions" }, [ROOM]: { mode: "room" } },
      },
    },
    canticle: {
      enabled: true,
      source: "host-daemon",
      hostSocket: "/nonexistent/canticle.sock",
      manifestPath,
      tune: { [ear]: tune },
      wakeKeys: advisory([OPS, ALPHA]),
      delivery: {
        [ear]: {
          mode: "digest",
          stations: opts.pushStations ?? { ops: "immediate", [ALPHA]: "off" },
        },
      },
      ...canticle,
    },
  };
  const configPath = join(dir, "frond-ear.json");
  writeFileSync(configPath, JSON.stringify(raw));
  let host: Host | undefined;
  const h = harness(parseConfig(raw), {
    canticleGuide: () => host!.guideView(),
    canticleStatus: () => status(host!, ear),
  });
  host = new Host(h.clock, tune);
  host.start();
  const cli = h.attach(undefined, { role: "cli" });
  let id = 1_000;
  const request = async (message: CliRequest) => {
    const at = ++id;
    await cli.send({ ...message, id: at } as never);
    const result = cli.connection.results().find((r) => r.id === at);
    if (!result) throw new Error("no result");
    return { ok: result.ok, text: result.text };
  };
  return {
    h,
    host,
    dir,
    env: { FROND_EAR_CONFIG: configPath },
    publicKeys,
    request,
    dispose: () => {
      h.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface Stream {
  stream: string;
  tuned: boolean | null;
  admitted: boolean | null;
  live: number | null;
  newest_age_ms: number | null;
}
interface Station {
  name: string;
  presence: string | null;
  verification: string | null;
  in_manifest: boolean;
  streams_known: string;
  streams: Stream[];
}
interface Export {
  kind: string;
  source: string;
  ear: string;
  now_ms: number;
  reader: {
    reader: string;
    payload_text: boolean | null;
    may_read: string[];
    may_read_complete: boolean;
    may_read_withheld: number;
    basis: {
      canticle: string;
      scope: string;
      config_patterns: number;
      may_read_configured: string[];
      hear: string;
      push: {
        mode: string;
        style: string;
        muted: boolean;
        stations: Array<{ station: string; mode: string }>;
      };
    };
  };
  deck: {
    view: string;
    listener: string;
    connected: boolean;
    window_start_ms: null;
    manifest: string;
    stations: Station[];
    walk: string;
    gaps: Array<{ name: string; count: number }>;
    left_out: {
      untuned_more: number;
      untuned_listed: number;
      truncated: boolean;
    };
  };
  withheld: Array<{ field: string; reason: string; count: number }>;
}

async function run(
  s: Pick<Setup, "env" | "request">,
  argv: string[] = ["--ear", "scribe"],
  extra: { request?: Setup["request"]; revision?: string } = {},
): Promise<{ code: number; out: string; err: string; doc: Export }> {
  let out = "";
  let err = "";
  const code = await runHouseExport(argv, {
    stdout: { write: (text: string) => (out += text) },
    stderr: { write: (text: string) => (err += text) },
    env: s.env,
    request: extra.request ?? s.request,
    revision: () => extra.revision ?? "abc1234",
  });
  return {
    code,
    out,
    err,
    doc: (code === 0 ? JSON.parse(out) : null) as Export,
  };
}

const station = (doc: Export, name: string) => {
  const found = doc.deck.stations.find((s) => s.name === name);
  assert.ok(found, `station ${name} in the deck`);
  return found;
};

const loud = (o: R = {}) => ({
  text: SENTINEL,
  stateKey: SENTINEL,
  extra: { purpose: SENTINEL, body_ref: SENTINEL },
  ...o,
});

test("house-export: the reader profile is the ear's own config: its name, its tune as may_read, payload text by canticle", async () => {
  const s = setup();
  try {
    const { code, doc } = await run(s);
    assert.equal(code, 0);
    assert.equal(doc.kind, "frond-house-export/0");
    assert.equal(doc.source, "frond-ear abc1234 ear scribe");
    assert.doesNotMatch(doc.source, /SYNTHETIC/u);
    assert.equal(doc.reader.reader, "scribe");
    assert.deepEqual(doc.reader.may_read, TUNE);
    // hear shows tuned streams' payload text whatever delivery says; delivery only gates pushes.
    assert.equal(doc.reader.payload_text, true);
    assert.equal(doc.reader.basis.canticle, "enabled");
    assert.equal(doc.reader.basis.hear, "payload text of tuned streams");
    assert.equal(doc.reader.basis.push.mode, "digest");
    assert.equal(doc.reader.basis.push.style, "records");
    assert.equal(doc.reader.basis.push.muted, false);
    assert.deepEqual(doc.reader.basis.push.stations, [
      { station: "ops", mode: "immediate" },
    ]);
    assert.equal(doc.reader.may_read_complete, true);
    assert.equal(doc.reader.may_read_withheld, 0);
    assert.deepEqual(doc.withheld, [
      { field: "push.stations", reason: "key-id shape", count: 1 },
    ]);
  } finally {
    s.dispose();
  }
});

test("house-export: the deck holds tuned and untuned stations and streams, with presence words, from the daemon's guide and status", async () => {
  const s = setup();
  try {
    s.host.sing(1); // ops:ops.fleet, tuned by *:ops.fleet
    s.host.sing(
      2,
      loud({ station: "frond-scribe", stream: "scribe.lighthouse" }),
    ); // on air, untuned
    s.h.clock.advance(3_000);
    const { doc } = await run(s);
    assert.equal(doc.deck.view, "daemon");
    assert.equal(doc.deck.listener, "listening");
    assert.equal(doc.deck.connected, true);
    assert.equal(doc.deck.window_start_ms, null);
    assert.equal(doc.deck.manifest, "read");
    assert.deepEqual(
      doc.deck.stations.map((x) => x.name),
      ["alpha", "frond-scribe", "ops", "quiet"],
    );
    const ops = station(doc, "ops");
    assert.equal(ops.presence, "EQUIPPED_SPEAKING");
    assert.equal(ops.verification, "verified");
    assert.equal(ops.in_manifest, true);
    assert.equal(ops.streams_known, "complete");
    assert.deepEqual(ops.streams, [
      {
        stream: "ops.deploy",
        tuned: true,
        admitted: true,
        live: 0,
        newest_age_ms: null,
      },
      {
        stream: "ops.fleet",
        tuned: true,
        admitted: true,
        live: 1,
        newest_age_ms: 4_000, // the song is 1 s old when heard, then 3 s pass
      },
    ]);
    const scribe = station(doc, "frond-scribe");
    assert.equal(scribe.in_manifest, false);
    assert.equal(scribe.presence, null, "not in the host's presence table");
    assert.deepEqual(scribe.streams, [
      {
        stream: "scribe.lighthouse",
        tuned: false,
        admitted: null,
        live: 1,
        newest_age_ms: 4_000, // the song is 1 s old when heard, then 3 s pass
      },
    ]);
    const alpha = station(doc, "alpha");
    assert.equal(alpha.presence, "EQUIPPED_QUIET");
    assert.deepEqual(alpha.streams, [
      {
        stream: "chatter",
        tuned: false,
        admitted: true,
        live: 0,
        newest_age_ms: null,
      },
    ]);
    // A tune naming its station adds the stream even when nothing is on air and the
    // manifest doesn't list it: tuned, admission unknown.
    const quiet = station(doc, "quiet");
    assert.deepEqual(
      quiet.streams.map((x) => [x.stream, x.tuned, x.admitted]),
      [
        ["chatter", false, true],
        ["whisper", true, null],
      ],
    );
  } finally {
    s.dispose();
  }
});

test("house-export: every stream's tuned is tune.ts's answer for may_read", async () => {
  const s = setup();
  try {
    s.host.sing(1);
    s.host.sing(2, { station: "alpha", stream: "chatter" });
    s.host.sing(3, { station: "frond-scribe", stream: "ops.deploy" });
    const { doc } = await run(s);
    let checked = 0;
    for (const st of doc.deck.stations) {
      for (const x of st.streams) {
        assert.equal(
          x.tuned,
          tunes(doc.reader.may_read, st.name, x.stream),
          `${st.name}:${x.stream}`,
        );
        checked += 1;
      }
    }
    assert.ok(checked >= 6);
    assert.equal(
      station(doc, "frond-scribe").streams.find(
        (x) => x.stream === "ops.deploy",
      )?.tuned,
      true,
      "*:ops.deploy tunes it on any station",
    );
  } finally {
    s.dispose();
  }
});

test("house-export: no payload, content, key, public key, Discord id or path reaches the export", async () => {
  const s = setup();
  try {
    s.host.sing(1, loud());
    s.host.sing(2, loud({ station: "alpha", stream: "chatter" }));
    s.host.sing(
      3,
      loud({ station: "frond-scribe", stream: "scribe.lighthouse" }),
    );
    s.host.pluck(2, loud({ station: "alpha", stream: "chatter" }));
    const { code, out, doc } = await run(s);
    assert.equal(code, 0);
    assert.ok(!out.includes(SENTINEL), "no payload-bearing field");
    assert.doesNotMatch(out, /[0-9]{17,20}/u, "no Discord id");
    for (const key of [OPS, ALPHA, ...s.publicKeys]) {
      assert.ok(!out.toLowerCase().includes(key), `no key ${key.slice(0, 8)}…`);
    }
    assert.doesNotMatch(out, /[0-9a-f]{16}/u, "no key id at all");
    assert.ok(!out.includes(s.dir), "no path");
    const extra = [...keysOf(doc)].filter((key) => !ALLOWED_KEYS.has(key));
    assert.deepEqual(extra, [], "only the export's own fields");
  } finally {
    s.dispose();
  }
});

test("house-export: a station known only by key id is counted, never printed", async () => {
  const s = setup();
  try {
    s.host.presence("0f1e2d3c4b5a6978", "EQUIPPED_QUIET");
    s.host.sing(1, { station: "0f1e2d3c4b5a6978", stream: "ops.fleet" });
    const { doc, out } = await run(s);
    assert.ok(!out.includes("0f1e2d3c4b5a6978"));
    assert.deepEqual(
      doc.withheld.filter((w) => w.field === "deck.stations"),
      [{ field: "deck.stations", reason: "key-id shape", count: 1 }],
      "presence and a row of one key id are one station",
    );
  } finally {
    s.dispose();
  }
});

test("house-export: past the untuned list's cap, the rest is counted and every station's streams are partial", async () => {
  const s = setup();
  try {
    for (let i = 0; i < 55; i++) {
      s.host.sing(10 + i, { station: "frond-scribe", stream: `wide${i}` });
    }
    const { doc } = await run(s);
    assert.equal(doc.deck.left_out.untuned_more, 5);
    assert.ok(doc.deck.stations.every((x) => x.streams_known === "partial"));
  } finally {
    s.dispose();
  }
});

test("house-export: with the daemon not reached, the deck is config and manifest only and says so", async () => {
  const s = setup();
  try {
    const { code, err, doc } = await run(s, undefined, {
      request: () => Promise.reject(new Error("connect ENOENT")),
    });
    assert.equal(code, 0);
    assert.match(err, /daemon not reached/u);
    assert.equal(doc.deck.view, "config");
    assert.equal(doc.deck.listener, "not reached");
    assert.equal(doc.deck.connected, false);
    const ops = station(doc, "ops");
    assert.equal(ops.presence, null);
    assert.equal(ops.streams_known, "partial");
    assert.ok(ops.streams.every((x) => x.live === null));
    assert.deepEqual(
      doc.reader.may_read,
      [],
      "the file's tune proves nothing without the daemon (🌿 R6)",
    );
    assert.deepEqual(
      doc.reader.basis.may_read_configured,
      TUNE,
      "kept as configured intent",
    );
  } finally {
    s.dispose();
  }
});

test("house-export: --offline asks the daemon nothing", async () => {
  const s = setup();
  try {
    let asked = 0;
    const { code, doc } = await run(s, ["--ear", "scribe", "--offline"], {
      request: () => {
        asked += 1;
        return Promise.reject(new Error("asked"));
      },
    });
    assert.equal(code, 0);
    assert.equal(asked, 0);
    assert.equal(doc.deck.view, "config");
    assert.equal(doc.deck.listener, "not asked");
  } finally {
    s.dispose();
  }
});

test("house-export: canticle off: no payload text, nothing tuned", async () => {
  const s = setup({ enabled: false });
  try {
    const { code, doc } = await run(s, ["--ear", "scribe", "--offline"]);
    assert.equal(code, 0);
    assert.equal(doc.reader.payload_text, false);
    assert.deepEqual(doc.reader.may_read, []);
    assert.equal(doc.reader.basis.canticle, "disabled");
    assert.equal(doc.reader.basis.hear, "off");
    assert.equal(
      doc.deck.listener,
      "not asked",
      "offline: the daemon's own state is unknown",
    );
  } finally {
    s.dispose();
  }
});

test("house-export: --ear is required and must be configured", async () => {
  const s = setup();
  try {
    const none = await run(s, []);
    assert.equal(none.code, 1);
    assert.match(none.err, /--ear is required/u);
    const unknown = await run(s, ["--ear", "nobody"]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /unknown ear nobody/u);
    assert.equal(unknown.out, "");
  } finally {
    s.dispose();
  }
});

test("house-export: read-only: it writes nothing beside the config or manifest", async () => {
  const s = setup();
  try {
    const before = readdirSync(s.dir).sort();
    await run(s);
    await run(s, ["--ear", "scribe", "--offline"]);
    assert.deepEqual(readdirSync(s.dir).sort(), before);
  } finally {
    s.dispose();
  }
});

// 🌫 on #147: "no identities" held only for deck station keys. Every output string is
// checked: each field below carries a name-shaped identity that the config, manifest or
// host accepts as valid, and each is withheld, counted with a reason, never printed.
const DISCORD = "1122611838010535946";
const KEYISH = OPS; // a real fixture key id, and a valid stream name and tune station
test("house-export: identity-shaped names in every field are withheld, counted with a reason, never printed", async () => {
  const s = setup({}, undefined, {
    tune: [
      "*:ops.fleet",
      `${KEYISH}:ops.fleet`, // key id as a tune's station
      `ops:${KEYISH}`, // key id as a tune's stream
      `ops:s${PRINCIPAL}`, // a Discord id inside a stream name
    ],
    manifestStations: [
      { name: DISCORD, streams: ["chatter"] }, // a Discord id as a station name
      { name: "/home/figs/station", streams: ["chatter"] }, // a path
      { name: "beta", streams: [KEYISH, "chatter"] }, // a key id as a manifest stream
    ],
    pushStations: { ops: "immediate", [`s${DISCORD}`]: "off" },
  });
  try {
    s.host.presence(PRINCIPAL, "EQUIPPED_QUIET"); // a Discord id in the presence table
    s.host.sing(1, { station: "ops", stream: KEYISH }); // a tuned row on a key-id stream
    s.host.sing(2, { station: PEER_BOT, stream: "chatter" }); // an untuned row's station
    const { code, out, doc } = await run(s);
    assert.equal(code, 0);
    for (const value of [KEYISH, PRINCIPAL, PEER_BOT, DISCORD, "/home/figs"]) {
      assert.ok(!out.includes(value), `${value.slice(0, 6)}… withheld`);
    }
    assert.doesNotMatch(out, /[0-9]{17,20}/u);
    assert.doesNotMatch(out, /[0-9a-f]{16}/iu);
    // The scope lost patterns, so it says it's incomplete: a card can't read a miss as no.
    assert.deepEqual(doc.reader.may_read, ["*:ops.fleet"]);
    assert.equal(doc.reader.may_read_complete, false);
    // How many patterns the scope lost, for a reader to carry: a count, never the values.
    assert.equal(doc.reader.may_read_withheld, 3);
    assert.deepEqual(doc.withheld, [
      { field: "deck.stations", reason: "discord-id shape", count: 3 },
      { field: "deck.stations", reason: "path shape", count: 1 },
      { field: "deck.streams", reason: "key-id shape", count: 2 },
      { field: "push.stations", reason: "discord-id shape", count: 1 },
      { field: "reader.may_read", reason: "discord-id shape", count: 1 },
      { field: "reader.may_read", reason: "key-id shape", count: 2 },
    ]);
    // A withheld tune pattern is counted once, under the reader: it adds nothing to the deck.
    // A station that lost a stream says its list is partial.
    assert.equal(station(doc, "ops").streams_known, "partial");
    assert.equal(station(doc, "beta").streams_known, "partial");
    assert.deepEqual(
      station(doc, "beta").streams.map((x) => x.stream),
      ["chatter"],
    );
    assert.equal(station(doc, "alpha").streams_known, "complete");
  } finally {
    s.dispose();
  }
});

test("house-export: an identity-shaped ear name fails closed: exit 1, nothing printed, the reason without the value", async () => {
  for (const ear of [DISCORD, KEYISH]) {
    const s = setup({}, undefined, { ear });
    try {
      const { code, out, err } = await run(s, ["--ear", ear]);
      assert.equal(code, 1, ear);
      assert.equal(out, "");
      assert.match(err, /identity-shaped \((discord|key)-id shape\)/u);
      assert.ok(!err.includes(ear), "the value is not repeated");
    } finally {
      s.dispose();
    }
  }
});

test("house-export: the backstop finds any identity-shaped string or number anywhere, by place and reason, never by value", () => {
  assert.deepEqual(identityIn({ a: "ok", b: ["fine", 3] }), []);
  assert.deepEqual(
    identityIn({
      kind: "frond-house-export/0",
      a: [{ name: `x${DISCORD}` }],
      b: { c: KEYISH.toUpperCase() },
      d: "/etc/hosts",
      e: 12345678901234567890,
      f: "a\\b",
    }),
    [
      { at: "a[0].name", reason: "discord-id shape" },
      { at: "b.c", reason: "key-id shape" },
      { at: "d", reason: "path shape" },
      { at: "e", reason: "discord-id shape" },
      { at: "f", reason: "path shape" },
    ],
  );
});

test("house-export: a whole real export passes its own backstop", async () => {
  const s = setup();
  try {
    s.host.sing(1);
    const { doc } = await run(s);
    assert.deepEqual(identityIn(doc), []);
  } finally {
    s.dispose();
  }
});

test("house-export: the backstop refuses the whole export when an unchecked field holds an identity shape", async () => {
  const s = setup();
  try {
    // The revision is no name, so no name check sees it: only the last pass over the output can.
    const { code, out, err } = await run(s, undefined, {
      revision: "0123456789abcdef",
    });
    assert.equal(code, 1);
    assert.equal(out, "");
    assert.match(
      err,
      /refused: identity-shaped output at source \(key-id shape\)/u,
    );
    assert.ok(!err.includes("0123456789abcdef"));
  } finally {
    s.dispose();
  }
});

test("house-export: the backstop finds an identity-shaped key, and its place never repeats the key", () => {
  const found = identityIn({ a: { [DISCORD]: { b: "ok", c: KEYISH } } });
  assert.deepEqual(found, [
    { at: "a.<withheld key>", reason: "discord-id shape" },
    { at: "a.<withheld key>.c", reason: "key-id shape" },
  ]);
  assert.ok(!JSON.stringify(found).includes(DISCORD));
});

test("house-export: the source names a short revision only: a sha long enough to be a key id reads unknown", () => {
  assert.equal(revisionWord("f6b1324", ""), "f6b1324");
  assert.equal(revisionWord("f6b1324abcde", " M x"), "f6b1324abcde+dirty");
  assert.equal(revisionWord("0123456789abcdef", ""), "unknown");
  assert.equal(
    revisionWord("f6b13243e8ceef6207acf0f0bbc9e6a5631a7b14", ""),
    "unknown",
  );
  assert.equal(revisionWord("not a sha", ""), "unknown");
});

// 🌿 on #147 (F1): the export turned the guide's "unknown" into "complete". Every gap the
// guide says, every row-level omission or coverage hole, and every break in the walk now
// reaches the export as a closed name and a count, and makes streams partial; a board the
// guide says is held empty gives live unknown, never 0.

const T0 = 1_800_000_000_000;
const item = (o: Partial<GuideItem> = {}): GuideItem => ({
  station: "ops",
  key: OPS,
  stream: "ops.fleet",
  seq: "1",
  epoch: 1,
  class: "advisory",
  heardAt: T0 - 2_000,
  ageMs: 2_000,
  expiresInMs: 60_000,
  ...o,
});
const view = (o: Partial<GuideSourceView> = {}): GuideSourceView => ({
  now: T0,
  tuned: true,
  listening: true,
  blind: false,
  lastDatagramAt: T0,
  stations: [{ name: "ops", presence: "EQUIPPED_SPEAKING" }],
  items: [item()],
  untuned: [],
  ...o,
});

/** A daemon whose guide is the real guide.ts over `v`, paged as the daemon pages it. */
function guideDaemon(
  v: GuideSourceView,
  o: {
    mode?: "immediate" | "mute";
    status?: object;
    page?: (n: number, text: string) => { ok: boolean; text: string };
  } = {},
): Setup["request"] {
  let n = 0;
  return async (message) => {
    if (message.type === "status") {
      return {
        ok: true,
        text: JSON.stringify({
          canticle: o.status ?? {
            source: "host-daemon",
            stations: { ops: "EQUIPPED_SPEAKING" },
            appliedTune: { scribe: TUNE },
          },
        }),
      };
    }
    const args = (message as { args: Record<string, unknown> }).args;
    // A page an override replaces may carry a cursor the real guide refuses.
    let text = "";
    try {
      text = JSON.stringify(
        guideView(v, {
          ear: "scribe",
          limit: Number(args.limit ?? 20),
          cursor: args.cursor as string | undefined,
          mode: () => o.mode ?? "immediate",
        }),
      );
    } catch (error) {
      if (!o.page) throw error;
    }
    const page = n++;
    return o.page ? o.page(page, text) : { ok: true, text };
  };
}

const gapNames = (doc: Export) => doc.deck.gaps.map((g) => g.name);
const allPartial = (doc: Export) =>
  doc.deck.stations.every((st) => st.streams_known === "partial");

test("house-export coverage: a clean guide is complete, with no gaps", async () => {
  const s = setup();
  try {
    const { doc } = await run(s, undefined, { request: guideDaemon(view()) });
    assert.equal(doc.deck.walk, "complete");
    assert.deepEqual(doc.deck.gaps, []);
    assert.equal(station(doc, "ops").streams_known, "complete");
  } finally {
    s.dispose();
  }
});

test("house-export coverage: each gap the guide says becomes its closed name, and streams go partial", async () => {
  const cases: Array<[string, Partial<GuideSourceView>]> = [
    ["ended", { ended: true }],
    ["not_listening", { listening: false }],
    ["blind", { blind: true }],
    ["joined_late", { joinedLate: { snapshot: "truncated" } }],
    ["host_mute", { hostMute: { until: null, by: "ops" } }],
    ["records_lost", { recordsLost: true }],
    ["awaiting_landing", { awaitingLanding: true }],
    [
      "omitted_other_tuned",
      {
        otherOmitted: {
          station: "",
          stream: "",
          key: "",
          count: 3,
          from: T0 - 9_000,
          to: T0 - 1_000,
          until: T0 + 60_000,
          total: 3,
          pushable: 0,
          pushableTotal: 0,
          serial: 1,
        },
      },
    ],
    [
      "omitted_untuned",
      {
        untunedOmitted: {
          count: 2,
          from: T0 - 9_000,
          to: T0 - 1_000,
          until: T0 + 60_000,
        },
      },
    ],
    [
      "coverage_unknown",
      {
        retuned: [
          {
            pattern: "*:ops.fleet",
            at: T0 - 5_000,
            dropped: 4,
            until: T0 + 60_000,
          },
        ],
      },
    ],
  ];
  for (const [name, o] of cases) {
    const s = setup();
    try {
      const { code, doc } = await run(s, undefined, {
        request: guideDaemon(view(o)),
      });
      assert.equal(code, 0, name);
      assert.ok(
        gapNames(doc).includes(name),
        `${name}: ${JSON.stringify(doc.deck.gaps)}`,
      );
      assert.ok(allPartial(doc), `${name}: partial everywhere`);
    } finally {
      s.dispose();
    }
  }
});

test("house-export coverage: 🌿's repro: under the host's mute, or before landing, the board is held empty: live unknown, never complete, live 0", async () => {
  for (const o of [
    { hostMute: { until: null, by: "ops" } },
    { awaitingLanding: true as const },
  ]) {
    const s = setup();
    try {
      const { doc } = await run(s, undefined, {
        request: guideDaemon(view({ ...o, items: [] })),
      });
      for (const st of doc.deck.stations) {
        assert.equal(st.streams_known, "partial", st.name);
        for (const x of st.streams)
          assert.equal(x.live, null, `${st.name}:${x.stream}`);
      }
    } finally {
      s.dispose();
    }
  }
});

test("house-export coverage: through the real consumer: host mute, no landing yet, records lost", async () => {
  const muted = setup();
  try {
    muted.host.landing({ mute: { until: null, by: "ops" } });
    const { doc } = await run(muted);
    assert.ok(gapNames(doc).includes("host_mute"));
    assert.equal(
      station(doc, "ops").streams.find((x) => x.stream === "ops.fleet")?.live,
      null,
    );
  } finally {
    muted.dispose();
  }
  const lost = setup();
  try {
    lost.host.sing(1);
    // A record v1 sequence gap: the consumer loses records and clears its live set.
    lost.host.consumer.feed(
      {
        v: RECORD_V,
        type: "health",
        rec_seq: 999,
        run: lost.host.run,
        last_datagram_at: lost.h.clock.now(),
        reasons: [],
      },
      lost.h.clock.now(),
    );
    const { doc } = await run(lost);
    assert.ok(
      gapNames(doc).includes("records_lost"),
      JSON.stringify(doc.deck.gaps),
    );
    assert.ok(allPartial(doc));
  } finally {
    lost.dispose();
  }
  const fresh = setup();
  try {
    // A new connection that has had hello but no landing_state yet.
    fresh.host.consumer.feed(
      { v: RECORD_V, type: "hello", rec_seq: 1, run: "c3d4" },
      fresh.h.clock.now(),
    );
    const { doc } = await run(fresh);
    assert.ok(
      gapNames(doc).includes("awaiting_landing"),
      JSON.stringify(doc.deck.gaps),
    );
    assert.ok(
      doc.deck.stations.every((st) => st.streams.every((x) => x.live === null)),
    );
  } finally {
    fresh.dispose();
  }
});

test("house-export coverage: this ear muted is a push fact, not a coverage gap", async () => {
  const s = setup();
  try {
    const { doc } = await run(s, undefined, {
      request: guideDaemon(view(), { mode: "mute" }),
    });
    assert.deepEqual(doc.deck.gaps, [{ name: "ear_muted", count: 1 }]);
    assert.equal(station(doc, "ops").streams_known, "complete");
  } finally {
    s.dispose();
  }
});

test("house-export coverage: a row's local omissions or coverage hole makes its station partial", async () => {
  const s = setup();
  try {
    const { doc } = await run(s, undefined, {
      request: guideDaemon(
        view({
          omitted: [
            {
              station: "alpha",
              stream: "chatter",
              key: ALPHA,
              count: 2,
              from: T0 - 9_000,
              to: T0 - 1_000,
              until: T0 + 60_000,
              total: 2,
              pushable: 0,
              pushableTotal: 0,
              serial: 1,
            },
          ],
        }),
      ),
    });
    assert.ok(
      doc.deck.gaps.some(
        (g) => g.name === "row_local_omissions" && g.count === 1,
      ),
      JSON.stringify(doc.deck.gaps),
    );
    assert.equal(station(doc, "alpha").streams_known, "partial");
    // A row's hole is that station's: it says nothing about another station's streams.
    assert.equal(station(doc, "ops").streams_known, "complete");
    assert.equal(doc.deck.walk, "complete");
  } finally {
    s.dispose();
  }
});

test("house-export coverage: a broken walk is partial with a reason, never a clean end", async () => {
  const many = view({
    items: Array.from({ length: 150 }, (_, i) =>
      item({ stream: `s${String(i).padStart(3, "0")}`, seq: String(i) }),
    ),
  });
  const breaks: Array<
    [string, (n: number, text: string) => { ok: boolean; text: string }]
  > = [
    [
      "page_unparsed",
      (n, text) =>
        n === 1 ? { ok: true, text: "not json" } : { ok: true, text },
    ],
    [
      "page_unparsed",
      (n, text) => (n === 1 ? { ok: true, text: "[]" } : { ok: true, text }),
    ],
    [
      "page_refused",
      (n, text) => (n === 1 ? { ok: false, text: "busy" } : { ok: true, text }),
    ],
    [
      "page_unparsed",
      (n, text) =>
        n === 1
          ? { ok: true, text: '{"listener":"listening"}' }
          : { ok: true, text },
    ],
    [
      "row_count_mismatch",
      (n, text) => {
        if (n !== 1) return { ok: true, text };
        const v = JSON.parse(text) as Record<string, unknown>;
        return { ok: true, text: JSON.stringify({ ...v, streams: 151 }) };
      },
    ],
  ];
  for (const [name, page] of breaks) {
    const s = setup();
    try {
      const { code, doc } = await run(s, undefined, {
        request: guideDaemon(many, { page }),
      });
      assert.equal(code, 0);
      assert.equal(doc.deck.walk, "partial", name);
      assert.ok(gapNames(doc).includes(name), JSON.stringify(doc.deck.gaps));
      assert.ok(allPartial(doc));
    } finally {
      s.dispose();
    }
  }
});

test("house-export coverage: a guide whose rows don't add up to its own count, or repeat across pages, is partial; a repeat is never summed", async () => {
  const short = setup();
  try {
    const { doc } = await run(short, undefined, {
      request: guideDaemon(view(), {
        page: (_n, text) => {
          const v = JSON.parse(text) as Record<string, unknown>;
          return { ok: true, text: JSON.stringify({ ...v, streams: 3 }) };
        },
      }),
    });
    assert.ok(gapNames(doc).includes("row_count_mismatch"));
    assert.equal(doc.deck.walk, "partial");
  } finally {
    short.dispose();
  }
  const dup = setup();
  try {
    let first: Record<string, unknown> | undefined;
    const { doc } = await run(dup, undefined, {
      request: guideDaemon(
        view({
          items: [
            item({ seq: "1" }),
            item({ seq: "2" }),
            item({ seq: "3" }),
            item({ seq: "4" }),
          ],
        }),
        {
          page: (n, text) => {
            if (n === 0) {
              const v = JSON.parse(text) as Record<string, unknown>;
              first = v;
              return {
                ok: true,
                text: JSON.stringify({ ...v, streams: 2, nextCursor: "again" }),
              };
            }
            return { ok: true, text: JSON.stringify({ ...first, streams: 2 }) };
          },
        },
      ),
    });
    assert.ok(
      gapNames(doc).includes("duplicate_row"),
      JSON.stringify(doc.deck.gaps),
    );
    assert.equal(
      station(doc, "ops").streams.find((x) => x.stream === "ops.fleet")?.live,
      4,
      "4, not 8",
    );
    assert.equal(doc.deck.walk, "partial");
  } finally {
    dup.dispose();
  }
});

test("house-export coverage: an untuned list that is absent, or doesn't add up, is partial", async () => {
  for (const [name, o] of [
    ["untuned_unlisted", { untuned: undefined }],
  ] as const) {
    const s = setup();
    try {
      const v = view();
      delete (v as { untuned?: unknown }).untuned;
      void o;
      const { doc } = await run(s, undefined, { request: guideDaemon(v) });
      assert.ok(gapNames(doc).includes(name), JSON.stringify(doc.deck.gaps));
      assert.ok(allPartial(doc));
    } finally {
      s.dispose();
    }
  }
  const odd = setup();
  try {
    const { doc } = await run(odd, undefined, {
      request: guideDaemon(
        view({ untuned: [item({ station: "alpha", stream: "chatter" })] }),
        {
          page: (_n, text) => {
            const v = JSON.parse(text) as { untuned: Record<string, unknown> };
            return {
              ok: true,
              text: JSON.stringify({
                ...v,
                untuned: { ...v.untuned, streams: 9 },
              }),
            };
          },
        },
      ),
    });
    assert.ok(gapNames(doc).includes("untuned_count_mismatch"));
  } finally {
    odd.dispose();
  }
  const embedded = setup();
  try {
    const { doc } = await run(embedded, undefined, {
      request: guideDaemon(view(), {
        status: { state: "listening", stations: { ops: "EQUIPPED_SPEAKING" } },
      }),
    });
    // The embedded listener lists untuned only on streams some ear tunes.
    assert.ok(gapNames(doc).includes("untuned_partial_source"));
    assert.ok(allPartial(doc));
  } finally {
    embedded.dispose();
  }
});

test("house-export coverage: a gap line it doesn't know is a gap, not nothing", async () => {
  const s = setup();
  try {
    const { doc } = await run(s, undefined, {
      request: guideDaemon(view(), {
        page: (_n, text) => {
          const v = JSON.parse(text) as Record<string, unknown>;
          return {
            ok: true,
            text: JSON.stringify({ ...v, gaps: [`some new gap ${SENTINEL}`] }),
          };
        },
      }),
    });
    assert.deepEqual(doc.deck.gaps, [{ name: "unrecognized_gap", count: 1 }]);
    assert.ok(allPartial(doc));
    assert.ok(
      !JSON.stringify(doc).includes(SENTINEL),
      "gap prose never reaches the export",
    );
  } finally {
    s.dispose();
  }
});

// 🌿 F4: state words come from fixed lists; anything else is unknown, and counted.
test("house-export: a presence, verification or listener word outside the closed lists is unknown, and counted", async () => {
  const s = setup();
  try {
    const { doc, out } = await run(s, undefined, {
      request: guideDaemon(view(), {
        status: {
          source: "host-daemon",
          stations: { ops: "Free Text Here", alpha: "EQUIPPED_QUIET" },
        },
        page: (_n, text) => {
          const v = JSON.parse(text) as {
            rows: Array<Record<string, unknown>>;
          };
          return {
            ok: true,
            text: JSON.stringify({
              ...v,
              listener: "Listening Kind Of",
              rows: v.rows.map((r) => ({ ...r, verification: "Trust Me" })),
            }),
          };
        },
      }),
    });
    assert.ok(
      !out.includes("Free Text") &&
        !out.includes("Trust Me") &&
        !out.includes("Kind Of"),
    );
    assert.equal(station(doc, "ops").presence, "unknown");
    assert.equal(station(doc, "ops").verification, null);
    assert.equal(station(doc, "alpha").presence, "EQUIPPED_QUIET");
    assert.equal(doc.deck.listener, "unknown");
    assert.ok(
      doc.deck.gaps.some(
        (g) => g.name === "unrecognized_word" && g.count === 3,
      ),
      JSON.stringify(doc.deck.gaps),
    );
  } finally {
    s.dispose();
  }
});

// 🌿 F2: token-shaped names are withheld too, and the look says what is checked.
test("house-export: token-shaped, UUID and separator-split id names are withheld", async () => {
  const names = [
    `ghp_${"a1B2c3D4e5F6g7H8i9J0".repeat(2)}`,
    "AKIAIOSFODNN7EXAMPLE",
    "AbCdEfGh12345678IjKlMnOp",
    "550e8400-e29b-41d4-a716-446655440000",
    "1122611838-010535946",
    "f6eecf2f.43082a97",
    "xoxb-1234-abcd",
  ];
  const s = setup({}, undefined, {
    manifestStations: names.map((name) => ({ name, streams: ["chatter"] })),
    tune: ["*:ops.fleet", "ops:sk-abcdef0123456789abcd"],
  });
  try {
    const { code, out, doc } = await run(s, ["--ear", "scribe", "--offline"]);
    assert.equal(code, 0);
    for (const name of [...names, "sk-abcdef0123456789abcd"]) {
      assert.ok(!out.includes(name), name.slice(0, 6));
    }
    const count = (field: string) =>
      doc.withheld
        .filter((w) => w.field === field)
        .reduce((n, w) => n + w.count, 0);
    assert.equal(count("deck.stations"), names.length);
    assert.equal(count("reader.may_read"), 1);
    assert.ok(doc.withheld.some((w) => w.reason === "token shape"));
    assert.match(JSON.parse(out).look as string, /token-shaped/u);
  } finally {
    s.dispose();
  }
});

// 🌿 F3: error paths repeat no socket path, daemon reply or config value.
test("house-export: error lines name what failed, never a path, a daemon reply or a config value", async () => {
  const s = setup();
  try {
    const gone = Object.assign(
      new Error(`connect ENOENT /run/user/1000/${SENTINEL}/daemon.sock`),
      { code: "ENOENT" },
    );
    const a = await run(s, undefined, { request: () => Promise.reject(gone) });
    assert.match(a.err, /daemon not reached \(ENOENT\)/u);
    assert.ok(!a.err.includes(SENTINEL) && !a.err.includes("/run/"));
    const b = await run(s, undefined, {
      request: async (m) =>
        m.type === "status"
          ? { ok: true, text: `{"canticle": ${SENTINEL}` }
          : { ok: true, text: "{}" },
    });
    assert.match(b.err, /daemon not reached/u);
    assert.ok(!b.err.includes(SENTINEL), b.err);
  } finally {
    s.dispose();
  }
  // A config the parser refuses, whose bad value carries the sentinel.
  const dir = mkdtempSync(join(tmpdir(), "frond-ear-house-bad-"));
  try {
    const configPath = join(dir, "frond-ear.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        botUserId: BOT,
        ears: { scribe: { target: "claude-channel" } },
        canticle: {
          enabled: true,
          manifestPath: join(dir, "m.json"),
          tune: { scribe: [`BAD:${SENTINEL}`] },
        },
      }),
    );
    const c = await run({
      env: { FROND_EAR_CONFIG: configPath },
      request: () => Promise.reject(new Error("unused")),
    });
    assert.equal(c.code, 1);
    assert.match(c.err, /the config could not be read or parsed/u);
    assert.ok(!c.err.includes(SENTINEL) && !c.err.includes(dir), c.err);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("house-export coverage: a row's coverage hole alone makes its own station partial", async () => {
  const s = setup();
  try {
    const { doc } = await run(s, undefined, {
      request: guideDaemon(
        view({
          items: [item(), item({ station: "alpha", stream: "chatter" })],
        }),
        {
          page: (_n, text) => {
            const v = JSON.parse(text) as {
              rows: Array<Record<string, unknown>>;
            };
            const rows = v.rows.map((r) =>
              r.station === "alpha"
                ? {
                    ...r,
                    coverageUnknown: {
                      tunedAt: "2026-11-28T00:00:00Z",
                      dropped: 1,
                      until: "2026-11-28T01:00:00Z",
                    },
                  }
                : r,
            );
            return { ok: true, text: JSON.stringify({ ...v, rows }) };
          },
        },
      ),
    });
    assert.deepEqual(doc.deck.gaps, [
      { name: "row_coverage_unknown", count: 1 },
    ]);
    assert.equal(station(doc, "alpha").streams_known, "partial");
    assert.equal(station(doc, "ops").streams_known, "complete");
  } finally {
    s.dispose();
  }
});

test("house-export coverage: a guide longer than the pages it reads is truncated and partial", async () => {
  const s = setup();
  try {
    const { doc } = await run(s, undefined, {
      request: guideDaemon(
        view({
          items: Array.from({ length: 2_050 }, (_, i) =>
            item({ stream: `s${String(i).padStart(4, "0")}`, seq: String(i) }),
          ),
        }),
      ),
    });
    assert.equal(doc.deck.left_out.truncated, true);
    assert.equal(doc.deck.walk, "partial");
    assert.ok(allPartial(doc));
  } finally {
    s.dispose();
  }
});

test("house-export: 17 digits in a row is already a Discord id's shape", () => {
  assert.deepEqual(identityIn({ a: "x12345678901234567" }), [
    { at: "a", reason: "discord-id shape" },
  ]);
});

// 🌫 at f22fae03: gap lines were read only from page 1. A clean first page, then a
// degraded second: every page's gaps count, and a walk whose pages disagree is partial.
test("house-export coverage: 🌫's repro: a gap that appears on page 2 reaches the export, and the walk is partial", async () => {
  const s = setup();
  try {
    for (let i = 0; i < 150; i++) {
      s.host.sing(10 + i, { station: `st${String(i).padStart(3, "0")}` });
    }
    let pages = 0;
    const { doc } = await run(s, undefined, {
      request: async (message) => {
        if (message.type === "call" && pages++ === 1) {
          // Receive goes blind between page 1 and page 2.
          s.host.health(["no_datagrams"]);
        }
        return s.request(message);
      },
    });
    assert.equal(pages, 2);
    assert.ok(gapNames(doc).includes("blind"), JSON.stringify(doc.deck.gaps));
    assert.ok(gapNames(doc).includes("changed_mid_walk"));
    assert.equal(doc.deck.walk, "partial");
    assert.ok(allPartial(doc));
  } finally {
    s.dispose();
  }
});

test("house-export coverage: the same gap on every page is counted once per name, not once per page", async () => {
  const s = setup();
  try {
    const { doc } = await run(s, undefined, {
      request: guideDaemon(
        view({
          blind: true,
          items: Array.from({ length: 150 }, (_, i) =>
            item({ stream: `s${String(i).padStart(3, "0")}`, seq: String(i) }),
          ),
        }),
      ),
    });
    assert.deepEqual(doc.deck.gaps, [{ name: "blind", count: 1 }]);
    assert.equal(doc.deck.walk, "complete", "the pages agree");
  } finally {
    s.dispose();
  }
});

test("house-export coverage: a listener word or untuned list that changes between pages is a walk that changed under it", async () => {
  const many = view({
    items: Array.from({ length: 150 }, (_, i) =>
      item({ stream: `s${String(i).padStart(3, "0")}`, seq: String(i) }),
    ),
  });
  const edits: Array<
    [string, (v: Record<string, unknown>) => Record<string, unknown>]
  > = [
    ["listener", (v) => ({ ...v, listener: "blind" })],
    [
      "untuned",
      (v) => ({
        ...v,
        untuned: {
          streams: 1,
          rows: [{ station: "alpha", stream: "chatter", live: 1 }],
        },
      }),
    ],
    [
      "untuned gone",
      (v) => {
        const { untuned: _gone, ...rest } = v;
        void _gone;
        return rest;
      },
    ],
  ];
  for (const [what, edit] of edits) {
    const s = setup();
    try {
      const { doc } = await run(s, undefined, {
        request: guideDaemon(many, {
          page: (n, text) =>
            n === 1
              ? {
                  ok: true,
                  text: JSON.stringify(
                    edit(JSON.parse(text) as Record<string, unknown>),
                  ),
                }
              : { ok: true, text },
        }),
      });
      assert.ok(
        gapNames(doc).includes("changed_mid_walk"),
        `${what}: ${JSON.stringify(doc.deck.gaps)}`,
      );
      assert.equal(doc.deck.walk, "partial", what);
      assert.ok(allPartial(doc), what);
    } finally {
      s.dispose();
    }
  }
});

test("house-export coverage: a later page's listening never hides an earlier page's blind", async () => {
  const s = setup();
  try {
    const { doc } = await run(s, undefined, {
      request: guideDaemon(
        view({
          items: Array.from({ length: 150 }, (_, i) =>
            item({ stream: `s${String(i).padStart(3, "0")}`, seq: String(i) }),
          ),
        }),
        {
          page: (n, text) =>
            n === 0
              ? {
                  ok: true,
                  text: JSON.stringify({
                    ...(JSON.parse(text) as object),
                    listener: "blind",
                  }),
                }
              : { ok: true, text },
        },
      ),
    });
    assert.equal(doc.deck.listener, "blind");
    assert.equal(doc.deck.connected, false);
    assert.ok(gapNames(doc).includes("changed_mid_walk"));
  } finally {
    s.dispose();
  }
});

// 🌿 round 2 on #147 (his helper's repros): the untuned list counts from every page, and
// what the walk didn't reach, or can't vouch for, is unknown rather than 0.
const manyItems = () =>
  Array.from({ length: 150 }, (_, i) =>
    item({ stream: `s${String(i).padStart(3, "0")}`, seq: String(i) }),
  );

test("house-export coverage: 🌿's repro: page 2's untuned list reporting 43 more is kept, and the deck is partial", async () => {
  const s = setup();
  try {
    const { doc } = await run(s, undefined, {
      request: guideDaemon(view({ items: manyItems() }), {
        page: (n, text) => {
          if (n !== 1) return { ok: true, text };
          const v = JSON.parse(text) as Record<string, unknown>;
          return {
            ok: true,
            text: JSON.stringify({
              ...v,
              untuned: {
                streams: 44,
                rows: [
                  {
                    station: "alpha",
                    stream: "chatter",
                    tuned: false,
                    classes: ["advisory"],
                    live: 1,
                    newestAgeS: 3,
                    verification: "verified",
                  },
                ],
                more: 43,
              },
            }),
          };
        },
      }),
    });
    assert.equal(doc.deck.left_out.untuned_more, 43);
    assert.equal(doc.deck.walk, "partial");
    assert.ok(allPartial(doc));
    // The row page 2 listed is kept too.
    assert.equal(
      station(doc, "alpha").streams.find((x) => x.stream === "chatter")?.live,
      1,
    );
  } finally {
    s.dispose();
  }
});

test("house-export coverage: a stream no row reached reads live unknown when the deck can't vouch for it", async () => {
  const s = setup();
  try {
    const { doc } = await run(s, undefined, {
      request: guideDaemon(view({ items: manyItems() }), {
        page: (n, text) =>
          n === 1 ? { ok: true, text: "not json" } : { ok: true, text },
      }),
    });
    assert.equal(doc.deck.walk, "partial");
    assert.equal(
      station(doc, "alpha").streams.find((x) => x.stream === "chatter")?.live,
      null,
      "never reached: unknown, not 0",
    );
    assert.equal(
      station(doc, "ops").streams.find((x) => x.stream === "s000")?.live,
      1,
      "a row it read keeps its count",
    );
  } finally {
    s.dispose();
  }
  const clean = setup();
  try {
    const { doc } = await run(clean, undefined, {
      request: guideDaemon(view()),
    });
    assert.equal(
      station(doc, "alpha").streams.find((x) => x.stream === "chatter")?.live,
      0,
      "a whole walk vouches for nothing on air",
    );
  } finally {
    clean.dispose();
  }
});

test("house-export coverage: a row it can't read is counted and breaks the walk, never vanishes", async () => {
  const bad: Array<
    [string, (r: Record<string, unknown>) => Record<string, unknown>]
  > = [
    ["station not a string", (r) => ({ ...r, station: 7 })],
    ["stream not a string", (r) => ({ ...r, stream: null })],
    ["localOmissions not an object", (r) => ({ ...r, localOmissions: 3 })],
    [
      "coverageUnknown not an object",
      (r) => ({ ...r, coverageUnknown: "yes" }),
    ],
  ];
  for (const [what, edit] of bad) {
    const s = setup();
    try {
      const { doc } = await run(s, undefined, {
        request: guideDaemon(view(), {
          page: (_n, text) => {
            const v = JSON.parse(text) as {
              rows: Array<Record<string, unknown>>;
            };
            return {
              ok: true,
              text: JSON.stringify({ ...v, rows: v.rows.map(edit) }),
            };
          },
        }),
      });
      assert.ok(
        gapNames(doc).includes("row_unparsed"),
        `${what}: ${JSON.stringify(doc.deck.gaps)}`,
      );
      assert.equal(doc.deck.walk, "partial", what);
      assert.ok(allPartial(doc), what);
    } finally {
      s.dispose();
    }
  }
});

test("house-export coverage: under a gap line it doesn't know, counts are unknown, never shown as measured", async () => {
  const s = setup();
  try {
    const { doc } = await run(s, undefined, {
      request: guideDaemon(view(), {
        page: (_n, text) => {
          const v = JSON.parse(text) as Record<string, unknown>;
          return {
            ok: true,
            text: JSON.stringify({ ...v, gaps: ["a gap from a newer guide"] }),
          };
        },
      }),
    });
    assert.ok(
      doc.deck.stations.every((st) => st.streams.every((x) => x.live === null)),
    );
  } finally {
    s.dispose();
  }
});

test("house-export coverage: an untuned row every page repeats is counted once", async () => {
  const s = setup();
  try {
    const { doc } = await run(s, undefined, {
      request: guideDaemon(
        view({
          items: manyItems(),
          untuned: [item({ station: "alpha", stream: "chatter" })],
        }),
      ),
    });
    assert.equal(
      station(doc, "alpha").streams.find((x) => x.stream === "chatter")?.live,
      1,
      "1, not 2",
    );
    assert.equal(doc.deck.walk, "complete");
  } finally {
    s.dispose();
  }
});

test("house-export coverage: an unreadable row alone breaks the walk: it still counts toward the guide's total", async () => {
  const s = setup();
  try {
    const { doc } = await run(s, undefined, {
      request: guideDaemon(view(), {
        page: (_n, text) => {
          const v = JSON.parse(text) as {
            rows: Array<Record<string, unknown>>;
          };
          return {
            ok: true,
            text: JSON.stringify({
              ...v,
              rows: v.rows.map((r) => ({ ...r, stream: 9 })),
            }),
          };
        },
      }),
    });
    assert.deepEqual(doc.deck.gaps, [{ name: "row_unparsed", count: 1 }]);
    assert.equal(doc.deck.walk, "partial");
  } finally {
    s.dispose();
  }
});

// 🌫 (07:17Z): a whole walk can sit beside a capped untuned list. The export says how many
// untuned streams it listed and how many it left out, apart from the walk.
test("house-export coverage: 🌫's case: 60 untuned streams: 50 listed, 10 left out, and the walk keeps its own word", async () => {
  const s = setup();
  try {
    for (let i = 0; i < 60; i++) {
      s.host.sing(10 + i, {
        station: "frond-scribe",
        stream: `wide${String(i).padStart(2, "0")}`,
      });
    }
    const { doc } = await run(s);
    assert.equal(doc.deck.left_out.untuned_listed, 50);
    assert.equal(doc.deck.left_out.untuned_more, 10);
    assert.equal(doc.deck.walk, "complete");
    assert.ok(
      allPartial(doc),
      "streams can't be complete while untuned ones are left out",
    );
  } finally {
    s.dispose();
  }
});

// 🌫 at 7fe187da: the change check compared untuned counts, not which streams. Swapping
// one untuned stream for another between pages kept the counts and passed as complete.
test("house-export coverage: 🌫's swap: page 2's untuned list names a different stream, same count: changed_mid_walk", async () => {
  const s = setup();
  try {
    for (let i = 0; i < 150; i++) {
      s.host.sing(10 + i, { station: `st${String(i).padStart(3, "0")}` });
    }
    s.host.sing(500, { station: "alpha", stream: "privatea" });
    let pages = 0;
    const { doc } = await run(s, undefined, {
      request: async (message) => {
        if (message.type === "call" && pages++ === 1) {
          s.host.pluck(500, { station: "alpha", stream: "privatea" });
          s.host.sing(501, { station: "alpha", stream: "privateb" });
        }
        return s.request(message);
      },
    });
    assert.equal(pages, 2);
    assert.ok(
      gapNames(doc).includes("changed_mid_walk"),
      JSON.stringify(doc.deck.gaps),
    );
    assert.equal(doc.deck.walk, "partial");
    assert.ok(allPartial(doc));
  } finally {
    s.dispose();
  }
});

test("house-export coverage: control: the same untuned stream on every page is no change", async () => {
  const s = setup();
  try {
    for (let i = 0; i < 150; i++) {
      s.host.sing(10 + i, { station: `st${String(i).padStart(3, "0")}` });
    }
    s.host.sing(500, { station: "alpha", stream: "privatea" });
    const { doc } = await run(s);
    assert.ok(
      !gapNames(doc).includes("changed_mid_walk"),
      JSON.stringify(doc.deck.gaps),
    );
    assert.equal(doc.deck.walk, "complete");
    assert.equal(doc.deck.left_out.untuned_listed, 1);
  } finally {
    s.dispose();
  }
});

// The same rule for the tuned rows and the presence table: compared by identity. A tuned
// row that leaves after it was read while another arrives behind the cursor keeps every
// count, so the walk re-reads its first page and the presence table at the end.
test("house-export coverage: a tuned row swapped behind the cursor, same total: the re-read first page catches it", async () => {
  const s = setup();
  try {
    for (let i = 0; i < 150; i++) {
      s.host.sing(10 + i, { station: `st${String(i).padStart(3, "0")}` });
    }
    let pages = 0;
    const { doc } = await run(s, undefined, {
      request: async (message) => {
        if (message.type === "call" && pages++ === 1) {
          s.host.pluck(10, { station: "st000" }); // read on page 1, now gone
          s.host.sing(900, { station: "aaa" }); // sorts before the cursor: page 2 can't see it
        }
        return s.request(message);
      },
    });
    assert.ok(
      gapNames(doc).includes("changed_mid_walk"),
      JSON.stringify(doc.deck.gaps),
    );
    assert.equal(doc.deck.walk, "partial");
  } finally {
    s.dispose();
  }
});

test("house-export coverage: a station that joins the presence table during the walk is a changed walk", async () => {
  const s = setup();
  try {
    let pages = 0;
    const { doc } = await run(s, undefined, {
      request: async (message) => {
        if (message.type === "call" && pages++ === 0) {
          s.host.presence("newcomer", "EQUIPPED_QUIET");
        }
        return s.request(message);
      },
    });
    assert.ok(
      gapNames(doc).includes("changed_mid_walk"),
      JSON.stringify(doc.deck.gaps),
    );
  } finally {
    s.dispose();
  }
});

test("house-export coverage: 🌿's repro: a presence word that flips between the two status reads is unknown, named presence_changed", async () => {
  const s = setup();
  try {
    let pages = 0;
    const { doc } = await run(s, undefined, {
      request: async (message) => {
        if (message.type === "call" && pages++ === 0) {
          s.host.presence("ops", "UNOBSERVABLE");
        }
        return s.request(message);
      },
    });
    assert.equal(
      station(doc, "ops").presence,
      "unknown",
      "never the first word alone",
    );
    assert.ok(
      gapNames(doc).includes("presence_changed"),
      JSON.stringify(doc.deck.gaps),
    );
    assert.equal(station(doc, "ops").streams_known, "partial");
    // A word is a reading in time: the walk itself didn't change.
    assert.ok(!gapNames(doc).includes("changed_mid_walk"));
    assert.equal(station(doc, "alpha").presence, "EQUIPPED_QUIET");
    assert.equal(
      station(doc, "alpha").streams_known,
      "complete",
      "only the flipped station",
    );
  } finally {
    s.dispose();
  }
});

test("house-export coverage: a re-walk page it can't read is a broken walk like any other, never a pass", async () => {
  const s = setup();
  try {
    const { doc } = await run(s, undefined, {
      request: guideDaemon(view({ items: manyItems() }), {
        page: (n, text) =>
          n === 2 ? { ok: true, text: "not json" } : { ok: true, text },
      }),
    });
    // Re-walk replies are pages like any other (🌫 at 5c7ffc65).
    assert.ok(
      gapNames(doc).includes("page_unparsed"),
      JSON.stringify(doc.deck.gaps),
    );
    assert.equal(doc.deck.walk, "partial");
  } finally {
    s.dispose();
  }
});

test("house-export coverage: one station leaving the presence table as another joins keeps the count, and is still a change", async () => {
  const s = setup();
  try {
    const guide = guideDaemon(view());
    let statuses = 0;
    const { doc } = await run(s, undefined, {
      request: async (message) => {
        if (message.type !== "status") return guide(message);
        const stations =
          statuses++ === 0
            ? { ops: "EQUIPPED_SPEAKING", alpha: "EQUIPPED_QUIET" }
            : { ops: "EQUIPPED_SPEAKING", beta: "EQUIPPED_QUIET" };
        return {
          ok: true,
          text: JSON.stringify({
            canticle: { source: "host-daemon", stations },
          }),
        };
      },
    });
    assert.ok(
      gapNames(doc).includes("changed_mid_walk"),
      JSON.stringify(doc.deck.gaps),
    );
  } finally {
    s.dispose();
  }
});

// 🌿 round 3 on #147 (his helper's repros).
test("house-export coverage: 🌿's repro: a tuned row swapped on a middle page, total unchanged: the whole walk is compared again", async () => {
  const s = setup();
  try {
    for (let i = 0; i < 250; i++) {
      s.host.sing(10 + i, { station: `st${String(i).padStart(3, "0")}` });
    }
    let pages = 0;
    const { doc } = await run(s, undefined, {
      request: async (message) => {
        if (message.type === "call" && pages++ === 2) {
          s.host.retract(130, "expired", { station: "st120" }); // read on page 2, now gone
          s.host.sing(900, { station: "st1205" }); // between page 1's end and the cursor
        }
        return s.request(message);
      },
    });
    assert.ok(
      gapNames(doc).includes("changed_mid_walk"),
      JSON.stringify(doc.deck.gaps),
    );
    assert.equal(doc.deck.walk, "partial");
  } finally {
    s.dispose();
  }
});

test("house-export coverage: a row out of the guide's order is an inconsistent walk (order_violation)", async () => {
  const s = setup();
  try {
    const { doc } = await run(s, undefined, {
      request: guideDaemon(view({ items: manyItems() }), {
        page: (n, text) => {
          if (n % 2 !== 1) return { ok: true, text }; // the same on the re-walk
          const v = JSON.parse(text) as {
            rows: Array<Record<string, unknown>>;
          };
          // page 2's first row now sorts before page 1's last
          const rows = [{ ...v.rows[0], stream: "s050x" }, ...v.rows.slice(1)];
          return { ok: true, text: JSON.stringify({ ...v, rows }) };
        },
      }),
    });
    // The re-walk sees the same pages, so the order break stands alone.
    assert.deepEqual(doc.deck.gaps, [{ name: "order_violation", count: 1 }]);
    assert.equal(doc.deck.walk, "partial");
  } finally {
    s.dispose();
  }
});

test("house-export coverage: 🌿's repro: the guide's presence word and the status table disagree: unknown, with a named gap", async () => {
  const s = setup();
  try {
    s.host.sing(1);
    let calls = 0;
    const { doc } = await run(s, undefined, {
      request: async (message) => {
        // After the status read, before the guide: ops goes unobservable.
        if (message.type === "call" && calls++ === 0)
          s.host.presence("ops", "UNOBSERVABLE");
        return s.request(message);
      },
    });
    assert.equal(station(doc, "ops").presence, "unknown");
    assert.ok(
      gapNames(doc).includes("presence_disagrees"),
      JSON.stringify(doc.deck.gaps),
    );
    assert.equal(station(doc, "ops").streams_known, "partial");
    assert.equal(
      station(doc, "alpha").presence,
      "EQUIPPED_QUIET",
      "a station both agree on keeps its word",
    );
  } finally {
    s.dispose();
  }
});

test("house-export coverage: a row whose live or age isn't a count exports unknown, never a vouched 0", async () => {
  const edits: Array<(r: Record<string, unknown>) => Record<string, unknown>> =
    [
      (r) => ({ ...r, live: null }),
      (r) => ({ ...r, live: "4" }),
      (r) => ({ ...r, live: -1 }),
      (r) => ({ ...r, newestAgeS: "2" }),
    ];
  for (const edit of edits) {
    const s = setup();
    try {
      const { doc } = await run(s, undefined, {
        request: guideDaemon(view(), {
          page: (_n, text) => {
            const v = JSON.parse(text) as {
              rows: Array<Record<string, unknown>>;
            };
            return {
              ok: true,
              text: JSON.stringify({ ...v, rows: v.rows.map(edit) }),
            };
          },
        }),
      });
      const x = station(doc, "ops").streams.find(
        (y) => y.stream === "ops.fleet",
      );
      assert.equal(x?.live, null, JSON.stringify(x));
      assert.equal(x?.newest_age_ms, null);
      assert.ok(
        gapNames(doc).includes("row_unparsed"),
        JSON.stringify(doc.deck.gaps),
      );
      assert.equal(station(doc, "ops").streams_known, "partial");
    } finally {
      s.dispose();
    }
  }
});

// 🌫 at 5c7ffc65: the validation re-walk kept only its tuned names and threw away the
// rest of what it saw. Its replies are pages like any other now.
test("house-export coverage: 🌫's repro: receive goes blind before the re-walk; its gap and its listener word count", async () => {
  const s = setup();
  try {
    for (let i = 0; i < 150; i++) {
      s.host.sing(10 + i, { station: `st${String(i).padStart(3, "0")}` });
    }
    let calls = 0;
    const { doc } = await run(s, undefined, {
      request: async (message) => {
        // Pages 1 and 2 are clean; the re-walk's first call comes third.
        if (message.type === "call" && calls++ === 2)
          s.host.health(["no_datagrams"]);
        return s.request(message);
      },
    });
    assert.equal(calls, 4, "two pages, then a two-page re-walk");
    assert.ok(gapNames(doc).includes("blind"), JSON.stringify(doc.deck.gaps));
    assert.equal(doc.deck.listener, "blind");
    assert.equal(doc.deck.connected, false);
    assert.equal(doc.deck.walk, "partial");
    assert.ok(allPartial(doc));
  } finally {
    s.dispose();
  }
});

test("house-export coverage: 🌫's helper repro: an untuned swap during the re-walk is a changed walk", async () => {
  const s = setup();
  try {
    for (let i = 0; i < 150; i++) {
      s.host.sing(10 + i, { station: `st${String(i).padStart(3, "0")}` });
    }
    s.host.sing(500, { station: "alpha", stream: "privatea" });
    let calls = 0;
    const { doc } = await run(s, undefined, {
      request: async (message) => {
        if (message.type === "call" && calls++ === 3) {
          s.host.pluck(500, { station: "alpha", stream: "privatea" });
          s.host.sing(501, { station: "alpha", stream: "privateb" });
        }
        return s.request(message);
      },
    });
    assert.ok(
      gapNames(doc).includes("changed_mid_walk"),
      JSON.stringify(doc.deck.gaps),
    );
    assert.equal(doc.deck.walk, "partial");
    // What the re-walk saw is kept, as any page's facts are.
    assert.ok(
      station(doc, "alpha").streams.some((x) => x.stream === "privateb"),
    );
  } finally {
    s.dispose();
  }
});

test("house-export coverage: a presence word the re-walk's rows give is checked against the status table too", async () => {
  const s = setup();
  try {
    for (let i = 0; i < 150; i++) {
      s.host.sing(10 + i, { station: `st${String(i).padStart(3, "0")}` });
    }
    s.host.sing(1); // ops:ops.fleet, on the first page of each pass
    let calls = 0;
    const { doc } = await run(s, undefined, {
      request: async (message) => {
        if (message.type === "call" && calls++ === 2)
          s.host.presence("ops", "UNOBSERVABLE");
        return s.request(message);
      },
    });
    assert.equal(station(doc, "ops").presence, "unknown");
    assert.ok(
      gapNames(doc).includes("presence_disagrees"),
      JSON.stringify(doc.deck.gaps),
    );
  } finally {
    s.dispose();
  }
});

test("house-export coverage: a presence table it can't read again is a changed walk, never a pass", async () => {
  const s = setup();
  try {
    const guide = guideDaemon(view());
    let statuses = 0;
    const { doc } = await run(s, undefined, {
      request: async (message) => {
        if (message.type !== "status") return guide(message);
        if (statuses++ === 0) return guide(message);
        return { ok: true, text: "not json" };
      },
    });
    assert.ok(
      gapNames(doc).includes("changed_mid_walk"),
      JSON.stringify(doc.deck.gaps),
    );
  } finally {
    s.dispose();
  }
});

// 🌿 round 4: the re-walk's rows go through every per-row check, and untuned rows too.
const rewalkEdit =
  (edit: (r: Record<string, unknown>) => Record<string, unknown>) =>
  (n: number, text: string) => {
    if (n < 2) return { ok: true, text }; // the walk's two pages are clean
    const v = JSON.parse(text) as { rows: Array<Record<string, unknown>> };
    return { ok: true, text: JSON.stringify({ ...v, rows: v.rows.map(edit) }) };
  };

test("house-export coverage: 🌿's repro: re-walk rows get the same row checks: a null live, a new local omission, a new coverage hole", async () => {
  const cases: Array<
    [string, (r: Record<string, unknown>) => Record<string, unknown>]
  > = [
    ["row_unparsed", (r) => (r.stream === "s000" ? { ...r, live: null } : r)],
    [
      "row_local_omissions",
      (r) =>
        r.stream === "s000"
          ? { ...r, localOmissions: { reason: "live_overflow", count: 2 } }
          : r,
    ],
    [
      "row_coverage_unknown",
      (r) =>
        r.stream === "s000"
          ? { ...r, coverageUnknown: { tunedAt: "x", dropped: 1, until: "y" } }
          : r,
    ],
  ];
  for (const [name, edit] of cases) {
    const s = setup();
    try {
      const { doc } = await run(s, undefined, {
        request: guideDaemon(view({ items: manyItems() }), {
          page: rewalkEdit(edit),
        }),
      });
      assert.ok(
        gapNames(doc).includes(name),
        `${name}: ${JSON.stringify(doc.deck.gaps)}`,
      );
      assert.equal(station(doc, "ops").streams_known, "partial", name);
    } finally {
      s.dispose();
    }
  }
});

test("house-export coverage: a re-walk row's null live makes that stream's count unknown", async () => {
  const s = setup();
  try {
    const { doc } = await run(s, undefined, {
      request: guideDaemon(view({ items: manyItems() }), {
        page: rewalkEdit((r) =>
          r.stream === "s000" ? { ...r, live: null } : r,
        ),
      }),
    });
    assert.equal(
      station(doc, "ops").streams.find((x) => x.stream === "s000")?.live,
      null,
    );
  } finally {
    s.dispose();
  }
});

test("house-export coverage: 🌿's repro: an untuned row whose live isn't a count exports unknown, never 0", async () => {
  for (const bad of [null, "1", -2]) {
    const s = setup();
    try {
      const { doc } = await run(s, undefined, {
        request: guideDaemon(
          view({ untuned: [item({ station: "alpha", stream: "chatter" })] }),
          {
            page: (_n, text) => {
              const v = JSON.parse(text) as {
                untuned: { rows: Array<Record<string, unknown>> };
              };
              return {
                ok: true,
                text: JSON.stringify({
                  ...v,
                  untuned: {
                    ...v.untuned,
                    rows: v.untuned.rows.map((r) => ({ ...r, live: bad })),
                  },
                }),
              };
            },
          },
        ),
      });
      const x = station(doc, "alpha").streams.find(
        (y) => y.stream === "chatter",
      );
      assert.equal(x?.live, null, String(bad));
      assert.ok(
        gapNames(doc).includes("row_unparsed"),
        JSON.stringify(doc.deck.gaps),
      );
      assert.equal(station(doc, "alpha").streams_known, "partial");
    } finally {
      s.dispose();
    }
  }
});

test("house-export coverage: an untuned row with an unreadable age or name is row_unparsed", async () => {
  const edits: Array<
    [string, (r: Record<string, unknown>) => Record<string, unknown>]
  > = [
    ["age", (r) => ({ ...r, newestAgeS: "3" })],
    ["station", (r) => ({ ...r, station: 7 })],
  ];
  for (const [what, edit] of edits) {
    const s = setup();
    try {
      const { doc } = await run(s, undefined, {
        request: guideDaemon(
          view({ untuned: [item({ station: "alpha", stream: "chatter" })] }),
          {
            page: (_n, text) => {
              const v = JSON.parse(text) as {
                untuned: { rows: Array<Record<string, unknown>> };
              };
              return {
                ok: true,
                text: JSON.stringify({
                  ...v,
                  untuned: { ...v.untuned, rows: v.untuned.rows.map(edit) },
                }),
              };
            },
          },
        ),
      });
      assert.ok(
        gapNames(doc).includes("row_unparsed"),
        `${what}: ${JSON.stringify(doc.deck.gaps)}`,
      );
      if (what === "age") {
        assert.equal(
          station(doc, "alpha").streams.find((x) => x.stream === "chatter")
            ?.live,
          null,
        );
      }
    } finally {
      s.dispose();
    }
  }
});

test("house-export coverage: a guide presence word that disagrees with a steady status table is unknown and partial", async () => {
  const s = setup();
  try {
    const { doc } = await run(s, undefined, {
      request: guideDaemon(
        view({ stations: [{ name: "ops", presence: "UNOBSERVABLE" }] }),
        {
          status: {
            source: "host-daemon",
            stations: { ops: "EQUIPPED_SPEAKING", alpha: "EQUIPPED_QUIET" },
          },
        },
      ),
    });
    assert.equal(station(doc, "ops").presence, "unknown");
    assert.equal(station(doc, "ops").streams_known, "partial");
    assert.ok(
      gapNames(doc).includes("presence_disagrees"),
      JSON.stringify(doc.deck.gaps),
    );
    assert.ok(
      !gapNames(doc).includes("presence_changed"),
      "the table itself held steady",
    );
    assert.equal(station(doc, "alpha").streams_known, "complete");
  } finally {
    s.dispose();
  }
});

// 🌫 at c392ded7: a row's metadata on a later sighting was lost behind identity dedup. An
// untuned row read verified, then ROOT_UNKNOWN on a later page, exported as verified.
test("house-export coverage: 🌫's repro: an untuned row's verification turns ROOT_UNKNOWN on a later page, then back: unknown, named", async () => {
  const s = setup();
  try {
    for (let i = 0; i < 150; i++) {
      s.host.sing(10 + i, { station: `st${String(i).padStart(3, "0")}` });
    }
    s.host.sing(500, { station: "alpha", stream: "chatter" }); // untuned: listed on every page
    let calls = 0;
    const { doc } = await run(s, undefined, {
      request: async (message) => {
        if (message.type === "call") {
          const n = calls++;
          if (n === 1) s.host.presence("alpha", "ROOT_UNKNOWN"); // page 2 says ROOT_UNKNOWN
          if (n === 2) s.host.presence("alpha", "EQUIPPED_QUIET"); // and it's back by the re-walk
        }
        return s.request(message);
      },
    });
    const alpha = station(doc, "alpha");
    assert.notEqual(alpha.verification, "verified", "never first-seen-wins");
    assert.equal(alpha.presence, "unknown");
    assert.equal(alpha.streams_known, "partial");
    assert.ok(
      gapNames(doc).includes("verification_changed"),
      JSON.stringify(doc.deck.gaps),
    );
  } finally {
    s.dispose();
  }
});

test("house-export coverage: control: an untuned row whose verification holds across every sighting keeps it", async () => {
  const s = setup();
  try {
    for (let i = 0; i < 150; i++) {
      s.host.sing(10 + i, { station: `st${String(i).padStart(3, "0")}` });
    }
    s.host.sing(500, { station: "alpha", stream: "chatter" });
    const { doc } = await run(s);
    assert.equal(station(doc, "alpha").verification, "verified");
    assert.equal(station(doc, "alpha").presence, "EQUIPPED_QUIET");
    assert.ok(!gapNames(doc).includes("verification_changed"));
  } finally {
    s.dispose();
  }
});

test("house-export coverage: a row's verification that contradicts the status table's presence is a disagreement", async () => {
  const s = setup();
  try {
    const { doc } = await run(s, undefined, {
      request: guideDaemon(
        view({
          untuned: [item({ station: "alpha", stream: "chatter" })],
          stations: [
            { name: "ops", presence: "EQUIPPED_SPEAKING" },
            { name: "alpha", presence: "ROOT_UNKNOWN" },
          ],
        }),
        {
          status: {
            source: "host-daemon",
            stations: { ops: "EQUIPPED_SPEAKING", alpha: "EQUIPPED_QUIET" },
          },
        },
      ),
    });
    assert.equal(station(doc, "alpha").presence, "unknown");
    assert.ok(
      gapNames(doc).includes("presence_disagrees"),
      JSON.stringify(doc.deck.gaps),
    );
    assert.equal(station(doc, "ops").presence, "EQUIPPED_SPEAKING");
  } finally {
    s.dispose();
  }
});

test("house-export coverage: a station the status table doesn't hold, whose row's verification flips, reads unknown and partial; others stay complete", async () => {
  const s = setup();
  try {
    const { doc } = await run(s, undefined, {
      request: guideDaemon(
        view({
          items: manyItems(),
          untuned: [item({ station: "beta", stream: "chatter" })],
        }),
        {
          status: {
            source: "host-daemon",
            stations: { ops: "EQUIPPED_SPEAKING", alpha: "EQUIPPED_QUIET" },
          },
          page: (n, text) => {
            if (n !== 1) return { ok: true, text };
            const v = JSON.parse(text) as {
              untuned: { rows: Array<Record<string, unknown>> };
            };
            return {
              ok: true,
              text: JSON.stringify({
                ...v,
                untuned: {
                  ...v.untuned,
                  rows: v.untuned.rows.map((r) => ({
                    ...r,
                    verification: "ROOT_UNKNOWN",
                  })),
                },
              }),
            };
          },
        },
      ),
    });
    assert.ok(
      gapNames(doc).includes("verification_changed"),
      JSON.stringify(doc.deck.gaps),
    );
    assert.equal(station(doc, "beta").presence, "unknown");
    assert.equal(station(doc, "beta").verification, null);
    assert.equal(station(doc, "beta").streams_known, "partial");
    assert.equal(station(doc, "alpha").streams_known, "complete", "only beta");
  } finally {
    s.dispose();
  }
});

test("house-export coverage: a tuned row whose verification differs on the re-walk is verification_changed", async () => {
  const s = setup();
  try {
    const { doc } = await run(s, undefined, {
      request: guideDaemon(view({ items: manyItems() }), {
        status: {
          source: "host-daemon",
          stations: { alpha: "EQUIPPED_QUIET" },
        },
        page: rewalkEdit((r) =>
          r.stream === "s000" ? { ...r, verification: "ROOT_UNKNOWN" } : r,
        ),
      }),
    });
    assert.ok(
      gapNames(doc).includes("verification_changed"),
      JSON.stringify(doc.deck.gaps),
    );
    assert.equal(station(doc, "ops").verification, null);
  } finally {
    s.dispose();
  }
});

test("house-export coverage: a status word of unknown says nothing a sighting can contradict", async () => {
  const s = setup();
  try {
    const { doc } = await run(s, undefined, {
      request: guideDaemon(
        view({
          untuned: [item({ station: "alpha", stream: "chatter" })],
          // the guide holds alpha ROOT_UNKNOWN, so its row says ROOT_UNKNOWN
          stations: [
            { name: "ops", presence: "EQUIPPED_SPEAKING" },
            { name: "alpha", presence: "ROOT_UNKNOWN" },
          ],
        }),
        {
          status: {
            source: "host-daemon",
            stations: { ops: "EQUIPPED_SPEAKING", alpha: "unknown" },
          },
        },
      ),
    });
    assert.ok(
      !gapNames(doc).includes("presence_disagrees"),
      JSON.stringify(doc.deck.gaps),
    );
  } finally {
    s.dispose();
  }
});

// 🌿 R6 on #147: the running daemon's view decides. canticle.tune and canticle.enabled are
// read by the daemon only at its start; the file is a cross-check, never the answer.
import { RecordClient } from "../src/canticle/record-client.ts";
import { StructuredLogger } from "../src/logger.ts";
import { readFileSync as readFile } from "node:fs";

/** Rewrites the config file on disk as an edit would, with no daemon restart. */
function editConfig(
  env: NodeJS.ProcessEnv,
  edit: (raw: Record<string, any>) => void,
): void {
  const path = env.FROND_EAR_CONFIG!;
  const raw = JSON.parse(readFile(path, "utf8")) as Record<string, any>;
  edit(raw);
  writeFileSync(path, JSON.stringify(raw));
}

test("house-export scope: 🌿's repro: a tune edited in the file without a restart: the daemon's applied tune decides, and the mismatch is named", async () => {
  const s = setup();
  try {
    s.host.sing(500, { station: "alpha", stream: "chatter" }); // untuned for the running daemon
    editConfig(s.env, (raw) => {
      raw.canticle.tune.scribe = [
        ...TUNE.filter((p) => p !== "quiet:whisper"),
        "alpha:chatter",
      ];
    });
    const { doc } = await run(s);
    assert.deepEqual(
      doc.reader.may_read,
      TUNE,
      "what the running daemon applies",
    );
    assert.equal(doc.reader.may_read_complete, false);
    assert.equal(doc.reader.basis.scope, "the running daemon's applied tune");
    assert.ok(
      doc.deck.gaps.some(
        (g) => g.name === "config_daemon_mismatch" && g.count === 2,
      ),
      JSON.stringify(doc.deck.gaps),
    );
    assert.equal(
      station(doc, "alpha").streams.find((x) => x.stream === "chatter")?.tuned,
      false,
      "the daemon doesn't tune it",
    );
    assert.equal(
      station(doc, "quiet").streams.find((x) => x.stream === "whisper")?.tuned,
      true,
      "the daemon still tunes it",
    );
  } finally {
    s.dispose();
  }
});

test("house-export scope: 🌿's repro: canticle on in the file, off in the running daemon: payload text off, the board unknown", async () => {
  const s = setup();
  try {
    // A daemon with no canticle source: status says disabled, the guide says not enabled.
    const raw = JSON.parse(readFile(s.env.FROND_EAR_CONFIG!, "utf8")) as Record<
      string,
      unknown
    >;
    const off = harness(parseConfig(raw));
    try {
      const cli = off.attach(undefined, { role: "cli" });
      let id = 1;
      const { doc } = await run(s, undefined, {
        request: async (message) => {
          const at = ++id;
          await cli.send({ ...message, id: at } as never);
          const r = cli.connection.results().find((x) => x.id === at)!;
          return { ok: r.ok, text: r.text };
        },
      });
      assert.equal(doc.reader.payload_text, false);
      assert.equal(doc.reader.basis.canticle, "disabled");
      assert.deepEqual(doc.reader.may_read, []);
      assert.equal(doc.reader.may_read_complete, false);
      assert.equal(doc.deck.listener, "canticle off");
      assert.equal(doc.deck.connected, false);
      assert.ok(
        gapNames(doc).includes("config_daemon_mismatch"),
        JSON.stringify(doc.deck.gaps),
      );
      assert.ok(
        doc.deck.stations.every((st) =>
          st.streams.every((x) => x.live === null),
        ),
      );
      assert.ok(allPartial(doc));
      assert.ok(
        !gapNames(doc).includes("changed_mid_walk"),
        "no presence table to compare, not a change",
      );
    } finally {
      off.dispose();
    }
  } finally {
    s.dispose();
  }
});

test("house-export scope: canticle off in the file, on in the running daemon: the daemon is asked, and it decides", async () => {
  const s = setup();
  try {
    s.host.sing(1);
    editConfig(s.env, (raw) => {
      raw.canticle.enabled = false;
    });
    const { doc } = await run(s);
    assert.equal(doc.reader.payload_text, true);
    assert.equal(doc.deck.listener, "listening");
    assert.deepEqual(doc.reader.may_read, TUNE);
    assert.ok(gapNames(doc).includes("config_daemon_mismatch"));
    assert.equal(
      station(doc, "ops").streams.find((x) => x.stream === "ops.fleet")?.live,
      1,
    );
  } finally {
    s.dispose();
  }
});

test("house-export scope: config and daemon agree: the scope is whole, and no mismatch", async () => {
  const s = setup();
  try {
    const { doc } = await run(s);
    assert.equal(doc.reader.may_read_complete, true);
    assert.equal(doc.reader.basis.scope, "the running daemon's applied tune");
    assert.equal(doc.reader.basis.config_patterns, TUNE.length);
    assert.ok(!gapNames(doc).includes("config_daemon_mismatch"));
    assert.ok(!gapNames(doc).includes("runtime_scope_unverified"));
  } finally {
    s.dispose();
  }
});

test("house-export scope: --offline says the scope is the config's, unverified: nothing in it can prove a read", async () => {
  const s = setup();
  try {
    const { doc } = await run(s, ["--ear", "scribe", "--offline"]);
    assert.equal(
      doc.reader.basis.scope,
      "none: the config's tune is unverified against a running daemon",
    );
    assert.deepEqual(doc.reader.may_read, []);
    assert.equal(doc.reader.may_read_complete, false);
    assert.equal(doc.reader.basis.config_patterns, TUNE.length);
    assert.deepEqual(
      doc.reader.basis.may_read_configured,
      TUNE,
      "configured intent, labelled apart",
    );
    assert.ok(gapNames(doc).includes("runtime_scope_unverified"));
    assert.ok(
      doc.deck.stations.every((st) =>
        st.streams.every((x) => x.tuned === null),
      ),
    );
  } finally {
    s.dispose();
  }
});

test("house-export scope: a daemon that doesn't say its tune: only its tuned rows prove a read, and rows the file contradicts are named", async () => {
  const s = setup({}, (host) => ({
    source: "host-daemon",
    stations: Object.fromEntries(host.consumer.presence),
  }));
  try {
    s.host.sing(1); // ops:ops.fleet, tuned by the daemon
    s.host.sing(500, { station: "alpha", stream: "chatter" });
    editConfig(s.env, (raw) => {
      raw.canticle.tune.scribe = ["alpha:chatter"]; // the file now tunes the untuned row, not ops.fleet
    });
    const { doc } = await run(s);
    assert.equal(
      doc.reader.basis.scope,
      "the running daemon's tuned rows only (it doesn't say its tune)",
    );
    assert.deepEqual(doc.reader.may_read, ["ops:ops.fleet"]);
    assert.equal(doc.reader.may_read_complete, false);
    assert.ok(gapNames(doc).includes("runtime_scope_unverified"));
    assert.ok(
      doc.deck.gaps.some(
        (g) => g.name === "config_daemon_mismatch" && g.count === 2,
      ),
      JSON.stringify(doc.deck.gaps),
    );
    assert.equal(
      station(doc, "ops").streams.find((x) => x.stream === "ops.fleet")?.tuned,
      true,
    );
    assert.equal(
      station(doc, "alpha").streams.find((x) => x.stream === "chatter")?.tuned,
      false,
    );
    assert.equal(
      station(doc, "quiet").streams.find((x) => x.stream === "chatter")?.tuned,
      null,
      "no row and no applied tune: unknown",
    );
  } finally {
    s.dispose();
  }
});

test("house-export scope: the record v1 source says the tune it applies (appliedTune), fixed at its start", () => {
  const client = new RecordClient({
    socketPath: "/nonexistent/canticle.sock",
    tune: { scribe: ["*:ops.fleet"] },
    logger: new StructuredLogger(() => {}),
  });
  assert.deepEqual((client.status() as { appliedTune: unknown }).appliedTune, {
    scribe: ["*:ops.fleet"],
  });
});

// 🌿 R6-3: an untuned row's numbers on later sightings were lost behind dedup too.
test("house-export coverage: an untuned row whose live count changes across sightings reads unknown, named count_changed", async () => {
  const s = setup();
  try {
    const { doc } = await run(s, undefined, {
      request: guideDaemon(
        view({
          items: manyItems(),
          untuned: [item({ station: "alpha", stream: "chatter" })],
        }),
        {
          page: (n, text) => {
            if (n !== 1) return { ok: true, text };
            const v = JSON.parse(text) as {
              untuned: { rows: Array<Record<string, unknown>> };
            };
            return {
              ok: true,
              text: JSON.stringify({
                ...v,
                untuned: {
                  ...v.untuned,
                  rows: v.untuned.rows.map((r) => ({ ...r, live: 5 })),
                },
              }),
            };
          },
        },
      ),
    });
    const x = station(doc, "alpha").streams.find((y) => y.stream === "chatter");
    assert.equal(x?.live, null);
    assert.ok(
      gapNames(doc).includes("count_changed"),
      JSON.stringify(doc.deck.gaps),
    );
    assert.equal(station(doc, "alpha").streams_known, "partial");
    assert.equal(station(doc, "ops").streams_known, "complete", "only alpha");
  } finally {
    s.dispose();
  }
});

test("house-export coverage: an untuned row's age that only grows keeps the latest; one that drops is count_changed", async () => {
  for (const [later, changed] of [
    [9, false],
    [0, true],
  ] as const) {
    const s = setup();
    try {
      const { doc } = await run(s, undefined, {
        request: guideDaemon(
          view({
            items: manyItems(),
            untuned: [item({ station: "alpha", stream: "chatter" })],
          }),
          {
            page: (n, text) => {
              if (n < 1) return { ok: true, text };
              const v = JSON.parse(text) as {
                untuned: { rows: Array<Record<string, unknown>> };
              };
              return {
                ok: true,
                text: JSON.stringify({
                  ...v,
                  untuned: {
                    ...v.untuned,
                    rows: v.untuned.rows.map((r) => ({
                      ...r,
                      newestAgeS: later,
                    })),
                  },
                }),
              };
            },
          },
        ),
      });
      const x = station(doc, "alpha").streams.find(
        (y) => y.stream === "chatter",
      );
      assert.equal(
        gapNames(doc).includes("count_changed"),
        changed,
        JSON.stringify(doc.deck.gaps),
      );
      if (!changed)
        assert.equal(x?.newest_age_ms, 9_000, "the latest sighting's age");
    } finally {
      s.dispose();
    }
  }
});

test("house-export scope: the daemon's canticle state from either of its words: status disabled, or a guide that says not enabled", async () => {
  const cases: Array<[string, Parameters<typeof guideDaemon>[1]]> = [
    [
      "status disabled",
      { status: { state: "disabled", appliedTune: { scribe: TUNE } } },
    ],
    [
      "guide not enabled",
      {
        page: () => ({
          ok: true,
          text: "canticle is not enabled on this daemon (config canticle.enabled).",
        }),
      },
    ],
  ];
  for (const [what, o] of cases) {
    const s = setup();
    try {
      const { doc } = await run(s, undefined, {
        request: guideDaemon(view(), o),
      });
      assert.equal(doc.reader.payload_text, false, what);
      assert.deepEqual(doc.reader.may_read, [], what);
      assert.ok(
        gapNames(doc).includes("canticle_off"),
        `${what}: ${JSON.stringify(doc.deck.gaps)}`,
      );
    } finally {
      s.dispose();
    }
  }
});

test("house-export scope: an appliedTune that isn't a list of patterns is a daemon that didn't say", async () => {
  const s = setup();
  try {
    const { doc } = await run(s, undefined, {
      request: guideDaemon(view(), {
        status: {
          source: "host-daemon",
          stations: { ops: "EQUIPPED_SPEAKING" },
          appliedTune: { scribe: ["*:ops.fleet", 7] },
        },
      }),
    });
    assert.equal(
      doc.reader.basis.scope,
      "the running daemon's tuned rows only (it doesn't say its tune)",
    );
    assert.ok(gapNames(doc).includes("runtime_scope_unverified"));
  } finally {
    s.dispose();
  }
});
