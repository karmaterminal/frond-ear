// The runtime gap-name guard (🌫 and 🌿 on frond-ear#148): the type on the gap recorders catches a literal push
// of an unlisted name, but a widened alias, a cast or a computed call gets past both it and the source test.
// So the export itself refuses: any `deck.gaps` name outside GAP_NAMES, whether it came in with the daemon's
// view or was set while the export was built, refuses the whole export. It exits 1, prints nothing to stdout,
// and says so in frond-ear's own words, never the name.
//
// Each sneak path the reviewers reproduced is run for real: a copy of house-cli.ts with the sneak written in,
// its imports pointed back at the real modules, through runHouseExport against a request double.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { houseExport, runHouseExport } from "../src/canticle/house-cli.ts";
import type { CliRequest } from "../src/client.ts";

const SRC = join(import.meta.dirname, "..", "src", "canticle");
const SOURCE = readFileSync(join(SRC, "house-cli.ts"), "utf8");
const UNLISTED = "new_unlisted";

/** Where readDaemon's gap recorder is declared: a sneak written right after it runs on every walk. */
const RECORDER = `  const gap = (name: GapName, n = 1) =>
    gaps.set(name, (gaps.get(name) ?? 0) + n);
`;
/** Where houseExport builds the map `deck.gaps` is printed from. */
const EXPORT_MAP = `  const gaps = new Map<GapName, number>(
    daemon.kind === "daemon" ? daemon.gaps : [],
  );
`;

const SNEAKS: Array<[string, string, string]> = [
  // 🌫, review on 6311a368: mutable Map covariance, no cast, no any.
  [
    "a widened Map<string, number> alias",
    RECORDER,
    `  const target: Map<string, number> = gaps;\n  target.set("${UNLISTED}", 1);\n`,
  ],
  // 🌿's four.
  ["a cast to GapName", RECORDER, `  gap("${UNLISTED}" as GapName);\n`],
  ["a cast to any", RECORDER, `  gap("${UNLISTED}" as any);\n`],
  [
    "an alias of gap",
    RECORDER,
    `  const note = gap as (name: string) => void;\n  note("${UNLISTED}");\n`,
  ],
  [
    '(gaps as any)["set"]',
    RECORDER,
    `  (gaps as any)["set"]("${UNLISTED}", 1);\n`,
  ],
  // Past the input check: set while the export itself is built.
  [
    "a widened alias of the export's own map",
    EXPORT_MAP,
    `  const wide: Map<string, number> = gaps;\n  wide.set("${UNLISTED}", 1);\n`,
  ],
];

const scratch = mkdtempSync(join(tmpdir(), "frond-ear-gap-guard-"));
let copies = 0;

/** house-cli.ts with `insert` written after `anchor`, its relative imports pointed at the real modules. */
async function sneakCopy(
  anchor: string,
  insert: string,
): Promise<{ runHouseExport: typeof runHouseExport }> {
  assert.equal(SOURCE.split(anchor).length, 2, "the anchor must occur once");
  const text = SOURCE.replace(anchor, anchor + insert).replace(
    /from "(\.\.?\/[^"]+)"/gu,
    (_, rel: string) => `from "${pathToFileURL(join(SRC, rel)).href}"`,
  );
  const path = join(scratch, `house-cli.${++copies}.ts`);
  writeFileSync(path, text);
  return (await import(pathToFileURL(path).href)) as {
    runHouseExport: typeof runHouseExport;
  };
}

// A config with one ear and canticle on, no manifest, no ids.
const configPath = join(scratch, "frond-ear.json");
writeFileSync(
  configPath,
  JSON.stringify({
    botUserId: "1",
    ears: { scribe: { channels: { "2": "room" } } },
    canticle: {
      enabled: true,
      source: "host-daemon",
      tune: { scribe: ["*:ops.fleet"] },
    },
  }),
);

/** A daemon with canticle on, its tune applied, and one guide page with nothing on it. */
async function request(message: CliRequest) {
  if (message.type === "status") {
    return {
      ok: true,
      text: JSON.stringify({
        canticle: {
          source: "host-daemon",
          state: "connected",
          stations: {},
          appliedTune: { scribe: ["*:ops.fleet"] },
        },
      }),
    };
  }
  return {
    ok: true,
    text: JSON.stringify({
      rows: [],
      streams: 0,
      untuned: { rows: [], streams: 0, more: 0 },
      gaps: [],
      listener: "listening",
    }),
  };
}

async function run(fn: typeof runHouseExport) {
  let out = "";
  let err = "";
  const code = await fn(["--ear", "scribe"], {
    stdout: { write: (text: string) => (out += text) },
    stderr: { write: (text: string) => (err += text) },
    env: { FROND_EAR_CONFIG: configPath },
    request,
    revision: () => "abc1234",
    now: () => 0,
  });
  return { code, out, err };
}

const REFUSAL =
  /^frond-ear house-export: refused: 1 gap name outside GAP_NAMES at (?:the daemon's view|deck\.gaps); nothing was printed\n$/u;

test("control: the request double and an unchanged copy export cleanly", async () => {
  const real = await run(runHouseExport);
  assert.equal(real.err, "");
  assert.equal(real.code, 0);
  const doc = JSON.parse(real.out) as { deck: { gaps: unknown[] } };
  assert.deepEqual(doc.deck.gaps, []);
  const copy = await run((await sneakCopy(RECORDER, "")).runHouseExport);
  assert.deepEqual(copy, real);
});

for (const [name, anchor, insert] of SNEAKS) {
  test(`${name} refuses the whole export: exit 1, no stdout, frond-ear's own words`, async () => {
    const { code, out, err } = await run(
      (await sneakCopy(anchor, insert)).runHouseExport,
    );
    assert.equal(out, "", "nothing may reach stdout");
    assert.equal(code, 1);
    assert.match(err, REFUSAL);
    assert.ok(!err.includes(UNLISTED), "the unlisted name is never repeated");
  });
}

test("houseExport itself refuses a daemon view carrying an unlisted gap name", () => {
  const daemon = {
    kind: "daemon",
    listener: "listening",
    badCounts: new Set(),
    unsure: new Set(),
    canticleState: "on",
    appliedTune: ["*:ops.fleet"],
    tunesNothing: false,
    observedTune: ["*:ops.fleet"],
    tunedUnknown: new Set(),
    presence: new Map(),
    rows: [],
    untuned: [],
    untunedMore: 0,
    truncated: false,
    gaps: new Map<string, number>([
      ["host_mute", 1],
      [UNLISTED, 1],
    ]),
    rowGaps: new Set(),
  };
  const input = {
    ear: "scribe",
    revision: "abc1234",
    now: 0,
    canticle: undefined,
    manifest: "none" as const,
    daemon: daemon as never,
  };
  assert.throws(
    () => houseExport(input),
    /refused: 1 gap name outside GAP_NAMES at the daemon's view/u,
  );
  // The same view with only listed names exports, its gaps kept.
  daemon.gaps.delete(UNLISTED);
  const doc = houseExport(input) as {
    deck: { gaps: Array<{ name: string }> };
  };
  assert.ok(doc.deck.gaps.some((g) => g.name === "host_mute"));
});
