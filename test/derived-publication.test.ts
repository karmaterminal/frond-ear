// binary-canticle#161 item 4: the derived-publication adapter. Phase 1 left the seam
// closed; this is the call path to a station's derived op (binary-canticle#159, assembled
// in #162 at 452c5433): `derived_publish` with exactly `op`, `capsule_b64` and `text`, and
// `derived_query` with exactly `op` and `election_id`, one JSON line per connection on the
// station's Unix control socket. It stays closed unless config canticle.derivedPublication
// is on, every source was heard whole and echoed within the current compaction boundary,
// the station's control socket offers the derived op, and the owner's issuer is wired:
// #162 accepts only a capsule its authority issued, so frond-ear hands the issuer the
// lineage (source ids and digests, scope, author, audience) and never mints one. It never
// uses the `sing` route. The station here is a fake on a real Unix socket.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  type DerivedIssuer,
  type DerivedLineage,
  unixStationControl,
} from "../src/canticle/derived.ts";
import { EventStore } from "../src/store.ts";
import { offered, OPS, pressure, SESSION, setup } from "./canticle-host.ts";
import type { Harness } from "./helpers.ts";

type R = Record<string, unknown>;

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const identity = (seq: number) => `${OPS}:7:ops.fleet:${seq}`;
const digestOf = (seq: number) => sha256(`deploy.started ${seq}`);

const ELECTION = "5e1ec7ed5e1ec7ed5e1ec7ed5e1ec7ed";
const PROBE = { op: "derived_query", election_id: "0".repeat(32) };
const TEXT = "the fleet deploy began; one host is still waiting";

/** #162's acceptance receipt, as the station answers derived_publish. */
const ACCEPTANCE = {
  v: "canticle-derived-station-acceptance/1",
  election_id: ELECTION,
  payload_sha256: sha256(TEXT),
  station: "scribe-station",
  stream: "town.reply",
  seq: "1",
  frame_sha256: "ab".repeat(32),
};

type Answer = R | "drop" | string;

/**
 * A station's Unix control socket as #162's runner serves it: one JSON request line per
 * connection, one JSON answer line, then the station closes. `answer` decides each reply;
 * every request is kept, so a test can say exactly what crossed the socket.
 */
async function fakeStation(
  directory: string,
  answer: (request: R) => Answer,
): Promise<{ path: string; requests: R[]; close: () => Promise<void> }> {
  const path = join(directory, "station.sock");
  const requests: R[] = [];
  const server: Server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as R;
      requests.push(request);
      const reply = answer(request);
      if (reply === "drop") {
        socket.destroy();
        return;
      }
      socket.end(
        typeof reply === "string" ? reply : `${JSON.stringify(reply)}\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    path,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A station with the derived op configured: #162's answers, including its probe reply. */
function capable(publish: Answer = { ok: true, acceptance: ACCEPTANCE }) {
  return (request: R): Answer => {
    if (request.op === "derived_query") {
      return request.election_id === ELECTION
        ? {
            ok: true,
            election_id: ELECTION,
            state: "accepted",
            acceptance: ACCEPTANCE,
          }
        : { ok: false, error: "station_claim_missing" };
    }
    if (request.op === "derived_publish") return publish;
    return { ok: false, error: `unknown op ${JSON.stringify(request.op)}` };
  };
}

/**
 * The owner's issuer, faked: keeps what it was asked and returns a capsule naming it.
 * `during` runs while it is issuing, before it answers.
 */
function fakeIssuer(
  refuse?: string,
  during?: () => Promise<void>,
): DerivedIssuer & {
  calls: Array<{ lineage: DerivedLineage; text: string }>;
  capsule: Uint8Array | undefined;
} {
  const issuer = {
    calls: [] as Array<{ lineage: DerivedLineage; text: string }>,
    capsule: undefined as Uint8Array | undefined,
    async issue(lineage: DerivedLineage, text: string) {
      issuer.calls.push({ lineage, text });
      await during?.();
      if (refuse !== undefined) throw new Error(refuse);
      issuer.capsule = new TextEncoder().encode(
        JSON.stringify({
          envelope: { election_id: ELECTION, lineage },
          mac: "00",
        }),
      );
      return { capsule: issuer.capsule, electionId: ELECTION };
    },
  };
  return issuer;
}

/**
 * Canticle on, delivering to scribe, with the owner's route wired to a fake station: the
 * session attached, its hook reporting boundary b-1, and record 1 pushed and echoed.
 */
async function heard(
  answer: (request: R) => Answer,
  options: {
    derivedPublication?: boolean;
    issuer?: ReturnType<typeof fakeIssuer>;
    /** Runs before each request goes to the station. */
    beforeRequest?: () => Promise<void>;
  } = {},
) {
  const issuer = options.issuer ?? fakeIssuer();
  let station: Awaited<ReturnType<typeof fakeStation>> | undefined;
  const { h, host } = setup(
    { mode: "immediate" },
    { derivedPublication: options.derivedPublication ?? true },
    {},
    {
      derivedRoute: {
        control: {
          request: async (message) => {
            await options.beforeRequest?.();
            return unixStationControl(station!.path).request(message);
          },
        },
        issuer,
      },
    },
  );
  station = await fakeStation(h.directory, answer);
  const shim = h.attach("scribe", { sessionId: SESSION });
  await pressure(h, "b-1");
  const sungAt = h.clock.now();
  const push = await offered(h, host, shim, 1);
  await h.call(shim, "ack", { batch_id: push.meta.batch_id });
  return { h, host, shim, station, issuer, sungAt };
}

/** Every op that crossed the station socket: never `sing`. */
const ops = (requests: R[]) => requests.map((request) => request.op);

test("derived: closed by default; nothing goes to the station or the issuer", async () => {
  const { h, station, issuer } = await heard(capable(), {
    derivedPublication: false,
  });
  try {
    const outcome = await h.daemon.derivedPublish(
      "scribe",
      [identity(1)],
      TEXT,
    );
    assert.deepEqual(outcome, {
      state: "closed",
      reason:
        "closed: derived publication is off (config canticle.derivedPublication)",
    });
    assert.deepEqual(station.requests, []);
    assert.deepEqual(issuer.calls, []);
  } finally {
    await station.close();
    h.dispose();
  }
});

test("derived: closed on incomplete or unknown history, before any station call", async () => {
  const { h, host, shim, station, issuer } = await heard(capable());
  try {
    // Offered, never echoed.
    await offered(h, host, shim, 2);
    let outcome = await h.daemon.derivedPublish(
      "scribe",
      [identity(1), identity(2)],
      TEXT,
    );
    assert.deepEqual(outcome, {
      state: "closed",
      reason: "closed: history incomplete: 1 record offered, never echoed",
    });
    // A compaction past what was heard.
    h.clock.advance(1_000);
    await pressure(h, "compact-1", { tokens: null });
    outcome = await h.daemon.derivedPublish("scribe", [identity(1)], TEXT);
    assert.deepEqual(outcome, {
      state: "closed",
      reason:
        "closed: history incomplete: 1 record echoed before the current compaction boundary or by another session",
    });
    // No session holding the ear: unknown.
    shim.close();
    outcome = await h.daemon.derivedPublish("scribe", [identity(1)], TEXT);
    assert.equal(outcome.state, "closed");
    assert.match(
      (outcome as { reason: string }).reason,
      /^closed: history unknown: no session holds the ear/u,
    );
    assert.deepEqual(station.requests, [], "not even the capability probe");
    assert.deepEqual(issuer.calls, []);
  } finally {
    await station.close();
    h.dispose();
  }
});

test("derived: closed without the station's derived capability, with the station's own reason; the probe is a side-effect-free derived_query", async () => {
  for (const [answer, reason] of [
    [
      { ok: false, error: "derived publication is not configured" },
      "derived publication is not configured",
    ],
    [
      { ok: false, error: "unknown op 'derived_query'" },
      "unknown op 'derived_query'",
    ],
    [{ ok: false, error: "peer_identity" }, "peer_identity"],
    ["not json\n", "no answer from the station (its answer wasn't JSON)"],
  ] as const) {
    const { h, station, issuer } = await heard(() => answer);
    try {
      const outcome = await h.daemon.derivedPublish(
        "scribe",
        [identity(1)],
        TEXT,
      );
      assert.deepEqual(
        outcome,
        {
          state: "closed",
          reason: `closed: the station's control socket doesn't offer derived publication: ${reason}`,
        },
        reason,
      );
      assert.deepEqual(station.requests, [PROBE], reason);
      assert.deepEqual(issuer.calls, [], reason);
    } finally {
      await station.close();
      h.dispose();
    }
  }

  // No station listening at all.
  const { h, station, issuer } = await heard(capable());
  await station.close();
  try {
    const outcome = await h.daemon.derivedPublish(
      "scribe",
      [identity(1)],
      TEXT,
    );
    assert.equal(outcome.state, "closed");
    assert.match(
      (outcome as { reason: string }).reason,
      /^closed: the station's control socket doesn't offer derived publication: no answer from the station \(/u,
    );
    assert.deepEqual(issuer.calls, []);
  } finally {
    h.dispose();
  }
});

test("derived: when every condition holds, the issuer gets the exact lineage and the station exactly derived_publish {op, capsule_b64, text}; never sing", async () => {
  const { h, host, shim, station, issuer, sungAt } = await heard(capable());
  try {
    // A second source the station scoped to its host only: the audience narrows to it.
    const secondAt = h.clock.now();
    const push = await offered(h, host, shim, 2, { scope: "host" });
    await h.call(shim, "ack", { batch_id: push.meta.batch_id });

    const outcome = await h.daemon.derivedPublish(
      "scribe",
      [identity(1), identity(2)],
      TEXT,
    );
    assert.deepEqual(outcome, {
      state: "accepted",
      electionId: ELECTION,
      acceptance: ACCEPTANCE,
    });
    const source = (seq: number, at: number, scope: string) => ({
      identity: identity(seq),
      digest: digestOf(seq),
      station: "ops",
      stream: "ops.fleet",
      keyId: OPS,
      epoch: 7,
      seq: String(seq),
      scope,
      class: "advisory",
      hop: 0,
      principal: null,
      root: null,
      expiresAt: at + 300_000 + 5_000,
      wakeDerived: false,
    });
    assert.deepEqual(issuer.calls, [
      {
        lineage: {
          ear: "scribe",
          author: { ear: "scribe", sessionId: SESSION },
          audience: { scope: "host" },
          payloadSha256: sha256(TEXT),
          sources: [source(1, sungAt, "lan"), source(2, secondAt, "host")],
        },
        text: TEXT,
      },
    ]);
    assert.deepEqual(station.requests, [
      PROBE,
      {
        op: "derived_publish",
        capsule_b64: Buffer.from(issuer.capsule!).toString("base64"),
        text: TEXT,
      },
    ]);
    assert.ok(!ops(station.requests).includes("sing"));
    // What crossed the socket carries no lineage field of its own: it's in the capsule.
    assert.deepEqual(Object.keys(station.requests[1]!).sort(), [
      "capsule_b64",
      "op",
      "text",
    ]);

    const [row] = h.store.derivedPublications("scribe");
    assert.ok(row);
    assert.deepEqual(
      {
        sessionId: row.sessionId,
        electionId: row.electionId,
        sources: row.sources,
        audience: row.audience,
        payloadSha256: row.payloadSha256,
        state: row.state,
        acceptance: row.acceptance,
      },
      {
        sessionId: SESSION,
        electionId: ELECTION,
        sources: [
          { identity: identity(1), digest: digestOf(1) },
          { identity: identity(2), digest: digestOf(2) },
        ],
        audience: "host",
        payloadSha256: sha256(TEXT),
        state: "accepted",
        acceptance: ACCEPTANCE,
      },
    );
    assert.ok(
      !JSON.stringify(h.store.derivedPublications("scribe")).includes(TEXT),
      "never the published text",
    );
  } finally {
    await station.close();
    h.dispose();
  }
});

test("derived: custody is judged again after every wait: a compaction while the station is probed, or while the capsule is issued, stops the publish before the station gets it", async () => {
  const compaction =
    "closed: history incomplete: 1 record echoed before the current compaction boundary or by another session";
  {
    let during: (() => Promise<void>) | undefined;
    const { h, station, issuer } = await heard(capable(), {
      beforeRequest: async () => during?.(),
    });
    try {
      during = async () => {
        during = undefined;
        h.clock.advance(1_000);
        await pressure(h, "compact-1", { tokens: null });
      };
      assert.deepEqual(
        await h.daemon.derivedPublish("scribe", [identity(1)], TEXT),
        { state: "closed", reason: compaction },
      );
      assert.deepEqual(station.requests, [PROBE]);
      assert.deepEqual(issuer.calls, []);
    } finally {
      await station.close();
      h.dispose();
    }
  }
  {
    let harnessed: Harness | undefined;
    const issuer = fakeIssuer(undefined, async () => {
      harnessed!.clock.advance(1_000);
      await pressure(harnessed!, "compact-1", { tokens: null });
    });
    const { h, station } = await heard(capable(), { issuer });
    harnessed = h;
    try {
      assert.deepEqual(
        await h.daemon.derivedPublish("scribe", [identity(1)], TEXT),
        {
          state: "refused",
          electionId: ELECTION,
          reason: `custody moved while the capsule was issued (${compaction}); election ${ELECTION} is left unpublished`,
        },
      );
      assert.deepEqual(station.requests, [PROBE], "no derived_publish");
      const [row] = h.store.derivedPublications("scribe");
      assert.deepEqual([row!.state, row!.electionId], ["refused", ELECTION]);
    } finally {
      await station.close();
      h.dispose();
    }
  }
});

test("derived: a lost reply leaves the election unknown, and recovery is derived_query for the same election, never a second publish", async () => {
  const { h, station } = await heard(capable("drop"));
  try {
    const outcome = await h.daemon.derivedPublish(
      "scribe",
      [identity(1)],
      TEXT,
    );
    assert.equal(outcome.state, "unknown");
    assert.equal((outcome as { electionId: string }).electionId, ELECTION);
    assert.match(
      (outcome as { reason: string }).reason,
      /no answer from the station .*; query election 5e1ec7ed5e1ec7ed5e1ec7ed5e1ec7ed, never publish it again/u,
    );
    assert.equal(h.store.derivedPublications("scribe")[0]!.state, "unknown");
    // A crash now keeps it so.
    const reopened = new EventStore(join(h.directory, "ear.db"), h.clock);
    assert.equal(reopened.derivedPublications("scribe")[0]!.state, "unknown");
    reopened.close();

    const answer = await h.daemon.derivedQuery("scribe", ELECTION);
    assert.deepEqual(answer, {
      ok: true,
      election_id: ELECTION,
      state: "accepted",
      acceptance: ACCEPTANCE,
    });
    assert.deepEqual(ops(station.requests), [
      "derived_query",
      "derived_publish",
      "derived_query",
    ]);
    assert.deepEqual(station.requests.at(-1), {
      op: "derived_query",
      election_id: ELECTION,
    });
    const row = h.store.derivedPublications("scribe")[0]!;
    assert.deepEqual([row.state, row.acceptance], ["accepted", ACCEPTANCE]);
    await assert.rejects(
      h.daemon.derivedQuery("scribe", "not-an-election"),
      /election_id is 32 lowercase hex digits/u,
    );
  } finally {
    await station.close();
    h.dispose();
  }
});

test("derived: a station or issuer refusal is recorded with its reason and nothing more is tried", async () => {
  {
    const { h, station } = await heard(
      capable({ ok: false, error: "claim_consumed" }),
    );
    try {
      const outcome = await h.daemon.derivedPublish(
        "scribe",
        [identity(1)],
        TEXT,
      );
      assert.deepEqual(outcome, {
        state: "refused",
        electionId: ELECTION,
        reason: "the station refused: claim_consumed",
      });
      assert.deepEqual(ops(station.requests), [
        "derived_query",
        "derived_publish",
      ]);
      assert.equal(h.store.derivedPublications("scribe")[0]!.state, "refused");
    } finally {
      await station.close();
      h.dispose();
    }
  }
  {
    const issuer = fakeIssuer("history_unknown");
    const { h, station } = await heard(capable(), { issuer });
    try {
      const outcome = await h.daemon.derivedPublish(
        "scribe",
        [identity(1)],
        TEXT,
      );
      assert.deepEqual(outcome, {
        state: "refused",
        electionId: null,
        reason: "the issuer refused: history_unknown",
      });
      assert.deepEqual(station.requests, [PROBE]);
      assert.equal(issuer.calls.length, 1);
    } finally {
      await station.close();
      h.dispose();
    }
  }
});

test("derived: closed with no route wired, on a payload outside 1 to 800 UTF-8 bytes, and for a source whose custody kept no lineage", async () => {
  // No route: the default daemon (cli.ts wires none).
  const { h: bare, host } = setup(
    { mode: "immediate" },
    { derivedPublication: true },
  );
  try {
    const shim = bare.attach("scribe", { sessionId: SESSION });
    await pressure(bare, "b-1");
    const push = await offered(bare, host, shim, 1);
    await bare.call(shim, "ack", { batch_id: push.meta.batch_id });
    assert.deepEqual(
      await bare.daemon.derivedPublish("scribe", [identity(1)], TEXT),
      {
        state: "closed",
        reason:
          "closed: no derived-publication route: the owner's issuer and station control socket aren't wired into this daemon",
      },
    );
  } finally {
    bare.dispose();
  }

  const { h, station, issuer } = await heard(capable());
  try {
    for (const text of ["", "é".repeat(401)]) {
      assert.deepEqual(
        await h.daemon.derivedPublish("scribe", [identity(1)], text),
        {
          state: "closed",
          reason:
            "closed: the derived text must be 1 to 800 UTF-8 bytes (binary-canticle#162)",
        },
      );
    }
    // Custody written before frond-ear kept lineage (an upgraded store).
    const database = new DatabaseSync(join(h.directory, "ear.db"));
    database.exec("UPDATE canticle_custody SET lineage = NULL");
    database.close();
    assert.deepEqual(
      await h.daemon.derivedPublish("scribe", [identity(1)], TEXT),
      {
        state: "closed",
        reason:
          "closed: custody kept no lineage (scope, class, hop) for 1 source record",
      },
    );
    assert.deepEqual(station.requests, []);
    assert.deepEqual(issuer.calls, []);
  } finally {
    await station.close();
    h.dispose();
  }
});

test("derived: custody keeps each exposure's verified lineage, from a push and from hear alike, and an older store gains the column in place", async () => {
  const { h, shim, station } = await heard(capable());
  try {
    await h.call(shim, "hear", {});
    const rows = h.store.canticleCustody("scribe", 0);
    assert.deepEqual(
      rows.map((row) => [row.path, row.lineage?.scope, row.lineage?.class]),
      [
        ["immediate", "lan", "advisory"],
        ["hear", "lan", "advisory"],
      ],
    );
  } finally {
    await station.close();
    h.dispose();
  }

  // A store from before the lineage column: it gains it, older rows reading null.
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-lineage-"));
  try {
    const path = join(directory, "ear.db");
    new EventStore(path).close();
    const database = new DatabaseSync(path);
    database.exec("ALTER TABLE canticle_custody DROP COLUMN lineage");
    database.exec(
      `INSERT INTO canticle_custody (ear, path, mode, generation, identity, station, stream,
         key_id, epoch, seq, shown, claimed_at)
       VALUES ('scribe', 'hear', 'off', 1, 'k:1:s:1', 'ops', 's', 'k', 1, '1', 'whole', 1)`,
    );
    database.close();
    const upgraded = new EventStore(path);
    assert.equal(upgraded.canticleCustody("scribe", 0)[0]!.lineage, null);
    upgraded.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
