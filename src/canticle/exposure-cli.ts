// `frond-ear exposure --ear <ear> [--since <time>] [--json]` (frond-ear#117): the exposure
// ledger, read-only, for a future issuer behind its own boundary to read. It opens the
// database read-only and never creates one, so it works with the daemon running or stopped.
// It has no network side at all: no export, no issuer call. The records hold hashes and
// provenance, never payload text, and never a delivery token.

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import { runtimeOptions } from "../config.ts";
import { readExposures } from "../store.ts";
import type { ExposureEntry } from "./exposure.ts";

export interface ExposureIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  env: NodeJS.ProcessEnv;
}

const USAGE =
  "usage: frond-ear exposure --ear <name> [--since <ISO time | epoch ms>] [--json]\n";

/** `--since`: an ISO time or epoch milliseconds; undefined when it is neither. */
function sinceOf(value: string | undefined): number | undefined {
  if (value === undefined) return 0;
  if (/^\d+$/u.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : at;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** One line per record: when, which push, its phase and receipts; no payload, no token. */
function line(entry: ExposureEntry): string {
  const session = entry.record.reader.sessionId?.slice(0, 8) ?? "none";
  return [
    iso(entry.fencedAt),
    `push=${entry.batchId}`,
    `phase=${entry.phase}`,
    `sources=${entry.record.sources.length}`,
    `holder=${entry.holder}`,
    `session=${session}`,
    `revision=${entry.record.reader.lifecycleRevision}`,
    ...(entry.offered ? [`offered=${iso(entry.offered.at)}`] : []),
    ...(entry.echoed
      ? [`echoed=${iso(entry.echoed.at)}`, `by=${entry.echoed.by}`]
      : []),
    ...(entry.unknown
      ? [`unknown=${iso(entry.unknown.at)}`, `why=${entry.unknown.reason}`]
      : []),
    `result=${entry.record.resultSha256.slice(0, 16)}`,
    `pending=${entry.pendingId}`,
  ].join(" ");
}

export async function runExposure(
  argv: string[],
  io: ExposureIo,
): Promise<number> {
  let values: { ear?: string; since?: string; json?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        ear: { type: "string" },
        since: { type: "string" },
        json: { type: "boolean" },
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
  const since = sinceOf(values.since);
  if (since === undefined) {
    io.stderr.write(
      `--since must be an ISO time or epoch milliseconds\n${USAGE}`,
    );
    return 1;
  }
  const path = runtimeOptions(io.env, { dryRun: false }).databasePath;
  if (!existsSync(path)) {
    io.stderr.write(`no frond-ear database at ${path}\n`);
    return 1;
  }
  const database = new DatabaseSync(path, { readOnly: true });
  let entries: ExposureEntry[];
  try {
    entries = readExposures(database, values.ear, since);
  } catch (error) {
    // A store from before the ledger has no table: it has recorded nothing.
    if (!/no such table/u.test(String(error))) throw error;
    entries = [];
  } finally {
    database.close();
  }
  io.stdout.write(
    values.json
      ? `${JSON.stringify(entries, null, 2)}\n`
      : entries.map((entry) => `${line(entry)}\n`).join(""),
  );
  return 0;
}
