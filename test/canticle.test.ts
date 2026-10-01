import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as cbor from "../src/canticle/cbor.ts";
import { keyId, streamId } from "../src/canticle/ids.ts";
import { Listener } from "../src/canticle/listener.ts";
import { Manifest, hex } from "../src/canticle/manifest.ts";
import { Reject, parse } from "../src/canticle/wire.ts";

// Candidate frame v2 vectors from the binary-canticle spike (see test/fixtures/canticle/SOURCE.md).
interface Vectors {
  now_ms: number;
  keys: Record<string, { secret: string; public: string; key_id: string }>;
  manifest: unknown;
  parse: Array<{ name: string; datagram_hex: string; expect: string }>;
  sequences: Array<{
    name: string;
    datagrams_hex: string[];
    now_ms: number;
    expect: string[];
  }>;
}

const vectors = JSON.parse(
  readFileSync(
    new URL("./fixtures/canticle/frame-v2-candidates.json", import.meta.url),
    "utf8",
  ),
) as Vectors;
const manifest = Manifest.fromJson(vectors.manifest);
const bytes = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

function runParse(datagramHex: string): string {
  try {
    parse(bytes(datagramHex), manifest.resolve, vectors.now_ms);
    return "accept";
  } catch (e) {
    assert.ok(e instanceof Reject, `parse threw a non-Reject: ${String(e)}`);
    return e.reason;
  }
}

test("vector keys: public key and key-id derive from the RFC 8032 seeds", () => {
  const pkcs8Prefix = "302e020100300506032b657004220420";
  for (const [name, k] of Object.entries(vectors.keys)) {
    const sk = createPrivateKey({
      key: Buffer.from(pkcs8Prefix + k.secret, "hex"),
      format: "der",
      type: "pkcs8",
    });
    const spki = createPublicKey(sk).export({ format: "der", type: "spki" });
    const pub = new Uint8Array(spki.subarray(spki.length - 32));
    assert.equal(hex(pub), k.public, name);
    assert.equal(hex(keyId(pub)), k.key_id, name);
  }
});

for (const c of vectors.parse) {
  test(`parse vector: ${c.name} → ${c.expect}`, () => {
    assert.equal(runParse(c.datagram_hex), c.expect);
  });
}

for (const s of vectors.sequences) {
  test(`sequence vector: ${s.name} → [${s.expect.join(", ")}]`, () => {
    // As in the spike's runner: wire semantics at one instant, so the warm-up hold is off.
    const listener = new Listener(manifest, { warmup: false, ephemeral: true });
    const out: string[] = [];
    for (const d of s.datagrams_hex) {
      for (const ev of listener.hear(bytes(d), s.now_ms)) {
        if (ev.event === "presence") continue;
        out.push(
          ev.event === "evidence"
            ? `evidence:${String(ev.data.reason)}`
            : ev.event,
        );
      }
    }
    assert.deepEqual(out, s.expect);
  });
}

test("parse never throws anything but Reject, whatever the bytes", () => {
  const good = bytes(
    vectors.parse.find((c) => c.name === "rfc-vector-1-item")!.datagram_hex,
  );
  let seed = 1;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < 2000; i++) {
    const buf = good.slice(0, Math.floor(rand() * (good.length + 1)));
    for (let j = 0; j < 4 && buf.length > 0; j++)
      buf[Math.floor(rand() * buf.length)] = Math.floor(rand() * 256);
    try {
      parse(buf, manifest.resolve, vectors.now_ms);
    } catch (e) {
      assert.ok(
        e instanceof Reject,
        `non-Reject on input ${hex(buf)}: ${String(e)}`,
      );
    }
  }
});

test("a listener surfaces the item text, then expires it on tick", () => {
  const listener = new Listener(manifest, { warmup: false, ephemeral: true });
  const named = vectors.parse.find(
    (c) => c.name === "valid-item-named-stream",
  )!;
  const [ev] = listener.hear(bytes(named.datagram_hex), vectors.now_ms);
  assert.equal(ev?.event, "item");
  assert.equal(ev?.stream, "chatter");
  assert.equal(ev?.data.text, "hello, station");
  assert.equal(listener.onAir().length, 1);
  const expires = Number(ev?.data.expires_at);
  assert.deepEqual(
    listener
      .tick(expires + 1)
      .filter((e) => e.event === "expired")
      .map((e) => e.seq),
    [ev?.seq],
  );
  assert.equal(listener.onAir().length, 0);
});

test("a listener only surfaces tuned streams", () => {
  const listener = new Listener(manifest, {
    warmup: false,
    ephemeral: true,
    tuned: new Set(["lens.threat"]),
  });
  const named = vectors.parse.find(
    (c) => c.name === "valid-item-named-stream",
  )!;
  assert.deepEqual(
    listener.hear(bytes(named.datagram_hex), vectors.now_ms),
    [],
  );
});

test("a listener refuses to start without ephemeral until state persists (P2)", () => {
  assert.throws(() => new Listener(manifest, {} as never), /restart safety/);
});

test("cbor: deterministic round trip and strict rejections", () => {
  const m: cbor.CborMap = new Map<cbor.CborKey, cbor.CborValue>([
    [2n, "two"],
    [1n, new Uint8Array([1, 2])],
    [-1n, [true, false, null, 2n ** 64n - 1n]],
  ]);
  const enc = cbor.encode(m);
  // Same bytes as the spike's cbor.encode({2: "two", 1: b"\x01\x02", -1: [True, False, None, 2**64 - 1]}).
  assert.equal(hex(enc), "a301420102026374776f2084f5f4f61bffffffffffffffff");
  const back = cbor.decode(enc) as cbor.CborMap;
  assert.equal(cbor.compareBytes(cbor.encode(back), enc), 0);
  const reason = (h: string) => {
    try {
      cbor.decode(bytes(h));
      return "ok";
    } catch (e) {
      return (e as cbor.CborError).reason;
    }
  };
  assert.equal(reason("1817"), "non-shortest");
  assert.equal(reason("a202000100"), "map-key-order");
  assert.equal(reason("f93c00"), "float-or-simple");
  assert.equal(reason("c100"), "tag");
  assert.equal(reason("5f"), "indefinite-length");
  assert.equal(reason("0000"), "trailing-bytes");
  assert.equal(reason("8181818181"), "depth");
  assert.equal(reason("62ff00"), "bad-utf8");
});

test("stream ids match the spike (vector beacon advertises chatter)", () => {
  assert.equal(streamId("chatter"), 0x1ab3c589);
  assert.throws(() => streamId("Bad.Name"), /invalid stream name/);
});
