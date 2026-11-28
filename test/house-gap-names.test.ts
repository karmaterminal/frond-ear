// `frond-ear house-export --gap-names` (🌿 on ews#15): the one list of names `deck.gaps` can carry, with the three
// sets that say which way each pushes, so a reader (ews-concept-new's house card) can hold its own table to
// frond-ear itself rather than to a hand copy. The list must be every name the code can push and no other: the
// names pushed are read here from house-cli.ts's own code, never typed in by hand.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  GAP_NAMES,
  gapNamesDoc,
  runHouseExport,
} from "../src/canticle/house-cli.ts";

const SOURCE = readFileSync(
  join(import.meta.dirname, "..", "src", "canticle", "house-cli.ts"),
  "utf8",
);

/** Every gap name the code pushes: each literal handed to a gap map, and each name a guide gap line maps to. */
function pushedInCode(): Set<string> {
  const names = new Set<string>();
  for (const m of SOURCE.matchAll(
    /\b(?:gap|gaps\.set|pageGaps\.set|guideGaps\.set)\(\s*"([^"]+)"/gu,
  ))
    names.add(m[1]!);
  const lines = /const GAP_LINES\b[^=]*=\s*\[([\s\S]*?)\n\];/u.exec(SOURCE);
  assert.ok(lines, "GAP_LINES not found in house-cli.ts");
  for (const m of lines[1]!.matchAll(/,\s*"([^"]+)",?\s*\]/gu))
    names.add(m[1]!);
  return names;
}

/** Every call that hands a gap map a name: a literal, or one of the two forwarding forms the types hold. */
function gapCallsAreLiteralOrForwarded(): string[] {
  const odd: string[] = [];
  for (const m of SOURCE.matchAll(
    /\b(?:gap|gaps\.set|pageGaps\.set|guideGaps\.set)\(\s*([^\s"][^,)]*)/gu,
  )) {
    if (!["name", "name: GapName"].includes(m[1]!.trim())) odd.push(m[0]);
  }
  return odd;
}

async function gapNamesCli(argv: string[]) {
  let out = "";
  let err = "";
  const code = await runHouseExport(argv, {
    stdout: { write: (text: string) => (out += text) },
    stderr: { write: (text: string) => (err += text) },
    env: {},
    revision: () => "abc1234",
  });
  return { code, out, err };
}

test("GAP_NAMES is every gap name the code pushes, and no other", () => {
  const pushed = pushedInCode();
  const listed = new Set<string>(GAP_NAMES);
  assert.ok(pushed.size > 0);
  assert.deepEqual(
    [...pushed].filter((name) => !listed.has(name)).sort(),
    [],
    "pushed in house-cli.ts but missing from GAP_NAMES",
  );
  assert.deepEqual(
    [...listed].filter((name) => !pushed.has(name)).sort(),
    [],
    "in GAP_NAMES but never pushed",
  );
});

test("every gap push is a literal or a forwarded name the types hold to GapName", () => {
  assert.deepEqual(gapCallsAreLiteralOrForwarded(), []);
});

test("the list is sorted and unique, and each set is drawn from it", () => {
  assert.deepEqual([...GAP_NAMES], [...new Set(GAP_NAMES)].sort());
  const doc = gapNamesDoc("abc1234");
  for (const set of [doc.board_empty, doc.walk_breaks, doc.not_coverage]) {
    assert.ok(set.length > 0);
    assert.deepEqual([...set], [...new Set(set)].sort());
    for (const name of set) assert.ok(doc.names.includes(name), name);
  }
  // A board held empty and a broken walk are both coverage gaps: neither can sit in NOT_COVERAGE.
  for (const name of [...doc.board_empty, ...doc.walk_breaks])
    assert.ok(!doc.not_coverage.includes(name), name);
});

test("house-export --gap-names prints the list and the sets, and reads no config", async () => {
  const { code, out, err } = await gapNamesCli(["--gap-names"]);
  assert.equal(err, "");
  assert.equal(code, 0);
  const doc = JSON.parse(out) as ReturnType<typeof gapNamesDoc>;
  assert.equal(doc.kind, "frond-house-gap-names/0");
  assert.equal(doc.source, "frond-ear abc1234");
  assert.deepEqual(doc, gapNamesDoc("abc1234"));
  assert.deepEqual(doc.names, [...GAP_NAMES]);
  for (const name of ["host_mute", "order_violation", "ear_muted"] as const)
    assert.ok(doc.names.includes(name), name);
  assert.ok(doc.board_empty.includes("host_mute"));
  assert.ok(doc.walk_breaks.includes("order_violation"));
  assert.ok(doc.not_coverage.includes("ear_muted"));
});

test("--gap-names takes no other option", async () => {
  for (const argv of [
    ["--gap-names", "--ear", "scribe"],
    ["--gap-names", "--offline"],
  ]) {
    const { code, out, err } = await gapNamesCli(argv);
    assert.equal(code, 1, argv.join(" "));
    assert.equal(out, "");
    assert.match(err, /--gap-names takes no other option/u);
  }
});
