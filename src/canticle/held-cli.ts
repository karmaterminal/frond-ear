// `frond-ear held-export --ear <ear> --station <s> --stream <s> --epoch <n> --seq <n>
// [--before-hold]`: one held canticle record as p57#187's heard-item.v0 JSON (the held
// state), so it can be fed through p57's specimen test (held-state.md gate 3). It opens the
// database read-only and writes no rows (SQLite may still leave -wal/-shm sidecars), works
// with the daemon running or stopped, and has no network side. It prints the record's text:
// it is for the seat's own shell, as the store file itself is, never a tool a station or a
// room can reach.

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import { runtimeOptions } from "../config.ts";
import { heardItem, heardName } from "../letters.ts";
import { readHeld, type HeldItem } from "../store.ts";
import { heldItemRecord } from "./held.ts";
import { iso } from "./hear.ts";

export interface HeldExportIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  env: NodeJS.ProcessEnv;
}

const USAGE =
  "usage: frond-ear held-export --ear <name> --station <name> --stream <name> --epoch <n> --seq <n> [--before-hold]\n";

export async function runHeldExport(
  argv: string[],
  io: HeldExportIo,
  now: () => number = Date.now,
): Promise<number> {
  let values: {
    ear?: string;
    station?: string;
    stream?: string;
    epoch?: string;
    seq?: string;
    "before-hold"?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        ear: { type: "string" },
        station: { type: "string" },
        stream: { type: "string" },
        epoch: { type: "string" },
        seq: { type: "string" },
        "before-hold": { type: "boolean" },
      },
    }));
  } catch (error) {
    io.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
    return 1;
  }
  if (!values.ear) {
    io.stderr.write(`--ear is required\n${USAGE}`);
    return 1;
  }
  let ref;
  try {
    ref = heardItem(
      {
        station: values.station,
        stream: values.stream,
        epoch: /^\d{1,10}$/u.test(values.epoch ?? "")
          ? Number(values.epoch)
          : values.epoch,
        seq: values.seq,
      },
      "the record",
    );
  } catch (error) {
    io.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
    return 1;
  }
  const path = runtimeOptions(io.env, { dryRun: false }).databasePath;
  if (!existsSync(path)) {
    io.stderr.write(`no frond-ear database at ${path}\n`);
    return 1;
  }
  const database = new DatabaseSync(path, { readOnly: true });
  let items: HeldItem[];
  try {
    items = readHeld(database, values.ear);
  } catch (error) {
    // A store from before the held state has no table: it holds nothing.
    if (!/no such table/u.test(String(error))) throw error;
    items = [];
  } finally {
    database.close();
  }
  const item = items.find(
    (held) =>
      held.station === ref.station &&
      held.stream === ref.stream &&
      held.epoch === ref.epoch &&
      held.seq === ref.seq,
  );
  if (item === undefined) {
    io.stderr.write(`no held record ${heardName(ref)} on ear ${values.ear}\n`);
    return 1;
  }
  if (item.text === null || item.expiresAt <= now()) {
    io.stderr.write(
      `held record ${heardName(ref)} expired at ${iso(item.expiresAt)}; its text is dropped\n`,
    );
    return 1;
  }
  const record = heldItemRecord(item, {
    observer: `frond-ear:${values.ear}`,
    beforeHold: values["before-hold"] === true,
  });
  io.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  return 0;
}
