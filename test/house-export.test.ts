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

import { runHouseExport } from "../src/canticle/house-cli.ts";
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
  "key_scoped",
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
  "unnamed_stations",
  "untuned_more",
  "truncated",
  "refused_names",
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
  status: (host: Host) => object = (host) => ({
    source: "host-daemon",
    state: "connected",
    socket: `/run/${SENTINEL}/canticle.sock`,
    lastError: `payload ${SENTINEL}`,
    stations: Object.fromEntries(host.consumer.presence),
  }),
): Setup {
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
      ],
    }),
  );
  const raw = {
    botUserId: BOT,
    principals: [PRINCIPAL],
    peerAgents: [PEER_BOT],
    labels: { [PRINCIPAL]: "figs" },
    ears: {
      scribe: {
        target: "claude-channel",
        channels: { [CHANNEL]: { mode: "mentions" }, [ROOM]: { mode: "room" } },
      },
    },
    canticle: {
      enabled: true,
      source: "host-daemon",
      hostSocket: "/nonexistent/canticle.sock",
      manifestPath,
      tune: { scribe: TUNE },
      wakeKeys: advisory([OPS, ALPHA]),
      delivery: {
        scribe: {
          mode: "digest",
          stations: { ops: "immediate", [ALPHA]: "off" },
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
    canticleStatus: () => status(host!),
  });
  host = new Host(h.clock, TUNE);
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
  tuned: boolean;
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
    basis: {
      canticle: string;
      hear: string;
      push: {
        mode: string;
        style: string;
        muted: boolean;
        stations: Array<{ station: string; mode: string }>;
        key_scoped: number;
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
    left_out: {
      unnamed_stations: number;
      untuned_more: number;
      truncated: boolean;
      refused_names: number;
    };
  };
}

async function run(
  s: Pick<Setup, "env" | "request">,
  argv: string[] = ["--ear", "scribe"],
  extra: { request?: Setup["request"] } = {},
): Promise<{ code: number; out: string; err: string; doc: Export }> {
  let out = "";
  let err = "";
  const code = await runHouseExport(argv, {
    stdout: { write: (text: string) => (out += text) },
    stderr: { write: (text: string) => (err += text) },
    env: s.env,
    request: extra.request ?? s.request,
    revision: () => "abc1234",
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
    assert.equal(doc.reader.basis.push.key_scoped, 1);
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
    assert.equal(doc.deck.left_out.unnamed_stations, 1);
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
      TUNE,
      "the reader stands on config alone",
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
    assert.equal(doc.deck.listener, "canticle off");
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
