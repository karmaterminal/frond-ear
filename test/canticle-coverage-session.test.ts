// frond-ear#140 (RFC-0002 §7.5): the lone coverage note may start a turn on the session it
// is owed to only, at most once. It carries the owed session's id, as #134's withdrawn note
// does: the same session (a re-attach included) gets it; another one (a `/clear`, a new
// attach with a new id) does not, and the note is dropped and counted.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  confirm,
  OPS,
  pushes,
  SESSION,
  setup,
  status,
} from "./canticle-host.ts";

const OTHER_SESSION = "22222222-bbbb-4bbb-8bbb-000000000002";
const NOTE =
  /^- ops:ops\.fleet: 1 went off air unpushed while the hour's push budget was spent \(push_budget; heard \S+Z to \S+Z\)\.$/mu;

/**
 * One push spends the hour's budget (`maxPushesPerHour: 1`), then record 2 goes off air
 * under that hold: a coverage note owed a push of its own, owed to the session holding the
 * ear now. Returns when the budget next has room.
 */
async function owe(opts: { sessionId?: string } = {}) {
  const { h, host } = setup({ mode: "immediate", maxPushesPerHour: 1 });
  const shim = h.attach(
    "scribe",
    opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {},
  );
  host.sing(1);
  h.timers.advance(6_000);
  await confirm(shim);
  const frees = status(h).lastPushAt! + 3_600_000;
  host.sing(2, { ttlMs: 60_000 });
  h.timers.advance(120_000);
  assert.equal(status(h).counts.off_air_unpushed, 1, "2 went off air, held");
  return { h, host, shim, frees };
}

test("#140: the session the coverage note is owed to gets it, once", async () => {
  const { h, shim, frees } = await owe({ sessionId: SESSION });
  try {
    h.timers.advance(frees + 6_000 - h.clock.now());
    assert.equal(pushes(shim).length, 2);
    assert.match(pushes(shim)[1]!.content, NOTE);
    await confirm(shim);
    h.timers.advance(3_600_000);
    assert.equal(pushes(shim).length, 2, "once");
    assert.equal(status(h).counts.coverage_notes, 1);
    assert.equal(status(h).counts.coverage_note_dropped, undefined);
  } finally {
    h.dispose();
  }
});

test("#140: after a /clear (the same shim now speaks for another session), the note owed to the one before is dropped, counted, and never pushed or carried", async () => {
  const { h, host, shim, frees } = await owe({ sessionId: SESSION });
  try {
    await shim.send({ type: "session", sessionId: OTHER_SESSION });
    h.timers.advance(frees + 6_000 - h.clock.now());
    assert.equal(pushes(shim).length, 1, "no push of the note alone");
    assert.equal(status(h).counts.coverage_note_dropped, 1);
    assert.equal(status(h).counts.coverage_notes, undefined);
    // Nor does it ride with the next push that goes anyway.
    host.sing(3);
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 2);
    assert.doesNotMatch(pushes(shim)[1]!.content, /push_budget/u);
    const heard = (await h.call(shim, "hear", {})).text;
    assert.doesNotMatch(heard, /the next push reports/u);
  } finally {
    h.dispose();
  }
});

test("#140: a new attach with another session id doesn't get the note owed to the one before; the one before, back later, doesn't either: it was dropped", async () => {
  const { h, shim, frees } = await owe({ sessionId: SESSION });
  try {
    shim.close();
    const other = h.attach("scribe", { sessionId: OTHER_SESSION });
    h.timers.advance(frees + 6_000 - h.clock.now());
    assert.equal(pushes(other).length, 0);
    assert.equal(status(h).counts.coverage_note_dropped, 1);
    other.close();
    const back = h.attach("scribe", { sessionId: SESSION });
    h.timers.advance(3_600_000);
    assert.equal(pushes(back).length, 0, "dropped, not held");
  } finally {
    h.dispose();
  }
});

test("#140: a re-attach of the same session gets the note, once", async () => {
  const { h, shim, frees } = await owe({ sessionId: SESSION });
  try {
    shim.close();
    h.timers.advance(60_000); // no session holds the ear: the note waits for one
    assert.equal(status(h).held, "no_session");
    const back = h.attach("scribe", { sessionId: SESSION });
    h.timers.advance(frees + 6_000 - h.clock.now());
    assert.equal(pushes(back).length, 1);
    assert.match(pushes(back)[0]!.content, NOTE);
    await confirm(back);
    h.timers.advance(3_600_000);
    assert.equal(pushes(back).length, 1, "once");
    assert.equal(status(h).counts.coverage_note_dropped, undefined);
  } finally {
    h.dispose();
  }
});

test("#140: what a push promised a session (its footer said a record waits) is owed to that session, not to the one holding the ear when the record goes off air", async () => {
  const { h, host } = setup({ mode: "immediate", maxItems: 1 });
  try {
    const shim = h.attach("scribe", { sessionId: SESSION });
    host.sing(1);
    host.sing(2, { ttlMs: 8_000 });
    h.timers.advance(6_000);
    assert.equal(pushes(shim).length, 1);
    assert.match(pushes(shim)[0]!.content, /1 more record waits/u);
    await confirm(shim);
    await shim.send({ type: "session", sessionId: OTHER_SESSION });
    h.timers.advance(60_000); // 2 goes off air before the next push
    assert.equal(status(h).counts.off_air_unpushed, 1);
    assert.equal(pushes(shim).length, 1, "nothing pushed to the new session");
    assert.equal(status(h).counts.coverage_note_dropped, 1);
  } finally {
    h.dispose();
  }
});

test("#140: with no session id on either side, the note goes under the same attach only", async () => {
  // The control: one attach, no id; the note comes, once.
  const same = await owe();
  try {
    same.h.timers.advance(same.frees + 6_000 - same.h.clock.now());
    assert.equal(pushes(same.shim).length, 2);
    assert.match(pushes(same.shim)[1]!.content, NOTE);
  } finally {
    same.h.dispose();
  }
  // A re-attach without an id can't prove it is the same session: dropped.
  const { h, shim, frees } = await owe();
  try {
    shim.close();
    const next = h.attach("scribe");
    h.timers.advance(frees + 6_000 - h.clock.now());
    assert.equal(pushes(next).length, 0);
    assert.equal(status(h).counts.coverage_note_dropped, 1);
  } finally {
    h.dispose();
  }
});

test("#140: the note keeps its session through a frond-ear restart: the same session gets it, another one doesn't", async () => {
  for (const comes of [SESSION, OTHER_SESSION]) {
    const directory = mkdtempSync(join(tmpdir(), "frond-ear-coverage-"));
    const path = join(directory, "ear.db");
    const delivery = { mode: "immediate", maxPushesPerHour: 1 };
    try {
      let frees: number;
      const first = setup(delivery, {}, {}, { path });
      try {
        const shim = first.h.attach("scribe", { sessionId: SESSION });
        first.host.sing(1);
        first.h.timers.advance(6_000);
        await confirm(shim);
        frees = status(first.h).lastPushAt! + 3_600_000;
        first.host.sing(2, { ttlMs: 60_000 });
        first.h.timers.advance(120_000);
        assert.equal(status(first.h).counts.off_air_unpushed, 1);
      } finally {
        first.h.dispose();
      }
      const second = setup(delivery, {}, {}, { path });
      try {
        second.h.clock.value = frees + 1_000;
        const shim = second.h.attach("scribe", { sessionId: comes });
        second.h.timers.advance(6_000);
        if (comes === SESSION) {
          assert.equal(pushes(shim).length, 1, "the same session's note");
          assert.match(pushes(shim)[0]!.content, NOTE);
        } else {
          assert.equal(pushes(shim).length, 0, "another session's: none");
          assert.equal(status(second.h).counts.coverage_note_dropped, 1);
        }
      } finally {
        second.h.dispose();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("#140: a saved note owed with no session it can name (an earlier build's) is owed to none: the next session to hold the ear drops it, counted", async () => {
  const { h } = setup({ mode: "immediate" });
  try {
    const at = h.clock.now() - 1_000;
    h.store.setRuntimeState(
      "canticle.withheld.scribe",
      JSON.stringify({
        pending: {
          "ops:ops.fleet": {
            offAir: 0,
            dropped: 0,
            withheld: [["push_budget", { count: 1, from: at, to: at }]],
            key: OPS,
            owed: true,
          },
        },
        carried: {},
      }),
    );
    const shim = h.attach("scribe", { sessionId: SESSION });
    h.timers.advance(60_000);
    assert.equal(pushes(shim).length, 0);
    assert.equal(status(h).counts.coverage_note_dropped, 1);
  } finally {
    h.dispose();
  }
});

test("#140: a note pushed to a session, given back after a /clear, is dropped as it comes back: it never merges into the note owed to the session after", async () => {
  const { h, host, shim, frees } = await owe({ sessionId: SESSION });
  try {
    h.timers.advance(frees + 6_000 - h.clock.now());
    assert.equal(pushes(shim).length, 2, "the note, pushed, never confirmed");
    assert.match(pushes(shim)[1]!.content, NOTE);
    await shim.send({ type: "session", sessionId: OTHER_SESSION });
    // The new session's own note: 3 goes off air under the spent budget.
    host.sing(3, { ttlMs: 60_000 });
    h.timers.advance(120_000);
    shim.close(); // the note's push is given back, the budget's push with it
    assert.equal(status(h).counts.coverage_note_dropped, 1, "the one before's");
    const back = h.attach("scribe", { sessionId: OTHER_SESSION });
    h.timers.advance(6_000);
    assert.equal(pushes(back).length, 1);
    assert.match(
      pushes(back)[0]!.content,
      NOTE,
      "1 went off air: the new session's own, not 2",
    );
  } finally {
    h.dispose();
  }
});
