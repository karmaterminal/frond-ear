// binary-canticle#176 decision 1: which heard records may wake a session. `wakeKeys` entries
// carry the classes allowed to wake; a bare key means alarm only, and only where the
// manifest grants that key alarm. Every other class from a listed key is delivered without
// a wake: hear still reads it, ear_status counts it `wake_withheld:<class>`, and the next
// push's coverage note names it as a local omission. A prince may opt in to more classes on
// one station:stream with `wake_grant`, for a TTL; nothing a station sends can make, extend
// or widen one, and a grant frond-ear can't prove is discarded. Every other gate still holds.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { HearView } from "../src/canticle/receptor.ts";
import { MAX_LIVE } from "../src/canticle/records.ts";
import {
  ALPHA,
  canticleConfig,
  confirm,
  Host,
  OPS,
  order,
  pushes,
  type R,
  SESSION,
  setup,
  status,
} from "./canticle-host.ts";
import { harness, testConfig, type Harness } from "./helpers.ts";

/** An alarm: keyed (§6.2), so it carries a state_key. */
const ALARM = { class: "alarm", stateKey: "fire" } as const;
const AMBIENT = { class: "ambient" } as const;

const withheldLine = (stream: string, cls: string, n = 1) =>
  new RegExp(
    `^- ${stream.replace(/\./gu, "\\.")}: ${n} .*\\(wake_withheld:${cls}; heard `,
    "mu",
  );

async function grant(h: Harness, shim: ReturnType<Harness["attach"]>, args: R) {
  return h.call(shim, "wake_grant", args);
}

test("#176 proof 1: an ambient record from a bare wakeKeys key does not wake; it stays readable with hear and is counted wake_withheld:ambient", async () => {
  const { h, host } = setup({ mode: "immediate" }, { wakeKeys: [OPS] });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1, { ...AMBIENT, text: "the bellwether bell rings" });
    h.timers.advance(10_000);
    assert.equal(pushes(shim).length, 0, "no wake");
    assert.equal(status(h).counts["wake_withheld:ambient"], 1);
    assert.equal(status(h).waiting, 0, "not waiting for a push either");
    // Its pull custody is unchanged: hear reads it while it is live.
    assert.match(
      (await h.call(shim, "hear", {})).text,
      /> the bellwether bell rings/u,
    );
    // Still nothing later, the record still on air.
    h.timers.advance(120_000);
    assert.equal(pushes(shim).length, 0);
    assert.equal(
      status(h).counts["wake_withheld:ambient"],
      1,
      "counted once, however many passes read it",
    );
  } finally {
    h.dispose();
  }
});

test("#176 proof 2: a verified alarm from the same bare key wakes; its push names the withheld ambient as a local omission, never as heard", async () => {
  const { h, host } = setup({ mode: "immediate" }, { wakeKeys: [OPS] });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1, AMBIENT);
    h.timers.advance(10_000);
    host.sing(2, ALARM);
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1, "the alarm wakes");
    const push = pushes(shim)[0]!;
    assert.deepEqual(order(push.content), ["ops:ops.fleet/2"]);
    assert.match(push.content, / class=alarm /u);
    assert.doesNotMatch(push.content, / class=ambient /u);
    assert.match(push.content, withheldLine("ops:ops.fleet", "ambient"));
    assert.match(push.content, /not a sign it was seen/u);
    // wake_withheld is an attention decision, not a receipt: no custody of the ambient.
    await confirm(shim);
    const custody = JSON.parse(
      (await h.call(shim, "canticle_custody", {})).text,
    ) as { records: Array<{ item: string; state: string }> };
    assert.deepEqual(
      custody.records.map(({ item, state }) => ({ item, state })),
      [{ item: "7/2", state: "offered" }],
      "the alarm only: the withheld ambient was neither offered nor heard",
    );
  } finally {
    h.dispose();
  }
});

test("#176 proof 1: an ambient flood from a bare key that overflows the live set wakes nobody: what it dropped owes no push of its own and rides with the next push that goes", async () => {
  const { h, host } = setup(
    { mode: "immediate", maxPushesPerHour: 360 },
    { wakeKeys: [OPS] },
  );
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    for (let n = 1; n <= MAX_LIVE + 50; n++) {
      host.sing(n, { ...AMBIENT, stream: "ops.deploy", ttlMs: 3_600_000 });
    }
    h.timers.advance(60_000);
    assert.equal(pushes(shim).length, 0, "no wake, not even for the note");
    assert.equal(status(h).counts.live_overflow, 50);
    assert.equal(status(h).counts["wake_withheld:ambient"], MAX_LIVE);
    h.timers.advance(120_000);
    assert.equal(pushes(shim).length, 0);
    host.sing(1, ALARM);
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1, "the alarm wakes");
    const push = pushes(shim)[0]!.content;
    assert.deepEqual(order(push), ["ops:ops.fleet/1"]);
    assert.match(
      push,
      /^- ops:ops\.deploy: 50 dropped by frond-ear's full live set \(live_overflow; /mu,
    );
    assert.match(push, withheldLine("ops:ops.deploy", "ambient", MAX_LIVE));
  } finally {
    h.dispose();
  }
});

/**
 * A host whose view says what the manifest grants each key, as the embedded receptor's
 * does: `caps` per key, live (a test may take a class away, as a manifest reload would).
 */
function capable(
  caps: Map<string, Set<string>>,
  delivery: unknown,
  canticle: R,
): { h: Harness; host: Host } {
  let host: Host | undefined;
  const h = harness(canticleConfig(delivery, canticle), {
    canticleHear: (): HearView => ({
      ...host!.view(),
      capability: (key: string) => caps.get(key.toLowerCase()),
    }),
  });
  host = new Host(h.clock);
  host.start();
  return { h, host };
}

test("#176 proof 3 (🌿's MUST): alarms from a bare key the manifest doesn't grant alarm, dropped by a full live set, owe no push of its own; the next legitimate push tells it", async () => {
  const caps = new Map([
    [OPS, new Set(["advisory", "ambient"])],
    [ALPHA, new Set(["alarm"])],
  ]);
  const { h, host } = capable(
    caps,
    { mode: "immediate", maxPushesPerHour: 360 },
    { wakeKeys: [OPS, ALPHA] },
  );
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    for (let n = 1; n <= MAX_LIVE + 50; n++) {
      host.sing(n, {
        ...ALARM,
        stateKey: `fire-${n}`,
        stream: "ops.deploy",
        ttlMs: 3_600_000,
      });
    }
    h.timers.advance(60_000);
    assert.equal(pushes(shim).length, 0, "no wake, not even for the note");
    assert.equal(status(h).counts.live_overflow, 50);
    assert.equal(status(h).counts.not_capable, MAX_LIVE);
    h.timers.advance(120_000);
    assert.equal(pushes(shim).length, 0);
    host.sing(1, { ...ALARM, station: "alpha" });
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1, "the capable alarm wakes");
    assert.match(
      pushes(shim)[0]!.content,
      /^- ops:ops\.deploy: 50 dropped by frond-ear's full live set \(live_overflow; /mu,
    );
  } finally {
    h.dispose();
  }
});

test("#176 proof 3 (🌿's MUST): an alarm the push budget held, whose key lost alarm in the manifest before it went off air, owes no push of its own; the next legitimate push tells it", async () => {
  const caps = new Map([
    [OPS, new Set(["alarm"])],
    [ALPHA, new Set(["alarm"])],
  ]);
  const { h, host } = capable(
    caps,
    { mode: "immediate", maxItems: 1, maxPushesPerHour: 1 },
    { wakeKeys: [OPS, ALPHA] },
  );
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1, { ...ALARM, stateKey: "fire-1", ttlMs: 10_000 });
    host.sing(2, { ...ALARM, stateKey: "fire-2", ttlMs: 10_000 });
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1, "one carried, one promised");
    assert.match(pushes(shim)[0]!.content, /1 more record waits/u);
    await confirm(shim);
    h.timers.advance(3_500); // 9.5 s: still on air, still held, still capable
    // The manifest stops granting OPS alarm in the same poll interval the promised one
    // goes off air under the spent budget: the off-air pass sees it before any re-check.
    caps.get(OPS)!.delete("alarm");
    h.timers.advance(8_500);
    assert.equal(status(h).counts.off_air_unpushed, 1);
    h.timers.advance(3_600_000); // the budget frees
    assert.equal(pushes(shim).length, 1, "no wake for the note");
    host.sing(1, { ...ALARM, station: "alpha" });
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 2, "the capable alarm wakes");
    assert.match(
      pushes(shim)[1]!.content,
      /^- ops:ops\.fleet: 1 went off air unpushed while the hour's push budget was spent \(push_budget; /mu,
    );
  } finally {
    h.dispose();
  }
});

test("#176 proof 3 (🪨's negative): a verified alarm from a bare key the manifest doesn't grant alarm does not wake; granted alarm, the same record does", async () => {
  for (const granted of [false, true]) {
    let host: Host | undefined;
    const classes = new Set(granted ? ["advisory", "alarm"] : ["advisory"]);
    const h = harness(
      canticleConfig({ mode: "immediate" }, { wakeKeys: [OPS] }),
      {
        // The embedded receptor's view says what its manifest grants each key.
        canticleHear: (): HearView => ({
          ...host!.view(),
          capability: (key: string) =>
            key.toLowerCase() === OPS ? classes : undefined,
        }),
      },
    );
    host = new Host(h.clock);
    host.start();
    try {
      const shim = h.attach("scribe", { sessionId: SESSION });
      host.sing(1, ALARM);
      h.timers.advance(10_000);
      assert.equal(pushes(shim).length, granted ? 1 : 0, `granted=${granted}`);
      if (!granted) {
        assert.equal(status(h).counts.not_capable, 1);
        assert.equal(status(h).counts["wake_withheld:alarm"], undefined);
      }
    } finally {
      h.dispose();
    }
  }
});

test("#176 proof 3, host daemon: an alarm the host admitted as capability_exceeded never reaches delivery, so never wakes", async () => {
  const { h, host } = setup({ mode: "immediate" }, { wakeKeys: [OPS] });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1, { ...ALARM, admission: "capability_exceeded" });
    h.timers.advance(10_000);
    assert.equal(pushes(shim).length, 0);
  } finally {
    h.dispose();
  }
});

test("#176: a wakeKeys entry with classes wakes for those classes only; alarm is not implied once classes are named", async () => {
  const { h, host } = setup(
    { mode: "immediate" },
    { wakeKeys: [{ key: OPS, classes: ["advisory"] }, ALPHA] },
  );
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1); // advisory
    host.sing(2, ALARM);
    host.sing(3, { ...AMBIENT, station: "alpha" });
    h.timers.advance(10_000);
    assert.equal(pushes(shim).length, 1);
    assert.deepEqual(order(pushes(shim)[0]!.content), ["ops:ops.fleet/1"]);
    assert.equal(status(h).counts["wake_withheld:alarm"], 1);
    assert.equal(status(h).counts["wake_withheld:ambient"], 1);
  } finally {
    h.dispose();
  }
});

test("#176 proof 4: a wake_grant for ambient on one station:stream wakes for that stream only, and stops after its TTL", async () => {
  const { h, host } = setup({ mode: "immediate" }, { wakeKeys: [OPS, ALPHA] });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const granted = await grant(h, shim, {
      stream: "ops:ops.fleet",
      classes: ["ambient"],
      ttl_seconds: 600,
    });
    assert.equal(granted.ok, true, granted.text);
    const expiresAt = h.clock.now() + 600_000;
    assert.deepEqual(JSON.parse(granted.text).grants, [
      { stream: "ops:ops.fleet", classes: ["ambient"], expiresAt },
    ]);
    host.sing(1, AMBIENT);
    host.sing(2, { ...AMBIENT, stream: "ops.deploy" });
    host.sing(3, { ...AMBIENT, station: "alpha" });
    h.timers.advance(10_000);
    assert.equal(pushes(shim).length, 1, "the granted stream wakes");
    assert.deepEqual(order(pushes(shim)[0]!.content), ["ops:ops.fleet/1"]);
    assert.equal(status(h).counts["wake_withheld:ambient"], 2);
    await confirm(shim);
    assert.deepEqual(
      (status(h) as unknown as { wakeGrants: unknown }).wakeGrants,
      [{ stream: "ops:ops.fleet", classes: ["ambient"], expiresAt }],
    );
    // Past its TTL: the same stream's next ambient record doesn't wake.
    h.clock.value = expiresAt;
    host.sing(4, AMBIENT);
    h.timers.advance(10_000);
    assert.equal(pushes(shim).length, 1, "the grant lapsed");
    assert.equal(status(h).counts["wake_withheld:ambient"], 3);
    assert.deepEqual(
      (status(h) as unknown as { wakeGrants: unknown }).wakeGrants,
      [],
    );
  } finally {
    h.dispose();
  }
});

test("#176 proof 4: a record waiting under a grant that lapses before its push is withheld then, and owes no push of its own", async () => {
  const { h, host } = setup(
    { mode: "digest", windowMs: 60_000 },
    { wakeKeys: [OPS] },
  );
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await grant(h, shim, {
      stream: "ops:ops.fleet",
      classes: ["ambient"],
      ttl_seconds: 30,
    });
    host.sing(1, AMBIENT);
    h.timers.advance(2_000);
    assert.equal(status(h).waiting, 1, "waits for the report under the grant");
    h.timers.advance(40_000); // the grant lapses before the window closes
    assert.equal(status(h).waiting, 0);
    h.timers.advance(3_600_000);
    assert.equal(pushes(shim).length, 0, "nothing wakes after the TTL");
    assert.equal(status(h).counts["wake_withheld:ambient"], 1);
  } finally {
    h.dispose();
  }
});

test("#176 proof 4: what a grant let wake and the push budget held until it went off air owes no push of its own: nothing wakes the ear once the grant lapses, and the next push that goes tells it", async () => {
  const { h, host } = setup(
    { mode: "immediate", maxItems: 1, maxPushesPerHour: 1 },
    { wakeKeys: [OPS] },
  );
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await grant(h, shim, {
      stream: "ops:ops.fleet",
      classes: ["ambient"],
      ttl_seconds: 600,
    });
    host.sing(1, { ...AMBIENT, ttlMs: 10_000 });
    host.sing(2, { ...AMBIENT, ttlMs: 10_000 });
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1, "one carried, one promised");
    assert.match(pushes(shim)[0]!.content, /1 more record waits/u);
    await confirm(shim);
    h.timers.advance(12_000); // the promised one goes off air under the spent budget
    assert.equal(status(h).counts.off_air_unpushed, 1);
    h.timers.advance(3_600_000); // the grant lapses, then the budget frees
    assert.equal(pushes(shim).length, 1, "no wake for the note");
    host.sing(3, ALARM);
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 2, "the alarm wakes");
    assert.match(
      pushes(shim)[1]!.content,
      /^- ops:ops\.fleet: 1 went off air unpushed while the hour's push budget was spent \(push_budget; /mu,
    );
  } finally {
    h.dispose();
  }
});

test("#176 proof 4: a grant asks for a TTL within bounds, exact station:stream and known classes, and only the attached session with an id can make one", async () => {
  const { h } = setup({ mode: "immediate" }, { wakeKeys: [OPS] });
  try {
    const anonymous = h.attach("scribe");
    const refused = await grant(h, anonymous, {
      stream: "ops:ops.fleet",
      classes: ["ambient"],
      ttl_seconds: 60,
    });
    assert.equal(refused.ok, false);
    assert.match(refused.text, /session's id/u);
    anonymous.close();
    const shim = h.attach("scribe", { sessionId: SESSION });
    for (const [args, why] of [
      [{ stream: "ops:ops.fleet", classes: ["ambient"] }, /ttl_seconds/u],
      [
        { stream: "ops:ops.fleet", classes: ["ambient"], ttl_seconds: 86_401 },
        /ttl_seconds/u,
      ],
      [
        { stream: "*:ops.fleet", classes: ["ambient"], ttl_seconds: 60 },
        /stream/u,
      ],
      [
        { stream: "ops:ops.fleet", classes: ["gossip"], ttl_seconds: 60 },
        /class/u,
      ],
      [{ stream: "ops:ops.fleet", classes: [], ttl_seconds: 60 }, /class/u],
    ] as Array<[R, RegExp]>) {
      const result = await grant(h, shim, args);
      assert.equal(result.ok, false, JSON.stringify(args));
      assert.match(result.text, why);
    }
    const tap = h.attach("scribe", { role: "tap" } as never);
    const tapped = await grant(h, tap, {
      stream: "ops:ops.fleet",
      classes: ["ambient"],
      ttl_seconds: 60,
    });
    assert.equal(tapped.ok, false);
  } finally {
    h.dispose();
  }
});

test("#176 proof 4: a grant is revoked by the session, and discarded when another session holds the ear", async () => {
  const { h, host } = setup({ mode: "immediate" }, { wakeKeys: [OPS] });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await grant(h, shim, {
      stream: "ops:ops.fleet",
      classes: ["ambient"],
      ttl_seconds: 600,
    });
    const revoked = await grant(h, shim, {
      stream: "ops:ops.fleet",
      revoke: true,
    });
    assert.equal(revoked.ok, true, revoked.text);
    assert.deepEqual(JSON.parse(revoked.text).grants, []);
    host.sing(1, AMBIENT);
    h.timers.advance(10_000);
    assert.equal(pushes(shim).length, 0, "revoked");

    await grant(h, shim, {
      stream: "ops:ops.fleet",
      classes: ["ambient"],
      ttl_seconds: 600,
    });
    shim.close();
    // A rebind: a different session takes the ear. The grant was the other one's act.
    const other = h.attach("scribe", {
      sessionId: "22222222-bbbb-4bbb-8bbb-000000000002",
    });
    host.sing(2, AMBIENT);
    h.timers.advance(10_000);
    assert.equal(pushes(other).length, 0, "discarded on rebind");
    assert.equal(status(h).counts.wake_grant_discarded, 1);
    assert.equal(h.store.canticleWakeGrants("scribe").length, 0, "gone");
  } finally {
    h.dispose();
  }
});

test("#176 proof 4: another holder taking the ear discards its grants at the attach, so an A -> B -> A rebind before any poll leaves A no grant; a session with no id counts as another holder", async () => {
  for (const between of [
    { sessionId: "22222222-bbbb-4bbb-8bbb-000000000002" },
    {}, // a shim that gave no session id
  ]) {
    const { h, host } = setup({ mode: "immediate" }, { wakeKeys: [OPS] });
    try {
      const a = h.attach("scribe", { sessionId: SESSION });
      const granted = await grant(h, a, {
        stream: "ops:ops.fleet",
        classes: ["ambient"],
        ttl_seconds: 600,
      });
      assert.equal(granted.ok, true, granted.text);
      // B takes the ear, then A takes it back, with no delivery poll in between.
      h.attach("scribe", between);
      const rowsAtB = h.store.canticleWakeGrants("scribe").length;
      const again = h.attach("scribe", { sessionId: SESSION });
      host.sing(1, AMBIENT);
      h.timers.advance(10_000);
      assert.equal(
        pushes(again).length,
        0,
        `A's grant didn't cross B's hold (${JSON.stringify(between)})`,
      );
      assert.equal(rowsAtB, 0, "gone at B's attach, before any poll");
      assert.equal(status(h).counts.wake_grant_discarded, 1);
      assert.equal(status(h).counts["wake_withheld:ambient"], 1);
    } finally {
      h.dispose();
    }
  }
});

test("#176 proof 4: the attached shim turning to another session discards the grants too, so A -> B -> A by session change before any poll leaves A no grant", async () => {
  const { h, host } = setup({ mode: "immediate" }, { wakeKeys: [OPS] });
  try {
    const a = h.attach("scribe", { sessionId: SESSION });
    await grant(h, a, {
      stream: "ops:ops.fleet",
      classes: ["ambient"],
      ttl_seconds: 600,
    });
    await a.send({
      type: "session",
      sessionId: "22222222-bbbb-4bbb-8bbb-000000000002",
    });
    const rowsAtB = h.store.canticleWakeGrants("scribe").length;
    await a.send({ type: "session", sessionId: SESSION });
    host.sing(1, AMBIENT);
    h.timers.advance(10_000);
    assert.equal(pushes(a).length, 0, "A's grant didn't cross B's hold");
    assert.equal(rowsAtB, 0, "gone at the session change, before any poll");
    assert.equal(status(h).counts.wake_grant_discarded, 1);
  } finally {
    h.dispose();
  }
});

/** A seat's SessionStart hook naming `sessionId` for scribe's ear, as the CLI sends it. */
async function release(h: Harness, sessionId: string, source = "clear") {
  const cli = h.attach(undefined, { role: "cli" });
  await cli.send({ type: "release", id: 1, ear: "scribe", source, sessionId });
  const result = cli.connection.results().find((item) => item.id === 1);
  cli.close();
  return result;
}

test("#176 proof 4: while the session holding the ear is in doubt (a hook names a session frond-ear can't tie to the shim), its grants are discarded and no new one is made, so no grant crosses into or out of the doubt", async () => {
  const { h, host } = setup({ mode: "immediate" }, { wakeKeys: [OPS] });
  try {
    const a = h.attach("scribe", { sessionId: SESSION });
    const granted = await grant(h, a, {
      stream: "ops:ops.fleet",
      classes: ["ambient"],
      ttl_seconds: 600,
    });
    assert.equal(granted.ok, true, granted.text);
    // A hook names C, with no CLAUDE_PID to tie it to this shim: in doubt.
    const doubt = await release(h, "33333333-cccc-4ccc-8ccc-000000000003");
    assert.match(doubt?.text ?? "", /in doubt/u);
    const rowsAtDoubt = h.store.canticleWakeGrants("scribe").length;
    host.sing(1, AMBIENT);
    h.timers.advance(10_000);
    assert.equal(pushes(a).length, 0, "no grant wakes a session in doubt");
    assert.equal(rowsAtDoubt, 0, "gone as the doubt began, before any poll");
    assert.equal(status(h).counts.wake_grant_discarded, 1);
    // Nor can one be made while the doubt holds.
    const during = await grant(h, a, {
      stream: "ops:ops.fleet",
      classes: ["ambient"],
      ttl_seconds: 600,
    });
    assert.equal(during.ok, false, during.text);
    assert.match(during.text, /in doubt/u);
    assert.equal(h.store.canticleWakeGrants("scribe").length, 0);
    // A's own hook ends the doubt; a grant made after it is A's again.
    await release(h, SESSION, "resume");
    const after = await grant(h, a, {
      stream: "ops:ops.fleet",
      classes: ["ambient"],
      ttl_seconds: 600,
    });
    assert.equal(after.ok, true, after.text);
    host.sing(2, AMBIENT);
    h.timers.advance(10_000);
    assert.equal(pushes(a).length, 1, "a grant made after the doubt wakes");
  } finally {
    h.dispose();
  }
});

test("#176 proof 4: the same session reattaching (compaction, resume) keeps its grant", async () => {
  const { h, host } = setup({ mode: "immediate" }, { wakeKeys: [OPS] });
  try {
    const a = h.attach("scribe", { sessionId: SESSION });
    await grant(h, a, {
      stream: "ops:ops.fleet",
      classes: ["ambient"],
      ttl_seconds: 600,
    });
    a.close();
    const again = h.attach("scribe", { sessionId: SESSION });
    assert.equal(h.store.canticleWakeGrants("scribe").length, 1);
    host.sing(1, AMBIENT);
    h.timers.advance(10_000);
    assert.equal(pushes(again).length, 1, "the same session's grant holds");
    assert.equal(status(h).counts.wake_grant_discarded, undefined);
  } finally {
    h.dispose();
  }
});

test("#176 proof 4: across a restart a grant the same session can prove holds; one whose expiry can't be proved (the clock went back) is discarded", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-grant-"));
  const path = join(directory, "ear.db");
  const delivery = { mode: "immediate" };
  try {
    let grantedAt: number;
    const first = setup(delivery, { wakeKeys: [OPS] }, {}, { path });
    try {
      const shim = first.h.attach("scribe", { sessionId: SESSION });
      grantedAt = first.h.clock.now() + 50_000;
      first.h.clock.value = grantedAt;
      const result = await grant(first.h, shim, {
        stream: "ops:ops.fleet",
        classes: ["ambient"],
        ttl_seconds: 600,
      });
      assert.equal(result.ok, true, result.text);
    } finally {
      first.h.dispose();
    }
    // Restarted later, inside the TTL, the same session resumed: provable, so it holds.
    const second = setup(delivery, { wakeKeys: [OPS] }, {}, { path });
    try {
      second.h.clock.value = grantedAt + 60_000;
      const shim = second.h.attach("scribe", { sessionId: SESSION });
      second.host.sing(1, AMBIENT);
      second.h.timers.advance(10_000);
      assert.equal(pushes(shim).length, 1, "the same session's grant holds");
    } finally {
      second.h.dispose();
    }
    // Restarted on a clock behind the grant: how long it has run can't be proved.
    const third = setup(delivery, { wakeKeys: [OPS] }, {}, { path });
    try {
      third.h.clock.value = grantedAt - 1_000;
      const shim = third.h.attach("scribe", { sessionId: SESSION });
      third.host.sing(2, AMBIENT);
      third.h.timers.advance(10_000);
      assert.equal(pushes(shim).length, 0, "an unprovable grant is discarded");
      assert.equal(status(third.h).counts.wake_grant_discarded, 1);
      assert.equal(third.h.store.canticleWakeGrants("scribe").length, 0);
      // And it stays discarded once the clock is past the grant again.
      third.h.clock.value = grantedAt + 120_000;
      third.host.sing(3, AMBIENT);
      third.h.timers.advance(10_000);
      assert.equal(pushes(shim).length, 0);
    } finally {
      third.h.dispose();
    }
    // A row that claims more than the longest TTL a grant may have is unprovable too.
    const fourth = setup(delivery, { wakeKeys: [OPS] }, {}, { path });
    try {
      const now = fourth.h.clock.now();
      fourth.h.store.setCanticleWakeGrant({
        ear: "scribe",
        station: "ops",
        stream: "ops.fleet",
        cls: "ambient",
        sessionId: SESSION,
        grantedAt: now - 1_000,
        expiresAt: now + 7 * 86_400_000,
      });
      const shim = fourth.h.attach("scribe", { sessionId: SESSION });
      fourth.host.sing(4, AMBIENT);
      fourth.h.timers.advance(10_000);
      assert.equal(pushes(shim).length, 0);
      assert.equal(status(fourth.h).counts.wake_grant_discarded, 1);
    } finally {
      fourth.h.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("#176 proof 4: a grant held 500 s of 600 does not outlive its TTL across a restart on a clock stepped back 400 s: it is discarded, so nothing wakes 950 s into it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frond-ear-grant-"));
  const path = join(directory, "ear.db");
  const delivery = { mode: "immediate" };
  try {
    let grantedAt: number;
    const first = setup(delivery, { wakeKeys: [OPS] }, {}, { path });
    try {
      const shim = first.h.attach("scribe", { sessionId: SESSION });
      grantedAt = first.h.clock.now() + 500_000;
      first.h.clock.value = grantedAt;
      const result = await grant(first.h, shim, {
        stream: "ops:ops.fleet",
        classes: ["ambient"],
        ttl_seconds: 600,
      });
      assert.equal(result.ok, true, result.text);
      // The grant runs 500 s and wakes the session while it does.
      first.h.timers.advance(490_000);
      first.host.sing(1, AMBIENT);
      first.h.timers.advance(10_000);
      assert.equal(pushes(shim).length, 1, "the grant holds while it runs");
    } finally {
      first.h.dispose();
    }
    // Restarted on the same store with the clock 400 s behind, after the grant was made:
    // its row alone can't tell that 500 s of it already ran.
    const second = setup(delivery, { wakeKeys: [OPS] }, {}, { path });
    try {
      second.h.clock.value = grantedAt + 100_000;
      const shim = second.h.attach("scribe", { sessionId: SESSION });
      second.host.sing(2, AMBIENT);
      second.h.timers.advance(10_000);
      assert.equal(pushes(shim).length, 0, "a stepped-back clock discards it");
      assert.equal(status(second.h).counts.wake_grant_discarded, 1);
      assert.equal(status(second.h).counts["wake_withheld:ambient"], 1);
      assert.equal(second.h.store.canticleWakeGrants("scribe").length, 0);
      assert.deepEqual(
        (status(second.h) as unknown as { wakeGrants: unknown }).wakeGrants,
        [],
      );
      // 450 s on the stepped-back clock (950 s into a 600 s grant): still nothing wakes.
      second.h.clock.value = grantedAt + 540_000;
      second.host.sing(3, AMBIENT);
      second.h.timers.advance(10_000);
      assert.equal(pushes(shim).length, 0);
    } finally {
      second.h.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("#176 proof 4: a clock that steps back mid-run discards every grant, so expiry never rests on a clock that went backwards", async () => {
  const { h, host } = setup({ mode: "immediate" }, { wakeKeys: [OPS] });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const grantedAt = h.clock.now();
    const result = await grant(h, shim, {
      stream: "ops:ops.fleet",
      classes: ["ambient"],
      ttl_seconds: 600,
    });
    assert.equal(result.ok, true, result.text);
    h.timers.advance(300_000);
    assert.deepEqual(
      (status(h) as unknown as { wakeGrants: unknown }).wakeGrants,
      [
        {
          stream: "ops:ops.fleet",
          classes: ["ambient"],
          expiresAt: grantedAt + 600_000,
        },
      ],
    );
    // An NTP step back of 200 s: still after the grant was made, but behind what the
    // daemon already saw while the grant held.
    h.clock.value -= 200_000;
    assert.deepEqual(
      (status(h) as unknown as { wakeGrants: unknown }).wakeGrants,
      [],
      "a step back discards the grant",
    );
    assert.equal(status(h).counts.wake_grant_discarded, 1);
    assert.equal(h.store.canticleWakeGrants("scribe").length, 0);
    // The fake timers keep the absolute time the next poll was due, so run past it: on the
    // stepped-back clock that is 310 s into a 600 s grant, which would still hold.
    host.sing(1, AMBIENT);
    h.timers.advance(210_000);
    assert.equal(
      pushes(shim).length,
      0,
      "nothing the grant let wake wakes now",
    );
    assert.equal(status(h).counts["wake_withheld:ambient"], 1);
  } finally {
    h.dispose();
  }
});

test("#176 proof 4: a clock that steps forward only shortens a grant: a jump past its expiry lapses it for good, and stepping back afterwards brings nothing back", async () => {
  const { h, host } = setup({ mode: "immediate" }, { wakeKeys: [OPS] });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const grantedAt = h.clock.now();
    await grant(h, shim, {
      stream: "ops:ops.fleet",
      classes: ["ambient"],
      ttl_seconds: 600,
    });
    h.timers.advance(100_000);
    h.clock.value = grantedAt + 1_000_000; // a step forward past the grant's expiry
    host.sing(1, AMBIENT);
    h.timers.advance(10_000);
    assert.equal(pushes(shim).length, 0, "lapsed on the stepped clock");
    assert.equal(status(h).counts.wake_grant_lapsed, 1);
    assert.equal(h.store.canticleWakeGrants("scribe").length, 0);
    // Corrected back to 200 s into the grant: the row is gone, so nothing wakes.
    h.clock.value = grantedAt + 200_000;
    host.sing(2, AMBIENT);
    h.timers.advance(1_200_000);
    assert.equal(pushes(shim).length, 0, "a correction doesn't revive it");
  } finally {
    h.dispose();
  }
});

test("#176 proof 4: a forward step later corrected leaves no wake past the TTL: the high-water mark it set discards the grant when the clock comes back", async () => {
  const { h, host } = setup({ mode: "immediate" }, { wakeKeys: [OPS] });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const grantedAt = h.clock.now();
    await grant(h, shim, {
      stream: "ops:ops.fleet",
      classes: ["ambient"],
      ttl_seconds: 600,
    });
    h.timers.advance(100_000);
    // A wrong step forward to 500 s in, still inside the TTL: polls move the mark there.
    h.clock.value = grantedAt + 500_000;
    h.timers.advance(5_000);
    assert.equal(
      (status(h) as unknown as { wakeGrants: unknown[] }).wakeGrants.length,
      1,
      "still inside its TTL",
    );
    // Corrected back to 110 s in: behind the mark, so the grant is discarded, not given
    // the 400 s the wrong step would otherwise hand back.
    h.clock.value = grantedAt + 110_000;
    assert.deepEqual(
      (status(h) as unknown as { wakeGrants: unknown }).wakeGrants,
      [],
    );
    assert.equal(status(h).counts.wake_grant_discarded, 1);
    host.sing(1, AMBIENT);
    h.timers.advance(400_000); // past where the poll was due on the stepped clock
    assert.equal(pushes(shim).length, 0, "no wake past the TTL");
  } finally {
    h.dispose();
  }
});

/**
 * A storage fault on the `chatter` row only, as 🌫's probe injected it (#124 follow-up): the
 * second class of an `ambient, chatter` request fails after the first was written.
 */
function faultSecondClass(h: Harness): void {
  (h.store as unknown as { database: DatabaseSync }).database.exec(`
    CREATE TEMP TRIGGER wake_grant_test_fault
      BEFORE INSERT ON canticle_wake_grants WHEN NEW.class = 'chatter'
      BEGIN SELECT RAISE(ABORT, 'injected on the second class'); END`);
}

test("#176 proof 4: a multi-class wake_grant is one whole: a storage fault on its second class leaves no grant made, so nothing wakes", async () => {
  const { h, host } = setup({ mode: "immediate" }, { wakeKeys: [OPS] });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    faultSecondClass(h);
    const failed = await grant(h, shim, {
      stream: "ops:ops.fleet",
      classes: ["ambient", "chatter"],
      ttl_seconds: 600,
    });
    assert.equal(failed.ok, false, failed.text);
    assert.match(failed.text, /injected on the second class/u);
    assert.deepEqual(
      h.store.canticleWakeGrants("scribe"),
      [],
      "the first class's row went with the failure",
    );
    host.sing(1, AMBIENT);
    h.timers.advance(10_000);
    assert.equal(pushes(shim).length, 0, "no wake from a request that failed");
    assert.equal(status(h).counts["wake_withheld:ambient"], 1);
  } finally {
    h.dispose();
  }
});

test("#176 proof 4: a failed multi-class wake_grant leaves an existing grant exactly as it was: no longer expiry, no moved mark, and it stops waking at its own expiry", async () => {
  const { h, host } = setup({ mode: "immediate" }, { wakeKeys: [OPS] });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const made = await grant(h, shim, {
      stream: "ops:ops.fleet",
      classes: ["ambient"],
      ttl_seconds: 10,
    });
    assert.equal(made.ok, true, made.text);
    const expiresAt = h.clock.now() + 10_000;
    h.timers.advance(2_000);
    // Between polls, so a mark moved by the request itself would show.
    h.clock.value += 500;
    const before = h.store.canticleWakeGrants("scribe");
    assert.equal(before.length, 1);
    assert.equal(before[0]!.expiresAt, expiresAt);
    faultSecondClass(h);
    const failed = await grant(h, shim, {
      stream: "ops:ops.fleet",
      classes: ["ambient", "chatter"],
      ttl_seconds: 600,
    });
    assert.equal(failed.ok, false, failed.text);
    assert.match(failed.text, /injected on the second class/u);
    assert.deepEqual(
      h.store.canticleWakeGrants("scribe"),
      before,
      "the row is byte for byte as it was: expiry, grant time, mark",
    );
    // The grant still holds until its own expiry...
    host.sing(1, AMBIENT);
    h.timers.advance(7_000);
    assert.ok(h.clock.now() < expiresAt);
    assert.equal(pushes(shim).length, 1, "the original grant still wakes");
    await confirm(shim);
    // ...and not past it.
    h.clock.value = expiresAt + 1_000;
    host.sing(2, AMBIENT);
    h.timers.advance(10_000);
    assert.equal(pushes(shim).length, 1, "no wake past the original expiry");
    assert.equal(status(h).counts["wake_withheld:ambient"], 1);
    assert.deepEqual(h.store.canticleWakeGrants("scribe"), []);
  } finally {
    h.dispose();
  }
});

test("#176 proof 4: a multi-class wake_grant that succeeds makes every class it names, and each wakes", async () => {
  const { h, host } = setup({ mode: "immediate" }, { wakeKeys: [OPS] });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const granted = await grant(h, shim, {
      stream: "ops:ops.fleet",
      classes: ["ambient", "chatter"],
      ttl_seconds: 600,
    });
    assert.equal(granted.ok, true, granted.text);
    const expiresAt = h.clock.now() + 600_000;
    assert.deepEqual(JSON.parse(granted.text).grants, [
      { stream: "ops:ops.fleet", classes: ["ambient", "chatter"], expiresAt },
    ]);
    assert.deepEqual(
      h.store.canticleWakeGrants("scribe").map(({ cls }) => cls),
      ["ambient", "chatter"],
    );
    host.sing(1, { class: "chatter" });
    h.timers.advance(10_000);
    assert.equal(pushes(shim).length, 1, "chatter wakes");
    await confirm(shim);
    host.sing(2, AMBIENT);
    h.timers.advance(10_000);
    assert.equal(pushes(shim).length, 2, "ambient wakes");
    assert.deepEqual(order(pushes(shim)[1]!.content), ["ops:ops.fleet/2"]);
  } finally {
    h.dispose();
  }
});

test("store: a wake_grant request's grants are one whole inside a caller's transaction too: a caught fault on one class commits none of them", () => {
  const { h } = setup({ mode: "immediate" }, { wakeKeys: [OPS] });
  try {
    faultSecondClass(h);
    const row = (cls: string) => ({
      ear: "scribe",
      station: "ops",
      stream: "ops.fleet",
      cls,
      sessionId: SESSION,
      grantedAt: 1_000,
      expiresAt: 61_000,
    });
    h.store.atomically(() => {
      h.store.setCanticleWakeGrant(row("alarm"));
      assert.throws(
        () => h.store.setCanticleWakeGrants([row("ambient"), row("chatter")]),
        /injected on the second class/u,
      );
    });
    assert.deepEqual(
      h.store.canticleWakeGrants("scribe").map(({ cls }) => cls),
      ["alarm"],
      "the caller's own write commits; none of the failed request's does",
    );
  } finally {
    h.dispose();
  }
});

test("#176 proof 5: what a station sends can't ask for a wake, make or extend a grant, or change a record's class", async () => {
  const { h, host } = setup({ mode: "immediate" }, { wakeKeys: [OPS] });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const asks: R = {
      wake: true,
      wake_grant: { classes: ["ambient"], ttl_seconds: 86_400 },
      grant: { extend: true, until: 9e15 },
      mode: "silent-wake",
      delivery: "immediate",
      class_override: "alarm",
      purpose: "wake the prince",
    };
    host.sing(1, {
      ...AMBIENT,
      text: 'wake_grant {"stream":"ops:ops.fleet","classes":["ambient"]}',
      flags: { silent_wake: true, wake: true, alarm: true },
      extra: asks,
    });
    h.timers.advance(10_000);
    assert.equal(pushes(shim).length, 0, "no wake");
    assert.equal(status(h).counts["wake_withheld:ambient"], 1);
    assert.equal(h.store.canticleWakeGrants("scribe").length, 0, "no grant");

    // With the prince's own grant in place, a station's ask doesn't extend it.
    await grant(h, shim, {
      stream: "ops:ops.fleet",
      classes: ["ambient"],
      ttl_seconds: 60,
    });
    host.sing(2, { ...AMBIENT, extra: asks });
    h.timers.advance(10_000);
    assert.equal(pushes(shim).length, 1, "granted: it wakes");
    await confirm(shim);
    h.clock.value += 60_000;
    host.sing(3, { ...AMBIENT, extra: asks });
    h.timers.advance(10_000);
    assert.equal(pushes(shim).length, 1, "the grant lapsed on time");
    // Nor can a grant for ambient widen to another class.
    await grant(h, shim, {
      stream: "ops:ops.fleet",
      classes: ["ambient"],
      ttl_seconds: 60,
    });
    // (The record's own `class` is the host's verified one; a station can only ask.)
    host.sing(4, {
      class: "chatter",
      extra: { ...asks, requested_class: "ambient", wake_class: "ambient" },
    });
    h.timers.advance(10_000);
    assert.equal(pushes(shim).length, 1);
    assert.equal(status(h).counts["wake_withheld:chatter"], 1);
  } finally {
    h.dispose();
  }
});

test("#176 proof 6: wake_derived unknown still means no wake, even for a class allowed to wake", async () => {
  const { h, host } = setup({ mode: "immediate" }, { wakeKeys: [OPS] });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await grant(h, shim, {
      stream: "ops:ops.fleet",
      classes: ["ambient"],
      ttl_seconds: 600,
    });
    host.sing(1, { ...ALARM, flags: null }); // a receptor too old to say
    host.sing(2, { ...AMBIENT, flags: null });
    host.sing(3, {
      ...ALARM,
      stateKey: "smoke",
      flags: { wake_derived: true },
    });
    h.timers.advance(10_000);
    assert.equal(pushes(shim).length, 0);
    assert.equal(status(h).counts.wake_derived, 3);
  } finally {
    h.dispose();
  }
});

test("#176: a grant never opens a station whose key isn't on wakeKeys, and mute still wins over one", async () => {
  const { h, host } = setup({ mode: "immediate" }, { wakeKeys: [OPS] });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    await grant(h, shim, {
      stream: "alpha:ops.fleet",
      classes: ["ambient", "alarm"],
      ttl_seconds: 600,
    });
    host.sing(1, { ...AMBIENT, station: "alpha" });
    host.sing(2, { ...ALARM, station: "alpha" });
    h.timers.advance(10_000);
    assert.equal(pushes(shim).length, 0, "the allowlist is necessary");
    assert.equal(status(h).counts.not_allowlisted, 2);

    await grant(h, shim, {
      stream: "ops:ops.fleet",
      classes: ["ambient"],
      ttl_seconds: 600,
    });
    await h.call(shim, "set_canticle_delivery", { mode: "mute" });
    host.sing(3, AMBIENT);
    host.sing(4, ALARM);
    h.timers.advance(10_000);
    assert.equal(pushes(shim).length, 0, "mute wins");
  } finally {
    h.dispose();
  }
});

test("#176 proof 7: migration: a bare wakeKeys key parses as alarm only; an entry may name its classes", () => {
  const parsed = testConfig(
    canticleInput({
      wakeKeys: [
        "F6EECF2F43082A97",
        { key: ALPHA, classes: ["advisory", "alarm"] },
        { key: OPS, classes: ["ambient"] },
      ],
    }),
  ).canticle!;
  assert.deepEqual(parsed.wakeKeys, [OPS, ALPHA]);
  assert.deepEqual(parsed.wakeClasses, {
    [OPS]: ["alarm", "ambient"],
    [ALPHA]: ["advisory", "alarm"],
  });
  for (const [entry, why] of [
    [{ key: OPS, classes: [] }, /classes/u],
    [{ key: OPS, classes: ["gossip"] }, /gossip/u],
    [{ key: OPS }, /classes/u],
    [{ key: "ops", classes: ["alarm"] }, /16 hex digits/u],
    [{ key: OPS, classes: ["alarm"], ttl: 5 }, /ttl/u],
  ] as Array<[R, RegExp]>) {
    assert.throws(
      () => testConfig(canticleInput({ wakeKeys: [entry] })),
      why,
      JSON.stringify(entry),
    );
  }
  // The runbook says so.
  const runbook = readFileSync(
    new URL("../docs/runbook.md", import.meta.url),
    "utf8",
  );
  assert.match(runbook, /bare key[^.]*alarm only/iu);
  assert.match(runbook, /wake_withheld:<class>/u);
  assert.match(runbook, /wake_grant/u);
});

/** The test config's canticle section, before parsing. */
function canticleInput(canticle: R): R {
  return {
    canticle: {
      enabled: true,
      source: "host-daemon",
      hostSocket: "/nonexistent/canticle.sock",
      tune: { scribe: ["*:ops.fleet"] },
      delivery: { scribe: { mode: "immediate" } },
      ...canticle,
    },
  };
}

test("#176: on a daemon without canticle, a session change still records the ear's new holder (discarding grants never skips the write)", async () => {
  const h = harness(testConfig());
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    const other = "22222222-bbbb-4bbb-8bbb-000000000002";
    await shim.send({ type: "session", sessionId: other });
    assert.equal(h.store.ear("scribe")?.sessionId, other);
  } finally {
    h.dispose();
  }
});
