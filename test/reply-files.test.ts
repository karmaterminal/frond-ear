// frond-ear#99: a reply can carry files. The daemon reads them, so every refusal
// is checked here with nothing posted, and the multipart request is checked on the wire.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseConfig } from "../src/config.ts";
import { HttpDiscordRest } from "../src/rest.ts";
import {
  BOT,
  CHANNEL,
  PEER_BOT,
  PRINCIPAL,
  harness,
  testConfig,
} from "./helpers.ts";

const sha = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

let nextCall = 10_000;
/**
 * The harness's `call` waits one tick; reading files is real async I/O, so wait for
 * the result to arrive.
 */
async function reply(
  shim: ReturnType<ReturnType<typeof harness>["attach"]>,
  args: Record<string, unknown>,
) {
  const id = ++nextCall;
  await shim.send({ type: "call", id, tool: "reply", args });
  for (let waited = 0; waited < 5_000; waited += 5) {
    const result = shim.connection.results().find((item) => item.id === id);
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("no result for reply");
}

/** A sandbox: `root` is the ear's send root, `outside` is not. */
function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "frond-ear-files-"));
  const root = join(base, "root");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  return {
    base,
    root,
    outside,
    file(dir: string, name: string, content: string | Uint8Array): string {
      const path = join(dir, name);
      writeFileSync(path, content);
      return path;
    },
    dispose: () => rmSync(base, { recursive: true, force: true }),
  };
}

function configWithRoots(roots: string[], maxSendFileBytes?: number) {
  return testConfig({
    ears: {
      scribe: {
        target: "claude-channel",
        dms: true,
        attachCanary: false,
        channels: { [CHANNEL]: { mode: "mentions" } },
        sendFileRoots: roots,
      },
    },
    ...(maxSendFileBytes ? { limits: { maxSendFileBytes } } : {}),
  });
}

test("reply carries files on its last message, with digests in the receipt; text may be empty", async () => {
  const box = sandbox();
  const h = harness(configWithRoots([box.root]));
  try {
    const shim = h.attach("scribe");
    const png = box.file(
      box.root,
      "pic.png",
      new Uint8Array([0x89, 0x50, 1, 2]),
    );
    const log = box.file(box.root, "run.log", "line one\n");
    const result = await reply(shim, {
      chat_id: CHANNEL,
      text: "here",
      files: [png, log],
    });
    assert.equal(result.ok, true, result.text);
    assert.equal(h.rest.calls.length, 1);
    assert.deepEqual(h.rest.calls[0]?.files, [
      {
        name: "pic.png",
        size: 4,
        sha256: sha(new Uint8Array([0x89, 0x50, 1, 2])),
      },
      { name: "run.log", size: 9, sha256: sha("line one\n") },
    ]);
    assert.equal(h.rest.calls[0]?.content, "here");
    assert.match(
      result.text,
      /with 2 files \(pic\.png 4 B sha256 [0-9a-f]{12}, run\.log 9 B/u,
    );

    // Files alone: no text needed.
    const bare = await reply(shim, {
      chat_id: CHANNEL,
      files: [png],
    });
    assert.equal(bare.ok, true, bare.text);
    assert.equal(h.rest.calls[1]?.content, "");
    assert.equal(h.rest.calls[1]?.files?.length, 1);

    // Neither text nor files: refused as before.
    const empty = await reply(shim, { chat_id: CHANNEL });
    assert.equal(empty.ok, false);
    assert.match(empty.text, /text is required/u);
    assert.equal(h.rest.calls.length, 2);
  } finally {
    h.dispose();
    box.dispose();
  }
});

test("a long reply puts its files on the last part only", async () => {
  const box = sandbox();
  const h = harness(configWithRoots([box.root]));
  try {
    const shim = h.attach("scribe");
    const file = box.file(box.root, "a.txt", "a");
    const text = `${"x".repeat(1_990)}\n\n${"y".repeat(1_990)}\n\n${"z".repeat(50)}`;
    const result = await reply(shim, {
      chat_id: CHANNEL,
      text,
      files: [file],
    });
    assert.equal(result.ok, true, result.text);
    assert.equal(h.rest.calls.length, 3);
    assert.deepEqual(
      h.rest.calls.map((call) => call.files?.length ?? 0),
      [0, 0, 1],
    );
  } finally {
    h.dispose();
    box.dispose();
  }
});

test("a retry resumes a part-sent reply only with the same files; other files make it a new reply", async () => {
  const box = sandbox();
  const h = harness(configWithRoots([box.root]));
  try {
    const shim = h.attach("scribe");
    const one = box.file(box.root, "one.txt", "1");
    const two = box.file(box.root, "two.txt", "2");
    const text = `${"x".repeat(1_990)}\n\n${"y".repeat(50)}`;
    // Part 1 posts; part 2 (the one with the file) posts but its response is lost.
    const originalSend = h.rest.sendMessage.bind(h.rest);
    let failNext = 2;
    h.rest.sendMessage = async (...args) => {
      failNext -= 1;
      const sent = await originalSend(...args);
      if (failNext === 0) {
        throw new Error("socket hang up");
      }
      return sent;
    };
    const first = await reply(shim, { chat_id: CHANNEL, text, files: [one] });
    assert.equal(first.ok, false);
    assert.equal(h.rest.calls.length, 2);

    // The same text with another file is a new reply with fresh nonces: both parts
    // post again, and Discord is not handed the lost part's nonce (it would return
    // the message carrying one.txt).
    const other = await reply(shim, { chat_id: CHANNEL, text, files: [two] });
    assert.equal(other.ok, true, other.text);
    assert.doesNotMatch(other.text, /earlier try/u);
    assert.equal(h.rest.calls.length, 4);
    assert.equal(h.rest.calls[3]?.files?.[0]?.name, "two.txt");

    // The same text with the first file resumes it: part 1 is not posted again, and
    // part 2 reuses its nonce, so Discord returns the original instead of a second.
    const same = await reply(shim, { chat_id: CHANNEL, text, files: [one] });
    assert.equal(same.ok, true, same.text);
    assert.match(same.text, /had gone out on an earlier try/u);
    assert.equal(h.rest.calls.length, 4);
    assert.equal(h.rest.calls[1]?.files?.[0]?.name, "one.txt");
  } finally {
    h.dispose();
    box.dispose();
  }
});

test("refusals post nothing: off, outside, dot paths, links out, own state, not a file, too big, too many, relative, missing", async () => {
  const box = sandbox();
  const db = join(box.root, "ear.db");
  writeFileSync(db, "state");
  const h = harness(configWithRoots([box.root], 10), { protectedPaths: [db] });
  const off = harness(configWithRoots([]));
  try {
    const shim = h.attach("scribe");
    const ok = box.file(box.root, "ok.txt", "fine");
    const out = box.file(box.outside, "secret.txt", "no");
    mkdirSync(join(box.root, ".ssh"));
    const dotted = box.file(join(box.root, ".ssh"), "id", "key");
    const dotfile = box.file(box.root, ".env", "K=V");
    const link = join(box.root, "link.txt");
    symlinkSync(out, link);
    const big = box.file(box.root, "big.bin", "0123456789A");
    const sub = join(box.root, "dir");
    mkdirSync(sub);
    const cases: Array<[unknown, RegExp]> = [
      [[out], /is not under any of ears\.scribe\.sendFileRoots/u],
      [[dotted], /dot-named/u],
      [[dotfile], /dot-named/u],
      [[link], /is not under any of ears\.scribe\.sendFileRoots/u],
      [[db], /frond-ear's own state/u],
      [[sub], /not a regular file/u],
      [[big], /limits\.maxSendFileBytes/u],
      [[ok, ok, ok], /limits\.maxSendFileBytes/u],
      [Array.from({ length: 11 }, () => ok), /at most 10 per reply/u],
      [["ok.txt"], /must be an absolute path/u],
      [[join(box.root, "nope.txt")], /file not found/u],
      ["/etc/hostname", /must be an array/u],
      [[ok, out], /is not under any/u],
    ];
    for (const [files, pattern] of cases) {
      const result = await reply(shim, {
        chat_id: CHANNEL,
        text: "t",
        files,
      });
      assert.equal(result.ok, false, `${JSON.stringify(files)} was accepted`);
      assert.match(result.text, pattern, JSON.stringify(files));
    }
    assert.equal(h.rest.calls.length, 0, "a refused reply posted something");

    // The one good file goes; the same set plus a bad one did not (last case above).
    const good = await reply(shim, {
      chat_id: CHANNEL,
      text: "t",
      files: [ok],
    });
    assert.equal(good.ok, true, good.text);

    const offShim = off.attach("scribe");
    const refused = await reply(offShim, {
      chat_id: CHANNEL,
      text: "t",
      files: [ok],
    });
    assert.equal(refused.ok, false);
    assert.match(
      refused.text,
      /sending files is off for ear scribe: set ears\.scribe\.sendFileRoots/u,
    );
    assert.equal(off.rest.calls.length, 0);
  } finally {
    h.dispose();
    off.dispose();
    box.dispose();
  }
});

test("config: sendFileRoots defaults to off and must be absolute directories; maxSendFileBytes defaults to 10 MiB", () => {
  const base = {
    botUserId: BOT,
    principals: [PRINCIPAL],
    peerAgents: [PEER_BOT],
    ears: {
      scribe: {
        target: "claude-channel",
        channels: { [CHANNEL]: { mode: "mentions" } },
      },
    },
  };
  const parsed = parseConfig(base);
  assert.deepEqual(parsed.ears.scribe?.sendFileRoots, []);
  assert.equal(parsed.limits.maxSendFileBytes, 10 * 1024 * 1024);
  for (const bad of [
    ["relative"],
    ["/"],
    ["//"],
    ["/tmp/.."],
    ["/tmp/../"],
    ["/a/../../etc"],
    "/home",
    [1],
  ]) {
    assert.throws(
      () =>
        parseConfig({
          ...base,
          ears: { scribe: { ...base.ears.scribe, sendFileRoots: bad } },
        }),
      /sendFileRoots must be an array of absolute directories/u,
    );
  }
});

test("REST: files go as multipart, payload_json names each attachment, a 429 retry rebuilds the form", async () => {
  const requests: RequestInit[] = [];
  const responses = [
    { status: 429, body: { retry_after: 0 } },
    { status: 200, body: { id: "999" } },
  ];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(init ?? {});
    const next = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof globalThis.fetch;
  const rest = new HttpDiscordRest({
    token: "t",
    apiBase: "https://discord.example",
    fetch,
    sleep: async () => undefined,
  });
  const bytes = new Uint8Array([1, 2, 3]);
  const sent = await rest.sendMessage(CHANNEL, "hi", "42", "nonce-x", [
    { name: "a.png", bytes, sha256: sha(bytes) },
  ]);
  assert.deepEqual(sent, { id: "999" });
  assert.equal(requests.length, 2);
  assert.notEqual(
    requests[0]?.body,
    requests[1]?.body,
    "the form was reused across attempts",
  );
  for (const init of requests) {
    const headers = init.headers as Record<string, string>;
    assert.equal(
      headers["Content-Type"],
      undefined,
      "fetch must set the multipart boundary",
    );
    const form = init.body as FormData;
    assert.ok(form instanceof FormData);
    const payload = JSON.parse(String(form.get("payload_json"))) as Record<
      string,
      unknown
    >;
    assert.equal(payload.content, "hi");
    assert.equal(payload.nonce, "nonce-x");
    assert.equal(payload.enforce_nonce, true);
    assert.deepEqual(payload.attachments, [{ id: 0, filename: "a.png" }]);
    assert.deepEqual(payload.message_reference, {
      message_id: "42",
      fail_if_not_exists: false,
    });
    const file = form.get("files[0]") as File;
    assert.equal(file.name, "a.png");
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
  }

  // No files: still plain JSON.
  responses.push({ status: 200, body: { id: "1000" } });
  await rest.sendMessage(CHANNEL, "plain");
  const last = requests.at(-1);
  assert.equal(typeof last?.body, "string");
  assert.equal(
    (last?.headers as Record<string, string>)["Content-Type"],
    "application/json",
  );
});

test("a root that resolves to / (a symlink to /) refuses the reply; nothing posts", async () => {
  const box = sandbox();
  const slash = join(box.base, "slash");
  symlinkSync("/", slash);
  // Config accepts the path (no "..", not "/"); only resolution shows it is /.
  const h = harness(configWithRoots([slash]));
  try {
    const shim = h.attach("scribe");
    const target = box.file(box.root, "any.txt", "x");
    const result = await reply(shim, {
      chat_id: CHANNEL,
      text: "t",
      files: [target],
    });
    assert.equal(result.ok, false);
    assert.match(result.text, /has a root that resolves to \/; refusing/u);
    assert.equal(h.rest.calls.length, 0);
  } finally {
    h.dispose();
    box.dispose();
  }
});
